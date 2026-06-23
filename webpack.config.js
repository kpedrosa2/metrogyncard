const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/module.jsx',
  output: {
    filename: 'module.js',
    path: path.resolve(__dirname),
    libraryTarget: 'amd',
  },
  externals: ['react', '@grafana/data'],
  resolve: {
    extensions: ['.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.jsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [['@babel/preset-react', { runtime: 'classic' }]],
          },
        },
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'src/img', to: 'img', noErrorOnMissing: true },
      ],
    }),
  ],
};
