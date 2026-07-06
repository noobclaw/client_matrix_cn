/**
 * 矩阵「小红书爆款批量仿写」运行时 —— 让一批账号在各自指纹内核里:
 *   用【本号赛道/关键词/人设】去小红书搜本 niche 爆款 → 维度化创意引擎仿写 → AI 生图 → 发布。
 *
 * 复用后端 fork 的 xhs_viral_production_career orchestrator(STEP1 采集 / STEP2 仿写 /
 * STEP3 AI 生图 / STEP4 发布)。结构基本同 imageTextRunner(故大量逻辑一致),差异:
 *   · scenarioId = xhs_viral_production_career(仅小红书);来源是「搜爆款」而非用户给素材。
 *   · ctx 多 4 个采集必需件:parseLikes / keywordMatch / seenPostIds(Set)/ recordSeen(去重持久化),
 *     另给 writeAsset(存源图);getViralConfig/passViralThreshold/pushToViralLibrary 是 orchestrator
 *     里 typeof 守卫的可选件 → v1 不提供(不建共享爆文库,不影响 采集→仿写→发布 主流程)。
 *
 * 回调签名与 EngageTaskOptions 对齐(onLog/onItem/onTargets/signal),返回 EngageReport,
 * sidecar 进度聚合闭包零改动复用。⚠️ STEP1 小红书搜索/详情 DOM 在指纹内核 CDP 上首跑要据真机微调。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { coworkLog } from '../coworkLogger';
import { launchKernel, kernelNavigate, closeKernel, checkKernelLogin, NO_KERNEL_ERROR } from './kernelPool';
import { inspectHoldMs } from './inspectHold';
import { installedKernelPath } from './kernelInstaller';
import { matrixCmd } from './cdpCommands';
import { getAccount, setAccountStatus, appendDerivedKeywords, effectiveKeywords, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey } from './accountManager';
import { promptReloginForExpiredAccount } from './reloginPrompt';
import { getNoobClawAuthToken } from '../claudeSettings';
import type { EngageItemResult, EngageReport } from './engageRunner';
import type { ViralRewriteConfig } from './types';
import { contentUsageStore, defaultContentReuseCap } from './contentUsage';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
/** 可中断等待:点停止后立即返回,不再干等整段(错峰 3-15s 是任务停不下来的主因)。 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(t); try { signal?.removeEventListener('abort', onAbort); } catch { /* ignore */ } };
    try { signal?.addEventListener('abort', onAbort, { once: true }); } catch { /* ignore */ }
  });
}
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function matrixDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }

// 「1.2万」「3.4w」「2.1k」「1,234」→ 数字。STEP1 按点赞数过滤爆款用(orchestrator 不守卫,必须提供)。
function parseLikes(text: any): number {
  const s = String(text == null ? '' : text).trim().replace(/,/g, '');
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*([万wWkK])?/);
  if (!m) return 0;
  let n = parseFloat(m[1]) || 0;
  const unit = (m[2] || '').toLowerCase();
  if (unit === '万' || unit === 'w') n *= 10000;
  else if (unit === 'k') n *= 1000;
  return Math.round(n);
}
// 标题/正文是否命中任一关键词(空关键词视为命中,不过滤)。STEP1 过滤用(不守卫,必须提供)。
function keywordMatch(text: any, kws: any): boolean {
  const t = String(text == null ? '' : text).toLowerCase();
  if (!Array.isArray(kws) || kws.length === 0) return true;
  return kws.some((k: any) => k && t.indexOf(String(k).toLowerCase()) >= 0);
}

// 多平台通用验证码检测(同 imageTextRunner)。
const CAPTCHA_DETECT_EXPR = "(function(){try{"
  + "if(document.querySelector('#captcha_container,#captcha-verify-image,[id*=\"captcha\" i][class*=\"verify\" i],[class*=\"captcha_verify\" i],[class*=\"vc_captcha\" i],[class*=\"captcha-container\" i],[class*=\"captcha-slider\" i],[class*=\"secsdk-captcha\" i],[class*=\"geetest\" i],[class*=\"red-captcha\" i],[class*=\"sc-captcha\" i]'))return true;"
  + "var b=document.body?(document.body.innerText||'').slice(0,3000):'';"
  + "if(/向右滑动|拖动滑块|拖动下方滑块|完成拼图|按住滑块|滑动完成验证|Verify you are human|请完成安全验证/i.test(b))return true;"
  + "return false;}catch(e){return false;}})()";

