/**
 * 矩阵「币安广场批量搬运」运行时(两阶段)—— 把币安广场的「批量搬运」能力带到矩阵多账号。
 *
 * 与其它矩阵任务最大的不同:本任务有【两种账号角色】,跑两个阶段:
 *   阶段A · 采集(1 个采集号):用 config.sourceAccountId(在 sourcePlatform 上已登录)的指纹内核,
 *     跑 binance_repost_collect_<sourcePlatform> 剧本,按关键词搜索 → 筛选 → 下源图,采够 N 条候选。
 *   阶段B · 分发(N 个币安号):把候选逐条分给勾选的币安账号,每号在各自指纹内核里跑 binance_repost
 *     发布剧本(AI 仿写 + 配源图 → 发币安广场),每条之间睡 60-120s,成功一条扣 repost_image_text。
 *
 * 设计要点:① 采集只跑一次(币安号不需要各自登录源平台);② 候选按 post_id 任务内去重 + 采集号跨运行
 * 去重(seen 库),两号不撞同源;③ 每号【独立仿写】→ 同源也出不同文案,降低连坐。
 *
 * 复用:发布侧 ctx 沿用 binancePostRunner;采集侧 ctx 沿用 viralRewriteRunner(seenPostIds/keywordMatch)。
 * 进度回调与 EngageTaskOptions 对齐(onLog/onItem/onTargets/signal → EngageReport),sidecar 聚合零改动。
 *
 * ⚠️ 采集 DOM(小红书)+ 币安发布 selector 在指纹内核 CDP 上首跑都要据真机微调;币安需 VPN/代理。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import { launchKernel, kernelNavigate, closeKernel, checkKernelLogin, NO_KERNEL_ERROR } from './kernelPool';
import { installedKernelPath } from './kernelInstaller';
import { matrixCmd } from './cdpCommands';
import { runMatrixDriver, runMatrixDouyinSearch } from './driverCtx';
import { contentUsageStore, defaultContentReuseCap, type ContentUsage } from './contentUsage';
import { getAccount, setAccountStatus, effectiveKeywords, appendDerivedKeywords, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey } from './accountManager';
import { promptReloginForExpiredAccount } from './reloginPrompt';
import { getNoobClawAuthToken } from '../claudeSettings';
import type { EngageItemResult, EngageReport } from './engageRunner';
import type { BinanceRepostConfig } from './types';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function matrixDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }

const BINANCE_SQUARE = 'https://www.binance.com/square';
// 采集号登录态预检导航的首页(按源平台)。
const SOURCE_HOME: Record<string, string> = {
  xhs: 'https://www.xiaohongshu.com/',
  douyin: 'https://www.douyin.com/',
  tiktok: 'https://www.tiktok.com/',
  x: 'https://x.com/home',
};

export interface BinanceRepostTaskOptions {
  platform: string;                 // 'binance'(发布目标平台)
  taskId?: string;
  accountIds: string[];             // 币安发布号
  config: BinanceRepostConfig;      // 搬运配置(含 sourcePlatform / sourceAccountId / keyword / material …)
  concurrency?: number;             // 此处忽略:分发阶段顺序执行(每条睡 60-120s)
  jitterMinMs?: number; jitterMaxMs?: number;
  kernelPath?: string;
  authToken?: string;
  signal?: AbortSignal;
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
  onTargets?: (accountId: string, targets: { like?: number; follow?: number; comment?: number }) => void;
}

interface RepostCandidate {
  post_id: string;
  source_url?: string;
  author?: string;
  text: string;
  images: Array<{ base64: string; mimeType?: string }>; // 图文模式:源图
  video_path?: string;   // 视频模式:采集号下好的无水印 mp4 本地路径
  duration?: number;
}

async function fetchPack(id: string): Promise<any | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/matrix/scenarios/${id}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    coworkLog('WARN', 'binanceRepostRunner', 'fetch pack failed', { id, err: String(e) });
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
      stream: false, max_tokens: (opts && opts.max_tokens) || 3072,
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

const CAPTCHA_DETECT_EXPR = "(function(){try{"
  + "if(document.querySelector('#captcha_container,#captcha-verify-image,[id*=\"captcha\" i][class*=\"verify\" i],[class*=\"captcha_verify\" i],[class*=\"geetest\" i],[class*=\"red-captcha\" i]'))return true;"
  + "var b=document.body?(document.body.innerText||'').slice(0,3000):'';"
  + "if(/向右滑动|拖动滑块|完成拼图|Verify you are human|请完成安全验证/i.test(b))return true;"
  + "return false;}catch(e){return false;}})()";

function keywordMatch(text: any, kws: any): boolean {
  const t = String(text == null ? '' : text).toLowerCase();
  if (!Array.isArray(kws) || kws.length === 0) return true;
  return kws.some((k: any) => k && t.indexOf(String(k).toLowerCase()) >= 0);
}

// 采集号内容去重 + 复用计数:同一条源最多用 cap 次(默认 3,见 contentUsage)。.set=已用满的 id;.record(id)=+1。
const REPOST_CONTENT_CAP = defaultContentReuseCap();

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const VIDEO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// runner 侧下载一个视频 URL 到本地:先借采集号浏览器网络栈(main_world_fetch_api,带签名/cookies)→ Node fetch 兜底。
async function downloadVideoUrl(accountId: string, url: string, destPath: string, referer: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const r: any = await matrixCmd(accountId, 'main_world_fetch_api', { url, method: 'GET', credentials: 'include', responseType: 'base64' }, 180000);
    if (r && r.ok && r.body && r.encoding === 'base64') {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, Buffer.from(r.body, 'base64'));
      if (fs.statSync(destPath).size > 10000) return true;
    }
  } catch { /* fall through */ }
  try {
    const resp = await fetch(url, { headers: { Referer: referer, 'User-Agent': VIDEO_UA }, signal });
    if (resp.ok) {
      const ab = await resp.arrayBuffer();
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, Buffer.from(ab));
      if (ab.byteLength > 10000) return true;
    }
  } catch { /* ignore */ }
  return false;
}

