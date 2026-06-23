import React, { useMemo, useRef, useState } from 'react';
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
  showTraffic: true,
  showAlarms: true,
  animateLinks: true,
  blinkOnAlert: true,
  showTooltips: true,
  linkBase: '',
  linkCapacityBps: 2_500_000_000,
  config: {
    switches: [],
    connections: [],
    elements: [],
    rules: [],
    positions: {},
    cardSizes: {},
    excludedSwitches: [],
    rings: {
      entry: { left: 3.6, top: 46.5, width: 10, height: 17.5 },
      primary: { left: 13.97, top: 14.06, width: 39.63, height: 70.83 },
      secondary: { left: 43.68, top: 13.02, width: 39.04, height: 72.92 },
    },
    layout: {
      mapHeight: 640,
    },
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

function toArray(values) {
  if (!values) return [];
  if (Array.isArray(values)) return values;
  if (typeof values.length === 'number' && typeof values.get === 'function') {
    const out = [];
    for (let i = 0; i < values.length; i += 1) out.push(values.get(i));
    return out;
  }
  return [];
}

function readSeries(data) {
  const byRef = {};
  (data?.series || []).forEach((frame, index) => {
    const valueField = frame.fields?.find((field) => field.type === 'number') || frame.fields?.find((field) => field.name === 'Value');
    if (!valueField) return;
    const timeField = frame.fields?.find((field) => field.type === 'time');
    const refId = frameRef(frame, index);
    const labels = valueField.labels || {};
    const id = fieldId({ refId, item: labels.item || frame.name || '', key: labels.item_key || '' });
    byRef[refId] = byRef[refId] || {};
    byRef[refId][id] = {
      values: toArray(valueField.values).map((value) => Number(value)),
      times: toArray(timeField?.values).map((value) => Number(value)),
    };
  });
  return byRef;
}

function seriesFor(seriesByRef, refId, fieldSelector, kind) {
  const byField = seriesByRef[refId];
  if (!byField) return [];
  if (fieldSelector && byField[fieldSelector]) return byField[fieldSelector].values;
  const rx = kind === 'upload' ? /bits sent|net\.if\.out|tx|out/i : /bits received|net\.if\.in|rx|in/i;
  const match = Object.entries(byField).find(([key]) => rx.test(key));
  return match ? match[1].values : [];
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
    elements: Array.isArray(current.elements) ? current.elements : [],
    rules: Array.isArray(current.rules) ? current.rules : [],
    positions: current.positions && typeof current.positions === 'object' ? current.positions : {},
    cardSizes: current.cardSizes && typeof current.cardSizes === 'object' ? current.cardSizes : {},
    excludedSwitches: Array.isArray(current.excludedSwitches) ? current.excludedSwitches : [],
    rings: {
      ...defaults.config.rings,
      ...(current.rings || {}),
      entry: { ...defaults.config.rings.entry, ...(current.rings?.entry || {}) },
      primary: { ...defaults.config.rings.primary, ...(current.rings?.primary || {}) },
      secondary: { ...defaults.config.rings.secondary, ...(current.rings?.secondary || {}) },
    },
    layout: { ...defaults.config.layout, ...(current.layout || {}) },
    appearance: { ...defaults.config.appearance, ...(current.appearance || {}) },
  };
}

function switchConfigsForInventory(config, inventory) {
  const excluded = new Set(config.excludedSwitches || []);
  const configured = config.switches || [];
  const fromInventory = (inventory || []).map((query) => ({
    id: query.refId,
    refId: query.refId,
    direction: 'Horario',
    thresholds: defaultThresholds,
    ...(configured.find((sw) => sw.refId === query.refId && !sw.duplicateOf && (sw.id === query.refId || !sw.id)) || {}),
  })).filter((sw) => !excluded.has(sw.refId) && !excluded.has(sw.id));
  const inventoryRefs = new Set(fromInventory.map((sw) => sw.refId));
  const autoIds = new Set(fromInventory.map((sw) => sw.id));
  const manual = configured.filter((sw) => sw.refId && (!inventoryRefs.has(sw.refId) || sw.duplicateOf || !autoIds.has(sw.id)));
  return [...fromInventory, ...manual];
}

function buildSwitches(config, inventory, rows, seriesByRef) {
  const configured = switchConfigsForInventory(config, inventory).filter((sw) => !sw.hidden && !sw.deleted);

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
      uploadSeries: seriesFor(seriesByRef || {}, sw.refId, uploadField, 'upload'),
      downloadSeries: seriesFor(seriesByRef || {}, sw.refId, downloadField, 'download'),
      statusValue,
      lineValue,
      direction,
      status: statusFrom(statusValue, upload, download, thresholds),
    };
  });
}

function metricForRule(site, metric) {
  switch (metric) {
    case 'upload': return site.uploadRaw;
    case 'download': return site.downloadRaw;
    case 'traffic': return site.uploadRaw + site.downloadRaw;
    case 'status': return site.statusValue;
    case 'line': return site.lineValue;
    default: return null;
  }
}

function evalRules(site, rules) {
  const out = {};
  (rules || []).forEach((rule) => {
    if (rule.scope && rule.scope !== 'all' && rule.scope !== site.id) return;
    const value = metricForRule(site, rule.metric || 'traffic');
    if (value === null || value === undefined || Number.isNaN(Number(value))) return;
    const steps = [...(rule.steps || [])].sort((a, b) => Number(a.when) - Number(b.when));
    let matched = null;
    steps.forEach((step) => { if (Number(value) >= Number(step.when)) matched = step; });
    if (!matched) return;
    const apply = rule.apply || ['border'];
    if (apply.includes('border')) out.border = matched.color;
    if (apply.includes('background')) out.background = matched.color;
    if (apply.includes('text')) out.textColor = matched.color;
    if (apply.includes('blink')) out.blink = true;
    if (matched.text) out.badge = matched.text;
  });
  return out;
}

