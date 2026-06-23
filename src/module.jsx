import React, { useMemo, useState } from 'react';
import { PanelPlugin } from '@grafana/data';
import './styles.css';

const refIds = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const defaultThresholds = {
  statusDown: 0,
  uploadWarnBps: 100_000_000,
  uploadCritBps: 20_000_000,
  downloadWarnBps: 100_000_000,
  downloadCritBps: 20_000_000,
  lineDown: 0,
};

const defaults = {
  title: 'MetroGYN NOC Map',
  showTopCards: true,
  showLegend: true,
  showMiniFlow: true,
  showAlarms: true,
  animateLinks: true,
  config: {
    switches: [],
    connections: [],
    appearance: {
      cardWidth: 132,
      lineWidth: 1.1,
    },
  },
};

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function labelFromHost(host, fallback) {
  return String(host || fallback || '')
    .replace(/\s+metrogyn$/i, '')
    .replace(/^pop\s+/i, 'PTT ')
    .replace(/^educacao$/i, 'SEDUCE')
    .replace(/^agr$/i, 'CRER')
    .replace(/^ssp$/i, 'HUGO')
    .replace(/^pplt$/i, 'SEDI PPLT')
    .replace(/^dc1r11-swmtr1a$/i, 'SEDI METROGYN')
    .toUpperCase();
}

function lastValue(field) {
  const values = field?.values;
  if (!values) return null;
  if (Array.isArray(values)) {
    for (let i = values.length - 1; i >= 0; i -= 1) {
      if (values[i] !== null && values[i] !== undefined && values[i] !== '') return Number(values[i]);
    }
    return null;
  }
  if (typeof values.length === 'number' && typeof values.get === 'function') {
    for (let i = values.length - 1; i >= 0; i -= 1) {
      const value = values.get(i);
      if (value !== null && value !== undefined && value !== '') return Number(value);
    }
  }
  return null;
}

function formatBps(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 bps';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} Gbps`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mbps`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} Kbps`;
  return `${Math.round(value)} bps`;
}

function frameRef(frame, index) {
  return frame.refId || frame.meta?.refId || frame.meta?.custom?.refId || frame.schema?.refId || refIds[index] || String(index + 1);
}

function readFrames(data) {
  const rows = [];
  (data?.series || []).forEach((frame, index) => {
    const valueField = frame.fields?.find((field) => field.type === 'number') || frame.fields?.find((field) => field.name === 'Value');
    const labels = valueField?.labels || {};
    const value = lastValue(valueField);
    if (value === null || Number.isNaN(value)) return;
    rows.push({
      refId: frameRef(frame, index),
      host: labels.host || frame.labels?.host || '',
      item: labels.item || frame.name || valueField?.config?.displayNameFromDS || '',
      key: labels.item_key || '',
      value,
    });
  });
  return rows;
}

function queryInventory(data) {
  const byRef = {};
  readFrames(data).forEach((row) => {
    if (!byRef[row.refId]) {
      byRef[row.refId] = { refId: row.refId, host: row.host, name: labelFromHost(row.host, row.refId), fields: [] };
    }
    if (row.host && !byRef[row.refId].host) {
      byRef[row.refId].host = row.host;
      byRef[row.refId].name = labelFromHost(row.host, row.refId);
    }
    const id = fieldId(row);
    if (!byRef[row.refId].fields.some((field) => field.id === id)) {
      byRef[row.refId].fields.push({ id, label: row.item || row.key || id, key: row.key });
    }
  });
  return Object.values(byRef).sort((a, b) => a.refId.localeCompare(b.refId));
}

function fieldId(row) {
  return row.key || row.item || `${row.refId}:value`;
}

function pickAutoField(query, kind) {
  const checks = {
    upload: [/bits sent/i, /out/i, /tx/i],
    download: [/bits received/i, /in/i, /rx/i],
    status: [/icmp ping/i, /operational status/i, /status/i],
    line: [/operational status/i, /status/i],
    flow: [/fluxo/i, /flow/i, /trafego/i],
  }[kind] || [];
  return query?.fields.find((field) => checks.some((rx) => rx.test(`${field.label} ${field.key}`)))?.id || '';
}

