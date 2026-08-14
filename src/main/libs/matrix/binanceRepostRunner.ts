/**
 * 矩阵「币安广场批量搬运」运行时(两阶段)—— 把币安广场的「批量搬运」能力带到矩阵多账号。
 *
 * 与其它矩阵任务最大的不同:本任务有【两种账号角色】,跑两个阶段:
 *   阶段A · 采集(1 个采集号):用 config.sourceAccountId(在 sourcePlatform 上已登录)的指纹内核,
 *     跑 binance_repost_collect_<sourcePlatform> 剧本,按关键词搜索 → 筛选 → 下源图,采够 N 条候选。
 *   阶段B · 分发(N 个币安号):把候选逐条分给勾选的币安账号,每号在各自指纹内核里跑 binance_repost
 *     发布剧本(AI 仿写 + 配源图 → 发币安广场),每条之间睡 10-60s,成功一条扣 repost_image_text。
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
import { inspectHoldMs } from './inspectHold';
import { installedKernelPath } from './kernelInstaller';
import { matrixCmd } from './cdpCommands';
import { runMatrixDriver, runMatrixDouyinSearch } from './driverCtx';
import { contentUsageStore, type ContentUsage } from './contentUsage';
import { getAccount, setAccountStatus, effectiveKeywords, appendDerivedKeywords, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey } from './accountManager';
import { promptReloginForExpiredAccount } from './reloginPrompt';
import { getNoobClawAuthToken } from '../claudeSettings';
import type { EngageItemResult, EngageReport } from './engageRunner';
import type { BinanceRepostConfig } from './types';

// 平台显示名 —— 本 runner 服务币安广场 + 四家交易所广场,日志/提示不能写死「币安」。
const REPOST_PLATFORM_LABEL: Record<string, string> = {
  binance: '币安广场', gate: 'Gate广场', bitget: 'Bitget Insight', bybit: 'Bybit Byx', okx: 'OKX星球',
};
function platLabel(p: string): string { return REPOST_PLATFORM_LABEL[p] || p; }
// 能做【视频搬运】的目标平台 = 有 backend/matrix/drivers/<平台>.js 视频发布 driver 的平台。
// 不在表里的平台走视频模式会被提前拦住(否则素材都下完了才在发布那步失败,时间和带宽全白花)。
// 2026-08-03 真机逐个验过各交易所广场的发帖框:
//   · gate  ✅ 支持视频,input[accept=video/*] 常驻 DOM(drivers/gate.js 已实现)
//   · okx   ❌ 内联框和完整编辑器都只有 image/png,jpg,jpeg,gif,全页无视频入口 —— 平台就没这功能
//   · bitget ✅ 展开发帖框后 input[accept=video/mp4] 就在 DOM 里(drivers/bitget.js 已实现)
//   · bybit ✅ 平台支持(/social/publish 有 Photos|Video tab,≤200MB),但 input 要点「Add video」
//            才创建,得走 TikTok 那套 chooser 拦截 —— driver 还没写,所以先不开
const VIDEO_REPOST_PLATFORMS = new Set<string>(['binance', 'gate', 'bitget', 'bybit']);

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function matrixDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }

const BINANCE_SQUARE = 'https://www.binance.com/square';
// 发布号登录预检导航的广场页(按【发布平台】取)。⚠️ 这里原来写死 BINANCE_SQUARE:本 runner 服务
//   币安 + 交易所四家,把 Gate/Bitget/Bybit/OKX 的号也导到【币安广场】上做登录判定 —— 各平台的判据
//   (Gate 的「我的主页」链接、Bitget 的同域接口、OKX 的侧栏 uid)在别人家的域上全都拿不到答案。
//   与 binancePostRunner.BINANCE_LOGIN_HOME 保持一致。
const PUBLISH_HOME: Record<string, string> = {
  binance: BINANCE_SQUARE,
  gate: 'https://www.gate.com/post',
  bitget: 'https://www.bitget.com/insights',
  bybit: 'https://www.bybit.com/social/',
  okx: 'https://www.okx.com/orbit',
};
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
  concurrency?: number;             // 此处忽略:分发阶段顺序执行(每条睡 10-60s)
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

// 搬运的复用上限固定为 1 =【一个平台一条源内容只搬一次】(用户 2026-08-04 明确要求),
// 所以这里【不再】读 env MATRIX_CONTENT_REUSE_CAP —— 那个 env 只影响爆款仿写等其它生产型任务。
const REPOST_CONTENT_CAP = 1;

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

/**
 * 源文案指纹 —— 给拿不到平台侧稳定 id 时当去重 key 用。
 * 同一条作品的文案不会变,所以它跨运行稳定;而 CDN 地址每次都变,绝不能拿来当 id。
 * 归一化掉空白和标点,避免平台偶尔多个空格就算成新的一条。
 */
