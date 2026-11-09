'use strict';
/* 禮券。與 app.js / ledger.js 共用 state / save / esc / toast / ymd 等全域函式。 */

const GIFT_PRESETS = [
  { name: '7-11 禮券', emoji: '🏪' },
  { name: '星巴克禮券', emoji: '☕' },
  { name: '全聯禮券', emoji: '🛒' },
  { name: '新光三越禮券', emoji: '🏬' },
  { name: '麥當勞點點卡', emoji: '🍟', unit: 'points' },
];
const EXPIRY_WARN_DAYS = 30;

let giftEditingId = null;
let giftDetailId = null;
let giftAction = null; // use | add | set
let showUsedUp = false;

/* ========== 資料 ========== */
function defaultGifts() { return { giftCards: [] }; }

function normalizeGifts(data) {
  if (!Array.isArray(data.giftCards)) return defaultGifts();
  const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
  return {
    giftCards: data.giftCards
      .filter((g) => g && typeof g.name === 'string' && g.name.trim())
      .map((g) => ({
        id: typeof g.id === 'string' && g.id ? g.id : uid(),
        name: g.name.trim().slice(0, 30),
        emoji: typeof g.emoji === 'string' ? [...g.emoji].slice(0, 2).join('') : '🎁',
        unit: g.unit === 'points' ? 'points' : 'money',
        denom: Math.max(0, money(g.denom)),
        expiry: isYmd(g.expiry) ? g.expiry : '',
        place: typeof g.place === 'string' ? g.place.slice(0, 40) : '',
        created: Number(g.created) || Date.now(),
        log: Array.isArray(g.log) ? g.log
          .filter((l) => l && isYmd(l.date) && Number.isFinite(Number(l.amount)))
          .map((l) => ({
            id: typeof l.id === 'string' && l.id ? l.id : uid(),
            date: l.date,
            amount: money(l.amount),
            kind: ['init', 'use', 'add', 'set'].includes(l.kind) ? l.kind : (Number(l.amount) < 0 ? 'use' : 'add'),
            note: typeof l.note === 'string' ? l.note.slice(0, 60) : '',
          })) : [],
      })),
  };
}

function giftBalance(g) { return Math.round(g.log.reduce((a, l) => a + l.amount, 0) * 100) / 100; }
/** 曾經有過的總額（初始＋加值），用來畫剩餘比例 */
function giftTotal(g) {
  return g.log.filter((l) => l.amount > 0).reduce((a, l) => a + l.amount, 0) || giftBalance(g);
}
function giftDaysLeft(g) { return g.expiry ? daysBetween(today(), parseYmd(g.expiry)) : null; }
function giftById(id) { return state.giftCards.find((g) => g.id === id); }
function isPoints(g) { return g.unit === 'points'; }
/** 依單位格式化：金額 NT$1,000、點數 1,000 點 */
function giftFmt(g, v) { return isPoints(g) ? `${fmtNum(v)} 點` : fmtTWD(v); }

function giftExpiryBadge(g) {
  const d = giftDaysLeft(g);
  if (d === null || giftBalance(g) <= 0) return '';
  if (d < 0) return '<span class="badge danger">已過期</span>';
  if (d <= EXPIRY_WARN_DAYS) return `<span class="badge warn">${d === 0 ? '今天到期' : d + ' 天後到期'}</span>`;
  return '';
}

function giftSubText(g) {
  const bal = giftBalance(g);
  const parts = [];
  if (g.denom && bal > 0 && !isPoints(g)) {
    const n = Math.floor(bal / g.denom);
    const rest = Math.round((bal - n * g.denom) * 100) / 100;
    parts.push(`剩 ${n} 張 × ${fmtNum(g.denom)}${rest ? ` + ${fmtNum(rest)}` : ''}`);
  }
  if (g.expiry) parts.push(`${g.expiry.replace(/-/g, '/')} 到期`);
  if (g.place) parts.push('📍' + g.place);
  return parts.join(' · ');
}

