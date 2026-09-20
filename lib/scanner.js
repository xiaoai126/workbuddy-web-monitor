/**
 * WorkBuddy 会话扫描器
 *
 * 扫描 ~/.workbuddy/projects/<munged-cwd>/<session-uuid>.jsonl 转录文件，
 * 从每条 API 响应行提取 usage（输入/输出/缓存/推理 tokens、模型、时间戳），
 * 计算会话级指标：上下文占用、累计输入输出、API 请求数、最近速度（保守值）。
 *
 * 性能策略：按 (mtimeMs + size) 做文件级缓存，只重扫发生变化的文件；
 * JSONL 逐行流式读取，避免大文件整块载入内存。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');

/** @typedef {{ts:number, input:number, output:number, cached:number, reasoning:number, requests:number, model:string|null}} UsageEvent */
/** @typedef {import('./scanner').SessionStat} SessionStat */

const MAX_HISTORY = 5000; // 单会话保留的请求历史上限（防止内存膨胀）

/**
 * 从一行原始文本中快速提取 timestamp（避免完整 JSON.parse）。
 * 行首形如 {"id":"...","timestamp":1789740587291,...
 */
function fastTimestamp(line) {
  const idx = line.indexOf('"timestamp":');
  if (idx === -1 || idx > 200) return null;
  const start = idx + 12;
  let end = start;
  while (end < line.length && line.charCodeAt(end) >= 48 && line.charCodeAt(end) <= 57) end++;
  if (end === start) return null;
  const n = Number(line.slice(start, end));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 快速提取 cwd（不完整 parse） */
function fastStringField(line, field) {
  const key = `"${field}":"`;
  const idx = line.indexOf(key);
  if (idx === -1 || idx > 4000) return null;
  const start = idx + key.length;
  let out = '';
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') return out;
    if (ch === '\\') {
      const nxt = line[i + 1];
      if (nxt === 'u') {
        const hex = line.slice(i + 2, i + 6);
        try { out += String.fromCharCode(parseInt(hex, 16)); } catch { /* ignore */ }
        i += 5;
      } else if (nxt === 'n') out += '\n';
      else if (nxt === 't') out += '\t';
      else if (nxt) out += nxt;
      i++;
    } else {
      out += ch;
    }
  }
  return out.length ? out : null;
}

/**
 * 归一化一条 usage 记录（兼容 camelCase / snake_case / rawUsage 多种格式）。
 */
function normalizeUsage(d) {
  const pd = d.providerData || {};
  let u = pd.usage || (d.message && d.message.usage) || null;
  let fallbackModel = null;

  if (!u && pd.rawUsage) {
    const r = pd.rawUsage;
    u = {
      requests: 1,
      inputTokens: r.prompt_tokens || 0,
      outputTokens: r.completion_tokens || 0,
      inputTokensDetails: [{ cached_tokens: (r.prompt_tokens_details && r.prompt_tokens_details.cached_tokens) || r.prompt_cache_hit_tokens || 0 }],
      outputTokensDetails: [{ reasoning_tokens: (r.completion_tokens_details && r.completion_tokens_details.reasoning_tokens) || r.completion_thinking_tokens || 0 }],
    };
  }
  if (!u) return null;

  const sumDetail = (arr, key) =>
    Array.isArray(arr) ? arr.reduce((s, x) => s + (x && typeof x[key] === 'number' ? x[key] : 0), 0) : null;

  const input = u.inputTokens ?? u.input_tokens ?? 0;
  const output = u.outputTokens ?? u.output_tokens ?? 0;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;

  let cached =
    sumDetail(u.inputTokensDetails, 'cached_tokens') ??
    u.cache_read_input_tokens ??
    (u.input_tokens_details && u.input_tokens_details.cached_tokens) ?? 0;
  let reasoning =
    sumDetail(u.outputTokensDetails, 'reasoning_tokens') ??
    (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) ??
    (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) ??
    u.completion_thinking_tokens ?? 0;

  const model = pd.model || pd.requestModelId || fallbackModel || null;
  // 积分消耗：仅在 rawUsage 中记录（本地/免费模型为 0 或缺失）
  const credit = Number(pd.rawUsage && pd.rawUsage.credit) || 0;

  return {
    ts: d.timestamp || 0,
    input,
    output,
    cached: cached || 0,
    reasoning: reasoning || 0,
    requests: Number.isFinite(u.requests) && u.requests > 0 ? u.requests : 1,
    model,
    credit,
  };
}