function fieldValue(rows, refId, selector) {
  if (!selector) return null;
  const found = rows.find((row) => row.refId === refId && fieldId(row) === selector);
  return found?.value ?? null;
}

function fieldSum(rows, refId, kind) {
  const rx = kind === 'upload' ? /bits sent|net\.if\.out|tx/i : /bits received|net\.if\.in|rx/i;
  return rows.filter((row) => row.refId === refId && rx.test(`${row.item} ${row.key}`)).reduce((sum, row) => sum + row.value, 0);
}

function statusFrom(value, upload, download, thresholds) {
  if (value !== null && value !== undefined) {
    return value === thresholds.statusDown ? 'DOWN' : 'UP';
  }
  if (upload === null && download === null) return 'UNKNOWN';
  if ((upload || 0) < thresholds.uploadCritBps || (download || 0) < thresholds.downloadCritBps) return 'DOWN';
  if ((upload || 0) < thresholds.uploadWarnBps || (download || 0) < thresholds.downloadWarnBps) return 'DEGRADADO';
  return 'UP';
}

function statusClass(status) {
  const normalized = String(status || 'UNKNOWN').toUpperCase();
  if (normalized.includes('DOWN')) return 'down';
  if (normalized.includes('DEG')) return 'degraded';
  if (normalized.includes('UP')) return 'up';
  return 'unknown';
}

function normalizeConfig(config) {
  const current = config && typeof config === 'object' ? config : {};
  return {
    switches: Array.isArray(current.switches) ? current.switches : [],
    connections: Array.isArray(current.connections) ? current.connections : [],
    appearance: { ...defaults.config.appearance, ...(current.appearance || {}) },
  };
}

function buildSwitches(config, inventory, rows) {
  const configured = config.switches.length
    ? config.switches
    : inventory.map((query) => ({ id: query.refId, refId: query.refId, direction: 'Horario', thresholds: defaultThresholds }));

  return configured.map((sw) => {
    const query = inventory.find((item) => item.refId === sw.refId);
    const thresholds = { ...defaultThresholds, ...(sw.thresholds || {}) };
    const uploadField = sw.uploadField || pickAutoField(query, 'upload');
    const downloadField = sw.downloadField || pickAutoField(query, 'download');
    const statusField = sw.statusField || pickAutoField(query, 'status');
    const lineField = sw.lineField || pickAutoField(query, 'line');
    const flowField = sw.flowField || pickAutoField(query, 'flow');
    const upload = fieldValue(rows, sw.refId, uploadField) ?? fieldSum(rows, sw.refId, 'upload');
    const download = fieldValue(rows, sw.refId, downloadField) ?? fieldSum(rows, sw.refId, 'download');
    const statusValue = fieldValue(rows, sw.refId, statusField);
    const lineValue = fieldValue(rows, sw.refId, lineField);
    const flowValue = fieldValue(rows, sw.refId, flowField);
    const direction = flowValue === 0 ? 'Sem fluxo' : sw.direction || 'Horario';

    return {
      ...sw,
      id: sw.id || sw.refId,
      name: query?.name || sw.refId,
      host: query?.host || '',
      uploadRaw: upload || 0,
      downloadRaw: download || 0,
      upload: formatBps(upload || 0),
      download: formatBps(download || 0),
      statusValue,
      lineValue,
      direction,
      status: statusFrom(statusValue, upload, download, thresholds),
    };
  });
}