/* ========== 列表 ========== */
function giftItemHTML(g) {
  const bal = giftBalance(g);
  const total = giftTotal(g);
  const pct = total > 0 ? Math.max(0, Math.min(100, (bal / total) * 100)) : 0;
  return `
    <button class="item gift ${bal <= 0 ? 'cancelled' : ''}" data-gift="${esc(g.id)}">
      <span class="emoji gift-emoji">${esc(g.emoji || '🎁')}</span>
      <span class="main">
        <span class="name">${esc(g.name)}${giftExpiryBadge(g)}</span>
        <span class="sub">${esc(giftSubText(g) || (bal <= 0 ? '已用完' : ''))}</span>
        ${isPoints(g) ? '' : `<span class="mini-bar"><span style="width:${pct}%"></span></span>`}
      </span>
      <span class="right"><span class="amt">${esc(giftFmt(g, bal))}</span>
        ${isPoints(g) ? '' : `<span class="sub">共 ${esc(fmtNum(total))}</span>`}</span>
    </button>`;
}

function sortedGifts() {
  const big = 1e9;
  return state.giftCards.slice().sort((a, b) => {
    const da = giftDaysLeft(a), db = giftDaysLeft(b);
    return (da ?? big) - (db ?? big) || b.created - a.created;
  });
}

function renderGifts() {
  const active = sortedGifts().filter((g) => giftBalance(g) > 0);
  const usedUp = sortedGifts().filter((g) => giftBalance(g) <= 0);
  const total = active.filter((g) => !isPoints(g)).reduce((a, g) => a + giftBalance(g), 0);
  const pts = active.filter(isPoints);
  document.getElementById('giftTotal').innerHTML = `
    <div class="label">禮券總餘額</div>
    <div class="hero-num">${esc(fmtTWD(total))}</div>
    <div class="hint">${active.length} 張可用${usedUp.length ? ` · ${usedUp.length} 張已用完` : ''}${pts.length ? ` · 點數卡另計（${pts.map((g) => esc(g.name) + ' ' + esc(giftFmt(g, giftBalance(g)))).join('、')}）` : ''}</div>`;
  document.getElementById('giftList').innerHTML = active.length
    ? active.map(giftItemHTML).join('')
    : `<div class="empty">還沒有禮券<br><button class="btn" data-action="add-gift">＋ 新增禮券</button></div>`;
  document.getElementById('giftUsedUp').innerHTML = usedUp.length
    ? `<button class="link-btn" data-action="toggle-usedup">${showUsedUp ? '▾' : '▸'} 已用完（${usedUp.length}）</button>
       ${showUsedUp ? `<div class="list">${usedUp.map(giftItemHTML).join('')}</div>` : ''}`
    : '';
}

/** 首頁的禮券摘要 */
function renderHomeGifts() {
  const active = state.giftCards.filter((g) => giftBalance(g) > 0);
  const box = document.getElementById('homeGifts');
  if (!active.length) { box.innerHTML = ''; return; }
  const total = active.filter((g) => !isPoints(g)).reduce((a, g) => a + giftBalance(g), 0);
  const pts = active.filter(isPoints);
  const soon = active.filter((g) => { const d = giftDaysLeft(g); return d !== null && d <= EXPIRY_WARN_DAYS; })
    .sort((a, b) => giftDaysLeft(a) - giftDaysLeft(b));
  box.innerHTML = `
    <h2>禮券 <small>${active.length} 張</small></h2>
    <button class="card gift-summary" data-view-go="gifts">
      <span>🎁 總餘額</span><strong>${esc(fmtTWD(total))}</strong>
    </button>
    ${pts.map((g) => `<button class="card gift-summary" data-gift="${esc(g.id)}"><span>${esc(g.emoji)} ${esc(g.name)}</span><strong>${esc(giftFmt(g, giftBalance(g)))}</strong></button>`).join('')}
    ${soon.length ? `<div class="list">${soon.map(giftItemHTML).join('')}</div>` : ''}`;
}