/** 空白会话统计结构 */
function newStat() {
  return {
    sessionId: null,
    file: null,
    projectDir: null,
    cwd: null,
    title: null,
    firstTs: null,
    lastTs: null,
    /** @type {UsageEvent[]} */
    events: [],
    lastModel: null,
    models: {},          // model -> {requests, input, output, cached, reasoning, credit, peak:{input,cached,output}}（按模型分别累计，供费用估算）
    todayModels: {},     // 同上，仅统计今天 0 点以后
    totalRequests: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCached: 0,
    totalReasoning: 0,
    totalCredit: 0,      // 累计积分消耗
    contextTokens: 0,    // 最后一次请求的 input tokens
  };
}

/**
 * DeepSeek 高峰时段判定：北京时间周一至周五 9:00-12:00、14:00-18:00
 * （法定节假日忽略，误差可接受；其余时间含周末为空闲时段，价格为高峰一半）。
 */
function isPeakHour(ts) {
  const d = new Date(ts + 8 * 3600 * 1000); // 平移到北京时间后用 UTC 取值
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 向按模型累计的 slot 写入一条事件（含高峰/空闲分桶） */
function accumulateSlot(slot, ev, peak) {
  slot.requests += ev.requests;
  slot.input += ev.input;
  slot.output += ev.output;
  slot.cached += ev.cached;
  slot.reasoning += ev.reasoning;
  slot.credit += ev.credit;
  if (peak) {
    slot.peak = slot.peak || { input: 0, cached: 0, output: 0 };
    slot.peak.input += ev.input;
    slot.peak.cached += ev.cached;
    slot.peak.output += ev.output;
  }
}

/**
 * 扫描单个 JSONL 文件（全量重扫），返回 SessionStat。
 */
async function scanFile(filePath) {
  const stat = newStat();
  stat.file = filePath;
  stat.projectDir = path.basename(path.dirname(filePath));
  stat.sessionId = path.basename(filePath, '.jsonl');

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity, emitClose: true });

  rl.on('line', (line) => {
    if (!line || line.length < 20) return;

    // cwd / 标题 / timestamp 均可从原始行快速提取
    if (stat.cwd === null && line.includes('"cwd":"')) {
      stat.cwd = fastStringField(line, 'cwd');
    }
    if (stat.title === null && line.includes('"aiTitle":"')) {
      stat.title = fastStringField(line, 'aiTitle');
    }

    const isUsageLine = line.includes('"usage"');
    if (!isUsageLine && stat.firstTs !== null && stat.lastTs !== null) {
      // 非 usage 行也可能更新 lastTs（会话末尾的用户消息等）
      const ts = fastTimestamp(line);
      if (ts) {
        if (stat.firstTs === null) stat.firstTs = ts;
        if (ts > stat.lastTs) stat.lastTs = ts;
      }
      return;
    }

    const ts = fastTimestamp(line);
    if (ts !== null) {
      if (stat.firstTs === null) stat.firstTs = ts;
      if (stat.lastTs === null || ts > stat.lastTs) stat.lastTs = ts;
    }

    if (!isUsageLine) return;

    // usage 行才完整 parse
    let d = null;
    try { d = JSON.parse(line); } catch { return; } // 半行写入/损坏行，静默跳过
    const ev = normalizeUsage(d);
    if (!ev) return;

    if (stat.events.length < MAX_HISTORY) stat.events.push(ev);
    stat.totalRequests += ev.requests;
    stat.totalInput += ev.input;
    stat.totalOutput += ev.output;
    stat.totalCached += ev.cached;
    stat.totalReasoning += ev.reasoning;
    stat.totalCredit += ev.credit;
    stat.contextTokens = ev.input; // 最后一条即为当前上下文
    if (ev.model) {
      stat.lastModel = ev.model;
      const peak = isPeakHour(ev.ts);
      accumulateSlot(stat.models[ev.model] = stat.models[ev.model] || { requests: 0, input: 0, output: 0, cached: 0, reasoning: 0, credit: 0 }, ev, peak);
    }
  });

  await new Promise((resolve, reject) => {
    rl.on('close', resolve);
    rl.on('error', reject);
    stream.on('error', reject);
  });

  return stat;
}

