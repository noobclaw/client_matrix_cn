/**
 * repost-pipeline —— 翻译搬运(engine='repost')。
 *
 * 拿一条现成视频(链接或本地文件)→ 抽音 → 后端 ASR 转带时间戳字幕 → 句子重组 →
 * 翻译 → 逐句配音并对齐原时间轴 → 换音轨(可选保留原声垫底)+ 可选烧译文字幕 →
 * 多平台发布。前半段(下载/转写/重组/翻译)是本引擎独有;后半段(发布文案 + 发布)
 * 完全复用现有基建。
 *
 * 音画对齐策略(结构对齐 KrillinAI 的 dubbing 包,详见 dubPlan.ts):
 *   ① 时间轴来自【原音轨的词级时间戳】,不是 TTS —— ASR 出 words[] → resplitByWords 切句 →
 *      regroupSegments 重组 → 译文贴回原窗口。这一点和 KrillinAI 的 GenerateTimestamps 同源。
 *   ② 【合块】挨得近的短句(间隙 ≤1.2s 且其一 <2.5s,最多 4 句)并成一块,**整块一次 TTS**。
 *      逐句合成每句都带独立朗读收尾,拼起来一顿一顿;整块合成块内语气连贯、共用一个速度因子。
 *   ③ 【先估后合成】统计式估时(中文 4.2 字/秒、英文 13.5 字符/秒 + 标点/数字/缩写惩罚)在花钱
 *      之前判断超不超窗:超出 atempo 能吃的部分 → 一次 LLM 批量精简;吃得下的不动文字。
 *   ④ 【贴轴】块实测/块窗口 = 速度因子,atempo 封顶 1.25;块内各句按估时权重分摊出字幕时间。
 *      说得短 → 尾部垫静音到下一块原始起点(硬锚点纠偏);说得长 → 顺延,靠块间空隙还债。
 * 每块 TTS 先 trim 首尾静音(synthesize 已在内部处理),否则拼接漂移会雪崩。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { runFfmpeg, probeDuration, probeImageSize, probeVideoCodec, isFfmpegAvailable, getFfmpegPath } from './ffmpegRuntime';
import { getYtdlpPath, detectSystemProxy } from './ytdlpRuntime';
import { resolveBgmPath } from './bgm';
import { getVideoConfig } from './videoConfig';
import { synthesize, getVoiceFallbacks, getLastTtsError, alignSentencesToCues, voiceProviderLabel, type TtsCue } from './tts';
import {
  speechProfileFor, estimateSpeechSeconds, rateScale, makeChunks, chunkText, distributeChunk, textUnits,
  budgetPerSecond, type DubCue,
} from './dubPlan';
import { resolvePublishCaption } from './publishCaptionWriter';
import { callDeepSeek } from './scriptWriter';
import { chargeRepostVideo, refundMode1Video } from './billing';
import { getNoobClawAuthToken } from '../claudeSettings';
import {
  ProgressTracker, resolveOutputDirs, throwIfAborted,
  type VideoCreationInput, type VideoCreationResult, type ProgressEmitter,
} from './pipeline';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

// 翻译搬运专属步骤集(替代默认 script/tts/visuals/compose/publish)。
// ── 服务端可调参数(admin repost_* → /api/video/config 下发;拉不到用默认=历史行为)。
// 模块级单例:每次 runRepostPipeline 开跑时刷新一次。调这些不用重新打包客户端。
const TUNE = {
  // 0 = 自动按估时器推导(budgetPerSecond)。admin 填了非零值才覆盖 ——
  // 两套数各调各的正是「译文用满预算就必被判超窗」的根因。
  budgetCjk: 0, budgetLatin: 0,
  rateHi: 1.08, rateLo: 0.9, rateUpMax: 15, rateDownMax: 10,
  lineBoost: 20, atempoMax: 1.25, stretchMax: 1.15,
  gapSplit: 1.0, unitsSplit: 36,
  // 一条最长几秒 —— 自动字幕没标点时全靠它兜底。见 maxCueSec 那段说明:
  // 窗口越长,窗口内「译文比画面早」的漂移越大(9s→2.2s,5s→1.2s)。
  maxCueSec: 5,
  // 配音合块(dubPlan):短于 chunkMinDur 且间隙 ≤chunkGap 的相邻句并成一块整块合成,最多 chunkMax 句。
  chunkMinDur: 2.5, chunkGap: 1.2, chunkMax: 4,
  maskRatio: 0.16, fontDivisor: 700,
  // ⚠️ 优先挑 H.264(avc1)+ AAC(mp4a),别只写 bv*+ba。「最佳画质」在 YouTube 上通常是
  //    VP9/AV1,封进 mp4 规范上合法但 Windows Media Player / QuickTime / 多数平台播不了
  //    (真机反馈:下下来的源片打不开)。四级回退,每级都【显式配一条音轨】——
  //    不能退化成 ext=mp4 那种写法,TikTok 的"最佳 mp4"可能是纯视频无音轨,抽音必挂。
  //    实在没有 H.264 的站才落到最后一级(照旧 bv*+ba/b),那时靠合成阶段转码兜底。
  ytdlpFormat: 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba/b[vcodec^=avc1]/bv*+ba/b',
  ytdlpExtractorArgs: 'youtube:player_client=android,ios',
  translatePrompt: '', condensePrompt: '',
};
async function refreshTune(): Promise<void> {
  try {
    const c: any = await getVideoConfig();
    const n = (v: unknown, dv: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dv);
    TUNE.budgetCjk = n(c?.repostBudgetCjk, 0);
    TUNE.budgetLatin = n(c?.repostBudgetLatin, 0);
    TUNE.rateHi = n(c?.repostRateHi, TUNE.rateHi);
    TUNE.rateLo = n(c?.repostRateLo, TUNE.rateLo);
    TUNE.rateUpMax = n(c?.repostRateUpMax, TUNE.rateUpMax);
    TUNE.rateDownMax = n(c?.repostRateDownMax, TUNE.rateDownMax);
    TUNE.lineBoost = n(c?.repostLineBoost, TUNE.lineBoost);
    TUNE.atempoMax = n(c?.repostAtempoMax, TUNE.atempoMax);
    TUNE.stretchMax = n(c?.repostStretchMax, TUNE.stretchMax);
    TUNE.gapSplit = n(c?.repostGapSplit, TUNE.gapSplit);
    TUNE.unitsSplit = n(c?.repostUnitsSplit, TUNE.unitsSplit);
    TUNE.maxCueSec = n(c?.repostMaxCueSec, TUNE.maxCueSec);
    TUNE.chunkMinDur = n(c?.repostChunkMinDur, TUNE.chunkMinDur);
    TUNE.chunkGap = n(c?.repostChunkGap, TUNE.chunkGap);
    TUNE.chunkMax = n(c?.repostChunkMax, TUNE.chunkMax);
    TUNE.maskRatio = n(c?.repostMaskRatio, TUNE.maskRatio);
    TUNE.fontDivisor = n(c?.repostFontDivisor, TUNE.fontDivisor);
    if (typeof c?.repostYtdlpFormat === 'string' && c.repostYtdlpFormat.trim()) TUNE.ytdlpFormat = c.repostYtdlpFormat.trim();
    if (typeof c?.repostYtdlpExtractorArgs === 'string' && c.repostYtdlpExtractorArgs.trim()) TUNE.ytdlpExtractorArgs = c.repostYtdlpExtractorArgs.trim();
    TUNE.translatePrompt = typeof c?.repostTranslatePrompt === 'string' ? c.repostTranslatePrompt : '';
    TUNE.condensePrompt = typeof c?.repostCondensePrompt === 'string' ? c.repostCondensePrompt : '';
  } catch { /* 没网/没登录 → 保持默认 */ }
}

const REPOST_STEPS = [
  { key: 'source', label: '获取源视频' },
  { key: 'transcribe', label: '语音转写' },
  { key: 'translate', label: '翻译文案' },
  { key: 'voice', label: '配音并对齐' },
  { key: 'compose', label: '合成成片' },
  { key: 'publish', label: '发布到各大平台' },
];

// ASR 返回的一条字幕(时间戳单位=秒)。
interface AsrWord { text: string; start: number; end: number }
interface Seg {
  start: number;
  end: number;
  text: string;
  /** 词级时间戳(火山 bigmodel ASR)。用来把粗 utterance 重切成字幕粒度的句子。 */
  words?: AsrWord[];
}

/**
 * 词间静音超过这个秒数,就当说话人换了一句 —— 有些语言/口语里句末没有标点,
 * 停顿是唯一可靠的句界信号。
 */
const SENTENCE_PAUSE_SEC = 0.6;

/**
 * ── 切句(移植自 KrillinAI `pkg/util/subtitle.go` 的 protectSpecialNumbers +
 *    splitByCompleteSentences)────────────────────────────────────────────────
 *
 * ⚠️【真机 bug 的根因,别再退回去】我们原来的句末判据是 `/[。！？!?…]$/` —— **没有半角
 *   句号 `.`**。英文句子就是以 `.` 收尾,于是对英文源片整个切句层等于不工作,只能靠
 *   「词间静音 ≥0.6s」兜底;语速快的口播句间没有 0.6s 停顿 → 三四句并成一个翻译单元 →
 *   一条字幕塞三句中文同屏(真机:原片一句 "The water is overflowing",我们出
 *   「水溢出来了。我的衣柜满出来了。行李箱满出来了。」)。
 *
 * KrillinAI 的做法是对的:句末标点表第一个就是 `"."`,再用一组「保护模式」先把不是句号
 *   的点(小数、版本号、时间、域名、Mr./a.m.、列表编号)挡掉。下面按同一套模式移植。
 */
const PROTECT_PATTERNS: RegExp[] = [
  /\d+\.[A-Za-z]/,                                   // 列表编号 "1.value"
  /^[A-Za-z0-9-]+\.(?:com|org|net|edu|gov|io|ai|co|me|tv|app|dev|cn|jp|kr|uk|de|fr|es|it|ru|in|au|ca|br)$/i, // 域名
  /^[ap]\.m\.$/i,                                    // a.m. / p.m.
  /^\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?$/i,          // 时间 3.30 / 3:30pm
  /^\d+\.\d+$/,                                      // 小数 1.3
  /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/,                  // 千位分隔 1,234.5
  /^\d+(?:\.\d+)+$/,                                 // 版本号 2.5.1
  /^(?:[A-Z][a-z]*\.){2,}$/,                         // U.S.A. 型缩写
  /^(?:[A-Z]\.){2,}[A-Z]?$/,                         // U.S. 型缩写
  /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Co|No|Fig|Approx)\.$/i, // 称谓/常用缩写
  /^\d+\.$/,                                         // 列表编号 "1."
  /^[A-Za-z]\.$/,                                    // 字母编号 "a."
];