// 抖音视频源:复用 douyin_search driver(返回无水印 play_addr urls + 同序 titles 文案),runner 侧逐个下载。
async function collectDouyinVideos(
  opts: BinanceRepostTaskOptions, srcAccId: string, keywords: string[], want: number,
  seen: ContentUsage, log: (m: string) => void,
): Promise<RepostCandidate[]> {
  const out: RepostCandidate[] = [];
  // douyin_search driver 内部会逐个关键词搜直到够 want(随机轮换 + 自带去水印/最高码率)。
  log('🎬 抖音搜索 + 取无水印源(关键词 ' + keywords.length + ' 个,搜尽自动换下一个)…');
  const r = await runMatrixDouyinSearch(srcAccId, keywords, Math.min(want * 2, 20), 'video', (m) => log(m));
  const urls = Array.isArray(r.urls) ? r.urls : [];
  const titles = Array.isArray(r.titles) ? r.titles : [];
  if (!urls.length) { log('⚠️ 抖音未取到视频:' + (r.reason || 'empty')); return out; }
  const dir = path.join(matrixDir(), 'repost_src', 'douyin', srcAccId, '原文');
  const pickedLocal = new Set<string>(); // 本轮内去重(seen.set 只含已用满的,采集不再记 → 靠这个防同轮重复)
  for (let i = 0; i < urls.length && out.length < want; i++) {
    if (opts.signal?.aborted) break;
    const u = String(urls[i] || '');
    if (!/^https?:\/\//i.test(u)) continue;
    const idm = u.match(/(\d{15,})/);
    const id = idm ? idm[1] : `dy_${i}_${randInt(1e5, 9e5)}`;
    if (seen.set.has(id) || pickedLocal.has(id)) continue;
    pickedLocal.add(id);
    const cap = String(titles[i] || '').trim();
    if (cap.length < 6) { log('   ⏭ 文案过短,跳过'); continue; } // 仿写需要源文案
    const dest = path.join(dir, `repost_douyin_${id}.mp4`);
    log(`📥 下载无水印视频 ${out.length + 1}/${want}…`);
    const ok = await downloadVideoUrl(srcAccId, u, dest, 'https://www.douyin.com/', opts.signal);
    if (!ok) { log('   ⏭ 下载失败,跳过'); continue; }
    out.push({ post_id: id, source_url: u, author: '抖音用户', text: cap.slice(0, 1500), images: [], video_path: dest });
    // 采集不计数;计数在发布成功后(runBinanceRepostTask)。本轮内同 id 不重复靠下面 seen.set + 顺序去重。
    log(`   ✅ 采到 1 条视频(文案 ${cap.length} 字)`);
  }
  return out;
}

// 给采集/发布 orchestrator 公用的 captcha 等待。
function makeWaitForCaptcha(accountId: string, log: (m: string) => void, signal?: AbortSignal) {
  return async (o?: { maxMs?: number }) => {
    const maxMs = (o && o.maxMs) || 180000;
    const startedWait = Date.now();
    let notified = false;
    while (Date.now() - startedWait < maxMs) {
      if (signal?.aborted) return { ok: false, reason: 'aborted' };
      let showing = false;
      try { const r: any = await matrixCmd(accountId, 'cdp_eval', { expression: CAPTCHA_DETECT_EXPR }); showing = !!(r && (r.value === true || r.value === 'true')); } catch { showing = false; }
      if (!showing) { if (notified) log('✅ 验证码已通过,继续'); return { ok: true }; }
      if (!notified) { notified = true; log('🧩 检测到验证码,请在该账号浏览器窗口手动完成验证(最多等 ' + Math.round(maxMs / 60000) + ' 分钟)…'); }
      await sleep(4000);
    }
    return { ok: false, reason: 'captcha_timeout' };
  };
}

// ═══════════════════════ 阶段A · 采集 ═══════════════════════
async function collectFromSource(
  opts: BinanceRepostTaskOptions, collectPack: any, want: number, seen: ContentUsage,
): Promise<{ candidates: RepostCandidate[]; reason?: string }> {
  const cfg = opts.config;
  const srcAccId = cfg.sourceAccountId;
  const acc = getAccount(srcAccId);
  // 采集阶段进度上报:采集号(srcAccId)不在任务的发布号面板里 → 把采集日志【广播到每个币安发布号的进度框】,
  // 否则采集那几分钟右边面板一片空白(用户以为卡死)。前缀 🧺 区分这是采集阶段。
  const log = (m: string) => {
    try { opts.onLog?.(srcAccId, '🧺 ' + m); } catch { /* ignore */ }
    for (const pid of (opts.accountIds || [])) { try { opts.onLog?.(pid, '🧺 ' + m); } catch { /* ignore */ } }
  };
  if (!acc) { log('❌ 采集号不存在'); return { candidates: [], reason: 'source_account_not_found' }; }
  if (acc.platform !== cfg.sourcePlatform) { log('❌ 采集号平台与来源平台不符'); return { candidates: [], reason: 'source_platform_mismatch' }; }

  // 关键词:直接用采集号自己的关键词【全列表】(不再让用户在任务里填);cfg.keyword 仅作老任务/可选覆盖兼容。
  const accKw = effectiveKeywords(acc); // 采集号:原始 + AI 衍生池
  const keywords = (cfg.keyword && String(cfg.keyword).trim()) ? [String(cfg.keyword).trim()] : accKw;
  if (!keywords.length) { log('❌ 采集号没有关键词 —— 去「我的矩阵账号」给它加几个赛道关键词'); return { candidates: [], reason: 'no_keywords' }; }

  const authToken = opts.authToken || getNoobClawAuthToken() || undefined;
  // seen 由 runBinanceRepostTask 创建并传入:采集阶段【只查不记】(seen.set.has 跳过已用满的),
  // 真正计数(record)挪到【发布成功后】—— 下载了但没发出去不算一次,可下轮重试(用户要求)。
  let candidates: RepostCandidate[] = [];

  try {
    setAccountStatus(srcAccId, 'running');
    log('启动采集号指纹内核');
    await launchKernel({
      accountId: srcAccId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc), groupTitle: matrixGroupTitle(cfg.sourcePlatform, opts.taskId),
    });
    await kernelNavigate(srcAccId, SOURCE_HOME[cfg.sourcePlatform] || SOURCE_HOME.xhs);
    await sleep(2500);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(srcAccId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(srcAccId, 'login_required');
      log('⚠️ 采集号登录态失效,弹窗扫码重连后重试任务');
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(srcAccId); } catch { /* ignore */ } }
      return { candidates: [], reason: 'source_login_expired' };
    }
    markAccountAlive(srcAccId);

    // 抖音视频源:不走采集剧本,runner 侧复用 douyin_search driver 搜+取无水印 + 逐个下载。
    if (cfg.sourcePlatform === 'douyin') {
      const dyCands = await collectDouyinVideos(opts, srcAccId, keywords, want, seen, log);
      setAccountStatus(srcAccId, 'idle');
      log('采集完成:' + dyCands.length + ' 条候选');
      return { candidates: dyCands };
    }

    const browserFn: any = (command: string, params?: any, timeout?: number) => matrixCmd(srcAccId, command, params, timeout);
    const ctx: any = {
      task: { keywords, keyword: keywords[0], want },
      config: collectPack?.config || {}, manifest: collectPack?.manifest || {},
      appLocale: 'zh',
      aborted: () => !!opts.signal?.aborted,
      browser: browserFn,
      navigate: (url: string) => kernelNavigate(srcAccId, url),
      scroll: (amount?: number) => matrixCmd(srcAccId, 'scroll', { amount: amount || randInt(2, 4) }),
      report: (m: string) => log(m),
      stepStart: (_s: number) => {},
      stepLog: (_s: number, _st: string, m: string) => log(m),
      stepDone: (_s: number) => {},
      finish: (_status: string, _err?: string) => {},
      // 关键词搜尽时,采集剧本调 aiCall 衍生新词 → appendKeywords 存进采集号衍生池(下轮启用)。
      aiCall: makeAiCall(authToken, undefined, opts.signal),
      appendKeywords: (arr: string[]) => { try { appendDerivedKeywords(srcAccId, arr); } catch { /* ignore */ } },
      keywordMatch,
      seenPostIds: seen.set,
      // 采集阶段不计数(只在发布成功后由 runBinanceRepostTask 调 seen.record);本轮内去重靠剧本自己的 local set。
      recordSeen: (_ids: any) => { /* no-op:计数挪到发布成功后 */ },
      // 视频采集落盘:base64 → <matrixDir>/repost_src/<platform>/<srcAccId>/<subdir>/<name>,返回 {ok,path}。
      writeAsset: async (fileName: string, base64: string, o?: { subdir?: string }) => {
        try {
          const dir = path.join(matrixDir(), 'repost_src', cfg.sourcePlatform || 'src', srcAccId, String((o && o.subdir) || '').replace(/[\\/:*?"<>|]/g, '_'));
          fs.mkdirSync(dir, { recursive: true });
          const safe = String(fileName || `asset_${randInt(1e5, 9e5)}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 160);
          const fp = path.join(dir, safe);
          fs.writeFileSync(fp, Buffer.from(String(base64 || ''), 'base64'));
          return { ok: true, path: fp, dir };
        } catch (err: any) { return { ok: false, reason: String(err?.message || err) }; }
      },
      randInt,
      sleep: (min: number, max?: number) => new Promise<void>((resolve) => {
        const ms = max ? randInt(min, max) : min;
        if (opts.signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
      }),
      waitForCaptchaCleared: makeWaitForCaptcha(srcAccId, log, opts.signal),
      log: (m: string) => coworkLog('INFO', 'repost-collect', m),
    };

    const code = collectPack?.orchestrator;
    if (!code) { log('❌ 采集剧本为空'); return { candidates: [], reason: 'no_collect_orchestrator' }; }
    const fn = new AsyncFunction('ctx', code);
    const ret: any = await fn(ctx);
    const arr = (ret && Array.isArray(ret.candidates)) ? ret.candidates : [];
    const wantVideo = cfg.material === 'video';
    candidates = arr
      .filter((c: any) => c && c.text && (wantVideo ? !!c.video_path : (Array.isArray(c.images) && c.images.length > 0)))
      .map((c: any) => ({
        post_id: String(c.post_id || ''), source_url: c.source_url, author: c.author, text: String(c.text),
        images: Array.isArray(c.images) ? c.images : [], video_path: c.video_path, duration: c.duration,
      }));
    setAccountStatus(srcAccId, 'idle');
    log('采集完成:' + candidates.length + ' 条候选');
    return { candidates };
  } catch (e: any) {
    setAccountStatus(srcAccId, 'idle');
    coworkLog('ERROR', 'binanceRepostRunner', `collect threw: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
    return { candidates: [], reason: 'collect_threw:' + String(e?.message || e).slice(0, 120) };
  } finally {
    // 采集完留 8s 让用户瞄一眼再关采集窗(点停止立即关)。
    if (!opts.signal?.aborted) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 8000); try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ } });
    }
    try { closeKernel(srcAccId); } catch { /* ignore */ }
  }
}