export interface ViralRewriteTaskOptions {
  platform: string;                 // 仅 xhs
  taskId?: string;
  accountIds: string[];
  config: ViralRewriteConfig;
  concurrency?: number;
  jitterMinMs?: number; jitterMaxMs?: number;
  kernelPath?: string;
  authToken?: string;
  signal?: AbortSignal;
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
  onTargets?: (accountId: string, targets: { like?: number; follow?: number; comment?: number }) => void;
}

async function fetchPack(id: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/matrix/scenarios/${id}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    coworkLog('WARN', 'viralRewriteRunner', 'fetch pack failed', { err: String(e) });
    return null;
  }
}

function makeAiCall(authToken: string | undefined, onCost?: (credits: number, usd: number) => void, signal?: AbortSignal) {
  return async (promptNameOrRaw: string, promptOrInput: any, rawInput?: string, opts?: any) => {
    const prompt = promptNameOrRaw === '__raw__' ? String(promptOrInput) : String(promptOrInput || '');
    const userMessage = promptNameOrRaw === '__raw__'
      ? String(rawInput || '')
      : (typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput));
    if (!authToken) throw new Error('AI_NOT_CONFIGURED');
    const body: any = {
      model: (opts && opts.model) || 'noobclawai-chat',
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: userMessage }],
      stream: false, max_tokens: (opts && opts.max_tokens) || 4096,
    };
    const wantJson = opts?.expectJson !== false;
    if (wantJson && (/json/i.test(prompt) || /json/i.test(userMessage))) body.response_format = { type: 'json_object' };
    else if (!wantJson) body.response_format = { type: 'text' };
    const res = await fetch(`${baseUrl()}/api/ai/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(body),
      signal,
    });
    const data: any = await res.json().catch(() => ({}));
    // 后端非 2xx(余额不足 402 / 内容审核 / 限流 / 5xx)必须抛错,不能把 {error,message}
    //   当成空 content 静默吞掉 —— 否则上层只看到空串误报「返回空」,看不出是余额不足。
    if (!res.ok) {
      const beMsg = String((data && (data.message || data.error)) || ('http_' + res.status));
      if (res.status === 402 || /INSUFFICIENT_TOKENS|insufficient|余额/i.test(beMsg)) throw new Error('余额不足,请充值后重试 (' + beMsg + ')');
      throw new Error('AI 请求失败 ' + res.status + ': ' + beMsg);
    }
    try {
      const aiCredits = Number(data?._noobclaw?.billableTokens) || 0;
      const aiUsd = Number(data?._noobclaw?.costUsd) || 0;
      if ((aiCredits > 0 || aiUsd > 0) && onCost) onCost(aiCredits, aiUsd);
    } catch { /* ignore */ }
    const content = data?.choices?.[0]?.message?.content ?? '';
    if (opts?.expectJson === false) return content;
    try { return JSON.parse(content); } catch { return content; }
  };
}

async function chargeAction(authToken: string | undefined, actionType: string, platform: string, refId?: string) {
  if (!authToken) return { ok: false, reason: 'auth_missing' };
  try {
    const res = await fetch(`${baseUrl()}/api/charge/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ action_type: actionType, platform, ref_id: refId || null }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: String(data?.error || `http_${res.status}`) };
    return { ok: true, charged: Number(data?.charged) || 0, cost_usd: Number(data?.cost_usd) || 0, balance_after: data?.balance_after };
  } catch { return { ok: false, reason: 'network_error' }; }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ── 本号「已采爆款」复用计数(跨运行;同一篇最多仿写 cap 次,默认 3,见 contentUsage)──
const VIRAL_CONTENT_CAP = defaultContentReuseCap();