function buildConnections(config, switches, rows) {
  return config.connections.map((conn) => {
    const from = switches.find((sw) => sw.id === conn.from);
    const to = switches.find((sw) => sw.id === conn.to);
    const thresholds = { ...defaultThresholds, ...(conn.thresholds || {}) };
    const value = fieldValue(rows, conn.refId || from?.refId || to?.refId, conn.lineField);
    const status = value === null || value === undefined
      ? (from?.status === 'DOWN' || to?.status === 'DOWN' ? 'DOWN' : from?.status === 'DEGRADADO' || to?.status === 'DEGRADADO' ? 'DEGRADADO' : 'UP')
      : value === thresholds.lineDown ? 'DOWN' : 'UP';
    return { ...conn, status };
  });
}

function ringOrder(connections, ring) {
  const ids = [];
  connections.filter((conn) => conn.ring === ring).forEach((conn) => {
    if (!ids.includes(conn.from)) ids.push(conn.from);
    if (!ids.includes(conn.to)) ids.push(conn.to);
  });
  return ids;
}

function canonicalSite(name) {
  const n = normalize(name);
  if (n.includes('emater')) return 'emater';
  if (n.includes('sedi metrogyn')) return 'sedi-metrogyn';
  if (n.includes('seduce') || n.includes('educacao')) return 'seduce';
  if (n.includes('seapa')) return 'seapa';
  if (n.includes('sead')) return 'sead';
  if (n.includes('ptt') || n.includes('pop ufg')) return 'ptt-ufg';
  if (n.includes('semad')) return 'semad';
  if (n.includes('ccon')) return 'ccon';
  if (n.includes('goiasprev') || n.includes('ipasgo')) return 'goiasprev-ipasgo';
  if (n.includes('hugo') || n.includes('ssp')) return 'hugo';
  if (n.includes('detran')) return 'detran';
  if (n.includes('fapeg')) return 'fapeg';
  if (n.includes('pplt')) return 'sedi-pplt';
  if (n.includes('radio')) return 'radio-ufg';
  if (n.includes('crer') || n.includes('agr')) return 'crer';
  return n;
}

function point(cx, cy, rx, ry, degrees) {
  const rad = (degrees * Math.PI) / 180;
  return { x: cx + Math.cos(rad) * rx, y: cy + Math.sin(rad) * ry };
}

function place(ids, cx, cy, rx, ry, start, span, target) {
  ids.forEach((id, index) => {
    target[id] = point(cx, cy, rx, ry, start + (span * index) / Math.max(ids.length, 1));
  });
}

function layout(switches, connections) {
  const primaryOrder = ['sedi-metrogyn', 'seduce', 'seapa', 'sead', 'ptt-ufg', 'fapeg', 'sedi-pplt', 'radio-ufg', 'crer'];
  const secondaryOrder = ['ptt-ufg', 'semad', 'ccon', 'goiasprev-ipasgo', 'hugo', 'detran', 'radio-ufg'];
  const byKey = Object.fromEntries(switches.map((sw) => [canonicalSite(sw.name), sw.id]));
  const ids = switches.map((sw) => sw.id);
  const primary = primaryOrder.map((key) => byKey[key]).filter(Boolean);
  const secondary = secondaryOrder.map((key) => byKey[key]).filter(Boolean);
  const rest = ids.filter((id) => !primary.includes(id) && !secondary.includes(id) && id !== byKey.emater);
  const targetByKey = {
    emater: { x: 5.5, y: 56, nodeX: 6.5, nodeY: 51 },
    'sedi-metrogyn': { x: 18, y: 61, nodeX: 19.5, nodeY: 50 },
    seduce: { x: 14, y: 42, nodeX: 20.5, nodeY: 44 },
    seapa: { x: 21, y: 25, nodeX: 27, nodeY: 32 },
    sead: { x: 34, y: 15, nodeX: 38, nodeY: 23 },
    'ptt-ufg': { x: 54, y: 26, nodeX: 50.5, nodeY: 34 },
    fapeg: { x: 53, y: 56, nodeX: 53.5, nodeY: 49 },
    'sedi-pplt': { x: 50, y: 67, nodeX: 50.5, nodeY: 58 },
    'radio-ufg': { x: 43, y: 78, nodeX: 43, nodeY: 66 },
    crer: { x: 29, y: 78, nodeX: 31, nodeY: 67 },
    semad: { x: 70, y: 18, nodeX: 72, nodeY: 26 },
    ccon: { x: 85, y: 30, nodeX: 82, nodeY: 36 },
    'goiasprev-ipasgo': { x: 91, y: 49, nodeX: 88, nodeY: 49 },
    hugo: { x: 84, y: 66, nodeX: 82, nodeY: 62 },
    detran: { x: 68, y: 80, nodeX: 72, nodeY: 71 },
  };
  const target = {};
  switches.forEach((sw) => {
    const pos = targetByKey[canonicalSite(sw.name)];
    if (pos) target[sw.id] = pos;
  });
  place(rest, 55, 52, 7, 21, 240, 240, target);
  return switches.map((sw, index) => {
    const key = canonicalSite(sw.name);
    return {
      ...sw,
      segment: key,
      clockwise: nextName(key, primaryOrder, secondaryOrder, switches),
      counter: prevName(key, primaryOrder, secondaryOrder, switches),
      ...(target[sw.id] || { ...point(50, 50, 31, 31, (index / Math.max(switches.length, 1)) * 360), nodeX: 50, nodeY: 50 }),
    };
  });
}