function textFingerprint(s: string): string {
  const norm = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 120);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < norm.length; i++) {
    const c = norm.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

/** 源文案在去重账本里的 key(与平台 id 分开存,前缀避免撞上真实 id)。文案太短不足以标识内容 → 不用。 */
function capKeyOf(text: string): string {
  const t = String(text || '').trim();
  if (t.length < 10) return '';
  return 'cap_' + textFingerprint(t);
}

// 抖音视频源:复用 douyin_search driver(返回无水印 play_addr urls + 同序 titles 文案 + 同序 post_ids),runner 侧逐个下载。
// 结构【照搬小红书采集剧本 binance_repost_collect_xhs】,因为它早就把这件事做对了:
//   洗牌关键词 → 每轮最多试 KW_CAP 个 → 一个词一个词地搜、筛完累加 →【不够就换下一个词】
//   → 全都搜尽再让 AI 衍生新词存进池子,下轮启用。
//
// 🚨 抖音这条原来是【一次性把所有词丢给 driver】。driver 取够 want 条就收手,而【去重发生在
//   它外面】—— 它压根不知道那几条我们早搬过了。于是 1 条/次的任务只让它取 2 条,两条一撞车,
//   过滤完剩 0,报「采集为空」,而命中的十几条和另外十几个关键词全晾着,用户还会觉得
//   「从来没见他换关键词」(2026-08-05 实测)。更糟的是它【自锁】:采不到就发不出,发不出就
//   不会写新记录,driver 那份名单永远补不上,下一轮照样空。
//   小红书没这毛病,是因为它的去重在采集循环【里面】,发现这条用过就接着往下找。
//   现在抖音也按词分轮:每轮只搜一个词,筛完不够就换词再搜,和小红书同构。
async function collectDouyinVideos(
  opts: BinanceRepostTaskOptions, srcAccId: string, keywords: string[], want: number,
  seen: ContentUsage, log: (m: string) => void, authToken?: string,
): Promise<RepostCandidate[]> {
  const out: RepostCandidate[] = [];
  if (!keywords.length) { log('⚠️ 采集号没有关键词,无法搜索'); return out; }
  const dir = path.join(matrixDir(), 'repost_src', 'douyin', srcAccId, '原文');
  const pickedLocal = new Set<string>();   // 本轮内去重(seen.set 只含已用满的)

  // 洗牌:driver 永远从第一个词搜起,不洗牌的话配 20 个词也只有最前面一两个长期在出力。
  const shuffled = keywords.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // 🚨 采集预算必须随 want 走:每号条数上限放到 100 后,原来「≤4 词 × 每词 ≤20 条」的
  //    结构上限只有 80 条,去重/文案过短/下载失败再打个折 —— 用户拉满滑条却只采到几十条,
  //    跟 bilibili/kuaishou「每词固定 12 张跑不满」同一类病(2026-08-14 审计发现)。
  //    词数按「每词 20 条」够 want 来算(封顶全部词);每词候选 20 保底、随人均需求放大。
  const KW_CAP = Math.min(shuffled.length, Math.max(4, Math.ceil(want / 20)));
  // 每个词让 driver 多取几条当候选池 —— 筛掉搬过的之后才有得挑(同小红书 POOL_MULT)。
  const poolWant = Math.min(Math.max(want * 3, 6), Math.max(20, Math.ceil(want * 1.5 / Math.max(1, KW_CAP))));
  log(`🎬 抖音采集 · 关键词 ${keywords.length} 个(本轮随机试 ≤${KW_CAP} 个)· 目标 ${want} 条`);

  /** 单个关键词:搜一遍 → 逐条筛(已搬过/文案过短/下载失败都跳)→ 累加到 out。 */
  const collectForKeyword = async (kw: string): Promise<void> => {
    const r = await runMatrixDouyinSearch(srcAccId, [kw], poolWant, 'video', (m) => log(m), seen.set);
    const urls = Array.isArray(r.urls) ? r.urls : [];
    const titles = Array.isArray(r.titles) ? r.titles : [];
    const postIds = Array.isArray(r.postIds) ? r.postIds : [];
    if (!urls.length) { log('   ⚠️ 该词没取到视频:' + (r.reason || 'empty')); return; }
    log(`   「${kw}」候选 ${urls.length} 条`);
    for (let i = 0; i < urls.length && out.length < want; i++) {
      if (opts.signal?.aborted) break;
      const u = String(urls[i] || '');
      if (!/^https?:\/\//i.test(u)) continue;
      const cap = String(titles[i] || '').trim();
      if (cap.length < 6) { log('   ⏭ 文案过短,跳过'); continue; }   // 仿写需要源文案
      // 去重 id 必须【跨运行稳定】。老写法从视频地址抓数字,而抖音无水印 play_addr 是带签名和
      //   expire 的临时 CDN 地址,同一条作品每次搜出来都不一样(抓不到还回落随机数)—— 等于没去重。
      //   现在优先用 driver 返回的 aweme_id;老 driver 没这字段就回落源文案指纹,同样跨运行稳定。
      const id = String(postIds[i] || '').trim() || `dycap_${textFingerprint(cap)}`;
      if (seen.set.has(id) || pickedLocal.has(id)) { log('   ⏭ 这条已经搬过,跳过'); continue; }
      pickedLocal.add(id);
      const dest = path.join(dir, `repost_douyin_${id}.mp4`);
      log(`📥 下载无水印视频 ${out.length + 1}/${want}…`);
      const ok = await downloadVideoUrl(srcAccId, u, dest, 'https://www.douyin.com/', opts.signal);
      if (!ok) { log('   ⏭ 下载失败,跳过'); continue; }
      out.push({ post_id: id, source_url: u, author: '抖音用户', text: cap.slice(0, 1500), images: [], video_path: dest });
      log(`   ✅ 采到 ${out.length}/${want} 条(文案 ${cap.length} 字)`);
    }
  };

  for (let ki = 0; ki < KW_CAP && out.length < want; ki++) {
    if (opts.signal?.aborted) break;
    const kw = shuffled[ki];
    log(`🔍 关键词「${kw}」(${ki + 1}/${KW_CAP})`);
    const before = out.length;
    // 单个词出错(命令异常/页面解析等)不该让整条采集崩 —— 记下来换下一个词(同小红书)。
    try { await collectForKeyword(kw); }
    catch (e: any) { log(`   ⚠️ 关键词「${kw}」采集出错(跳过):${String(e?.message || e).slice(0, 140)}`); }
    if (out.length === before) log('   该词本轮无新素材,换下一个');
  }

  // 一条都没采到 = 这批词的内容都搬过了 → 让 AI 衍生一批新词存进衍生池,下轮就有新料可搜。
  if (out.length === 0 && !opts.signal?.aborted) {
    log('🧺 本轮没采到新素材(这些关键词的内容可能都搬过了),尝试衍生新关键词…');
    await deriveDouyinKeywords(srcAccId, shuffled, authToken, opts.signal, log);
  }
  // 采不满就明说差多少 —— 否则「目标 100 实采 30」在 UI 上只体现为发得少,查不出是采集端瓶颈。
  if (out.length < want) log(`🧺 采集完成:目标 ${want} 条,实采 ${out.length} 条(去重/过滤后素材不够;可加关键词或降低每号条数)`);
  else log(`🧺 采集完成:共 ${out.length} 条候选`);
  return out;
}

/**
 * 关键词搜尽 → 让 AI 衍生一批同赛道新词,存进【衍生池】(原始词一个不动),下一轮 effectiveKeywords 自动带上。
 * 对齐小红书采集剧本的 deriveAndPersistKeywords;失败只记日志,绝不让采集因此失败。
 */
async function deriveDouyinKeywords(
  srcAccId: string, usedKeywords: string[], authToken: string | undefined,
  signal: AbortSignal | undefined, log: (m: string) => void,
): Promise<void> {
  if (!authToken) { log('   ⚠️ 未登录,跳过关键词衍生'); return; }
  try {
    const aiCall = makeAiCall(authToken, undefined, signal);
    const sys = '你是中文短视频选题助手。根据给定的一组抖音搜索关键词,推测它们所属的赛道,'
      + '再给出 8 个【同赛道但更具体、说法不同】的新搜索词,用来在抖音搜到不一样的视频。'
      + '要求:每个 2-8 个中文字;不要与给定词重复;不要英文、不要标点、不要话题符号;'
      + '只输出 JSON:{"keywords":["词1","词2"]}';
    const raw = await aiCall('__raw__', sys, '已用过的关键词:' + usedKeywords.slice(0, 12).join('、'), { max_tokens: 400 });
    const txt = typeof raw === 'string' ? raw : (raw?.content || raw?.text || JSON.stringify(raw || ''));
    let words: string[] = [];
    try {
      const m = String(txt).match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      if (parsed && Array.isArray(parsed.keywords)) words = parsed.keywords;
    } catch { /* 解析不了就算了 */ }
    const clean = words.map((w) => String(w || '').trim()).filter((w) => w && w.length <= 12).slice(0, 8);
    if (!clean.length) { log('   ⚠️ 没能衍生出新关键词'); return; }
    appendDerivedKeywords(srcAccId, clean);
    log(`   ✨ 已衍生 ${clean.length} 个新关键词(下轮启用):${clean.join('、')}`);
  } catch (e: any) {
    log('   ⚠️ 关键词衍生失败:' + String(e?.message || e).slice(0, 100));
  }
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

  // 关键词:【按发布号的赛道取,不是采集号的】。cfg.keyword 仅作老任务/可选覆盖兼容。
  // 🚨 这里原来用的是采集号(acc)自己的关键词,方向反了:采集号只是"借它的登录态去源平台搜"的
  //    工具人 —— 一个小红书美食号的赛道词是「美食探店 / 一人食 / 家常菜」,拿这些去搜素材再发到
  //    币安/Gate/OKX 这类 web3 广场,内容完全不对路(用户实拍反馈)。
  //    搬运要的是【发布平台那边想要的内容】,所以取【本任务勾选的发布号】的赛道关键词并集
  //    (采集只跑一次、候选池给所有发布号共用,故取并集而不是某一个号的)。
  const pubKw: string[] = [];
  for (const pid of (opts.accountIds || [])) {
    const pa = getAccount(pid);
    if (!pa) continue;
    for (const k of effectiveKeywords(pa)) {
      const kk = String(k || '').trim();
      if (kk && pubKw.indexOf(kk) < 0) pubKw.push(kk);
    }
  }
  // 发布号一个关键词都没配 → 退回采集号的词,至少还能跑起来(并明确告知,别让用户以为设置生效了)。
  const usedSrcKw = pubKw.length === 0;
  const keywords = (cfg.keyword && String(cfg.keyword).trim())
    ? [String(cfg.keyword).trim()]
    : (usedSrcKw ? effectiveKeywords(acc) : pubKw);
  if (!keywords.length) {
    log(`❌ ${platLabel(opts.platform)}发布号没有关键词 —— 去「我的矩阵账号」给发布号加几个赛道关键词(搬运搜什么由发布号的赛道决定)`);
    return { candidates: [], reason: 'no_keywords' };
  }
  if (usedSrcKw && !(cfg.keyword && String(cfg.keyword).trim())) {
    log(`⚠️ ${platLabel(opts.platform)}发布号没配赛道关键词,暂时退回用采集号的词搜 —— 建议给发布号配上自己的赛道词,否则搜到的素材跟发布平台不对路`);
  }

  const authToken = opts.authToken || getNoobClawAuthToken() || undefined;
  // seen 由 runBinanceRepostTask 创建并传入:采集阶段【只查不记】(seen.set.has 跳过已用满的),
  // 真正计数(record)挪到【发布成功后】—— 下载了但没发出去不算一次,可下轮重试(用户要求)。
  let candidates: RepostCandidate[] = [];
  // launch 失败时 kernelPool 已回退本次的引用计数/使用锁,finally 不能再 closeKernel(会错关/错放别的流程)。
  let kernelLaunched = false;

  try {
    setAccountStatus(srcAccId, 'running');
    log('启动采集号指纹内核');
    await launchKernel({
      accountId: srcAccId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc), groupTitle: matrixGroupTitle(cfg.sourcePlatform, opts.taskId),
    });
    kernelLaunched = true;
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
      const dyCands = await collectDouyinVideos(opts, srcAccId, keywords, want, seen, log, authToken);
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
    if (kernelLaunched) { try { closeKernel(srcAccId); } catch { /* ignore */ } }
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
  // launch 失败时 kernelPool 已回退本次的引用计数/使用锁,finally 不能再 closeKernel(会错关/错放别的流程)。
  let kernelLaunched = false;

  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc), groupTitle: matrixGroupTitle(opts.platform, opts.taskId),
    });
    kernelLaunched = true;
    await kernelNavigate(accountId, PUBLISH_HOME[opts.platform] || BINANCE_SQUARE);
    await sleep(2500);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log(`⚠️ ${platLabel(opts.platform)}登录态失效,弹窗扫码重连(其它号照跑)`);
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
      const res: any = await chargeAction(authToken, actionType, opts.platform, candidate.source_url || candidate.post_id || '');
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
    // 普通 20s;撞到登录墙/验证墙留 60s,好让用户当场手动登录/过验证(2026-07-06 用户要求)。
    const holdMs = inspectHoldMs(finished?.error);
    if (!opts.signal?.aborted) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, holdMs); try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ } });
    }
    if (kernelLaunched) { try { closeKernel(accountId); } catch { /* ignore */ } }
  }
}

