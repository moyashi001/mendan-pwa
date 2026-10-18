// Code.gs をローカルで動かすための、スプレッドシートなど GAS サービスの簡易モック
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Range {
  constructor(sheet, row, col, rows, cols) {
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  getValues() {
    return Array.from({ length: this.rows }, (_, i) => Array.from({ length: this.cols }, (_, j) => {
      const r = this.sheet.data[this.row - 1 + i];
      const v = r ? r[this.col - 1 + j] : undefined;
      return v === undefined ? '' : v;
    }));
  }
  getDisplayValues() {
    return this.getValues().map(r => r.map(String));
  }
  setValues(values) {
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.set(this.row + i, this.col + j, v)));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(name) {
    this.name = name;
    this.data = [];
  }
  set(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    this.data[row - 1][col - 1] = v;
  }
  getLastRow() { return this.data.length; }
  getRange(row, col = 1, rows = 1, cols = 1) {
    // 'A:E' のような列指定は書式設定にしか使わないため、空の範囲を返す
    return typeof row === 'string' ? new Range(this, 1, 1, 0, 0) : new Range(this, row, col, rows, cols);
  }
  getDataRange() {
    const cols = Math.max(1, ...this.data.map(r => r.length));
    return new Range(this, 1, 1, Math.max(1, this.data.length), cols);
  }
  deleteRow(row) { this.data.splice(row - 1, 1); }
  insertRowAfter(row) { this.data.splice(row, 0, []); }
  setFrozenRows() {}
}

function formatDate(d, tz, fmt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return fmt
    .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute)
    .replace(/\bM\b/, String(Number(parts.month))).replace(/\bd\b/, String(Number(parts.day)))
    .replace(/\bH\b/, String(Number(parts.hour)));
}

// Code.gs を読み込み、setup 済みのスプレッドシートを用意する
function createGas() {
  const sheets = new Map();
  const ss = {
    getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => { const s = new Sheet(name); sheets.set(name, s); return s; },
  };
  const cache = new Map();
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: text => ({ setMimeType() { return this; }, getContent: () => text }),
    },
    Utilities: { formatDate },
  });
  const code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
  vm.runInContext(`${code}\n;globalThis.__gas = { setup, doGet, doPost };`, context);
  const gas = context.__gas;
  gas.setup();
  const sheet = name => sheets.get(name);
  return {
    sheet,
    cache,
    // シートの見出しを除いた行
    rows: name => sheet(name).data.slice(1),
    get: me => JSON.parse(gas.doGet({ parameter: me ? { me } : {} }).getContent()),
    post: body => JSON.parse(gas.doPost({ postData: { contents: JSON.stringify(body) } }).getContent()),
  };
}

// 日本時間の今日から days 日後の日付
function jstDate(days) {
  return formatDate(new Date(Date.now() + days * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
}

module.exports = { createGas, jstDate };