function orderedRing(discovered, desired, existingIds) {
  const ordered = desired.filter((id) => discovered.includes(id) && existingIds.includes(id));
  discovered.forEach((id) => {
    if (!ordered.includes(id) && existingIds.includes(id)) ordered.push(id);
  });
  return ordered;
}

function siteNameByKey(key, switches) {
  return switches.find((sw) => canonicalSite(sw.name) === key)?.name || '';
}

function ringForKey(key, primaryOrder, secondaryOrder) {
  return secondaryOrder.includes(key) && !['ptt-ufg', 'radio-ufg'].includes(key) ? secondaryOrder : primaryOrder;
}

function nextName(key, primaryOrder, secondaryOrder, switches) {
  if (key === 'emater') return siteNameByKey('sedi-metrogyn', switches);
  const ring = ringForKey(key, primaryOrder, secondaryOrder);
  const index = ring.indexOf(key);
  return index >= 0 ? siteNameByKey(ring[(index + 1) % ring.length], switches) : '';
}

function prevName(key, primaryOrder, secondaryOrder, switches) {
  if (key === 'emater') return '';
  const ring = ringForKey(key, primaryOrder, secondaryOrder);
  const index = ring.indexOf(key);
  return index >= 0 ? siteNameByKey(ring[(index - 1 + ring.length) % ring.length], switches) : '';
}

function SwitchIcon({ state }) {
  return (
    <svg className={`mg-switch-icon ${state}`} viewBox="0 0 120 70">
      <defs><linearGradient id={`mg-sw-${state}`} x1="0" x2="1"><stop offset="0" stopColor="#172033" /><stop offset="0.45" stopColor="#b7c0cf" /><stop offset="1" stopColor="#0e1522" /></linearGradient></defs>
      <path d="M10 42 L72 20 L110 35 L47 60 Z" fill={`url(#mg-sw-${state})`} stroke="#050914" strokeWidth="2" />
      <path d="M47 60 L110 35 L110 47 L47 70 Z" fill="#0a101b" stroke="#050914" strokeWidth="2" />
      <rect x="34" y="49" width="5" height="4" fill="#55ff6d" /><rect x="43" y="52" width="5" height="4" fill="#55ff6d" /><rect x="52" y="55" width="5" height="4" fill="#55ff6d" />
    </svg>
  );
}

function SiteCard({ site }) {
  const cls = statusClass(site.status);
  return (
    <div className={`mg-site-card ${cls}`} style={{ left: `${site.x}%`, top: `${site.y}%` }}>
      <div className="mg-card-head"><strong>{site.name}</strong><span><i />{site.status}</span></div>
      <div className="mg-metric"><b>Up</b>{site.upload}</div>
      <div className="mg-metric"><b>Dn</b>{site.download}</div>
      <div className="mg-metric"><b>St</b>{site.statusValue ?? 'auto'}</div>
      <div className="mg-metric"><b>Ln</b>{site.lineValue ?? 'auto'}</div>
      <div className="mg-metric muted"><b>↻</b>{site.direction}</div>
      <SwitchIcon state={cls} />
    </div>
  );
}

