'use strict';

/* ========== 常數 ========== */
const STORE_KEY = 'subtrack.v1';
const APP_VERSION = '1.1.0';

const CATEGORIES = {
  video: { label: '影音', color: '#6366f1' },
  tool: { label: '工具', color: '#10b981' },
  shopping: { label: '購物外送', color: '#f59e0b' },
  other: { label: '其他', color: '#94a3b8' },
};
const STATUSES = {
  active: '使用中',
  considering: '考慮取消',
  cancelled: '已取消',
};
const CYCLES = { monthly: '月繳', yearly: '年繳' };

const DEFAULT_SUBS = [
  ['巴哈姆特動畫瘋', 'video'],
  ['Netflix', 'video'],
  ['Google One', 'tool'],
  ['YouTube Premium', 'video'],
  ['Claude', 'tool'],
  ['Uber One', 'shopping'],
  ['蝦皮', 'shopping'],
];

/* ========== 狀態 ========== */
let state; // 在 DOMContentLoaded 時載入（ledger.js 載入後）
let currentView = 'home';
let listFilter = 'all';
let calCursor = startOfMonth(today());
let calSelected = null;
let review = null; // { queue: [id], idx, results: {id: 'used'|'unused'|'skip'} }
let editingId = null;

/* ========== 儲存 ========== */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function blankSub(overrides = {}) {
  return {
    id: uid(),
    name: '',
    amount: 0,
    currency: 'TWD',
    cycle: 'monthly',
    billingDay: null, // 1–31
    billingMonth: null, // 1–12，年繳才用
    payment: '',
    category: 'other',
    status: 'active',
    lastReviewed: null,
    ...overrides,
  };
}

function defaultState() {
  return {
    version: 2,
    settings: { usdRate: 32 },
    subs: DEFAULT_SUBS.map(([name, category]) => blankSub({ name, category })),
    ...defaultLedger(),
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (e) {
    console.warn('讀取資料失敗，改用預設值', e);
  }
  return defaultState();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast('儲存失敗：' + e.message);
  }
}

/** 驗證並修正資料（也用於匯入） */
function normalizeState(data) {
  if (!data || !Array.isArray(data.subs)) throw new Error('格式不正確：找不到 subs 陣列');
  const rate = Number(data.settings && data.settings.usdRate);
  const intIn = (v, lo, hi) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  return {
    version: 2,
    ...normalizeLedger(data),
    settings: { usdRate: rate > 0 ? rate : 32 },
    subs: data.subs
      .filter((s) => s && typeof s.name === 'string' && s.name.trim())
      .map((s) => blankSub({
        id: typeof s.id === 'string' && s.id ? s.id : uid(),
        name: s.name.trim().slice(0, 40),
        amount: Math.max(0, Number(s.amount) || 0),
        currency: s.currency === 'USD' ? 'USD' : 'TWD',
        cycle: s.cycle === 'yearly' ? 'yearly' : 'monthly',
        billingDay: intIn(s.billingDay, 1, 31),
        billingMonth: intIn(s.billingMonth, 1, 12),
        payment: typeof s.payment === 'string' ? s.payment.slice(0, 30) : '',
        category: CATEGORIES[s.category] ? s.category : 'other',
        status: STATUSES[s.status] ? s.status : 'active',
        lastReviewed: typeof s.lastReviewed === 'string' ? s.lastReviewed : null,
      })),
  };
}

