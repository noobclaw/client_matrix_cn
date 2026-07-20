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
import { resolveBundledFont } from './compose';
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
import {
  synthesize, synthesizeWhole, getVoiceFallbacksWide, getLastTtsError,
  groupWordCues, alignSentencesToCues, type TtsCue, type WholeTtsResult,
} from './tts';
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
/** 卡片显示宽(px)。RedditVideoMakerBot 原版是 45%(final_video.py:268),照搬到竖屏太小。
 *  2026-07-11 用户拍板「截图卡字要看得清」→ 0.62 提到 0.74;2026-07-20 用户再反馈
 *  「看不到字」→ 0.84,并配合截图端字号再放大(driver/threadProvider 注入 CSS)。
 *  上下仍留游戏画面保住品类灵魂。 */
const CARD_W = Math.round(W * 0.84); // ≈907
/** 卡片显示高上限:随宽等比缩小,超高长评论按此钳制不顶穿画面。 */
const CARD_MAX_H = Math.round(H * 0.7); // ≈1344
/** 卡片叠加不透明度(照 bot opacity=0.9,略提到 0.92):微透和游戏背景柔和融合,不生硬。 */
const CARD_OPACITY = 0.92;
/** 段间静音(秒),对齐 bot 的 silence_duration=0.3。 */
const GAP_SEC = 0.3;

/** 创作语言 → 默认音色(用户没选音色时);fallback 链由 getVoiceFallbacks 兜。
 *  2026-07-20 从 4 语扩到 10 语(对齐在线素材/模板速生),与向导 THREAD_LANG_VOICE 同表。 */
const LANG_DEFAULT_VOICE: Record<ContentLang, string> = {
  zh: 'zh-CN-YunjianNeural',
  'zh-TW': 'zh-TW-HsiaoChenNeural',
  en: 'en-US-GuyNeural',
  ja: 'ja-JP-KeitaNeural',
  ko: 'ko-KR-InJoonNeural',
  id: 'id-ID-GadisNeural',
  vi: 'vi-VN-HoaiMyNeural',
  es: 'es-MX-DaliaNeural',
  pt: 'pt-BR-FranciscaNeural',
  fr: 'fr-FR-DeniseNeural',
};

const LANG_NAME: Record<ContentLang, string> = {
  zh: '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어',
  id: 'Bahasa Indonesia', vi: 'Tiếng Việt', es: 'Español', pt: 'Português', fr: 'Français',
};

/** 拉丁字母语种(标点/连接词用西式:'. ' 与 ': ')。 */
const LATIN_LANGS = new Set<ContentLang>(['en', 'id', 'vi', 'es', 'pt', 'fr']);

/**
 * 粗校验文本是否像目标语言(2026-07-20 用户实测:AI 会被 prompt 里的中文示例带偏,英文/日韩
 * 任务照样输出中文;英文 voice 念中文只会蹦出几个拉丁用户名,整条片报废)。
 * 拉丁语种(en/id/vi/es/pt/fr)不得含汉字;ja 必须含假名(日文正常句子必带);ko 必须含谚文;
 * zh/zh-TW 须含汉字。校验不过 → 调用方弃用该 AI 产物、回退原文,宁可少主持词也不出「哑巴音频」。
 */
function looksLikeLang(text: string, lang: ContentLang): boolean {
  if (LATIN_LANGS.has(lang)) return !/[一-鿿]/.test(text);
  if (lang === 'ja') return /[ぁ-ゖァ-ヺ]/.test(text);
  if (lang === 'ko') return /[가-힣]/.test(text);
  return /[一-鿿]/.test(text); // zh / zh-TW
}

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
  /** edge-tts 短语级字幕 cue(相对本段起点,秒)。跳字大字幕模式用;无则按时长均分估算。 */
  cues?: TtsCue[];
}

