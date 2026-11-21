'use strict';

const util = require('util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let current = LEVELS[process.env.SANDROID_LOG] || LEVELS.info;

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function make(level) {
  return (...args) => {
    if (LEVELS[level] < current) return;
    const tag = level === 'info' ? '' : `${level.toUpperCase()} `;
    const line = `[${stamp()}] ${tag}${util.format(...args)}`;
    if (level === 'warn' || level === 'error') console.error(line);
    else console.log(line);
  };
}

module.exports = {
  debug: make('debug'),
  info: make('info'),
  warn: make('warn'),
  error: make('error'),
  setLevel(name) {
    if (LEVELS[name]) current = LEVELS[name];
  },
};