/** 这个 token 里的点是「不该断句的点」吗(小数/缩写/域名/时间/编号)。 */
function isProtectedToken(token: string): boolean {
  const t = token.trim().replace(/^[("'「『【[]+/, ''); // 去掉前引号再判,别让 ("1.3" 漏网
  return PROTECT_PATTERNS.some((re) => re.test(t));
}

/**
 * 一个 token 是不是句子结尾。全角标点直接算;半角 `.` 先过保护模式。
 * 宁可多切不可少切 —— 多切只是字幕短一点,少切就是三句挤一屏。
 */
function isSentenceEndToken(token: string): boolean {
  const t = token.trim().replace(/["'」』』)\]]+$/, ''); // 尾引号/括号不影响判断
  if (!t) return false;
  if (/[。！？!?…；;]$/.test(t)) return true;
  if (!/\.$/.test(t)) return false;
  return !isProtectedToken(t);
}

/**
 * 文本级保护模式(同上表,但不锚定、带 g,用于整段替换)。中文没有空格,不能按空白
 * token 判句末 —— 必须走 Krillin 那套「保护 → 按标点插分隔符 → 还原」。
 */
const PROTECT_GLOBAL: RegExp[] = [
  /\b\d+\.[A-Za-z]/g,
  /\b[A-Za-z0-9-]+\.(?:com|org|net|edu|gov|io|ai|co|me|tv|app|dev|cn|jp|kr|uk|de|fr|es|it|ru|in|au|ca|br)\b/gi,
  /\b[ap]\.m\./gi,
  /\b\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?\b/gi,
  // ⚠️ 版本号必须排在小数【前面】。`\b\d+\.\d+\b` 会先把 "2.5.1" 里的 "2.5" 吃掉,
  //    剩一个孤零零的 ".1",于是 "Version 2.5.1" 被切成 "Version 2.5." + "1"。
  //    (KrillinAI 原版就是小数在前,这个坑它也有。)
  /\b\d+(?:\.\d+)+\b/g,
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g,
  /\b\d+\.\d+\b/g,
  /(?:[A-Z][a-z]*\.){2,}|(?:[A-Z]\.){2,}[A-Z]?/g,
  /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Co|No|Fig|Approx)\./gi,
  /\b\d+\.\s/g,
  /\b[A-Za-z]\.\s/g,
];

// 占位符/分隔符用 Unicode 私用区(正文绝不会出现)。⚠️ 用 fromCharCode 显式构造,别在源码里写
// 字面量 —— 私用区字符在编码转换/复制粘贴里会被静默吃掉,那时保护就完全失效了。
const PH_OPEN = String.fromCharCode(0xE000);
const SPLIT_MARK = String.fromCharCode(0xE001);

/**
 * 把一段文本按句末标点拆成句子。用于**没有词级时间戳**的来源(SRT 字幕 / YouTube CC /
 * 非火山 ASR / 后端没部署)—— 这些走不到 resplitByWords,以前整段只能当一句。
 *
 * 三步(移植 KrillinAI):① 把小数/版本号/域名/缩写/编号里的点换成占位符;
 * ② 在 `.!?;。！？；` 连续标点后插分隔符再 split;③ 还原占位符。
 * 拆不出多句时返回 [原文]。
 */
function splitTextSentences(text: string): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const kept: string[] = [];
  let t = raw;
  for (const re of PROTECT_GLOBAL) {
    t = t.replace(re, (m) => {
      kept.push(m);
      return `${PH_OPEN}${kept.length - 1}${PH_OPEN}`;
    });
  }

  const restore = (s: string) => s.replace(
    new RegExp(`${PH_OPEN}(\\d+)${PH_OPEN}`, 'g'),
    (_m, i) => kept[Number(i)] ?? '',
  );

  const parts = t
    .replace(/([.!?;。！？；]+)/g, `$1${SPLIT_MARK}`)
    .split(SPLIT_MARK)
    .map((p) => restore(p).trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [raw];
}

/**
 * 把 ASR 的粗 utterance 按【词级时间戳】切成【句】。
 *
 * ⚠️ 只切句,不按字数切。配音的落位单位就是句:整句翻译、整句放回原位置。
 *   按字数切会把一句话劈成几个片段分别送去翻译 —— 丢上下文,译文质量直接崩,
 *   而且拼回来的语序可能是错的。字幕要分屏是【显示】层面的事,不该动翻译单元。
 *
 * 为什么还要切:火山返回的 utterance 可能是整段(实测 16 秒只回 2 条)。一条里含
 *   好几句时,译文音频会被灌进整段的时间窗,画面早换了配音还在读上一句。
 *
 * 句界判据:① 句末标点(含半角 `.`,见 isSentenceEndToken)② 词间静音 ≥SENTENCE_PAUSE_SEC。
 * 没有 words 的段(老后端 / 非火山 ASR / SRT 来源)由 regroupSegments 按文本再拆一次。
 */
function resplitByWords(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const seg of segs) {
    const ws = seg.words;
    if (!ws || ws.length < 2) { out.push(seg); continue; }
    let buf: AsrWord[] = [];
    const flush = () => {
      if (buf.length === 0) return;
      // 拉丁系词之间要空格,CJK 不要 —— 直接 join('') 会把英文拼成 "Thetrashis"。
      const text = buf.reduce((acc, w) => {
        const t = w.text;
        if (!acc) return t;
        const cjk = /[぀-ヿ㐀-鿿가-힯]/;
        const needSpace = !cjk.test(acc.slice(-1)) && !cjk.test(t[0] || '') && !/^[,.!?;:'")\]]/.test(t);
        return needSpace ? `${acc} ${t}` : acc + t;
      }, '').trim();
      if (text) out.push({ start: buf[0].start, end: buf[buf.length - 1].end, text });
      buf = [];
    };
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      buf.push(w);
      const endsSentence = isSentenceEndToken(w.text);
      const nextGap = i + 1 < ws.length ? ws[i + 1].start - w.end : 0;
      if (endsSentence || nextGap >= SENTENCE_PAUSE_SEC) flush();
    }
    flush();
  }
  return out.filter((s) => s.text && s.end > s.start);
}

// 进程内正在跑的 yt-dlp 下载数 + 序号。>1 就说明同一任务被重复启动了(见 runYtdlp 里的探针)。
let _ytdlpActive = 0;
let _ytdlpSeq = 0;

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

// ── SRT → Seg[](含 YouTube 自动字幕「滚动窗口重复」清洗:后条以前条全文开头则剥前缀)──
function parseSrt(srtText: string): Seg[] {
  const raw: Seg[] = [];
  const t2s = (h: string, m: string, s: string, ms: string) => (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
  for (const b of srtText.replace(/\r/g, '').split(/\n\n+/)) {
    const m = b.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!m) continue;
    const text = b.slice((m.index || 0) + m[0].length).split('\n')
      .map((x) => x.trim()).filter((x) => x && !/^\d+$/.test(x)).join(' ')
      .replace(/<[^>]+>/g, '').replace(/\{\\an\d\}/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    raw.push({ start: t2s(m[1], m[2], m[3], m[4]), end: t2s(m[5], m[6], m[7], m[8]), text });
  }
  const out: Seg[] = [];
  for (const s of raw) {
    const prev = out[out.length - 1];
    if (prev && s.text === prev.text) { prev.end = Math.max(prev.end, s.end); continue; }
    if (prev && prev.text.length >= 4 && s.text.startsWith(prev.text)) {
      const rest = s.text.slice(prev.text.length).trim();
      if (!rest) { prev.end = Math.max(prev.end, s.end); continue; }
      out.push({ start: s.start, end: s.end, text: rest });
      continue;
    }
    out.push({ ...s });
  }
  return out.filter((s) => s.end > s.start);
}

/** destDir 里找 yt-dlp 落的字幕文件(ytsub.<lang>.srt),优先源语言,退回第一个。 */
function pickSubFile(destDir: string, srcLang: string): string | null {
  let files: string[] = [];
  try { files = fs.readdirSync(destDir).filter((f) => /^ytsub\..+\.srt$/i.test(f)); } catch { return null; }
  if (!files.length) return null;
  // 偏好序:显式源语言 → 原语言自动轨(-orig)→ 中文 → 英文 → 第一个。
  // (多语言手动字幕的视频,'auto' 模式老逻辑按字母序取 files[0],可能抓到阿语等错轨。)
  const lc = (x: string) => x.toLowerCase();
  const prefer = files.find((f) => srcLang && srcLang !== 'auto' && lc(f).includes('.' + srcLang.toLowerCase()))
    || files.find((f) => /-orig\./i.test(f))
    || files.find((f) => /\.(zh|chi)([-_.])/i.test(f) || /\.zh\.srt$/i.test(f))
    || files.find((f) => /\.en([-_.])/i.test(f) || /\.en\.srt$/i.test(f))
    || files[0];
  return path.join(destDir, prefer);
}

// ── 源视频:本地文件直接用;URL 走 yt-dlp 通用下载(YouTube/TikTok/B站等上千站点)──
async function resolveSourceVideo(
  input: VideoCreationInput, destDir: string, onLog: (m: string) => void, signal?: AbortSignal,
): Promise<{ ok: boolean; videoPath?: string; error?: string; subs?: Seg[] }> {
  const localFile = String((input as any).repostSourceFile || '').trim();
  if (localFile) {
    if (!fs.existsSync(localFile)) return { ok: false, error: `本地文件不存在:${localFile}` };
    if (!VIDEO_EXTS.has(path.extname(localFile).toLowerCase())) return { ok: false, error: '所选文件不是支持的视频格式' };
    return { ok: true, videoPath: localFile };
  }
  const url = String((input as any).repostSourceUrl || '').trim();
  if (!url) return { ok: false, error: '未提供源视频(请粘贴视频链接或选择本地文件)' };

  onLog('正在准备下载器…');
  // yt-dlp 本体走服务端下发地址(与爆帖成片同一份,~35MB 首次下、之后缓存复用)。
  //   ⚠️ 之前传 undefined → 没缓存的新用户下不了 yt-dlp,翻译搬运直接不可用。
  const vcfg = await getVideoConfig().catch(() => null as any);
  const ytdlpUrl = process.platform === 'win32' ? vcfg?.threadYtdlpUrlWin : vcfg?.threadYtdlpUrlMac;
  const ytdlp = await getYtdlpPath(ytdlpUrl, onLog);
  if (!ytdlp) return { ok: false, error: '下载器(yt-dlp)不可用,请改用本地文件,或检查网络后重试' };

  const outPath = path.join(destDir, 'source.mp4');
  onLog(`正在下载源视频:${url.slice(0, 80)}`);
  // 优先 mp4(h264/aac,后续换音轨可 -c:v copy);合并交给 yt-dlp/ffmpeg。
  // ⚠️ 别用 ext=mp4 限制:个别站(TikTok)的"最佳 mp4"可能是【纯视频无音轨】,下下来抽音必挂。
  //   bv*+ba/b = 最佳视频+最佳音频合并,再不行退最佳单流(通常也带音轨)→ 保证有声音。
  const baseArgs = [
    '-f', TUNE.ytdlpFormat,
    // ⚠️ 别加 --no-progress:大文件要下几分钟,没有进度用户只能看着一行「正在下载源视频」
    //    干等,完全分不清是在下还是卡死(真机反馈)。--newline 让 yt-dlp 每次进度都换行输出
    //    (默认用 \r 原地刷新,管道里读到的是一坨),这样才能逐行解析。
    '--no-playlist', '--retries', '5', '--newline',
    '--merge-output-format', 'mp4',
    '-o', outPath, url,
  ];
  // ⚠️ 关键:显式告诉 yt-dlp 打包 ffmpeg 的位置。用户机器 ffmpeg 不在 PATH,yt-dlp 找不到
  //   就放弃合并、退回下"单个最佳格式" —— TikTok 的单格式可能是纯视频流(无音轨),
  //   这正是「抽取音轨失败」的根因。传了 location 合并必然可用。
  try { const ff = getFfmpegPath(); if (ff && ff !== 'ffmpeg') baseArgs.push('--ffmpeg-location', ff); } catch { /* PATH 上有就不传 */ }
  // 代理:env → Windows 注册表 → mac scutil(规则型 VPN 不接管 Node 子进程直连,同爆帖成片)。
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || detectSystemProxy();
  if (proxy) baseArgs.push('--proxy', proxy);

  /**
   * 跑 yt-dlp。`showProgress` 时解析 stdout 的下载进度往日志推。
   *
   * yt-dlp 的进度行长这样(--newline 下每条独占一行):
   *   `[download] Destination: source.f137.mp4`
   *   `[download]  45.2% of  120.50MiB at    2.31MiB/s ETA 00:30`
   * 限流:进度每涨 5% 或每 3 秒才打一条,否则几百行刷屏。
   *
   * ⚠️ 「第几个流」必须认 `Destination:` 行,**不能靠百分比回退去猜**。bv*+ba 会分两趟下
   *   (先视频后音频),百分比确实会从 0 重来 —— 但真机上出现过【两个进程同时下同一个文件】
   *   (同一秒两条进度、速度分别 2.54 和 1.31MiB/s),那时百分比也在来回跳,靠回退猜就会
   *   把它误判成"换流",标出一堆假的「第 N 个流」,把真正的问题掩盖掉。
   */
  const runYtdlp = (args: string[], showProgress = false): Promise<{ ok: boolean; err: string }> => new Promise((resolve) => {
    // ⚠️ 并发探针:正常情况下同一时刻只该有一个下载进程(pipeline 有 _videoBatchBusy 单飞闸)。
    //    真机出现过两条进度交替刷、状态一会红一会绿 —— 那是【两次运行同时在跑】,不是下载器的毛病。
    //    这里显式点名,别再让它伪装成"进度乱跳"。
    if (showProgress) {
      _ytdlpSeq++;
      if (_ytdlpActive > 0) {
        onLog(`⚠️ 检测到已有 ${_ytdlpActive} 个下载在跑 —— 同一任务被重复启动了(进度会交替刷、状态忽红忽绿)`);
      }
      _ytdlpActive++;
    }
    const tag = showProgress && _ytdlpActive > 1 ? `#${_ytdlpSeq} ` : '';
    let done = false;
    const finish = (r: { ok: boolean; err: string }) => {
      if (done) return;
      done = true;
      if (showProgress) _ytdlpActive = Math.max(0, _ytdlpActive - 1);
      resolve(r);
    };
    const child = spawn(ytdlp, args, { windowsHide: true });
    let err = '';
    if (showProgress) {
      let buf = '';
      let lastPct = -1;
      let lastAt = 0;
      let filePart = 0;
      child.stdout?.on('data', (d) => {
        buf += String(d);
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
          // 换文件:yt-dlp 每开一个流都会先打 Destination。这才是「第几个流」的可靠依据。
          if (/\[download\]\s+Destination:/.test(line)) { filePart++; lastPct = -1; continue; }
          const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+at\s+([\d.]+\s*\w+\/s))?(?:\s+ETA\s+([\d:]+))?/);
          if (!m) continue;
          const pct = Number(m[1]);
          if (!Number.isFinite(pct)) continue;
          const now = Date.now();
          const advanced = pct >= lastPct + 5;
          const stale = now - lastAt >= 3000;
          if (!advanced && !stale && pct < 100) continue;
          lastPct = pct; lastAt = now;
          const size = String(m[2] || '').replace(/\s+/g, '');
          const speed = m[3] ? String(m[3]).replace(/\s+/g, '') : '';
          const eta = m[4] || '';
          const part = filePart > 1 ? `(第 ${filePart} 个流)` : '';
          onLog(`⬇️ ${tag}下载中 ${pct.toFixed(1)}% / ${size}${speed ? ` · ${speed}` : ''}${eta ? ` · 约剩 ${eta}` : ''}${part}`);
        }
      });
    }
    child.stderr?.on('data', (d) => { err += String(d); });
    child.on('error', (e) => finish({ ok: false, err: String(e) }));
    child.on('close', (code) => finish({ ok: code === 0, err }));
    signal?.addEventListener('abort', () => {
      // ⚠️ 停止时不能只 kill 一次就 resolve 完事。kill 可能没生效(子进程在别的进程组、
      //    或正卡在 socket 上),而 promise 一 resolve,流水线就往下走、单飞闸也放开了 ——
      //    用户再点一次运行,就变成【两个 yt-dlp 同时下同一个文件】,进度交替刷、状态忽红忽绿。
      //    所以:① 先摘掉 stdout 监听,孤儿进程再怎么跑也污染不了日志;② kill 之后再补一刀。
      try { child.stdout?.removeAllListeners('data'); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ } }, 1000).unref?.();
      finish({ ok: false, err: 'aborted' });
    }, { once: true });
  });

  let r = await runYtdlp(baseArgs, true);
  // YouTube 签名坎(真机实报):新版 yt-dlp 解 web 端签名需要外部 JS runtime(deno),
  // 用户机器没有 → 「s may be missing / EJS」+ 403。android/ios 播放端不走 JS 签名,
  // 大多数视频可直接下 → 自动换端重试一次,不用装任何东西。
  if (!r.ok && !signal?.aborted && /youtu\.?be/i.test(url) && /403|EJS|signature|s may be missing|nsig/i.test(r.err)) {
    onLog('⚙️ YouTube 签名受限,自动换 android/ios 播放端重试…');
    try { fs.unlinkSync(outPath); } catch { /* 无残留 */ }
    r = await runYtdlp(['--extractor-args', TUNE.ytdlpExtractorArgs, ...baseArgs], true);
  }
  if (!r.ok || !fs.existsSync(outPath)) {
    if (r.err && r.err !== 'aborted') onLog(`yt-dlp 失败 · ${r.err.slice(-200)}`);
    const isEjs = /EJS|s may be missing|jsruntime/i.test(r.err);
    return {
      ok: false,
      error: isEjs
        ? '源视频下载失败:YouTube 签名限制(yt-dlp 需要 JS 运行时)。可先用本地文件,或在电脑上安装 deno 后重试。'
        : '源视频下载失败(该链接可能不受支持或需要登录/VPN)。可改用本地文件。',
    };
  }

  // ── 顺手抓源视频自带字幕(CC):有就能整个跳过 ASR 转写(免转写费、时间轴更准)。──
  // 两趟都只拉元数据(--skip-download,几秒):手动字幕优先(人校对过),没有再退
  // 自动字幕(只取 *-orig 原语言轨,避免下几十条机翻轨)。抓不到不算错,走 ASR 老路。
  let subs: Seg[] | undefined;
  if (!signal?.aborted) {
    const srcLang = String((input as any).repostSourceLang || 'auto');
    const subBase = ['--skip-download', '--no-playlist', '--convert-subs', 'srt', '-o', path.join(destDir, 'ytsub.%(ext)s'), url];
    try { const ff = getFfmpegPath(); if (ff && ff !== 'ffmpeg') subBase.push('--ffmpeg-location', ff); } catch { /* ignore */ }
    if (proxy) subBase.push('--proxy', proxy);
    const manualLangs = srcLang !== 'auto' ? `${srcLang}.*,${srcLang}` : 'all,-live_chat';
    await runYtdlp(['--write-subs', '--sub-langs', manualLangs, ...subBase]);
    let subFile = pickSubFile(destDir, srcLang);
    if (!subFile && !signal?.aborted) {
      const autoLangs = srcLang !== 'auto' ? `${srcLang}.*,${srcLang}-orig` : '*-orig';
      await runYtdlp(['--write-auto-subs', '--sub-langs', autoLangs, ...subBase]);
      subFile = pickSubFile(destDir, srcLang);
    }
    if (subFile) {
      try {
        const parsed = parseSrt(fs.readFileSync(subFile, 'utf8'));
        if (parsed.length >= 3) {
          subs = parsed;
          onLog(`✅ 抓到源视频自带字幕(${parsed.length} 条),将跳过语音转写`);
        }
      } catch { /* 解析失败走 ASR */ }
    }
  }
  return { ok: true, videoPath: outPath, subs };
}

