'use strict';

/* ================= ExpenseStorage：LocalStorage 資料層 ================= */
const ExpenseStorage = (() => {
  const TX_KEY = 'ledger.transactions';
  const PREF_KEY = 'ledger.prefs';
  const DEFAULT_PREFS = { name: '你', currency: 'NT$', budget: 15000, theme: 'nordic' };

  const safeParse = (raw, fallback) => {
    try { const v = JSON.parse(raw); return v ?? fallback; } catch { return fallback; }
  };

  return {
    getTransactions() {
      const list = safeParse(localStorage.getItem(TX_KEY), []);
      return Array.isArray(list) ? list : [];
    },
    saveTransactions(list) { localStorage.setItem(TX_KEY, JSON.stringify(list)); },
    add(tx) { const l = this.getTransactions(); l.push(tx); this.saveTransactions(l); },
    remove(id) { this.saveTransactions(this.getTransactions().filter(t => t.id !== id)); },
    getPrefs() { return { ...DEFAULT_PREFS, ...safeParse(localStorage.getItem(PREF_KEY), {}) }; },
    savePrefs(p) { localStorage.setItem(PREF_KEY, JSON.stringify(p)); },
    exportAll() {
      return { app: 'minimal-ledger', version: 1, exportedAt: new Date().toISOString(),
        prefs: this.getPrefs(), transactions: this.getTransactions() };
    },
    importAll(data) {
      if (!data || !Array.isArray(data.transactions)) throw new Error('檔案格式不正確');
      const valid = data.transactions.filter(t =>
        t && typeof t.amount === 'number' && isFinite(t.amount) && typeof t.ts === 'number');
      valid.forEach(t => { t.id = t.id || uid(); t.desc = String(t.desc || '未命名'); t.tag = String(t.tag || '其他'); });
      this.saveTransactions(valid);
      if (data.prefs && typeof data.prefs === 'object') this.savePrefs({ ...DEFAULT_PREFS, ...data.prefs });
      return valid.length;
    },
  };
})();

/* ================= 工具 ================= */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const $ = sel => document.querySelector(sel);
const TAGS = ['伙食', '娛樂', '交通', '購物', '生活', '其他'];
const TAG_KEYWORDS = {
  伙食: ['早餐', '午餐', '晚餐', '宵夜', '便當', '飲料', '咖啡', '吃', '餐', '麵', '飯', '手搖', '點心', '超商'],
  娛樂: ['遊戲', '電影', 'steam', 'switch', '唱歌', 'ktv', '課金', '演唱會', 'netflix', '書'],
  交通: ['捷運', '公車', '高鐵', '台鐵', '計程車', 'uber', '加油', '停車', 'youbike', '油錢'],
  購物: ['買', '衣服', '鞋', '網購', '蝦皮', '包包', '3c'],
  生活: ['房租', '水費', '電費', '電話', '網路', '日用', '藥', '看醫生', '理髮'],
};
const PAYMENTS = ['街口', 'line pay', 'linepay', '現金', '信用卡', '悠遊卡', '一卡通', 'apple pay', '全支付', '台灣pay'];

/* ================= parseInput：自然語言解析 ================= */
function parseInput(text, forcedTag = null) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '請輸入內容，例如「午餐 120」' };

  // 取最後一個數字作為金額（支援 1,200 / 12.5 / $120 / 120元）
  const matches = [...raw.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g)];
  if (!matches.length) return { ok: false, error: '找不到金額，請加上數字（例：午餐 120）' };
  const m = matches[matches.length - 1];
  const amount = parseFloat(m[0].replace(/,/g, ''));
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: '金額需大於 0' };
  if (amount > 1e9) return { ok: false, error: '金額過大，請確認輸入' };

  let rest = (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length))
    .replace(/(NT\$|\$|元|塊)/gi, ' ');

  // 付款方式
  let payment = '';
  const lower = rest.toLowerCase();
  for (const p of PAYMENTS) {
    const i = lower.indexOf(p);
    if (i !== -1) { payment = rest.substr(i, p.length); rest = rest.slice(0, i) + rest.slice(i + p.length); break; }
  }

  // #標籤
  let tag = forcedTag;
  rest = rest.replace(/#(\S+)/g, (_, t) => { if (!tag) tag = t; return ' '; });

  const desc = rest.replace(/\s+/g, ' ').trim() || (tag || '未命名支出');
  if (!tag) {
    const d = desc.toLowerCase();
    tag = Object.keys(TAG_KEYWORDS).find(k => TAG_KEYWORDS[k].some(w => d.includes(w))) || '其他';
  }
  return { ok: true, amount: Math.round(amount * 100) / 100, desc: desc.slice(0, 60), tag, payment };
}

