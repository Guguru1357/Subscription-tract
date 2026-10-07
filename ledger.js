'use strict';
/* 記帳 + 統計。與 app.js 共用 state / save / esc / toast 等全域函式。 */

/* ========== 常數 ========== */
// 顏色依序取自經色盲驗證的分類色盤；深色模式自動換成對應的深色版本
const VIZ_DARK = {
  '#2a78d6': '#3987e5', '#eb6834': '#d95926', '#1baf7a': '#199e70', '#eda100': '#c98500',
  '#e87ba4': '#d55181', '#008300': '#008300', '#4a3aa7': '#9085e9', '#e34948': '#e66767',
};
const DEFAULT_EXP_CATS = [
  { id: 'food', name: '餐飲', emoji: '🍱', color: '#2a78d6' },
  { id: 'transport', name: '交通', emoji: '🚇', color: '#eb6834' },
  { id: 'shopping', name: '購物', emoji: '🛍️', color: '#1baf7a' },
  { id: 'fun', name: '娛樂', emoji: '🎮', color: '#eda100' },
  { id: 'daily', name: '生活日用', emoji: '🧻', color: '#e87ba4' },
  { id: 'health', name: '醫療', emoji: '💊', color: '#008300' },
  { id: 'other', name: '其他', emoji: '📦', color: '#4a3aa7' },
];
const FIXED_CATS = ['food', 'other']; // 不可刪除
const SUB_CAT = { id: '__sub', name: '訂閱', emoji: '🔁', color: '#e34948' };
const NEW_CAT_COLOR = '#8a8f98';
const MEALS = { meal: '正餐', snack: '點心' };
const MEAL_COLORS = { meal: '#2a78d6', snack: '#eb6834' };

/* ========== 狀態 ========== */
let ledgerCursor = startOfMonth(today());
let ledgerFilter = 'all';
let statsMode = 'month'; // month | year
let statsCursor = startOfMonth(today());
let statsIncludeSubs = true;
let statsBarSel = null;
let statsPieSel = null;
let expEditingId = null;
let expDraft = null; // 表單目前選擇的 { cat, meal }
let chipManage = false;
let autoFilledAmount = null;

/* ========== 資料 ========== */
function defaultLedger() {
  return { expenseCats: DEFAULT_EXP_CATS.map((c) => ({ ...c })), expenses: [], quickItems: {} };
}

function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

/** 驗證記帳資料（舊版備份沒有這些欄位時補上預設值） */
function normalizeLedger(data) {
  const base = defaultLedger();
  let cats = Array.isArray(data.expenseCats) ? data.expenseCats
    .filter((c) => c && typeof c.id === 'string' && c.id && typeof c.name === 'string' && c.name.trim())
    .map((c) => ({
      id: c.id.slice(0, 40),
      name: c.name.trim().slice(0, 12),
      emoji: typeof c.emoji === 'string' ? [...c.emoji].slice(0, 2).join('') : '',
      color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color.toLowerCase() : NEW_CAT_COLOR,
    })) : base.expenseCats;
  for (const id of FIXED_CATS) {
    if (!cats.some((c) => c.id === id)) cats.push({ ...DEFAULT_EXP_CATS.find((c) => c.id === id) });
  }
  const catIds = new Set(cats.map((c) => c.id));
  const expenses = Array.isArray(data.expenses) ? data.expenses
    .filter((e) => e && isYmd(e.date) && Number(e.amount) > 0)
    .map((e) => {
      const cat = catIds.has(e.cat) ? e.cat : 'other';
      return {
        id: typeof e.id === 'string' && e.id ? e.id : uid(),
        date: e.date,
        amount: Math.round(Number(e.amount) * 100) / 100,
        cat,
        meal: cat === 'food' ? (e.meal === 'snack' ? 'snack' : 'meal') : null,
        item: typeof e.item === 'string' ? e.item.trim().slice(0, 40) : '',
        note: typeof e.note === 'string' ? e.note.slice(0, 100) : '',
      };
    }) : [];
  const quickItems = {};
  if (data.quickItems && typeof data.quickItems === 'object') {
    for (const q of Object.values(data.quickItems)) {
      if (!q || typeof q.item !== 'string' || !q.item.trim() || !catIds.has(q.cat)) continue;
      const meal = q.cat === 'food' ? (q.meal === 'snack' ? 'snack' : 'meal') : null;
      const item = q.item.trim().slice(0, 40);
      quickItems[qKey(q.cat, meal, item)] = {
        cat: q.cat, meal, item,
        amount: Math.max(0, Number(q.amount) || 0),
        count: Math.max(1, parseInt(q.count, 10) || 1),
        last: Number(q.last) || 0,
      };
    }
  }
  return { expenseCats: cats, expenses, quickItems };
}

