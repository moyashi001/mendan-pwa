// 面談管理 - Google Apps Script
// スプレッドシートの「拡張機能 > Apps Script」に貼り付けて使う

const SHEET_MEMBERS = 'メンバー';
const SHEET_SLOTS = '面談枠';
const SHEET_SETTINGS = '設定';
const SHEET_LOG = '変更履歴';
const MEMBER_HEADER = ['社員番号', '名前', '第1希望', '第2希望', '確定', '更新日時'];
const SLOT_HEADER = ['日付', '開始', '終了'];
const LOG_HEADER = ['日時', '操作', '対象', '内容'];
const TITLE_KEY = '面談名';
const PASS_KEY = '管理パスコード';
const TZ = 'Asia/Tokyo';
const MAX_SLOTS_PER_ADD = 50;
// パスコードを続けて間違えたら、しばらく管理操作を受け付けない
const MAX_PASS_FAILS = 10;
const PASS_LOCK_SECONDS = 600;

// 初回に1度だけ GAS エディタから実行する
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 社員番号の先頭の 0 や日付・時刻が自動変換されないよう、文字列として扱う
  ensureSheet_(ss, SHEET_MEMBERS, MEMBER_HEADER).getRange('A:E').setNumberFormat('@');
  ensureSheet_(ss, SHEET_SLOTS, SLOT_HEADER).getRange('A:C').setNumberFormat('@');
  const settings = ensureSheet_(ss, SHEET_SETTINGS, ['項目', '内容']);
  if (settings.getLastRow() < 2) {
    settings.getRange(2, 1, 2, 2).setValues([[TITLE_KEY, ''], [PASS_KEY, '']]);
  }
  ensureSheet_(ss, SHEET_LOG, LOG_HEADER);
}

function ensureSheet_(ss, name, header) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ?me=名前 を付けると、その人の希望（mine）も返す
function doGet(e) {
  return respond_(() => publicState_(sheets_(), (e && e.parameter && e.parameter.me) || ''));
}