/**
 * 由 usage 事件序列计算速度指标（保守值：分母包含工具执行时间）。
 * speed_i = output_i / ((ts_i - ts_{i-1}) / 1000)，ts_{i-1} 为上一个请求完成时刻。
 * 间隔超过 IDLE_CAP_SEC 视为会话闲置（如隔天恢复），不计入任何速度样本。
 */
const IDLE_CAP_SEC = 300;

function computeSpeeds(stat) {
  const evs = stat.events;
  let lastDurationMs = null;

  /** @type {{output:number, dur:number}[]} 有效速度样本 */
  const samples = [];
  for (let i = 0; i < evs.length; i++) {
    const prevTs = i > 0 ? evs[i - 1].ts : stat.firstTs;
    if (!prevTs) continue;
    const dur = (evs[i].ts - prevTs) / 1000;
    if (evs[i].output > 0 && dur > 0 && dur <= IDLE_CAP_SEC) {
      samples.push({ output: evs[i].output, dur });
    }
  }

  const weighted = (arr) => {
    if (!arr.length) return null;
    const out = arr.reduce((s, x) => s + x.output, 0);
    const dur = arr.reduce((s, x) => s + x.dur, 0);
    return dur > 0 ? out / dur : null;
  };

  const lastSpeed = samples.length ? samples[samples.length - 1].output / samples[samples.length - 1].dur : null;
  const recentSpeed = weighted(samples.slice(-5)); // 最近 5 次请求
  const avgSpeed = weighted(samples);              // 全会话有效样本

  if (evs.length >= 2 && evs[evs.length - 2].ts) {
    lastDurationMs = evs[evs.length - 1].ts - evs[evs.length - 2].ts;
  }

  return { lastSpeed, recentSpeed, avgSpeed, lastDurationMs };
}

/** 构造 API 返回的会话摘要 */
function toSummary(stat, speedInfo) {
  const active = stat.events.length > 0;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();
  const today = { requests: 0, input: 0, output: 0, cached: 0, reasoning: 0, credit: 0 };
  const todayModels = {};
  for (let i = stat.events.length - 1; i >= 0; i--) {
    const ev = stat.events[i];
    if (ev.ts < todayStart) break; // 事件按时间升序
    today.requests += ev.requests;
    today.input += ev.input;
    today.output += ev.output;
    today.cached += ev.cached;
    today.reasoning += ev.reasoning;
    today.credit += ev.credit;
    if (ev.model) {
      accumulateSlot(todayModels[ev.model] = todayModels[ev.model] || { requests: 0, input: 0, output: 0, cached: 0, reasoning: 0, credit: 0 }, ev, isPeakHour(ev.ts));
    }
  }
  return {
    sessionId: stat.sessionId,
    file: stat.file,
    projectDir: stat.projectDir,
    cwd: stat.cwd,
    title: stat.title,
    firstTs: stat.firstTs,
    lastTs: stat.lastTs || stat.firstTs,
    model: stat.lastModel,
    models: stat.models,
    todayModels,
    requests: stat.totalRequests,
    input: stat.totalInput,
    output: stat.totalOutput,
    cached: stat.totalCached,
    reasoning: stat.totalReasoning,
    credit: stat.totalCredit,
    context: active ? stat.contextTokens : 0,
    lastSpeed: speedInfo.lastSpeed,
    recentSpeed: speedInfo.recentSpeed,
    avgSpeed: speedInfo.avgSpeed,
    lastDurationMs: speedInfo.lastDurationMs,
    todayRequests: today.requests,
    todayInput: today.input,
    todayOutput: today.output,
    todayCached: today.cached,
    todayReasoning: today.reasoning,
    todayCredit: today.credit,
    hasUsage: active,
  };
}