function qKey(cat, meal, item) { return `${cat}|${meal || ''}|${item}`; }
function catById(id) {
  if (id === SUB_CAT.id) return SUB_CAT;
  return state.expenseCats.find((c) => c.id === id) || state.expenseCats.find((c) => c.id === 'other');
}
function catLabel(e) {
  const c = catById(e.cat);
  return c.name + (e.meal ? '・' + MEALS[e.meal] : '');
}

const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
function vizColor(hex) { return darkMQ.matches && VIZ_DARK[hex] ? VIZ_DARK[hex] : hex; }

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function guessMeal() {
  const h = new Date().getHours();
  return (h >= 6 && h < 10) || (h >= 11 && h < 14) || (h >= 17 && h < 21) ? 'meal' : 'snack';
}
function fmtNum(n) { return Math.round(n).toLocaleString('zh-TW'); }

/** 期間內的支出（含訂閱扣款時，訂閱轉成虛擬項目） */
function entriesInRange(start, end, includeSubs) {
  const s = ymd(start), e = ymd(end);
  const list = state.expenses.filter((x) => x.date >= s && x.date <= e);
  if (includeSubs) {
    const subs = state.subs.filter(isCounted).filter((x) => x.amount > 0);
    for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      for (const sub of subs) {
        if (chargesOn(sub, d)) {
          list.push({ id: 'sub-' + sub.id, date: ymd(d), amount: chargeTWD(sub), cat: SUB_CAT.id, meal: null, item: sub.name, note: '', virtual: true });
        }
      }
    }
  }
  return list;
}

/* ========== 首頁小卡 ========== */
function renderHomeLedger() {
  const t = ymd(today());
  const monthStart = ymd(startOfMonth(today()));
  const todayList = state.expenses.filter((e) => e.date === t);
  const monthSum = state.expenses.filter((e) => e.date >= monthStart && e.date <= t).reduce((a, e) => a + e.amount, 0);
  const todaySum = todayList.reduce((a, e) => a + e.amount, 0);
  document.getElementById('homeLedger').innerHTML = `
    <div class="card ledger-card">
      <div class="ledger-nums">
        <div><div class="label">今天支出</div><div class="mid">${esc(fmtTWD(todaySum))}</div></div>
        <div><div class="label">本月記帳</div><div class="mid">${esc(fmtTWD(monthSum))}</div></div>
      </div>
      <button class="btn" data-action="add-expense">＋ 記一筆</button>
    </div>
    ${todayList.length ? `<div class="list">${todayList.slice().reverse().slice(0, 5).map(expItemHTML).join('')}</div>` : ''}`;
}

/* ========== 記帳頁 ========== */
function expItemHTML(e) {
  const c = catById(e.cat);
  const title = e.item || c.name;
  const sub = [catLabel(e), e.note].filter(Boolean).join(' · ');
  return `
    <button class="item" ${e.virtual ? '' : `data-exp="${esc(e.id)}"`}>
      <span class="emoji" style="background:${vizColor(c.color)}22">${esc(c.emoji || '•')}</span>
      <span class="main">
        <span class="name">${esc(title)}</span>
        <span class="sub">${esc(sub)}</span>
      </span>
      <span class="right"><span class="amt">${esc(fmtTWD(e.amount))}</span></span>
    </button>`;
}