/* ========== 新增 / 編輯 ========== */
const giftDlg = document.getElementById('giftDialog');
const giftForm = document.getElementById('giftForm');

function openGiftEdit(id) {
  const g = id ? giftById(id) : null;
  if (id && !g) return;
  giftEditingId = id || null;
  document.getElementById('giftEditTitle').textContent = g ? '編輯禮券' : '新增禮券';
  document.getElementById('giftPresets').hidden = !!g;
  document.getElementById('giftAmountRow').hidden = !!g;
  document.getElementById('giftCountWrap').hidden = !!g;
  document.getElementById('giftDelete').hidden = !g;
  giftForm.name.value = g ? g.name : '';
  giftForm.emoji.value = g ? g.emoji : '🎁';
  giftForm.unit.value = g ? g.unit : 'money';
  giftForm.amount.value = '';
  giftForm.count.value = '';
  giftForm.denom.value = g && g.denom ? g.denom : '';
  giftForm.expiry.value = g ? g.expiry : '';
  giftForm.place.value = g ? g.place : '';
  document.getElementById('giftPresets').innerHTML = GIFT_PRESETS.map((p, i) =>
    `<button type="button" class="chip" data-preset="${i}">${esc(p.emoji)} ${esc(p.name)}</button>`).join('');
  updateGiftPreview();
  giftDlg.showModal();
}

/** 輸入「面額 × 張數」時自動算總額 */
function updateGiftPreview() {
  const pointsMode = giftForm.unit.value === 'points';
  document.getElementById('giftDenomRow').hidden = pointsMode;
  document.getElementById('giftAmountLabel').firstChild.textContent = pointsMode ? '目前點數 ' : '總金額 ';
  const denom = Number(giftForm.denom.value) || 0;
  const count = parseInt(giftForm.count.value, 10) || 0;
  if (!giftEditingId && !pointsMode && denom && count) giftForm.amount.value = Math.round(denom * count * 100) / 100;
  const amt = Number(giftForm.amount.value) || 0;
  document.getElementById('giftPreview').textContent =
    !giftEditingId && amt ? `建立後餘額 ${pointsMode ? fmtNum(amt) + ' 點' : fmtTWD(amt)}` : '';
}

giftForm.addEventListener('input', (e) => { if (e.target.name !== 'amount') updateGiftPreview(); });
giftForm.addEventListener('click', (e) => {
  const p = e.target.closest('[data-preset]');
  if (!p) return;
  const preset = GIFT_PRESETS[Number(p.dataset.preset)];
  giftForm.name.value = preset.name;
  giftForm.emoji.value = preset.emoji;
  giftForm.unit.value = preset.unit || 'money';
  updateGiftPreview();
  (preset.unit === 'points' ? giftForm.amount : giftForm.denom).focus();
});

giftForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = giftForm.name.value.trim();
  if (!name) return giftForm.name.focus();
  const fields = {
    name: name.slice(0, 30),
    emoji: [...giftForm.emoji.value.trim()].slice(0, 2).join('') || '🎁',
    unit: giftForm.unit.value === 'points' ? 'points' : 'money',
    denom: giftForm.unit.value === 'points' ? 0 : Math.max(0, Number(giftForm.denom.value) || 0),
    expiry: isYmd(giftForm.expiry.value) ? giftForm.expiry.value : '',
    place: giftForm.place.value.trim().slice(0, 40),
  };
  if (giftEditingId) {
    Object.assign(giftById(giftEditingId), fields);
  } else {
    const amount = Math.round((Number(giftForm.amount.value) || 0) * 100) / 100;
    if (!(amount > 0)) { toast(fields.unit === 'points' ? '請輸入點數' : '請輸入金額'); return giftForm.amount.focus(); }
    state.giftCards.push({
      id: uid(), ...fields, created: Date.now(),
      log: [{ id: uid(), date: ymd(today()), amount, kind: 'init', note: '' }],
    });
  }
  save();
  giftDlg.close();
  if (giftDetailId) renderGiftDetail();
  render();
  toast('已儲存');
});
document.getElementById('giftCancel').addEventListener('click', () => giftDlg.close());
document.getElementById('giftDelete').addEventListener('click', () => {
  const g = giftById(giftEditingId);
  if (!g || !confirm(`確定刪除「${g.name}」和所有使用紀錄？`)) return;
  state.giftCards = state.giftCards.filter((x) => x.id !== g.id);
  save();
  giftDlg.close();
  if (giftDetailDlg.open) giftDetailDlg.close();
  render();
  toast('已刪除');
});
giftDlg.addEventListener('click', (e) => { if (e.target === giftDlg) giftDlg.close(); });