// ── 后端 ASR:上传音轨 → 带时间戳字幕 ──
async function transcribeAudio(
  audioPath: string, durationSec: number, sourceLang: string, signal?: AbortSignal,
): Promise<{ ok: boolean; segments?: Seg[]; sentences?: Seg[]; language?: string; tokens?: number; costUsd?: number; error?: string; noSpeech?: boolean }> {
  const token = getNoobClawAuthToken();
  if (!token) return { ok: false, error: '未登录 NoobClaw,无法转写' };
  if (signal?.aborted) return { ok: false, error: '已停止' };
  try {
    // 5xx(502/504 网关错/后端重启抖动)自动重试 2 次(等 10s):multipart 上传大 wav 期间
    // 撞上 pm2 重启窗口是真机实报的 502 场景,重试大多能过;4xx 业务错不重试。
    let resp!: Response;
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append('audio', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
      form.append('durationSec', String(Math.max(0, Math.round(durationSec))));
      if (sourceLang && sourceLang !== 'auto') form.append('language', sourceLang);
      // ⚠️ 用户停止要能掀桌:原来只有 200s 超时,叠上 2 次 5xx 重试 + 2×10s 退避
      //    = 最坏 10 分 20 秒完全不响应停止(repost 里最长的死区)。
      //    这里手搓「超时 + 用户 signal」二合一 controller —— 不用 AbortSignal.any,
      //    因为 sidecar 是打包成二进制跑的,内嵌 Node 版本不一定有那个 API(Node 20.3+ 才有),
      //    真缺了会直接抛 TypeError 把整条 repost 流水线打挂,不值得赌。
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 200_000);
      const onUserAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onUserAbort, { once: true });
      try {
        resp = await fetch(`${apiBase()}/api/asr/transcribe`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(to);
        signal?.removeEventListener('abort', onUserAbort);
      }
      if (resp.status < 500 || attempt >= 2) break;
      if (signal?.aborted) return { ok: false, error: '已停止' }; // 别再退避 10s 了
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      let j: any = {}; try { j = JSON.parse(raw); } catch { /* 网关 html 错误页,保留裸文本摘要 */ }
      if (resp.status === 402) return { ok: false, error: '积分余额不足,无法转写(请充值后重试)' };
      // 422=未识别到人声(纯音乐/静音)。不算错误 → 让 pipeline 走「原片直发保留原声」兜底。
      if (resp.status === 422) return { ok: true, segments: [], noSpeech: true, tokens: 0, costUsd: 0 };
      if (resp.status === 503) return { ok: false, error: '转写服务未配置(请联系管理员填 ASR key)' };
      const detail = j?.message || j?.error || raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || '';
      return { ok: false, error: `转写失败:${resp.status}${detail ? ` · ${detail}` : ''}${resp.status === 502 || resp.status === 504 ? '(服务端网关错误,多为后端未部署最新版或进程重启,请检查服务端)' : ''}` };
    }
    const j: any = await resp.json();
    // ⚠️【真机 bug,别再删】必须把 words 一起接下来。以前这里只 map 了 {start,end,text},
    //    词级时间戳在 JSON 解析这一步就被丢掉 → seg.words 恒 undefined →
    //    resplitByWords 第一行 `if (!ws || ws.length < 2) continue` 直接放行 =
    //    **它从写出来那天起就是空转**,后端返不返回 words 结果都一样。
    const mapWords = (s: any): AsrWord[] | undefined => (Array.isArray(s?.words)
      ? s.words
        .map((w: any) => ({ text: String(w?.text || ''), start: Number(w?.start) || 0, end: Number(w?.end) || 0 }))
        .filter((w: AsrWord) => w.text)
      : undefined);
    const toSeg = (s: any): Seg => ({
      start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim(), words: mapWords(s),
    });
    const segs: Seg[] = (Array.isArray(j?.segments) ? j.segments : [])
      .map(toSeg).filter((s: Seg) => s.text && s.end > s.start);
    if (segs.length === 0) return { ok: true, segments: [], noSpeech: true, tokens: 0, costUsd: 0 };
    // 后端(新版)已经把【切好的句】一起回来了 —— 直接用,客户端不再自己切。
    //   这样以后调切句规则只要改 admin + pm2 restart,不用重新打包客户端。
    //   老后端没这个字段 → sentences=undefined → 下游退回本地切句(老行为)。
    const sents: Seg[] = (Array.isArray(j?.sentences) ? j.sentences : [])
      .map(toSeg).filter((s: Seg) => s.text && s.end > s.start);
    // ASR 端点已按真实时长扣了【一份】;返回 costUsd 供 pipeline 累计 →「token 消耗翻倍」时再扣一份。
    return {
      ok: true, segments: segs, sentences: sents.length > 0 ? sents : undefined,
      language: String(j?.language || '').trim(), tokens: Number(j?.chargedTokens) || 0, costUsd: Number(j?.costUsd) || 0,
    };
  } catch (e: any) {
    // 用户点停止 → fetch 抛 AbortError。别报成「转写请求异常」(用户会以为是 bug/网络问题,
    // 还会被当成真失败去看退款);归一成「已停止」。超时同样是 AbortError,但那时 signal
    // 没 aborted,所以用 signal 判别而不是看 err.name。
    if (signal?.aborted) return { ok: false, error: '已停止' };
    return { ok: false, error: `转写请求异常:${String(e?.message || e).slice(0, 120)}` };
  }
}