function renderLedger() {
  const y = ledgerCursor.getFullYear(), m = ledgerCursor.getMonth();
  document.getElementById('ledgerTitle').textContent = `${y} 年 ${m + 1} 月`;
  const start = ymd(new Date(y, m, 1)), end = ymd(new Date(y, m + 1, 0));
  const monthList = state.expenses.filter((e) => e.date >= start && e.date <= end);
  if (ledgerFilter !== 'all' && !state.expenseCats.some((c) => c.id === ledgerFilter)) ledgerFilter = 'all';

  // 分類篩選
  const used = new Set(monthList.map((e) => e.cat));
  document.getElementById('ledgerFilter').innerHTML =
    `<button data-lf="all" class="${ledgerFilter === 'all' ? 'on' : ''}">全部</button>` +
    state.expenseCats.filter((c) => used.has(c.id) || c.id === ledgerFilter)
      .map((c) => `<button data-lf="${esc(c.id)}" class="${ledgerFilter === c.id ? 'on' : ''}">${esc(c.emoji)} ${esc(c.name)}</button>`).join('');

  const list = monthList.filter((e) => ledgerFilter === 'all' || e.cat === ledgerFilter);
  const total = list.reduce((a, e) => a + e.amount, 0);
  document.getElementById('ledgerTotal').innerHTML =
    `<span>${list.length} 筆</span><strong>${esc(fmtTWD(total))}</strong>`;

  const byDate = {};
  for (const e of list) (byDate[e.date] = byDate[e.date] || []).push(e);
  const dates = Object.keys(byDate).sort().reverse();
  document.getElementById('ledgerList').innerHTML = dates.length
    ? dates.map((d) => {
      const items = byDate[d];
      const sum = items.reduce((a, e) => a + e.amount, 0);
      return `<div class="day-head"><span>${esc(fmtDate(parseYmd(d)))}</span><span>${esc(fmtTWD(sum))}</span></div>
        <div class="list">${items.slice().reverse().map(expItemHTML).join('')}</div>`;
    }).join('')
    : '<div class="empty">這個月還沒有記錄<br><button class="btn" data-action="add-expense">＋ 記一筆</button></div>';
}

/* ========== 統計頁 ========== */
function statsRange() {
  const y = statsCursor.getFullYear(), m = statsCursor.getMonth();
  if (statsMode === 'year') return { start: new Date(y, 0, 1), end: new Date(y, 11, 31), prevStart: new Date(y - 1, 0, 1), prevEnd: new Date(y - 1, 11, 31), title: `${y} 年` };
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 0), prevStart: new Date(y, m - 1, 1), prevEnd: new Date(y, m, 0), title: `${y} 年 ${m + 1} 月` };
}

function renderStats() {
  document.querySelectorAll('#statsMode button').forEach((b) => b.classList.toggle('on', b.dataset.sm === statsMode));
  document.getElementById('statsIncludeSubs').checked = statsIncludeSubs;
  const r = statsRange();
  document.getElementById('statsTitle').textContent = r.title;
  const list = entriesInRange(r.start, r.end, statsIncludeSubs);
  const prev = entriesInRange(r.prevStart, r.prevEnd, statsIncludeSubs);
  const total = list.reduce((a, e) => a + e.amount, 0);
  const prevTotal = prev.reduce((a, e) => a + e.amount, 0);

  // 平均：進行中的期間只算到今天
  const t = today();
  const effEnd = r.end > t && r.start <= t ? t : r.end;
  const days = Math.max(1, daysBetween(r.start, effEnd) + 1);
  const diff = prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;
  document.getElementById('statsHero').innerHTML = `
    <div class="label">${statsMode === 'year' ? '今年' : '本月'}總支出${statsIncludeSubs ? '（含訂閱）' : ''}</div>
    <div class="hero-num">${esc(fmtTWD(total))}</div>
    <div class="hint">日平均 ${esc(fmtTWD(total / days))} · ${statsMode === 'year' ? '去年' : '上月'} ${esc(fmtTWD(prevTotal))}${diff !== null ? `（${diff >= 0 ? '+' : ''}${diff}%）` : ''}</div>`;

  renderStatsBars(list, r);
  renderStatsPie(list, total);
  renderStatsFood(list);
}