/* ========== 工具函式 ========== */
function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function clampDate(y, m, day) { return new Date(y, m, Math.min(day, daysInMonth(y, m))); }
function sameDay(a, b) { return a && b && a.getTime() === b.getTime(); }
function daysBetween(a, b) { return Math.round((b - a) / 86400000); }

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function fmtDate(d) { return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`; }

function fmtTWD(n) {
  return 'NT$' + Math.round(n).toLocaleString('zh-TW');
}
function fmtOrig(s) {
  if (s.currency === 'USD') return 'US$' + Number(s.amount).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return 'NT$' + Number(s.amount).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 單次扣款金額（台幣） */
function chargeTWD(s) {
  return s.amount * (s.currency === 'USD' ? state.settings.usdRate : 1);
}
/** 每月平均（台幣），年繳 ÷ 12 */
function monthlyTWD(s) {
  return chargeTWD(s) / (s.cycle === 'yearly' ? 12 : 1);
}
function yearlyTWD(s) { return monthlyTWD(s) * 12; }

function isCounted(s) { return s.status !== 'cancelled'; }
function needsSetup(s) {
  return !s.amount || !s.billingDay || (s.cycle === 'yearly' && !s.billingMonth);
}

/** 這筆訂閱是否在指定日期扣款 */
function chargesOn(s, date) {
  if (!s.billingDay) return false;
  const y = date.getFullYear();
  const m = date.getMonth();
  if (s.cycle === 'yearly') {
    if (!s.billingMonth || s.billingMonth - 1 !== m) return false;
  }
  return sameDay(clampDate(y, m, s.billingDay), date);
}

/** 從 from（含）起算的下一次扣款日 */
function nextCharge(s, from = today()) {
  if (!s.billingDay) return null;
  if (s.cycle === 'yearly') {
    if (!s.billingMonth) return null;
    let d = clampDate(from.getFullYear(), s.billingMonth - 1, s.billingDay);
    if (d < from) d = clampDate(from.getFullYear() + 1, s.billingMonth - 1, s.billingDay);
    return d;
  }
  let d = clampDate(from.getFullYear(), from.getMonth(), s.billingDay);
  if (d < from) d = clampDate(from.getFullYear(), from.getMonth() + 1, s.billingDay);
  return d;
}

function billingText(s) {
  if (!s.billingDay) return '扣款日未設定';
  if (s.cycle === 'yearly') return s.billingMonth ? `每年 ${s.billingMonth}/${s.billingDay}` : '扣款月份未設定';
  return `每月 ${s.billingDay} 日`;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ========== 共用元件 ========== */
function statusBadge(s) {
  if (s.status === 'considering') return '<span class="badge warn">考慮取消</span>';
  if (s.status === 'cancelled') return '<span class="badge muted">已取消</span>';
  return '';
}

function itemHTML(s, { rightTop, rightBottom, subText } = {}) {
  const cat = CATEGORIES[s.category];
  const todo = needsSetup(s) && s.status !== 'cancelled' ? '<span class="badge todo">待填</span>' : '';
  const sub = subText ?? [cat.label, CYCLES[s.cycle], billingText(s), s.payment].filter(Boolean).join(' · ');
  const top = rightTop ?? (s.amount ? fmtOrig(s) : '—');
  const bottom = rightBottom ?? (s.amount && (s.cycle === 'yearly' || s.currency === 'USD') ? `≈ ${fmtTWD(monthlyTWD(s))}/月` : '');
  return `
    <button class="item ${s.status}" data-edit="${esc(s.id)}">
      <span class="dot" style="background:${cat.color}"></span>
      <span class="main">
        <span class="name">${esc(s.name)}${statusBadge(s)}${todo}</span>
        <span class="sub">${esc(sub)}</span>
      </span>
      <span class="right">
        <span class="amt">${esc(top)}</span>
        ${bottom ? `<span class="sub">${esc(bottom)}</span>` : ''}
      </span>
    </button>`;
}

/* ========== 首頁 ========== */
function renderHome() {
  renderHomeLedger();
  const counted = state.subs.filter(isCounted);
  const monthly = counted.reduce((a, s) => a + monthlyTWD(s), 0);
  const big = (n) => `<span class="cur">NT$</span>${Math.round(n).toLocaleString('zh-TW')}`;
  document.getElementById('monthlyTotal').innerHTML = big(monthly);
  document.getElementById('yearlyTotal').innerHTML = big(monthly * 12);

  const considering = counted.filter((s) => s.status === 'considering');
  const hint = [];
  hint.push(`共 ${counted.length} 筆使用中的訂閱`);
  if (considering.length) {
    const save = considering.reduce((a, s) => a + yearlyTWD(s), 0);
    hint.push(`${considering.length} 筆考慮取消，取消後每年可省 ${fmtTWD(save)}`);
  }
  document.getElementById('totalsHint').textContent = hint.join('；');

  // 即將扣款（今天起 7 天內）
  const t = today();
  const upcoming = counted
    .map((s) => ({ s, d: nextCharge(s, t) }))
    .filter((x) => x.d && daysBetween(t, x.d) <= 7)
    .sort((a, b) => a.d - b.d);
  document.getElementById('upcoming').innerHTML = upcoming.length
    ? upcoming.map(({ s, d }) => {
      const n = daysBetween(t, d);
      const when = n === 0 ? '今天' : n === 1 ? '明天' : `${n} 天後`;
      return itemHTML(s, {
        subText: `${fmtDate(d)} · ${when}${s.payment ? ' · ' + s.payment : ''}`,
        rightBottom: s.currency === 'USD' && s.amount ? `≈ ${fmtTWD(chargeTWD(s))}` : '',
      });
    }).join('')
    : '<div class="empty">7 天內沒有扣款 🎉</div>';

  renderPie(counted);

  // 待填提醒
  const todo = counted.filter(needsSetup);
  document.getElementById('todoBox').innerHTML = todo.length
    ? `<h2>還沒填完 <small>${todo.length} 筆</small></h2>
       <div class="list">${todo.map((s) => itemHTML(s)).join('')}</div>
       <p class="hint">點一下填入金額與扣款日，總額和提醒才會準確。</p>`
    : '';
}

function renderPie(subs) {
  const sums = {};
  for (const k of Object.keys(CATEGORIES)) sums[k] = 0;
  for (const s of subs) sums[s.category] += monthlyTWD(s);
  const total = Object.values(sums).reduce((a, b) => a + b, 0);
  const svg = document.getElementById('pie');
  const legend = document.getElementById('legend');

  const R = 50, C = 60, W = 18;
  const circ = 2 * Math.PI * R;
  let html = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="var(--line)" stroke-width="${W}"/>`;
  if (total > 0) {
    let offset = 0;
    for (const [k, v] of Object.entries(sums)) {
      if (!v) continue;
      const len = (v / total) * circ;
      html += `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${CATEGORIES[k].color}"
        stroke-width="${W}" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 ${C} ${C})"/>`;
      offset += len;
    }
  }
  html += `<text x="${C}" y="${C - 2}" text-anchor="middle" font-size="9" fill="var(--muted)">每月</text>
    <text x="${C}" y="${C + 12}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--text)">${esc(fmtTWD(total))}</text>`;
  svg.innerHTML = html;

  legend.innerHTML = Object.entries(sums).map(([k, v]) => `
    <li><span class="sw" style="background:${CATEGORIES[k].color}"></span>${CATEGORIES[k].label}
    <span class="v">${total ? Math.round((v / total) * 100) : 0}% · ${fmtTWD(v)}</span></li>`).join('');
}

