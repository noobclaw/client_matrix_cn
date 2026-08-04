/**
 * seedanceProvider — 「AI 自动成片」的视频片段生成(走 NoobClaw 服务端代理 Seedance）。
 *
 * 架构(对齐 stockProvider / billing 的"重活在服务端、key 不下发"原则):
 *   · ARK key 在服务端(backend/src/routes/video.ts 的 /api/video/seedance/*)。
 *   · 客户端只发 { prompt, imageUrls(参考图 base64), duration, ratio, resolution },
 *     由服务端【先扣费再提交】Ark 异步任务,返回 taskId + chargeId;失败服务端幂等退款。
 *   · 客户端轮询 /status/:taskId 拿 succeeded 的 video_url,直接从公网 CDN 下载到本地
 *     (mp4 字节不经我们服务器,省带宽,跟 stock 下载一个路子)。
 *
 * 计费:每个片段在服务端按【时长 × 分辨率档】扣积分(seedance_price_cny_per_sec)。
 *   片段失败(Ark 拒绝/任务 failed)服务端按 chargeId 自动退款,客户端无需补偿。
 *
 * 成本控制(对齐用户"以最低成本生成最好视频"):
 *   · 默认 720p(分辨率倍率 1×),关键镜才上 1080p。
 *   · 每镜时长按该镜配音时长 clamp 到 [minDur, 12],不无脑拉满。
 *   · 限并发(Ark 账号级限流),逐镜失败优雅降级(交给 pipeline 用参考图/邻镜兜底)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { runFfmpeg } from './ffmpegRuntime';
import { getNoobClawAuthToken } from '../claudeSettings';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

export type SeedanceResolution = '480p' | '720p' | '1080p';
export type SeedanceRatio = '9:16' | '16:9' | '1:1' | 'adaptive';
/** 模型档位:lite(1.0 Lite) | pro(1.0 Pro) | pro15(1.5 Pro,默认) | v2(2.0)。服务端映射真实模型 ID + 价格。 */
export type SeedanceTier = 'lite' | 'pro' | 'pro15' | 'v2';

export interface SeedanceSceneSpec {
  /** 该镜的画面 prompt(英文/中文均可,Seedance 双语)。 */
  prompt: string;
  /** 该镜目标时长(秒);内部 clamp 到 [4,12](1.5-pro 下限 4)。 */
  durationSec: number;
  /** 该镜【故事板首帧】data URL(故事板模式 i2v);有则用它做图生视频,无则退化文生视频。 */
  keyframeDataUrl?: string;
}

export interface SeedanceClipResult {
  /** 该镜成片本地路径;失败为 null(pipeline 据此降级)。 */
  path: string | null;
  /** 失败原因(供日志)。 */
  error?: string;
  /** 该镜实扣积分(服务端 create 时扣;失败镜服务端已退,不计入总额)。 */
  chargedTokens?: number;
  /** 是等满预算没等到,而不是上游明确失败。这种镜【钱已扣且退不回来】(退款只认 failed),
   *  所以开头连着超时必须立刻收手,别把后面每一镜都照样提交一遍。 */
  timedOut?: boolean;
}

export interface GenerateSeedanceOptions {
  scenes: SeedanceSceneSpec[];
  /** 参考图本地绝对路径(≤2),做风格/人设统一。会读成 data URL 发给服务端。 */
  referenceImages?: string[];
  resolution?: SeedanceResolution;
  /** 模型档位(默认 pro15 = 1.5 Pro)。 */
  tier?: SeedanceTier;
  ratio?: SeedanceRatio;
  /** 片段下载落地目录(临时素材目录)。 */
  destDir: string;
  /** 并发上限(Ark 账号级限流,默认 2)。⚠️ chainFrames 打开时强制串行。 */
  concurrency?: number;
  /**
   * 首尾帧串接:把上一镜的【末帧】当下一镜的首帧。
   *
   * 这是跨镜一致性的关键。以前每镜各自 i2v、靠参考图勉强锁人设,人物长相/光影/画风
   * 一路漂;末帧衔接是画面物理连续,接缝几乎看不出来。
   * ⚠️ 代价是【必须串行】——下一镜要等上一镜出片才能抽末帧,没法并发。
   * ⚠️ 火山实测:首尾帧与参考图互斥(InvalidParameter: first/last frame content cannot be
   *    mixed with reference media content),所以串接开启后不再下发全局参考图。
   */
  chainFrames?: boolean;
  /** 单镜最大等待秒数(轮询超时,默认 240)。 */
  perClipTimeoutSec?: number;
  /** 中断信号:用户「停止」时停止轮询、不再生成新镜。 */
  signal?: AbortSignal;
  /**
   * 进度回调。除常规进度文案外,在每镜【真成功落盘】时会带上该镜 chargedTokens,
   * pipeline 据此实时累加「上次消耗」(否则要等整个 generateSeedanceClips 跑完才累加,
   * 用户看不到顶部消耗跟着进度涨)。
   */
  onProgress?: (msg: string, chargedTokens?: number, costUsd?: number) => void;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};