function renderStatsBars(list, r) {
  const buckets = [];
  if (statsMode === 'year') {
    for (let i = 0; i < 12; i++) buckets.push({ label: `${i + 1}月`, short: String(i + 1), sum: 0, n: 0 });
    for (const e of list) { const b = buckets[parseYmd(e.date).getMonth()]; b.sum += e.amount; b.n++; }
  } else {
    const y = r.start.getFullYear(), m = r.start.getMonth();
    for (let d = 1; d <= daysInMonth(y, m); d++) buckets.push({ label: fmtDate(new Date(y, m, d)), short: String(d), sum: 0, n: 0 });
    for (const e of list) { const b = buckets[parseYmd(e.date).getDate() - 1]; b.sum += e.amount; b.n++; }
  }
  if (statsBarSel !== null && statsBarSel >= buckets.length) statsBarSel = null;

  const W = 320, H = 150, L = 34, B = 18, T = 8;
  const max = Math.max(...buckets.map((b) => b.sum), 0);
  const niceMax = max > 0 ? niceCeil(max) : 100;
  const step = (W - L) / buckets.length;
  const bw = Math.max(2, step - 2); // 2px 間隔
  const yOf = (v) => T + (H - T - B) * (1 - v / niceMax);
  const color = vizColor('#2a78d6');
  let svg = '';
  for (const g of [0.5, 1]) {
    const yy = yOf(niceMax * g);
    svg += `<line x1="${L}" x2="${W}" y1="${yy}" y2="${yy}" class="grid"/>
      <text x="${L - 4}" y="${yy + 3}" text-anchor="end" class="axis">${esc(shortNum(niceMax * g))}</text>`;
  }
  buckets.forEach((b, i) => {
    const x = L + i * step + (step - bw) / 2;
    if (b.sum > 0) {
      const y0 = yOf(0), y1 = yOf(b.sum);
      const h = y0 - y1, rr = Math.min(3, bw / 2, h);
      svg += `<path d="M${x},${y0} V${y1 + rr} Q${x},${y1} ${x + rr},${y1} H${x + bw - rr} Q${x + bw},${y1} ${x + bw},${y1 + rr} V${y0} Z"
        fill="${color}" opacity="${statsBarSel === null || statsBarSel === i ? 1 : 0.35}"/>`;
    }
    const showLabel = statsMode === 'year' || [1, 5, 10, 15, 20, 25].includes(i + 1) || i === buckets.length - 1;
    if (showLabel) svg += `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" class="axis">${esc(b.short)}</text>`;
    // 比長條寬的點擊區域
    svg += `<rect x="${L + i * step}" y="0" width="${step}" height="${H}" fill="transparent" data-bar="${i}"/>`;
  });
  svg += `<line x1="${L}" x2="${W}" y1="${yOf(0)}" y2="${yOf(0)}" class="baseline"/>`;
  document.getElementById('statsBars').innerHTML = svg;

  const sel = statsBarSel !== null ? buckets[statsBarSel] : null;
  const peak = buckets.reduce((a, b) => (b.sum > a.sum ? b : a), buckets[0]);
  document.getElementById('statsBarInfo').innerHTML = sel
    ? `<strong>${esc(sel.label)}</strong> ${esc(fmtTWD(sel.sum))} · ${sel.n} 筆`
    : max > 0 ? `最高：${esc(peak.label)} ${esc(fmtTWD(peak.sum))}（點長條看明細）` : '這段期間沒有支出';
}