function CompactSiteCard({ site }) {
  const cls = statusClass(site.status);
  const clockwise = site.clockwise || 'Proximo';
  const counter = site.counter || 'Anterior';
  return (
    <div className={`mg-site-card ${cls}`} style={{ left: `${site.x}%`, top: `${site.y}%` }}>
      <div className="mg-card-head"><strong>{site.name}</strong><span><i />{site.status}</span></div>
      <div className="mg-next">{'\u2192'} {clockwise}</div>
      <div className="mg-metric"><b>TX</b>{site.upload}</div>
      <div className="mg-metric"><b>RX</b>{site.download}</div>
      <div className="mg-next mg-prev">{'\u2190'} {counter}</div>
      <div className="mg-metric"><b>TX</b>{site.download}</div>
      <div className="mg-metric"><b>RX</b>{site.upload}</div>
    </div>
  );
}

function SwitchNode({ site }) {
  return (
    <div className="mg-switch-node" style={{ left: `${site.nodeX ?? site.x}%`, top: `${site.nodeY ?? site.y}%` }}>
      <SwitchIcon state={statusClass(site.status)} />
    </div>
  );
}

const ringArrows = [
  ['entry', 11, 54, 150],
  ['primary', 20, 45, -105],
  ['primary', 28, 29, -44],
  ['primary', 44, 24, 16],
  ['primary', 54, 41, 80],
  ['primary', 50, 62, 142],
  ['primary', 38, 70, 188],
  ['primary', 24, 62, 228],
  ['secondary', 64, 36, -38],
  ['secondary', 78, 35, 28],
  ['secondary', 87, 50, 92],
  ['secondary', 80, 66, 154],
  ['secondary', 66, 70, 218],
];

function RingArrow({ tone, x, y, rotate }) {
  return <span className={`mg-flow-arrow ${tone}`} style={{ left: `${x}%`, top: `${y}%`, transform: `translate(-50%, -50%) rotate(${rotate}deg)` }} />;
}

function NetworkMap({ switches, connections, animateLinks }) {
  const byId = Object.fromEntries(switches.map((sw) => [sw.id, sw]));
  return (
    <div className="mg-map">
      <div className="mg-stage">
        <div className="mg-ring-circle entry" />
        <div className="mg-ring-circle primary" />
        <div className="mg-ring-circle secondary" />
        {ringArrows.map(([tone, x, y, rotate], index) => <RingArrow key={index} tone={tone} x={x} y={y} rotate={rotate} />)}
        <svg className="mg-links" viewBox="0 0 100 100" preserveAspectRatio="none">
          <line x1="11.2" y1="52.5" x2="16.5" y2="48.5" className="mg-link entry static" />
          <line x1="50.8" y1="34.2" x2="64.8" y2="26.2" className="mg-link degraded static" />
          <line x1="43.6" y1="72.2" x2="66" y2="76" className="mg-link down static" />
          {connections.filter((conn) => conn.ring === 'edge' || conn.ring === 'bridge').map((conn, index) => {
            const from = byId[conn.from];
            const to = byId[conn.to];
            if (!from || !to) return null;
            return <line key={index} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`mg-link ${statusClass(conn.status)} ${conn.direction === 'Anti-horario' ? 'reverse' : ''} ${animateLinks ? '' : 'static'}`} />;
          })}
        </svg>
        <div className="mg-ring-label primary"><span>ANEL</span><span>PRIMARIO</span></div>
        <div className="mg-ring-label secondary"><span>ANEL</span><span>SECUNDARIO</span></div>
        {switches.map((site) => <SwitchNode key={`${site.id}-node`} site={site} />)}
        {switches.map((site) => <CompactSiteCard key={site.id} site={site} />)}
      </div>
    </div>
  );
}

