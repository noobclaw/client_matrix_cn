/**
 * thread-pipeline — 「爆帖成片」流水线(engine==='thread',v1 内容源 Reddit)。
 *
 * 像素级复刻 RedditVideoMakerBot 功能1 并超越:
 *   ① 选帖:勾选 subreddit 的 hot 前 25 条过滤(NSFW/评论数/屏蔽词/已做)后按赞数加权随机
 *   ② 拉高赞评论 → [创作语言≠en] AI 翻译改写(一次 JSON 调用,标题+评论批量)
 *   ③ 逐段 TTS(标题+每条评论各一段),累计时长到 targetSeconds 截断 —— 片长由此决定
 *   ④ 真截图:无头 Chrome 开帖子页、DOM 原地替换成翻译文本、对帖子/评论元素逐个截 PNG
 *   ⑤ 背景:'youtube'(yt-dlp 下免版权 gameplay 长视频随机裁段)| 'douyin'(搜竖屏游戏
 *      录屏下载 concat,国内推荐);都缓存在 userData/bg-cache 只下一次
 *   ⑥ 合成:背景打底 + 卡片 overlay enable='between(t,起,止)'(时间窗=对应 TTS 实测时长,
 *      bot 同款)+ 旁白 concat + BGM amix。卡片本身就是字,不烧字幕。
 *   ⑦ 计费照 stock 口径(chargeMode1Video 预扣,失败幂等退回);发布走 runPublishStep;
 *      发布成功(或仅存本地出片)才记「已做」防重复。
 *
 * 超越点:创作语言可选(AI 改写 vs bot 的 google 硬翻)、免 Reddit 账号、批量+定时+
 * 9 平台发布、按任务去重 —— bot 全没有。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isFfmpegAvailable, runFfmpeg, probeDuration, probeImageSize } from './ffmpegRuntime';
import { resolveBgmPath } from './bgm';
import {
  ProgressTracker, resolveOutputDirs, outputFileName, throwIfAborted,
  type VideoCreationInput, type VideoCreationResult, type ProgressEmitter,
} from './pipeline';
import { getVideoConfig, type VideoPipelineConfig } from './videoConfig';
import { resolveHeadlessBrowser } from './htmlVideoRenderer';
import {
  ThreadSession, pickRedditPost, fetchRedditComments, captureThreadCards, waitForRedditReady,
  type RedditPost, type RedditComment,
} from './threadProvider';
import { synthesize, getVoiceFallbacks, getLastTtsError } from './tts';
import { chargeMode1Video, refundMode1Video } from './billing';
import { callDeepSeek, extractJsonObject, type ContentLang } from './scriptWriter';
import { ensureBgVideo, bgCacheDir } from './ytdlpRuntime';
import { fetchDouyinClips } from './hotspotDouyinSource';
import { getUsedHotspots, markHotspotUsed } from './usedHotspotStore';

const THREAD_STEPS = [
  { key: 'pick', label: '选帖(Reddit 热帖)' },
  { key: 'voice', label: '翻译 + 生成配音' },
  { key: 'cards', label: '截图神评卡片' },
  { key: 'compose', label: '背景 + 合成' },
  { key: 'publish', label: '发布到各大平台' },
];

const W = 1080;
const H = 1920;
/** 卡片在画面里的显示宽(px)。截图是 2x DPI,缩到 940 仍然锐。 */
const CARD_W = 940;
/** 卡片显示高上限:超高长评论截图别顶穿画面。 */
const CARD_MAX_H = 1600;
/** 段间静音(秒),对齐 bot 的 silence_duration=0.3。 */
const GAP_SEC = 0.3;

/** 创作语言 → 默认音色(用户没选音色时);fallback 链由 getVoiceFallbacks 兜。 */
const LANG_DEFAULT_VOICE: Record<ContentLang, string> = {
  zh: 'zh-CN-YunjianNeural',
  en: 'en-US-GuyNeural',
  ja: 'ja-JP-KeitaNeural',
  ko: 'ko-KR-InJoonNeural',
};

const LANG_NAME: Record<ContentLang, string> = { zh: '简体中文', en: 'English', ja: '日本語', ko: '한국어' };