/* ========== 清單 ========== */
function renderList() {
  document.querySelectorAll('#listFilter button').forEach((b) => b.classList.toggle('on', b.dataset.f === listFilter));
  const t = today();
  const subs = state.subs
    .filter((s) => listFilter === 'all' || s.status === listFilter)
    .map((s) => ({ s, d: nextCharge(s, t) }))
    .sort((a, b) => {
      // 已取消放最後；有扣款日的依下次扣款日排；沒設定的放後面
      const ca = a.s.status === 'cancelled', cb = b.s.status === 'cancelled';
      if (ca !== cb) return ca ? 1 : -1;
      if (a.d && b.d) return a.d - b.d;
      if (a.d || b.d) return a.d ? -1 : 1;
      return a.s.name.localeCompare(b.s.name, 'zh-Hant');
    });
  document.getElementById('subList').innerHTML = subs.length
    ? subs.map(({ s, d }) => {
      const cat = CATEGORIES[s.category];
      const next = d && s.status !== 'cancelled' ? `下次 ${fmtDate(d)}` : billingText(s);
      return itemHTML(s, { subText: [cat.label, CYCLES[s.cycle], next, s.payment].filter(Boolean).join(' · ') });
    }).join('')
    : '<div class="empty">沒有符合的訂閱</div>';
}