function resolveLink(template, site) {
  if (!template) return '';
  return template
    .replace(/\$\{host\}/g, encodeURIComponent(site.host || ''))
    .replace(/\$\{name\}/g, encodeURIComponent(site.name || ''))
    .replace(/\$\{refId\}/g, encodeURIComponent(site.refId || ''))
    .replace(/\$\{value\}/g, encodeURIComponent(String(site.value ?? '')));
}

function renderTemplate(template, site) {
  if (!template) return site.name || '';
  return template
    .replace(/\$\{host\}/g, site.host || '')
    .replace(/\$\{name\}/g, site.name || '')
    .replace(/\$\{refId\}/g, site.refId || '')
    .replace(/\$\{status\}/g, site.status || '')
    .replace(/\$\{upload\}/g, site.upload || '')
    .replace(/\$\{download\}/g, site.download || '')
    .replace(/\$\{value\}/g, String(site.value ?? ''));
}

function elementTarget(element, switches) {
  const site = switches.find((sw) => sw.id === element.scope || sw.refId === element.scope) || switches.find((sw) => canonicalSite(sw.name) === canonicalSite(element.scope));
  if (!site) return null;
  const value = metricForRule(site, element.metric || 'traffic');
  return { ...site, id: element.id || site.id, value };
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

function layout(switches, connections, positions = {}) {
  const primaryOrder = ['sedi-metrogyn', 'seduce', 'seapa', 'sead', 'ptt-ufg', 'fapeg', 'sedi-pplt', 'radio-ufg', 'crer'];
  const secondaryOrder = ['ptt-ufg', 'semad', 'ccon', 'goiasprev-ipasgo', 'hugo', 'detran', 'radio-ufg'];
  const byKey = Object.fromEntries(switches.map((sw) => [canonicalSite(sw.name), sw.id]));
  const ids = switches.map((sw) => sw.id);
  const primary = primaryOrder.map((key) => byKey[key]).filter(Boolean);
  const secondary = secondaryOrder.map((key) => byKey[key]).filter(Boolean);
  const rest = ids.filter((id) => !primary.includes(id) && !secondary.includes(id) && id !== byKey.emater);
  const targetByKey = {
    emater: { x: 4.9, y: 57.2, nodeX: 3.68, nodeY: 46.35 },
    'sedi-metrogyn': { x: 12.0, y: 61.0, nodeX: 17.0, nodeY: 76.0 },
    seduce: { x: 14.0, y: 40.0, nodeX: 12.5, nodeY: 25.52 },
    seapa: { x: 23.0, y: 25.0, nodeX: 21.32, nodeY: 15.1 },
    sead: { x: 35.0, y: 19.0, nodeX: 33.09, nodeY: 9.9 },
    'ptt-ufg': { x: 47.5, y: 25.0, nodeX: 44.85, nodeY: 20.31 },
    fapeg: { x: 53.5, y: 41.0, nodeX: 47.79, nodeY: 35.94 },
    'sedi-pplt': { x: 53.5, y: 58.0, nodeX: 47.79, nodeY: 56.77 },
    'radio-ufg': { x: 44.0, y: 75.0, nodeX: 44.85, nodeY: 72.4 },
    semad: { x: 63.5, y: 19.0, nodeX: 62.5, nodeY: 9.9 },
    ccon: { x: 79.0, y: 33.0, nodeX: 77.21, nodeY: 25.52 },
    'goiasprev-ipasgo': { x: 86.0, y: 50.0, nodeX: 80.15, nodeY: 46.35 },
    detran: { x: 68.0, y: 78.0, nodeX: 65.44, nodeY: 82.81 },
    hugo: { x: 80.0, y: 66.0, nodeX: 74.5, nodeY: 70 },
    crer: { x: 33.0, y: 78.0, nodeX: 40.8, nodeY: 75.6 },
  };
  const target = {};
  switches.forEach((sw) => {
    const pos = targetByKey[canonicalSite(sw.name)];
    if (pos) target[sw.id] = pos;
  });
  place(rest, 55, 52, 7, 21, 240, 240, target);
  return switches.map((sw, index) => {
    const key = canonicalSite(sw.name);
    const base = target[sw.id] || { ...point(50, 50, 31, 31, (index / Math.max(switches.length, 1)) * 360), nodeX: 50, nodeY: 50 };
    const override = positions[sw.id] || positions[sw.refId] || positions[key] || {};
    return {
      ...sw,
      segment: key,
      clockwise: nextName(key, primaryOrder, secondaryOrder, switches),
      counter: prevName(key, primaryOrder, secondaryOrder, switches),
      ...base,
      ...override,
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

function Sparkline({ values, color, width = 150, height = 34 }) {
  const clean = (values || []).filter((value) => Number.isFinite(value));
  if (clean.length < 2) return <div className="mg-spark-empty">sem histórico</div>;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const step = width / (clean.length - 1);
  const points = clean.map((value, index) => `${(index * step).toFixed(1)},${(height - ((value - min) / span) * height).toFixed(1)}`).join(' ');
  return (
    <svg className="mg-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.6" />
    </svg>
  );
}

function SiteTooltip({ site }) {
  return (
    <div className="mg-tooltip">
      <div className="mg-tt-head"><strong>{site.name}</strong><span className={`mg-tt-status ${statusClass(site.status)}`}>{site.status}</span></div>
      {site.host && <div className="mg-tt-host">{site.host}</div>}
      <div className="mg-tt-row"><i style={{ background: '#54a7ff' }} />Upload <b>{site.upload}</b></div>
      <Sparkline values={site.uploadSeries} color="#54a7ff" />
      <div className="mg-tt-row"><i style={{ background: '#55ff6d' }} />Download <b>{site.download}</b></div>
      <Sparkline values={site.downloadSeries} color="#55ff6d" />
    </div>
  );
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

function CompactSiteCard({ site, rules, link, blinkOnAlert, showTooltips, editMode, onDragPosition, onResizeCard }) {
  const cls = statusClass(site.status);
  const clockwise = site.clockwise || 'Proximo';
  const counter = site.counter || 'Anterior';
  const effects = evalRules(site, rules);
  const blink = (blinkOnAlert && cls === 'down') || effects.blink;
  const href = editMode ? '' : site.link || resolveLink(link, site);
  const style = { left: `${site.x}%`, top: `${site.y}%` };
  if (site.cardWidth) style.width = `${site.cardWidth}px`;
  if (site.cardHeight) style.minHeight = `${site.cardHeight}px`;
  if (site.cardWidth || site.cardHeight) {
    const scale = Math.max(0.78, Math.min(1.25, Math.min(Number(site.cardWidth || 118) / 118, Number(site.cardHeight || 58) / 58)));
    style['--card-scale'] = scale.toFixed(2);
  }
  if (effects.border) style['--site-color'] = effects.border;
  if (effects.background) style.background = effects.background;
  const className = `mg-site-card ${cls} ${blink ? 'blink' : ''} ${href ? 'linked' : ''} ${editMode ? 'editable' : ''}`;
  const Tag = href ? 'a' : 'div';
  const tagProps = href ? { href, target: '_blank', rel: 'noreferrer' } : {};
  return (
    <Tag className={className} style={style} onPointerDown={editMode ? (event) => onDragPosition(event, site, 'card') : undefined} {...tagProps}>
      <div className="mg-card-head">
        <strong style={effects.textColor ? { color: effects.textColor } : undefined}>{site.name}</strong>
        {effects.badge && <span className="mg-badge" style={effects.border ? { color: effects.border } : undefined}>{effects.badge}</span>}
      </div>
      <div className="mg-card-body">
        <div className="mg-dir-block">
          <div className="mg-next">{'\u2192'} {clockwise}</div>
          <div className="mg-metric"><b>TX:</b>{site.upload}</div>
          <div className="mg-metric"><b>RX:</b>{site.download}</div>
        </div>
        <div className="mg-dir-block">
          <div className="mg-next mg-prev">{'\u2190'} {counter}</div>
          <div className="mg-metric"><b>TX:</b>{site.download}</div>
          <div className="mg-metric"><b>RX:</b>{site.upload}</div>
        </div>
      </div>
      {editMode && <span className="mg-card-resize" onPointerDown={(event) => onResizeCard(event, site)} />}
      {showTooltips && <SiteTooltip site={site} />}
    </Tag>
  );
}

function SwitchNode({ site, blinkOnAlert, editMode, onDragPosition }) {
  const cls = statusClass(site.status);
  const blink = blinkOnAlert && cls === 'down';
  return (
    <div className={`mg-switch-node ${blink ? 'blink' : ''} ${editMode ? 'editable' : ''}`} onPointerDown={editMode ? (event) => onDragPosition(event, site, 'node') : undefined} style={{ left: `${site.nodeX ?? site.x}%`, top: `${site.nodeY ?? site.y}%` }}>
      <SwitchIcon state={cls} />
    </div>
  );
}

function ringStyle(ring) {
  return {
    left: `${Number(ring.left ?? 0)}%`,
    top: `${Number(ring.top ?? 0)}%`,
    width: `${Number(ring.width ?? 10)}%`,
    height: `${Number(ring.height ?? ring.width ?? 10)}%`,
  };
}

function ringCenter(ring) {
  return {
    left: `${Number(ring.left ?? 0) + Number(ring.width ?? 0) / 2}%`,
    top: `${Number(ring.top ?? 0) + Number(ring.height ?? ring.width ?? 0) / 2}%`,
  };
}

function FlowElement({ element, switches, rules, linkBase, editMode, onDragElement }) {
  if (element.enabled === false) return null;
  if (element.type === 'line') return null;
  const target = elementTarget(element, switches) || {
    id: element.id,
    name: element.label || element.id || 'element',
    value: '',
    status: 'UNKNOWN',
  };
  const effects = evalRules(target, rules);
  const style = {
    left: `${Number(element.x ?? 50)}%`,
    top: `${Number(element.y ?? 50)}%`,
    width: `${Number(element.w ?? 8)}%`,
    height: `${Number(element.h ?? 4)}%`,
    '--flow-color': effects.border || element.color || '#42b8ff',
    color: effects.textColor || element.textColor || '#dce8f6',
  };
  if (effects.background) style.background = effects.background;
  const text = renderTemplate(element.text || element.label || '${name}: ${value}', target);
  const href = editMode ? '' : element.link || resolveLink(linkBase, target);
  const Tag = href ? 'a' : 'div';
  const props = href ? { href, target: '_blank', rel: 'noreferrer' } : {};
  return (
    <Tag className={`mg-flow-element ${element.type || 'rect'} ${effects.blink ? 'blink' : ''} ${editMode ? 'editable' : ''}`} onPointerDown={editMode ? (event) => onDragElement(event, element) : undefined} style={style} {...props}>
      <span>{text}</span>
    </Tag>
  );
}

function NetworkMap({ switches, connections, animateLinks, rules, elements, rings, linkBase, blinkOnAlert, showTooltips, editMode, onMoveSwitch, onMoveElement, onMoveRing, onResizeRing, onResizeCard }) {
  const byId = Object.fromEntries(switches.map((sw) => [sw.id, sw]));
  const stageRef = useRef(null);
  const pointFromEvent = (event) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100)),
    };
  };
  const startDragSwitch = (event, site, target) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => {
      const point = pointFromEvent(moveEvent);
      if (point) onMoveSwitch(site, target, point);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    move(event);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  const startDragElement = (event, element) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (moveEvent) => {
      const point = pointFromEvent(moveEvent);
      if (point) onMoveElement(element, point);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    move(event);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  const startResizeCard = (event, site) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const card = event.currentTarget.closest('.mg-site-card');
    const rect = card?.getBoundingClientRect();
    const baseWidth = Number(site.cardWidth || rect?.width || 118);
    const baseHeight = Number(site.cardHeight || rect?.height || 58);
    const move = (moveEvent) => {
      onResizeCard(site, {
        width: baseWidth + moveEvent.clientX - startX,
        height: baseHeight + moveEvent.clientY - startY,
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  const startDragRing = (event, ringName, mode) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const start = pointFromEvent(event);
    const ring = rings[ringName];
    if (!start || !ring) return;
    const base = { ...ring };
    const move = (moveEvent) => {
      const point = pointFromEvent(moveEvent);
      if (!point) return;
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      if (mode === 'resize') {
        onResizeRing(ringName, {
          width: Math.max(4, Number(base.width || 10) + dx),
          height: Math.max(4, Number(base.height || base.width || 10) + dy),
        });
      } else {
        onMoveRing(ringName, {
          left: Number(base.left || 0) + dx,
          top: Number(base.top || 0) + dy,
        });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  return (
    <div className={`mg-map ${editMode ? 'editing' : ''}`}>
      <div className="mg-stage" ref={stageRef}>
        {['entry', 'primary', 'secondary'].map((name) => (
          <div key={name} className={`mg-ring-circle ${name} ${editMode ? 'editable' : ''}`} style={ringStyle(rings[name])} onPointerDown={editMode ? (event) => startDragRing(event, name, 'move') : undefined}>
            {editMode && <span className="mg-ring-handle" onPointerDown={(event) => startDragRing(event, name, 'resize')} />}
          </div>
        ))}
        <svg className="mg-links" viewBox="0 0 100 100" preserveAspectRatio="none" />
        <div className="mg-ring-label primary" style={ringCenter(rings.primary)}><span>ANEL</span><span>PRIMARIO</span></div>
        <div className="mg-ring-label secondary" style={ringCenter(rings.secondary)}><span>ANEL</span><span>SECUNDARIO</span></div>
        {switches.map((site) => <SwitchNode key={`${site.id}-node`} site={site} blinkOnAlert={blinkOnAlert} editMode={editMode} onDragPosition={startDragSwitch} />)}
        {(elements || []).map((element, index) => <FlowElement key={element.id || index} element={element} switches={switches} rules={rules} linkBase={linkBase} editMode={editMode} onDragElement={startDragElement} />)}
        {switches.map((site) => <CompactSiteCard key={site.id} site={site} rules={rules} link={linkBase} blinkOnAlert={blinkOnAlert} showTooltips={showTooltips && !editMode} editMode={editMode} onDragPosition={startDragSwitch} onResizeCard={startResizeCard} />)}
      </div>
    </div>
  );
}

function TopCards({ switches, capacity }) {
  const total = switches.length;
  const up = switches.filter((sw) => statusClass(sw.status) === 'up').length;
  const down = switches.filter((sw) => statusClass(sw.status) === 'down').length;
  const upload = switches.reduce((sum, sw) => sum + sw.uploadRaw, 0);
  const download = switches.reduce((sum, sw) => sum + sw.downloadRaw, 0);
  const upPct = Math.round((up / Math.max(total, 1)) * 100);
  const downPct = Math.round((down / Math.max(total, 1)) * 100);
  return (
    <div className="mg-topcards">
      <Summary icon="building" label="TOTAL DE SITES" value={total} sub="Todos os sites" />
      <Summary icon="check" label="SITES UP" value={up} sub={`${upPct}% operacionais`} tone="up" />
      <Summary icon="cross" label="SITES DOWN" value={down} sub={`${downPct}% fora do ar`} tone="down" />
      <Summary icon="chart" label="TRÁFEGO TOTAL" value={formatBps(upload + download)} sub={`↑ ${formatBps(upload)}  ↓ ${formatBps(download)}`} tone="info" />
      <Summary icon="warn" label="ALARMES CRÍTICOS" value={down} sub={down === 0 ? 'Sem alarmes' : `${down} crítico(s)`} tone="warn" />
      <DonutSummary value={capacity} label="Capacidade média" />
    </div>
  );
}

const summaryIcons = {
  building: <path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M14 21V9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v12M3 21h18M7 8h0M7 12h0M7 16h0M10 8h0M10 12h0M10 16h0M17 12h0M17 16h0" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  chart: <path d="M4 18l5-6 4 3 6-8M4 20h16" />,
  warn: <path d="M12 3l9 16H3L12 3zM12 10v4M12 17h0" />,
};

function Summary({ icon, label, value, sub, tone = '' }) {
  return (
    <div className={`mg-summary ${tone}`}>
      <div className="mg-summary-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{summaryIcons[icon]}</svg>
      </div>
      <div><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>
    </div>
  );
}

function DonutSummary({ value, label }) {
  const pct = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  return (
    <div className="mg-summary donut">
      <div className="mg-donut" style={{ '--pct': pct }}><span>{pct}%</span></div>
      <div><small className="mg-donut-label">{label}</small></div>
    </div>
  );
}

function SidePanel({ showLegend, showMiniFlow, showTraffic, upload, download }) {
  return (
    <aside className="mg-side">
      {showLegend && <Box title="LEGENDA - STATUS"><Legend color="#39d353" text="UP - Operacional" /><Legend color="#f2cc0c" text="DEGRADADO" /><Legend color="#ff4d4d" text="DOWN - Falha" /><Legend color="#7b8494" text="SEM DADOS" /></Box>}
      <Box title="SENTIDO DO SINAL">
        <div className="mg-side-line"><span className="mg-dir">→</span> Horário <em>(clockwise)</em></div>
        <div className="mg-side-line"><span className="mg-dir">←</span> Anti-horário <em>(counter)</em></div>
      </Box>
      {showMiniFlow && <Box title="FLUXO EM TEMPO REAL">
        <div className="mg-flow-pair">
          <div className="mg-flow-item"><div className="mg-mini-flow primary" /><span>Horário</span></div>
          <div className="mg-flow-item"><div className="mg-mini-flow secondary" /><span>Anti-horário</span></div>
        </div>
      </Box>}
      {showTraffic && <Box title="TRÁFEGO TOTAL (5 MIN)">
        <div className="mg-chart"><span /></div>
        <div className="mg-chart-legend">
          <div><i style={{ background: '#54a7ff' }} />Upload ({formatBps(upload)})</div>
          <div><i style={{ background: '#55ff6d' }} />Download ({formatBps(download)})</div>
        </div>
      </Box>}
    </aside>
  );
}

function Legend({ color, text }) {
  return <div className="mg-legend"><i className="mg-dot" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />{text}</div>;
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
        <table>
          <thead><tr><th>Severidade</th><th>Hora</th><th>Switch</th><th>Problema</th><th>Duração</th><th>Status</th><th>Ack</th><th>Tags</th></tr></thead>
          <tbody>
            {alarms.length === 0 && <tr className="mg-empty-row"><td colSpan="8"><span className="mg-empty"><i>✓</i> Nenhum alarme ativo no momento</span></td></tr>}
            {alarms.map((sw) => (
              <tr key={sw.id}>
                <td><span className={`sev ${statusClass(sw.status) === 'down' ? 'crit' : 'high'}`}>{statusClass(sw.status) === 'down' ? 'Crítico' : 'Aviso'}</span></td>
                <td>—</td>
                <td>{sw.name}</td>
                <td className="problem">{statusClass(sw.status) === 'down' ? 'Switch fora do ar' : 'Tráfego degradado'}</td>
                <td>—</td>
                <td>{sw.status}</td>
                <td>—</td>
                <td>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Panel({ options, data, width, height, onOptionsChange }) {
  const opts = { ...defaults, ...options };
  const config = normalizeConfig(opts.config);
  const [editPositions, setEditPositions] = useState(false);
  const inventory = queryInventory(data);
  const rows = readFrames(data);
  const seriesByRef = readSeries(data);
  const switches = layout(buildSwitches(config, inventory, rows, seriesByRef), config.connections, config.positions)
    .map((sw) => ({ ...sw, ...(config.cardSizes?.[sw.id] || {}) }));
  const connections = buildConnections(config, switches, rows);
  const upload = switches.reduce((sum, sw) => sum + sw.uploadRaw, 0);
  const download = switches.reduce((sum, sw) => sum + sw.downloadRaw, 0);
  const capacityBps = Number(opts.linkCapacityBps) > 0 ? Number(opts.linkCapacityBps) : defaults.linkCapacityBps;
  const loads = switches.map((sw) => Math.min(100, ((sw.uploadRaw + sw.downloadRaw) / capacityBps) * 100));
  const capacity = loads.length ? loads.reduce((sum, value) => sum + value, 0) / loads.length : 0;

  const updateConfig = (nextConfig) => {
    if (typeof onOptionsChange === 'function') onOptionsChange({ ...opts, config: normalizeConfig(nextConfig) });
  };
  const moveSwitch = (site, target, point) => {
    const current = config.positions?.[site.id] || {};
    const patch = target === 'node'
      ? { nodeX: Number(point.x.toFixed(2)), nodeY: Number(point.y.toFixed(2)) }
      : { x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)) };
    updateConfig({ ...config, positions: { ...config.positions, [site.id]: { ...current, ...patch } } });
  };
  const resizeCard = (site, size) => {
    const current = config.cardSizes?.[site.id] || {};
    updateConfig({
      ...config,
      cardSizes: {
        ...config.cardSizes,
        [site.id]: {
          ...current,
          cardWidth: Math.round(Math.max(86, Math.min(260, size.width))),
          cardHeight: Math.round(Math.max(42, Math.min(180, size.height))),
        },
      },
    });
  };
  const moveElement = (element, point) => {
    const elements = config.elements.map((item) => item === element || item.id === element.id ? { ...item, x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)) } : item);
    updateConfig({ ...config, elements });
  };
  const moveRing = (ringName, point) => {
    const current = config.rings?.[ringName] || defaults.config.rings[ringName];
    updateConfig({
      ...config,
      rings: {
        ...config.rings,
        [ringName]: {
          ...current,
          left: Number(Math.max(-30, Math.min(130, point.left)).toFixed(2)),
          top: Number(Math.max(-30, Math.min(130, point.top)).toFixed(2)),
        },
      },
    });
  };
  const resizeRing = (ringName, size) => {
    const current = config.rings?.[ringName] || defaults.config.rings[ringName];
    updateConfig({
      ...config,
      rings: {
        ...config.rings,
        [ringName]: {
          ...current,
          width: Number(Math.max(4, Math.min(140, size.width)).toFixed(2)),
          height: Number(Math.max(4, Math.min(140, size.height)).toFixed(2)),
        },
      },
    });
  };
  const startResizeMap = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const base = Number(config.layout?.mapHeight || defaults.config.layout.mapHeight);
    const move = (moveEvent) => {
      const nextHeight = Math.max(280, Math.min(1200, base + (moveEvent.clientY - startY)));
      updateConfig({ ...config, layout: { ...config.layout, mapHeight: Math.round(nextHeight) } });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  return (
    <div className="mg-root" style={{ width, height }}>
      <main className="mg-shell">
        <header className="mg-header">
          <h2><span className="mg-logo">⚙</span>{opts.title}</h2>
          <button className={`mg-position-toggle ${editPositions ? 'active' : ''}`} onClick={() => setEditPositions(!editPositions)}>{editPositions ? 'Salvar posições' : 'Editar posições'}</button>
        </header>
        {opts.showTopCards && <TopCards switches={switches} capacity={capacity} />}
        <div className="mg-main" style={{ '--map-height': `${Number(config.layout?.mapHeight || defaults.config.layout.mapHeight)}px` }}><NetworkMap switches={switches} connections={connections} animateLinks={opts.animateLinks} rules={config.rules} elements={config.elements} rings={config.rings} linkBase={opts.linkBase} blinkOnAlert={opts.blinkOnAlert} showTooltips={opts.showTooltips} editMode={editPositions} onMoveSwitch={moveSwitch} onMoveElement={moveElement} onMoveRing={moveRing} onResizeRing={resizeRing} onResizeCard={resizeCard} /><SidePanel showLegend={opts.showLegend} showMiniFlow={opts.showMiniFlow} showTraffic={opts.showTraffic} upload={upload} download={download} /></div>
        {editPositions && <div className="mg-alarm-resize" onPointerDown={startResizeMap} title="Arraste para ajustar a altura do mapa" />}
        {opts.showAlarms && <AlarmTable switches={switches} />}
      </main>
    </div>
  );
}

function Select({ value, options, onChange }) {
  return <select value={value || ''} onChange={(event) => onChange(event.target.value)}><option value="">Automatico</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
}

function ComboInput({ value, options, onChange, placeholder = 'Automatico' }) {
  const id = useMemo(() => `mg-list-${Math.random().toString(36).slice(2)}`, []);
  return (
    <>
      <input list={id} value={value || ''} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      <datalist id={id}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </datalist>
    </>
  );
}

function ConfigEditor({ value, onChange, context }) {
  const [tab, setTab] = useState('switches');
  const [openCards, setOpenCards] = useState({});
  const config = normalizeConfig(value);
  const inventory = useMemo(() => queryInventory({ series: context.data || [] }), [context.data]);
  const visibleSwitches = switchConfigsForInventory(config, inventory);
  const switchOptions = visibleSwitches.map((sw) => ({ value: sw.id, label: inventory.find((q) => q.refId === sw.refId)?.name || sw.refId || sw.id }));

  const update = (next) => onChange(normalizeConfig(next));
  const updateSwitch = (index, patch) => {
    const switches = visibleSwitches.map((sw, i) => i === index ? { ...sw, ...patch } : sw);
    update({ ...config, switches });
  };
  const duplicateSwitch = (index) => {
    const source = visibleSwitches[index];
    if (!source) return;
    const copyId = `${source.refId || source.id}-copy-${Date.now().toString(36)}`;
    update({ ...config, switches: [...visibleSwitches, { ...source, id: copyId, duplicateOf: source.id || source.refId, hidden: false, deleted: false }] });
  };
  const deleteSwitch = (index) => {
    const target = visibleSwitches[index];
    if (!target) return;
    const switches = visibleSwitches.filter((_, i) => i !== index);
    const excludedSwitches = target.id === target.refId && !target.duplicateOf
      ? Array.from(new Set([...(config.excludedSwitches || []), target.refId]))
      : config.excludedSwitches;
    update({ ...config, switches, excludedSwitches });
  };
  const updateConnection = (index, patch) => {
    const connections = config.connections.map((conn, i) => i === index ? { ...conn, ...patch } : conn);
    update({ ...config, connections });
  };
  const updateElement = (index, patch) => {
    const elements = config.elements.map((element, i) => i === index ? { ...element, ...patch } : element);
    update({ ...config, elements });
  };
  const addElement = () => update({ ...config, elements: [...config.elements, { id: `element-${config.elements.length + 1}`, type: 'rect', x: 50, y: 50, w: 10, h: 5, scope: 'all', metric: 'traffic', text: '${name}: ${value}', color: '#42b8ff', enabled: true }] });
  const removeElement = (index) => update({ ...config, elements: config.elements.filter((_, i) => i !== index) });
  const addSwitch = () => {
    const existingRefs = new Set(visibleSwitches.map((sw) => sw.refId));
    const available = inventory.find((query) => !existingRefs.has(query.refId)) || inventory[0];
    const refId = available?.refId || `manual-${Date.now().toString(36)}`;
    const newSwitch = {
      id: existingRefs.has(refId) ? `${refId}-manual-${Date.now().toString(36)}` : refId,
      refId,
      direction: 'Horario',
      thresholds: defaultThresholds,
    };
    update({
      ...config,
      switches: [...visibleSwitches, newSwitch],
      excludedSwitches: (config.excludedSwitches || []).filter((item) => item !== refId && item !== newSwitch.id),
    });
  };
  const addConnection = () => {
    if (visibleSwitches.length < 2) return;
    update({ ...config, connections: [...config.connections, { from: visibleSwitches[0].id, to: visibleSwitches[1].id, ring: 'primary', direction: 'Horario', thresholds: defaultThresholds }] });
  };
  const updateRule = (index, patch) => {
    const rules = config.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule);
    update({ ...config, rules });
  };
  const removeRule = (index) => update({ ...config, rules: config.rules.filter((_, i) => i !== index) });
  const addRule = () => update({ ...config, rules: [...config.rules, { name: 'Nova regra', scope: 'all', metric: 'traffic', apply: ['border'], steps: [{ when: 0, color: '#39d353', text: '' }] }] });
  const toggleApply = (index, key) => {
    const apply = new Set(config.rules[index].apply || []);
    if (apply.has(key)) apply.delete(key); else apply.add(key);
    updateRule(index, { apply: [...apply] });
  };
  const updateStep = (ri, si, patch) => updateRule(ri, { steps: (config.rules[ri].steps || []).map((step, i) => i === si ? { ...step, ...patch } : step) });
  const addStep = (ri) => updateRule(ri, { steps: [...(config.rules[ri].steps || []), { when: 0, color: '#f2cc0c', text: '' }] });
  const removeStep = (ri, si) => updateRule(ri, { steps: (config.rules[ri].steps || []).filter((_, i) => i !== si) });

  return (
    <div className="mg-editor">
      <div className="mg-editor-tabs">
        {['switches', 'elements', 'rules', 'general'].map((name) => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}
      </div>
      {tab === 'switches' && <div>
        <button className="mg-editor-add" onClick={addSwitch}>+ Adicionar switch</button>
        <p className="mg-editor-hint">Cada query do painel vira um card de switch pelo RefID. Abra o card, configure os campos e depois posicione no mapa pelo botao Editar posicoes.</p>
        {visibleSwitches.map((sw, index) => {
          const query = inventory.find((item) => item.refId === sw.refId);
          const fieldOptions = (query?.fields || []).map((field) => ({ value: field.id, label: field.label }));
          const cardOpen = openCards[sw.id] !== false;
          const title = query?.name || sw.name || sw.refId || sw.id;
          return (
            <div className={`mg-editor-card ${sw.hidden ? 'muted' : ''}`} key={sw.id || index}>
              <div className="mg-switch-config-head">
                <button className="mg-collapse" onClick={() => setOpenCards({ ...openCards, [sw.id]: !cardOpen })}>{cardOpen ? 'v' : '>'}</button>
                <div><strong>{sw.refId} - {title}</strong><small>{sw.hidden ? 'Oculto no mapa' : 'Visivel no mapa'}</small></div>
                <button onClick={() => updateSwitch(index, { hidden: !sw.hidden })}>{sw.hidden ? 'Mostrar' : 'Ocultar'}</button>
                <button onClick={() => duplicateSwitch(index)}>Duplicar</button>
                <button className="danger" onClick={() => deleteSwitch(index)}>Excluir</button>
              </div>
              {cardOpen && <div className="mg-switch-config-body">
                <details open><summary>Query</summary>
                  <label>RefID da query</label>
                  <ComboInput value={sw.refId} options={inventory.map((query) => ({ value: query.refId, label: `${query.refId} - ${query.name}` }))} onChange={(refId) => updateSwitch(index, { id: sw.duplicateOf ? sw.id : refId, refId })} />
                  <small>Nome automatico: {query?.name || sw.refId}</small>
                </details>
                <details><summary>Upload</summary><ComboInput value={sw.uploadField} options={fieldOptions} onChange={(uploadField) => updateSwitch(index, { uploadField })} /></details>
                <details><summary>Download</summary><ComboInput value={sw.downloadField} options={fieldOptions} onChange={(downloadField) => updateSwitch(index, { downloadField })} /></details>
                <details><summary>Status</summary><ComboInput value={sw.statusField} options={fieldOptions} onChange={(statusField) => updateSwitch(index, { statusField })} /></details>
                <details><summary>Linha / Interface / Fluxo</summary>
                  <ComboInput value={sw.lineField} options={fieldOptions} onChange={(lineField) => updateSwitch(index, { lineField })} />
                  <label>Sentido do sinal</label>
                  <ComboInput value={sw.direction || 'Horario'} options={[{ value: 'Horario', label: 'Horario' }, { value: 'Anti-horario', label: 'Anti-horario' }, { value: 'Entrada', label: 'Entrada' }, { value: 'Saida', label: 'Saida' }]} onChange={(direction) => updateSwitch(index, { direction })} />
                </details>
                <details><summary>Drilldown</summary><input type="text" placeholder="ex: /d/zabbix-host?var-host=${host}" value={sw.link || ''} onChange={(event) => updateSwitch(index, { link: event.target.value })} /></details>
                <details><summary>Thresholds</summary>
                  <div className="mg-editor-row">
                    <label>Upload atencao abaixo de</label><input type="number" value={sw.thresholds?.uploadWarnBps ?? defaultThresholds.uploadWarnBps} onChange={(event) => updateSwitch(index, { thresholds: { ...(sw.thresholds || defaultThresholds), uploadWarnBps: Number(event.target.value) } })} />
                    <label>Upload critico abaixo de</label><input type="number" value={sw.thresholds?.uploadCritBps ?? defaultThresholds.uploadCritBps} onChange={(event) => updateSwitch(index, { thresholds: { ...(sw.thresholds || defaultThresholds), uploadCritBps: Number(event.target.value) } })} />
                  </div>
                </details>
              </div>}
            </div>
          );
        })}
      </div>}      {tab === 'connections' && <div>
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
      {tab === 'elements' && <div>
        <button className="mg-editor-add" onClick={addElement}>+ Adicionar elemento visual</button>
        <p className="mg-editor-hint">Elementos funcionam como shapes do Flowcharting: posicione no mapa, associe a um switch/metric e use regras para pintar, piscar, trocar texto ou criar drilldown.</p>
        {config.elements.map((element, index) => (
          <div className="mg-editor-card" key={index}>
            <div className="mg-editor-row"><label>Ativo</label><input type="checkbox" checked={element.enabled !== false} onChange={(event) => updateElement(index, { enabled: event.target.checked })} /></div>
            <label>ID / nome do shape</label><input type="text" value={element.id || ''} onChange={(event) => updateElement(index, { id: event.target.value })} />
            <label>Tipo</label>
            <select value={element.type || 'rect'} onChange={(event) => updateElement(index, { type: event.target.value })}>
              <option value="rect">Retangulo</option>
              <option value="circle">Circulo</option>
              <option value="text">Texto</option>
              <option value="badge">Badge</option>
              <option value="line">Linha</option>
            </select>
            <label>Vincular a switch</label>
            <select value={element.scope || 'all'} onChange={(event) => updateElement(index, { scope: event.target.value })}>
              <option value="all">Nenhum / geral</option>
              {switchOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <label>Metrica</label>
            <select value={element.metric || 'traffic'} onChange={(event) => updateElement(index, { metric: event.target.value })}>
              <option value="traffic">Trafego</option>
              <option value="upload">Upload</option>
              <option value="download">Download</option>
              <option value="status">Status</option>
              <option value="line">Linha / Interface</option>
            </select>
            <label>Texto do shape</label><input type="text" value={element.text || ''} placeholder="${name}: ${value}" onChange={(event) => updateElement(index, { text: event.target.value })} />
            <label>Link / drilldown</label><input type="text" value={element.link || ''} placeholder="/d/detalhe?var-host=${host}" onChange={(event) => updateElement(index, { link: event.target.value })} />
            <div className="mg-editor-row">
              <label>Cor base</label><input type="color" value={element.color || '#42b8ff'} onChange={(event) => updateElement(index, { color: event.target.value })} />
              <label>Cor texto</label><input type="color" value={element.textColor || '#dce8f6'} onChange={(event) => updateElement(index, { textColor: event.target.value })} />
            </div>
            <div className="mg-editor-grid4">
              <label>X %</label><input type="number" value={element.x ?? 50} onChange={(event) => updateElement(index, { x: Number(event.target.value) })} />
              <label>Y %</label><input type="number" value={element.y ?? 50} onChange={(event) => updateElement(index, { y: Number(event.target.value) })} />
              <label>W %</label><input type="number" value={element.w ?? 10} onChange={(event) => updateElement(index, { w: Number(event.target.value) })} />
              <label>H %</label><input type="number" value={element.h ?? 5} onChange={(event) => updateElement(index, { h: Number(event.target.value) })} />
            </div>
            <button className="mg-editor-del" onClick={() => removeElement(index)}>Remover elemento</button>
          </div>
        ))}
      </div>}
      {tab === 'rules' && <div>
        <button className="mg-editor-add" onClick={addRule}>+ Adicionar regra de mapeamento</button>
        <p className="mg-editor-hint">As regras pintam borda/fundo/texto, fazem piscar ou exibem um selo conforme a métrica atinge cada limiar (maior ou igual ao valor).</p>
        {config.rules.map((rule, index) => (
          <div className="mg-editor-card" key={index}>
            <div className="mg-editor-row"><label>Nome</label><input type="text" value={rule.name || ''} onChange={(event) => updateRule(index, { name: event.target.value })} /></div>
            <label>Aplicar a</label>
            <select value={rule.scope || 'all'} onChange={(event) => updateRule(index, { scope: event.target.value })}>
              <option value="all">Todos os switches/elementos</option>
              {switchOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              {config.elements.map((element) => <option key={element.id} value={element.id}>Elemento: {element.id}</option>)}
            </select>
            <label>Métrica</label>
            <select value={rule.metric || 'traffic'} onChange={(event) => updateRule(index, { metric: event.target.value })}>
              <option value="traffic">Tráfego (up+down)</option>
              <option value="upload">Upload</option>
              <option value="download">Download</option>
              <option value="status">Status (valor)</option>
              <option value="line">Linha / Interface</option>
            </select>
            <label>Efeitos</label>
            <div className="mg-apply">
              {['border', 'background', 'text', 'blink'].map((key) => (
                <label key={key} className="mg-check"><input type="checkbox" checked={(rule.apply || []).includes(key)} onChange={() => toggleApply(index, key)} />{key}</label>
              ))}
            </div>
            <label>Limiares (valor ≥, cor, selo)</label>
            {(rule.steps || []).map((step, si) => (
              <div className="mg-step" key={si}>
                <input type="number" value={step.when} onChange={(event) => updateStep(index, si, { when: Number(event.target.value) })} />
                <input type="color" value={step.color || '#39d353'} onChange={(event) => updateStep(index, si, { color: event.target.value })} />
                <input type="text" placeholder="selo" value={step.text || ''} onChange={(event) => updateStep(index, si, { text: event.target.value })} />
                <button className="mg-step-del" onClick={() => removeStep(index, si)}>×</button>
              </div>
            ))}
            <div className="mg-editor-row">
              <button className="mg-editor-add" onClick={() => addStep(index)}>+ limiar</button>
              <button className="mg-editor-del" onClick={() => removeRule(index)}>Remover regra</button>
            </div>
          </div>
        ))}
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
    .addBooleanSwitch({ path: 'showMiniFlow', name: 'Mostrar fluxo em tempo real', defaultValue: defaults.showMiniFlow })
    .addBooleanSwitch({ path: 'showTraffic', name: 'Mostrar tráfego total (5 min)', defaultValue: defaults.showTraffic })
    .addBooleanSwitch({ path: 'showAlarms', name: 'Mostrar tabela de alarmes', defaultValue: defaults.showAlarms })
    .addBooleanSwitch({ path: 'animateLinks', name: 'Animar linhas', defaultValue: defaults.animateLinks })
    .addBooleanSwitch({ path: 'blinkOnAlert', name: 'Piscar em alerta (DOWN)', defaultValue: defaults.blinkOnAlert })
    .addBooleanSwitch({ path: 'showTooltips', name: 'Tooltip com gráfico ao passar o mouse', defaultValue: defaults.showTooltips })
    .addTextInput({ path: 'linkBase', name: 'Link/drilldown padrão', description: 'Template usado ao clicar num switch. Use ${host}, ${name} ou ${refId}. Ex: /d/zabbix-host?var-host=${host}', defaultValue: defaults.linkBase })
    .addNumberInput({ path: 'linkCapacityBps', name: 'Capacidade de referência por link (bps)', defaultValue: defaults.linkCapacityBps })
    .addCustomEditor({ id: 'config', path: 'config', name: 'Configuracao do mapa', editor: ConfigEditor, defaultValue: defaults.config });
});