interface CardSeg {
  /** 'title' 或 comment id。 */
  key: string;
  /** 朗读文本(翻译后)。 */
  text: string;
  audioPath: string;
  durationSec: number;
  pngPath?: string;
  /** overlay 时间窗(compose 前算好)。 */
  startSec?: number;
  endSec?: number;
}

function sanitizeName(s: string): string {
  return (s || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 一次 AI 调用把标题+评论翻译改写成目标语言。失败返回 null(保留英文原文出片)。 */
async function translateThread(
  post: RedditPost,
  comments: RedditComment[],
  lang: ContentLang,
  onCost: (tokens: number, usd: number) => void,
): Promise<{ title: string; bodies: Record<string, string> } | null> {
  const sys = [
    `你是短视频本地化译者。把 Reddit 帖子标题和评论翻译改写成${LANG_NAME[lang]},用于口播朗读和画面展示。`,
    '要求:',
    '1. 口语化、地道、保留原梗和语气(吐槽/反讽/玩笑要传神),不是生硬直译。',
    '2. 每条译文长度与原文相当,不添油加醋、不合并、不遗漏。',
    '3. 俚语/缩写(AITA、TIFU、OP 等)转成目标语言观众能懂的说法。',
    '4. 只输出严格 JSON(json):{"title":"译文","comments":{"<id>":"译文",...}},id 原样保留。',
  ].join('\n');
  const user = JSON.stringify({
    title: post.title,
    comments: comments.map((c) => ({ id: c.id, text: c.body })),
  });
  try {
    const r = await callDeepSeek(sys, user, true, 90_000, 'noobclawai-chat');
    onCost(r.tokens, r.costUsd);
    const parsed = JSON.parse(extractJsonObject(r.content));
    const title = typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : '';
    const bodies: Record<string, string> = {};
    if (parsed?.comments && typeof parsed.comments === 'object') {
      for (const [k, v] of Object.entries(parsed.comments)) {
        if (typeof v === 'string' && v.trim()) bodies[k] = v.trim();
      }
    }
    if (!title && Object.keys(bodies).length === 0) return null;
    return { title: title || post.title, bodies };
  } catch {
    return null;
  }
}

/** TTS 一段(带音色 fallback 链)。失败返回 null(该段丢弃)。 */
async function ttsSeg(text: string, primary: string, outPath: string, rate?: number): Promise<{ audioPath: string; durationSec: number } | null> {
  for (const v of getVoiceFallbacks(primary)) {
    const r = await synthesize(text, outPath, v, rate);
    if (r.ok && r.synthesized && r.durationSec > 0.2) return { audioPath: r.audioPath, durationSec: r.durationSec };
  }
  return null;
}

/** 生成 GAP_SEC 静音 mp3(旁白段间停顿)。 */
async function makeSilence(outPath: string): Promise<boolean> {
  const r = await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-t', String(GAP_SEC), '-c:a', 'libmp3lame', '-b:a', '48k', outPath,
  ], { timeoutMs: 30_000 });
  return r.ok && fs.existsSync(outPath);
}

/** 旁白拼接:seg0 + 静音 + seg1 + … → narration.mp3(全部重采样 44.1k mono 防 concat 挑刺)。 */
async function concatNarration(segs: CardSeg[], silencePath: string, outPath: string): Promise<boolean> {
  const inputs: string[] = [];
  const chains: string[] = [];
  let idx = 0;
  const pushInput = (p: string) => { inputs.push('-i', p); return idx++; };
  const parts: string[] = [];
  segs.forEach((s, i) => {
    const k = pushInput(s.audioPath);
    chains.push(`[${k}:a]aresample=44100,aformat=channel_layouts=mono[a${k}]`);
    parts.push(`[a${k}]`);
    if (i < segs.length - 1) {
      const g = pushInput(silencePath);
      chains.push(`[${g}:a]aresample=44100,aformat=channel_layouts=mono[a${g}]`);
      parts.push(`[a${g}]`);
    }
  });
  const fc = `${chains.join(';')};${parts.join('')}concat=n=${parts.length}:v=0:a=1[aout]`;
  const r = await runFfmpeg([
    '-y', ...inputs, '-filter_complex', fc, '-map', '[aout]',
    '-c:a', 'libmp3lame', '-b:a', '160k', outPath,
  ], { timeoutMs: 120_000 });
  return r.ok && fs.existsSync(outPath);
}

