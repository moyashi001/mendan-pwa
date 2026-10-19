'use strict';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const $ = id => document.getElementById(id);
const el = {
  title: $('app-title'),
  modeBtn: $('mode-btn'),
  memberView: $('member-view'),
  adminView: $('admin-view'),
  meSelect: $('me-select'),
  meStatus: $('me-status'),
  slotList: $('slot-list'),
  chooseBar: $('choose-bar'),
  chooseSummary: $('choose-summary'),
  chooseBtn: $('choose-btn'),
  requests: $('tab-requests'),
  slotAdminList: $('slot-admin-list'),
  memberAdminList: $('member-admin-list'),
  busy: $('busy'),
  busyText: $('busy-text'),
  toast: $('toast'),
};

let state = { title: '', slots: [], names: [], today: '' };

// ---- 端末に保存する値（保存できない環境でも動くように try で包む） ----
const store = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* 保存できなくても動作は続ける */ }
  },
};
let me = store.get('mendan.me');
let passcode = store.get('mendan.pass');
let mode = passcode && store.get('mendan.mode') === 'admin' ? 'admin' : 'member';
let adminTab = store.get('mendan.tab') || 'requests';
// 送信前の希望。draftFor の人の分だけを持つ
let draft = { first: '', second: '' };
let draftFor = null;

// ---- 日時の表示 ----
function fmtDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}(${WEEKDAYS[new Date(y, m - 1, d).getDay()]})`;
}
const slotByKey = key => state.slots.find(s => s.key === key);
function slotLabel(key) {
  if (!key) return 'なし';
  const s = slotByKey(key);
  return s ? `${fmtDate(s.date)} ${s.start}〜${s.end}` : `${key}（削除された枠）`;
}
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const localToday = () => ymd(new Date());
const today = () => state.today || localToday();
const upcomingSlots = () => state.slots.filter(s => s.date >= today());

// ---- API ----
async function api(action, params = {}) {
  const url = window.GAS_URL;
  if (!url || url.includes('XXXXXXXX')) throw new Error('config.js に GAS の URL を設定してください');
  const res = action === 'list'
    ? await fetch(me ? `${url}?me=${encodeURIComponent(me)}` : url)
    // Content-Type を付けない（text/plain になり CORS のプリフライトが発生しない）
    : await fetch(url, { method: 'POST', body: JSON.stringify({ action, me, passcode, ...params }) });
  if (!res.ok) throw new Error(`通信エラー (${res.status})`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'エラーが発生しました');
  const { result, ...data } = json.data;
  // 一覧の再読み込みでは管理者用のデータが返らないため、前回の分を残す
  state = { ...data, admin: data.admin || (mode === 'admin' ? state.admin : undefined) };
  render();
  return result;
}

// 成功時は { result } を、失敗時は null を返す
async function run(action, params = {}, { quiet = false } = {}) {
  const loading = action === 'list' || action === 'login';
  el.busyText.textContent = loading ? '読み込み中…' : '保存中…';
  el.busy.hidden = false;
  try {
    const result = await api(action, params);
    if (!loading && !quiet) toast('保存しました', 'success');
    return { result };
  } catch (err) {
    if (/パスコード/.test(err.message)) leaveAdmin(true);
    toast(err.message.startsWith('Failed to fetch') ? '通信できませんでした。電波を確認してください' : err.message, 'error');
    return null;
  } finally {
    el.busy.hidden = true;
  }
}

const refresh = () => run(mode === 'admin' ? 'login' : 'list');

let toastTimer;
function toast(message, type) {
  el.toast.textContent = message;
  el.toast.className = `toast ${type}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, type === 'success' ? 1500 : 5000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ダイアログを開き、閉じたときのボタンの value を返す