function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}
function shortNum(v) { return v >= 10000 ? (v / 10000).toFixed(v % 10000 ? 1 : 0) + '萬' : fmtNum(v); }

function renderStatsPie(list, total) {
  const sums = {};
  for (const e of list) {
    const s = (sums[e.cat] = sums[e.cat] || { sum: 0, n: 0 });
    s.sum += e.amount; s.n++;
  }
  // 依分類固定順序排列（顏色跟著分類走，不跟排名）
  const order = [...state.expenseCats.map((c) => c.id), SUB_CAT.id];
  const rows = order.filter((id) => sums[id]).map((id) => ({ id, cat: catById(id), ...sums[id] }));
  if (statsPieSel && !sums[statsPieSel]) statsPieSel = null;

  const R = 50, C = 60, Wd = 16, circ = 2 * Math.PI * R;
  const gap = rows.length > 1 ? 2 : 0;
  let svg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="var(--line)" stroke-width="${Wd}"/>`;
  let off = 0;
  for (const r of rows) {
    const len = (r.sum / total) * circ;
    const vis = Math.max(0.5, len - gap);
    svg += `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${vizColor(r.cat.color)}" stroke-width="${statsPieSel === r.id ? Wd + 4 : Wd}"
      stroke-dasharray="${vis} ${circ - vis}" stroke-dashoffset="${-off}" transform="rotate(-90 ${C} ${C})"
      opacity="${!statsPieSel || statsPieSel === r.id ? 1 : 0.35}" data-pie="${esc(r.id)}" class="pie-seg"/>`;
    off += len;
  }
  const sel = rows.find((r) => r.id === statsPieSel);
  svg += `<text x="${C}" y="${C - 3}" text-anchor="middle" font-size="9" fill="var(--muted)">${esc(sel ? sel.cat.name : '合計')}</text>
    <text x="${C}" y="${C + 11}" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text)">${esc(fmtTWD(sel ? sel.sum : total))}</text>`;
  document.getElementById('statsPie').innerHTML = svg;

  const sorted = rows.slice().sort((a, b) => b.sum - a.sum);
  document.getElementById('statsLegend').innerHTML = sorted.length
    ? sorted.map((r) => `
      <li data-pie="${esc(r.id)}" class="${statsPieSel === r.id ? 'sel' : ''}">
        <span class="sw" style="background:${vizColor(r.cat.color)}"></span>${esc(r.cat.emoji)} ${esc(r.cat.name)}
        <span class="v">${Math.round((r.sum / total) * 100)}% · ${esc(fmtTWD(r.sum))}</span>
      </li>`).join('')
    : '<li class="hint">沒有資料</li>';
}

function renderStatsFood(list) {
  const food = list.filter((e) => e.cat === 'food');
  const box = document.getElementById('statsFood');
  if (!food.length) { box.innerHTML = '<p class="hint">這段期間沒有餐飲紀錄</p>'; return; }
  const agg = { meal: { sum: 0, n: 0 }, snack: { sum: 0, n: 0 } };
  for (const e of food) { agg[e.meal].sum += e.amount; agg[e.meal].n++; }
  const total = agg.meal.sum + agg.snack.sum;
  const pct = (k) => (agg[k].sum / total) * 100;

  const items = {};
  for (const e of food) {
    const name = e.item || '（未命名）';
    const k = e.meal + '|' + name;
    const it = (items[k] = items[k] || { name, meal: e.meal, sum: 0, n: 0 });
    it.sum += e.amount; it.n++;
  }
  const top = Object.values(items).sort((a, b) => b.n - a.n || b.sum - a.sum).slice(0, 6);

  box.innerHTML = `
    <div class="split-bar">
      ${['meal', 'snack'].filter((k) => agg[k].sum).map((k) => `<div style="flex:${pct(k)};background:${vizColor(MEAL_COLORS[k])}"></div>`).join('')}
    </div>
    <div class="split-legend">
      ${['meal', 'snack'].map((k) => `
        <div>
          <div><span class="sw" style="background:${vizColor(MEAL_COLORS[k])}"></span>${MEALS[k]} ${Math.round(pct(k))}%</div>
          <div class="mid">${esc(fmtTWD(agg[k].sum))}</div>
          <div class="hint">${agg[k].n} 筆 · 平均 ${esc(fmtTWD(agg[k].n ? agg[k].sum / agg[k].n : 0))}</div>
        </div>`).join('')}
    </div>
    <h3 class="top-title">最常吃</h3>
    <ol class="top-list">
      ${top.map((it) => `<li><span>${esc(it.name)} <span class="badge ${it.meal === 'snack' ? 'warn' : ''}">${MEALS[it.meal]}</span></span><span class="v">×${it.n} · ${esc(fmtTWD(it.sum))}</span></li>`).join('')}
    </ol>`;
}