/* ========== 月曆 ========== */
function renderCalendar() {
  const y = calCursor.getFullYear();
  const m = calCursor.getMonth();
  document.getElementById('calTitle').textContent = `${y} 年 ${m + 1} 月`;
  const t = today();
  const subs = state.subs.filter(isCounted);
  const first = new Date(y, m, 1).getDay();
  const dim = daysInMonth(y, m);
  let html = '';
  let monthSum = 0;
  for (let i = 0; i < first; i++) html += '<div class="cal-cell blank"></div>';
  for (let day = 1; day <= dim; day++) {
    const date = new Date(y, m, day);
    const hits = subs.filter((s) => chargesOn(s, date));
    const sum = hits.reduce((a, s) => a + chargeTWD(s), 0);
    monthSum += sum;
    const cls = ['cal-cell'];
    if (sameDay(date, t)) cls.push('today');
    if (sameDay(date, calSelected)) cls.push('sel');
    html += `<button class="${cls.join(' ')}" data-day="${day}">
      <span>${day}</span>
      <span class="dots">${hits.slice(0, 6).map((s) => `<i style="background:${CATEGORIES[s.category].color}"></i>`).join('')}</span>
      ${sum ? `<span class="amt">${Math.round(sum).toLocaleString('zh-TW')}</span>` : ''}
    </button>`;
  }
  document.getElementById('calGrid').innerHTML = html;
  document.getElementById('calSum').textContent = `本月預計扣款 ${fmtTWD(monthSum)}`;

  const titleEl = document.getElementById('calDayTitle');
  const listEl = document.getElementById('calDayList');
  if (calSelected && calSelected.getMonth() === m && calSelected.getFullYear() === y) {
    const hits = subs.filter((s) => chargesOn(s, calSelected));
    titleEl.textContent = `${fmtDate(calSelected)} 扣款`;
    listEl.innerHTML = hits.length
      ? hits.map((s) => itemHTML(s, { rightBottom: s.currency === 'USD' && s.amount ? `≈ ${fmtTWD(chargeTWD(s))}` : '' })).join('')
      : '<div class="empty">這天沒有扣款</div>';
  } else {
    titleEl.textContent = '';
    listEl.innerHTML = '<p class="hint center">點日期查看當天扣哪些</p>';
  }
}

/* ========== 審視模式 ========== */
function startReview() {
  const queue = state.subs.filter((s) => s.status !== 'cancelled').map((s) => s.id);
  review = { queue, idx: 0, results: {} };
  renderReview();
}

function renderReview() {
  const box = document.getElementById('reviewBox');
  const considering = state.subs.filter((s) => s.status === 'considering');
  const saveYear = considering.reduce((a, s) => a + yearlyTWD(s), 0);

  if (!review) {
    box.innerHTML = `
      <div class="card review-card">
        <div class="rname">🔍 審視模式</div>
        <p>一筆一筆問你：「上個月有用嗎？」<br>沒用的會標記為「考慮取消」，並算出取消後每年能省多少。</p>
        <button class="btn" id="reviewStart">開始審視（${state.subs.filter((s) => s.status !== 'cancelled').length} 筆）</button>
      </div>
      ${savingsHTML(considering, saveYear)}`;
    return;
  }

  if (review.idx >= review.queue.length) {
    const unused = Object.values(review.results).filter((r) => r === 'unused').length;
    box.innerHTML = `
      <div class="card review-card">
        <div class="rname">審視完成 ✅</div>
        <p>這次標記了 ${unused} 筆考慮取消。</p>
        <button class="btn" id="reviewDone">完成</button>
      </div>
      ${savingsHTML(considering, saveYear)}`;
    return;
  }

  const s = state.subs.find((x) => x.id === review.queue[review.idx]);
  if (!s) { review.idx++; return renderReview(); }
  const total = review.queue.length;
  box.innerHTML = `
    <div class="card review-card">
      <div class="progress">${review.idx + 1} / ${total}</div>
      <div class="bar"><div style="width:${(review.idx / total) * 100}%"></div></div>
      <div class="rname">${esc(s.name)}</div>
      <div class="hint">${esc(CATEGORIES[s.category].label)} · ${s.amount ? esc(fmtOrig(s)) + ' / ' + (s.cycle === 'yearly' ? '年' : '月') : '金額未填'}${statusBadge(s)}</div>
      <div class="save">取消後每年可省 ${esc(fmtTWD(yearlyTWD(s)))}</div>
      <div class="q">上個月有用嗎？</div>
      <div class="review-actions">
        <button class="btn ok" data-review="used">👍 有用，繼續訂</button>
        <button class="btn warn" data-review="unused">👎 沒用，考慮取消</button>
        <button class="btn ghost" data-review="skip">跳過</button>
      </div>
    </div>
    ${savingsHTML(considering, saveYear)}`;
}

