// 動作テスト。fetch を Code.gs（スプレッドシートはモック）につなぎ、app.js を jsdom 上で動かす
// 実行：npm install && npm test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createGas, jstDate } = require('./fake-gas');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script src[^>]*><\/script>/g, '');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const PASS = '1234';
const D1 = jstDate(1);
const D2 = jstDate(2);
const D3 = jstDate(3);
const PAST = jstDate(-1);

// メンバー3人・枠（昨日1・明日2・明後日1）・面談名・パスコードを入れたスプレッドシート
function seed() {
  const gas = createGas();
  gas.sheet('設定').data = [['項目', '内容'], ['面談名', '上期'], ['管理パスコード', PASS]];
  gas.sheet('メンバー').data.push(
    ['0012', '山田 太郎', '', '', '', ''],
    ['0034', '鈴木 花子', '', '', '', ''],
    ['A-56', '佐藤 次郎', '', '', '', ''],
  );
  gas.sheet('面談枠').data.push([PAST, '10:00', '10:30'], [D1, '10:30', '11:00'], [D1, '10:00', '10:30'], [D2, '13:00', '13:30']);
  return gas;
}
const key = (date, start) => `${date} ${start}`;

// app.js を読み込み、初回の読み込みが終わるまで待つ
async function loadApp(gas = seed(), storage = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://mendan-pwa.vercel.app/' });
  const w = dom.window;
  const ctx = { gas, w, d: w.document, sent: [], confirms: [] };
  Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.fetch = async (url, opts) => {
    let body;
    if (opts) {
      const req = JSON.parse(opts.body);
      ctx.sent.push(req);
      body = gas.post(req);
    } else {
      body = gas.get(new URL(url).searchParams.get('me'));
    }
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  w.GAS_URL = 'https://script.google.com/macros/s/test/exec';
  w.confirm = message => { ctx.confirms.push(message); return true; };
  w.eval(APP);
  await tick();
  return ctx;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const texts = (d, selector) => [...d.querySelectorAll(selector)].map(e => e.textContent.replace(/\s+/g, ' ').trim());
const toastText = d => d.getElementById('toast').textContent;
async function closeDialog(ctx, id, value) {
  const dialog = ctx.d.getElementById(id);
  dialog.returnValue = value;
  dialog.open = false;
  dialog.dispatchEvent(new ctx.w.Event('close'));
  await tick();
}
async function selectMe(ctx, name) {
  const select = ctx.d.getElementById('me-select');
  select.value = name;
  select.dispatchEvent(new ctx.w.Event('change'));
  await tick();
}
async function click(ctx, selector) {
  ctx.d.querySelector(selector).click();
  await tick();
}
// 管理者としてログインした状態で開く
const loadAdmin = (gas = seed()) => loadApp(gas, { 'mendan.pass': PASS, 'mendan.mode': 'admin' });

test('メンバー向けの一覧には社員番号もほかの人の希望も含めない', () => {
  const gas = seed();
  gas.sheet('メンバー').data[2][2] = key(D1, '10:00');
  const data = gas.get('山田 太郎').data;
  assert.deepEqual(data.names, ['山田 太郎', '鈴木 花子', '佐藤 次郎']);
  assert.equal(data.admin, undefined);
  assert.ok(!JSON.stringify(data).includes('0012'));
  assert.ok(!JSON.stringify(data).includes(`"first":"${key(D1, '10:00')}"`));
  assert.equal(data.mine.first, '');
  assert.equal(data.slots.find(s => s.key === key(D1, '10:00')).firstCount, 1);
  // 枠は日付・開始順
  assert.deepEqual(data.slots.map(s => s.key), [key(PAST, '10:00'), key(D1, '10:00'), key(D1, '10:30'), key(D2, '13:00')]);
});

test('名前を選んで第1・第2希望を送信し、過ぎた枠は表示しない', async () => {
  const ctx = await loadApp();
  const { d } = ctx;
  assert.equal(d.getElementById('app-title').textContent, '上期 面談管理');
  assert.equal(d.querySelectorAll('#slot-list .row').length, 0);
  await selectMe(ctx, '山田 太郎');
  assert.equal(ctx.w.localStorage.getItem('mendan.me'), '山田 太郎');
  assert.equal(d.querySelectorAll('#slot-list .row').length, 3);
  assert.equal(d.getElementById('choose-btn').disabled, true);

  await click(ctx, `[data-pick="first"][data-key="${key(D1, '10:30')}"]`);
  // 第2希望も選ぶまでは送信できない
  assert.equal(d.getElementById('choose-btn').disabled, true);
  await click(ctx, `[data-pick="second"][data-key="${key(D2, '13:00')}"]`);
  // 第2希望と同じ枠を第1に選ぶと、第2からは外れる
  await click(ctx, `[data-pick="first"][data-key="${key(D2, '13:00')}"]`);
  await click(ctx, `[data-pick="second"][data-key="${key(D1, '10:30')}"]`);
  assert.equal(d.getElementById('choose-btn').disabled, false);
  await click(ctx, '#choose-btn');

  assert.deepEqual(ctx.gas.rows('メンバー')[0].slice(2, 5), [key(D2, '13:00'), key(D1, '10:30'), '']);
  assert.equal(toastText(d), '希望を送信しました');
  assert.match(d.getElementById('me-status').textContent, /確定待ち/);
  assert.equal(d.getElementById('choose-btn').disabled, true);
  // 自分の希望はほかの人の数に入れない
  assert.ok(texts(d, '#slot-list .sub').every(t => t === '空き'));
  assert.match(ctx.gas.rows('変更履歴')[0][1], /希望/);
});

test('ほかの人の希望は人数だけ表示し、確定済みの枠は選べない', async () => {
  const gas = seed();
  gas.sheet('メンバー').data[2][2] = key(D1, '10:00');
  gas.sheet('メンバー').data[3][4] = key(D1, '10:30');
  const ctx = await loadApp(gas, { 'mendan.me': '山田 太郎' });
  const { d } = ctx;
  assert.deepEqual(texts(d, '#slot-list .sub'), ['ほかの人の希望：第1 1人・第2 0人', '埋まりました', '空き']);
  assert.ok(d.querySelector(`[data-pick="first"][data-key="${key(D1, '10:30')}"]`).disabled);
  // 画面を通さずに送っても GAS で断る
  const res = gas.post({ action: 'choose', name: '山田 太郎', first: key(D1, '10:30'), second: key(D2, '13:00') });
  assert.equal(res.ok, false);
  assert.match(res.error, /確定済み/);
  assert.match(gas.post({ action: 'choose', name: '山田 太郎', first: key(PAST, '10:00'), second: key(D2, '13:00') }).error, /過ぎています/);
  assert.match(gas.post({ action: 'choose', name: '山田 太郎', first: key(D2, '13:00') }).error, /第1希望と第2希望を選んでください/);
});

test('確定した人には面談日時を表示し、希望は出せない', async () => {
  const gas = seed();
  gas.sheet('メンバー').data[1][4] = key(D2, '13:00');
  const ctx = await loadApp(gas, { 'mendan.me': '山田 太郎' });
  const { d } = ctx;
  assert.match(d.getElementById('me-status').textContent, /面談日時が決まりました/);
  assert.match(d.getElementById('me-status').textContent, /13:00〜13:30/);
  assert.equal(d.querySelectorAll('#slot-list .row').length, 0);
  assert.equal(d.getElementById('choose-bar').hidden, true);
  assert.match(gas.post({ action: 'choose', name: '山田 太郎', first: key(D1, '10:00'), second: key(D1, '11:00') }).error, /確定済み/);
});

test('管理画面はパスコードが必要で、間違えるとメンバー画面に戻る', async () => {
  const ctx = await loadApp();
  const { d, w } = ctx;
  await click(ctx, '#mode-btn');
  d.getElementById('pass-input').value = '0000';
  await closeDialog(ctx, 'pass-dialog', 'ok');
  assert.equal(toastText(d), 'パスコードが違います');
  assert.equal(d.getElementById('admin-view').hidden, true);
  assert.equal(w.localStorage.getItem('mendan.pass'), null);

  await click(ctx, '#mode-btn');
  d.getElementById('pass-input').value = PASS;
  await closeDialog(ctx, 'pass-dialog', 'ok');
  assert.equal(d.getElementById('admin-view').hidden, false);
  assert.equal(w.localStorage.getItem('mendan.pass'), PASS);
  assert.deepEqual(texts(d, '#tab-requests .group-title'), ['未回答3人']);
  assert.match(d.getElementById('tab-requests').textContent, /0012/);

  await click(ctx, '#logout-btn');
  assert.equal(d.getElementById('admin-view').hidden, true);
  assert.equal(w.localStorage.getItem('mendan.pass'), null);
});

test('パスコードを10回間違えると、正しくても一時的に受け付けない', () => {
  const gas = seed();
  for (let i = 0; i < 10; i++) gas.post({ action: 'login', passcode: 'x' });
  assert.match(gas.post({ action: 'login', passcode: PASS }).error, /10分ほど待って/);
});

test('管理者は希望から日時を確定・取り消しでき、重複やほかの人の確定を警告する', async () => {
  const gas = seed();
  const rows = gas.sheet('メンバー').data;
  rows[1][2] = key(D1, '10:00');
  rows[1][3] = key(D2, '13:00');
  rows[2][2] = key(D1, '10:00');
  const ctx = await loadAdmin(gas);
  const { d } = ctx;
  assert.deepEqual(texts(d, '#tab-requests .group-title'), ['確定待ち（タップして確定）2人', '未回答1人']);
  assert.match(d.getElementById('tab-requests').textContent, /第1希望が2人/);

  await click(ctx, '[data-confirm="0012"]');
  const select = d.getElementById('confirm-select');
  // 過ぎた枠は出さず、初期値は第1希望
  assert.equal(select.options.length, 3);
  assert.equal(select.value, key(D1, '10:00'));
  assert.equal(d.getElementById('confirm-cancel-btn').hidden, true);
  await closeDialog(ctx, 'confirm-dialog', 'ok');
  assert.equal(gas.rows('メンバー')[0][4], key(D1, '10:00'));
  assert.match(d.getElementById('tab-requests').textContent, /山田 太郎さんで確定済み/);

  // ほかの人で確定済みの枠は選べず、初期値は空いている枠になる
  await click(ctx, '[data-confirm="0034"]');
  assert.ok([...select.options].find(o => o.value === key(D1, '10:00')).disabled);
  assert.notEqual(select.value, key(D1, '10:00'));
  await closeDialog(ctx, 'confirm-dialog', 'cancel');
  assert.match(gas.post({ action: 'confirm', passcode: PASS, empId: '0034', key: key(D1, '10:00') }).error, /山田 太郎さんで確定済み/);

  await click(ctx, '[data-confirm="0012"]');
  assert.equal(d.getElementById('confirm-cancel-btn').hidden, false);
  await closeDialog(ctx, 'confirm-dialog', 'unconfirm');
  assert.equal(gas.rows('メンバー')[0][4], '');
  assert.deepEqual(gas.rows('変更履歴').map(r => r[1]), ['確定取消', '確定']);
});

test('枠は複数の日付に、開始〜終了を区切ってまとめて作り、同じ時刻の枠は飛ばす', async () => {
  const ctx = await loadAdmin();
  const { d, gas } = ctx;
  await click(ctx, '[data-tab="slots"]');
  const form = d.getElementById('slot-form');
  const fill = (id, value) => {
    d.getElementById(id).value = value;
    form.dispatchEvent(new ctx.w.Event('input'));
  };
  // 日付を2つ追加し、もう1つは日付欄に入れたままにする（これも含める）
  fill('slot-date', D2);
  await click(ctx, '#date-add-btn');
  fill('slot-date', D1);
  await click(ctx, '#date-add-btn');
  fill('slot-date', D3);
  await click(ctx, '#date-add-btn');
  assert.deepEqual(texts(d, '#date-chips .chip').length, 3);
  await click(ctx, `[data-remove-date="${D3}"]`);
  fill('slot-date', D3);
  fill('slot-start', '09:00');
  fill('slot-end', '11:00');
  fill('slot-minutes', '30');
  assert.equal(d.getElementById('slot-submit').textContent, '12枠を追加');
  form.dispatchEvent(new ctx.w.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(toastText(d), '10枠を追加しました（同じ時刻の2枠は飛ばしました）');
  assert.deepEqual(gas.get().data.slots.filter(s => s.date === D1).map(s => `${s.start}-${s.end}`),
    ['09:00-09:30', '09:30-10:00', '10:00-10:30', '10:30-11:00']);
  assert.equal(gas.get().data.slots.filter(s => s.date === D3).length, 4);
  assert.equal(d.querySelectorAll('#date-chips .chip').length, 0);
  assert.equal(d.getElementById('slot-end').value, '');
  assert.equal(d.getElementById('slot-submit').textContent, '枠を追加');
  assert.match(gas.post({ action: 'addSlots', passcode: PASS, dates: [PAST, D1], start: '15:00', minutes: 30 }).error, /過ぎた日付/);
  assert.match(gas.post({ action: 'addSlots', passcode: PASS, date: D1, start: '10:00', end: '09:00', minutes: 30 }).error, /終了は開始より/);
  assert.match(gas.post({ action: 'addSlots', passcode: PASS, date: '2026-02-30', start: '10:00', minutes: 30 }).error, /日付/);
  // パスコードなしでは作れない
  assert.equal(gas.post({ action: 'addSlots', date: D1, start: '15:00', minutes: 30 }).ok, false);
});

test('確定済みの枠は削除できず、希望だけの枠は削除して第2希望を繰り上げる', async () => {
  const gas = seed();
  const rows = gas.sheet('メンバー').data;
  rows[1][2] = key(D1, '10:00');
  rows[1][3] = key(D2, '13:00');
  rows[2][4] = key(D1, '10:30');
  const ctx = await loadAdmin(gas);
  const { d } = ctx;
  await click(ctx, '[data-tab="slots"]');
  await click(ctx, `[data-remove-slot="${key(D1, '10:30')}"]`);
  assert.match(toastText(d), /鈴木 花子さんで確定済みのため削除できません/);

  await click(ctx, `[data-remove-slot="${key(D1, '10:00')}"]`);
  assert.deepEqual(gas.rows('メンバー')[0].slice(2, 4), [key(D2, '13:00'), '']);
  assert.ok(!gas.get().data.slots.some(s => s.key === key(D1, '10:00')));
  assert.match(gas.rows('変更履歴')[0][3], /山田 太郎/);
});

test('メンバーの追加・編集・削除と、社員番号・名前の重複チェック', async () => {
  const ctx = await loadAdmin();
  const { d, gas } = ctx;
  await click(ctx, '[data-tab="members"]');
  const add = async (empId, name) => {
    d.getElementById('add-empid').value = empId;
    d.getElementById('add-name').value = name;
    d.getElementById('member-form').dispatchEvent(new ctx.w.Event('submit', { cancelable: true }));
    await tick();
  };
  await add('0012', '新人 一郎');
  assert.match(toastText(d), /社員番号「0012」はすでに登録されています/);
  await add('0099', '鈴木 花子');
  assert.match(toastText(d), /「鈴木 花子」はすでに登録されています/);
  await add('0099', '新人 一郎');
  assert.deepEqual(gas.rows('メンバー')[3].slice(0, 2), ['0099', '新人 一郎']);
  assert.equal(d.getElementById('add-empid').value, '');

  await click(ctx, '[data-edit="0099"]');
  d.getElementById('edit-name').value = '新人 二郎';
  await closeDialog(ctx, 'edit-dialog', 'ok');
  assert.deepEqual(gas.rows('メンバー')[3].slice(0, 2), ['0099', '新人 二郎']);

  await click(ctx, '[data-remove-member="0099"]');
  assert.match(ctx.confirms.at(-1), /新人 二郎さんを削除しますか/);
  assert.equal(gas.rows('メンバー').length, 3);
  assert.match(gas.post({ action: 'addMember', passcode: PASS, empId: '=1', name: 'x' }).error, /社員番号は半角英数字/);
});

test('選んでいた名前が削除されていたら、名前の選択に戻る', async () => {
  const ctx = await loadApp(seed(), { 'mendan.me': '退職 者' });
  assert.equal(ctx.d.getElementById('me-select').value, '');
  assert.equal(ctx.w.localStorage.getItem('mendan.me'), null);
});