/* ========== 記帳表單 ========== */
const expDlg = document.getElementById('expDialog');
const expForm = document.getElementById('expForm');

function openExpense(id, preset = {}) {
  const e = id ? state.expenses.find((x) => x.id === id) : null;
  if (id && !e) return;
  expEditingId = id || null;
  chipManage = false;
  autoFilledAmount = null;
  expDraft = { cat: e ? e.cat : preset.cat || 'food', meal: e ? e.meal || guessMeal() : guessMeal() };
  document.getElementById('expTitle').textContent = id ? '編輯支出' : '記一筆';
  document.getElementById('expDelete').hidden = !id;
  expForm.amount.value = e ? e.amount : '';
  expForm.item.value = e ? e.item : '';
  expForm.date.value = e ? e.date : ymd(today());
  expForm.note.value = e ? e.note : '';
  renderExpForm();
  expDlg.showModal();
  if (!id) setTimeout(() => expForm.amount.focus(), 50);
}

function renderExpForm() {
  document.getElementById('expCats').innerHTML = state.expenseCats.map((c) => `
    <button type="button" data-ecat="${esc(c.id)}" class="${expDraft.cat === c.id ? 'on' : ''}"
      style="--c:${vizColor(c.color)}"><span>${esc(c.emoji || '•')}</span>${esc(c.name)}</button>`).join('');
  const isFood = expDraft.cat === 'food';
  document.getElementById('expMealRow').hidden = !isFood;
  document.querySelectorAll('#expMeal button').forEach((b) => b.classList.toggle('on', b.dataset.meal === expDraft.meal));
  expForm.item.placeholder = isFood ? (expDraft.meal === 'meal' ? '例如：排骨便當' : '例如：珍奶') : '例如：捷運、衛生紙';
  renderChips();
}

function currentQuickItems() {
  const meal = expDraft.cat === 'food' ? expDraft.meal : null;
  return Object.entries(state.quickItems)
    .filter(([, q]) => q.cat === expDraft.cat && (q.meal || null) === meal)
    .sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last);
}

function renderChips() {
  const items = currentQuickItems();
  document.getElementById('itemsList').innerHTML = items.map(([, q]) => `<option value="${esc(q.item)}">`).join('');
  const box = document.getElementById('expChips');
  const head = document.getElementById('expChipsHead');
  head.hidden = !items.length;
  document.getElementById('chipManage').textContent = chipManage ? '完成' : '編輯';
  box.innerHTML = items.slice(0, 15).map(([k, q]) => `
    <button type="button" class="chip ${chipManage ? 'manage' : ''}" data-chip="${esc(k)}">
      ${esc(q.item)}${q.amount ? ` <small>$${esc(fmtNum(q.amount))}</small>` : ''}${chipManage ? ' <b>✕</b>' : ''}
    </button>`).join('');
}

function applyQuick(q) {
  expForm.item.value = q.item;
  const cur = expForm.amount.value;
  if (q.amount && (!cur || Number(cur) === autoFilledAmount)) {
    expForm.amount.value = q.amount;
    autoFilledAmount = q.amount;
  }
}