function savingsHTML(list, saveYear) {
  if (!list.length) return '';
  return `
    <div class="card savings">
      <div class="hint">考慮取消的 ${list.length} 筆，全部取消後每年可省</div>
      <div class="big">${esc(fmtTWD(saveYear))}</div>
      <div class="hint">（每月 ${esc(fmtTWD(saveYear / 12))}）</div>
    </div>
    <div class="list">${list.map((s) => itemHTML(s, { rightBottom: `省 ${fmtTWD(yearlyTWD(s))}/年` })).join('')}</div>
    <p class="hint">點項目可把狀態改成「已取消」或改回「使用中」。</p>`;
}

function answerReview(ans) {
  const s = state.subs.find((x) => x.id === review.queue[review.idx]);
  if (s) {
    review.results[s.id] = ans;
    if (ans !== 'skip') s.lastReviewed = new Date().toISOString();
    if (ans === 'unused') s.status = 'considering';
    if (ans === 'used' && s.status === 'considering') s.status = 'active';
    save();
  }
  review.idx++;
  renderReview();
}

/* ========== 設定 ========== */
function renderSettings() {
  renderCatManager();
  document.getElementById('rateInput').value = state.settings.usdRate;
  document.getElementById('versionInfo').textContent = `版本 ${APP_VERSION} · 資料僅存在本機`;
}

function exportJSON() {
  const data = { ...state, exportedAt: new Date().toISOString(), app: 'subtrack' };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const d = new Date();
  const name = `subscriptions-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('已匯出 ' + name);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const next = normalizeState(JSON.parse(reader.result));
      if (!confirm(`將以備份中的 ${next.subs.length} 筆訂閱、${next.expenses.length} 筆支出取代目前資料，確定嗎？`)) return;
      state = next;
      save();
      review = null;
      render();
      toast('匯入完成');
    } catch (e) {
      alert('匯入失敗：' + e.message);
    }
  };
  reader.readAsText(file);
}

/* ========== 編輯表單 ========== */
const dlg = document.getElementById('editDialog');
const form = document.getElementById('editForm');

function fillSelect(sel, entries) {
  sel.innerHTML = entries.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
}
fillSelect(form.category, Object.entries(CATEGORIES).map(([k, v]) => [k, v.label]));
fillSelect(form.status, Object.entries(STATUSES));
fillSelect(form.billingMonth, [['', '未設定'], ...Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1} 月`])]);
fillSelect(form.billingDay, [['', '未設定'], ...Array.from({ length: 31 }, (_, i) => [i + 1, `${i + 1} 日`])]);

function openEdit(id) {
  const s = id ? state.subs.find((x) => x.id === id) : blankSub();
  if (!s) return;
  editingId = id || null;
  document.getElementById('editTitle').textContent = id ? '編輯訂閱' : '新增訂閱';
  document.getElementById('deleteBtn').hidden = !id;
  form.name.value = s.name;
  form.amount.value = s.amount || '';
  form.currency.value = s.currency;
  form.cycle.value = s.cycle;
  form.billingMonth.value = s.billingMonth ?? '';
  form.billingDay.value = s.billingDay ?? '';
  form.payment.value = s.payment;
  form.category.value = s.category;
  form.status.value = s.status;
  updateEditUI();
  dlg.showModal();
}

function readForm() {
  return {
    name: form.name.value.trim(),
    amount: Math.max(0, Number(form.amount.value) || 0),
    currency: form.currency.value,
    cycle: form.cycle.value,
    billingMonth: form.billingMonth.value ? Number(form.billingMonth.value) : null,
    billingDay: form.billingDay.value ? Number(form.billingDay.value) : null,
    payment: form.payment.value.trim(),
    category: form.category.value,
    status: form.status.value,
  };
}

function updateEditUI() {
  const v = readForm();
  document.getElementById('monthField').hidden = v.cycle !== 'yearly';
  const tmp = blankSub(v);
  const parts = [];
  if (v.amount) {
    if (v.currency === 'USD') parts.push(`單次 ≈ ${fmtTWD(chargeTWD(tmp))}（匯率 ${state.settings.usdRate}）`);
    parts.push(`每月平均 ${fmtTWD(monthlyTWD(tmp))}，每年 ${fmtTWD(yearlyTWD(tmp))}`);
  }
  if (v.billingDay > 28 && v.cycle === 'monthly') parts.push('小月份會在月底扣款');
  document.getElementById('editPreview').textContent = parts.join('；');
}