async function runOne(opts: ViralRewriteTaskOptions, pack: any, accountId: string): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const cfg = opts.config;
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  if (opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' };
  if (!acc) { log('❌ 跳过:账号不存在'); return { accountId, state: 'skipped', reason: 'account_not_found' }; }
  if (acc.platform !== opts.platform) { log('❌ 跳过:账号平台与任务不符'); return { accountId, state: 'skipped', reason: 'platform_mismatch' }; }
  if (acc.status === 'banned' || acc.status === 'limited') { log('❌ 跳过:账号状态为 ' + acc.status); return { accountId, state: 'skipped', reason: 'account_' + acc.status }; }
  // 爆款仿写靠本号关键词去搜 —— 没关键词没法搜,跳过。
  const accKeywords = effectiveKeywords(acc); // 原始 + AI 衍生池
  if (accKeywords.length === 0) {
    log('❌ 跳过:爆款仿写需要本号关键词(到「我的矩阵账号」编辑里添加)');
    return { accountId, state: 'skipped', reason: 'no_keywords' };
  }

  await abortableSleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000), opts.signal); // 错峰(可中断:停止立即结束)

  const counts = { like: 0, follow: 0, comment: 0, post: 0 };
  let chargedCredits = 0, chargedUsd = 0;
  const authToken = opts.authToken || getNoobClawAuthToken() || undefined;
  let finished: { status: string; error?: string } | null = null;
  const seen = contentUsageStore(accountId, opts.platform, VIRAL_CONTENT_CAP);

  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc),
      groupTitle: matrixGroupTitle(opts.platform, opts.taskId),
    });
    // 先导航小红书主站校验登录态(采集走主站搜索;发布走 creator,主站登录态覆盖)。
    await kernelNavigate(accountId, 'https://www.xiaohongshu.com/');
    await sleep(2000);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 小红书登录态失效/未关联,弹窗扫码重连(其它号照跑)');
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(accountId); } catch { /* ignore */ } }
      return { accountId, state: 'skipped', reason: 'login_expired' };
    }
    markAccountAlive(accountId);

    // 本号 task:沿用账号身份(赛道/关键词/人设);来源=关键词搜(不传 urls)。
    const task: any = {
      id: accountId,
      keywords: accKeywords,
      track: acc.track || '',
      persona: acc.persona || '',
      daily_count: Math.max(1, Math.min(50, Number(cfg.dailyCount) || 1)),
      variants_per_post: 1,
      ai_image_style: cfg.aiImageStyle || 'ai_auto',
      auto_upload: !!cfg.autoPublish,   // 仅本地时不上传
      auto_publish: !!cfg.autoPublish,  // 直接发布(坐标)
    };

    const onAiCost = (credits: number, usd: number) => {
      chargedCredits += credits; chargedUsd += usd;
      try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
    };
    const aiCall = makeAiCall(authToken, onAiCost, opts.signal);
    const browserFn: any = (command: string, params?: any, timeout?: number) => matrixCmd(accountId, command, params, timeout);
    const taskTab: any = {
      id: 'main', browser: browserFn,
      navigate: async (url: string) => { await kernelNavigate(accountId, url); },
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
    };

    const doCharge = async (a: string, p: string, r?: string) => {
      const res: any = await chargeAction(authToken, a, p, r);
      if (res && res.ok) {
        chargedCredits += Number(res.charged) || 0;
        chargedUsd += Number(res.cost_usd) || 0;
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      }
      return res;
    };

    const apiCall = async (endpoint: string, body?: any) => {
      const res = await fetch(`${baseUrl()}${endpoint}`, {
        method: body == null ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: body == null ? undefined : JSON.stringify(body),
        signal: opts.signal,
      });
      const data = await res.json().catch(() => ({}));
      // 累加 AI 生图 token/费用到「本次消耗」(imageGen 走通用 apiCall 不经 onCost,原漏此大头;
      //   sync /generate 与 async /status(done) 都返 token_cost+_noobclaw.costUsd,仅 done 时>0 天然不重复)。
      try {
        const imgTokens = Number((data as any)?.token_cost) || 0;
        if (imgTokens > 0) { chargedCredits += imgTokens; chargedUsd += Number((data as any)?._noobclaw?.costUsd) || 0; }
      } catch { /* non-fatal */ }
      return data;
    };

    // 仿写稿 + 配图落盘到 <matrixDir>/drafts/xhs/<accountId>/<draftId>/。
    const draftsBase = path.join(matrixDir(), 'drafts', opts.platform || 'xhs', accountId);
    const saveDrafts = async (arr: any[]) => {
      try {
        let lastDir = '';
        for (const d of (Array.isArray(arr) ? arr : [])) {
          const rawId = String(d?.source_post?.external_post_id || d?.external_post_id || `draft_${Date.now()}`);
          const safeId = rawId.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
          const dir = path.join(draftsBase, safeId);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(d, null, 2), 'utf8');
          const imgs = Array.isArray(d?.images) ? d.images : [];
          for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            if (img && img.base64) {
              const ext = String(img.mimeType || '').indexOf('png') >= 0 ? 'png' : 'jpg';
              try { fs.writeFileSync(path.join(dir, `img_${i}.${ext}`), Buffer.from(img.base64, 'base64')); } catch { /* ignore */ }
            }
          }
          lastDir = dir;
        }
        return { ok: true, dir: lastDir };
      } catch (err: any) {
        return { ok: false, reason: String(err?.message || err) };
      }
    };

    // 存源爆款图(STEP1 存档,可选;orchestrator typeof 守卫)。落 <matrixDir>/viral_src/xhs/<accountId>/。
    const writeAsset = async (fileName: string, base64: string, _o?: any) => {
      try {
        const dir = path.join(matrixDir(), 'viral_src', opts.platform || 'xhs', accountId);
        fs.mkdirSync(dir, { recursive: true });
        const safe = String(fileName || `src_${Date.now()}.jpg`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 160);
        const fp = path.join(dir, safe);
        fs.writeFileSync(fp, Buffer.from(String(base64 || ''), 'base64'));
        return { ok: true, path: fp, dir };
      } catch (err: any) { return { ok: false, reason: String(err?.message || err) }; }
    };

    const ctx: any = {
      task, config: pack?.config || {}, manifest: pack?.manifest || {},
      appLocale: 'zh',
      aborted: () => !!opts.signal?.aborted,
      browser: browserFn,
      navigate: (url: string) => kernelNavigate(accountId, url),
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
      openTab: async (o: any) => { if (o?.url) { await kernelNavigate(accountId, o.url); await sleep(1500); } return taskTab; },
      getTaskTab: async () => taskTab,
      report: (m: string) => { log(m); try { coworkLog('INFO', 'viral', `[${accountId}] ${m}`); } catch { /* ignore */ } },
      stepStart: (s: number) => log('▶ 步骤 ' + s),
      stepLog: (_s: number, _st: string, m: string) => log(m),
      stepDone: (_s: number) => {},
      startAction: (..._a: any[]) => {},
      stepResetAll: () => {},
      setActionTargets: (t: any) => {
        if (typeof t?.post === 'number') log(`🎯 本号目标:仿写发 ${t.post} 篇`);
      },
      addActionCount: (type: string, n: number) => {
        if (type === 'post') { counts.post += Number(n) || 0; log(`✅ 已完成 ${counts.post} 篇`); }
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      },
      finish: (status: string, error?: string) => { finished = { status, error }; },
      chargeAction: doCharge,
      charge: doCharge,
      aiCall,
      apiCall,
      saveDrafts,
      getPrompt: (name: string) => { const t = pack?.prompts?.[name]; if (!t) throw new Error('Missing prompt: ' + name); return t; },
      // AI 衍生新词 → 存进【衍生池】(原始词永留,封顶 30,满了整批换);之前是 no-op → 衍生词丢失。
      appendKeywords: (arr: string[]) => { try { appendDerivedKeywords(accountId, arr); } catch { /* ignore */ } },
      // ── 采集必需的 4 件(orchestrator 不守卫)──
      parseLikes,
      keywordMatch,
      seenPostIds: seen.set,
      recordSeen: (ids: any) => { try { (Array.isArray(ids) ? ids : [ids]).forEach((id) => { if (id) seen.record(String(id)); }); } catch { /* ignore */ } },
      // ── 可选(存源图)──
      writeAsset,
      sleep: (min: number, max?: number) => new Promise<void>((resolve) => {
        const ms = max ? randInt(min, max) : min;
        if (opts.signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
      }),
      waitForCaptchaCleared: async (o?: { maxMs?: number }) => {
        const maxMs = (o && o.maxMs) || 180000;
        const startedWait = Date.now();
        let notified = false;
        while (Date.now() - startedWait < maxMs) {
          if (opts.signal?.aborted) return { ok: false, reason: 'aborted' };
          let showing = false;
          try { const r: any = await matrixCmd(accountId, 'cdp_eval', { expression: CAPTCHA_DETECT_EXPR }); showing = !!(r && (r.value === true || r.value === 'true')); } catch { showing = false; }
          if (!showing) { if (notified) log('✅ 验证码已通过,继续任务'); return { ok: true }; }
          if (!notified) { notified = true; log('🧩 检测到验证码,请在该账号浏览器窗口【手动完成验证】(最多等 ' + Math.round(maxMs / 60000) + ' 分钟,过了自动继续)…'); }
          await sleep(4000);
        }
        log('⏱ 验证码等待超时(' + Math.round(maxMs / 60000) + ' 分钟未完成),放弃本号');
        return { ok: false, reason: 'captcha_timeout' };
      },
      randInt,
      log: (m: string) => coworkLog('INFO', 'viral-orch', m),
    };

    const code = pack?.orchestrator;
    if (!code) { coworkLog('ERROR', 'viral', `[${accountId}] no_orchestrator`); return { accountId, state: 'failed', reason: 'no_orchestrator' }; }
    const fn = new AsyncFunction('ctx', code);
    await fn(ctx);

    setAccountStatus(accountId, 'idle');
    const fin = finished as { status: string; error?: string } | null;
    if (fin && fin.status === 'error') {
      coworkLog('ERROR', 'viral', `[${accountId}] finished error: ${fin.error}`);
      return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: fin.error };
    }
    coworkLog('INFO', 'viral', `[${accountId}] done 仿写发 ${counts.post} 篇 · 扣费 ${chargedCredits}积分`);
    return { accountId, state: 'success', counts, chargedCredits, chargedUsd };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    coworkLog('ERROR', 'viral', `[${accountId}] threw: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
    return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'viral_threw:' + String(e?.message || e).slice(0, 140) };
  } finally {
    // 完成后留时间让用户检查浏览器里的结果再关窗(点「停止」立即关、不等)。
    // 普通 20s;撞到登录墙/验证墙留 60s,好让用户当场手动登录/过验证(2026-07-06 用户要求)。
    const holdMs = inspectHoldMs(finished?.error);
    if (!opts.signal?.aborted) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, holdMs);
        try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
      });
    }
    try { closeKernel(accountId); } catch { /* ignore */ }
  }
}

async function runPool(ids: string[], k: number, worker: (id: string) => Promise<EngageItemResult>, onItem?: (i: EngageItemResult) => void): Promise<EngageItemResult[]> {
  const results: EngageItemResult[] = new Array(ids.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      const r = await worker(ids[i]);
      results[i] = r;
      try { onItem?.(r); } catch { /* ignore */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(k, ids.length)) }, () => lane()));
  return results;
}

export async function runViralRewriteTask(opts: ViralRewriteTaskOptions): Promise<EngageReport> {
  if (!opts.kernelPath && !installedKernelPath()) {
    throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  }
  const k = Math.max(1, Math.min(opts.concurrency ?? 3, 10));
  const scenarioId = `${opts.platform}_viral_production_career`;
  const pack = await fetchPack(scenarioId);
  if (!pack || !pack.orchestrator) {
    return {
      platform: opts.platform, total: opts.accountIds.length, success: 0, failed: 0, skipped: opts.accountIds.length,
      items: opts.accountIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_scenario(后端未部署?)' })),
    };
  }
  coworkLog('INFO', 'viralRewriteRunner', `viral_rewrite ${opts.platform} x${opts.accountIds.length} (${scenarioId})`);
  const items = await runPool(opts.accountIds, k, (id) => runOne(opts, pack, id), opts.onItem);
  return {
    platform: opts.platform, total: items.length,
    success: items.filter((x) => x.state === 'success').length,
    failed: items.filter((x) => x.state === 'failed').length,
    skipped: items.filter((x) => x.state === 'skipped').length,
    items,
  };
}