/* ========== 明細 / 使用 ========== */
const giftDetailDlg = document.getElementById('giftDetail');
const useForm = document.getElementById('giftUseForm');
const KIND_LABEL = { init: '建立', use: '使用', add: '加值', set: '調整餘額' };

function openGiftDetail(id) {
  if (!giftById(id)) return;
  giftDetailId = id;
  giftAction = null;
  renderGiftDetail();
  giftDetailDlg.showModal();
}

function renderGiftDetail() {
  const g = giftById(giftDetailId);
  if (!g) { giftDetailDlg.close(); return; }
  const bal = giftBalance(g);
  const total = giftTotal(g);
  const pct = total > 0 ? Math.max(0, Math.min(100, (bal / total) * 100)) : 0;
  document.getElementById('giftDetailHead').innerHTML = `
    <div class="gift-head">
      <span class="emoji gift-emoji big">${esc(g.emoji || '🎁')}</span>
      <div><h3>${esc(g.name)}${giftExpiryBadge(g)}</h3><div class="hint">${esc(giftSubText(g))}</div></div>
    </div>
    <div class="label">剩餘</div>
    <div class="hero-num">${esc(giftFmt(g, bal))}</div>
    ${isPoints(g) ? '' : `<div class="bar"><div style="width:${pct}%"></div></div>
    <div class="hint">已用 ${esc(fmtTWD(Math.max(0, total - bal)))} / 共 ${esc(fmtTWD(total))}</div>`}`;

  document.querySelectorAll('#giftActions [data-gact]').forEach((b) => b.classList.toggle('on', b.dataset.gact === giftAction));
  useForm.hidden = !giftAction;
  if (giftAction) {
    const label = isPoints(g)
      ? { use: '兌換用掉的點數', add: '新增的點數', set: '目前 App 裡顯示的點數' }[giftAction]
      : { use: '使用金額', add: '加值金額（例如又拿到新的券）', set: '目前實際剩下的金額' }[giftAction];
    document.getElementById('giftUseLabel').firstChild.textContent = label + ' ';
    const quick = [];
    if (giftAction === 'use' && g.denom) quick.push([g.denom, `1 張（${fmtNum(g.denom)}）`], [g.denom * 2, `2 張`]);
    if (giftAction === 'add' && g.denom) quick.push([g.denom, `1 張（${fmtNum(g.denom)}）`]);
    if (giftAction === 'use' && bal > 0 && !isPoints(g)) quick.push([bal, '全部用完']);
    document.getElementById('giftQuick').innerHTML = quick
      .map(([v, l]) => `<button type="button" class="chip" data-gquick="${v}">${esc(l)}</button>`).join('');
    document.getElementById('giftNoteRow').hidden = giftAction === 'set';
  }

  const log = g.log.slice().sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
  document.getElementById('giftLog').innerHTML = log.length ? log.map((l) => `
    <li>
      <span class="log-main">
        <span>${esc(KIND_LABEL[l.kind])}${l.note ? ' · ' + esc(l.note) : ''}</span>
        <span class="hint">${esc(fmtDate(parseYmd(l.date)))}</span>
      </span>
      <span class="log-amt ${l.amount < 0 ? 'neg' : 'pos'}">${l.amount < 0 ? '−' : '+'}${esc(fmtNum(Math.abs(l.amount)))}</span>
      ${l.kind === 'init' ? '' : `<button type="button" class="link-btn" data-glogdel="${esc(l.id)}" aria-label="刪除這筆紀錄">✕</button>`}
    </li>`).join('') : '<li class="hint">沒有紀錄</li>';
}