function TopCards({ switches }) {
  const total = switches.length;
  const up = switches.filter((sw) => statusClass(sw.status) === 'up').length;
  const down = switches.filter((sw) => statusClass(sw.status) === 'down').length;
  const upload = switches.reduce((sum, sw) => sum + sw.uploadRaw, 0);
  const download = switches.reduce((sum, sw) => sum + sw.downloadRaw, 0);
  return (
    <div className="mg-topcards">
      <Summary icon="▦" label="TOTAL DE SITES" value={total} sub="Queries mapeadas" />
      <Summary icon="●" label="SITES UP" value={up} sub={`${Math.round((up / Math.max(total, 1)) * 100)}% operacionais`} tone="up" />
      <Summary icon="x" label="SITES DOWN" value={down} sub="Fora do ar" tone="down" />
      <Summary icon="⌁" label="TRAFEGO ATUAL" value={formatBps(upload + download)} sub={`Up ${formatBps(upload)} / Down ${formatBps(download)}`} tone="info" />
    </div>
  );
}

function Summary({ icon, label, value, sub, tone = '' }) {
  return <div className={`mg-summary ${tone}`}><div className="mg-summary-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{sub}</small></div></div>;
}

function SidePanel({ showLegend, showMiniFlow }) {
  return (
    <aside className="mg-side">
      {showLegend && <Box title="LEGENDA"><Legend color="#39d353" text="UP" /><Legend color="#f2cc0c" text="DEGRADADO" /><Legend color="#ff4d4d" text="DOWN" /><Legend color="#7b8494" text="SEM DADOS" /></Box>}
      <Box title="SENTIDO DO SINAL"><div className="mg-side-line">↻ Horario</div><div className="mg-side-line">↺ Anti-horario</div><div className="mg-side-line">→ Entrada</div><div className="mg-side-line">← Saida</div></Box>
      {showMiniFlow && <Box title="FLUXO EM TEMPO REAL"><div className="mg-mini-flow"><span /></div><p>Animado conforme o sentido configurado.</p></Box>}
    </aside>
  );
}

function Legend({ color, text }) {
  return <div className="mg-legend"><i style={{ background: color }} />{text}</div>;
}

function Box({ title, children }) {
  return <div className="mg-box"><h4>{title}</h4>{children}</div>;
}

function AlarmTable({ switches }) {
  const alarms = switches.filter((sw) => statusClass(sw.status) !== 'up');
  return (
    <div className="mg-bottom">
      <div className="mg-alarms">
        <h3>ALARMES ATIVOS</h3>
        <table><thead><tr><th>Severidade</th><th>Switch</th><th>Status</th></tr></thead><tbody>
          {alarms.length === 0 && <tr><td colSpan="3">Nenhum alarme calculado.</td></tr>}
          {alarms.map((sw) => <tr key={sw.id}><td><span className={`sev ${statusClass(sw.status) === 'down' ? 'crit' : 'high'}`}>{sw.status}</span></td><td>{sw.name}</td><td className="problem">{sw.status}</td></tr>)}
        </tbody></table>
      </div>
      <div className="mg-traffic"><h3>TRAFEGO TOTAL</h3><div className="mg-chart"><span /></div></div>
    </div>
  );
}

function Panel({ options, data, width, height }) {
  const opts = { ...defaults, ...options };
  const config = normalizeConfig(opts.config);
  const inventory = queryInventory(data);
  const rows = readFrames(data);
  const switches = layout(buildSwitches(config, inventory, rows), config.connections);
  const connections = buildConnections(config, switches, rows);

  return (
    <div className="mg-root" style={{ width, height }}>
      <main className="mg-shell">
        <header className="mg-header"><h2>{opts.title}</h2><span>Dados vindos das queries do painel</span></header>
        {opts.showTopCards && <TopCards switches={switches} />}
        <div className="mg-main"><NetworkMap switches={switches} connections={connections} animateLinks={opts.animateLinks} /><SidePanel showLegend={opts.showLegend} showMiniFlow={opts.showMiniFlow} /></div>
        {opts.showAlarms && <AlarmTable switches={switches} />}
      </main>
    </div>
  );
}