/**
 * 会话扫描器（带缓存）。
 */
class Scanner {
  /**
   * @param {string} workbuddyHome 例如 /Users/oem/.workbuddy 或容器内 /data/workbuddy
   */
  constructor(workbuddyHome) {
    this.home = workbuddyHome;
    this.projectsDir = path.join(workbuddyHome, 'projects');
    /** @type {Map<string, {key:string, stat:any, speed:any}>} */
    this.cache = new Map();
    this.scanning = null; // 进行中的全量扫描 Promise（防并发重入）
    this.lastScanAt = null;
    this.lastError = null;
  }

  /** 单文件增量扫描：mtime+size 未变则复用缓存 */
  async scanOneWithCache(filePath, mtimeMs, size) {
    const key = `${mtimeMs}:${size}`;
    const hit = this.cache.get(filePath);
    if (hit && hit.key === key) return hit;
    const stat = await scanFile(filePath);
    const speed = computeSpeeds(stat);
    const entry = { key, stat, speed };
    this.cache.set(filePath, entry);
    return entry;
  }

  /**
   * 扫描全部会话，返回按最后活动排序的摘要数组。
   * 同一时刻只允许一个扫描在跑；扫描期间新请求直接复用上次结果。
   */
  async scanAll({ force = false, maxAgeMs = 0 } = {}) {
    if (this.scanning) return this.scanning;
    if (!force && this.lastScanAt && Date.now() - this.lastScanAt < maxAgeMs) {
      return this._currentSummaries();
    }
    this.scanning = this._doScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async _doScan() {
    let summaries = [];
    try {
      let dirs;
      try { dirs = await fsp.readdir(this.projectsDir, { withFileTypes: true }); }
      catch (e) {
        this.lastError = `无法读取 ${this.projectsDir}: ${e.message}`;
        this.lastScanAt = Date.now();
        return this._currentSummaries();
      }
      const jobs = [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dirPath = path.join(this.projectsDir, d.name);
        let files;
        try { files = await fsp.readdir(dirPath); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(dirPath, f);
          jobs.push(
            fsp.stat(fp).then((st) => this.scanOneWithCache(fp, st.mtimeMs, st.size)).catch(() => null)
          );
        }
      }
      const results = await Promise.all(jobs);
      for (const r of results) {
        if (!r) continue;
        summaries.push(toSummary(r.stat, r.speed));
      }
      this.lastError = null;
    } catch (e) {
      this.lastError = e.message;
    }
    this.lastScanAt = Date.now();
    summaries.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));

    // 清理已删除文件的缓存
    const alive = new Set(summaries.map((s) => s.file));
    for (const k of this.cache.keys()) if (!alive.has(k)) this.cache.delete(k);

    this._summaries = summaries;
    return summaries;
  }

  _currentSummaries() {
    return this._summaries || [];
  }

  /** 单会话详情（含请求历史） */
  async detail(sessionId) {
    await this.scanAll();
    for (const [, entry] of this.cache) {
      if (entry.stat.sessionId === sessionId) {
        const stat = entry.stat;
        return {
          ...toSummary(stat, entry.speed),
          history: stat.events.map((ev) => ({
            ts: ev.ts, model: ev.model, input: ev.input, output: ev.output,
            cached: ev.cached, reasoning: ev.reasoning, requests: ev.requests,
            credit: ev.credit,
          })).slice(-300).reverse(), // 最近 300 条
        };
      }
    }
    return null;
  }
}

module.exports = { Scanner, computeSpeeds };