document.getElementById('giftActions').addEventListener('click', (e) => {
  const b = e.target.closest('[data-gact]');
  if (!b) return;
  giftAction = giftAction === b.dataset.gact ? null : b.dataset.gact;
  useForm.reset();
  useForm.date.value = ymd(today());
  if (giftAction === 'set') useForm.amount.value = giftBalance(giftById(giftDetailId));
  renderGiftDetail();
  if (giftAction) setTimeout(() => useForm.amount.focus(), 50);
});

useForm.addEventListener('click', (e) => {
  const q = e.target.closest('[data-gquick]');
  if (q) useForm.amount.value = q.dataset.gquick;
});

useForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const g = giftById(giftDetailId);
  const v = Math.round((Number(useForm.amount.value) || 0) * 100) / 100;
  const date = isYmd(useForm.date.value) ? useForm.date.value : ymd(today());
  const note = useForm.note.value.trim().slice(0, 60);
  const bal = giftBalance(g);
  let entry;
  if (giftAction === 'set') {
    if (v < 0 || useForm.amount.value === '') return toast('請輸入數字');
    const diff = Math.round((v - bal) * 100) / 100;
    if (!diff) { giftAction = null; return renderGiftDetail(); }
    entry = { amount: diff, kind: 'set', note: '' };
  } else {
    if (!(v > 0)) return toast('請輸入數字');
    if (giftAction === 'use' && v > bal && !confirm(`使用 ${giftFmt(g, v)} 超過剩餘的 ${giftFmt(g, bal)}，還是要記錄嗎？`)) return;
    entry = { amount: giftAction === 'use' ? -v : v, kind: giftAction, note };
  }
  g.log.push({ id: uid(), date, ...entry });
  save();
  const msg = giftAction === 'use' ? `已扣 ${giftFmt(g, v)}，剩 ${giftFmt(g, giftBalance(g))}` : `剩餘 ${giftFmt(g, giftBalance(g))}`;
  giftAction = null;
  renderGiftDetail();
  render();
  toast(msg);
});

document.getElementById('giftLog').addEventListener('click', (e) => {
  const b = e.target.closest('[data-glogdel]');
  if (!b) return;
  const g = giftById(giftDetailId);
  if (!confirm('刪除這筆紀錄？餘額會跟著還原。')) return;
  g.log = g.log.filter((l) => l.id !== b.dataset.glogdel);
  save();
  renderGiftDetail();
  render();
});

document.getElementById('giftEdit').addEventListener('click', () => openGiftEdit(giftDetailId));
document.getElementById('giftClose').addEventListener('click', () => giftDetailDlg.close());
giftDetailDlg.addEventListener('click', (e) => { if (e.target === giftDetailDlg) giftDetailDlg.close(); });
giftDetailDlg.addEventListener('close', () => { giftDetailId = null; giftAction = null; });

/* ========== 事件 ========== */
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-gift]');
  if (g) return openGiftDetail(g.dataset.gift);
  if (e.target.closest('[data-action="add-gift"]')) return openGiftEdit(null);
  if (e.target.closest('[data-action="toggle-usedup"]')) { showUsedUp = !showUsedUp; return renderGifts(); }
  const go = e.target.closest('[data-view-go]');
  if (go) return show(go.dataset.viewGo);
});
