/**
 * WorkBuddy Web Monitor — 前端逻辑
 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  sessions: [],
  summary: null,
  filter: 'all',
  sort: 'activity',
  search: '',
  expanded: new Set(),   // 展开的 sessionId
  details: new Map(),    // sessionId -> detail 数据
  autoRefresh: true,
  nextRefreshAt: 0,
  unit: localStorage.getItem('wb-unit') || 'metric', // 'metric' = k/M, 'cn' = 万/亿
  pricing: null,         // /api/pricing 返回的定价表
};

const CONTEXT_REF = 200000; // 上下文占用条参考上限

/* ---------------- 格式化 ---------------- */

/** token 数格式化：87.2k / 1595.7k / 1.43M（k 上限 9999.9k）
 *  中文单位模式（万/亿）：1.16 亿 / 777.5 万 */
function fmtK(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  if (state.unit === 'cn') {
    if (n < 1e4) return String(Math.round(n));
    if (n < 1e8) return (n / 1e4).toFixed(1) + '万';
    return (n / 1e8).toFixed(2) + '亿';
  }
  if (n < 1000) return String(Math.round(n));
  if (n < 1e7) return (n / 1e3).toFixed(1) + 'k';
  return (n / 1e6).toFixed(2) + 'M';
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  return Math.round(n).toLocaleString('en-US');
}