function ask(dialog) {
  return new Promise(resolve => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

// 日付ごとにまとめる
function groupByDate(slots) {
  const groups = new Map();
  slots.forEach(s => {
    if (!groups.has(s.date)) groups.set(s.date, []);
    groups.get(s.date).push(s);
  });
  return [...groups];
}

// ---- 描画 ----
function render() {
  const title = state.title ? `${state.title} 面談管理` : '面談管理';
  el.title.textContent = title;
  document.title = title;
  el.memberView.hidden = mode !== 'member';
  el.adminView.hidden = mode !== 'admin';
  el.modeBtn.textContent = mode === 'admin' ? 'メンバー画面' : '管理';
  if (mode === 'admin') renderAdmin();
  else renderMember();
}

// ---- メンバー画面 ----
function renderMember() {
  if (me && state.names.length && !state.names.includes(me)) setMe('');
  el.meSelect.innerHTML = `<option value="">名前を選んでください</option>` +
    state.names.map(n => `<option${n === me ? ' selected' : ''}>${esc(n)}</option>`).join('');
  el.meSelect.value = me;

  const mine = me && state.mine && state.mine.name === me ? state.mine : null;
  if (draftFor !== me && (mine || !me)) {
    draft = { first: mine ? mine.first : '', second: mine ? mine.second : '' };
    draftFor = me;
  }
  // 消えた枠・ほかの人で確定した枠は選択から外す
  ['first', 'second'].forEach(k => {
    const s = slotByKey(draft[k]);
    if (draft[k] && (!s || s.taken)) draft[k] = '';
  });
  if (!draft.first && draft.second) draft = { first: draft.second, second: '' };

  el.meStatus.innerHTML = statusHtml(mine);
  const choosing = Boolean(mine && !mine.confirmed);
  const slots = upcomingSlots();
  el.slotList.innerHTML = choosing ? slotsHtml(slots, mine) : '';
  el.chooseBar.hidden = !(choosing && slots.length);
  el.chooseSummary.innerHTML = `第1：<b>${esc(slotLabel(draft.first))}</b><br>第2：<b>${esc(slotLabel(draft.second))}</b>`;
  const changed = mine && (draft.first !== mine.first || draft.second !== mine.second);
  el.chooseBtn.disabled = !draft.first || !draft.second || !changed;
}

function statusHtml(mine) {
  if (!me) return `<p class="card">名前を選ぶと、面談の希望日時を出せます</p>`;
  if (!mine) return '';
  if (mine.confirmed) {
    return `<div class="card confirmed"><p class="card-label">面談日時が決まりました</p>
      <p class="big">${esc(slotLabel(mine.confirmed))}</p>
      <p class="sub">変更したいときは面談者に連絡してください</p></div>`;
  }
  if (mine.first) {
    const lost = [mine.first, mine.second].some(k => k && (slotByKey(k) || {}).taken);
    return `<div class="card"><p class="card-label">希望を送信済みです（面談者の確定待ち）</p>
      <p>第1：<b>${esc(slotLabel(mine.first))}</b><br>第2：<b>${esc(slotLabel(mine.second))}</b></p>
      ${lost ? '<p class="warn">⚠ 希望した枠がほかの人で埋まりました。選び直してください</p>' : ''}
      <p class="sub">確定するまでは選び直せます${mine.updatedAt ? `（送信：${esc(mine.updatedAt)}）` : ''}</p></div>`;
  }
  return `<p class="card">下の一覧から<b>第1希望</b>と<b>第2希望</b>を選んで送信してください</p>`;
}

function slotsHtml(slots, mine) {
  if (!slots.length) return `<p class="empty">面談枠はまだありません。面談者が枠を作るまでお待ちください</p>`;
  return groupByDate(slots).map(([date, list]) => `
    <h2 class="date-title">${esc(fmtDate(date))}</h2>
    <ul class="list">${list.map(s => {
      // 自分の送信済みの希望は数えない
      const firsts = s.firstCount - (mine.first === s.key ? 1 : 0);
      const seconds = s.secondCount - (mine.second === s.key ? 1 : 0);
      const avail = s.taken ? '埋まりました'
        : firsts || seconds ? `ほかの人の希望：第1 ${firsts}人・第2 ${seconds}人` : '空き';
      const btn = (k, label) => `<button type="button" class="pick${draft[k] === s.key ? ' on' : ''}" data-pick="${k}" data-key="${esc(s.key)}"
        aria-pressed="${draft[k] === s.key}"${s.taken ? ' disabled' : ''}>${label}</button>`;
      return `<li class="row${s.taken ? ' taken' : ''}">
        <div class="row-main"><span class="name">${esc(s.start)}〜${esc(s.end)}</span>
          <span class="sub${firsts && !s.taken ? ' busy-sub' : ''}">${esc(avail)}</span></div>
        <div class="row-actions">${btn('first', '第1')}${btn('second', '第2')}</div>
      </li>`;
    }).join('')}</ul>`).join('');
}

function setMe(name) {
  me = name;
  store.set('mendan.me', name);
}

// ---- 管理者画面 ----
function renderAdmin() {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === adminTab));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${adminTab}`; });
  const members = (state.admin && state.admin.members) || [];
  el.requests.innerHTML = requestsHtml(members);
  el.slotAdminList.innerHTML = slotsAdminHtml(members);
  el.memberAdminList.innerHTML = membersAdminHtml(members);
  renderSlotForm();
}

function requestsHtml(members) {
  if (!members.length) return `<p class="empty">メンバーが登録されていません。「メンバー」タブで追加してください</p>`;
  const confirmedBy = new Map(members.filter(m => m.confirmed).map(m => [m.confirmed, m]));
  const waiting = members.filter(m => !m.confirmed && m.first);
  const none = members.filter(m => !m.confirmed && !m.first);
  const done = members.filter(m => m.confirmed);
  // 第1希望が重なっている枠
  const firstCount = new Map();
  waiting.forEach(m => firstCount.set(m.first, (firstCount.get(m.first) || 0) + 1));

  const wish = (m, k, label) => {
    const key = m[k];
    if (!key) return `${label}：なし`;
    const holder = confirmedBy.get(key);
    const note = holder ? `<span class="warn">（${esc(holder.name)}さんで確定済み）</span>`
      : k === 'first' && firstCount.get(key) > 1 ? `<span class="warn">（第1希望が${firstCount.get(key)}人）</span>` : '';
    return `${label}：${esc(slotLabel(key))}${note}`;
  };
  const row = (m, body) => `<li><button type="button" class="row row-btn" data-confirm="${esc(m.empId)}">
    <span class="row-main"><span class="name">${esc(m.name)} <span class="emp">${esc(m.empId)}</span></span>${body}</span>
    <span class="chevron">›</span></button></li>`;
  const group = (title, list, body) => list.length
    ? `<h2 class="group-title">${title}<span class="count">${list.length}人</span></h2><ul class="list">${list.map(m => row(m, body(m))).join('')}</ul>`
    : '';
  return `
    <div class="summary">
      <div><b>${done.length}</b>確定</div><div><b>${waiting.length}</b>確定待ち</div><div class="${none.length ? 'alert' : ''}"><b>${none.length}</b>未回答</div>
    </div>
    ${done.length ? '<button type="button" class="copy-btn" data-copy>📋 確定した日時をコピー</button>' : ''}
    ${group('確定待ち（タップして確定）', waiting, m => `<span class="sub">${wish(m, 'first', '第1')}</span><span class="sub">${wish(m, 'second', '第2')}</span>`)}
    ${group('未回答', none, () => `<span class="sub">まだ希望を出していません</span>`)}
    ${group('確定済み', done, m => `<span class="sub ok">確定：${esc(slotLabel(m.confirmed))}</span>`)}`;
}

function slotsAdminHtml(members) {
  if (!state.slots.length) return `<p class="empty">面談枠がまだありません</p>`;
  const names = (list, label) => (list.length ? `<span class="sub">${label}：${esc(list.map(m => m.name).join('、'))}</span>` : '');
  return groupByDate(state.slots).map(([date, list]) => `
    <h2 class="date-title${date < today() ? ' past' : ''}">${esc(fmtDate(date))}${date < today() ? '<span class="count">終了</span>' : ''}</h2>
    <ul class="list">${list.map(s => {
      const holder = members.find(m => m.confirmed === s.key);
      return `<li class="row">
        <div class="row-main"><span class="name">${esc(s.start)}〜${esc(s.end)}</span>
          ${holder ? `<span class="sub ok">確定：${esc(holder.name)}</span>` : '<span class="sub">空き</span>'}
          ${names(members.filter(m => !m.confirmed && m.first === s.key), '第1希望')}
          ${names(members.filter(m => !m.confirmed && m.second === s.key), '第2希望')}</div>
        <div class="row-actions"><button type="button" class="danger small" data-remove-slot="${esc(s.key)}">削除</button></div>
      </li>`;
    }).join('')}</ul>`).join('');
}

function membersAdminHtml(members) {
  if (!members.length) return `<p class="empty">メンバーが登録されていません</p>`;
  return `<ul class="list">${members.map(m => `<li class="row">
    <div class="row-main"><span class="name">${esc(m.name)}</span><span class="sub">社員番号 ${esc(m.empId)}</span></div>
    <div class="row-actions">
      <button type="button" class="small" data-edit="${esc(m.empId)}">編集</button>
      <button type="button" class="danger small" data-remove-member="${esc(m.empId)}">削除</button>
    </div></li>`).join('')}</ul>`;
}

const adminMember = empId => ((state.admin && state.admin.members) || []).find(m => m.empId === empId);

async function openConfirm(empId) {
  const m = adminMember(empId);
  if (!m) return;
  const members = state.admin.members;
  // 過ぎた枠は、いま確定している枠のときだけ出す
  const slots = state.slots.filter(s => s.date >= today() || s.key === m.confirmed);
  if (!slots.length) {
    toast('先に「面談枠」タブで枠を作ってください', 'error');
    return;
  }
  $('confirm-title').textContent = `${m.name}さんの面談日時`;
  $('confirm-wish').innerHTML = `第1：${esc(slotLabel(m.first))}<br>第2：${esc(slotLabel(m.second))}`;
  const select = $('confirm-select');
  select.innerHTML = slots.map(s => {
    const holder = members.find(x => x.confirmed === s.key && x.empId !== m.empId);
    const tag = holder ? `（確定：${holder.name}）` : s.key === m.first ? '（第1希望）' : s.key === m.second ? '（第2希望）' : '';
    return `<option value="${esc(s.key)}"${holder ? ' disabled' : ''}>${esc(slotLabel(s.key) + tag)}</option>`;
  }).join('');
  const free = slots.find(s => !members.some(x => x.confirmed === s.key));
  select.value = m.confirmed || [m.first, m.second].find(k => k && !members.some(x => x.confirmed === k)) || (free ? free.key : '');
  $('confirm-cancel-btn').hidden = !m.confirmed;
  const answer = await ask($('confirm-dialog'));
  if (answer === 'ok' && select.value) await run('confirm', { empId, key: select.value });
  if (answer === 'unconfirm' && confirm(`${m.name}さんの確定を取り消しますか？`)) await run('unconfirm', { empId });
}

async function openEdit(empId) {
  const m = adminMember(empId);
  if (!m) return;
  $('edit-empid').value = m.empId;
  $('edit-name').value = m.name;
  if (await ask($('edit-dialog')) !== 'ok') return;
  await run('editMember', { oldEmpId: empId, empId: $('edit-empid').value.trim(), name: $('edit-name').value.trim() });
}

// ---- モード切り替え ----
function setMode(next) {
  mode = next;
  store.set('mendan.mode', next === 'admin' ? 'admin' : '');
}

async function enterAdmin() {
  if (!passcode) {
    $('pass-input').value = '';
    if (await ask($('pass-dialog')) !== 'ok') return;
    passcode = $('pass-input').value.trim();
    if (!passcode) return;
  }
  setMode('admin');
  if (await run('login')) store.set('mendan.pass', passcode);
}

// fromError: パスコードが通らなかったとき。メンバー画面に戻して再読み込みする
function leaveAdmin(fromError = false) {
  passcode = '';
  store.set('mendan.pass', '');
  state.admin = undefined;
  setMode('member');
  render();
  if (!fromError) run('list');
}

// ---- イベント ----
el.modeBtn.addEventListener('click', () => {
  if (mode === 'admin') {
    setMode('member');
    run('list');
  } else {
    enterAdmin();
  }
});
$('refresh-btn').addEventListener('click', refresh);
$('logout-btn').addEventListener('click', () => leaveAdmin());

el.meSelect.addEventListener('change', () => {
  setMe(el.meSelect.value);
  draftFor = null;
  if (me) run('list');
  else render();
});

el.slotList.addEventListener('click', e => {
  const btn = e.target.closest('[data-pick]');
  if (!btn) return;
  const k = btn.dataset.pick;
  const other = k === 'first' ? 'second' : 'first';
  const key = btn.dataset.key;
  draft[k] = draft[k] === key ? '' : key;
  if (draft[other] === key) draft[other] = '';
  render();
});

el.chooseBtn.addEventListener('click', async () => {
  if (!draft.first) return;
  if (await run('choose', { name: me, first: draft.first, second: draft.second }, { quiet: true })) {
    toast('希望を送信しました', 'success');
  }
});

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  adminTab = t.dataset.tab;
  store.set('mendan.tab', adminTab);
  render();
}));

el.requests.addEventListener('click', e => {
  const btn = e.target.closest('[data-confirm]');
  if (btn) openConfirm(btn.dataset.confirm);
  if (e.target.closest('[data-copy]')) copyText(scheduleText());
});

// 確定した人を日時順に1行1人で並べ、未確定の人は末尾に名前だけ載せる
function scheduleText() {
  const members = (state.admin && state.admin.members) || [];
  const done = members.filter(m => m.confirmed).sort((a, b) => (a.confirmed < b.confirmed ? -1 : 1));
  const rest = members.filter(m => !m.confirmed);
  return [
    `【${state.title ? `${state.title} ` : ''}面談日程】`,
    ...done.map(m => `${slotLabel(m.confirmed)} ${m.name}`),
    ...(rest.length ? ['', `未確定：${rest.map(m => m.name).join('、')}`] : []),
  ].join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // クリップボード API が使えない環境では、選択してコピーする
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) {
      toast('コピーできませんでした', 'error');
      return;
    }
  }
  toast('コピーしました', 'success');
}

// ---- 面談枠の追加（日付を複数選び、同じ時間帯で作る） ----
// 日付は期間と曜日でまとめて選び、カレンダーのタップで1日ずつ足し引きする
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 月曜始まり
const MAX_RANGE_DAYS = 366;
let slotDates = [];
let rangeWeekdays = [1, 2, 3, 4, 5];
let calMonth = ''; // 表示中の月（YYYY-MM）

const toggleDate = d => {
  slotDates = slotDates.includes(d) ? slotDates.filter(x => x !== d) : [...slotDates, d].sort();
};
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

// 作られる枠の数（すでにある枠も含む）。開始などが未入力なら 0
function slotCount() {
  const toMin = t => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : NaN);
  const start = toMin($('slot-start').value);
  const minutes = Number($('slot-minutes').value);
  const end = $('slot-end').value ? toMin($('slot-end').value) : start + minutes;
  if (!(minutes > 0) || isNaN(start) || end < start + minutes) return 0;
  return Math.floor((end - start) / minutes) * slotDates.length;
}

function calendarHtml() {
  const [y, m] = calMonth.split('-').map(Number);
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const last = new Date(y, m, 0).getDate();
  const slotDays = new Set(state.slots.map(s => s.date));
  const cells = WEEK_ORDER.map(w => `<span class="cal-wd${w === 6 ? ' sat' : w === 0 ? ' sun' : ''}">${WEEKDAYS[w]}</span>`);
  for (let i = 0; i < lead; i++) cells.push('<span></span>');
  for (let i = 1; i <= last; i++) {
    const date = new Date(y, m - 1, i);
    const d = ymd(date);
    const on = slotDates.includes(d);
    const cls = ['cal-day', on && 'on', d === today() && 'today', slotDays.has(d) && 'has-slot',
      date.getDay() === 6 && 'sat', date.getDay() === 0 && 'sun'].filter(Boolean).join(' ');
    cells.push(`<button type="button" class="${cls}" data-cal-date="${d}" aria-pressed="${on}" aria-label="${esc(fmtDate(d))}"${d < today() ? ' disabled' : ''}>${i}</button>`);
  }
  return cells.join('');
}

function renderSlotForm() {
  if (!calMonth) calMonth = today().slice(0, 7);
  $('range-weekdays').innerHTML = WEEK_ORDER.map(w => {
    const on = rangeWeekdays.includes(w);
    return `<button type="button" class="wd${on ? ' on' : ''}" data-wd="${w}" aria-pressed="${on}">${WEEKDAYS[w]}</button>`;
  }).join('');
  const [y, m] = calMonth.split('-').map(Number);
  $('cal-title').textContent = `${y}年${m}月`;
  $('cal-prev').disabled = calMonth <= today().slice(0, 7);
  $('cal-grid').innerHTML = calendarHtml();
  $('date-count').textContent = slotDates.length ? `${slotDates.length}日を選択中` : '日付が選ばれていません';
  $('date-clear').hidden = !slotDates.length;
  $('date-chips').innerHTML = slotDates.map(d =>
    `<button type="button" class="chip" data-remove-date="${esc(d)}" aria-label="${esc(fmtDate(d))}を外す">${esc(fmtDate(d))} ×</button>`).join('');
  const n = slotCount();
  $('slot-submit').textContent = n ? `${n}枠を追加` : '枠を追加';
}

// 期間内で選んだ曜日の日付をまとめて選ぶ（過ぎた日と選択済みの日は除く）
function addRangeDates() {
  const from = $('range-from').value;
  const to = $('range-to').value;
  if (!from || !to) return toast('期間の開始と終了を入れてください', 'error');
  if (to < from) return toast('期間の終了は開始と同じか後にしてください', 'error');
  if ((parseDate(to) - parseDate(from)) / 86400000 > MAX_RANGE_DAYS) return toast('期間は1年以内にしてください', 'error');
  if (!rangeWeekdays.length) return toast('曜日を選んでください', 'error');
  const added = [];
  for (const date = parseDate(from); ymd(date) <= to; date.setDate(date.getDate() + 1)) {
    const d = ymd(date);
    if (d >= today() && rangeWeekdays.includes(date.getDay()) && !slotDates.includes(d)) added.push(d);
  }
  if (!added.length) return toast('選べる日付がありません（過ぎた日・選択済みの日は除きます）', 'error');
  slotDates = [...slotDates, ...added].sort();
  calMonth = added[0].slice(0, 7);
  renderSlotForm();
  toast(`${added.length}日を選びました`, 'success');
}

function shiftMonth(n) {
  const [y, m] = calMonth.split('-').map(Number);
  calMonth = ymd(new Date(y, m - 1 + n, 1)).slice(0, 7);
  renderSlotForm();
}

$('slot-form').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn || btn.type === 'submit') return;
  if (btn.id === 'range-add-btn') return addRangeDates();
  if (btn.id === 'cal-prev') return shiftMonth(-1);
  if (btn.id === 'cal-next') return shiftMonth(1);
  if (btn.id === 'date-clear') slotDates = [];
  else if (btn.dataset.wd) {
    const w = Number(btn.dataset.wd);
    rangeWeekdays = rangeWeekdays.includes(w) ? rangeWeekdays.filter(x => x !== w) : [...rangeWeekdays, w];
  } else if (btn.dataset.calDate) toggleDate(btn.dataset.calDate);
  else if (btn.dataset.removeDate) slotDates = slotDates.filter(d => d !== btn.dataset.removeDate);
  else return;
  renderSlotForm();
});
$('slot-form').addEventListener('input', renderSlotForm);

$('slot-form').addEventListener('submit', async e => {
  e.preventDefault();
  const dates = slotDates;
  if (!dates.length) {
    toast('日付を選んでください', 'error');
    return;
  }
  const params = {
    dates,
    start: $('slot-start').value,
    end: $('slot-end').value,
    minutes: Number($('slot-minutes').value),
  };
  const ok = await run('addSlots', params, { quiet: true });
  if (!ok) return;
  const { added, skipped } = ok.result;
  toast(added ? `${added}枠を追加しました${skipped ? `（同じ時刻の${skipped}枠は飛ばしました）` : ''}` : '同じ時刻の枠がすでにあります',
    added ? 'success' : 'error');
  if (added) {
    slotDates = [];
    $('range-from').value = '';
    $('range-to').value = '';
    $('slot-end').value = '';
    renderSlotForm();
  }
});

el.slotAdminList.addEventListener('click', e => {
  const btn = e.target.closest('[data-remove-slot]');
  if (!btn) return;
  const key = btn.dataset.removeSlot;
  if (confirm(`${slotLabel(key)} の枠を削除しますか？\nこの枠を希望していた人の希望から外れます`)) run('removeSlot', { key });
});

$('member-form').addEventListener('submit', async e => {
  e.preventDefault();
  const empId = $('add-empid').value.trim();
  const name = $('add-name').value.trim();
  if (!empId || !name) {
    toast('社員番号と名前を入力してください', 'error');
    return;
  }
  if (await run('addMember', { empId, name })) {
    $('add-empid').value = '';
    $('add-name').value = '';
    $('add-empid').focus();
  }
});

el.memberAdminList.addEventListener('click', e => {
  const edit = e.target.closest('[data-edit]');
  if (edit) openEdit(edit.dataset.edit);
  const remove = e.target.closest('[data-remove-member]');
  if (remove) {
    const m = adminMember(remove.dataset.removeMember);
    if (m && confirm(`${m.name}さんを削除しますか？\n希望・確定した日時も消えます`)) run('removeMember', { empId: m.empId });
  }
});

// アプリに戻ってきたとき、1分以上たっていれば最新にする
let lastShown = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastShown > 60000) refresh();
  lastShown = Date.now();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}

render();
refresh();