function rememberItem(e) {
  if (!e.item) return;
  const k = qKey(e.cat, e.meal, e.item);
  const q = state.quickItems[k] || { cat: e.cat, meal: e.meal, item: e.item, amount: 0, count: 0, last: 0 };
  q.amount = e.amount;
  q.count += 1;
  q.last = Date.now();
  state.quickItems[k] = q;
}

expForm.addEventListener('click', (ev) => {
  const cat = ev.target.closest('[data-ecat]');
  if (cat) { expDraft.cat = cat.dataset.ecat; chipManage = false; return renderExpForm(); }
  const meal = ev.target.closest('[data-meal]');
  if (meal) { expDraft.meal = meal.dataset.meal; chipManage = false; return renderExpForm(); }
  const chip = ev.target.closest('[data-chip]');
  if (chip) {
    const q = state.quickItems[chip.dataset.chip];
    if (!q) return;
    if (chipManage) {
      delete state.quickItems[chip.dataset.chip];
      save();
      return renderChips();
    }
    return applyQuick(q);
  }
  if (ev.target.id === 'chipManage') { chipManage = !chipManage; return renderChips(); }
});

expForm.item.addEventListener('change', () => {
  const meal = expDraft.cat === 'food' ? expDraft.meal : null;
  const q = state.quickItems[qKey(expDraft.cat, meal, expForm.item.value.trim())];
  if (q) applyQuick(q);
});

expForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const amount = Math.round(Number(expForm.amount.value) * 100) / 100;
  if (!(amount > 0)) { toast('請輸入金額'); return expForm.amount.focus(); }
  if (!isYmd(expForm.date.value)) { toast('請選擇日期'); return; }
  const data = {
    date: expForm.date.value,
    amount,
    cat: expDraft.cat,
    meal: expDraft.cat === 'food' ? expDraft.meal : null,
    item: expForm.item.value.trim().slice(0, 40),
    note: expForm.note.value.trim().slice(0, 100),
  };
  if (expEditingId) {
    const e = state.expenses.find((x) => x.id === expEditingId);
    const itemChanged = e.item !== data.item || e.cat !== data.cat || e.meal !== data.meal;
    Object.assign(e, data);
    if (itemChanged) rememberItem(e);
    else if (state.quickItems[qKey(e.cat, e.meal, e.item)]) state.quickItems[qKey(e.cat, e.meal, e.item)].amount = e.amount;
  } else {
    const e = { id: uid(), ...data };
    state.expenses.push(e);
    rememberItem(e);
  }
  save();
  expDlg.close();
  render();
  toast(`已記錄 ${fmtTWD(amount)}`);
});

document.getElementById('expCancel').addEventListener('click', () => expDlg.close());
document.getElementById('expDelete').addEventListener('click', () => {
  if (!confirm('確定刪除這筆支出？')) return;
  state.expenses = state.expenses.filter((x) => x.id !== expEditingId);
  save();
  expDlg.close();
  render();
  toast('已刪除');
});
expDlg.addEventListener('click', (e) => { if (e.target === expDlg) expDlg.close(); });

/* ========== 分類管理（設定頁） ========== */
function renderCatManager() {
  document.getElementById('catManager').innerHTML = state.expenseCats.map((c) => `
    <div class="cat-row" data-cid="${esc(c.id)}">
      <input class="cat-emoji" value="${esc(c.emoji)}" maxlength="4" aria-label="圖示">
      <input class="cat-name" value="${esc(c.name)}" maxlength="12" aria-label="名稱">
      <input class="cat-color" type="color" value="${esc(c.color)}" aria-label="顏色">
      ${FIXED_CATS.includes(c.id)
    ? `<span class="cat-del" title="${c.id === 'food' ? '餐飲分類有正餐／點心，不能刪除' : '預設分類不能刪除'}">🔒</span>`
    : `<button type="button" class="cat-del" data-catdel="${esc(c.id)}" aria-label="刪除">🗑</button>`}
    </div>`).join('');
}