/**
 * 让【后端】把粗段切成句(POST /api/asr/segment)。
 *
 * 为什么走后端:切句是纯计算,放客户端意味着改一个标点都要重新打包 + 用户重装。
 *   搬到后端后,规则和阈值全在 admin(repost_sentence_* / repost_protect_patterns),
 *   改完 pm2 restart 立即对所有已装客户端生效。
 * 用在【源视频自带字幕】这条路(YouTube CC / 内嵌字幕轨 / 本地 SRT)—— 它不走 ASR 端点,
 *   拿不到那边顺带返回的 sentences。纯计算、不计费。
 * 任何失败都返回 null,调用方退回本地切句,绝不因此让出片失败。
 */
async function segmentViaBackend(segs: Seg[], signal?: AbortSignal): Promise<Seg[] | null> {
  const token = getNoobClawAuthToken();
  if (!token || segs.length === 0) return null;
  try {
    const resp = await fetch(`${apiBase()}/api/asr/segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ segments: segs.map((s) => ({ start: s.start, end: s.end, text: s.text, words: s.words })) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return null;
    const j: any = await resp.json();
    const out: Seg[] = (Array.isArray(j?.sentences) ? j.sentences : [])
      .map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
      .filter((s: Seg) => s.text && s.end > s.start);
    return out.length > 0 ? out : null;
  } catch { return null; }
}

// ── 句子重组:gap≤1s 合并 → 句末标点重切 → 时间按字符比例回摊 ──
// (借鉴 Voice-Pro 的"先合完整句再翻/配音"思路,自研实现。翻译质量与配音韵律都更好。)
// ⚠️ 旧的 SENT_END = /[。！？.!?…]/ 已删除。它是「字符集包含」判定,对 "1.3"、"Dr."、
//    "example.com" 全都会误判成句末;句末判定统一走 isSentenceEndToken(带保护模式)。
function regroupSegments(segs: Seg[]): Seg[] {
  if (segs.length === 0) return [];
  // v2(真机 bug):抖音/TikTok 的自动字幕【没有标点】——老逻辑先并组再按句末标点切,
  // 一个标点都没有 → 58 条并成 1 句 119s,整片文字糊满屏、一次 TTS 念全文。
  // 现在沿【原始字幕条】滚动累积,三个断句条件任一命中即收句(时间轴用真实条边界,不再按字符比例摊):
  //   ① 本条以句末标点收尾;② 与下一条停顿 >1s;③ 累积口播量到上限(≈8s,无标点字幕的兜底)。
  const unitsOf = (t: string) => Array.from(t.replace(/\s/g, '')).reduce((acc, ch) => acc + (/[\u2e80-\u9fff\uac00-\ud7ff\u3040-\u30ff]/.test(ch) ? 1 : 0.5), 0);

  // ⚠️【v3 真机 bug】这个函数只做【合并】,从不在一条内部拆句 —— 它判句末只看
  //   `seg.text` 的最后一个字符。所以只要上游给来一条含好几句的粗段(火山对英文常常
  //   一个 utterance 盖三四句;SRT / YouTube CC 更是整段一条,且**根本没有 words[]**、
  //   走不到 resplitByWords),它就原样过去 → 一个翻译单元 → 一条字幕塞三句中文同屏。
  //   所以进循环前先按句末标点把每条拆开,时间按字符数比例摊(没有词级时间戳时这是
  //   唯一可用的近似)。拆完仍是「短句」,后面的合并逻辑会把该并的再并回去。
  const presplit: Seg[] = [];
  for (const seg of segs) {
    const parts = splitTextSentences(seg.text);
    if (parts.length <= 1) { presplit.push(seg); continue; }
    const weights = parts.map((p) => Math.max(1, unitsOf(p)));
    const total = weights.reduce((a, b) => a + b, 0);
    const span = Math.max(0.001, seg.end - seg.start);
    let cursor = seg.start;
    parts.forEach((p, i) => {
      const dur = (span * weights[i]) / total;
      const end = i === parts.length - 1 ? seg.end : cursor + dur;
      // words 不再往下传:已经按文本拆过了,原 words 跨了新边界会对不上。
      presplit.push({ start: cursor, end, text: p });
      cursor = end;
    });
  }

  const out: Seg[] = [];
  let buf = ''; let bStart = -1; let bEnd = 0;
  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim();
    if (t && bStart >= 0 && bEnd > bStart) out.push({ start: bStart, end: bEnd, text: t });
    buf = ''; bStart = -1;
  };
  for (let i = 0; i < presplit.length; i++) {
    const seg = presplit[i];
    if (!seg.text.trim()) continue;
    // ⚠️ 上限要在【加进来之前】判。加完再判的话窗口总会超出上限一整条源字幕的长度
    //    (5s 上限实测出 6.2s 的窗口)。单条本身就超限时 bStart<0,照常收下,不丢内容。
    if (bStart >= 0 && seg.end - bStart > TUNE.maxCueSec) flush();
    if (bStart < 0) bStart = seg.start;
    buf += (buf ? ' ' : '') + seg.text;
    bEnd = seg.end;
    const gapNext = i + 1 < presplit.length ? presplit[i + 1].start - seg.end : 99;
    // ⚠️ 用 isSentenceEndToken,不是 SENT_END —— 后者是「字符集包含」,对 "1.3" 这种
    //   结尾也会判成句末;而且它对英文缩写没有任何防护。
    const endsSent = isSentenceEndToken(seg.text.trim().split(/\s+/).pop() || '');
    if (endsSent || gapNext > TUNE.gapSplit || unitsOf(buf) >= TUNE.unitsSplit) flush();
  }
  flush();
  // 过短碎句(<4 字宽)并入前句,别单独占屏。
  const merged: Seg[] = [];
  for (const s2 of out) {
    // ⚠️ 碎句回并不能把窗口顶过 maxCueSec —— 上面刚限制完这里又合回去就白限制了。
    const prevSeg = merged[merged.length - 1];
    if (prevSeg && unitsOf(s2.text) < 4 && s2.start - prevSeg.end <= 1.0 && s2.end - prevSeg.start <= TUNE.maxCueSec) {
      const p = merged[merged.length - 1]; p.text += ' ' + s2.text; p.end = s2.end;
    } else merged.push({ ...s2 });
  }
  return merged;
}

// ── 翻译:批量调 DeepSeek,协议壳强制一一对应,不合并不拆分 ──
async function translateSegments(
  segs: Seg[], targetLangLabel: string, onCost: (tk: number, usd: number) => void, signal?: AbortSignal,
  onLog?: (m: string) => void,
): Promise<Seg[]> {
  const BATCH = 20;
  let failedBatches = 0;
  const system = [
    '你是配音字幕翻译器(json)。把输入 items 数组每一项的 text 翻译成【' + targetLangLabel + '】。',
    '# 硬规则(违反任一 = 失败):',
    '1. 必须与输入数组一一对应:第 N 条输入只翻译成第 N 条输出。禁止跨条目借用、合并、拆分、增删条目。',
    '2. 若某条源文本本身是不完整短语/半句/续句,译文也保持同样边界,不要擅自补成完整句。',
    '3. 等价翻译,不解释、不扩写。数字、代码、URL、@handle、无公认译法的专有名词可保留原文。',
    '4. 删除口播里的导流/社媒/订阅引导(如 like and subscribe / 关注我)——这类整条译成空字符串 "".',
    '5. 【口播长度硬上限】每项的 max 是该条译文的长度上限(目标语言为中/日/韩时=字符数,其它语言=单词数)。',
    '   译文绝不允许超过 max —— 超长会导致配音拖过画面。空间不够就精简表达:删冗余修饰、换短说法、保核心信息。',
    '# 只返回 JSON:{ "translations": ["译文1", "译文2", ...] },数组长度必须等于输入长度。',
  ].join('\n');
  // admin 可整体覆盖翻译 prompt({{TARGET}} 占位;必须保持 translations 输出契约)。
  const systemFinal = TUNE.translatePrompt.trim() ? TUNE.translatePrompt.split('{{TARGET}}').join(targetLangLabel) : system;
  // 每句长度预算直接算成【具体数字】给模型(比让它自己按语速换算服从得多)。
  // ⚠️ 预算【从估时器推导】,不能另设一个独立的数:原来翻译按 5 字/秒 产出、配音端估时
  //    按 4.2 字/秒 判断超窗,两套数各调各的 —— 结果是「译文老老实实用满预算 = 必被判超窗」,
  //    真机上一条片 10~11 句被误判、白烧一次 LLM 精简还把译文砍短。
  //    现在 budgetPerSecond = cps × atempoMax × 0.95:atempo 那 25% 就是留给译文的余量。
  //    admin 填了 repost_budget_cjk / _latin(非零)才覆盖这个推导值。
  const profile = speechProfileFor(targetLangLabel);
  const perSec = profile.cjk
    ? (TUNE.budgetCjk > 0 ? TUNE.budgetCjk : budgetPerSecond(profile, TUNE.atempoMax))
    : (TUNE.budgetLatin > 0 ? TUNE.budgetLatin : budgetPerSecond(profile, TUNE.atempoMax));
  const budgetOf = (s: Seg) => {
    const sec = Math.max(0.6, s.end - s.start);
    return Math.max(3, Math.floor(sec * perSec));
  };

  const out: Seg[] = [];
  for (let i = 0; i < segs.length; i += BATCH) {
    throwIfAborted(signal);
    const batch = segs.slice(i, i + BATCH);
    const user = '翻译下面 ' + batch.length + ' 条:\n' + JSON.stringify({
      items: batch.map((s) => ({ text: s.text, max: budgetOf(s) })),
    });
    // 真机 bug:单批失败静默保原文 → 全部批失败时整条片就是原语言,用户看到「选了英文出来还是中文」。
    // 现在:每批失败重试 1 次;仍失败记 failedBatches 并打日志;循环后全败则抛错,不再静默产出原文。
    let translations: string[] | null = null;
    for (let attempt = 0; attempt < 2 && !translations; attempt++) {
      try {
        const r = await callDeepSeek(systemFinal, user, true, 60_000, 'noobclawai-chat', 0.2);
        onCost(r.tokens || 0, r.costUsd || 0);
        const m = r.content.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : JSON.parse(r.content);
        if (Array.isArray(parsed?.translations) && parsed.translations.length === batch.length) {
          translations = parsed.translations.map((x: any) => String(x ?? ''));
        } else if (attempt === 1) {
          onLog?.(`⚠️ 第 ${Math.floor(i / BATCH) + 1} 批翻译返回不规整(条数不匹配),该批保留原文`);
        }
      } catch (e: any) {
        if (attempt === 1) onLog?.(`⚠️ 第 ${Math.floor(i / BATCH) + 1} 批翻译失败:${String(e?.message || e).slice(0, 80)},该批保留原文`);
      }
    }
    if (!translations) failedBatches++;
    for (let k = 0; k < batch.length; k++) {
      const t = translations ? translations[k].trim() : batch[k].text;
      out.push({ start: batch[k].start, end: batch[k].end, text: t });
    }
  }
  // 全部批都失败 = 翻译一句没成 → 明确报错(否则配音/合成照跑,产出原语言成片还照常扣费)。
  if (failedBatches > 0 && failedBatches === Math.ceil(segs.length / BATCH)) {
    throw new Error('翻译服务全部失败(网络/AI 异常),已中止,请稍后重试');
  }
  return out;
}

/**
 * 批量精简超窗句子 —— 一次 LLM 调用改完所有超长句,不是一句一调。
 * 返回与输入等长的数组;某条精简失败/变长时原样返回。
 */
async function condenseBatch(
  items: Array<{ text: string; budget: number }>, onCost?: (tk: number, usd: number) => void, signal?: AbortSignal,
): Promise<string[]> {
  if (items.length === 0) return [];
  const system = TUNE.condensePrompt.trim()
    ? TUNE.condensePrompt.split('{{BUDGET}}').join('每项自带的 max')
    : [
      '你是口播精简器(json)。把输入 items 数组每一项的 text 用【同一种语言】略微精简。',
      '# 硬规则:',
      '1. 一一对应:第 N 条输入只对应第 N 条输出,禁止合并/拆分/增删条目。',
      '2. 每项的 max 是该条输出的长度上限(中日韩=字符数,其它=单词数),绝不允许超过。',
      '3. 删冗余修饰、口头语、重复表述;核心信息(数字、人名、结论)一个都不能丢。',
      '4. 不解释、不加引号、不改语言。',
      '# 只返回 JSON:{ "texts": ["精简1", "精简2", ...] },数组长度必须等于输入长度。',
    ].join('\n');
  try {
    const r = await callDeepSeek(
      system,
      '精简下面 ' + items.length + ' 条:\n' + JSON.stringify({ items: items.map((x) => ({ text: x.text, max: x.budget })) }),
      true, 60_000, 'noobclawai-chat', 0.3,
    );
    onCost?.(r.tokens || 0, r.costUsd || 0);
    if (signal?.aborted) return items.map((x) => x.text);
    const m = r.content.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : JSON.parse(r.content);
    if (Array.isArray(parsed?.texts) && parsed.texts.length === items.length) {
      return parsed.texts.map((t: any, i: number) => {
        const s = String(t ?? '').trim().replace(/^["'「『]|["'」』]$/g, '').trim();
        // 精简后反而变长 / 空 → 用原文(宁可 atempo 压,不要丢内容)
        return s && s.length < items[i].text.length ? s : items[i].text;
      });
    }
  } catch { /* 精简失败 → 原文,后面 atempo + 顺延兜底 */ }
  return items.map((x) => x.text);
}

// ── 配音 + 对齐(合块一次 TTS → 贴回原时间轴)──────────────────────────────
//
// 结构来自 KrillinAI 的 dubbing 包(见 dubPlan.ts 顶部注释)。相对旧版逐句合成的两点改变:
//   ① 【合块】挨得近的短句并成一块整块合成 → 块内语气连贯,不再每句一个独立朗读收尾;
//   ② 【先估后合成】统计式估时判断超窗 → 超了先批量 LLM 缩写,再 TTS。
//      旧版是「合成→超长→提速重配→仍超→缩写再重配」= 同一句最多 4 次 TTS。
//      豆包按字符实扣,那是 4 倍字符费且每次真扣。现在每块 1 次(极端超长才多 1 次)。
async function synthAndAlign(
  segs: Seg[], voice: string, rate: number, assetDir: string, targetTotalDur: number,
  targetLangLabel: string,
  onLog: (m: string) => void, signal?: AbortSignal, onCost?: (tk: number, usd: number) => void,
): Promise<{ voiceTrackPath: string; totalDur: number; cues: TtsCue[] } | null> {
  const pieces: string[] = []; // 按时间轴排好的音频片段(含静音)文件列表
  const cues: TtsCue[] = [];
  let cursor = 0; // 当前已排到的音频末尾(秒)
  const chain = getVoiceFallbacks(voice);

  // 只保留有译文的句(被翻成空的导流句直接丢,原位留空)。
  const dubCues: DubCue[] = [];
  segs.forEach((s, i) => { if (s.text.trim()) dubCues.push({ index: i, start: s.start, end: s.end, text: s.text.trim() }); });
  if (dubCues.length === 0) return null;

  const profile = speechProfileFor(targetLangLabel, dubCues[0].text);
  const chunks = makeChunks(dubCues, {
    minDur: TUNE.chunkMinDur, gapTolerance: TUNE.chunkGap, maxSize: Math.max(1, Math.round(TUNE.chunkMax)),
  });
  if (chunks.length < dubCues.length) {
    onLog(`🧩 相邻短句合块:${dubCues.length} 句 → ${chunks.length} 块(整块一次合成,语气更连贯、TTS 花费更省)`);
  }

  // ── 全局自适应语速:用估时算,**零 TTS 开销**(旧版为了算这个要把全片先合成一遍)。
  const availOf = (c: { start: number; end: number }) => Math.max(0.6, c.end - c.start);
  let estSum = 0, availSum = 0;
  const chunkEst = chunks.map((ch) => {
    const e = estimateSpeechSeconds(chunkText(dubCues, ch), profile);
    estSum += e; availSum += availOf(ch);
    return e;
  });
  let globalRate = rate;
  if (availSum > 3 && chunks.length >= 3) {
    // 估时是「自然语速」下的,先按用户设定的基准语速折算,再和原口播窗口比。
    const ratio = (estSum * rateScale(rate)) / availSum;
    if (ratio > TUNE.rateHi) globalRate = Math.min(50, rate + Math.min(TUNE.rateUpMax, Math.round((ratio - 1) * 100)));
    else if (ratio < TUNE.rateLo) globalRate = Math.max(-50, rate - Math.min(TUNE.rateDownMax, Math.round((1 - ratio) * 50)));
    if (globalRate !== rate) onLog(`🎚️ 语速自适应:预估配音/原口播时长比 ${ratio.toFixed(2)} → 全片语速 ${globalRate > 0 ? '+' : ''}${globalRate}%`);
  }
  const scale = rateScale(globalRate);

  // ── 合成前批量缩写:估时超出【窗口 × atempo 上限】的块才动文字。
  //    atempo 能吃掉的部分不改文字(改了译文就干);吃不掉的才精简,而且一次调用改完。
  const pending: Array<{ ci: number; k: number; text: string; budget: number }> = [];
  chunks.forEach((ch, ci) => {
    const est = chunkEst[ci] * scale;
    const room = availOf(ch) * TUNE.atempoMax;
    if (est <= room * 1.02 || est <= 0) return;
    const keep = room / est; // 需要保留的比例
    ch.items.forEach((k) => {
      const t = dubCues[k].text;
      // ⚠️ 预算单位必须跟着语言走(中日韩=字,其它=词)—— prompt 里也是这么说的。
      //    用 String.length 当「词数」发给模型 = 上限虚高几倍,等于没约束。
      const units = textUnits(t, profile);
      if (units <= (profile.cjk ? 6 : 3)) return; // 太短的不动,砍了也省不出时间
      pending.push({ ci, k, text: t, budget: Math.max(profile.cjk ? 6 : 3, Math.floor(units * keep * 1.05)) });
    });
  });
  if (pending.length > 0 && !signal?.aborted) {
    onLog(`✂️ ${pending.length} 句预估超出画面窗口,合成前统一精简(一次 AI 调用,约 10~30s)`);
    const shortened = await condenseBatch(pending.map((p) => ({ text: p.text, budget: p.budget })), onCost, signal);
    onLog(`✂️ 精简完成,开始合成`);
    pending.forEach((p, i) => {
      const s = shortened[i];
      if (s && s !== p.text) {
        dubCues[p.k].text = s;
        segs[dubCues[p.k].index].text = s; // 字幕也用精简后的文本
      }
    });
    // 文本变了 → 估时重算(后面 fit 的权重要用新估时)
    chunks.forEach((ch, ci) => { chunkEst[ci] = estimateSpeechSeconds(chunkText(dubCues, ch), profile); });
  }

  const makeSilence = async (dur: number, out: string): Promise<boolean> => {
    if (dur <= 0.02) return false;
    const r = await runFfmpeg(['-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', dur.toFixed(3), '-c:a', 'aac', '-b:a', '128k', out], { timeoutMs: 30_000, signal });
    return r.ok && fs.existsSync(out);
  };

  // ── 逐块:合成 → 贴轴 → 归一化(含 atempo)→ 排进时间线 ──
  // ⚠️ 这个循环必须打进度。一条长片能有 150+ 块,每块一次 TTS + 一次 ffmpeg,整体要跑好几分钟;
  //    原来循环里一行日志都没有,用户看到的就是「✂️ 精简完」之后彻底没动静 —— 完全像卡死。
  //    (真机反馈:等了四分钟以为挂了。)每块都打太吵,按 5% 或至少每 10 块打一次。
  const progressEvery = Math.max(1, Math.min(10, Math.ceil(chunks.length / 20)));
  const t0 = Date.now();
  if (chunks.length > 12) onLog(`🎤 开始逐块合成,共 ${chunks.length} 块(长片需要几分钟,下面会报进度)`);
  for (let ci = 0; ci < chunks.length; ci++) {
    throwIfAborted(signal);
    if (chunks.length > 12 && ci > 0 && ci % progressEvery === 0) {
      const done = ci / chunks.length;
      const elapsed = (Date.now() - t0) / 1000;
      const eta = done > 0 ? Math.round(elapsed / done - elapsed) : 0;
      onLog(`🎤 配音进度 ${ci}/${chunks.length} 块(${Math.round(done * 100)}%)· 已用 ${Math.round(elapsed)}s${eta > 0 ? ` · 约剩 ${eta}s` : ''}`);
    }
    const ch = chunks[ci];
    const text = chunkText(dubCues, ch);
    if (!text) continue;

    // 起点静音:补到本块原始 start(硬锚点纠偏);若已越过 start 则不补(顺延)。
    if (ch.start > cursor) {
      const sil = path.join(assetDir, `sil_${ci}.m4a`);
      if (await makeSilence(ch.start - cursor, sil)) { pieces.push(sil); cursor = ch.start; }
    }
    const placeStart = Math.max(cursor, ch.start);

    let ttsPath = ''; let ttsDur = 0;
    for (const v of chain) {
      const out = path.join(assetDir, `chunk_${String(ci).padStart(3, '0')}.mp3`);
      // ⚠️ signal 必须传:voiceChain × 最多 5 次重试 × 单次最长 60s,不传则停止要磨数分钟。
      const r = await synthesize(text, out, v, globalRate, { signal });
      // 豆包按字符实扣 —— 必须报出来。repost 的平台费是按 aiCostUsd 翻倍算的,
      //   漏了 TTS 这笔就等于少收钱(不只是详情页少显示)。Edge 免费,chargedTokens 为空。
      if (r.chargedTokens) onCost?.(r.chargedTokens, r.costUsd || 0);
      if (r.synthesized && r.durationSec > 0) { ttsPath = r.audioPath; ttsDur = r.durationSec; break; }
    }
    if (!ttsPath) { onLog(`⚠️ 第 ${ci + 1} 块配音失败,跳过:${getLastTtsError().slice(0, 60)}`); continue; }

    const targetDur = availOf(ch);
    // 安全网:估时失准导致实测远超 atempo 能吃的范围时,**只**再提速重配一次(声库原生
    //   提速比 atempo 自然)。上限一次,不再链式重试 —— 那正是旧版烧钱的地方。
    if (ttsDur > targetDur * TUNE.atempoMax * 1.25 && !signal?.aborted) {
      const boosted = Math.min(50, globalRate + TUNE.lineBoost);
      if (boosted > globalRate) {
        const outF = path.join(assetDir, `chunk_${String(ci).padStart(3, '0')}_f.mp3`);
        for (const v of chain) {
          const rf = await synthesize(text, outF, v, boosted, { signal });
          if (rf.chargedTokens) onCost?.(rf.chargedTokens, rf.costUsd || 0);
          if (rf.synthesized && rf.durationSec > 0 && rf.durationSec < ttsDur) {
            onLog(`⏩ 第 ${ci + 1} 块偏长,提速重配(${ttsDur.toFixed(1)}s→${rf.durationSec.toFixed(1)}s)`);
            ttsPath = rf.audioPath; ttsDur = rf.durationSec;
            break;
          }
        }
      }
    }

    // 溢出压到原窗口,真实压缩封顶 atempoMax(听感仍自然;再多就只压到上限、剩余顺延)。
    const tempo = ttsDur > targetDur ? Math.min(TUNE.atempoMax, ttsDur / targetDur) : 1;
    // ⚠️ 必须把每块【归一化成 aac 48k 立体声】:TTS 出的是 mp3、静音片段是 aac,格式不统一
    //    concat demuxer -c copy 会失败。这一步同时做 atempo(需要时),一趟 ffmpeg 搞定。
    const norm = path.join(assetDir, `chunk_${String(ci).padStart(3, '0')}_n.m4a`);
    const filt = tempo > 1.005 ? `atempo=${tempo.toFixed(3)}` : 'anull';
    const nr = await runFfmpeg(['-y', '-i', ttsPath, '-filter:a', filt, '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', norm], { timeoutMs: 30_000, signal });
    if (!nr.ok || !fs.existsSync(norm)) { onLog(`⚠️ 第 ${ci + 1} 块音频归一化失败,跳过`); continue; }
    const effDur = tempo > 1.005 ? ttsDur / tempo : ttsDur;
    pieces.push(norm);
    // 块内各句按估时权重分摊,得出最终字幕时间轴。
    for (const f of distributeChunk(dubCues, ch, placeStart, effDur, profile)) {
      cues.push({ text: f.text, start: f.start, end: f.end });
    }
    cursor = placeStart + effDur;

    // 尾部补静音到下一块原始 start(说得短时保持后续同步)。
    const nextStart = ci + 1 < chunks.length ? chunks[ci + 1].start : cursor;
    if (nextStart > cursor) {
      const sil = path.join(assetDir, `siltail_${ci}.m4a`);
      if (await makeSilence(nextStart - cursor, sil)) { pieces.push(sil); cursor = nextStart; }
    }
  }

  if (pieces.length === 0) return null;
  // concat demuxer 拼全部片段(均已 aac 48k stereo 同格式)。
  const listPath = path.join(assetDir, 'voice_pieces.txt');
  fs.writeFileSync(listPath, pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const voiceTrack = path.join(assetDir, 'voice_track.m4a');
  const cr = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', voiceTrack], { timeoutMs: 120_000, signal });
  if (!cr.ok || !fs.existsSync(voiceTrack)) {
    // 退回重编码拼接(片段容器/时基不一致时)。
    const cr2 = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'aac', '-b:a', '128k', voiceTrack], { timeoutMs: 120_000, signal });
    if (!cr2.ok || !fs.existsSync(voiceTrack)) return null;
  }
  // 垫静音到目标总长,但【绝不截断配音】:译文语速比原文长时,末句会超过源视频尾。
  //   padTo = max(源视频长, 配音自然长度) —— 短则补静音填满视频,长则保留完整配音(视频那边靠
  //   compose 冻结末帧延长,别把译文尾巴切掉,否则「音频没播完画面停了」)。
  let finalTrack = voiceTrack;
  const padTo = Math.max(targetTotalDur, cursor);
  if (padTo > 0.1) {
    const padded = path.join(assetDir, 'voice_track_pad.m4a');
    const pr = await runFfmpeg(['-y', '-i', voiceTrack, '-af', 'apad', '-t', padTo.toFixed(3), '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', padded], { timeoutMs: 120_000, signal });
    if (pr.ok && fs.existsSync(padded)) finalTrack = padded;
  }
  const totalDur = await probeDuration(finalTrack).catch(() => cursor);
  return { voiceTrackPath: finalTrack, totalDur: totalDur || cursor, cues };
}

// ── 合成阶段的超时与进度 ─────────────────────────────────────────────────────
/**
 * 按成片时长算 ffmpeg 超时。
 *
 * ⚠️【真机 bug】原来三处合成全写死 `timeoutMs: 600_000`(10 分钟)。24 分钟 / 2.83GB 的源片
 *   要「冻结末帧延长 + 底部裁切 + boxblur 高斯 + ASS 烧字幕 + libx264 重编码」,实测跑了
 *   638 秒被超时掐死,报成「合成失败(字幕烧录/编码出错)」—— 前面下载 13 分钟、配音 6 分钟
 *   全白费,钱也扣了。搬运长视频是正常用法,不能用一个固定值卡死。
 *
 * 取 `时长 × 6`(boxblur + 字幕这套滤镜在慢机器上可能不到 1 倍速),下限 15 分钟、
 *   上限 3 小时(真挂住时还是要有个头,不能无限等)。
 *
 * ⚠️ 拿不到时长(probeDuration 失败 / 坏容器)时**不能落到 15 分钟下限** —— 长度未知恰恰
 *   最可能是长片,那样等于把上面这个坑原样挖回来。这种情况直接给 60 分钟。
 */
const COMPOSE_TIMEOUT_UNKNOWN_MS = 60 * 60_000;
function composeTimeoutMs(durationSec: number): number {
  const d = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (d <= 0) return COMPOSE_TIMEOUT_UNKNOWN_MS;
  return Math.min(3 * 3600_000, Math.max(15 * 60_000, Math.round(d * 6 * 1000)));
}

/**
 * ffmpeg 进度上报:解析 stderr 的 `time=HH:MM:SS.xx`,对着总时长算百分比。
 * 限流同下载:每涨 5% 或每 5 秒一条 —— 十几分钟的编码没有任何输出,看着也像卡死。
 */
function ffmpegProgress(totalSec: number, label: string, onLog: (m: string) => void): (line: string) => void {
  let lastPct = -1;
  let lastAt = 0;
  const t0 = Date.now();
  return (line: string) => {
    const m = line.match(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (!m) return;
    const cur = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    if (!Number.isFinite(cur) || !(totalSec > 0)) return;
    const pct = Math.min(100, (cur / totalSec) * 100);
    const now = Date.now();
    if (pct < lastPct + 5 && now - lastAt < 5000) return;
    lastPct = pct; lastAt = now;
    const elapsed = (now - t0) / 1000;
    const eta = pct > 1 ? Math.round((elapsed / pct) * (100 - pct)) : 0;
    onLog(`🎞️ ${label} ${pct.toFixed(0)}% · 已用 ${Math.round(elapsed)}s${eta > 0 ? ` · 约剩 ${eta}s` : ''}`);
  };
}

// ── 字幕存档:原字幕 / 译文字幕 / 译文纯文本,全落到成片同目录 ────────────────
/** 秒 → SRT 时间码 `HH:MM:SS,mmm`。 */
function toSrtTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(ss)},${p(ms, 3)}`;
}

function buildSrt(cues: Array<{ start: number; end: number; text: string }>): string {
  return cues
    .filter((c) => c.text && c.end > c.start)
    .map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text.replace(/\r?\n/g, ' ').trim()}\n`)
    .join('\n');
}

/**
 * 把字幕存一份到成片目录,方便人工核对译文。写三种:
 *   · `原字幕_<源语言码>.srt` —— YouTube CC / 内嵌字幕轨原样留档;没有字幕(走 ASR)时用转写结果
 *   · `译文字幕_<目标语言码>.srt` —— 最终时间轴(和成片里烧的那份完全一致)
 *   · `译文_<目标语言码>.txt` —— 纯文本,一行一句、带时间码前缀,直接读
 *
 * ⚠️ 文件名用【语言代码】(en/zh/ja/ko/vi/es/pt/fr/de/id),不用显示名 ——
 *   目标语言不一定是英语,显示名里有空格和变音符(`Bahasa Indonesia`、`Tiếng Việt`、
 *   `한국어`),当文件名既难敲也难在脚本里匹配。代码短、纯 ASCII,还能和「原字幕」那份对齐。
 * 任何一份写失败都只记日志,绝不影响出片。
 */
function saveSubtitleArchive(
  destDir: string,
  srcLangCode: string,
  targetLangCode: string,
  original: Array<{ start: number; end: number; text: string }>,
  translated: Array<{ start: number; end: number; text: string }>,
  onLog: (m: string) => void,
): void {
  // 只留字母数字和连字符(zh-TW、pt-BR 这类要保住),其余一律丢。
  const safe = (s: string, dv: string) => {
    const t = String(s || '').trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
    return t && t.toLowerCase() !== 'auto' ? t : dv;
  };
  const srcTag = safe(srcLangCode, 'src');
  const dstTag = safe(targetLangCode, 'dst');
  const written: string[] = [];
  const write = (name: string, content: string) => {
    if (!content.trim()) return;
    try { fs.writeFileSync(path.join(destDir, name), content, 'utf8'); written.push(name); } catch { /* 存档失败不影响出片 */ }
  };
  write(`原字幕_${srcTag}.srt`, buildSrt(original));
  write(`译文字幕_${dstTag}.srt`, buildSrt(translated));
  write(
    `译文_${dstTag}.txt`,
    translated
      .filter((c) => c.text && c.end > c.start)
      .map((c) => `[${toSrtTime(c.start).slice(0, 8)}] ${c.text.replace(/\r?\n/g, ' ').trim()}`)
      .join('\n'),
  );
  if (written.length) onLog(`📝 字幕已存档:${written.join('、')}`);
}

// ── ASS 字幕(修「巨字挡画面」bug)──
// SRT + force_style 的 FontSize 是按 libass 内部 288 高虚拟画布算的:竖屏 1920 高会放大
// ~6.7 倍 → 20 号变 130+px 巨字。改为生成 ASS:PlayRes = 视频真实分辨率,字号按视频高度
// 换算(setting 16/20/26 ≈ 高度的 2.3%/2.9%/3.7%),样式(白字黑边/底部边距)完全受控。
function toAssTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60); const cs = Math.round((s - Math.floor(s)) * 100);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${h}:${p(m)}:${p(ss)}.${p(cs)}`;
}
// 按字号 + 画宽把一句硬折行(插 \N):libass 对无空格的中文自动折行不可靠,长句会顶出画面
// (用户实测中文字幕超出屏幕宽度不换行)。中日韩全角字≈1 个字宽(fontPx),拉丁/数字≈0.55。
// 边距两侧各留 4%(与样式 MarginL/R 一致)→ 可用宽 = W*0.92。
function wrapAssLine(text: string, W: number, fontPx: number): string {
  const usable = W * 0.92;
  const maxUnits = Math.max(6, usable / fontPx);
  const isWide = (ch: string) => /[ᄀ-ᇿ⺀-鿿ꥠ-꥿가-퟿豈-﫿＀-￯]/.test(ch);
  const unit = (ch: string) => (isWide(ch) ? 1 : 0.55);
  const breakable = (ch: string) => ch === ' ' || isWide(ch) || '，。！？、；：,.!?;:)】」）'.includes(ch);
  const out: string[] = [];
  let line = ''; let units = 0; let lastBreak = -1;
  for (const ch of Array.from(text)) {
    line += ch; units += unit(ch);
    if (breakable(ch)) lastBreak = line.length;
    if (units >= maxUnits) {
      const cut = (lastBreak > 0 && lastBreak < line.length) ? lastBreak : line.length;
      out.push(line.slice(0, cut).replace(/\s+$/, ''));
      line = line.slice(cut);
      units = 0; for (const c of Array.from(line)) units += unit(c);
      lastBreak = -1;
    }
  }
  if (line.replace(/\s+$/, '')) out.push(line.replace(/\s+$/, ''));
  return out.join('\\N');
}
function buildAss(cues: TtsCue[], W: number, H: number, fontSetting: number): string {
  const fontPx = Math.max(18, Math.round(H * (fontSetting / TUNE.fontDivisor))); // 20 → 1920高≈55px / 1080高≈31px
  const marginV = Math.round(H * 0.05); // 距底 5%,落在底部蒙层带内
  const outline = Math.max(1, Math.round(fontPx / 18));
  const esc = (t: string) => wrapAssLine(t.replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim(), W, fontPx);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${fontPx},&H00FFFFFF,&H00FFFFFF,&H00000000,&H7F000000,0,0,0,0,100,100,0,0,1,${outline},0,2,${Math.round(W * 0.04)},${Math.round(W * 0.04)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Text',
    ...cues.map((c) => `Dialogue: 0,${toAssTime(c.start)},${toAssTime(c.end)},Default,,0,0,0,${esc(c.text)}`),
  ];
  return lines.join('\n');
}

// subtitles 滤镜的路径转义(Windows 反斜杠 + 冒号)。
function escSubPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export async function runRepostPipeline(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  await refreshTune(); // 服务端可调参数(admin repost_*),拉不到用默认

  const jobId = `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracker = new ProgressTracker(jobId, emit, REPOST_STEPS);

  if (!isFfmpegAvailable()) {
    tracker.fail('source', 'ffmpeg 不可用(打包版需内置 ffmpeg 资源)');
    return { ok: false, error: 'ffmpeg 不可用' };
  }

  const { taskDir, runDir: destDir } = resolveOutputDirs(input);
  tracker.setOutputDir(taskDir);
  fs.mkdirSync(destDir, { recursive: true });
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-repost-'));

  const targetLang = String((input as any).repostTargetLang || input.scriptLang || 'zh').trim() || 'zh';
  const LANG_LABEL: Record<string, string> = {
    zh: '简体中文', 'zh-TW': '繁体中文', en: 'English', ja: '日本語', ko: '한국어',
    vi: 'Tiếng Việt', es: 'Español', pt: 'Português', fr: 'Français', de: 'Deutsch', id: 'Bahasa Indonesia',
  };
  const targetLabel = LANG_LABEL[targetLang] || '简体中文';

  // 计费:token 消耗(ASR+翻译)累计,合成前扣「平台费 + 翻倍那份」;失败按 chargeId 退回。
  let aiCostUsd = 0;
  let chargeId: string | undefined;
  let refundOnExit = false;

  try {
    // ── STEP 1:源视频 ──
    throwIfAborted(signal);
    tracker.start('source', `输出目录:${taskDir}`);
    const src = await resolveSourceVideo(input, destDir, (m) => tracker.progress(m), signal);
    if (!src.ok || !src.videoPath) { const err = src.error || '源视频获取失败'; tracker.fail('source', err); return { ok: false, error: err }; }
    const sourceVideoPath = src.videoPath;
    tracker.done('source', '✅ 源视频就绪');

    const srcDur = await probeDuration(sourceVideoPath).catch(() => 0);

    // ── STEP 2:字幕/转写 ── 优先级:源视频自带字幕(URL 的 CC / 本地文件的内嵌字幕轨)
    //   → 有就跳过整个 ASR(免转写费、时间轴更准);没有才抽音轨走火山转写。
    throwIfAborted(signal);
    tracker.start('transcribe', '🎧 检查源字幕…');
    let subsSegs: Seg[] | undefined = src.subs;
    if (!subsSegs && (input as any).repostSourceFile) {
      // 本地文件:试抽第一条内嵌软字幕轨(mkv/mp4 常见);没有就静默走 ASR。
      const embSrt = path.join(assetDir, 'embedded_sub.srt');
      const ex = await runFfmpeg(['-y', '-i', sourceVideoPath, '-map', '0:s:0', '-f', 'srt', embSrt], { timeoutMs: 60_000, signal }).catch(() => ({ ok: false } as any));
      if (ex.ok && fs.existsSync(embSrt)) {
        try {
          const parsed = parseSrt(fs.readFileSync(embSrt, 'utf8'));
          if (parsed.length >= 3) { subsSegs = parsed; tracker.progress(`✅ 检测到内嵌字幕轨(${parsed.length} 条),跳过转写`); }
        } catch { /* 走 ASR */ }
      }
    }

    let asr: Awaited<ReturnType<typeof transcribeAudio>>;
    if (subsSegs) {
      asr = { ok: true, segments: subsSegs, tokens: 0, costUsd: 0 };
    } else {
      // 抽音轨(用于 ASR)。抽成 WAV(pcm_s16le)—— 任何 ffmpeg 都自带 pcm 编码器(不像 libmp3lame
      //   可能没编进静态包,Mac 版尤其);火山/whisper 都收 WAV。16k 单声道正是火山要的格式、体积小。
      tracker.progress('🎧 无源字幕,抽取音轨…');
      const audioPath = path.join(assetDir, 'source_audio.wav');
      let ax = await runFfmpeg(['-y', '-i', sourceVideoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath], { timeoutMs: 180_000, signal });
      if (!ax.ok || !fs.existsSync(audioPath)) {
        // 兜底:去掉重采样直接抽(个别源的采样率/声道让第一条挂);仍失败就把 ffmpeg 真实报错亮出来。
        tracker.progress(`⚠️ 抽音重试(第一次:${((ax.stderr || '').trim().split('\n').pop() || '').slice(0, 140)})…`);
        ax = await runFfmpeg(['-y', '-i', sourceVideoPath, '-vn', '-c:a', 'pcm_s16le', audioPath], { timeoutMs: 180_000, signal });
      }
      if (!ax.ok || !fs.existsSync(audioPath)) {
        const reason = (ax.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(-240);
        const err = `抽取音轨失败:${reason || '源视频可能无音频轨/文件损坏'}`;
        tracker.fail('transcribe', err); return { ok: false, error: err };
      }
      tracker.progress('☁️ 上传音轨转写(按音频分钟计费)…');
      asr = await transcribeAudio(audioPath, srcDur, String((input as any).repostSourceLang || 'auto'), signal);
      // 用户停止:统一走 throwIfAborted 的「已停止」口径(外层 catch 归一 + 终态带 aborted),
      // 别当成 transcribe 步骤失败标红 —— 这时候片子还没合成,refundOnExit 仍为 true 会正常退款。
      throwIfAborted(signal);
      if (!asr.ok) { const err = asr.error || '转写失败'; tracker.fail('transcribe', err); return { ok: false, error: err }; }
    }
    const noSpeech = !!asr.noSpeech || !asr.segments || asr.segments.length === 0;

    let translated: Seg[] = [];
    let aligned: { voiceTrackPath: string; totalDur: number; cues: TtsCue[] } | null = null;

    if (noSpeech) {
      // 无人声(纯音乐/风景片)→ 原片直发,保留原有全部声音,只 AI 配目标语言标题/简介。
      tracker.done('transcribe', '⏭ 未检测到人声 → 原片直发(保留原声)');
      tracker.done('translate', '⏭ 无人声,跳过翻译');
      tracker.done('voice', '⏭ 无人声,跳过配音');
    } else {
      const asrSegments = asr.segments!;
      tracker.addTokens(asr.tokens || 0, asr.costUsd || 0); // 显示;翻倍靠下面累计 aiCostUsd
      aiCostUsd += asr.costUsd || 0;
      // ── 切句:优先【后端】,本地只做兜底 ────────────────────────────────
      // 切句是纯计算,放客户端意味着改一个标点都要重新打包 + 用户重装(真机上就吃过这个亏:
      //   句末判据漏了半角 `.`,英文三句并成一条字幕,只能重新出包)。现在规则全在服务端,
      //   admin 改 repost_sentence_* / repost_protect_patterns → pm2 restart → 所有已装客户端
      //   立即生效。老后端没这两个接口时自动退回下面的本地实现,行为不变。
      let regrouped: Seg[];
      let splitBy = '';
      if (asr.sentences && asr.sentences.length > 0) {
        // 走 ASR 端点时后端已经顺带切好了,直接用(零额外请求)。
        regrouped = asr.sentences;
        splitBy = '服务端';
      } else {
        // 源视频自带字幕这条路不走 ASR 端点 → 单独请后端切一次。
        const remote = await segmentViaBackend(asrSegments, signal);
        if (remote) {
          regrouped = remote;
          splitBy = '服务端';
        } else {
          // 本地兜底:先按词级时间戳把粗 utterance 拆细,再重组 —— 顺序不能反:
          //   regroupSegments 是【合并】逻辑(把碎句并成适合翻译的长度),拿 2 条 8 秒的
          //   粗段去合并,合出来还是 2 条,锚点密度一点没变。
          const fine = resplitByWords(asrSegments);
          regrouped = regroupSegments(fine);
          splitBy = '本地兜底(后端切句不可用)';
        }
      }
      tracker.done('transcribe', subsSegs
        ? `✅ 源字幕就绪(免转写费)· ${asrSegments.length} 条 → 切句 ${regrouped.length} 句 · ${splitBy}`
        : `✅ 转写完成 · ${asrSegments.length} 条 → 切句 ${regrouped.length} 句 · ${splitBy}`);

      // ── STEP 3:翻译 ──
      throwIfAborted(signal);
      tracker.start('translate', `🌐 翻译为 ${targetLabel}…`);
      translated = await translateSegments(regrouped, targetLabel, (tk, usd) => { tracker.addTokens(tk, usd); aiCostUsd += usd; }, signal, (m) => tracker.progress(m));
      const nonEmpty = translated.filter((s) => s.text.trim());
      if (nonEmpty.length === 0) { const err = '翻译结果为空'; tracker.fail('translate', err); return { ok: false, error: err }; }
      tracker.done('translate', `✅ 翻译完成 · ${nonEmpty.length} 句`);

      // ── STEP 4:配音 + 对齐 ──
      throwIfAborted(signal);
      tracker.start('voice', '🎤 配音并对齐原时间轴…');
      const voice = input.voice || 'zh-CN-YunjianNeural';
      // 说清是哪家配音:豆包按字数计费、Edge 免费,用户有权在日志里一眼看到。
      tracker.progress(`🎤 配音:${voiceProviderLabel(voice)} · 音色 ${voice}`);
      const rate = typeof input.voiceRate === 'number' ? input.voiceRate : 0;
      aligned = await synthAndAlign(translated, voice, rate, assetDir, srcDur, targetLabel, (m) => tracker.progress(m), signal, (tk, usd) => { tracker.addTokens(tk, usd); aiCostUsd += usd; });
      if (!aligned) { const err = '配音失败(edge-tts 不可用或全部句子合成失败)'; tracker.fail('voice', err); return { ok: false, error: err }; }
      tracker.done('voice', `✅ 配音就绪 · ${aligned.cues.length} 句 · 共 ${aligned.totalDur.toFixed(1)}s`);

      // 字幕存档(原文 / 译文 srt + 译文 txt)。放在这里是因为要用 aligned.cues 的最终时间轴 ——
      //   它和成片里烧进去的那份完全一致,拿去核对译文不会有偏差。
      // 源语言优先用 ASR 实际探测到的(用户那栏常常留 'auto');目标语言用向导选的码。
      saveSubtitleArchive(
        destDir,
        String(asr.language || (input as any).repostSourceLang || ''),
        String(targetLang || ''),
        regrouped,
        aligned.cues,
        (m) => tracker.progress(m),
      );
    }

    // ── STEP 5:合成 ──
    throwIfAborted(signal);
    tracker.start('compose', '🎞️ 合成成片…');

    // 计费:无人声(原片直发)只扣平台费(aiCostUsd=0,不翻倍);有配音则平台费 + token 消耗翻倍。
    const charge = await chargeRepostVideo(aiCostUsd);
    if (!charge.ok) {
      const err = charge.reason === 'insufficient' ? '余额不足,无法生成(请充值后重试)'
        : charge.reason === 'no_auth' ? '未登录 NoobClaw,无法生成'
        : '平台基础费预扣失败,请稍后重试';
      tracker.fail('compose', err);
      return { ok: false, error: err };
    }
    chargeId = charge.chargeId;
    void chargeId;
    // 用户要求(2026-07-28):不显示扣费明细提示、且【绝不退回】(ASR/翻译已产生真实成本)。
    //   refundOnExit 保持 false → finally 不退款;只把消耗静默计入「本次消耗」显示。
    tracker.addTokens(charge.chargedTokens || 0, charge.feeUsd || 0);

    const outPath = path.join(destDir, `翻译搬运_${targetLang}.mp4`);

    if (noSpeech || !aligned) {
      // 原片直发:保留原声,直接 remux(零转码 + faststart);容器不兼容再重编码兜底。
      const r = await runFfmpeg(['-y', '-i', sourceVideoPath, '-c', 'copy', '-movflags', '+faststart', outPath], { timeoutMs: 180_000, signal });
      if (!r.ok || !fs.existsSync(outPath)) {
        const r2 = await runFfmpeg(
          ['-y', '-i', sourceVideoPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath],
          { timeoutMs: composeTimeoutMs(srcDur), signal, onStderr: ffmpegProgress(srcDur, '转码', (m) => tracker.progress(m)) },
        );
        if (!r2.ok || !fs.existsSync(outPath)) { const err = '合成失败(原片直发出错)'; tracker.fail('compose', err); return { ok: false, error: err }; }
      }
      tracker.done('compose', `📦 原片直发就绪(保留原声)· 📂 ${destDir}`);
    } else {
      // 有配音:组装最终音轨(配音为主;可选原声压低垫底保 BGM/音效)+ 换音轨(可选烧字幕)。
      let finalAudio = aligned.voiceTrackPath;
      // ── 画面微伸缩(温和版,用户拍板):配音总长超过原片 ≤15% 时,整条画面 setpts 放慢
      //    到正好匹配(15% 以内肉眼基本无感),超出部分仍靠冻结末帧。配音不长则不动画面。
      const vStretch = srcDur > 0 && aligned.totalDur > srcDur + 0.3
        ? Math.min(TUNE.stretchMax, aligned.totalDur / srcDur) : 1;
      if (vStretch > 1.005) tracker.progress(`🎬 画面微伸缩 ×${vStretch.toFixed(2)}(配音略长,放慢画面代替冻结)`);
      if ((input as any).repostKeepBgm) {
        const mixed = path.join(assetDir, 'final_audio.m4a');
        // ⚠️ 原声垫底用【源视频音轨】;画面被放慢时垫底同步 atempo 放慢,避免音效跟画面错位。
        const bgFilt = vStretch > 1.005 ? `atempo=${(1 / vStretch).toFixed(4)},volume=0.12` : 'volume=0.12';
        const r = await runFfmpeg([
          '-y', '-i', aligned.voiceTrackPath, '-i', sourceVideoPath,
          '-filter_complex', `[1:a]${bgFilt}[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]`,
          '-map', '[a]', '-c:a', 'aac', '-b:a', '160k', mixed,
        ], { timeoutMs: 120_000, signal });
        if (r.ok && fs.existsSync(mixed)) finalAudio = mixed;
        else tracker.progress('⚠️ 原声混音失败,改用纯配音');
      }
      // 背景音乐(可选,向导曲库/上传):循环铺满配音长度、按 bgmVolume 压低垫底。失败不阻塞。
      if (input.bgmPath) {
        const bgm = await resolveBgmPath(input.bgmPath, (m) => tracker.progress(m)).catch(() => undefined);
        if (bgm && fs.existsSync(bgm)) {
          const vol = typeof input.bgmVolume === 'number' ? input.bgmVolume : 0.18;
          const withBgm = path.join(assetDir, 'final_audio_bgm.m4a');
          const rb = await runFfmpeg([
            '-y', '-i', finalAudio, '-stream_loop', '-1', '-i', bgm,
            '-filter_complex', `[1:a]volume=${vol}[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]`,
            '-map', '[a]', '-c:a', 'aac', '-b:a', '160k', withBgm,
          ], { timeoutMs: 180_000, signal });
          if (rb.ok && fs.existsSync(withBgm)) { finalAudio = withBgm; tracker.progress('🎵 已叠加背景音乐'); }
          else tracker.progress('⚠️ 背景音乐混音失败,跳过');
        }
      }
      const burn = input.subtitleEnabled !== false;
      if (burn) {
        // 烧译文字幕:生成 ASS(画布=真实分辨率,字号按视频高换算 —— 修 SRT force_style 的
        //   288 虚拟画布导致的巨字挡画面 bug)。底部蒙层收窄到 16%,字幕居中落在带内。
        const dim = await probeImageSize(sourceVideoPath).catch(() => ({ width: 1080, height: 1920 }));
        const W = dim.width > 0 ? dim.width : 1080;
        const H = dim.height > 0 ? dim.height : 1920;
        const fontSetting = input.subtitleFontSize && input.subtitleFontSize > 0 ? input.subtitleFontSize : 20;
        const assPath = path.join(assetDir, 'sub.ass');
        fs.writeFileSync(assPath, buildAss(aligned.cues, W, H, fontSetting), 'utf8');
        // 配音可能比源视频长(译文语速慢)→ 冻结末帧把画面延长到音频总长,再 -t 钉总长,
        //   杜绝「音频没播完画面停了」;短则 -t 就是视频长,无副作用。
        const finalDur = aligned.totalDur;
        const vf = `[0:v]${vStretch > 1.005 ? `setpts=PTS*${vStretch.toFixed(4)},` : ''}tpad=stop_mode=clone:stop_duration=${finalDur.toFixed(3)}[vext];`
          + `[vext]split[vb][vm];[vm]crop=iw:ih*${TUNE.maskRatio.toFixed(3)}:0:ih*${(1 - TUNE.maskRatio).toFixed(3)},boxblur=20:2[vmb];`
          + `[vb][vmb]overlay=0:H*${(1 - TUNE.maskRatio).toFixed(3)}[vbg];[vbg]subtitles='${escSubPath(assPath)}'[v]`;
        const r = await runFfmpeg([
          '-y', '-i', sourceVideoPath, '-i', finalAudio,
          '-filter_complex', vf,
          '-map', '[v]', '-map', '1:a:0',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-c:a', 'aac', '-b:a', '160k', '-t', finalDur.toFixed(3), '-movflags', '+faststart', outPath,
        ], { timeoutMs: composeTimeoutMs(finalDur), signal, onStderr: ffmpegProgress(finalDur, '烧字幕合成', (m) => tracker.progress(m)) });
        if (!r.ok || !fs.existsSync(outPath)) { const err = '合成失败(字幕烧录/编码出错)'; tracker.fail('compose', err); return { ok: false, error: err }; }
      } else {
        const finalDur = aligned.totalDur;
        // 配音比源视频长 → 必须冻结末帧延长画面(copy 无法延长,得重编码);否则「音频没播完画面停了」。
        const needExtend = !(srcDur > 0) || finalDur > srcDur + 0.3;
        if (needExtend) {
          const r = await runFfmpeg([
            '-y', '-i', sourceVideoPath, '-i', finalAudio,
            '-filter_complex', `[0:v]${vStretch > 1.005 ? `setpts=PTS*${vStretch.toFixed(4)},` : ''}tpad=stop_mode=clone:stop_duration=${finalDur.toFixed(3)}[v]`,
            '-map', '[v]', '-map', '1:a:0',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac', '-b:a', '160k', '-t', finalDur.toFixed(3), '-movflags', '+faststart', outPath,
          ], { timeoutMs: composeTimeoutMs(finalDur), signal, onStderr: ffmpegProgress(finalDur, '合成', (m) => tracker.progress(m)) });
          if (!r.ok || !fs.existsSync(outPath)) { const err = '合成失败(换音轨/延长画面出错)'; tracker.fail('compose', err); return { ok: false, error: err }; }
        } else {
          // 配音不长于视频:换音轨,画面能 copy 就 copy(零转码最快)。
          // ⚠️ 但【只有 H.264 才能 copy】。YouTube 的最佳画质通常是 VP9/AV1,封进 mp4 容器
          //    规范上合法、实际 Windows Media Player / QuickTime / 多数平台都播不了 ——
          //    copy 出去用户拿到的成片就是打不开的(真机反馈:下下来的片子播不了)。
          //    非 H.264 一律转 libx264,慢一点但保证到处能播、能发。
          const srcCodec = await probeVideoCodec(sourceVideoPath).catch(() => '');
          const canCopy = srcCodec === 'h264';
          if (!canCopy && srcCodec) tracker.progress(`🎞️ 源视频编码 ${srcCodec}(非 H.264,多数播放器/平台不认)→ 转码为 H.264`);
          const r = await runFfmpeg([
            '-y', '-i', sourceVideoPath, '-i', finalAudio,
            '-map', '0:v:0', '-map', '1:a:0',
            ...(canCopy ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']),
            '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', outPath,
          ], { timeoutMs: canCopy ? 600_000 : composeTimeoutMs(srcDur), signal, onStderr: canCopy ? undefined : ffmpegProgress(srcDur, '转码合成', (m) => tracker.progress(m)) });
          if (!r.ok || !fs.existsSync(outPath)) { const err = '合成失败(换音轨出错)'; tracker.fail('compose', err); return { ok: false, error: err }; }
        }
      }
      tracker.done('compose', `📦 成片就绪 · 📂 ${destDir}`);
    }
    refundOnExit = false; // 成片已产出 → 费用照收(发布失败不退,与其它引擎一致)

    // ── STEP 6:发布(复用现有)──
    // ⚠️ 进 publish 前查 abort,且【不抛】:成片已落地、平台费已收下,抛出去会被外层 catch
    //    归成失败(成片被记成 error、outputPath 丢失)。当成「成了,只是没发」。
    if (signal?.aborted) {
      tracker.progress('⏹ 已停止 · 成片已保存,跳过发布');
      tracker.finish(outPath, 1, true); // aborted → UI 显示「已停止」而非「生成完成」
      return { ok: true, outputPath: outPath, outputPaths: [outPath], aborted: true } as VideoCreationResult;
    }
    tracker.start('publish');
    const wantPublish = Array.isArray(input.publishPlatforms) && input.publishPlatforms.length > 0;
    try {
      const summary = translated.map((s) => s.text).filter(Boolean).join(' ').slice(0, 600);
      const cap = await resolvePublishCaption({
        wantPublish,
        summary,
        title: input.publishTitle,
        keywords: input.keywords,
        track: input.track,
        lang: targetLang as any,
        userTitle: input.publishTitle,
        userCaption: input.publishCaption,
        userTags: input.hashtags,
        onLog: (m: string) => tracker.progress(m),
        onCost: (tk, usd) => tracker.addTokens(tk, usd),
      });
      const { MATRIX_EDITION } = require('../../matrixEdition');
      if (MATRIX_EDITION && wantPublish) {
        const { runMatrixPublishStep } = require('./publishers/runMatrixPublish');
        await runMatrixPublishStep({
          platforms: input.publishPlatforms || [],
          accounts: (input as any).publishAccounts || {},
          videoPath: outPath, title: cap.title, description: cap.description, tags: cap.tags,
          onLog: (m: string) => tracker.progress(m), signal,
        });
      } else if (wantPublish) {
        const { runPublishStep } = require('./publishers/runPublish');
        await runPublishStep({
          platforms: input.publishPlatforms || [],
          videoPath: outPath, title: cap.title, description: cap.description, tags: cap.tags,
          onLog: (m: string) => tracker.progress(m), signal,
        });
      }
    } catch (e) {
      tracker.progress(`⚠️ 发布步骤异常:${String((e as Error)?.message || e).slice(0, 120)}`);
    }
    tracker.finish(outPath, 1);
    return { ok: true, outputPath: outPath, outputPaths: [outPath] };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    // 用户停止:归一成「已停止」+ aborted 标记。否则 UI 直接显示内部错误串
    // 「VIDEO_ABORTED:已停止」(渲染端无此前缀的文案映射),且 compose 会被误标红。
    const aborted = err.startsWith('VIDEO_ABORTED');
    const msg = aborted ? '已停止' : err.slice(0, 300);
    tracker.fail(aborted ? null : 'compose', msg);
    return { ok: false, error: msg, ...(aborted ? { aborted: true } : {}) } as VideoCreationResult;
  } finally {
    // 成片失败 → 退回合成前预扣的(平台费 + 翻倍那份)。幂等,按 chargeId。
    if (refundOnExit && chargeId) {
      try {
        const refunded = await refundMode1Video(chargeId);
        tracker.progress(refunded ? '↩️ 成片失败,已退回预扣费用' : '⚠️ 成片失败,退款请求未成功(可联系客服核对)');
      } catch { /* 退款失败仅忽略 */ }
    }
    try { fs.rmSync(assetDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