function doPost(e) {
  return respond_(() => {
    const req = JSON.parse(e.postData.contents);
    const isAdmin = Object.prototype.hasOwnProperty.call(ADMIN_ACTIONS, req.action);
    const action = isAdmin ? ADMIN_ACTIONS[req.action] : ACTIONS[req.action];
    if (!action) throw new Error('不明な操作です: ' + req.action);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let result;
    let s;
    try {
      s = sheets_();
      if (isAdmin) checkPasscode_(s, req.passcode);
      result = action(s, req);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    const state = publicState_(s, req.me || '');
    if (isAdmin) state.admin = adminState_(s);
    return { ...state, result };
  });
}

function respond_(fn) {
  let body;
  try {
    body = { ok: true, data: fn() };
  } catch (err) {
    body = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- メンバーの操作（名前を選ぶだけで使える） ----
const ACTIONS = {
  // 第1希望（必須）と第2希望（任意）を保存する。確定後は変えられない
  choose(s, req) {
    const name = String(req.name || '');
    const m = memberByName_(s, name);
    const row = m.row;
    if (m.confirmed) throw new Error('面談日時は確定済みです。変更は面談者に連絡してください');
    const slots = readSlots_(s);
    const taken = takenSlots_(s, m.empId);
    const today = today_();
    const pick = (key, label) => {
      const slot = slots.find(x => x.key === key);
      if (!slot) throw new Error(`${label}の枠が見つかりません。画面を更新してください`);
      if (slot.date < today) throw new Error(`${label}の枠は過ぎています`);
      if (taken.has(key)) throw new Error(`${label}の枠はほかの人で確定済みです。選び直してください`);
      return key;
    };
    const first = pick(String(req.first || ''), '第1希望');
    const second = req.second ? pick(String(req.second), '第2希望') : '';
    if (first === second) throw new Error('第1希望と第2希望は別の枠を選んでください');
    s.members.getRange(row, 3, 1, 2).setValues([[first, second]]);
    s.members.getRange(row, 6).setValue(new Date());
    if (m.first !== first || m.second !== second) {
      log_(s, '希望', name, `第1：${m.first || 'なし'}→${first}、第2：${m.second || 'なし'}→${second || 'なし'}`);
    }
  },
};

// ---- 管理者の操作（パスコードが必要） ----
const ADMIN_ACTIONS = {
  login() {},

  // 開始〜終了の間に minutes 分ごとの枠を作る。終了が空なら1枠だけ。同じ日付・開始の枠は飛ばす
  addSlots(s, req) {
    const date = validDate_(req.date);
    const start = toMinutes_(validTime_(req.start));
    const minutes = Math.floor(Number(req.minutes) || 0);
    if (minutes < 5 || minutes > 480) throw new Error('1枠の長さは5〜480分で入力してください');
    const end = req.end ? toMinutes_(validTime_(req.end)) : start + minutes;
    if (end < start + minutes) throw new Error('終了は開始より1枠分以上あとにしてください');
    if (end > 24 * 60) throw new Error('終了は24:00までにしてください');
    const exists = new Set(readSlots_(s).map(x => x.key));
    const rows = [];
    let skipped = 0;
    for (let t = start; t + minutes <= end; t += minutes) {
      const row = [date, fromMinutes_(t), fromMinutes_(t + minutes)];
      if (exists.has(slotKey_(date, row[1]))) {
        skipped++;
        continue;
      }
      rows.push(row);
    }
    if (rows.length > MAX_SLOTS_PER_ADD) throw new Error(`一度に作れる枠は${MAX_SLOTS_PER_ADD}件までです`);
    if (rows.length) {
      s.slots.getRange(s.slots.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
      log_(s, '枠追加', date, rows.map(r => `${r[1]}〜${r[2]}`).join('、'));
    }
    return { added: rows.length, skipped };
  },

  // 確定済みの枠は消せない。希望に入っていた枠は外し、第2希望を第1希望に繰り上げる
  removeSlot(s, req) {
    const key = String(req.key || '');
    const slot = readSlots_(s).find(x => x.key === key);
    if (!slot) throw new Error('枠が見つかりません。画面を更新してください');
    const members = readMembers_(s);
    const holder = members.find(m => m.confirmed === key);
    if (holder) throw new Error(`${holder.name}さんで確定済みのため削除できません。先に確定を取り消してください`);
    const affected = [];
    members.forEach(m => {
      if (m.first !== key && m.second !== key) return;
      const rest = [m.first, m.second].filter(k => k && k !== key);
      s.members.getRange(m.row, 3, 1, 2).setValues([[rest[0] || '', rest[1] || '']]);
      affected.push(m.name);
    });
    s.slots.deleteRow(slot.row);
    log_(s, '枠削除', key, affected.length ? `希望から外した人：${affected.join('、')}` : '');
  },

  addMember(s, req) {
    const empId = validEmpId_(req.empId);
    const name = validName_(req.name);
    const members = readMembers_(s);
    if (members.some(m => m.empId === empId)) throw new Error(`社員番号「${empId}」はすでに登録されています`);
    if (members.some(m => m.name === name)) throw new Error(`「${name}」はすでに登録されています`);
    s.members.getRange(s.members.getLastRow() + 1, 1, 1, 6).setValues([[empId, name, '', '', '', '']]);
    log_(s, 'メンバー追加', name, `社員番号：${empId}`);
  },

  editMember(s, req) {
    const old = memberByEmpId_(s, req.oldEmpId);
    const row = old.row;
    const empId = validEmpId_(req.empId);
    const name = validName_(req.name);
    const others = readMembers_(s).filter(m => m.row !== row);
    if (others.some(m => m.empId === empId)) throw new Error(`社員番号「${empId}」はすでに登録されています`);
    if (others.some(m => m.name === name)) throw new Error(`「${name}」はすでに登録されています`);
    s.members.getRange(row, 1, 1, 2).setValues([[empId, name]]);
    const changes = [];
    if (old.empId !== empId) changes.push(`社員番号：${old.empId}→${empId}`);
    if (old.name !== name) changes.push(`名前：${old.name}→${name}`);
    if (changes.length) log_(s, 'メンバー編集', name, changes.join('、'));
  },

  removeMember(s, req) {
    const m = memberByEmpId_(s, req.empId);
    s.members.deleteRow(m.row);
    log_(s, 'メンバー削除', m.name, `社員番号：${m.empId}${m.confirmed ? `、確定していた枠：${m.confirmed}` : ''}`);
  },

  // 希望以外の枠でも確定できる。ほかの人で確定済みの枠は選べない
  confirm(s, req) {
    const m = memberByEmpId_(s, req.empId);
    const key = String(req.key || '');
    if (!readSlots_(s).some(x => x.key === key)) throw new Error('枠が見つかりません。画面を更新してください');
    const holder = readMembers_(s).find(x => x.confirmed === key && x.empId !== m.empId);
    if (holder) throw new Error(`この枠は${holder.name}さんで確定済みです`);
    s.members.getRange(m.row, 5).setValue(key);
    if (m.confirmed !== key) log_(s, '確定', m.name, `${m.confirmed ? m.confirmed + '→' : ''}${key}`);
  },

  unconfirm(s, req) {
    const m = memberByEmpId_(s, req.empId);
    s.members.getRange(m.row, 5).setValue('');
    if (m.confirmed) log_(s, '確定取消', m.name, m.confirmed);
  },
};

function checkPasscode_(s, passcode) {
  const expected = setting_(s, PASS_KEY);
  if (!expected) throw new Error('「設定」シートの「管理パスコード」を入力してください');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('passFails')) || 0;
  if (fails >= MAX_PASS_FAILS) throw new Error('パスコードの間違いが続いたため、10分ほど待ってからやり直してください');
  if (String(passcode || '') !== expected) {
    cache.put('passFails', String(fails + 1), PASS_LOCK_SECONDS);
    throw new Error('パスコードが違います');
  }
}

function sheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s = {
    members: ss.getSheetByName(SHEET_MEMBERS),
    slots: ss.getSheetByName(SHEET_SLOTS),
    settings: ss.getSheetByName(SHEET_SETTINGS),
  };
  if (!s.members || !s.slots || !s.settings) {
    throw new Error('シートがありません。GASエディタで setup を実行してください');
  }
  s.log = ensureSheet_(ss, SHEET_LOG, LOG_HEADER);
  return s;
}

// メンバー向け：名前の一覧と、枠ごとの埋まり具合だけを返す（社員番号・ほかの人の希望は返さない）
function publicState_(s, me) {
  const members = readMembers_(s);
  const slots = readSlots_(s).map(({ row, ...slot }) => ({
    ...slot,
    taken: members.some(m => m.confirmed === slot.key),
    firstCount: members.filter(m => m.first === slot.key).length,
    secondCount: members.filter(m => m.second === slot.key).length,
  }));
  const state = { title: setting_(s, TITLE_KEY), slots, names: members.map(m => m.name), today: today_() };
  const mine = members.find(m => m.name === String(me));
  if (mine) {
    state.mine = { name: mine.name, first: mine.first, second: mine.second, confirmed: mine.confirmed, updatedAt: mine.updatedAt };
  }
  return state;
}

function adminState_(s) {
  return { members: readMembers_(s).map(({ row, ...m }) => m) };
}

function readMembers_(s) {
  return s.members.getDataRange().getValues().slice(1)
    .map((r, i) => ({
      row: i + 2,
      empId: String(r[0]).trim(),
      name: String(r[1]).trim(),
      first: String(r[2] || '').trim(),
      second: String(r[3] || '').trim(),
      confirmed: String(r[4] || '').trim(),
      updatedAt: formatDate_(r[5]),
    }))
    .filter(m => m.name);
}

// 日付・開始順に並べる。シートを直接編集して日付や時刻に変換された値も文字列にそろえる
function readSlots_(s) {
  return s.slots.getDataRange().getValues().slice(1)
    .map((r, i) => ({ row: i + 2, date: normDate_(r[0]), start: normTime_(r[1]), end: normTime_(r[2]) }))
    .filter(x => x.date && x.start)
    .map(({ row, ...x }) => ({ key: slotKey_(x.date, x.start), ...x, row }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function takenSlots_(s, exceptEmpId) {
  return new Set(readMembers_(s).filter(m => m.confirmed && m.empId !== exceptEmpId).map(m => m.confirmed));
}

function memberByName_(s, name) {
  const m = readMembers_(s).find(x => x.name === name);
  if (!m) throw new Error(`「${name}」が見つかりません。画面を更新してください`);
  return m;
}

function memberByEmpId_(s, empId) {
  const id = String(empId || '').trim();
  const m = readMembers_(s).find(x => x.empId === id);
  if (!m) throw new Error('メンバーが見つかりません。画面を更新してください');
  return m;
}

function setting_(s, key) {
  const row = s.settings.getDataRange().getDisplayValues().slice(1).find(([label]) => label === key);
  return row ? String(row[1]).trim() : '';
}

// 変更履歴は新しいものが上に来るよう、見出しの直下に挿入する
function log_(s, op, target, detail) {
  s.log.insertRowAfter(1);
  s.log.getRange(2, 1, 1, 4).setValues([[new Date(), op, safeText_(target, 100), safeText_(detail, 1000)]]);
}

const slotKey_ = (date, start) => `${date} ${start}`;
const toMinutes_ = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const pad_ = n => String(n).padStart(2, '0');
const fromMinutes_ = m => `${pad_(Math.floor(m / 60))}:${pad_(m % 60)}`;
const today_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');

function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const m = String(v || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  return m ? `${m[1]}-${pad_(m[2])}-${pad_(m[3])}` : '';
}

function normTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad_(m[1])}:${m[2]}` : '';
}

function validDate_(v) {
  const date = normDate_(v);
  const d = date && new Date(`${date}T00:00:00Z`);
  if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== date) throw new Error('日付を正しく入力してください');
  return date;
}

function validTime_(v) {
  const time = normTime_(v);
  if (!time || Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) throw new Error('時刻を正しく入力してください');
  return time;
}

function validEmpId_(v) {
  const id = String(v || '').trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z-]{0,19}$/.test(id)) throw new Error('社員番号は半角英数字（20文字まで）で入力してください');
  return id;
}

function validName_(v) {
  const name = String(v || '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('名前を入力してください');
  if (/^[=+\-@]/.test(name)) throw new Error('名前の先頭に記号は使えません');
  if (name.length > 40) throw new Error('名前が長すぎます');
  return name;
}

// 先頭が = などだと数式として解釈されるため、文字列として保存する
function safeText_(v, max) {
  const s = String(v || '').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function formatDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'M/d H:mm') : String(v || '');
}