/* ================= 動態預算演算法 ================= */
function computeBudget(transactions, budget, now = new Date()) {
  const y = now.getFullYear(), mo = now.getMonth();
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const remainingDays = daysInMonth - now.getDate() + 1; // 含今天
  const startToday = new Date(y, mo, now.getDate()).getTime();

  const monthTx = transactions.filter(t => { const d = new Date(t.ts); return d.getFullYear() === y && d.getMonth() === mo; });
  const spent = monthTx.reduce((s, t) => s + t.amount, 0);
  const spentToday = monthTx.filter(t => t.ts >= startToday).reduce((s, t) => s + t.amount, 0);
  const spentBeforeToday = spent - spentToday;

  // 今日額度以「今天開始前」的剩餘預算平均分配，再扣除今日已花，避免越花額度越重算
  const dailyAllowance = (budget - spentBeforeToday) / remainingDays;
  const dailyLeft = dailyAllowance - spentToday;
  // 規格公式：(每月預算 - 本月總支出) / 剩餘天數
  const dailyBySpec = (budget - spent) / remainingDays;

  return { spent, spentToday, remaining: budget - spent, remainingDays, dailyAllowance, dailyLeft, dailyBySpec, monthTx };
}

/* ================= 機會成本趣味換算 ================= */
const OPPORTUNITY_THRESHOLD = 300;
const EQUIVALENTS = [
  { name: '份便當', price: 100 },
  { name: '杯手搖飲', price: 60 },
  { name: '款特價遊戲', price: 900 },
  { name: '次電影', price: 330 },
  { name: '個月串流訂閱', price: 390 },
];
function opportunityCost(amount) {
  if (amount < OPPORTUNITY_THRESHOLD) return '';
  const picks = [...EQUIVALENTS].sort(() => Math.random() - 0.5).slice(0, 2);
  return '💡 約等於 ' + picks.map(e => `${+(amount / e.price).toFixed(1)} ${e.name}`).join('，或 ');
}

/* ================= UI ================= */
const state = {
  prefs: ExpenseStorage.getPrefs(),
  selectedTag: null,
  view: 'dashboard',          // dashboard | history
  period: 'quarter',          // month | quarter | year
  anchor: (d => new Date(d.getFullYear(), d.getMonth(), 1))(new Date()),
  buckets: [],
};

const fmt = n => {
  const c = state.prefs.currency;
  const s = Math.round(n).toLocaleString('zh-TW');
  return /^[A-Za-z$]/.test(c) && !/^[A-Za-z]{2,}$/.test(c) ? `${c}${s}` : `${s} ${c}`;
};
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg; el.classList.toggle('err', isErr);
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.textContent = ''), 4500);
}