/** YouTube 背景:缓存的长视频随机裁 totalSec 一段 → 1080x1920 base.mp4。 */
async function buildYoutubeBase(
  vcfg: VideoPipelineConfig, choice: string, totalSec: number, outPath: string,
  onLog: (m: string) => void, signal?: AbortSignal,
): Promise<boolean> {
  const list = vcfg.threadBgVideos;
  if (!list.length) return false;
  const bg = (choice && choice !== 'random' && list.find((b) => b.id === choice))
    || list[Math.floor(Math.random() * list.length)];
  const local = await ensureBgVideo(bg, process.platform === 'win32' ? vcfg.threadYtdlpUrlWin : vcfg.threadYtdlpUrlMac, onLog, signal);
  if (!local) return false;
  const dur = await probeDuration(local);
  if (dur < 5) return false;
  const vf = `crop=ih*${W}/${H}:ih,scale=${W}:${H},fps=30,setsar=1`;
  let args: string[];
  if (dur >= totalSec + 10) {
    // 随机起点(掐头 5s 片头),bot 的 get_start_and_end_times 简化版
    const start = 5 + Math.random() * (dur - totalSec - 8);
    args = ['-y', '-ss', start.toFixed(2), '-t', totalSec.toFixed(2), '-i', local,
      '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', outPath];
  } else {
    // 背景比成片短 → 循环铺满
    args = ['-y', '-stream_loop', '-1', '-i', local, '-t', totalSec.toFixed(2),
      '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', outPath];
  }
  const r = await runFfmpeg(args, { timeoutMs: 600_000, signal });
  return r.ok && fs.existsSync(outPath);
}

/** 抖音背景:按搜索词下竖屏游戏录屏(缓存复用),concat 铺满 totalSec → base.mp4。 */
async function buildDouyinBase(
  vcfg: VideoPipelineConfig, choice: string, totalSec: number, outPath: string,
  onLog: (m: string) => void, signal?: AbortSignal,
): Promise<boolean> {
  const list = vcfg.threadBgDouyinTerms;
  if (!list.length) return false;
  const term = (choice && choice !== 'random' && list.find((t) => t.id === choice))
    || list[Math.floor(Math.random() * list.length)];
  const cacheDir = path.join(bgCacheDir(), `douyin-${term.id}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  // 缓存里凑一批可用竖屏录屏;不够(< 2 条或总时长不足)才真去抖音搜(浏览器串行,较慢)
  const listClips = () => fs.readdirSync(cacheDir).filter((f) => /\.mp4$/i.test(f)).map((f) => path.join(cacheDir, f));
  let clips = listClips();
  let cachedDur = 0;
  for (const c of clips) cachedDur += await probeDuration(c);
  if (clips.length < 2 || cachedDur < totalSec) {
    onLog(`🎮 上抖音搜背景「${term.label}」(只下一次,之后复用缓存)…`);
    try {
      await fetchDouyinClips([term.term], 6, cacheDir, onLog, signal, 'video');
    } catch (e) {
      onLog(`⚠️ 抖音背景搜索失败:${String((e as Error)?.message || e).slice(0, 100)}`);
    }
    clips = listClips();
  }
  if (clips.length === 0) return false;
  // 随机顺序取,直到时长够;不够就整组循环补
  const shuffled = [...clips].sort(() => Math.random() - 0.5);
  const picked: string[] = [];
  let acc = 0;
  let guard = 0;
  while (acc < totalSec + 2 && guard < 40) {
    const c = shuffled[guard % shuffled.length];
    const d = await probeDuration(c);
    if (d > 1) { picked.push(c); acc += d; }
    guard++;
  }
  if (picked.length === 0 || acc < 3) return false;
  const inputs: string[] = [];
  const norm: string[] = [];
  picked.slice(0, 12).forEach((c, i) => {
    inputs.push('-i', c);
    norm.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,setsar=1[v${i}]`);
  });
  const n = Math.min(picked.length, 12);
  const fc = `${norm.join(';')};${Array.from({ length: n }, (_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vout]`;
  const r = await runFfmpeg([
    '-y', ...inputs, '-filter_complex', fc, '-map', '[vout]', '-t', totalSec.toFixed(2),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', outPath,
  ], { timeoutMs: 600_000, signal });
  return r.ok && fs.existsSync(outPath);
}