// 视频文案仿写(rewriter prompt → 纯文本;视频帖正文短,目标 30-180 字)。
async function rewriteVideoCaption(
  publishPack: any, srcText: string, srcAuthor: string, persona: string, language: string,
  authToken: string | undefined, onCost: (c: number, u: number) => void, signal?: AbortSignal,
  platform?: string,
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
    .replace(/\{\{persona\}\}/g, persona || `${platLabel(platform || 'binance')}用户,语气克制不喊单`)
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
  let closeReason: string | undefined;   // 收口给 finally 判是否撞墙(此函数走 driver,无 finished 闭包)

  // launch 失败时 kernelPool 已回退本次的引用计数/使用锁,finally 不能再 closeKernel(会错关/错放别的流程)。
  let kernelLaunched = false;
  try {
    setAccountStatus(accountId, 'running');
    log('启动指纹内核(视频发布)');
    await launchKernel({
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      label: accountBadgeLabel(acc), groupTitle: matrixGroupTitle(opts.platform, opts.taskId),
    });
    kernelLaunched = true;
    await kernelNavigate(accountId, PUBLISH_HOME[opts.platform] || BINANCE_SQUARE);
    await sleep(2500);
    let loggedIn = true;
    try { loggedIn = await checkKernelLogin(accountId, platformKey(acc)); } catch { loggedIn = true; }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log(`⚠️ ${platLabel(opts.platform)}登录态失效,弹窗扫码重连(其它号照跑)`);
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
    const cap = await rewriteVideoCaption(publishPack, candidate.text, candidate.author || '匿名', acc.persona || '', cfg.language || 'mixed', authToken, onAiCost, opts.signal, opts.platform);
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
    log(`📤 上传视频到${platLabel(opts.platform)}(复用发布 driver)…`);
    const r = await runMatrixDriver(accountId, opts.platform as any, { videoPath: candidate.video_path, description: cap.text } as any, (m) => log(m));
    if (!r || !r.ok) { closeReason = r?.reason; setAccountStatus(accountId, 'idle'); log('❌ 视频发布失败:' + (r?.reason || 'unknown')); return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: r?.reason || 'driver_failed' }; }

    counts.post += 1;
    log('✅ 视频已发布');
    // 成功 → 扣 repost_video。
    const chg: any = await chargeAction(authToken, 'repost_video', opts.platform, candidate.source_url || candidate.post_id || '');
    if (chg && chg.ok) { chargedCredits += Number(chg.charged) || 0; chargedUsd += Number(chg.cost_usd) || 0; }
    setAccountStatus(accountId, 'idle');
    try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
    return { accountId, state: 'success', counts, chargedCredits, chargedUsd };
  } catch (e: any) {
    setAccountStatus(accountId, 'idle');
    coworkLog('ERROR', 'binanceRepost', `[${accountId}] video threw: ${String(e?.stack || e?.message || e).slice(0, 300)}`);
    return { accountId, state: 'failed', counts, chargedCredits, chargedUsd, reason: 'repost_video_threw:' + String(e?.message || e).slice(0, 120) };
  } finally {
    // 普通 20s;撞到登录墙/验证墙留 60s,好让用户当场手动登录/过验证(2026-07-06 用户要求)。
    const holdMs = inspectHoldMs(closeReason);
    if (!opts.signal?.aborted) {
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, holdMs); try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ } });
    }
    if (kernelLaunched) { try { closeKernel(accountId); } catch { /* ignore */ } }
  }
}