function render() {
  const { prefs } = state;
  document.documentElement.dataset.theme = prefs.theme;
  const h = new Date().getHours();
  $('#greeting').textContent = `${h < 11 ? '早安' : h < 18 ? '午安' : '晚安'}，${prefs.name}`;

  // 視圖切換
  $('#viewDashboard').hidden = state.view !== 'dashboard';
  $('#viewHistory').hidden = state.view !== 'history';
  document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  if (state.view === 'history') return renderHistory();

  const tx = ExpenseStorage.getTransactions();
  const b = computeBudget(tx, prefs.budget);

  const daily = $('#statDaily');
  daily.textContent = fmt(b.dailyLeft);
  daily.classList.toggle('neg', b.dailyLeft < 0);
  $('#statDailyHint').textContent = b.dailyLeft >= 0
    ? `今日額度 ${fmt(b.dailyAllowance)}・本月剩 ${b.remainingDays} 天`
    : `今天超出一點點，明天會自動重新分配 🌱`;
  $('#statBudget').textContent = fmt(prefs.budget);
  $('#statSpent').textContent = fmt(b.spent);

  const pct = prefs.budget > 0 ? (b.spent / prefs.budget) * 100 : (b.spent > 0 ? 100 : 0);
  const bar = $('#progressBar');
  bar.style.width = Math.min(pct, 100) + '%';
  bar.classList.toggle('over', pct > 100);
  $('#statRemain').textContent = `已用 ${pct.toFixed(1)}%・剩餘 ${fmt(b.remaining)}`;

  // 分類統計
  const byTag = {};
  b.monthTx.forEach(t => (byTag[t.tag] = (byTag[t.tag] || 0) + t.amount));
  const entries = Object.entries(byTag).sort((a, b2) => b2[1] - a[1]);
  $('#tagStats').innerHTML = entries.length
    ? entries.map(([k, v]) => `<li><span>${esc(k)}</span><span>${fmt(v)}</span></li>`).join('')
    : '<li class="empty">本月尚無紀錄</li>';

  // 今日明細
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const today = tx.filter(t => t.ts >= start).sort((a, c) => c.ts - a.ts);
  $('#todayTotal').textContent = today.length ? `共 ${fmt(b.spentToday)}` : '';
  $('#txList').innerHTML = today.length ? today.map(txItemHTML).join('') : '<li class="empty">今天還沒有花錢，很棒！✨</li>';
}

function txItemHTML(t) {
  const time = new Date(t.ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `<li data-id="${esc(t.id)}">
      <div class="tx-main"><div class="tx-desc">${esc(t.desc)}</div>
      <div class="tx-meta">${time}・${esc(t.tag)}${t.payment ? '・' + esc(t.payment) : ''}</div></div>
      <span class="tx-amt">${esc(fmt(t.amount))}</span>
      <button class="tx-del" aria-label="刪除">✕</button></li>`;
}

/* ================= 歷史帳本：期間計算、走勢圖、時間軸 ================= */
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function periodRange(period, anchor) {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  if (period === 'month') {
    const days = new Date(y, m + 1, 0).getDate();
    const buckets = Array.from({ length: days }, (_, i) => ({
      label: i === 0 || (i + 1) % 5 === 0 ? String(i + 1) : '',
      title: `${m + 1}/${i + 1}`, day: i + 1,
      start: new Date(y, m, i + 1).getTime(), end: new Date(y, m, i + 2).getTime(),
    }));
    return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1), label: `${y} 年 ${m + 1} 月`, buckets, monthly: false };
  }
  const sm = period === 'quarter' ? Math.floor(m / 3) * 3 : 0;
  const len = period === 'quarter' ? 3 : 12;
  const buckets = Array.from({ length: len }, (_, i) => ({
    label: `${sm + i + 1}月`, title: `${y}/${sm + i + 1}`, month: sm + i,
    start: new Date(y, sm + i, 1).getTime(), end: new Date(y, sm + i + 1, 1).getTime(),
  }));
  const label = period === 'quarter' ? `${y} 年 Q${sm / 3 + 1}（${sm + 1}–${sm + 3} 月）` : `${y} 年`;
  return { start: new Date(y, sm, 1), end: new Date(y, sm + len, 1), label, buckets, monthly: true };
}

function shiftPeriod(dir) {
  const step = { month: 1, quarter: 3, year: 12 }[state.period];
  const a = state.anchor;
  state.anchor = new Date(a.getFullYear(), a.getMonth() + dir * step, 1);
  renderHistory();
}