function relTime(ts) {
  if (!ts) return '–';
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时 ${min % 60} 分前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

function fmtTime(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtSpeed(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return `~${v >= 100 ? Math.round(v) : v.toFixed(1)} tok/s`;
}

/** 积分格式化：去尾零，保留 1~2 位小数 */
function fmtCredit(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const v = Math.round(n * 100) / 100;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** 金额格式化：¥12.34 / ¥0.043 */
function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const v = n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
  return '¥' + v;
}

/* ---------------- 费用估算 ---------------- */

/** 模型定价查询（大小写不敏感） */
function priceFor(model) {
  if (!model || !state.pricing || !state.pricing.prices) return null;
  return state.pricing.prices[String(model).toLowerCase()] || null;
}

/** 单条请求费用（元）；未定价模型返回 null */
function eventCost(ev) {
  const p = priceFor(ev.model);
  if (!p) return null;
  const missInput = Math.max(0, (ev.input || 0) - (ev.cached || 0));
  return missInput / 1e6 * p.input + (ev.cached || 0) / 1e6 * (p.cached ?? p.input) + (ev.output || 0) / 1e6 * p.output;
}

/**
 * 按模型的 token 分布计算费用。
 * 返回 {total, in, cache, out, partial, models[]}；完全无定价模型时返回 null。
 * partial=true 表示还有未定价模型的用量未计入（显示时追加 "+"）。
 */
function costBreakdown(modelsMap) {
  if (!modelsMap) return null;
  let acc = null;
  let unpricedRequests = 0;
  for (const [m, info] of Object.entries(modelsMap)) {
    const p = priceFor(m);
    if (!p) { unpricedRequests += info.requests || 0; continue; }
    const missInput = Math.max(0, (info.input || 0) - (info.cached || 0));
    const cIn = missInput / 1e6 * p.input;
    const cCache = (info.cached || 0) / 1e6 * (p.cached ?? p.input);
    const cOut = (info.output || 0) / 1e6 * p.output;
    acc = acc || { total: 0, in: 0, cache: 0, out: 0, partial: false, models: [] };
    acc.total += cIn + cCache + cOut;
    acc.in += cIn;
    acc.cache += cCache;
    acc.out += cOut;
    acc.models.push(`${m}：输入 ${p.input} · 缓存命中 ${p.cached ?? '—'} · 输出 ${p.output} 元/百万tokens`);
  }
  if (!acc) return null;
  if (unpricedRequests > 0) acc.partial = true;
  return acc;
}

/** 汇总多组费用（全局卡片用） */
function sumCosts(sessions, field) {
  let acc = null;
  for (const s of sessions) {
    const c = costBreakdown(s[field]);
    if (!c) continue;
    acc = acc || { total: 0, in: 0, cache: 0, out: 0, partial: false, models: [] };
    acc.total += c.total;
    acc.in += c.in;
    acc.cache += c.cache;
    acc.out += c.out;
    if (c.partial) acc.partial = true;
    for (const line of c.models) if (!acc.models.includes(line)) acc.models.push(line);
  }
  return acc;
}

/** 费用 tooltip 文本（显示各模型单价） */
function costTooltip(cost) {
  const lines = ['定价（元/百万 tokens）:', ...cost.models];
  if (state.pricing && state.pricing.source) lines.push('', `来源: ${state.pricing.source}`);
  if (cost.partial) lines.push('', '注意: 还有未收录定价的模型用量未计入（标 + 号）');
  lines.push('', '费用为按 token 用量的预估值，仅供参考');
  return lines.join('\n');
}

/** 模型名 -> 稳定颜色 */
const MODEL_COLORS = ['#58a6ff', '#3fb950', '#bc8cff', '#db6d28', '#39c5cf', '#d29922', '#f85149', '#79c0ff'];
const modelColorMap = new Map();
function modelColor(name) {
  if (!modelColorMap.has(name)) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    modelColorMap.set(name, MODEL_COLORS[h % MODEL_COLORS.length]);
  }
  return modelColorMap.get(name);
}

function tildePath(p) {
  if (!p) return '(未知路径)';
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function ctxClass(tokens) {
  if (tokens >= 180000) return 'crit';
  if (tokens >= 150000) return 'high';
  if (tokens >= 100000) return 'mid';
  return 'ok';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 数据获取 ---------------- */

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  try {
    const [sessionsRes, summaryRes, pricingRes] = await Promise.all([
      fetchJSON('/api/sessions'),
      fetchJSON('/api/summary'),
      fetchJSON('/api/pricing'),
    ]);
    state.sessions = sessionsRes.sessions || [];
    state.summary = summaryRes.summary;
    state.pricing = pricingRes.pricing;
    $('#scan-error').classList.toggle('hidden', !sessionsRes.scanError);
    if (sessionsRes.scanError) $('#scan-error').textContent = '扫描错误: ' + sessionsRes.scanError;
    $('#wb-home').textContent = sessionsRes.wbHome || '';
    $('#wb-home').title = 'WorkBuddy 数据目录: ' + (sessionsRes.wbHome || '');
    render();
    setStatus('ok');
  } catch (e) {
    console.error(e);
    setStatus('err', e.message);
  }
  state.nextRefreshAt = Date.now() + 5000;
}

function setStatus(kind, msg) {
  const el = $('#refresh-status');
  if (kind === 'ok') el.textContent = `已更新 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  else if (kind === 'err') { el.textContent = '刷新失败'; el.title = msg || ''; }
  else el.textContent = '…';
}

async function loadDetail(sessionId) {
  try {
    const data = await fetchJSON(`/api/sessions/${sessionId}/detail`);
    if (data.ok) {
      state.details.set(sessionId, data.session);
      render();
    }
  } catch (e) {
    console.error(e);
  }
}

/* ---------------- 过滤与排序 ---------------- */

function visibleSessions() {
  const now = Date.now();
  let list = state.sessions.slice();
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter((s) =>
      (s.cwd || '').toLowerCase().includes(q) ||
      (s.title || '').toLowerCase().includes(q) ||
      (s.model || '').toLowerCase().includes(q) ||
      Object.keys(s.models || {}).some((m) => m.toLowerCase().includes(q))
    );
  }
  switch (state.filter) {
    case 'active': list = list.filter((s) => now - s.lastTs < 10 * 60 * 1000); break;
    case '24h': list = list.filter((s) => now - s.lastTs < 24 * 3600 * 1000); break;
    case 'today': {
      const d = new Date(); d.setHours(0, 0, 0, 0);
      list = list.filter((s) => s.lastTs >= d.getTime());
      break;
    }
  }
  const sorters = {
    activity: (a, b) => b.lastTs - a.lastTs,
    output: (a, b) => b.output - a.output,
    input: (a, b) => b.input - a.input,
    requests: (a, b) => b.requests - a.requests,
    context: (a, b) => b.context - a.context,
  };
  list.sort(sorters[state.sort] || sorters.activity);
  return list;
}

/* ---------------- 渲染 ---------------- */

function render() {
  renderSummary();
  renderModelDist();
  renderSessions();
}

function renderSummary() {
  const s = state.summary;
  const el = $('#summary-cards');
  if (!s) { el.innerHTML = ''; return; }
  const todayCost = sumCosts(state.sessions, 'todayModels');
  const totalCost = sumCosts(state.sessions, 'models');
  const cards = [
    { label: '今日 API 请求', value: fmtInt(s.today.requests), cls: 'accent', sub: `输出 ${fmtK(s.today.output)}` },
    { label: '今日消耗积分', value: fmtCredit(s.today.credit), cls: 'orange', sub: `累计 ${fmtCredit(s.total.credit)}` },
  ];
  if (todayCost && todayCost.total > 0) {
    cards.push({
      label: '今日预估费用',
      value: fmtMoney(todayCost.total) + (todayCost.partial ? '+' : ''),
      cls: 'green',
      sub: `累计 ${fmtMoney(totalCost ? totalCost.total : 0)}${totalCost && totalCost.partial ? '+' : ''}`,
    });
  }
  cards.push(
    { label: '今日输入 tokens', value: fmtK(s.today.input), cls: 'cyan', sub: `缓存命中 ${fmtK(s.today.cached)}` },
    { label: '今日输出 tokens', value: fmtK(s.today.output), cls: 'green', sub: `推理 ${fmtInt(s.today.reasoning)}` },
    { label: '活跃会话 (10min)', value: String(s.activeSessions), cls: 'yellow', sub: `24h 内 ${s.sessions24h} 个` },
    { label: '累计请求', value: fmtInt(s.total.requests), cls: 'purple', sub: `共 ${s.sessions} 个会话` },
    { label: '累计输入 tokens', value: fmtK(s.total.input), cls: 'cyan', sub: `输出 ${fmtK(s.total.output)}` },
  );
  el.innerHTML = cards.map((c) => `
    <div class="sum-card ${c.cls}">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');
}

function renderModelDist() {
  const el = $('#model-dist');
  const s = state.summary;
  if (!s || !Object.keys(s.models).length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const arr = Object.entries(s.models).sort((a, b) => b[1].requests - a[1].requests);
  const max = arr[0][1].requests || 1;
  el.innerHTML = arr.slice(0, 8).map(([name, info]) => {
    const pct = Math.max(1.5, (info.requests / max) * 100);
    const color = modelColor(name);
    return `
    <div class="model-row">
      <span class="model-name" title="${esc(name)}">${esc(name)}</span>
      <div class="model-bar-track"><div class="model-bar" style="width:${pct}%;background:${color}"></div></div>
      <span class="model-count">${fmtInt(info.requests)} 次 · ${info.sessions} 会话</span>
    </div>`;
  }).join('');
}

function sessionCard(s) {
  const path = tildePath(s.cwd);
  const live = Date.now() - s.lastTs < 5 * 60 * 1000;
  const recent = !live && Date.now() - s.lastTs < 60 * 60 * 1000;
  const expanded = state.expanded.has(s.sessionId);
  const speed = fmtSpeed(s.lastSpeed);

  const ctxCls = ctxClass(s.context);
  const ctxPct = Math.min(100, (s.context / CONTEXT_REF) * 100);
  const ctxSpanCls = s.context >= 180000 ? 'ctx-crit' : s.context >= 150000 ? 'ctx-high' : s.context >= 100000 ? 'ctx-mid' : '';

  const cost = costBreakdown(s.models);
  const todayCost = costBreakdown(s.todayModels);
  const costRow = cost ? `
      <div class="stat-row"><span class="stat-label">预估费用</span><span class="stat-value"><span class="cost">${fmtMoney(cost.total)}${cost.partial ? '+' : ''}</span>${todayCost && todayCost.total > 0 ? ` <span class="dim">(今日 ${fmtMoney(todayCost.total)})</span>` : ''} <span class="dim">(输入 ${fmtMoney(cost.in)} / 缓存 ${fmtMoney(cost.cache)} / 输出 ${fmtMoney(cost.out)})</span><span class="cost-tip" title="${esc(costTooltip(cost))}">!</span></span></div>` : '';

  return `
  <div class="session-card ${expanded ? 'expanded' : ''}" data-sid="${esc(s.sessionId)}">
    <div class="card-head" data-action="toggle">
      <div class="card-title-group">
        <div class="session-path"><span class="tilde">会话:</span> ${esc(path)}</div>
        ${s.title ? `<div class="session-title">${esc(s.title)}</div>` : ''}
      </div>
      <div class="card-meta">
        <div class="last-activity ${live ? 'live' : recent ? 'recent' : ''}">
          ${live ? '● ' : ''}最后活动 ${relTime(s.lastTs)}
        </div>
        ${s.model ? `<span class="model-badge">${esc(s.model)}</span>` : ''}
      </div>
    </div>
    <div class="card-stats">
      <div class="stat-row"><span class="stat-label">模型</span><span class="stat-value">${esc(s.model || '–')}${Object.keys(s.models).length > 1 ? ` <span class="dim">(${Object.keys(s.models).length} 个模型)</span>` : ''}</span></div>
      <div class="stat-row"><span class="stat-label">上下文占用</span><span class="stat-value ${ctxSpanCls}">${fmtK(s.context)} tokens</span></div>
      <div class="stat-row"><span class="stat-label">累计输入</span><span class="stat-value"><span class="in">${fmtK(s.input)}</span> <span class="dim">(缓存命中 ${fmtK(s.cached)})</span></span></div>
      <div class="stat-row"><span class="stat-label">累计输出</span><span class="stat-value"><span class="out">${fmtK(s.output)}</span> <span class="dim">(推理 ${fmtInt(s.reasoning)})</span></span></div>
      <div class="stat-row"><span class="stat-label">API 请求</span><span class="stat-value">${fmtInt(s.requests)} 次</span></div>
      <div class="stat-row"><span class="stat-label">积分消耗</span><span class="stat-value">${fmtCredit(s.credit)}${s.todayCredit ? ` <span class="dim">(今日 ${fmtCredit(s.todayCredit)})</span>` : ''}</span></div>
      ${costRow}
      <div class="stat-row"><span class="stat-label">最近速度</span><span class="stat-value"><span class="speed">${speed || '–'}</span> <span class="dim">(含工具执行时间, 保守值)</span></span></div>
    </div>
    <div class="ctx-bar-track" title="上下文占用，参考上限 ${fmtK(CONTEXT_REF)}">
      <div class="ctx-bar ${ctxCls}" style="width:${s.hasUsage ? ctxPct : 0}%"></div>
    </div>
    ${expanded ? renderDetail(s) : ''}
  </div>`;
}

function renderDetail(s) {
  const d = state.details.get(s.sessionId);
  if (!d) return `<div class="card-detail"><div class="empty">加载详情中…</div></div>`;

  const hist = (d.history || []).map((h, i, arr) => {
    const prev = i + 1 < arr.length ? arr[i + 1] : null;
    let speed = '–';
    if (prev) {
      const dur = (h.ts - prev.ts) / 1000;
      if (dur > 0 && dur <= 300 && h.output > 0) speed = '~' + (h.output / dur >= 100 ? Math.round(h.output / dur) : (h.output / dur).toFixed(1));
    } else if (h.output > 0) {
      speed = `~${fmtK(h.output)} out`;
    }
    const c = eventCost(h);
    const costStr = c != null ? fmtMoney(c) : '–';
    return `
    <tr>
      <td>${fmtTime(h.ts)}</td>
      <td>${esc(h.model || '–')}</td>
      <td>${fmtK(h.input)}</td>
      <td>${fmtK(h.cached)}</td>
      <td>${fmtK(h.output)}</td>
      <td>${fmtInt(h.reasoning)}</td>
      <td>${h.credit ? fmtCredit(h.credit) : '0'}</td>
      <td>${costStr}</td>
      <td>${speed}</td>
    </tr>`;
  }).join('');

  const multiModel = Object.keys(s.models || {}).length > 1
    ? Object.entries(s.models).sort((a, b) => b[1].requests - a[1].requests).map(([m, info]) => `${esc(m)} ×${info.requests}`).join(' · ')
    : '';

  const cost = costBreakdown(s.models);

  return `
  <div class="card-detail">
    <div class="detail-meta">
      <div><b>会话 ID:</b> <span class="v">${esc(s.sessionId)}</span></div>
      <div><b>工作目录:</b> <span class="v">${esc(s.cwd || '–')}</span></div>
      <div><b>开始时间:</b> <span class="v">${fmtTime(s.firstTs)}</span></div>
      <div><b>转录文件:</b> <span class="v">${esc(s.file || '–')}</span></div>
      ${multiModel ? `<div><b>模型使用:</b> <span class="v">${multiModel}</span></div>` : ''}
      ${cost ? `<div><b>预估费用:</b> <span class="v">${fmtMoney(cost.total)}${cost.partial ? '+' : ''} (输入 ${fmtMoney(cost.in)} / 缓存 ${fmtMoney(cost.cache)} / 输出 ${fmtMoney(cost.out)})</span></div>` : ''}
      ${s.recentSpeed ? `<div><b>近 5 次速度:</b> <span class="v">${fmtSpeed(s.recentSpeed)}</span></div>` : ''}
      ${s.avgSpeed ? `<div><b>平均速度:</b> <span class="v">${fmtSpeed(s.avgSpeed)}</span></div>` : ''}
    </div>
    <div class="hist-title">最近请求历史（新 → 旧，最多 300 条；速度按相邻请求间隔估算，>5min 间隔不计）</div>
    <div class="hist-scroll">
      <table class="history">
        <thead><tr><th>时间</th><th>模型</th><th>输入</th><th>缓存</th><th>输出</th><th>推理</th><th>积分</th><th>费用</th><th>速度</th></tr></thead>
        <tbody>${hist || '<tr><td colspan="9" style="text-align:center">无数据</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;
}

function renderSessions() {
  const list = visibleSessions();
  $('#list-empty').classList.toggle('hidden', list.length > 0);
  $('#session-list').innerHTML = list.map(sessionCard).join('');
}

/* ---------------- 事件绑定 ---------------- */

$('#session-list').addEventListener('click', (e) => {
  const head = e.target.closest('[data-action="toggle"]');
  if (!head) return;
  const card = head.closest('.session-card');
  const sid = card.dataset.sid;
  if (state.expanded.has(sid)) {
    state.expanded.delete(sid);
    render();
  } else {
    state.expanded.add(sid);
    render();
    if (!state.details.has(sid)) loadDetail(sid);
  }
});

$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderSessions(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderSessions(); });

$('#filters').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('active', b === btn));
  renderSessions();
});

$('#auto-refresh').addEventListener('change', (e) => { state.autoRefresh = e.target.checked; });

$('#unit-toggle').addEventListener('click', () => {
  state.unit = state.unit === 'cn' ? 'metric' : 'cn';
  localStorage.setItem('wb-unit', state.unit);
  $('#unit-toggle').textContent = state.unit === 'cn' ? '万/亿' : 'k/M';
  render();
});
$('#unit-toggle').textContent = state.unit === 'cn' ? '万/亿' : 'k/M';

/* ---------------- 启动 ---------------- */

refresh();
setInterval(() => {
  // 倒计时显示
  const remain = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  if (state.autoRefresh && remain > 0) $('#refresh-status').textContent = `${remain}s 后刷新`;
}, 500);

setInterval(() => {
  if (!state.autoRefresh) return;
  refresh();
  // 已展开的详情随刷新更新
  for (const sid of state.expanded) loadDetail(sid);
}, 5000);