/**
 * 把候选素材按【各发布号自己的赛道关键词】分给对应的号。
 *
 * 为什么需要:采集只跑一次,用的是所有发布号关键词的【并集】。若勾选的号赛道不同
 * (号1 DeFi / 号2 NFT / 号3 Meme),并集搜回来的候选是混着的 —— 原来按下标硬分
 * (candidates[i] → accIds[i]),号1 很可能拿到一条 Meme 素材,内容跟它自己的赛道不搭。
 *
 * 做法(贪心两轮,不额外开采集):
 *   ① 逐号从未分配的候选里挑一条【正文命中该号关键词】的;
 *   ② 没匹配上的号,再按顺序补剩下的候选(总比不发强)。
 * 返回与 accIds 等长的数组,元素可能为 null(候选不够)。
 */
function allocateByNiche(accIds: string[], candidates: RepostCandidate[]): Array<RepostCandidate | null> {
  const assigned: Array<RepostCandidate | null> = new Array(accIds.length).fill(null);
  const taken = new Set<number>();

  // ① 精确匹配:命中该号任一关键词的候选优先给它
  for (let i = 0; i < accIds.length; i++) {
    const acc = getAccount(accIds[i]);
    const kws = acc
      ? effectiveKeywords(acc).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (!kws.length) continue;
    for (let j = 0; j < candidates.length; j++) {
      if (taken.has(j)) continue;
      const text = String(candidates[j]?.text || '').toLowerCase();
      if (!text) continue;
      if (kws.some((k) => text.indexOf(k) >= 0)) { assigned[i] = candidates[j]; taken.add(j); break; }
    }
  }

  // ② 兜底:没匹配上的号按顺序领剩下的
  let p = 0;
  for (let i = 0; i < accIds.length; i++) {
    if (assigned[i]) continue;
    while (p < candidates.length && taken.has(p)) p++;
    if (p >= candidates.length) break;
    assigned[i] = candidates[p]; taken.add(p);
  }
  return assigned;
}