function renderHistory() {
  const r = periodRange(state.period, state.anchor);
  const now = Date.now(), s = r.start.getTime(), e = r.end.getTime();
  $('#periodLabel').textContent = r.label;
  $('#nextPeriod').disabled = e > now;
  document.querySelectorAll('#periodSeg button').forEach(b => b.classList.toggle('active', b.dataset.p === state.period));

  const q = $('#histSearch').value.trim().toLowerCase();
  const shown = ExpenseStorage.getTransactions()
    .filter(t => t.ts >= s && t.ts < e)
    .filter(t => !q || `${t.desc} ${t.tag} ${t.payment || ''}`.toLowerCase().includes(q))
    .sort((a, b) => b.ts - a.ts);

  // 摘要
  const total = shown.reduce((sum, t) => sum + t.amount, 0);
  const days = Math.max(1, Math.ceil((Math.min(e, now) - s) / 86400000));
  $('#histTotal').textContent = fmt(total);
  $('#histCount').textContent = `${shown.length} 筆`;
  $('#histAvg').textContent = fmt(total / days);

  // 走勢圖（月檢視 = 每日；季/年檢視 = 每月），並畫出預算參考線
  const sums = r.buckets.map(b => shown.filter(t => t.ts >= b.start && t.ts < b.end).reduce((sum, t) => sum + t.amount, 0));
  const budget = state.prefs.budget;
  const ref = r.monthly ? budget : budget / r.buckets.length;
  const showLine = budget > 0 && !q;
  const max = Math.max(...sums, showLine ? ref : 0, 1);
  state.buckets = r.buckets;
  $('#histChart').innerHTML = r.buckets.map((b, i) =>
    `<div class="bar" data-i="${i}" title="${esc(b.title + '：' + fmt(sums[i]))}">
       <div class="bar-fill${showLine && sums[i] > ref ? ' over' : ''}" style="height:${(sums[i] / max) * 100}%"></div>
       <span class="bar-label">${b.label}</span></div>`).join('')
    + (showLine ? `<div class="budget-line" style="bottom:calc(20px + ${(ref / max) * 160}px)"><span>${r.monthly ? '月預算' : '日均預算'}</span></div>` : '');

  // 分類統計
  const byTag = {};
  shown.forEach(t => (byTag[t.tag] = (byTag[t.tag] || 0) + t.amount));
  const entries = Object.entries(byTag).sort((a, b) => b[1] - a[1]);
  $('#histTags').innerHTML = entries.length
    ? entries.map(([k, v]) => `<li><span>${esc(k)}</span><span>${esc(fmt(v))}・${((v / total) * 100).toFixed(0)}%</span></li>`).join('')
    : '<li class="empty">無資料</li>';

  // 時間軸：依日分組，季/年檢視再加月份標頭
  const groups = new Map();
  for (const t of shown) {
    const d = new Date(t.ts);
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!groups.has(k)) groups.set(k, { date: d, items: [] });
    groups.get(k).items.push(t);
  }
  const parts = [];
  let lastMonth = '';
  for (const { date: d, items } of groups.values()) {
    const mk = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    if (r.monthly && mk !== lastMonth) { parts.push(`<li class="tl-month">${mk}</li>`); lastMonth = mk; }
    const sum = items.reduce((acc, t) => acc + t.amount, 0);
    parts.push(`<li class="tl-day" data-day="${d.getDate()}">
      <div class="tl-date"><span>${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）</span><span>${esc(fmt(sum))}</span></div>
      <ul class="tx-list">${items.map(txItemHTML).join('')}</ul></li>`);
  }
  $('#timeline').innerHTML = parts.join('') || `<li class="empty">${q ? '找不到符合的紀錄' : '這段期間沒有紀錄'}</li>`;
}

function renderQuickTags() {
  $('#quickTags').innerHTML = TAGS.map(t =>
    `<button type="button" class="chip${state.selectedTag === t ? ' active' : ''}" data-tag="${t}">${t}</button>`).join('');
}

function deleteTx(id) {
  ExpenseStorage.remove(id);
  render();
  toast('已刪除一筆紀錄');
}