function sanitizeName(s: string): string {
  // 空格换 _:目录名进日志后要被链接化(renderVideoLog),含空格的路径链接会断;
  // Finder/资源管理器里下划线也更整洁(2026-07-20 用户反馈「输出目录点不开」)。
  return (s || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
}

/** 一次 AI 调用把标题+评论翻译改写成目标语言。失败返回 null(保留英文原文出片)。 */
async function translateThread(
  post: RedditPost,
  comments: RedditComment[],
  lang: ContentLang,
  onCost: (tokens: number, usd: number) => void,
): Promise<{ title: string; bodies: Record<string, string>; postBody?: string; intro?: string; outro?: string; leadIns?: Record<string, string> } | null> {
  const sys = [
    `你是短视频「爆帖解说」主持人兼本地化译者。目标语言:${LANG_NAME[lang]}。把 Reddit 帖子做成有叙事感的口播:`,
    `0. 【铁律】所有输出字段(title/postBody/intro/outro/leadIns/comments)一律用目标语言 ${LANG_NAME[lang]} 书写,一个别的语言的字都不能混。下面规则里的示例是中文示意 —— 目标语言不是中文时,必须改写成目标语言的等价说法(如 English:「Today's top Reddit thread」),绝不能照抄中文。`,
    '1. 翻译改写:标题/正文/评论译成目标语言,口语化、保留原梗语气;俚语缩写(AITA/TIFU/OP)转成观众能懂的说法。目标语言与原文相同时原样保留、只做轻度口语顺滑。',
    '2. intro(开场,≤2句):第一句必须用「今日 Reddit 热帖」这类栏目感句式点题开场(让观众知道这是个每日栏目;目标语言非中文时用等价说法,如 English:「Today\'s top Reddit thread」),紧接着像主持人一样交代这帖在聊什么、冲突/悬念是什么(如「今日 Reddit 热帖:楼主说…大家直接吵翻了」)。',
    '3. leadIns:给每条评论写一个≤12字的引入短语,自然多样、可带网友名(如「网友Bannon9k直言」「有人当场反驳」「高赞回复说」);要尽量【承接上一条评论的观点】(赞同/反驳/补充/递进),让整条口播像一个连续展开的故事,而不是孤立地念评论;避免连续重复句式。',
    '4. outro(结尾,≤2句):总结各方观点或抛一个问题引导互动(如「你站哪边?评论区聊聊」)。',
    '5. 只输出严格 JSON(json):{"title":"…","postBody":"…(无则空串)","intro":"…","outro":"…","leadIns":{"<id>":"…"},"comments":{"<id>":"…"}},id 原样保留。',
  ].join('\n');
  const user = JSON.stringify({
    title: post.title,
    postBody: String(post.selftext || '').slice(0, 1500),
    comments: comments.map((c) => ({ id: c.id, author: c.author || '', text: c.body })),
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
    const postBody = typeof parsed?.postBody === 'string' ? parsed.postBody.trim() : '';
    const intro = typeof parsed?.intro === 'string' ? parsed.intro.trim() : '';
    const outro = typeof parsed?.outro === 'string' ? parsed.outro.trim() : '';
    const leadIns: Record<string, string> = {};
    if (parsed?.leadIns && typeof parsed.leadIns === 'object') {
      for (const [k, v] of Object.entries(parsed.leadIns)) {
        if (typeof v === 'string' && v.trim()) leadIns[k] = v.trim();
      }
    }
    return { title: title || post.title, bodies, postBody, intro, outro, leadIns };
  } catch {
    return null;
  }
}

/**
 * TTS 一段(逐段兜底路径)。失败返回 null(该段丢弃)。
 * 音色走【同语种全音色】宽链(#473 按音色族拒发,同性别链可能全灭,见 getVoiceFallbacksWide);
 * 出现超时型失败后,后续音色只试 1 次快速扫过。每段墙钟预算 6 分钟兜底(宽链最坏也能扫到
 * 可用音色);停止信号直通 synthesize,点停止立刻中断当次 WebSocket。
 */
const TTS_SEG_BUDGET_MS = 360_000;
async function ttsSeg(text: string, primary: string, outPath: string, rate?: number, signal?: AbortSignal, onLog?: (m: string) => void): Promise<{ audioPath: string; durationSec: number; cues?: TtsCue[] } | null> {
  const started = Date.now();
  let sawTimeout = false;
  for (const v of getVoiceFallbacksWide(primary)) {
    if (signal?.aborted) return null;
    if (Date.now() - started > TTS_SEG_BUDGET_MS) {
      onLog?.('⏱ 本段配音超出预算,放弃剩余备选音色');
      break;
    }
    const r = await synthesize(text, outPath, v, rate, { signal, maxAttempts: sawTimeout ? 2 : 3 });
    if (r.ok && r.synthesized && r.durationSec > 0.2) return { audioPath: r.audioPath, durationSec: r.durationSec, cues: r.cues };
    const why = getLastTtsError() || '';
    if (why.includes('超时')) sawTimeout = true;
    if (!signal?.aborted) onLog?.(`🔁 音色 ${v} 合成未成${why ? `(${why.slice(0, 70)})` : ''},换下一个音色…`);
  }
  return null;
}

// ── 跳字大字幕(TikTok 爆款风):短语 cue 内按词/字均分出词级时间 → ASS 卡拉OK ──
// edge-tts 的 cues 是短语级(≤12 字符,时间精确);词级用短语内均分估算(误差 <±0.2s,
// 视觉上完全够;TikTok TTS 等无时间戳引擎也能走同一套估算,不用改两份)。
function splitCueWords(cue: TtsCue): TtsCue[] {
  const txt = (cue.text || '').trim();
  if (!txt) return [];
  // 英文按空格分词;中文按 1~2 字成组(单字太碎,2 字一跳节奏最像爆款)。
  const hasCjk = /[一-鿿]/.test(txt);
  let parts: string[];
  if (hasCjk) {
    const chars = Array.from(txt.replace(/\s+/g, ''));
    parts = [];
    for (let i = 0; i < chars.length; i += 2) parts.push(chars.slice(i, i + 2).join(''));
  } else {
    parts = txt.split(/\s+/).filter(Boolean);
  }
  if (!parts.length) return [];
  const span = Math.max(0.05, cue.end - cue.start);
  const per = span / parts.length;
  return parts.map((p, i) => ({ text: p, start: cue.start + per * i, end: cue.start + per * (i + 1) }));
}

function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${rest}`;
}

function assEscape(s: string): string {
  return (s || '').replace(/\\/g, '＼').replace(/\{/g, '（').replace(/\}/g, '）').replace(/\r?\n/g, ' ');
}

/**
 * 生成跳字大字幕 ASS:每个词一条 Dialogue,居中偏上、大号粗体白字黑描边,
 * 词出现瞬间 120%→100% 缩放弹一下(爆款标志性 pop 动效)。
 * segs 的 startSec 必须已算好;cue 缺失的段按时长均分单词兜底。
 */
function buildKaraokeAss(segs: CardSeg[], outPath: string): void {
  const lines: string[] = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // 白字 + 黑描边 6 + 阴影 2,Alignment=5(正中),字号 88(1080 宽下和爆款接近)。
    'Style: Jump,Microsoft YaHei,88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,5,60,60,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Text',
  ];
  for (const seg of segs) {
    const base = seg.startSec || 0;
    // 有 cue 用 cue;没有 → 整段文本按时长均分成一个大 cue 再拆词。
    const cues: TtsCue[] = (seg.cues && seg.cues.length)
      ? seg.cues
      : [{ text: seg.text, start: 0, end: Math.max(0.4, seg.durationSec) }];
    for (const cue of cues) {
      for (const w of splitCueWords(cue)) {
        const st = base + w.start, en = base + w.end;
        if (en - st < 0.04) continue;
        // \an5 居中;pos 在画面 62% 高(卡片风格在中间,跳字放低一点避开截图卡区域也不挡脸)。
        // \fscx120\fscy120 → 80ms 内缩回 100:pop 动效。
        lines.push(`Dialogue: 0,${assTime(st)},${assTime(en)},Jump,,0,0,0,{\\an5\\pos(${Math.round(W / 2)},${Math.round(H * 0.62)})\\fscx120\\fscy120\\t(0,80,\\fscx100\\fscy100)}${assEscape(w.text)}`);
      }
    }
  }
  fs.writeFileSync(outPath, '﻿' + lines.join('\n'), 'utf8');
}

/** AI 把标题改写成前 3 秒钩子句(悬念/冲突前置)。失败返回原标题(不挡出片)。 */
async function hookifyTitle(
  title: string,
  lang: ContentLang,
  onCost: (tokens: number, usd: number) => void,
): Promise<string> {
  const sys = [
    `你是短视频爆款开头写手。把给定的帖子标题改写成${LANG_NAME[lang]}的「前 3 秒钩子」:`,
    '1. 把最炸的冲突/悬念/反差提到第一句,让人必须听下去;疑问句/悬念句优先。',
    '2. 不超过 30 个字(英文 15 词),口语化,禁止书面腔。',
    '3. 不编造标题里没有的事实,只做强化表达。',
    '4. 只输出严格 JSON(json):{"hook":"改写后的钩子"}',
  ].join('\n');
  try {
    const r = await callDeepSeek(sys, JSON.stringify({ title }), true, 60_000, 'noobclawai-chat');
    onCost(r.tokens, r.costUsd);
    const parsed = JSON.parse(extractJsonObject(r.content));
    const hook = typeof parsed?.hook === 'string' ? parsed.hook.trim() : '';
    if (hook && hook.length >= 4 && looksLikeLang(hook, lang)) return hook;
  } catch { /* 钩子失败不挡出片 */ }
  return title;
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
  /** 跳字大字幕 ASS(karaoke 风格);有则烧进画面(在卡片 overlay 之后)。 */
  assPath?: string;
  /** 顶部常驻抬头(如「今日 Reddit 热帖 · 7月20日」)。空 = 不画。 */
  headerText?: string;
  /** 底部口播字幕(热搜同款):全局时间轴短语 cue。空 = 不烧(karaoke 模式用 ASS)。 */
  subtitleCues?: Array<{ text: string; start: number; end: number }>;
  /** 蒙层(局部高斯模糊带)中心占画高比例。不传 = 不画。字幕/跳字都垫这条,观感同热搜。 */
  maskCenterRatio?: number;
  /** cue 文本文件落盘目录(drawtext textfile 用相对名 + ffmpeg cwd 指到这)。烧字幕时必传。 */
  workDir?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const cards = opts.segs.filter((s) => s.pngPath && typeof s.startSec === 'number');
  const inputs: string[] = ['-i', opts.basePath, '-i', opts.narrationPath];
  const hasBgm = !!opts.bgmPath;
  cards.forEach((c) => inputs.push('-i', c.pngPath!));
  if (hasBgm) inputs.push('-stream_loop', '-1', '-i', opts.bgmPath!);

  const parts: string[] = [];
  // 顶部抬头(2026-07-20 用户要求:视频上方常驻「今日 Reddit 热帖 + 日期」栏目标识)。
  // 画在底片上、卡片 overlay 之前:卡片高钳 0.7H 居中,顶部 0.15H 内不会与抬头相撞。
  // 需要内置 CJK 字体;没找到字体就跳过(不挡出片)。
  let baseIn = '[0:v]';
  if (opts.headerText) {
    const font = resolveBundledFont();
    if (font) {
      const fontEsc = font.replace(/\\/g, '/').replace(/:/g, '\\:');
      const textEsc = opts.headerText.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/,/g, '\\,');
      parts.push(
        `[0:v]drawtext=fontfile='${fontEsc}':text='${textEsc}':fontsize=52:fontcolor=white`
        + `:borderw=2:bordercolor=black@0.6:box=1:boxcolor=black@0.4:boxborderw=18`
        + `:x=(w-text_w)/2:y=96[vhdr]`,
      );
      baseIn = '[vhdr]';
    }
  }
  // 蒙层(2026-07-20 用户要求对齐热搜):在字幕中心处叠一条局部高斯模糊带,字幕画在带上。
  // 画在底片上、卡片 overlay 之前(卡片/字幕都在其上层)。配方同 compose.renderClipsBg。
  if (opts.maskCenterRatio) {
    const maskH = Math.round(H * 0.18);
    const maskY = Math.max(0, Math.min(Math.round(H * opts.maskCenterRatio) - Math.round(maskH / 2), H - maskH));
    parts.push(`${baseIn}split[vmb0][vmsrc];[vmsrc]crop=${W}:${maskH}:0:${maskY},boxblur=24:2[vmblur];[vmb0][vmblur]overlay=0:${maskY}[vmask]`);
    baseIn = '[vmask]';
  }
  // 卡片:缩到显示宽,超高的按高钳制(截图 2x DPI,缩小锐利)
  const scaleArgs: string[] = [];
  for (const c of cards) {
    const size = await probeImageSize(c.pngPath!);
    const dispH = size.width > 0 ? Math.round((size.height * CARD_W) / size.width) : 0;
    scaleArgs.push(dispH > CARD_MAX_H ? `scale=-2:${CARD_MAX_H}` : `scale=${CARD_W}:-2`);
  }
  cards.forEach((c, i) => {
    // 缩到显示宽 + 整卡半透明(format=rgba 保 alpha,colorchannelmixer aa 压全局不透明度)。
    // 照 bot 的 colorchannelmixer=aa=opacity,让卡片跟游戏背景柔和融合而非实心糊上去。
    parts.push(`[${2 + i}:v]${scaleArgs[i]},format=rgba,colorchannelmixer=aa=${CARD_OPACITY}[c${i}]`);
  });
  // 底部口播字幕(热搜同款,cards 模式):需要内置字体 + workDir(textfile 相对名)。
  const subFont = (opts.subtitleCues && opts.subtitleCues.length && opts.workDir) ? resolveBundledFont() : null;
  const burnSubs = !!subFont;
  // 链尾:有 ASS(跳字)→ [vpre] 烧 ASS 出 [vout];有底部字幕 → [vcards] 接 drawtext 出 [vout];都无 → 直接 [vout]。
  const vEnd = opts.assPath ? '[vpre]' : burnSubs ? '[vcards]' : '[vout]';
  let cur = baseIn;
  cards.forEach((c, i) => {
    const next = i === cards.length - 1 ? vEnd : `[ov${i}]`;
    parts.push(`${cur}[c${i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,${c.startSec!.toFixed(2)},${c.endSec!.toFixed(2)})'${next}`);
    cur = next;
  });
  if (cards.length === 0) parts.push(`${baseIn}null${vEnd}`);
  if (opts.assPath) {
    // Windows 路径进 filter 要 / 分隔 + 冒号转义;整个文件名再包引号防空格。
    const assEsc = opts.assPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    parts.push(`[vpre]subtitles=filename='${assEsc}'[vout]`);
  }
  if (burnSubs) {
    // 每条短语 cue 一个 drawtext(textfile 落盘避开转义地狱,ffmpeg cwd 指到 workDir)。
    // 字幕垂直中心 = 蒙层中心(maskCenterRatio,默认 0.86)→ 字幕稳稳落在模糊带正中,同热搜。
    const fontEsc2 = subFont!.replace(/\\/g, '/').replace(/:/g, '\\:');
    const centerY = Math.round(H * (opts.maskCenterRatio || 0.86));
    const draws = opts.subtitleCues!.map((c, j) => {
      const txtName = `thrsub_${String(j).padStart(4, '0')}.txt`;
      fs.writeFileSync(path.join(opts.workDir!, txtName), (c.text || '').trim(), 'utf8');
      return `drawtext=fontfile='${fontEsc2}':textfile=${txtName}:fontsize=54:fontcolor=white`
        + `:box=1:boxcolor=black@0.45:boxborderw=22:x=(w-text_w)/2:y=${centerY}-text_h/2`
        + `:enable='between(t,${c.start.toFixed(2)},${Math.max(c.start + 0.15, c.end).toFixed(2)})'`;
    });
    parts.push(`[vcards]${draws.join(',')}[vout]`);
  }

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
  ], { timeoutMs: 900_000, signal: opts.signal, cwd: opts.workDir });
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

  const lang: ContentLang = (['zh', 'zh-TW', 'en', 'ja', 'ko', 'id', 'vi', 'es', 'pt', 'fr'] as ContentLang[]).includes(input.threadLang as ContentLang)
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
    // 去重改【全局】(2026-07-20 用户反馈:每个任务各存各的已用表,新建任务后又抽中同一个
    // 高赞帖)。所有爆帖任务共用 'thread__global' 一张表;兼容读老的 per-task 记录。
    const THREAD_USED_KEY = 'thread__global';
    const usedIds = [...new Set([...getUsedHotspots(THREAD_USED_KEY), ...getUsedHotspots(input.taskId || '')])];
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
    let trPostBody = '';
    let hostIntro = '';
    let hostOutro = '';
    let leadIns: Record<string, string> = {};
    // 主持人叙事(2026-07-18 用户反馈「只念评论完全看不懂」):所有语言(含英文)都过一次 AI,
    // 产出 开场intro + 每条评论引入语 + 结尾outro;英文时原文保留只写主持词。失败回落生读(老行为)。
    {
      let tr = await translateThread(post, translateCandidates, lang, (tk, usd) => tracker.addTokens(tk, usd));
      // 语言兜底(2026-07-20 用户实测「英文配出来只有几个名字」):AI 会被中文示例带偏、
      // 非中文任务照样输出中文稿 → 目标语言 voice 念不出来。整稿语言校验不过就作废,
      // 回退原文生读(宁可没主持词,不能出「只念名字」的哑巴音频)。
      if (tr) {
        const joined = [tr.title, tr.postBody || '', tr.intro || '', tr.outro || '',
          ...Object.values(tr.leadIns || {}), ...Object.values(tr.bodies)].filter(Boolean).join(' ');
        if (!looksLikeLang(joined, lang)) {
          tracker.progress(`⚠️ 主持稿语言不符(未按 ${LANG_NAME[lang]} 输出),弃用主持稿,按原文生读`);
          tr = null;
        }
      }
      if (tr) {
        trTitle = tr.title;
        trBodies = tr.bodies;
        trPostBody = tr.postBody || '';
        hostIntro = tr.intro || '';
        hostOutro = tr.outro || '';
        leadIns = tr.leadIns || {};
        tracker.progress(`✅ 主持稿就绪(开场+${Object.keys(tr.bodies).length} 条评论引入+结尾${lang !== 'en' ? ' · 已本地化' : ''})`);
      } else {
        tracker.progress('⚠️ 主持稿生成失败,本条按原文生读出片');
      }
    }
    const voice = input.voice || LANG_DEFAULT_VOICE[lang];
    const rate = typeof input.voiceRate === 'number' ? input.voiceRate : 0;
    // 评论多音色已取消(2026-07-19 用户拍板):评论经主持稿(引入语)织进整条口播,本来
    // 就是一个主持人从头讲到尾;多音色要按音色拆多次 edge-tts 请求,连接频率一高就被微软
    // 掐(限频/黑洞),爆帖因此必卡而单请求的模板速生从不失败。现在整条口播【单音色一次
    // 请求】合成 —— 和模板速生同款请求量。

    const segs: CardSeg[] = [];
    let acc = 0;
    // 标题永远第一段。开头 3 秒钩子:AI 把标题改写成悬念句(冲突前置),抓住前 3 秒;
    // 失败自动退回原标题,不挡出片。截图卡上仍显示原标题(卡是 Reddit 原貌),钩子只进口播+跳字。
    let titleText = (trTitle || post.title).trim();
    const hooked = await hookifyTitle(titleText, lang, (tk, usd) => tracker.addTokens(tk, usd));
    if (hooked && hooked !== titleText) {
      tracker.progress(`🪝 开头钩子:「${hooked.slice(0, 40)}」`);
      titleText = hooked;
    }
    // 帖子正文(selftext)以前被整个跳过 —— 故事型帖(TIFU/AITA 等)正文才是主菜,只念评论
    // 观众不知所云(2026-07-18 用户反馈,对标 RedditVideoMakerBot 它是念正文的)。正文跟在
    // 标题后同段朗读(画面即帖子卡);截 900 字防吃光片长,评论仍按剩余时长逐条截断。
    const postBodyText = (trPostBody || String(post.selftext || '')).trim().slice(0, 900);
    // 段落结构:钩子标题 → 主持人开场(交代主题背景) → 帖子正文
    // 拼接补句号:前段已带句末标点就不再加(修「Think again.。今日…」双标点);英文用 '. '。
    const joinSpeech = (a: string, b: string) => {
      const t = a.trim();
      const latin = LATIN_LANGS.has(lang);
      const ended = /[。.!?！?…"」』]$/.test(t);
      return t + (ended ? (latin ? ' ' : '') : (latin ? '. ' : '。')) + b;
    };
    if (hostIntro) titleText = joinSpeech(titleText, hostIntro);
    if (postBodyText) titleText = joinSpeech(titleText, postBodyText);
    // ── 一口气配音(2026-07-19 用户拍板):整条口播【单音色 1 次 edge-tts 请求】合成,
    //   再按 cue 时间戳切回各段(卡片时间窗) —— 请求数 15+ → 1,和「从不失败」的模板速生
    //   同款请求量,从根上躲开限频/黑洞。合成失败 / 切段对不齐 → 回退逐段 ttsSeg(有界)。
    //   评论按【估算时长】预裁到 ~1.5× 目标片长再进大文本:13 条全合是浪费(60s 片通常只
    //   用 5~8 条),文本越短合成越快、对齐越稳。
    const onTtsLog = (m: string) => tracker.progress(m);
    interface PlanSeg { key: string; text: string; voice: string; outPath: string }
    const plan: PlanSeg[] = [{ key: 'title', text: titleText, voice, outPath: path.join(assetDir, 'seg-title.mp3') }];
    const estSec = (s: string) => s.replace(/\s+/g, '').length / 4.5;
    let planEstSec = estSec(titleText);
    for (const c of translateCandidates) {
      if (planEstSec > targetSeconds * 1.5 + 8) break;
      let text = (trBodies[c.id] || c.body).trim();
      if (!text) continue;
      // 主持人引入:「网友XX直言」「有人反驳道」…(AI 给的;没给则不加,保持生读)
      const lead = (leadIns[c.id] || '').trim();
      if (lead) text = lead + (LATIN_LANGS.has(lang) ? ': ' : ':') + text;
      plan.push({ key: c.id, text, voice, outPath: path.join(assetDir, `seg-${c.id}.mp3`) });
      planEstSec += estSec(text);
    }
    // 组结构保留(单音色 = 恒 1 组;将来要恢复多音色只用改 voice 赋值)。
    const groups = new Map<string, PlanSeg[]>();
    for (const s of plan) { const g = groups.get(s.voice); if (g) g.push(s); else groups.set(s.voice, [s]); }
    /**
     * 一段文本整段一口气合成;失败返回 null,由调用方决定兜底。
     * fallback 用【同语种全音色】宽链(2026-07-19 真机:#473 按音色族拒发,云健/云希/云扬
     * 全灭时晓晓正常 —— 同性别链会 9 分钟全军覆没,跨性别才能出片)。首个音色试 2 次;
     * 一旦出现【超时型】失败(= 拒发的典型表现,重试同音色无意义),后续每个音色只试 1 次,
     * 快速扫到能用的音色为止。
     */
    let sawTtsTimeout = false;
    const deadVoices = new Set<string>(); // 本次任务内确认被拒发(超时)的音色,后续组直接跳过不再撞墙
    const oneShot = async (text: string, primary: string, outPath: string): Promise<WholeTtsResult | null> => {
      for (const v of getVoiceFallbacksWide(primary)) {
        if (deadVoices.has(v)) continue;
        throwIfAborted(signal);
        const w = await synthesizeWhole(text, outPath, v, rate, { signal, maxAttempts: sawTtsTimeout ? 2 : 3 });
        if (w.ok) {
          if (v !== primary) tracker.progress(`🎤 已改用备选音色 ${v}(原音色被上游拒发)`);
          return w;
        }
        const why = getLastTtsError() || '';
        if (why.includes('超时')) { sawTtsTimeout = true; deadVoices.add(v); }
        if (!signal?.aborted) tracker.progress(`🔁 音色 ${v} 整段合成未成${why ? `(${why.slice(0, 90)})` : ''},换下一个音色…`);
      }
      return null;
    };
    const made = new Map<string, { audioPath: string; durationSec: number; cues?: TtsCue[] }>();
    let gi = 0;
    for (const [gv, gsegs] of groups) {
      gi++;
      throwIfAborted(signal);
      tracker.progress(`🎙 一口气配音 ${gi}/${groups.size}(音色 ${gv} · ${gsegs.length} 段 · ${gsegs.reduce((a, s) => a + s.text.length, 0)} 字)…`);
      let groupDone = false;
      if (gsegs.length === 1) {
        const w = await oneShot(gsegs[0].text, gv, gsegs[0].outPath);
        if (w) {
          made.set(gsegs[0].key, { audioPath: w.audioPath, durationSec: w.durationSec, cues: w.rawCues.length ? groupWordCues(w.rawCues) : undefined });
          groupDone = true;
        }
      } else {
        const groupMp3 = path.join(assetDir, `narr-group-${gi}.mp3`);
        const w = await oneShot(gsegs.map((s) => s.text).join('\n'), gv, groupMp3);
        if (w) {
          // 切段对齐照抄 stock(pipeline.ts 一口气路径):字符流锚 cue 真实时间戳,不累积误差。
          const spans = alignSentencesToCues(gsegs.map((s) => s.text), w.rawCues, w.durationSec);
          if (spans && spans.length === gsegs.length) {
            let cutOk = true;
            for (let i = 0; i < gsegs.length; i++) {
              throwIfAborted(signal);
              const r = await runFfmpeg([
                '-y', '-i', groupMp3,
                '-ss', spans[i].start.toFixed(3), '-to', spans[i].end.toFixed(3),
                '-c:a', 'libmp3lame', '-q:a', '4', gsegs[i].outPath,
              ], { timeoutMs: 30_000, signal });
              if (!r.ok || !fs.existsSync(gsegs[i].outPath)) { cutOk = false; break; }
              // 本段 cue = 整段 cue 落在本段时间窗内的,平移成段内相对时间(CardSeg.cues 契约)。
              // 按 cue 起点归段(边界 cue 归后段,与 filter 上界互斥 → 不会两段重复出词)
              const segCues = w.rawCues
                .filter((c) => c.start >= spans[i].start && c.start < spans[i].end)
                .map((c) => ({
                  text: c.text,
                  start: Math.max(0, c.start - spans[i].start),
                  end: Math.max(0.05, Math.min(c.end, spans[i].end) - spans[i].start),
                }));
              made.set(gsegs[i].key, {
                audioPath: gsegs[i].outPath,
                durationSec: Math.max(0.3, spans[i].end - spans[i].start),
                cues: segCues.length ? groupWordCues(segCues) : undefined,
              });
            }
            groupDone = cutOk;
          } else {
            tracker.progress(`↩️ 音色 ${gv} 切段对不齐(edge-tts 念读与文本差异过大)`);
          }
        }
      }
      if (!groupDone) {
        throwIfAborted(signal);
        if (getVoiceFallbacksWide(gv).every((v) => deadVoices.has(v))) {
          tracker.progress('⚠️ 同语种全部音色均被上游拒发/超时,该组跳过逐段兜底');
          continue;
        }
        if (gsegs.length > 1) tracker.progress(`↩️ 该组回退逐段配音(${gsegs.length} 段,已切好的保留)…`);
        for (const s of gsegs) {
          throwIfAborted(signal);
          if (made.has(s.key)) continue; // 切到一半失败的组:已切好的段不重配
          tracker.progress(`🎙 逐段配音:${s.key === 'title' ? '标题+开场' : `评论 ${s.key}`}(${s.text.length} 字)…`);
          const r = await ttsSeg(s.text, s.voice, s.outPath, rate, signal, onTtsLog);
          if (r) made.set(s.key, r);
          else { throwIfAborted(signal); if (s.key !== 'title') tracker.progress(`⚠️ 评论 ${s.key} 配音失败,跳过`); }
        }
      }
    }
    throwIfAborted(signal);
    const t0 = made.get('title');
    if (!t0) {
      const why = getLastTtsError() || '请稍后再试';
      tracker.fail('voice', `标题配音失败:${why}`);
      return { ok: false, error: `配音失败:${why}` };
    }
    segs.push({ key: 'title', text: titleText, audioPath: t0.audioPath, durationSec: t0.durationSec, cues: t0.cues });
    acc += t0.durationSec;
    // 按段序组装,超 targetSeconds 停(bot 的 max_length 截断逻辑;多合成的段直接弃用)
    for (const s of plan) {
      if (s.key === 'title') continue;
      if (acc >= targetSeconds) break;
      const r = made.get(s.key);
      if (!r) continue;
      segs.push({ key: s.key, text: s.text, audioPath: r.audioPath, durationSec: r.durationSec, cues: r.cues });
      acc += r.durationSec + GAP_SEC;
    }
    if (segs.length < 2) {
      tracker.fail('voice', '可用配音段不足(标题之外没有评论段成功)');
      return { ok: false, error: '配音段不足,请重试' };
    }
    // 主持人结尾:总结/抛问接在【最后一条评论段】末尾重配(同卡同音色,不动画面映射)。
    if (hostOutro) {
      const last = segs[segs.length - 1];
      try {
        const lastVoice = plan.find((p) => p.key === last.key)?.voice || voice;
        const merged = joinSpeech(last.text, hostOutro);
        tracker.progress('🎙 配音收尾:结尾总结并入最后一段…');
        const w = await oneShot(merged, lastVoice, path.join(assetDir, `seg-${last.key}-outro.mp3`));
        if (w) {
          acc += w.durationSec - last.durationSec;
          last.text = merged; last.audioPath = w.audioPath; last.durationSec = w.durationSec;
          last.cues = w.rawCues.length ? groupWordCues(w.rawCues) : undefined;
          tracker.progress('🎬 结尾总结已并入最后一段');
        }
      } catch (e) { if (signal?.aborted) throw e; /* 失败保留原段 */ }
    }
    tracker.done('voice', `✅ 配音完成 · ${segs.length} 段(标题+${segs.length - 1}条神评)· 约 ${Math.round(acc)}s · ${groups.size + (hostOutro ? 1 : 0)} 次整段合成`);

    // ── STEP 3:画面素材 ─────────────────────────────────────────────────
    // 风格分流(threadCaptionStyle):'cards'(默认)= Reddit 真截图卡;'karaoke' = 跳字大字幕
    //   (TikTok 爆款风,不放截图卡 → 跳过整个截图阶段,快很多)。
    throwIfAborted(signal);
    const captionStyle = String((input as any).threadCaptionStyle || 'cards') === 'karaoke' ? 'karaoke' : 'cards';
    let alive: CardSeg[];
    if (captionStyle === 'karaoke') {
      tracker.start('cards', '🔤 跳字大字幕模式:跳过截图,按词时间轴生成字幕…');
      alive = segs;
    } else {
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
    alive = [];
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
    // 跳字大字幕:按段起点 + 词时间轴生成 ASS(卡片模式不生成)。
    let assPath: string | undefined;
    if (captionStyle === 'karaoke') {
      try {
        assPath = path.join(assetDir, 'karaoke.ass');
        buildKaraokeAss(alive, assPath);
        tracker.progress('🔤 跳字字幕就绪(逐词弹出,随配音节奏)');
      } catch (e) {
        assPath = undefined;
        tracker.progress(`⚠️ 跳字字幕生成失败(${String((e as Error)?.message || e).slice(0, 60)}),本条无字幕出片`);
      }
    }
    tracker.progress(captionStyle === 'karaoke' ? '🎞️ 合成中(游戏背景 + 跳字大字幕)…' : '🎞️ 合成中(卡片按配音时间窗依次上屏)…');
    const outPath = path.join(destDir, outputFileName(0));
    // 顶部常驻抬头「今日 Reddit 热帖 · M月D日」(2026-07-20 用户要求,栏目感)。
    // 思源黑体SC 覆盖中/日/拉丁,无谚文 → 韩语和拉丁语种统一用英文抬头;日期用出片当天。
    const now = new Date();
    const headerText = (() => {
      const m = now.getMonth() + 1; const d = now.getDate();
      if (lang === 'zh') return `今日 Reddit 热帖 · ${m}月${d}日`;
      if (lang === 'zh-TW') return `今日 Reddit 熱帖 · ${m}月${d}日`;
      if (lang === 'ja') return `本日のReddit人気投稿 · ${m}月${d}日`;
      return `Reddit Daily Hot · ${now.toLocaleString('en-US', { month: 'short' })} ${d}`;
    })();
    // 底部口播字幕(2026-07-20 用户要求对齐热搜:大蒙层 + 字幕)。cards 模式烧短语字幕
    // (全局时间轴 = 段起点 + 段内 cue;无 cue 的段整段文本兜底);karaoke 模式跳字就是字幕,
    // 只把蒙层垫到跳字中心(0.62H)。
    const globalSubCues = captionStyle === 'karaoke' ? undefined : alive.flatMap((s) => {
      const base = s.startSec || 0;
      // 无 cue 的段(静音兜底等):整段文本按 ~14 字均分伪 cue,防一条字幕溢出一行。
      const cs: TtsCue[] = (s.cues && s.cues.length) ? s.cues : (() => {
        const t = s.text.replace(/\s+/g, ' ').trim();
        const n = Math.max(1, Math.ceil(t.length / 14));
        const per = Math.max(0.4, s.durationSec / n);
        return Array.from({ length: n }, (_, i) => ({
          text: t.slice(i * 14, (i + 1) * 14),
          start: i * per,
          end: Math.min(Math.max(0.4, s.durationSec), (i + 1) * per),
        }));
      })();
      return cs.map((c) => ({ text: c.text, start: base + c.start, end: base + c.end }));
    });
    const composed = await composeThreadVideo({
      basePath, narrationPath, segs: alive, totalSec,
      bgmPath: bgm, bgmVolume: typeof input.bgmVolume === 'number' ? input.bgmVolume : 0.15,
      outPath, assPath, headerText, signal,
      subtitleCues: globalSubCues,
      maskCenterRatio: captionStyle === 'karaoke' ? 0.62 : 0.86,
      workDir: assetDir,
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
    // 已做去重口径对齐 hotspot:仅存本地出片成功 = 用过;选了平台则 ≥1 个发布成功才算。
    // 记到全局表(所有爆帖任务共用,防跨任务重复选帖)。
    if (platforms.length === 0 || publishedCount > 0) {
      markHotspotUsed('thread__global', post.id);
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