// ═══════════════════════ 阶段B · 单个币安号发布 ═══════════════════════
async function publishOne(
  opts: BinanceRepostTaskOptions, publishPack: any, accountId: string, candidate: RepostCandidate,
): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const cfg = opts.config;
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  if (opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' };
  if (!acc) { log('❌ 跳过:账号不存在'); return { accountId, state: 'skipped', reason: 'account_not_found' }; }
  if (acc.platform !== opts.platform) { log('❌ 跳过:账号平台与任务不符'); return { accountId, state: 'skipped', reason: 'platform_mismatch' }; }
  if (acc.status === 'banned' || acc.status === 'limited') { log('❌ 跳过:账号状态为 ' + acc.status); return { accountId, state: 'skipped', reason: 'account_' + acc.status }; }

  const counts = { like: 0, follow: 0, comment: 0, post: 0 };
  let chargedCredits = 0, chargedUsd = 0;
  const authToken = opts.authToken || getNoobClawAuthToken() || undefined;
  let finished: { status: string; error?: string } | null = null;
  let posted = false;

  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc), groupTitle: matrixGroupTitle(opts.platform, opts.taskId),
    });
    await kernelNavigate(accountId, BINANCE_SQUARE);
    await sleep(2500);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 币安登录态失效,弹窗扫码重连(其它号照跑)');
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(accountId); } catch { /* ignore */ } }
      return { accountId, state: 'skipped', reason: 'login_expired' };
    }
    markAccountAlive(accountId);

    const accKeywords = Array.isArray(acc.keywords) ? acc.keywords.filter((k) => String(k || '').trim()) : [];
    const task: any = {
      id: accountId,
      material: cfg.material || 'image',
      with_image: cfg.withImage !== false,
      language: cfg.language || 'mixed',
      auto_upload: !!cfg.autoPublish,
      persona: acc.persona || '',
      track: acc.track || '',
      keywords: accKeywords,
      source_item: { text: candidate.text, author: candidate.author, source_url: candidate.source_url, images: candidate.images },
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

    const ctx: any = {
      task, config: publishPack?.config || {}, manifest: publishPack?.manifest || {},
      appLocale: cfg.language === 'en' ? 'en' : 'zh',
      aborted: () => !!opts.signal?.aborted,
      browser: browserFn,
      navigate: (url: string) => kernelNavigate(accountId, url),
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
      openTab: async (o: any) => { if (o?.url) { await kernelNavigate(accountId, o.url); await sleep(1500); } return taskTab; },
      getTaskTab: async () => taskTab,
      report: (m: string) => { log(m); try { coworkLog('INFO', 'binanceRepost', `[${accountId}] ${m}`); } catch { /* ignore */ } },
      stepStart: (s: number) => log('▶ 步骤 ' + s),
      stepLog: (_s: number, _st: string, m: string) => log(m),
      stepDone: (_s: number) => {},
      startAction: (..._a: any[]) => {},
      stepResetAll: () => {},
      setActionTargets: (t: any) => { if (typeof t?.post === 'number') log(`🎯 本号目标:发 ${t.post} 条`); },
      addActionCount: (type: string, n: number) => {
        if (type === 'post') { counts.post += Number(n) || 0; posted = true; log(`✅ 已发布 ${counts.post} 条`); }
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      },
      finish: (status: string, error?: string) => { finished = { status, error }; },
      aiCall,
      apiCall,
      saveDrafts: async (arr: any[]) => {
        try {
          const draftsBase = path.join(matrixDir(), 'drafts', opts.platform || 'binance', accountId);
          let lastDir = '';
          for (const d of (Array.isArray(arr) ? arr : [])) {
            const rawId = String(d?.source_post?.external_post_id || `draft_${randInt(1e5, 9e5)}`);
            const safeId = rawId.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
            const dir = path.join(draftsBase, safeId);
            fs.mkdirSync(dir, { recursive: true });
            if (d?.text) { try { fs.writeFileSync(path.join(dir, 'text.txt'), String(d.text), 'utf8'); } catch { /* ignore */ } }
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
        } catch (err: any) { return { ok: false, reason: String(err?.message || err) }; }
      },
      getPrompt: (name: string) => { const t = publishPack?.prompts?.[name]; if (!t) throw new Error('Missing prompt: ' + name); return t; },
      appendKeywords: (_arr: string[]) => { /* matrix: no-op */ },
      sleep: (min: number, max?: number) => new Promise<void>((resolve) => {
        const ms = max ? randInt(min, max) : min;
        if (opts.signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
      }),
      waitForCaptchaCleared: makeWaitForCaptcha(accountId, log, opts.signal),
      randInt,
      log: (m: string) => coworkLog('INFO', 'binanceRepost-orch', m),
    };

    const code = publishPack?.orchestrator;
    if (!code) { log('❌ 发布剧本为空'); return { accountId, state: 'failed', reason: 'no_orchestrator' }; }
    const fn = new AsyncFunction('ctx', code);
    await fn(ctx);

    // 成功发布 → 按搬运形态扣费(repost_image_text / repost_video)。
    if (posted && cfg.autoPublish) {
      const actionType = (cfg.material === 'video') ? 'repost_video' : 'repost_image_text';
      const res: any = await chargeAction(authToken, actionType, 'binance', candidate.source_url || candidate.post_id || '');
      if (res && res.ok) {
        chargedCredits += Number(res.charged) || 0;
        chargedUsd += Number(res.cost_usd) || 0;
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      }
    }

    setAccountStatus(accountId, 'idle');
    const fin = finished as { status: string; error?: string } | null;
    if (fin && fin.status === 'error') return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: fin.error };
    return { accountId, state: posted ? 'success' : 'failed', counts, chargedCredits, chargedUsd, reason: posted ? undefined : 'not_posted' };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    coworkLog('ERROR', 'binanceRepost', `[${accountId}] threw: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
    return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'repost_threw:' + String(e?.message || e).slice(0, 140) };
  } finally {
    if (!opts.signal?.aborted) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 20000); try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ } });
    }
    try { closeKernel(accountId); } catch { /* ignore */ }
  }
}

// 视频文案仿写(rewriter prompt → 纯文本;视频帖正文短,目标 30-180 字)。
async function rewriteVideoCaption(
  publishPack: any, srcText: string, srcAuthor: string, persona: string, language: string,
  authToken: string | undefined, onCost: (c: number, u: number) => void, signal?: AbortSignal,
): Promise<{ ok: boolean; text?: string; reason?: string }> {
  const tpl = publishPack?.prompts?.rewriter;
  if (!tpl) return { ok: false, reason: 'no_rewriter_prompt' };
  // 9 语言映射与 orchestrator 的 LANG_NAME 对齐;mixed/未知 → 中文(与 appLocale 兜底口径一致)。
  const LANG_NAME: Record<string, string> = {
    zh: '简体中文 (Simplified Chinese)', 'zh-tw': '繁体中文 (Traditional Chinese)', en: '英文 (English)',
    ja: '日语 (Japanese)', ko: '韩语 (Korean)', ru: '俄语 (Russian)', fr: '法语 (French)', de: '德语 (German)', vi: '越南语 (Vietnamese)',
  };
  const langName = LANG_NAME[String(language || '').toLowerCase()] || '中文 (Chinese)';
  const min = 30, max = 180, target = 110;
  const prompt = String(tpl)
    .replace(/\{\{persona\}\}/g, persona || '币安广场用户,语气克制不喊单')
    .replace(/\{\{language_name\}\}/g, langName)
    .replace(/\{\{source_text\}\}/g, String(srcText).slice(0, 1200))
    .replace(/\{\{source_author\}\}/g, srcAuthor || '匿名')
    .replace(/\{\{target_chars\}\}/g, String(target))
    .replace(/\{\{min_chars\}\}/g, String(min))
    .replace(/\{\{max_chars\}\}/g, String(max));
  const aiCall = makeAiCall(authToken, onCost, signal);
  try {
    const raw: any = await aiCall('__raw__', prompt, '把上面参考素材里讨论的话题,仿写成一条币安广场视频配文。只输出正文。', { model: 'noobclawai-chat', expectJson: false, max_tokens: 600 });
    let text = String((raw && raw.text) ? raw.text : raw || '').trim().replace(/^```(?:\w+)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    if (!text || text.length < 8) return { ok: false, reason: 'rewrite_too_short' };
    if (text.length > max) text = text.slice(0, max);
    return { ok: true, text };
  } catch (e: any) { return { ok: false, reason: 'rewrite_failed:' + String(e?.message || e).slice(0, 80) }; }
}

// ═══════════════════════ 阶段B · 单个币安号发布【视频】═══════════════════════
// 复用已验证的 binance.js 发布 driver(runMatrixDriver),不重写 inline modal 上传。
async function publishVideoOne(
  opts: BinanceRepostTaskOptions, publishPack: any, accountId: string, candidate: RepostCandidate,
): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const cfg = opts.config;
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  if (opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' };
  if (!acc) { log('❌ 跳过:账号不存在'); return { accountId, state: 'skipped', reason: 'account_not_found' }; }
  if (acc.platform !== opts.platform) { log('❌ 跳过:账号平台不符'); return { accountId, state: 'skipped', reason: 'platform_mismatch' }; }
  if (acc.status === 'banned' || acc.status === 'limited') { log('❌ 跳过:账号状态为 ' + acc.status); return { accountId, state: 'skipped', reason: 'account_' + acc.status }; }
  if (!candidate.video_path) { log('❌ 跳过:候选无视频文件'); return { accountId, state: 'skipped', reason: 'no_video' }; }

  const counts = { like: 0, follow: 0, comment: 0, post: 0 };
  let chargedCredits = 0, chargedUsd = 0;
  const authToken = opts.authToken || getNoobClawAuthToken() || undefined;

  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核(视频发布)');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc), groupTitle: matrixGroupTitle(opts.platform, opts.taskId),
    });
    await kernelNavigate(accountId, BINANCE_SQUARE);
    await sleep(2500);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 币安登录态失效,弹窗扫码重连(其它号照跑)');
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(accountId); } catch { /* ignore */ } }
      return { accountId, state: 'skipped', reason: 'login_expired' };
    }
    markAccountAlive(accountId);

    // 仿写配文(AI token 计入本号扣费)。
    const onAiCost = (c: number, u: number) => {
      chargedCredits += c; chargedUsd += u;
      try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
    };
    log('🧠 仿写视频配文…');
    const cap = await rewriteVideoCaption(publishPack, candidate.text, candidate.author || '匿名', acc.persona || '', cfg.language || 'mixed', authToken, onAiCost, opts.signal);
    if (!cap.ok || !cap.text) { setAccountStatus(accountId, 'idle'); log('❌ 配文仿写失败:' + cap.reason); return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: cap.reason }; }
    log('✍️ 配文:' + cap.text.slice(0, 60) + '…');

    if (!cfg.autoPublish) {
      // 仅本地:不发布,直接算完成(视频已在 repost_src 下载好,配文打日志)。
      setAccountStatus(accountId, 'idle');
      counts.post += 1;
      log('💾 仅生成不发(视频已下载,配文已生成)');
      return { accountId, state: 'success', counts, chargedCredits, chargedUsd };
    }

    // 复用 binance.js 发布 driver:导航币安广场 → 视频 inline modal 上传 + 写正文 + 发文。
    log('📤 上传视频到币安广场(复用发布 driver)…');
    const r = await runMatrixDriver(accountId, 'binance' as any, { videoPath: candidate.video_path, description: cap.text } as any, (m) => log(m));
    if (!r || !r.ok) { setAccountStatus(accountId, 'idle'); log('❌ 视频发布失败:' + (r?.reason || 'unknown')); return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: r?.reason || 'driver_failed' }; }

    counts.post += 1;
    log('✅ 视频已发布');
    // 成功 → 扣 repost_video。
    const chg: any = await chargeAction(authToken, 'repost_video', 'binance', candidate.source_url || candidate.post_id || '');
    if (chg && chg.ok) { chargedCredits += Number(chg.charged) || 0; chargedUsd += Number(chg.cost_usd) || 0; }
    setAccountStatus(accountId, 'idle');
    try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
    return { accountId, state: 'success', counts, chargedCredits, chargedUsd };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    coworkLog('ERROR', 'binanceRepost', `[${accountId}] video threw: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
    return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'repost_video_threw:' + String(e?.message || e).slice(0, 120) };
  } finally {
    if (!opts.signal?.aborted) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 20000); try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ } });
    }
    try { closeKernel(accountId); } catch { /* ignore */ }
  }
}

export async function runBinanceRepostTask(opts: BinanceRepostTaskOptions): Promise<EngageReport> {
  if (!opts.kernelPath && !installedKernelPath()) {
    throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  }
  const accIds = opts.accountIds || [];
  if (!accIds.length) {
    opts.onLog?.('', '⚠️ 本任务未选择任何币安账号');
    return { platform: opts.platform, total: 0, success: 0, failed: 0, skipped: 0, items: [] };
  }
  const cfg = opts.config;
  if (!cfg?.sourceAccountId) {
    for (const id of accIds) opts.onLog?.(id, '❌ 未配置采集号(sourceAccountId),无法搬运');
    return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_source_account' })) };
  }

  const isVideo = cfg.material === 'video';

  // 拉两个剧本:采集(按源平台)+ 发布(币安,图文剧本;视频走 binance.js driver,仅用其 prompts.rewriter)。
  // 抖音视频源 runner 侧采集(复用 douyin_search driver),不需要后端采集剧本;其余源平台走 binance_repost_collect_<platform>。
  const needCollectPack = cfg.sourcePlatform !== 'douyin';
  const collectScenarioId = `binance_repost_collect_${cfg.sourcePlatform}`;
  const [collectPack, publishPack] = await Promise.all([
    needCollectPack ? fetchPack(collectScenarioId) : Promise.resolve(null),
    fetchPack('binance_repost'),
  ]);
  if (needCollectPack && !collectPack?.orchestrator) {
    const reason = `❌ 采集剧本(${collectScenarioId})拉取失败:可能后端未部署该来源平台的采集器`;
    for (const id of accIds) { opts.onLog?.(id, reason); }
    return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_collect_scenario' })) };
  }
  if (!publishPack?.orchestrator) {
    const reason = `❌ 币安发布剧本(binance_repost)拉取失败:可能后端未部署`;
    for (const id of accIds) { opts.onLog?.(id, reason); }
    return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_publish_scenario' })) };
  }

  // 本轮目标条数 = min(币安号数, perRunCount||号数)。采集就采这么多。
  const postCount = Math.max(1, Math.min(accIds.length, Number(cfg.perRunCount) || accIds.length));

  coworkLog('INFO', 'binanceRepostRunner', `repost src=${cfg.sourcePlatform} want=${postCount} → binance x${accIds.length}`);

  // 采集号内容复用计数(默认 cap=1=只用一次)。采集只查(seen.set.has 跳过已用满的),发布成功后才 record。
  const srcSeen = contentUsageStore(cfg.sourceAccountId, cfg.sourcePlatform, REPOST_CONTENT_CAP);

  // ── 阶段A:采集 ──
  if (opts.signal?.aborted) return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'aborted' })) };
  const { candidates, reason: collectReason } = await collectFromSource(opts, collectPack, postCount, srcSeen);
  if (!candidates.length) {
    const r = collectReason || 'no_candidates';
    for (const id of accIds) opts.onLog?.(id, `⚠️ 采集为空(${r}),本次无可搬运素材`);
    return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: r })) };
  }

  // ── 阶段B:分发(顺序执行,每条之间睡 60-120s 防连坐)──
  const items: EngageItemResult[] = [];
  for (let i = 0; i < accIds.length; i++) {
    if (opts.signal?.aborted) { items.push({ accountId: accIds[i], state: 'skipped', reason: 'aborted' }); continue; }
    const candidate = candidates[i];
    if (!candidate) { opts.onLog?.(accIds[i], 'ℹ️ 候选素材已分完,本号本轮不发'); items.push({ accountId: accIds[i], state: 'skipped', reason: 'no_more_candidate' }); continue; }
    const r = isVideo
      ? await publishVideoOne(opts, publishPack, accIds[i], candidate)
      : await publishOne(opts, publishPack, accIds[i], candidate);
    items.push(r);
    // 仅【发布成功】才把这条源计 1 次 → 用满 cap(默认 1)后下轮跳过;发布失败不计,可下轮重试。
    if (r.state === 'success' && candidate.post_id) { try { srcSeen.record(String(candidate.post_id)); } catch { /* ignore */ } }
    try { opts.onItem?.(r); } catch { /* ignore */ }
    // 下一号发布前睡 60-120s(最后一号不睡;停止立即退)。
    const hasNext = i < accIds.length - 1 && !!candidates[i + 1];
    if (hasNext && !opts.signal?.aborted) {
      const gap = randInt(60000, 120000);
      opts.onLog?.(accIds[i + 1], `⏳ 防连坐:距上一条发布间隔 ${Math.round(gap / 1000)}s…`);
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, gap); try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ } });
    }
  }

  return {
    platform: opts.platform, total: items.length,
    success: items.filter((x) => x.state === 'success').length,
    failed: items.filter((x) => x.state === 'failed').length,
    skipped: items.filter((x) => x.state === 'skipped').length,
    items,
  };
}