/* ================= 事件綁定 ================= */
function bindEvents() {
  // 分頁切換
  $('#tabs').addEventListener('click', e => {
    const v = e.target.dataset?.view; if (!v || v === state.view) return;
    state.view = v; render(); window.scrollTo(0, 0);
  });

  // 歷史帳本
  $('#periodSeg').addEventListener('click', e => {
    const p = e.target.dataset?.p; if (!p) return;
    state.period = p; renderHistory();
  });
  $('#prevPeriod').addEventListener('click', () => shiftPeriod(-1));
  $('#nextPeriod').addEventListener('click', () => shiftPeriod(1));
  $('#histSearch').addEventListener('input', renderHistory);
  $('#histChart').addEventListener('click', e => {
    const bar = e.target.closest('.bar'); if (!bar) return;
    const b = state.buckets[+bar.dataset.i];
    if (b.month !== undefined) {           // 季/年 → 鑽取到該月
      state.period = 'month';
      state.anchor = new Date(state.anchor.getFullYear(), b.month, 1);
      renderHistory();
    } else {                                // 月 → 捲動到時間軸該日
      const el = $(`#timeline .tl-day[data-day="${b.day}"]`); if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
  });
  $('#timeline').addEventListener('click', e => {
    if (!e.target.classList.contains('tx-del')) return;
    if (confirm('確定要刪除這筆紀錄嗎？')) deleteTx(e.target.closest('li').dataset.id);
  });
  $('#inputForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#mainInput');
    const r = parseInput(input.value, state.selectedTag);
    if (!r.ok) return toast(r.error, true);
    ExpenseStorage.add({ id: uid(), ts: Date.now(), amount: r.amount, desc: r.desc, tag: r.tag, payment: r.payment });
    input.value = '';
    state.selectedTag = null; renderQuickTags();
    render();
    toast(opportunityCost(r.amount) || `✔ 已記錄：${r.desc} ${fmt(r.amount)}（${r.tag}）`);
  });

  $('#quickTags').addEventListener('click', e => {
    const tag = e.target.dataset?.tag; if (!tag) return;
    state.selectedTag = state.selectedTag === tag ? null : tag;
    renderQuickTags(); $('#mainInput').focus();
  });

  // 按鈕刪除
  const list = $('#txList');
  list.addEventListener('click', e => {
    if (!e.target.classList.contains('tx-del')) return;
    deleteTx(e.target.closest('li').dataset.id);
  });

  // 左滑刪除（觸控）
  let sx = 0, sy = 0, li = null;
  list.addEventListener('touchstart', e => {
    li = e.target.closest('li[data-id]'); if (!li) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  list.addEventListener('touchmove', e => {
    if (!li) return;
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    if (Math.abs(dx) > Math.abs(dy) && dx < 0) li.style.transform = `translateX(${Math.max(dx, -120)}px)`;
  }, { passive: true });
  list.addEventListener('touchend', e => {
    if (!li) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (dx < -90) { li.style.opacity = '0'; const id = li.dataset.id; setTimeout(() => deleteTx(id), 180); }
    else li.style.transform = '';
    li = null;
  });

  // 設定面板
  const dlg = $('#settingsDialog');
  $('#btnSettings').addEventListener('click', () => {
    const p = state.prefs;
    $('#setName').value = p.name; $('#setCurrency').value = p.currency;
    $('#setBudget').value = p.budget; $('#setTheme').value = p.theme;
    dlg.showModal();
  });
  $('#setTheme').addEventListener('change', e => (document.documentElement.dataset.theme = e.target.value)); // 即時預覽
  dlg.addEventListener('close', () => {
    if (dlg.returnValue === 'save') {
      const budget = parseFloat($('#setBudget').value);
      state.prefs = {
        name: $('#setName').value.trim() || '你',
        currency: $('#setCurrency').value.trim() || 'NT$',
        budget: isFinite(budget) && budget >= 0 ? budget : state.prefs.budget,
        theme: $('#setTheme').value,
      };
      ExpenseStorage.savePrefs(state.prefs);
      toast('設定已儲存');
    }
    render();
  });

  // 匯出
  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(ExpenseStorage.exportAll(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `記帳備份_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // 匯入
  $('#btnImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const n = ExpenseStorage.importAll(JSON.parse(reader.result));
        state.prefs = ExpenseStorage.getPrefs();
        dlg.close(); render();
        toast(`匯入成功，共 ${n} 筆紀錄`);
      } catch (err) { alert('匯入失敗：' + err.message); }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
}

/* ================= 啟動 ================= */
renderQuickTags();
bindEvents();
render();
// 跨日自動更新
setInterval(render, 60 * 1000);