form.addEventListener('input', updateEditUI);
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = readForm();
  if (!v.name) return form.name.focus();
  if (editingId) {
    Object.assign(state.subs.find((x) => x.id === editingId), v);
  } else {
    state.subs.push(blankSub(v));
  }
  save();
  dlg.close();
  render();
  toast('已儲存');
});
document.getElementById('cancelEdit').addEventListener('click', () => dlg.close());
document.getElementById('deleteBtn').addEventListener('click', () => {
  const s = state.subs.find((x) => x.id === editingId);
  if (!s || !confirm(`確定刪除「${s.name}」？（若只是不用了，建議改狀態為「已取消」保留紀錄）`)) return;
  state.subs = state.subs.filter((x) => x.id !== editingId);
  save();
  dlg.close();
  render();
  toast('已刪除');
});
// 點背景關閉
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

/* ========== 導覽 & 事件 ========== */
const TITLES = { home: '訂閱追蹤器', ledger: '記帳', stats: '統計', list: '訂閱清單', calendar: '扣款月曆', review: '審視模式', settings: '設定' };
const SUB_VIEWS = ['list', 'calendar', 'review'];
let subView = 'list';

function show(view) {
  if (view === 'subs') view = subView;
  if (SUB_VIEWS.includes(view)) subView = view;
  currentView = view;
  const tab = SUB_VIEWS.includes(view) ? 'subs' : view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === tab));
  const seg = document.getElementById('subSeg');
  seg.hidden = tab !== 'subs';
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  document.getElementById('addBtn').setAttribute('aria-label', tab === 'subs' ? '新增訂閱' : '記一筆');
  document.getElementById('pageTitle').textContent = TITLES[view];
  render();
  window.scrollTo(0, 0);
}

function render() {
  ({ home: renderHome, ledger: renderLedger, stats: renderStats, list: renderList, calendar: renderCalendar, review: renderReview, settings: renderSettings })[currentView]();
}

document.querySelectorAll('.tabbar, #subSeg').forEach((el) => el.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) show(b.dataset.view);
}));
document.getElementById('addBtn').addEventListener('click', () => {
  if (SUB_VIEWS.includes(currentView)) openEdit(null);
  else openExpense(null);
});

document.addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return openEdit(edit.dataset.edit);
  const f = e.target.closest('#listFilter button');
  if (f) { listFilter = f.dataset.f; return renderList(); }
  const day = e.target.closest('[data-day]');
  if (day) {
    calSelected = new Date(calCursor.getFullYear(), calCursor.getMonth(), Number(day.dataset.day));
    return renderCalendar();
  }
  const r = e.target.closest('[data-review]');
  if (r) return answerReview(r.dataset.review);
  if (e.target.id === 'reviewStart') return startReview();
  if (e.target.id === 'reviewDone') { review = null; return renderReview(); }
});

document.getElementById('calPrev').addEventListener('click', () => {
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1);
  renderCalendar();
});
document.getElementById('calNext').addEventListener('click', () => {
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1);
  renderCalendar();
});

document.getElementById('rateInput').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (!(v > 0)) { e.target.value = state.settings.usdRate; return toast('匯率需大於 0'); }
  state.settings.usdRate = v;
  save();
  toast('匯率已更新');
});
document.getElementById('exportBtn').addEventListener('click', exportJSON);
document.getElementById('importInput').addEventListener('change', (e) => {
  if (e.target.files[0]) importJSON(e.target.files[0]);
  e.target.value = '';
});
document.getElementById('resetBtn').addEventListener('click', () => {
  if (!confirm('會刪除所有訂閱和記帳資料，並還原成預設清單，確定嗎？建議先匯出備份。')) return;
  state = defaultState();
  save();
  review = null;
  render();
  toast('已還原預設');
});

// 回到 App 時（例如隔天開啟）重新計算「即將扣款」
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

/* ========== 啟動 ========== */
document.addEventListener('DOMContentLoaded', () => {
  state = load();
  save();
  show('home');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 註冊失敗', e));
  });
}