/** 兜底背景:深蓝纯色(背景全失败也要能出片,别浪费已扣的 AI/TTS)。 */
async function buildColorBase(totalSec: number, outPath: string): Promise<boolean> {
  const r = await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `color=c=0x14142a:s=${W}x${H}:d=${totalSec.toFixed(2)}:r=30`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', outPath,
  ], { timeoutMs: 120_000 });
  return r.ok && fs.existsSync(outPath);
}

/** 最终合成:base + 卡片 overlay(时间窗)+ 旁白 + BGM。 */
async function composeThreadVideo(opts: {
  basePath: string;
  narrationPath: string;
  segs: CardSeg[];          // 已带 startSec/endSec + pngPath
  totalSec: number;
  bgmPath?: string;
  bgmVolume: number;
  outPath: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const cards = opts.segs.filter((s) => s.pngPath && typeof s.startSec === 'number');
  const inputs: string[] = ['-i', opts.basePath, '-i', opts.narrationPath];
  const hasBgm = !!opts.bgmPath;
  cards.forEach((c) => inputs.push('-i', c.pngPath!));
  if (hasBgm) inputs.push('-stream_loop', '-1', '-i', opts.bgmPath!);

  const parts: string[] = [];
  // 卡片:缩到显示宽,超高的按高钳制(截图 2x DPI,缩小锐利)
  const scaleArgs: string[] = [];
  for (const c of cards) {
    const size = await probeImageSize(c.pngPath!);
    const dispH = size.width > 0 ? Math.round((size.height * CARD_W) / size.width) : 0;
    scaleArgs.push(dispH > CARD_MAX_H ? `scale=-2:${CARD_MAX_H}` : `scale=${CARD_W}:-2`);
  }
  cards.forEach((c, i) => {
    parts.push(`[${2 + i}:v]${scaleArgs[i]}[c${i}]`);
  });
  let cur = '[0:v]';
  cards.forEach((c, i) => {
    const next = i === cards.length - 1 ? '[vout]' : `[ov${i}]`;
    parts.push(`${cur}[c${i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${c.startSec!.toFixed(2)},${c.endSec!.toFixed(2)})'${next}`);
    cur = next;
  });
  if (cards.length === 0) parts.push(`[0:v]null[vout]`);

  let audioMap = '1:a';
  if (hasBgm) {
    const bgmIdx = 2 + cards.length;
    parts.push(`[${bgmIdx}:a]volume=${opts.bgmVolume.toFixed(2)}[ba]`);
    parts.push(`[1:a][ba]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
    audioMap = '[aout]';
  }

  const r = await runFfmpeg([
    '-y', ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', audioMap,
    '-t', opts.totalSec.toFixed(2),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    opts.outPath,
  ], { timeoutMs: 900_000, signal: opts.signal });
  return r.ok && fs.existsSync(opts.outPath);
}

export async function runThreadPipeline(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  const jobId = `thr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracker = new ProgressTracker(jobId, emit, THREAD_STEPS);

  if (!isFfmpegAvailable()) {
    const err = 'ffmpeg 不可用(开发机请确保 PATH 上有 ffmpeg;打包版需内置 ffmpeg 资源)';
    tracker.fail('pick', err);
    return { ok: false, error: err };
  }
  if (!resolveHeadlessBrowser()) {
    const err = '未检测到 Chrome / Edge。爆帖成片需要其一来抓帖+截图(Windows 自带 Edge 即可)。';
    tracker.fail('pick', err);
    return { ok: false, error: err };
  }
  const subreddits = (input.threadSubreddits || []).map((s) => String(s).trim()).filter(Boolean);
  if (subreddits.length === 0) {
    const err = '爆帖成片:未勾选任何帖子源(subreddit)';
    tracker.fail('pick', err);
    return { ok: false, error: err };
  }

  const lang: ContentLang = (['zh', 'en', 'ja', 'ko'] as ContentLang[]).includes(input.threadLang as ContentLang)
    ? (input.threadLang as ContentLang) : 'zh';
  const targetSeconds = Math.max(20, Math.min(180, input.targetSeconds || 60));

  const { taskDir, runDir } = resolveOutputDirs(input);
  let destDir = runDir;
  tracker.setOutputDir(taskDir);
  tracker.setLogFile(path.join(runDir, '运行记录.md'));

  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-thread-assets-'));
  let chargeId: string | undefined;
  let refundOnExit = false;
  const session = new ThreadSession();

  // 矩阵内核取材(生产主路):选帖/评论/截图跑在 Reddit 矩阵账号的指纹内核里,逻辑在
  // 服务端下发的 reddit_search driver(热更新)。拿不到账号/内核 → 回落无头 Chrome 路径。
  let kernelAccountId = '';

  try {
    // ── STEP 1:选帖 + 拉评论 ─────────────────────────────────────────────
    throwIfAborted(signal);
    tracker.start('pick', `输出目录:${taskDir}`);
    const vcfg = await getVideoConfig();
    const { acquireRedditKernel, pickThreadViaKernel, captureCardsViaKernel } = require('./threadProvider');
    kernelAccountId = await acquireRedditKernel(input.threadMaterialAccountId, (m: string) => tracker.progress(m));
    const usedIds = getUsedHotspots(input.taskId || '');
    let post: RedditPost | null = null;
    let rawComments: RedditComment[] = [];
    if (kernelAccountId) {
      const r = await pickThreadViaKernel(kernelAccountId, {
        subreddits, excludeIds: usedIds, minComments: 20, wantComments: 24,
        onLog: (m: string) => tracker.progress(m),
      });
      if (r) { post = r.post; rawComments = r.comments; }
    }
    if (!post) {
      // 无头 Chrome 兜底(没有 Reddit 矩阵账号 / 内核路径失败)。
      if (kernelAccountId) tracker.progress('⚠️ 内核取材未成,回落无头浏览器再试…');
      tracker.progress(`🌐 启动无头浏览器连 Reddit(需要 VPN/代理可达)…`);
      await session.launch(W, H);
      await session.goto('https://www.reddit.com/', 2000);
      // 等 JS challenge 自动过、shreddit 真正挂载;没就绪也继续(选帖有页面 DOM 兜底)。
      await waitForRedditReady(session, (m) => tracker.progress(m));
      post = await pickRedditPost(session, {
        subreddits,
        excludeIds: usedIds,
        minComments: 20,
        onLog: (m) => tracker.progress(m),
      });
      if (!post) {
        const err = '爆帖成片:选不到可用帖子(检查 VPN 是否可达 reddit.com,或所选版块暂无合格热帖)';
        tracker.fail('pick', err);
        return { ok: false, error: err };
      }
      tracker.progress(`📌 选中 r/${post.subreddit}「${post.title.slice(0, 80)}」· 👍${post.score} · 💬${post.numComments}`);
      throwIfAborted(signal);
      rawComments = await fetchRedditComments(session, post, 24, (m) => tracker.progress(m));
      kernelAccountId = ''; // 后续截图也走无头路径
    }
    if (rawComments.length < 2) {
      const err = '爆帖成片:该帖拉不到足够的可用评论(过滤后 <2 条),请重试换一帖';
      tracker.fail('pick', err);
      return { ok: false, error: err };
    }
    tracker.done('pick', `✅ 选帖完成 · 候选评论 ${rawComments.length} 条${kernelAccountId ? ' · 指纹内核' : ''}`);

    // 批次目录加帖子标题后缀,方便肉眼区分(照 hotspot 的做法;此刻 runDir 还没写过成片)
    try {
      const suffix = sanitizeName(post.title).slice(0, 40);
      if (suffix) {
        const newDir = path.join(path.dirname(destDir), `${path.basename(destDir)}_${suffix}`);
        if (newDir !== destDir && !fs.existsSync(newDir)) { fs.renameSync(destDir, newDir); destDir = newDir; }
      }
    } catch { /* 改名失败不影响出片 */ }

    // ── STEP 2:翻译改写 + 逐段 TTS(定长截断) ───────────────────────────
    throwIfAborted(signal);
    tracker.start('voice', lang === 'en' ? '🎤 英文原声,逐段配音…' : `🌏 AI 翻译改写为${LANG_NAME[lang]},随后逐段配音…`);
    // 翻译上限 14 条评论(通常 60s 只用得到 5~8 条,留余量;省 token)
    const translateCandidates = rawComments.slice(0, 14);
    let trTitle = post.title;
    let trBodies: Record<string, string> = {};
    if (lang !== 'en') {
      const tr = await translateThread(post, translateCandidates, lang, (tk, usd) => tracker.addTokens(tk, usd));
      if (tr) {
        trTitle = tr.title;
        trBodies = tr.bodies;
        tracker.progress(`✅ 翻译改写完成(标题 + ${Object.keys(tr.bodies).length} 条评论)`);
      } else {
        tracker.progress('⚠️ 翻译改写失败,本条用英文原文出片');
      }
    }
    const voice = input.voice || LANG_DEFAULT_VOICE[lang];
    const rate = typeof input.voiceRate === 'number' ? input.voiceRate : 0;

    const segs: CardSeg[] = [];
    let acc = 0;
    // 标题永远第一段
    const titleText = (trTitle || post.title).trim();
    const t0 = await ttsSeg(titleText, voice, path.join(assetDir, 'seg-title.mp3'), rate);
    if (!t0) {
      const why = getLastTtsError() || '请稍后再试';
      tracker.fail('voice', `标题配音失败:${why}`);
      return { ok: false, error: `配音失败:${why}` };
    }
    segs.push({ key: 'title', text: titleText, audioPath: t0.audioPath, durationSec: t0.durationSec });
    acc += t0.durationSec;
    // 评论逐条 TTS,超 targetSeconds 停(bot 的 max_length 截断逻辑)
    for (const c of translateCandidates) {
      if (acc >= targetSeconds) break;
      throwIfAborted(signal);
      const text = (trBodies[c.id] || c.body).trim();
      if (!text) continue;
      const r = await ttsSeg(text, voice, path.join(assetDir, `seg-${c.id}.mp3`), rate);
      if (!r) { tracker.progress(`⚠️ 评论 ${c.id} 配音失败,跳过`); continue; }
      segs.push({ key: c.id, text, audioPath: r.audioPath, durationSec: r.durationSec });
      acc += r.durationSec + GAP_SEC;
    }
    if (segs.length < 2) {
      tracker.fail('voice', '可用配音段不足(标题之外没有评论段成功)');
      return { ok: false, error: '配音段不足,请重试' };
    }
    tracker.done('voice', `✅ 配音完成 · ${segs.length} 段(标题+${segs.length - 1}条神评)· 约 ${Math.round(acc)}s`);

    // ── STEP 3:真截图(只截入选段的卡片) ────────────────────────────────
    throwIfAborted(signal);
    tracker.start('cards', '📸 打开帖子页,替换文字并逐卡截图…');
    const pickedComments = rawComments.filter((c) => segs.some((s) => s.key === c.id));
    const captureOpts = {
      post,
      comments: pickedComments,
      translatedTitle: lang !== 'en' ? trTitle : undefined,
      translatedBodies: lang !== 'en' ? trBodies : undefined,
      outDir: assetDir,
      onLog: (m: string) => tracker.progress(m),
      signal,
    };
    const captured = kernelAccountId
      ? await captureCardsViaKernel(kernelAccountId, captureOpts)
      : await captureThreadCards(session, captureOpts);
    if (!captured.titlePng) {
      const err = `爆帖成片:标题卡截图失败(Reddit 页面结构可能变了)。诊断:${captured.diag.slice(0, 3).join(' | ') || '无'}`;
      tracker.fail('cards', err);
      return { ok: false, error: err };
    }
    // 对齐音画:截图失败的评论段【连音频一起丢】,时间窗按存活段重算
    const alive: CardSeg[] = [];
    for (const s of segs) {
      if (s.key === 'title') { s.pngPath = captured.titlePng; alive.push(s); continue; }
      const png = captured.commentPngs.get(s.key);
      if (png) { s.pngPath = png; alive.push(s); }
      else tracker.progress(`⚠️ 评论 ${s.key} 没截到卡片,该段(含配音)跳过`);
    }
    if (alive.length < 2) {
      const err = '爆帖成片:评论卡片全部截图失败,无法成片(看上方诊断)';
      tracker.fail('cards', err);
      return { ok: false, error: err };
    }
    let cursor = 0;
    for (const s of alive) {
      s.startSec = cursor;
      s.endSec = cursor + s.durationSec;
      cursor = s.endSec + GAP_SEC;
    }
    const totalSec = Math.max(3, cursor - GAP_SEC + 0.6); // 尾留白 0.6s
    tracker.done('cards', `✅ 卡片就绪 ${alive.length}/${segs.length} · 成片约 ${Math.round(totalSec)}s`);
    // 截图用完就关浏览器/内核,别占着资源陪跑 ffmpeg
    await session.close().catch(() => { /* 已关 */ });
    if (kernelAccountId) {
      try { require('../matrix/kernelPool').closeKernel(kernelAccountId, { force: true }); } catch { /* ignore */ }
      kernelAccountId = '';
    }

    // 口播文案存档(对齐 stock 的「文案.txt」)
    try {
      const lines = [
        `📝 爆帖成片(r/${post.subreddit} · 👍${post.score})`,
        `原帖: https://www.reddit.com${post.permalink}`,
        '',
        ...alive.map((s, i) => `[${i === 0 ? '标题' : `神评${i}`}] ${s.text}`),
      ];
      fs.writeFileSync(path.join(destDir, '文案.txt'), lines.join('\n'), 'utf8');
    } catch { /* 不影响出片 */ }

    // ── STEP 4:计费 → 背景 → 合成 ───────────────────────────────────────
    throwIfAborted(signal);
    tracker.start('compose', '💎 预扣平台基础费…');
    const aiCost = 0; // 翻译 token 已实时扣;平台基础费单独预扣(与 template 同口径)
    const charge = await chargeMode1Video(totalSec, { videoCount: 1, aiCostUsd: aiCost });
    if (!charge.ok) {
      let err: string;
      if (charge.reason === 'insufficient') err = '余额不足,无法生成(需先预扣平台基础费,请充值后重试)';
      else if (charge.reason === 'no_auth') err = '未登录 NoobClaw,无法生成';
      else err = '平台基础费预扣失败,请稍后重试';
      tracker.fail('compose', err);
      return { ok: false, error: err };
    }
    chargeId = charge.chargeId;
    refundOnExit = true;
    tracker.addTokens(charge.chargedTokens || 0, charge.feeUsd || 0);
    tracker.progress(`💎 平台基础费已预扣 ${charge.chargedTokens || 0} 积分(≈$${(charge.feeUsd || 0).toFixed(2)}),失败将自动退回`);

    // 旁白
    const silencePath = path.join(assetDir, 'silence.mp3');
    const narrationPath = path.join(assetDir, 'narration.mp3');
    if (!(await makeSilence(silencePath)) || !(await concatNarration(alive, silencePath, narrationPath))) {
      tracker.fail('compose', '旁白音频拼接失败');
      return { ok: false, error: '旁白音频拼接失败' };
    }

    // 背景(douyin/youtube 二选一,失败互为备胎,最后纯色兜底)
    const basePath = path.join(assetDir, 'base.mp4');
    const bgSource = input.threadBgSource === 'youtube' ? 'youtube' : 'douyin';
    const bgChoice = input.threadBgChoice || 'random';
    tracker.progress(`🎮 准备游戏录屏背景(来源:${bgSource === 'douyin' ? '抖音' : 'YouTube'})…`);
    let baseOk = bgSource === 'douyin'
      ? await buildDouyinBase(vcfg, bgChoice, totalSec, basePath, (m) => tracker.progress(m), signal)
      : await buildYoutubeBase(vcfg, bgChoice, totalSec, basePath, (m) => tracker.progress(m), signal);
    if (!baseOk) {
      throwIfAborted(signal);
      tracker.progress(`⚠️ ${bgSource === 'douyin' ? '抖音' : 'YouTube'} 背景失败,换${bgSource === 'douyin' ? ' YouTube ' : '抖音'}通道再试…`);
      baseOk = bgSource === 'douyin'
        ? await buildYoutubeBase(vcfg, 'random', totalSec, basePath, (m) => tracker.progress(m), signal)
        : await buildDouyinBase(vcfg, 'random', totalSec, basePath, (m) => tracker.progress(m), signal);
    }
    if (!baseOk) {
      throwIfAborted(signal);
      tracker.progress('⚠️ 两个背景通道都失败,用纯色底出片(建议检查 VPN/网络后重跑)');
      baseOk = await buildColorBase(totalSec, basePath);
    }
    if (!baseOk) {
      tracker.fail('compose', '背景生成失败');
      return { ok: false, error: '背景生成失败' };
    }

    // BGM(内置/云端曲库,失败不阻塞)
    const bgm = await resolveBgmPath(input.bgmPath, (m) => tracker.progress(m)).catch(() => undefined);

    throwIfAborted(signal);
    tracker.progress('🎞️ 合成中(卡片按配音时间窗依次上屏)…');
    const outPath = path.join(destDir, outputFileName(0));
    const composed = await composeThreadVideo({
      basePath, narrationPath, segs: alive, totalSec,
      bgmPath: bgm, bgmVolume: typeof input.bgmVolume === 'number' ? input.bgmVolume : 0.15,
      outPath, signal,
    });
    if (!composed) {
      tracker.fail('compose', '视频合成失败(ffmpeg)');
      return { ok: false, error: '视频合成失败' };
    }
    refundOnExit = false; // 用户拿到成片,平台费收下
    tracker.done('compose', `✅ 已生成 ${path.basename(outPath)}`);
    tracker.progress(`📂 输出目录:${destDir}`);

    // ── STEP 5:发布(未选平台 = 仅存本地)──────────────────────────────
    tracker.start('publish');
    const platforms = Array.isArray(input.publishPlatforms) ? input.publishPlatforms.filter(Boolean) : [];
    let publishedCount = 0;
    try {
      const { resolvePublishCaption } = require('./publishCaptionWriter');
      const cap = await resolvePublishCaption({
        wantPublish: platforms.length > 0,
        summary: alive.map((s) => s.text).join('\n').slice(0, 1200),
        title: trTitle.slice(0, 40),
        keywords: [],
        track: input.track,
        lang,
        userTitle: input.publishTitle,
        userCaption: input.publishCaption,
        userTags: input.hashtags,
        onLog: (m: string) => tracker.progress(m),
        onCost: (tk: number, usd: number) => tracker.addTokens(tk, usd),
      });
      // 矩阵号 edition:发布走指纹内核 CDP(按平台→选定账号上传);非矩阵走旧 runPublishStep。
      const { MATRIX_EDITION } = require('../../matrixEdition');
      if (MATRIX_EDITION && platforms.length > 0) {
        const { runMatrixPublishStep } = require('./publishers/runMatrixPublish');
        const pub = await runMatrixPublishStep({
          platforms,
          accounts: (input as any).publishAccounts || {},
          videoPath: outPath,
          title: cap.title,
          description: cap.description,
          tags: cap.tags,
          onLog: (msg: string) => tracker.progress(msg),
          signal,
        });
        publishedCount = pub?.publishedCount || 0;
      } else {
        const { runPublishStep } = require('./publishers/runPublish');
        const pub = await runPublishStep({
          platforms,
          videoPath: outPath,
          title: cap.title,
          description: cap.description,
          tags: cap.tags,
          onLog: (msg: string) => tracker.progress(msg),
          signal,
        });
        publishedCount = pub?.publishedCount || 0;
      }
    } catch (e) {
      tracker.progress(`⚠️ 发布步骤异常:${String((e as Error)?.message || e).slice(0, 120)}`);
    }
    // 已做去重口径对齐 hotspot:仅存本地出片成功 = 用过;选了平台则 ≥1 个发布成功才算
    if (input.taskId && (platforms.length === 0 || publishedCount > 0)) {
      markHotspotUsed(input.taskId, post.id);
    }
    tracker.finish(outPath, 1);
    return { ok: true, outputPath: outPath, outputPaths: [outPath] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('VIDEO_ABORTED') || msg === 'aborted') {
      return { ok: false, error: '已停止', aborted: true };
    }
    tracker.fail(null, msg);
    return { ok: false, error: msg };
  } finally {
    await session.close().catch(() => { /* 已关 */ });
    if (kernelAccountId) {
      try { require('../matrix/kernelPool').closeKernel(kernelAccountId, { force: true }); } catch { /* ignore */ }
    }
    if (refundOnExit && chargeId) {
      try {
        const refunded = await refundMode1Video(chargeId);
        tracker.progress(refunded
          ? '↩️ 成片失败,已退回预扣的平台基础费'
          : '⚠️ 成片失败,平台基础费退回请求未成功(稍后可联系客服核对)');
      } catch { /* 退款失败不抛,仅日志 */ }
    }
    try { fs.rmSync(assetDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
