/**
 * WorkBuddy Web Monitor — 零依赖 Node.js HTTP 服务
 *
 * API:
 *   GET /api/summary               全局汇总（今日 tokens、活跃会话、模型分布）
 *   GET /api/sessions              会话列表（按最后活动排序）
 *   GET /api/sessions/:id/detail   单会话详情（含最近 300 条请求历史）
 *
 * 环境变量:
 *   PORT        监听端口（默认 3456）
 *   HOST        监听地址（默认 0.0.0.0）
 *   WB_HOME     WorkBuddy 数据目录（默认 ~/.workbuddy，容器内为 /data/workbuddy）
 *   AUTH_TOKEN  可选访问令牌；设置后所有请求需带 ?token= 或 Authorization: Bearer
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Scanner, beijingMidnight } = require('./lib/scanner.js');

const PORT = parseInt(process.env.PORT || '3456', 10);
const HOST = process.env.HOST || '0.0.0.0';
const WB_HOME = process.env.WB_HOME || path.join(os.homedir(), '.workbuddy');
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRICING_FILE = process.env.PRICING_FILE || path.join(__dirname, 'pricing.json');
const SCAN_INTERVAL_MS = 2000; // API 请求触发的扫描最小间隔（增量扫描本身有缓存，很便宜）

const scanner = new Scanner(WB_HOME);

/** 读取定价表（每次请求现读，支持不重启热更新） */
function readPricing() {
  try {
    return JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
  } catch (e) {
    return { source: null, currency: 'CNY', prices: {}, error: `读取 ${PRICING_FILE} 失败: ${e.message}` };
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function checkAuth(req, url) {
  if (!AUTH_TOKEN) return true;
  const q = url.searchParams.get('token');
  if (q === AUTH_TOKEN) return true;
  const h = req.headers['authorization'] || '';
  return h === `Bearer ${AUTH_TOKEN}`;
}

/** 全局汇总 */
function buildSummary(list) {
  const todayStart = beijingMidnight(Date.now());
  const now = Date.now();
  const ACTIVE_MS = 10 * 60 * 1000;

  const agg = {
    sessions: list.length,
    activeSessions: 0,      // 10 分钟内有活动
    sessions24h: 0,
    today: { requests: 0, input: 0, output: 0, cached: 0, reasoning: 0, credit: 0 },
    total: { requests: 0, input: 0, output: 0, cached: 0, reasoning: 0, credit: 0 },
    models: {},             // model -> {requests, input, output}
  };

  for (const s of list) {
    if (now - s.lastTs < ACTIVE_MS) agg.activeSessions++;
    if (now - s.lastTs < 24 * 3600 * 1000) agg.sessions24h++;
    agg.total.requests += s.requests;
    agg.total.input += s.input;
    agg.total.output += s.output;
    agg.total.cached += s.cached;
    agg.total.reasoning += s.reasoning;
    agg.total.credit += s.credit || 0;
    agg.today.requests += s.todayRequests || 0;
    agg.today.input += s.todayInput || 0;
    agg.today.output += s.todayOutput || 0;
    agg.today.cached += s.todayCached || 0;
    agg.today.reasoning += s.todayReasoning || 0;
    agg.today.credit += s.todayCredit || 0;
    for (const [m, info] of Object.entries(s.models || {})) {
      const slot = (agg.models[m] = agg.models[m] || { requests: 0, sessions: 0 });
      slot.requests += typeof info === 'number' ? info : (info.requests || 0);
      slot.sessions += 1;
    }
  }
  return agg;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (!checkAuth(req, url)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Unauthorized: 需要 ?token= 或 Authorization: Bearer');
    }

    // ---- API ----
    if (pathname === '/api/summary' || pathname === '/api/sessions' || pathname.startsWith('/api/sessions/') || pathname === '/api/daily') {
      const list = await scanner.scanAll({ maxAgeMs: SCAN_INTERVAL_MS });

      if (pathname === '/api/summary') {
        return sendJson(res, 200, {
          ok: true,
          scanError: scanner.lastError,
          lastScanAt: scanner.lastScanAt,
          wbHome: WB_HOME,
          summary: buildSummary(list),
        });
      }

      if (pathname === '/api/daily') {
        const days = Math.min(120, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
        return sendJson(res, 200, { ok: true, daily: scanner.dailyGlobal(days) });
      }

      if (pathname === '/api/sessions') {
        const dateKey = url.searchParams.get('date');
        if (dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
          return sendJson(res, 200, {
            ok: true,
            scanError: scanner.lastError,
            lastScanAt: scanner.lastScanAt,
            wbHome: WB_HOME,
            date: dateKey,
            sessions: scanner.daySummaries(dateKey),
          });
        }
        return sendJson(res, 200, {
          ok: true,
          scanError: scanner.lastError,
          lastScanAt: scanner.lastScanAt,
          wbHome: WB_HOME,
          sessions: list,
        });
      }

      const m = pathname.match(/^\/api\/sessions\/([^/]+)\/detail$/);
      if (m) {
        const dateKey = url.searchParams.get('date');
        const detail = scanner.detail(m[1], /^\d{4}-\d{2}-\d{2}$/.test(dateKey || '') ? dateKey : null);
        if (!detail) return sendJson(res, 404, { ok: false, error: '会话不存在' });
        return sendJson(res, 200, { ok: true, session: detail });
      }
    }

    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, uptime: process.uptime() });
    }

    if (pathname === '/api/pricing') {
      return sendJson(res, 200, { ok: true, pricing: readPricing() });
    }

    // ---- 静态文件 ----
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[workbuddy-web-monitor] http://${HOST}:${PORT}`);
  console.log(`[workbuddy-web-monitor] WB_HOME = ${WB_HOME}`);
  if (AUTH_TOKEN) console.log('[workbuddy-web-monitor] AUTH_TOKEN 已启用');
});