/** 本地图片读成 data URL(服务端 image_url 接受 http(s) 或 data:image/*)。 */
function imageToDataUrl(absPath: string): string | null {
  try {
    if (!fs.existsSync(absPath)) return null;
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'image/jpeg';
    const b64 = fs.readFileSync(absPath).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

function authHeaders(): Record<string, string> | null {
  const token = getNoobClawAuthToken();
  if (!token) return null;
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

interface CreateResult {
  taskId: string; chargeId: string; chargedTokens: number; costUsd: number;
  /** 服务端给的【本镜最多等多少秒】。档位是服务端定的(flex=离线队列,排队十几分钟很正常),
   *  客户端自己猜不出来 —— 老客户端没有这个字段,回落到本地默认。 */
  pollBudgetSec?: number;
  serviceTier?: string;
}

/** 提交一个 Seedance 片段任务。返回 taskId+chargeId,或抛错(含 402 余额不足)。 */
async function createClip(
  prompt: string, imageUrls: string[], duration: number, ratio: string,
  resolution: string | undefined, tier: string | undefined,
): Promise<CreateResult> {
  const headers = authHeaders();
  if (!headers) throw new Error('未登录 NoobClaw');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);
  try {
    const resp = await fetch(`${apiBase()}/api/video/seedance/create`, {
      method: 'POST',
      headers,
      // firstFrame 单独发:服务端要给每张图打 role,全塞 imageUrls 会被当成多个首帧。
      //   imageUrls 仍然带上,兼容还没部署新契约的后端。
      body: JSON.stringify({ prompt, firstFrame: imageUrls[0], imageUrls, duration, ratio, resolution, tier }),
      signal: ctrl.signal,
    });
    if (resp.status === 402) throw new Error('余额不足');
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`提交失败(${resp.status})${t ? ': ' + t.slice(0, 120) : ''}`);
    }
    const json: any = await resp.json();
    if (!json?.taskId) throw new Error('服务端未返回 taskId');
    return {
      taskId: json.taskId, chargeId: json.chargeId || '',
      chargedTokens: Number(json.chargedTokens) || 0,
      // 服务端权威美元数。拿不到(老后端)才退回 tokens/1e6 —— 那个是 $1/M 的假设,会少算。
      costUsd: Number(json.costUsd) || 0,
      pollBudgetSec: Number(json.pollBudgetSec) > 0 ? Number(json.pollBudgetSec) : undefined,
      serviceTier: typeof json.serviceTier === 'string' ? json.serviceTier : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface StatusResult {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  videoUrl?: string | null;
  error?: string;
  /** 这一次【查询本身】失败了(HTTP 非 2xx / 解析不了),不是任务在跑。
   *  调用方要单独计数:偶发一两次无所谓,一直失败说明链路断了,不能当"还在跑"干等到超时。 */
  pollFailed?: boolean;
}

/** 查一次任务状态。 */
async function pollClipOnce(taskId: string, chargeId: string): Promise<StatusResult> {
  const headers = authHeaders();
  if (!headers) throw new Error('未登录 NoobClaw');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const url = `${apiBase()}/api/video/seedance/status/${encodeURIComponent(taskId)}`
      + (chargeId ? `?chargeId=${encodeURIComponent(chargeId)}` : '');
    const resp = await fetch(url, { headers, signal: ctrl.signal });
    // 查询失败 ≠ 任务在跑。标记出来交给上层计数 —— 原来一律当 'running',链路真断了
    // (401/502/端点不存在)也会一路干等到超时才放弃,而钱在 create 时就已经扣了。
    if (!resp.ok) return { status: 'running', pollFailed: true, error: `status ${resp.status}` };
    const json: any = await resp.json();
    return { status: json?.status || 'running', videoUrl: json?.videoUrl, error: json?.error };
  } finally {
    clearTimeout(timer);
  }
}

/** 把 CDN 上的成片下载到本地 mp4(片段小,直接 buffer 落盘)。重试 3 次,防 CDN 偶发 fetch failed。 */
async function downloadVideo(url: string, outPath: string): Promise<void> {
  if (!url) throw new Error('empty_video_url');
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, buf);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface StoryboardResult {
  /** 每镜首帧 dataURL 数组(失败为空)。 */
  images: string[];
  /** 服务端按张实扣的积分(失败/未配置为 0);计入「本次消耗」总额。 */
  chargedTokens: number;
  /** 服务端权威 USD 成本。0 = 老后端没回,调用方自行折算。 */
  costUsd: number;
  /** 失败原因(服务端返回的 error/detail 或异常信息),供进度展示排查;成功为空。 */
  error?: string;
  /** 出图失败的镜序号(0-based)。调用方可据此在分镜表上标红,而不是静默降级。 */
  failedIndices: number[];
}

export interface StoryboardOptions {
  /** 每镜的【画面描述】prompt。⚠️ 必须是给图像模型的画面 prompt,不是给视频模型的运动 prompt。 */
  shots: string[];
  /** 角色/主体锁定串(每张都带,保一致)。 */
  character?: string;
  /** 画风锁定串。 */
  style?: string;
  /** 镜数(默认 shots.length)。 */
  count?: number;
  /** 画幅。不传时服务端按老行为默认竖屏 9:16。 */
  aspect?: '9:16' | '16:9' | '1:1';
  /** 与 shots 等长:该镜是否允许(需要)画面内出现文字。图表/文字卡/Logo 必须 true。 */
  allowText?: boolean[];
  /** 额外的固定参考图(如用户上传的定妆图),每张都会带上。 */
  referenceImages?: string[];
  /** 中断信号:用户点停止时立刻放弃出图,别让整条卡在这一步。 */
  signal?: AbortSignal;
  /**
   * 批次级进度文案。组图是【一次请求出一整批】,中途拿不到逐张进度 —— 只靠计数器的话
   * 数字会在整批生成的一两分钟里一动不动(实测停在 1/8),看着就是卡死。
   * 所以批次开始/结束各说一句人话。
   */
  onNote?: (msg: string) => void;
}

/** 滚动参考:除固定参考图外,再带最近这么多张【已生成的历史帧】。 */
const ROLLING_REF_COUNT = 2;
/** 单次请求最多带几张参考图(服务端也会截断)。 */
const MAX_REFS = 4;

/**
 * 故事板首帧:调服务端 /api/image/storyboard 生成每镜首帧 dataURL。
 *
 * ## 先组图,失败才逐张
 * 组图(一次出 N 张)的价值是【同一次去噪出来的 N 张天然一致】—— 光影、画风、人物长相,
 * 这是靠参考图补不回来的。老实现被迫逐张,是因为组图是单次长请求(6 张 >100s)必撞
 * Cloudflare 的 100s 超时(HTTP 524)。现在服务端支持异步任务(提交拿 job_id → 轮询),
 * 天花板没了,所以先按 GROUP_BATCH 分批组图;哪一批不通(老后端 / 超时 / 张数对不上)
 * 就把那一批退回逐张,不影响出片。
 *
 * ## 一致性:滚动参考(不是单锚点)
 * 老实现是「第 1 张成功的图当 anchor,后面每镜都参考它」。问题有三:
 *   ① 第 1 张画偏了全片跟着偏,没有自纠机会;
 *   ② 第 1 张不只带角色,还带着【那个场景那束光】,后面每镜都被往回拽;
 *   ③ 第 8 镜完全不知道第 7 镜长什么样 —— 越往后越飘。
 * 改成滚动参考:固定参考图(定妆图)+ 最近 ROLLING_REF_COUNT 张历史帧。相邻镜之间的
 * 连续性比「和第一张像」更重要 —— 这是 ViMax reference_image_selector 的经验规则。
 *
 * 返回的 images 按 shot 索引【对齐】(某张失败 → 该位置为空串 ''),失败的镜号同时记进
 * failedIndices 供上层标红,不再静默降级。
 */
/** 组图单次最多几张(Seedream sequential 上限 6)。超过就分批,每批各自一次生成。 */
const GROUP_BATCH = 6;
/** 异步任务轮询间隔 / 上限。6 张一批实测几十秒,给到 4 分钟足够。 */
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_MS = 240_000;
/** 提交请求的超时。新后端异步模式秒回 202;老后端会同步硬跑,超了就回落逐张。 */
const SUBMIT_TIMEOUT_MS = 25_000;

/**
 * 真组图:一次请求出一批(≤GROUP_BATCH 张),走服务端异步任务绕开 Cloudflare 100s。
 *
 * 为什么值得:同一次去噪出来的 N 张,光影 / 画风 / 人物长相天然一致 —— 这是靠参考图
 * 补不回来的。老实现为了躲 524 退回「一次一张调 N 次」,那 N 张是各画各的,风格会飘。
 *
 * 返回 null = 这条路不通(老后端不认 async / 轮询超时 / 任务失败),调用方回落逐张。
 */
async function generateGroupBatch(
  headers: Record<string, string>,
  shots: string[],
  opts: StoryboardOptions,
  refs: string[],
  signal?: AbortSignal,
): Promise<{ images: string[]; chargedTokens: number; costUsd: number } | null> {
  // ⚠️ 提交必须带超时。老后端不认 async,会把它当同步请求整批跑完 —— 那是个几分钟的
  //    长请求,撞 Cloudflare 100s 之后连接就吊在那儿。没有超时的话整条出片卡死在
  //    「故事板生成中… 1/N」,用户只能杀进程。超时 → 返回 null → 回落逐张,照常出片。
  const submitCtrl = new AbortController();
  const submitTimer = setTimeout(() => submitCtrl.abort(), SUBMIT_TIMEOUT_MS);
  const onAbort = () => { try { submitCtrl.abort(); } catch { /* ignore */ } };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await fetch(`${apiBase()}/api/image/storyboard`, {
      method: 'POST',
      headers,
      signal: submitCtrl.signal,
      body: JSON.stringify({
        shots,
        character: opts.character || '',
        style: opts.style || '',
        count: shots.length,
        async: true,
        ...(opts.aspect ? { aspect: opts.aspect } : {}),
        // 组图是一次请求出多张 → 只能给一个统一的文字策略:这批里只要有一镜需要文字就放开。
        ...(opts.allowText ? { allowText: opts.allowText.some(Boolean) } : {}),
        ...(refs.length ? { referenceImages: refs, referenceImage: refs[refs.length - 1] } : {}),
      }),
    });
    // 老后端没有 async 分支 → 会当成同步请求直接返图(200)。那也能用,直接收下。
    if (resp.status === 200) {
      const j: any = await resp.json();
      const imgs = Array.isArray(j?.images) ? j.images.filter((x: any) => typeof x === 'string' && x) : [];
      return imgs.length ? { images: imgs, chargedTokens: Number(j?.chargedTokens) || 0, costUsd: Number(j?.costUsd) || 0 } : null;
    }
    if (resp.status !== 202) return null;
    const started: any = await resp.json();
    const jobId = String(started?.job_id || '');
    if (!jobId) return null;

    const deadline = Date.now() + POLL_MAX_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) return null;
      await sleep(POLL_INTERVAL_MS);
      const pollCtrl = new AbortController();
      const pollTimer = setTimeout(() => pollCtrl.abort(), 20_000);
      let pr: Response;
      try {
        pr = await fetch(`${apiBase()}/api/image/storyboard/status/${encodeURIComponent(jobId)}`,
          { headers, signal: pollCtrl.signal });
      } finally { clearTimeout(pollTimer); }
      if (!pr.ok) return null;           // 404/403 → 别再等了
      const pj: any = await pr.json();
      if (pj?.status === 'done') {
        const imgs = Array.isArray(pj?.images) ? pj.images.filter((x: any) => typeof x === 'string' && x) : [];
        return imgs.length ? { images: imgs, chargedTokens: Number(pj?.chargedTokens) || 0, costUsd: Number(pj?.costUsd) || 0 } : null;
      }
      if (pj?.status === 'failed') return null;
    }
    return null;                          // 超时 → 回落逐张
  } catch {
    return null;
  } finally {
    clearTimeout(submitTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function generateStoryboard(
  opts: StoryboardOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<StoryboardResult> {
  const headers = authHeaders();
  if (!headers) return { images: [], chargedTokens: 0, costUsd: 0, error: '未登录', failedIndices: [] };
  // ⚠️ 不能先 filter 再用下标:上层(pipeline)按 shot 索引挂首帧,过滤会让整条 images 错位。
  //    空 prompt 的位置直接判失败,保持下标对齐。
  const shots = (opts.shots || []).map((s) => (typeof s === 'string' ? s.trim() : ''));
  const total = shots.length;
  const images: string[] = new Array(total).fill('');
  const failedIndices: number[] = [];
  let chargedTokens = 0;
  let chargedUsd = 0;
  let okCount = 0;
  let lastError = '';
  // 固定参考图(如定妆图):每张都带,锁主体。
  const fixedRefs = (opts.referenceImages || [])
    .filter((s) => typeof s === 'string' && /^(https?:\/\/|data:image\/)/.test(s));
  // 滚动参考:已成功生成的历史帧(按时间顺序),取最近几张。
  const history: string[] = [];

  // ── 先走【真组图】:一次出一批,同一次去噪出来的 N 张天然一致 ──────────────────
  //  失败(老后端 / 超时 / 任务失败)就把这一批退回逐张,不影响出片。
  const pending = new Set<number>();
  for (let i = 0; i < total; i++) if (shots[i]) pending.add(i);
  if (pending.size > 1) {
    const idxAll = [...pending];
    const batchCount = Math.ceil(idxAll.length / GROUP_BATCH);
    for (let b = 0; b < idxAll.length; b += GROUP_BATCH) {
      const batch = idxAll.slice(b, b + GROUP_BATCH);
      const bi = Math.floor(b / GROUP_BATCH) + 1;
      onProgress?.(total - pending.size, total);
      opts.onNote?.(
        `🎨 正在一次性生成第 ${bi}/${batchCount} 批(镜 ${batch[0] + 1}-${batch[batch.length - 1] + 1},共 ${batch.length} 张)`
        + ' —— 同一批出的图画风、光线天然一致。这一步没有逐张进度,约 1~2 分钟,请稍候',
      );
      const refs = [...fixedRefs, ...history.slice(-ROLLING_REF_COUNT)].slice(-MAX_REFS);
      if (opts.signal?.aborted) break;
      const r = await generateGroupBatch(
        headers,
        batch.map((i) => shots[i]),
        { ...opts, allowText: opts.allowText ? batch.map((i) => opts.allowText![i] === true) : undefined },
        refs,
        opts.signal,
      );
      if (!r || r.images.length === 0) {
        lastError = lastError || 'group_failed';
        opts.onNote?.(`⚠️ 第 ${bi}/${batchCount} 批组图没出图,这一批改为逐张生成`);
        continue;
      }
      // ⚠️ 少给了几张也要【把给的这几张用上】。服务端是按【实际产出张数】扣费的,
      //    整批丢弃回落逐张 = 同一批图付两次钱(实测 8 镜的故事板被收了 11 张)。
      //    组图是顺序生成,返回的第 k 张对应本批第 k 镜;不够的那几镜留给下面逐张补。
      chargedTokens += r.chargedTokens;
      chargedUsd += r.costUsd;
      const got = Math.min(r.images.length, batch.length);
      for (let k = 0; k < got; k++) {
        const idx = batch[k];
        images[idx] = r.images[k];
        okCount++;
        history.push(r.images[k]);
        pending.delete(idx);
      }
      opts.onNote?.(`✅ 第 ${bi}/${batchCount} 批已出 ${got}/${batch.length} 张(累计 ${okCount}/${total})`);
      if (got < batch.length) {
        lastError = lastError || 'group_partial';
        opts.onNote?.(`⚠️ 第 ${bi} 批少出了 ${batch.length - got} 张,缺的那几镜改为逐张补出`);
      }
    }
  }

  const needPerShot = shots.filter((sh, i) => sh && (pending.has(i) || !images[i])).length;
  if (needPerShot > 0 && total > 1) {
    opts.onNote?.(`🖼️ 还有 ${needPerShot} 镜逐张生成中…`);
  }
  for (let i = 0; i < total; i++) {
    if (!pending.has(i) && images[i]) continue;   // 组图已经出了这一镜
    onProgress?.(i, total);
    if (!shots[i]) { failedIndices.push(i); lastError = 'empty_prompt'; continue; }
    // 相邻镜的连续性比「和第一张像」更重要 → 取最近的历史帧,不是永远第 1 张。
    const refs = [...fixedRefs, ...history.slice(-ROLLING_REF_COUNT)].slice(-MAX_REFS);
    if (opts.signal?.aborted) { failedIndices.push(i); continue; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000); // 单张 < CF 100s,绝不触发 524
    const onAbortOne = () => { try { ctrl.abort(); } catch { /* ignore */ } };
    opts.signal?.addEventListener('abort', onAbortOne, { once: true });
    try {
      const resp = await fetch(`${apiBase()}/api/image/storyboard`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          shots: [shots[i]],
          character: opts.character || '',
          style: opts.style || '',
          count: 1,
          ...(opts.aspect ? { aspect: opts.aspect } : {}),
          // 该镜是否允许画面内出现文字(图表/文字卡/Logo 必须允许,否则出来是空白板)。
          ...(opts.allowText ? { allowText: opts.allowText[i] === true } : {}),
          ...(refs.length ? { referenceImages: refs } : {}),
          // 老后端只认单张 referenceImage —— 一并带上首张,保证不部署新后端也能跑。
          ...(refs.length ? { referenceImage: refs[refs.length - 1] } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        let detail = '';
        try { const ej: any = await resp.json(); detail = ej?.detail || ej?.error || ''; }
        catch { try { detail = (await resp.text()).slice(0, 200); } catch { /* ignore */ } }
        lastError = `HTTP ${resp.status}${detail ? ' · ' + detail : ''}`;
        failedIndices.push(i);
        continue;
      }
      const json: any = await resp.json();
      const imgs = Array.isArray(json?.images) ? json.images.filter((s: any) => typeof s === 'string' && s) : [];
      chargedTokens += Number(json?.chargedTokens) || 0;
      chargedUsd += Number(json?.costUsd) || 0;
      if (imgs[0]) { images[i] = imgs[0]; okCount++; history.push(imgs[0]); }
      else { lastError = json?.error || 'empty'; failedIndices.push(i); }
    } catch (e) {
      lastError = String((e as any)?.message || e).slice(0, 200);
      failedIndices.push(i);
    } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbortOne); }
  }
  onProgress?.(total, total);
  return {
    images,
    chargedTokens,
    costUsd: chargedUsd,
    error: okCount > 0 ? undefined : (lastError || 'all_failed'),
    failedIndices,
  };
}

/** 生成单镜:create → 轮询 → 下载。失败返回 {path:null,error}(不抛,交给上层降级)。 */
async function generateOne(
  idx: number, scene: SeedanceSceneSpec, imageUrls: string[],
  ratio: string, resolution: string | undefined, tier: string | undefined, destDir: string, timeoutSec: number,
  signal: AbortSignal | undefined,
  onProgress?: (m: string, chargedTokens?: number, costUsd?: number) => void,
): Promise<SeedanceClipResult> {
  const duration = Math.max(4, Math.min(12, Math.round(scene.durationSec || 5)));
  // 故事板模式:该镜有首帧图 → 用它做 i2v(图生视频,更稳);否则用全局参考图 / 纯文生视频。
  const imgs = (scene.keyframeDataUrl && scene.keyframeDataUrl.length > 0) ? [scene.keyframeDataUrl] : imageUrls;
  try {
    const created = await createClip(scene.prompt, imgs, duration, ratio, resolution, tier);
    const { taskId, chargeId, chargedTokens, costUsd } = created;
    // 等多久【听服务端的】:档位是它定的(flex=离线队列,排队十几分钟正常;default=在线)。
    //   老后端没回这个字段才用本地默认 —— 那正是真机烧掉一整批的配方:
    //   服务端选了慢档、客户端按 300s 的快档等,每镜必然等满再放弃,钱早扣了。
    const budgetSec = Math.max(60, Math.min(3600, created.pollBudgetSec ?? timeoutSec));
    // 每镜【先扣费再生成】(服务端 /seedance/create 原子扣费),把这笔扣费显出来 ——
    // 否则用户只看到"生成中"、看不到扣费,会以为没收钱(失败镜服务端会自动退)。
    onProgress?.(chargedTokens > 0
      ? `💎 第 ${idx + 1} 镜 已扣 ${chargedTokens.toLocaleString()} 积分 · AI 生成中…`
      : `🎬 第 ${idx + 1} 镜 AI 生成中…`);
    const startedAt = Date.now();
    const deadline = startedAt + budgetSec * 1000;
    // 等待期间每 15 秒报一次【已等多久】—— 原来只在开头写一句「离线档排队,最长等 30 分钟」,
    //   之后十几分钟一声不吭,用户分不清是在等还是卡死了。心跳文案统一以「已等 M:SS」结尾:
    //   渲染端 videoTaskStore.appendLog 认这个后缀做【原地更新】(不刷屏),ProgressTracker
    //   也认它跳过 markdown 落盘(运行记录里不留上百条只差秒数的行)。改文案先改那两处。
    let lastBeatMs = 0;
    // 连续【查询失败】计数:偶发抖动照常重试,连续 12 次(约 1 分钟)说明链路断了,
    //   立刻退出去报错,而不是拿着一条查不动的任务干等满整个预算。
    let pollFails = 0;
    while (Date.now() < deadline) {
      await sleep(5000);
      if (signal?.aborted) return { path: null, error: '已停止', chargedTokens };
      const waitedMs = Date.now() - startedAt;
      if (waitedMs - lastBeatMs >= 15000) {
        lastBeatMs = waitedMs;
        const s = Math.round(waitedMs / 1000);
        onProgress?.(`🎬 第 ${idx + 1} 镜 AI 生成中… 已等 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      }
      const st = await pollClipOnce(taskId, chargeId);
      if (st.pollFailed) {
        if (++pollFails >= 12) return { path: null, error: `任务状态查询持续失败(${st.error || '未知'})` };
        continue;
      }
      pollFails = 0;
      if (st.status === 'succeeded') {
        if (!st.videoUrl) return { path: null, error: '成片无 video_url', chargedTokens };
        const outPath = path.join(destDir, `seedance_${idx + 1}_${taskId.slice(-8)}.mp4`);
        await downloadVideo(st.videoUrl, outPath);
        // 镜真成功落盘 → 把该镜 chargedTokens 透给 onProgress,pipeline 实时累加进「上次消耗」。
        //   失败镜走不到这条 emit(上方 return path:null),所以语义仍是「只计成功镜」,
        //   跟服务端「有 token 输出不退、0 输出才退」的退款策略对齐。
        onProgress?.(`✅ 第 ${idx + 1} 镜 AI 片段就绪`, chargedTokens, costUsd);
        return { path: outPath, chargedTokens };
      }
      // 失败镜:服务端按 chargeId 自动退款,不计入实扣总额。
      if (st.status === 'failed') return { path: null, error: st.error || 'Ark 任务失败' };
    }
    // 超时 = 钱已扣、任务还在上游队列里跑,成片我们再也取不回来。把等了多久写进错误里,
    //   否则日志上只有一个"生成超时",看不出是"等太短"还是"上游真挂了"。
    return { path: null, error: `生成超时(已等 ${Math.round(budgetSec / 60)} 分钟未出片)`, timedOut: true };
  } catch (e) {
    return { path: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 批量生成各镜 Seedance 片段(限并发)。返回与 scenes 等长的结果数组(失败项 path:null）。
 * 服务端逐片段计费 + 失败自动退款,所以这里只管生成 + 收集,不处理钱。
 */
/**
 * 抽视频【最后一帧】存成 jpg。给首尾帧串接用。
 * ⚠️ 用 `-sseof -0.1` 从末尾倒数取,而不是 seek 到 duration —— 后者常因时基/最后一个
 *   关键帧的位置取不到画面,输出空文件。
 */
async function extractLastFrame(videoPath: string, outPath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const r = await runFfmpeg(
      ['-y', '-sseof', '-0.1', '-i', videoPath, '-vsync', '0', '-q:v', '2', '-frames:v', '1', outPath],
      { timeoutMs: 60_000, signal },
    );
    return r.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  } catch { return false; }
}

export async function generateSeedanceClips(opts: GenerateSeedanceOptions): Promise<SeedanceClipResult[]> {
  const { scenes, destDir } = opts;
  // 档位/分辨率不在客户端定:透传(可能 undefined)→ 服务端 create 端点决定。
  const resolution = opts.resolution;
  const tier = opts.tier;
  const ratio = opts.ratio || '9:16';
  // 并发 3 / 单镜超时 300s:失败或超时的镜会被 pipeline「就近复用」成重复画面,
  // 所以宁可多等、并发高一点,尽量让每镜都真生成出来,减少重复片段。
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 3));
  const timeoutSec = Math.max(60, Math.min(600, opts.perClipTimeoutSec ?? 300));

  // 参考图读成 data URL(≤2),所有镜共用 → 风格统一。
  const imageUrls = (opts.referenceImages || [])
    .slice(0, 2)
    .map(imageToDataUrl)
    .filter((u): u is string => !!u);

  const results = new Array<SeedanceClipResult>(scenes.length);

  // ── 熔断:开头连着超时就收手 ────────────────────────────────────────────
  // 每镜是【先扣费再生成】,而超时镜的钱退不回来(服务端只在查到 failed 时退)。
  // 真机实测:档位配成离线队列、客户端按 300s 等 → 第 1 镜就超时,代码却照样把
  //   剩下 7 镜挨个提交挨个扣费,8 镜全军覆没、¥11.9 全烧掉。
  // 前两镜都超时说明是【配置/链路层面】的问题(等太短、上游堵死),不是这一镜的运气,
  //   后面每一镜都会一模一样。这时候停下来只赔 2 镜,继续跑就是赔满全场。
  const BAIL_AFTER_TIMEOUTS = 2;
  let timeouts = 0;
  let anyOk = false;
  let bailed = false;
  /** 记一镜结果;返回 true 表示该收手了。 */
  const noteResult = (r: SeedanceClipResult): boolean => {
    if (r?.path) { anyOk = true; timeouts = 0; return false; }
    if (!r?.timedOut) return false;      // 上游明确失败的镜会退款,不触发熔断
    timeouts++;
    if (anyOk || timeouts < BAIL_AFTER_TIMEOUTS) return false;
    bailed = true;
    opts.onProgress?.(`⛔ 开头连着 ${timeouts} 镜等不到成片,已中止本次生成 —— 剩下的镜不再提交,免得继续扣费`);
    return true;
  };

  if (opts.chainFrames) {
    // ── 串接模式:严格顺序,每镜首帧 = 上一镜末帧 ──
    //   第 1 镜用它自己的故事板首帧(或纯文生视频);之后每镜都不再需要出图,
    //   故事板图从 N 张降到 1 张。
    let carry = '';   // 上一镜末帧的 data URL
    for (let i = 0; i < scenes.length; i++) {
      if (opts.signal?.aborted) break;
      const scene = scenes[i];
      // 有 carry 就用 carry;否则用本镜自己的首帧图;都没有 → 文生视频。
      const seed = carry || scene.keyframeDataUrl || '';
      const imgs = seed ? [seed] : [];
      results[i] = await generateOne(
        i, { ...scene, keyframeDataUrl: undefined }, imgs,
        ratio, resolution, tier, destDir, timeoutSec, opts.signal, opts.onProgress,
      );
      if (noteResult(results[i])) break;
      // 抽本镜末帧给下一镜。抽不到就清空 carry —— 下一镜退回文生视频,
      //   总比拿一张过期的帧去驱动强(那会让画面突然跳回好几镜之前)。
      carry = '';
      const out = results[i]?.path;
      if (out && i + 1 < scenes.length) {
        const framePath = path.join(destDir, `chain_${String(i).padStart(3, '0')}.jpg`);
        const got = await extractLastFrame(out, framePath, opts.signal);
        if (got) carry = imageToDataUrl(framePath) || '';
        if (!carry) opts.onProgress?.(`⚠️ 第 ${i + 1} 镜末帧抽取失败,下一镜改用文生视频`);
      }
    }
  } else {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < scenes.length) {
        if (opts.signal?.aborted || bailed) break;
        const i = next++;
        results[i] = await generateOne(i, scenes[i], imageUrls, ratio, resolution, tier, destDir, timeoutSec, opts.signal, opts.onProgress);
        if (noteResult(results[i])) break;   // bailed 置位,其余 worker 下一轮各自退出
      }
    };
    const n = Math.max(1, Math.min(concurrency, scenes.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
  }

  // 结尾汇总实扣积分(只计成功镜)。
  // ⚠️ 「失败已退」不能一概而论:上游明确 failed 的镜服务端会退,但【超时】的镜退不了 ——
  //    任务还在上游队列里跑,状态从没到过终态,退款那条路根本没被触发过。以前这里
  //    把所有失败都写成"已退",用户对账时会以为钱回来了。
  const okResults = results.filter((r) => r && r.path);
  const totalCharged = okResults.reduce((s, r) => s + (r.chargedTokens || 0), 0);
  const timedOutCount = results.filter((r) => r && r.timedOut).length;
  const failedCount = results.filter((r) => r && !r.path && !r.timedOut).length;
  if (totalCharged > 0) {
    const tail = [
      failedCount > 0 ? `${failedCount} 镜失败已退` : '',
      timedOutCount > 0 ? `${timedOutCount} 镜超时未出片(该笔已扣,上游仍在跑)` : '',
    ].filter(Boolean).join(',');
    opts.onProgress?.(`💎 AI 成片共扣 ${totalCharged.toLocaleString()} 积分(${okResults.length} 镜成功${tail ? ',' + tail : ''})`);
  } else if (timedOutCount > 0) {
    opts.onProgress?.(`⚠️ ${timedOutCount} 镜等满预算未出片 —— 这几笔已扣且退不回来,请把服务端「出片档」或「等待预算」调好再重试`);
  }
  return results;
}