export async function runBinanceRepostTask(opts: BinanceRepostTaskOptions): Promise<EngageReport> {
  if (!opts.kernelPath && !installedKernelPath()) {
    throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  }
  const accIds = opts.accountIds || [];
  if (!accIds.length) {
    opts.onLog?.('', `⚠️ 本任务未选择任何${platLabel(opts.platform)}账号`);
    return { platform: opts.platform, total: 0, success: 0, failed: 0, skipped: 0, items: [] };
  }
  // 视频搬运需要该平台的视频发布 driver(backend/matrix/drivers/<平台>.js)。交易所广场四家
  // 只做发帖 + 互动、没有 driver —— 必须在【采集开始前】拦住:否则会先把 N 条视频下载完
  // (耗时 + 带宽 + 可能已扣采集费),一路跑到 runMatrixDriver 才失败。
  if (opts.config?.material === 'video' && !VIDEO_REPOST_PLATFORMS.has(opts.platform)) {
    const reason = `❌ ${platLabel(opts.platform)}不支持视频搬运(该平台没有视频发布能力),请把素材类型改成图文`;
    for (const id of accIds) opts.onLog?.(id, reason);
    return {
      platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length,
      items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'video_repost_unsupported' })),
    };
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
    fetchPack(`${opts.platform}_repost`),
  ]);
  if (needCollectPack && !collectPack?.orchestrator) {
    const reason = `❌ 采集剧本(${collectScenarioId})拉取失败:可能后端未部署该来源平台的采集器`;
    for (const id of accIds) { opts.onLog?.(id, reason); }
    return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_collect_scenario' })) };
  }
  if (!publishPack?.orchestrator) {
    const reason = `❌ ${platLabel(opts.platform)}发布剧本(${opts.platform}_repost)拉取失败:可能后端未部署`;
    for (const id of accIds) { opts.onLog?.(id, reason); }
    return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'no_publish_scenario' })) };
  }

  // 每号每轮搬几条(1-10,默认 1 = 老行为)。老任务没有这个字段 → 仍是一号一条。
  //   ⚠️ 用新字段而不是复用 perRunCount:后者的语义是【本轮总条数】且被号数封顶,
  //   老任务里存的值按那个语义解释,直接改语义会让老任务的行为悄悄变掉。
  const perAcc = Math.max(1, Math.min(100, Number(cfg.perAccountCount) || 1));
  // 采集目标 = 号数 × 每号条数(老行为下 perAcc=1,等于原来的号数)。
  //   原来还额外 min(号数),那是因为「一个号只领一条」;现在一个号能领多条,这个封顶就不成立了。
  const postCount = Math.max(1, accIds.length * perAcc);

  coworkLog('INFO', 'binanceRepostRunner', `repost src=${cfg.sourcePlatform} want=${postCount} → binance x${accIds.length}`);

  // 搬运去重 —— 口径是【发布平台 × 源内容】:某条源内容在某个平台搬成功过一次,这个平台以后
  //   就不再搬它;但【别的平台还能搬】。
  // 🚨 原来按【采集号】记(contentUsageStore(sourceAccountId, sourcePlatform)):同一个小红书采集号
  //   喂 Gate 和 Bitget 两个任务时,Gate 先发成功就把这条记满了,Bitget 再也拿不到 —— 一条内容
  //   全网只能用一次,交易所越多越明显(用户 2026-08-04 提出按平台各记各的)。
  //   现在改成按发布平台建库(账号位写 `_platform_<平台>`),文件落
  //   content_usage/<源平台>/_platform_<发布平台>.json;cap 固定 1 = 一个平台最多搬一次。
  //   注:同平台多个发布号共用这一份记录,所以 A 号发过的内容 B 号也不会再发(符合"一个平台一次")。
  const srcSeen = contentUsageStore(`_platform_${opts.platform}`, cfg.sourcePlatform, REPOST_CONTENT_CAP);

  // ── 阶段A:采集 ──
  if (opts.signal?.aborted) return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'aborted' })) };
  const collected = await collectFromSource(opts, collectPack, postCount, srcSeen);
  const collectReason = collected.reason;
  // 【第二把锁:源文案指纹】。平台 id 那把锁认的是"这条帖子",指纹认的是"这段内容",两者都记、
  //   任一命中就跳过。加这道是因为光靠 id 有三种情况会漏:
  //     ① 历史包用【随机数】当抖音的 id 记过账(见 collectDouyinVideos 的注释),那些记录永远
  //        对不上今天的 aweme_id —— 老素材还会再搬一次,之后才开始正确记账;
  //     ② 账本换过 key(f8cd46a 从"采集号"改成"发布平台")→ 旧账作废,全部当新的重搬一轮;
  //     ③ 同一条内容被转发/在不同关键词下重出,平台给的 id 未必是同一个。
  //   文案不会因为这些而变,所以它兜得住。放在这里过滤,四个源(含走剧本的 xhs/x/tiktok)一起生效,
  //   backend 的采集剧本一行都不用改。
  const candidates = collected.candidates.filter((c) => {
    const key = capKeyOf(c.text);
    if (!key) return true;
    if (srcSeen.set.has(key)) { coworkLog('INFO', 'binanceRepostRunner', 'skip by caption fingerprint: ' + key); return false; }
    return true;
  });
  const dropped = collected.candidates.length - candidates.length;
  if (dropped > 0) for (const id of accIds) opts.onLog?.(id, `♻️ 跳过 ${dropped} 条搬过的内容(按源文案比对)`);
  if (!candidates.length) {
    const r = collectReason || 'no_candidates';
    for (const id of accIds) opts.onLog?.(id, `⚠️ 采集为空(${r}),本次无可搬运素材`);
    return { platform: opts.platform, total: accIds.length, success: 0, failed: 0, skipped: accIds.length, items: accIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: r })) };
  }

  // 按各号自己的赛道把候选分配好 —— 采集用的是所有发布号关键词的并集,若各号赛道不同,
  // 按下标硬分会让 DeFi 的号拿到 Meme 素材。命中关键词的优先给对应的号,剩下的再顺次补。
  const allocated = allocateByNiche(accIds, candidates);
  const matchedCount = allocated.filter((c, i) => {
    if (!c) return false;
    const acc = getAccount(accIds[i]);
    const kws = acc ? effectiveKeywords(acc).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean) : [];
    const text = String(c.text || '').toLowerCase();
    return kws.some((k) => text.indexOf(k) >= 0);
  }).length;
  if (candidates.length > 1 && accIds.length > 1) {
    for (const id of accIds) {
      opts.onLog?.(id, `🎯 素材按赛道分配:${matchedCount}/${accIds.length} 个号拿到贴合自己关键词的素材`
        + (matchedCount < accIds.length ? '(其余按顺序补,可能不完全对口)' : ''));
    }
  }

  // ── 发布计划:每号 perAcc 条。按【轮次】铺开(第 1 轮每号各一条,第 2 轮再各一条…),
  //   而不是同一个号连着发 perAcc 条 —— 这样同号两条之间天然隔着其它号的发布 + 各自的
  //   10-60s 间隔,节奏更像真人,也避免同一账号短时间内连续发帖被平台盯上。
  //   每轮都重新 allocateByNiche 一次,让本轮剩余候选继续按各号赛道就近分配。
  const plan: Array<{ accountId: string; candidate: any }> = [];
  {
    let pool = candidates.slice();
    for (let round = 0; round < perAcc && pool.length; round++) {
      const alloc = round === 0 ? allocated : allocateByNiche(accIds, pool);
      const used = new Set<any>();
      for (let i = 0; i < accIds.length; i++) {
        const c = alloc[i];
        if (!c || used.has(c)) continue;
        plan.push({ accountId: accIds[i], candidate: c });
        used.add(c);
      }
      if (!used.size) break;                       // 这一轮一条都没分出去 → 池子对不上,别空转
      pool = pool.filter((c) => !used.has(c));
    }
  }
  if (perAcc > 1) {
    for (const id of accIds) opts.onLog?.(id, `📋 本轮计划发布 ${plan.length} 条(每号最多 ${perAcc} 条,按轮次交替)`);
  }
  // 🚨 一条都没分到的号必须补一条 skipped。改成按 plan 迭代后,这些号在 items 里【完全消失】,
  //   而 sidecar 只按 items 回填每号状态(runP.then 里 `for (const it of report.items)`)——
  //   没出现的号会永远停在「运行中」,运行记录里也查无此号。旧代码本来有这条(no_more_candidate),
  //   重构时被我一并删掉了,审计时才发现。
  const planned = new Set(plan.map((p) => p.accountId));
  const preItems: EngageItemResult[] = [];
  for (const id of accIds) {
    if (planned.has(id)) continue;
    opts.onLog?.(id, 'ℹ️ 候选素材已分完,本号本轮不发');
    const it: EngageItemResult = { accountId: id, state: 'skipped', reason: 'no_more_candidate' };
    preItems.push(it);
    try { opts.onItem?.(it); } catch { /* ignore */ }
  }

  // ── 阶段B:分发(顺序执行,每条之间睡 10-60s 防连坐)──
  // 🚨 只选 1 个号 + 每号多条时,轮次交错退化成【同号连发】:publishOne 每条结尾都关内核,
  //    休息期间窗口被关、下一条再冷启动(用户 2026-08-14 在发帖任务实拍的同款问题)。
  //    单号场景用 skipLease 多拿一份引用把窗口吊住整个分发阶段(多号交错时各号窗口本就轮换,
  //    全吊着会同时挂一排浏览器,不吊)。同 binancePostRunner 的说明。
  let repostHoldId = '';
  if (accIds.length === 1 && plan.length > 1) {
    const hAcc = getAccount(accIds[0]);
    if (hAcc) {
      try {
        await launchKernel({
          accountId: accIds[0], kernelPath: opts.kernelPath, kernelVersion: hAcc.kernelVersion,
          userDataDir: hAcc.userDataDir, fingerprint: hAcc.fingerprint, proxy: hAcc.proxy,
          label: accountBadgeLabel(hAcc),
          groupTitle: matrixGroupTitle(opts.platform, opts.taskId),
          skipLease: true,
        });
        repostHoldId = accIds[0];
      } catch { /* 拿不到就退回逐条开关的老行为 */ }
    }
  }
  const items: EngageItemResult[] = preItems.slice();   // 先带上「没分到素材」的那些号
  try {
  for (let i = 0; i < plan.length; i++) {
    if (opts.signal?.aborted) { items.push({ accountId: plan[i].accountId, state: 'skipped', reason: 'aborted' }); continue; }
    const candidate = plan[i].candidate;
    const r = isVideo
      ? await publishVideoOne(opts, publishPack, plan[i].accountId, candidate)
      : await publishOne(opts, publishPack, plan[i].accountId, candidate);
    items.push(r);
    // 仅【发布成功】才把这条源计 1 次 → 用满 cap(默认 1)后下轮跳过;发布失败不计,可下轮重试。
    // 两把锁一起记:平台 id(认这条帖子)+ 源文案指纹(认这段内容,见上面 candidates 过滤处的说明)。
    if (r.state === 'success') {
      try { if (candidate.post_id) srcSeen.record(String(candidate.post_id)); } catch { /* ignore */ }
      try { const ck = capKeyOf(candidate.text); if (ck) srcSeen.record(ck); } catch { /* ignore */ }
    }
    try { opts.onItem?.(r); } catch { /* ignore */ }
    // 下一条发布前睡 10-60s(最后一条不睡;停止立即退)。同号连发也走这条 = 1~2 分钟间隔。
    const hasNext = i < plan.length - 1;
    if (hasNext && !opts.signal?.aborted) {
      const gap = randInt(10000, 60000);
      opts.onLog?.(plan[i + 1].accountId, `⏳ 防连坐:距上一条发布间隔 ${Math.round(gap / 1000)}s…`);
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, gap); try { opts.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ } });
    }
  }
  } finally {
    if (repostHoldId) { try { closeKernel(repostHoldId, { skipLease: true }); } catch { /* ignore */ } }
  }

  return {
    platform: opts.platform, total: items.length,
    success: items.filter((x) => x.state === 'success').length,
    failed: items.filter((x) => x.state === 'failed').length,
    skipped: items.filter((x) => x.state === 'skipped').length,
    items,
  };
}