document.getElementById('catManager').addEventListener('change', (ev) => {
  const row = ev.target.closest('[data-cid]');
  if (!row) return;
  const c = state.expenseCats.find((x) => x.id === row.dataset.cid);
  if (!c) return;
  if (ev.target.classList.contains('cat-name')) {
    const v = ev.target.value.trim();
    if (!v) { ev.target.value = c.name; return toast('名稱不能空白'); }
    c.name = v.slice(0, 12);
  } else if (ev.target.classList.contains('cat-emoji')) {
    c.emoji = [...ev.target.value.trim()].slice(0, 2).join('');
  } else if (ev.target.classList.contains('cat-color')) {
    c.color = ev.target.value.toLowerCase();
  }
  save();
  toast('分類已更新');
});

document.getElementById('catManager').addEventListener('click', (ev) => {
  const del = ev.target.closest('[data-catdel]');
  if (!del) return;
  const c = state.expenseCats.find((x) => x.id === del.dataset.catdel);
  const n = state.expenses.filter((e) => e.cat === c.id).length;
  if (!confirm(`刪除分類「${c.name}」？${n ? `\n其中 ${n} 筆支出會移到「其他」。` : ''}`)) return;
  state.expenses.forEach((e) => { if (e.cat === c.id) e.cat = 'other'; });
  for (const [k, q] of Object.entries(state.quickItems)) if (q.cat === c.id) delete state.quickItems[k];
  state.expenseCats = state.expenseCats.filter((x) => x.id !== c.id);
  save();
  renderCatManager();
  toast('已刪除分類');
});

document.getElementById('catAdd').addEventListener('click', () => {
  const name = prompt('新分類名稱（例如：寵物、教育）');
  if (!name || !name.trim()) return;
  state.expenseCats.splice(state.expenseCats.length - 1, 0, { id: 'c' + uid(), name: name.trim().slice(0, 12), emoji: '🏷️', color: NEW_CAT_COLOR });
  save();
  renderCatManager();
  toast('已新增分類');
});

/* ========== 事件 ========== */
document.addEventListener('click', (ev) => {
  const exp = ev.target.closest('[data-exp]');
  if (exp) return openExpense(exp.dataset.exp);
  if (ev.target.closest('[data-action="add-expense"]')) return openExpense(null);
  const lf = ev.target.closest('[data-lf]');
  if (lf) { ledgerFilter = lf.dataset.lf; return renderLedger(); }
  const sm = ev.target.closest('[data-sm]');
  if (sm) { statsMode = sm.dataset.sm; statsBarSel = null; statsPieSel = null; return renderStats(); }
  const bar = ev.target.closest('[data-bar]');
  if (bar) { const i = Number(bar.dataset.bar); statsBarSel = statsBarSel === i ? null : i; return renderStats(); }
  const pie = ev.target.closest('[data-pie]');
  if (pie) { statsPieSel = statsPieSel === pie.dataset.pie ? null : pie.dataset.pie; return renderStats(); }
});

function shiftMonth(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
document.getElementById('ledgerPrev').addEventListener('click', () => { ledgerCursor = shiftMonth(ledgerCursor, -1); renderLedger(); });
document.getElementById('ledgerNext').addEventListener('click', () => { ledgerCursor = shiftMonth(ledgerCursor, 1); renderLedger(); });
document.getElementById('statsPrev').addEventListener('click', () => {
  statsCursor = shiftMonth(statsCursor, statsMode === 'year' ? -12 : -1); statsBarSel = null; renderStats();
});
document.getElementById('statsNext').addEventListener('click', () => {
  statsCursor = shiftMonth(statsCursor, statsMode === 'year' ? 12 : 1); statsBarSel = null; renderStats();
});
document.getElementById('statsIncludeSubs').addEventListener('change', (e) => { statsIncludeSubs = e.target.checked; renderStats(); });
darkMQ.addEventListener('change', () => render());