function Select({ value, options, onChange }) {
  return <select value={value || ''} onChange={(event) => onChange(event.target.value)}><option value="">Automatico</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

function ConfigEditor({ value, onChange, context }) {
  const [tab, setTab] = useState('switches');
  const config = normalizeConfig(value);
  const inventory = useMemo(() => queryInventory({ series: context.data || [] }), [context.data]);
  const switchOptions = config.switches.map((sw) => ({ value: sw.id, label: inventory.find((q) => q.refId === sw.refId)?.name || sw.refId || sw.id }));

  const update = (next) => onChange(normalizeConfig(next));
  const updateSwitch = (index, patch) => {
    const switches = config.switches.map((sw, i) => i === index ? { ...sw, ...patch } : sw);
    update({ ...config, switches });
  };
  const updateConnection = (index, patch) => {
    const connections = config.connections.map((conn, i) => i === index ? { ...conn, ...patch } : conn);
    update({ ...config, connections });
  };
  const addSwitch = () => {
    const available = inventory.find((query) => !config.switches.some((sw) => sw.refId === query.refId));
    if (!available) return;
    update({ ...config, switches: [...config.switches, { id: available.refId, refId: available.refId, direction: 'Horario', thresholds: defaultThresholds }] });
  };
  const addConnection = () => {
    if (config.switches.length < 2) return;
    update({ ...config, connections: [...config.connections, { from: config.switches[0].id, to: config.switches[1].id, ring: 'primary', direction: 'Horario', thresholds: defaultThresholds }] });
  };

  return (
    <div className="mg-editor">
      <div className="mg-editor-tabs">
        {['switches', 'connections', 'appearance', 'general'].map((name) => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}
      </div>
      {tab === 'switches' && <div>
        <button className="mg-editor-add" onClick={addSwitch}>+ Adicionar switch por query</button>
        {config.switches.map((sw, index) => {
          const query = inventory.find((item) => item.refId === sw.refId);
          const fieldOptions = (query?.fields || []).map((field) => ({ value: field.id, label: field.label }));
          return (
            <div className="mg-editor-card" key={index}>
              <label>Query do switch</label>
              <Select value={sw.refId} options={inventory.map((query) => ({ value: query.refId, label: `${query.refId} - ${query.name}` }))} onChange={(refId) => updateSwitch(index, { id: refId, refId })} />
              <small>Nome automatico: {query?.name || sw.refId}</small>
              <label>Upload</label><Select value={sw.uploadField} options={fieldOptions} onChange={(uploadField) => updateSwitch(index, { uploadField })} />
              <label>Download</label><Select value={sw.downloadField} options={fieldOptions} onChange={(downloadField) => updateSwitch(index, { downloadField })} />
              <label>Status</label><Select value={sw.statusField} options={fieldOptions} onChange={(statusField) => updateSwitch(index, { statusField })} />
              <label>Linha / Interface / Fluxo</label><Select value={sw.lineField} options={fieldOptions} onChange={(lineField) => updateSwitch(index, { lineField })} />
              <label>Sentido do sinal</label>
              <select value={sw.direction || 'Horario'} onChange={(event) => updateSwitch(index, { direction: event.target.value })}><option>Horario</option><option>Anti-horario</option><option>Entrada</option><option>Saida</option></select>
              <div className="mg-editor-row">
                <label>Upload atencao abaixo de</label><input type="number" value={sw.thresholds?.uploadWarnBps ?? defaultThresholds.uploadWarnBps} onChange={(event) => updateSwitch(index, { thresholds: { ...(sw.thresholds || defaultThresholds), uploadWarnBps: Number(event.target.value) } })} />
                <label>Upload critico abaixo de</label><input type="number" value={sw.thresholds?.uploadCritBps ?? defaultThresholds.uploadCritBps} onChange={(event) => updateSwitch(index, { thresholds: { ...(sw.thresholds || defaultThresholds), uploadCritBps: Number(event.target.value) } })} />
              </div>
            </div>
          );
        })}
      </div>}
      {tab === 'connections' && <div>
        <button className="mg-editor-add" onClick={addConnection}>+ Adicionar conexao</button>
        {config.connections.map((conn, index) => {
          const source = config.switches.find((sw) => sw.id === conn.from) || config.switches.find((sw) => sw.id === conn.to);
          const query = inventory.find((item) => item.refId === (conn.refId || source?.refId));
          const fieldOptions = (query?.fields || []).map((field) => ({ value: field.id, label: field.label }));
          return (
            <div className="mg-editor-card" key={index}>
              <label>Origem</label><Select value={conn.from} options={switchOptions} onChange={(from) => updateConnection(index, { from })} />
              <label>Destino</label><Select value={conn.to} options={switchOptions} onChange={(to) => updateConnection(index, { to })} />
              <label>Tipo de anel</label><select value={conn.ring || 'primary'} onChange={(event) => updateConnection(index, { ring: event.target.value })}><option value="primary">Primario</option><option value="secondary">Secundario</option><option value="bridge">Interligacao</option><option value="edge">Entrada/Saida</option></select>
              <label>Query da linha/interface</label><Select value={conn.refId || source?.refId} options={inventory.map((query) => ({ value: query.refId, label: `${query.refId} - ${query.name}` }))} onChange={(refId) => updateConnection(index, { refId })} />
              <label>Item da linha/interface</label><Select value={conn.lineField} options={fieldOptions} onChange={(lineField) => updateConnection(index, { lineField })} />
              <label>Sentido da linha</label><select value={conn.direction || 'Horario'} onChange={(event) => updateConnection(index, { direction: event.target.value })}><option>Horario</option><option>Anti-horario</option><option>Entrada</option><option>Saida</option></select>
            </div>
          );
        })}
      </div>}
      {tab === 'appearance' && <div className="mg-editor-card">
        <label>Largura dos cards</label><input type="number" value={config.appearance.cardWidth} onChange={(event) => update({ ...config, appearance: { ...config.appearance, cardWidth: Number(event.target.value) } })} />
        <label>Largura das linhas</label><input type="number" value={config.appearance.lineWidth} onChange={(event) => update({ ...config, appearance: { ...config.appearance, lineWidth: Number(event.target.value) } })} />
      </div>}
      {tab === 'general' && <div className="mg-editor-card"><p>Use as queries A, B, C... do painel para alimentar os switches. O editor lista apenas itens que chegaram do Zabbix para o intervalo atual.</p></div>}
    </div>
  );
}

export const plugin = new PanelPlugin(Panel).setPanelOptions((builder) => {
  builder
    .addTextInput({ path: 'title', name: 'Titulo do painel', defaultValue: defaults.title })
    .addBooleanSwitch({ path: 'showTopCards', name: 'Mostrar cards superiores', defaultValue: defaults.showTopCards })
    .addBooleanSwitch({ path: 'showLegend', name: 'Mostrar legenda', defaultValue: defaults.showLegend })
    .addBooleanSwitch({ path: 'showMiniFlow', name: 'Mostrar mini fluxo', defaultValue: defaults.showMiniFlow })
    .addBooleanSwitch({ path: 'showAlarms', name: 'Mostrar tabela de alarmes', defaultValue: defaults.showAlarms })
    .addBooleanSwitch({ path: 'animateLinks', name: 'Animar linhas', defaultValue: defaults.animateLinks })
    .addCustomEditor({ id: 'config', path: 'config', name: 'Configuracao do mapa', editor: ConfigEditor, defaultValue: defaults.config });
});
