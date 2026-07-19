/**
 * tts — 文案配音 + 字幕时间轴(抄 MoneyPrinterTurbo 的离线字幕方案)。
 *
 * 配音走微软 Edge 在线 TTS(免费、无需 key)。**纯 JS 实现**:用 npm 包
 * `edge-tts-universal`(无任何 Python 依赖),在 Electron 主进程 / Node 里直接
 * 连微软 TTS 的 WebSocket 端点合成 —— 不再 spawn `python -m edge_tts`,因此
 *   - Windows 不用再内置/装 Python(根治退出码 9009「找不到 python」),
 *   - mac/Windows 共用同一条代码路径(不再有 venv / PEP 668 那套分叉)。
 *
 * 字幕:edge-tts-universal 的 synthesize() 在返回 MP3 音频的同时,带回逐词
 * 【WordBoundary】元数据(offset/duration,单位 100 纳秒 = 1e-7 秒)。我们把它
 * 换算成秒、映射成本模块原有的 TtsCue(逐词,时间相对本次合成起点),再按 ~12 字
 * 攒成短语 cue 返回给 compose 烧字幕,字幕和旁白严丝合缝。WordBoundary 为空 / 解析
 * 失败不影响出片(compose 会退回按各镜时长估算的 cue)。
 *
 * 音频:库给的是 MP3 字节(audio-24khz-48kbitrate-mono-mp3),直接写到 outPath
 * (消费方一直用 .mp3),时长用既有 ffprobe(probeDuration)实测,跟以前一致。
 *
 * 可靠性:edge-tts 在线接口偶发抖动/限流,synthesize() 内置最多 5 次重试(指数退避)。
 * 仍合成不出真人声时返回 synthesized:false(并把诊断写进 _lastTtsError),
 * 静音 mp3 只作为占位返回 —— 由 pipeline 判定为配音失败、终止出片并退费,
 * 绝不把「无配音的视频」当成片交付。
 */

import fs from 'fs';
import { EdgeTTS, type WordBoundary } from 'edge-tts-universal';
import { runFfmpeg, probeDuration } from './ffmpegRuntime';
import { getTtsVoice } from './config';
import { type TtsCue } from './ttsAlign';

// TtsCue 定义在 ttsAlign(纯模块,便于测试);这里 re-export 保持既有 import 路径不变。
export type { TtsCue } from './ttsAlign';
export { alignSentencesToCues } from './ttsAlign';

export interface TtsResult {
  ok: boolean;
  /** 音频文件路径(成功是真人声,失败是静音兜底)。 */
  audioPath: string;
  durationSec: number;
  /** true = 真 TTS;false = 静音兜底。 */
  synthesized: boolean;
  /**
   * edge-tts 词边界出的短语级字幕 cue(相对本句起点)。真 TTS 且字幕解析成功才有;
   * 静音兜底 / 解析失败为 undefined,上层退回估算。
   */
  cues?: TtsCue[];
}

/** 最近一次 TTS 失败原因(给上层/日志用,避免静默)。 */
let _lastTtsError: string | null = null;
export function getLastTtsError(): string | null {
  return _lastTtsError;
}

function estimateDuration(text: string): number {
  // 中文约 4.5 字/秒,英文按词粗算;给点首尾留白。
  const chars = text.replace(/\s+/g, '').length;
  return Math.max(1.8, chars / 4.5 + 0.4);
}

/** 生成静音 mp3 兜底。 */
async function makeSilence(outPath: string, durationSec: number): Promise<boolean> {
  const r = await runFfmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
    '-t', durationSec.toFixed(2),
    '-c:a', 'libmp3lame', '-q:a', '6',
    outPath,
  ], { timeoutMs: 30_000 });
  return r.ok && fs.existsSync(outPath);
}

/** 把语速档(-50~+50,单位%)归一成 edge-tts 的 `+N%` 串;0/非法 → 不传(`+0%`)。 */
function normalizeRate(rate?: number): string {
  const n = Math.round(Number(rate) || 0);
  if (!Number.isFinite(n) || n === 0) return '+0%';
  const clamped = Math.max(-50, Math.min(50, n));
  return clamped >= 0 ? `+${clamped}%` : `${clamped}%`;
}

/** 100 纳秒(edge-tts WordBoundary 单位)→ 秒。 */
const TICKS_PER_SEC = 10_000_000;

/**
 * 把 edge-tts-universal 的 WordBoundary[] 换算成逐词 TtsCue[](时间相对本次合成起点,秒)。
 * offset/duration 都是 100ns ticks。空文本 / 非法时间的条目丢弃。
 */
function wordBoundariesToCues(words: WordBoundary[]): TtsCue[] {
  const out: TtsCue[] = [];
  for (const w of words || []) {
    const text = String(w?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = Number(w.offset) / TICKS_PER_SEC;
    const end = (Number(w.offset) + Number(w.duration)) / TICKS_PER_SEC;
    if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) continue;
    out.push({ text, start, end });
  }
  return out;
}

/**
 * edge-tts-universal 的 WordBoundary 词文本【不含标点】(实测:「今天，我们…」只回
 * ["今天","我们"…])。把原文案的标点/符号按词序贴回每个词 cue —— 每个词带上它到
 * 【下一个词起点之前】的原文片段(尾随标点归前词;首词带上句首标点)。匹配失败则
 * 原样返回(退回无标点,不致崩)。这样 groupWordCues 出的字幕短语保留标点。
 */
function reattachPunctuation(original: string, words: TtsCue[]): TtsCue[] {
  const orig = original || '';
  const n = orig.length;
  if (!words.length || !n) return words;
  // 在 orig[from..] 里按词字符(忽略空白)定位该词,返回 [start, end)。
  const findWord = (wtext: string, from: number): { start: number; end: number } | null => {
    const wt = (wtext || '').replace(/\s+/g, '');
    if (!wt) return null;
    for (let i = from; i < n; i++) {
      let j = i, k = 0;
      while (j < n && k < wt.length) {
        if (/\s/.test(orig[j])) { j++; continue; }
        if (orig[j] === wt[k]) { j++; k++; } else break;
      }
      if (k === wt.length) return { start: i, end: j };
    }
    return null;
  };
  const spans: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (const w of words) {
    const m = findWord(w.text, from);
    if (!m) return words; // 对不上 → 退回原样(无标点),不冒险错位
    spans.push(m);
    from = m.end;
  }
  return words.map((w, idx) => {
    const start = idx === 0 ? 0 : spans[idx].start;            // 首词带句首标点
    const end = idx + 1 < spans.length ? spans[idx + 1].start : n; // 尾随标点归前词
    const display = orig.slice(start, end).trim();
    return { ...w, text: display || w.text };
  });
}

/**
 * 把逐词 cue 攒成 ~maxChars 字一段的短语 cue(用真实词级时间戳,不估算)。
 * 短语 start = 首词 start,end = 末词 end。中文按字,英文按词长累加。
 */
export function groupWordCues(words: TtsCue[], maxChars = 12): TtsCue[] {
  const out: TtsCue[] = [];
  let buf = '';
  let start: number | null = null;
  let end = 0;
  const hasCjk = (s: string) => /[　-鿿＀-￯]/.test(s);
  for (const w of words) {
    if (start === null) start = w.start;
    // 英文词之间加空格,中文不加。
    buf = buf && !hasCjk(w.text) && !hasCjk(buf.slice(-1)) ? `${buf} ${w.text}` : `${buf}${w.text}`;
    end = w.end;
    if (buf.length >= maxChars) {
      out.push({ text: buf, start, end });
      buf = '';
      start = null;
    }
  }
  if (buf && start !== null) out.push({ text: buf, start, end });
  return out;
}

interface EdgeTtsRun {
  ok: boolean;
  /** 成功时的逐词 cue(相对本次合成起点);失败为空。 */
  words: TtsCue[];
  /** 失败诊断(异常 message / 超时 / 空输出),给上层拼进 _lastTtsError。 */
  detail: string;
}

/**
 * 合成超时(连不通微软端点 / 卡死时兜底)。按文本长度自适应:
 * 活连接首字节 <3s、音频流 15~30× 实时速度,死连接(黑洞)等多久都不会活 ——
 * 2026-07-19 真机:用户网络到微软 TTS 大面积黑洞、少数连接能通,固定 60s/次把
 * 重试预算全烧在死连接上(模板速生 1 次超时+1 次成功耗 65s 实锤)。
 * 短文本 ~17s、整段长组 ~40s,封顶 60s —— 同样的预算能多抽几次「活连接」。
 */
function synthTimeoutMs(text: string): number {
  return Math.min(60_000, 15_000 + Math.ceil((estimateDuration(text) * 1000) / 5));
}

/**
 * 跑一次 edge-tts-universal 合成:写 MP3 到 outPath,返回逐词 cue。
 * 不抛异常 —— 失败把原因放进 detail,由调用方决定重试 / 兜底。
 */
async function runEdgeTts(text: string, voice: string, outPath: string, rate?: number, signal?: AbortSignal): Promise<EdgeTtsRun> {
  // 每次重试前清掉上轮可能残留的半截输出,避免「旧文件 >256 字节」骗过校验。
  try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
  let timer: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;
  try {
    const tts = new EdgeTTS(text, voice, { rate: normalizeRate(rate) });
    // synthesize() 是单次 WebSocket 往返;库本身不带超时,这里用 Promise.race 兜底,
    // 避免端点不通时永不 resolve 卡死出片流程。用户点停止(signal)也立刻掀桌,
    // 不用干等 60s 超时才轮到外层 throwIfAborted。
    const timeoutMs = synthTimeoutMs(text);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`合成超时(${Math.round(timeoutMs / 1000)}s:到微软 TTS 的连接黑洞/被拒,换连接重试)`)),
        timeoutMs,
      );
    });
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      if (signal.aborted) { reject(new Error('已停止')); return; }
      onAbort = () => reject(new Error('已停止'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const res = await Promise.race([tts.synthesize(), timeout, aborted]);
    const buf = Buffer.from(await res.audio.arrayBuffer());
    if (buf.length <= 256) {
      return { ok: false, words: [], detail: '合成返回空音频' };
    }
    fs.writeFileSync(outPath, buf);
    const words = reattachPunctuation(text, wordBoundariesToCues(res.subtitle || []));
    return { ok: true, words, detail: '' };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(-200);
    return { ok: false, words: [], detail: msg || '未知错误' };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** 重试间隔休眠(edge-tts 网络抖动,退避一下再试)。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** synthesize() 的可选控制项(不传 = 老行为)。 */
export interface SynthesizeOpts {
  /** 用户停止信号:当次 WebSocket 立即掀桌,重试循环立即退出(不再退避睡眠)。 */
  signal?: AbortSignal;
  /** 重试次数上限(默认 5)。多段流水(爆帖逐段配音)可调小,防失败时静默磨太久。 */
  maxAttempts?: number;
}

/**
 * 给一句文案配音,输出 mp3 到 outPath。失败自动退化为静音 mp3。
 */
export async function synthesize(text: string, outPath: string, voice?: string, rate?: number, opts?: SynthesizeOpts): Promise<TtsResult> {
  const clean = (text || '').trim();
  const estDur = estimateDuration(clean || '。');
  const useVoice = voice || getTtsVoice();

  if (clean) {
    try {
      // edge-tts 走在线接口,偶发网络抖动/限流 → 重试最多 5 次再判失败(指数退避)。
      // 2026-04 起微软上游按 voice 间歇性拒发音频(rany2/edge-tts#473),
      // 单纯加重试次数仍有限,真正救场要靠调用方做 voice fallback(见 getVoiceFallbacks)。
      const MAX_ATTEMPTS = Math.max(1, opts?.maxAttempts ?? 5);
      let lastDetail = '';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (opts?.signal?.aborted) break;
        const run = await runEdgeTts(clean, useVoice, outPath, rate, opts?.signal);
        if (run.ok) {
          const dur = await probeDuration(outPath);
          let cues: TtsCue[] | undefined;
          try {
            if (run.words.length > 0) cues = groupWordCues(run.words);
          } catch { /* 解析失败 → 上层估算兜底 */ }
          return {
            ok: true,
            audioPath: outPath,
            durationSec: dur > 0 ? dur : estDur,
            synthesized: true,
            cues,
          };
        }
        lastDetail = run.detail || lastDetail;
        if (attempt < MAX_ATTEMPTS && !opts?.signal?.aborted) await sleep(800 * attempt);
      }
      _lastTtsError = lastDetail
        ? `edge-tts 合成失败(已重试 ${MAX_ATTEMPTS} 次):${lastDetail.slice(0, 160)}`
        : `edge-tts 运行失败(合成无输出,已重试 ${MAX_ATTEMPTS} 次)`;
    } catch (e) {
      _lastTtsError = e instanceof Error ? e.message : String(e);
      // fall through to silence
    }
  }

  // 兜底:静音
  const silenceOk = await makeSilence(outPath, estDur);
  return {
    ok: silenceOk,
    audioPath: outPath,
    durationSec: estDur,
    synthesized: false,
  };
}

/**
 * 同语种同性别的 voice fallback 链(整片重做用)。数组首位 = primary,后续是同语种同性别备选。
 * 表里没有就只返回 [primary] — 不切 voice,只靠 synthesize() 内部 MAX_ATTEMPTS=5 次重试救场。
 *
 * 背景:edge-tts 2026-04 起出现【按 voice 间歇性拒发音频】的上游问题(rany2/edge-tts#473 至今 open),
 *   单 voice 多次重试也救不回时,**换 voice 整片重做**是上游用户实测有效的 workaround
 *   (评论:"I tried to use another voice, and then it worked again")。
 *
 * 设计规则:
 *   - 只在【同语种 + 同性别】之间 fallback,避免音色 / 语种突变让用户体验更糟。
 *   - 调用方(pipeline)拿到链后,要的是【整片重头合】,不是单句切,这样音色全篇统一。
 *   - 没列进表的 voice(方言、独子 voice、跨性别没法救)→ 走单 voice 重试,失败就退费。
 *   - HsiaoYu(台湾女声第二个)只用作 HsiaoChen 的后台 fallback,UI 不暴露。
 */
export function getVoiceFallbacks(primary: string): string[] {
  const M: Record<string, string[]> = {
    // —— 中文标准女声 ——
    'zh-CN-XiaoxiaoNeural':  ['zh-CN-XiaoxiaoNeural',  'zh-CN-XiaoyiNeural'],
    'zh-CN-XiaoyiNeural':    ['zh-CN-XiaoyiNeural',    'zh-CN-XiaoxiaoNeural'],
    // —— 中文男声(3 互救) ——
    'zh-CN-YunxiNeural':     ['zh-CN-YunxiNeural',     'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural'],
    'zh-CN-YunyangNeural':   ['zh-CN-YunyangNeural',   'zh-CN-YunxiNeural',   'zh-CN-YunjianNeural'],
    'zh-CN-YunjianNeural':   ['zh-CN-YunjianNeural',   'zh-CN-YunxiNeural',   'zh-CN-YunyangNeural'],
    // —— 粤语女声(HiuGaai / HiuMaan 互救;WanLung 男声唯一,不 fallback) ——
    'zh-HK-HiuGaaiNeural':   ['zh-HK-HiuGaaiNeural',   'zh-HK-HiuMaanNeural'],
    'zh-HK-HiuMaanNeural':   ['zh-HK-HiuMaanNeural',   'zh-HK-HiuGaaiNeural'],
    // —— 台湾国语女声(HsiaoChen → HsiaoYu 后台备胎) ——
    'zh-TW-HsiaoChenNeural': ['zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural'],
    // —— 英文女声(3 互救) ——
    'en-US-JennyNeural':     ['en-US-JennyNeural',     'en-US-AriaNeural',    'en-US-EmmaNeural'],
    'en-US-AriaNeural':      ['en-US-AriaNeural',      'en-US-JennyNeural',   'en-US-EmmaNeural'],
    'en-US-EmmaNeural':      ['en-US-EmmaNeural',      'en-US-AriaNeural',    'en-US-JennyNeural'],
    // —— 英文男声(3 互救) ——
    'en-US-GuyNeural':       ['en-US-GuyNeural',       'en-US-AndrewNeural',  'en-US-BrianNeural'],
    'en-US-AndrewNeural':    ['en-US-AndrewNeural',    'en-US-GuyNeural',     'en-US-BrianNeural'],
    'en-US-BrianNeural':     ['en-US-BrianNeural',     'en-US-AndrewNeural',  'en-US-GuyNeural'],
    // —— 以下 voice 不做 voice 切换 fallback,只靠 5 次重试: ——
    //   zh-CN-liaoning-XiaobeiNeural(东北方言独子)、zh-TW-YunJheNeural(台湾男声独子)、
    //   ja/ko/fr/es-MX/pt-BR/id/vi/ar 各只配了一对 voice,跨性别会让音色跳变,体验不如失败退费让用户重试。
  };
  return M[primary] || [primary];
}

/**
 * 同语种【全音色】fallback 链:先走 getVoiceFallbacks 的同性别链,走完再跨性别补齐同语种
 * 其余 voice。给爆帖这类「整段一口气」链路用 —— 2026-07-19 真机实锤:#473 的音色拒发是
 * 按【音色族】来的(云健/云希/云扬男声全灭,同一时刻晓晓正常),同性别链全军覆没时,
 * 跨性别换个音色能出片,比整条视频失败强。单句流水(stock 逐句)不用它,保持音色统一。
 */
export function getVoiceFallbacksWide(primary: string): string[] {
  const lang = primary.split('-').slice(0, 2).join('-');
  const ALL: Record<string, string[]> = {
    'zh-CN': ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural'],
    'zh-HK': ['zh-HK-HiuGaaiNeural', 'zh-HK-HiuMaanNeural', 'zh-HK-WanLungNeural'],
    'zh-TW': ['zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural'],
    'en-US': ['en-US-JennyNeural', 'en-US-AriaNeural', 'en-US-EmmaNeural', 'en-US-GuyNeural', 'en-US-AndrewNeural', 'en-US-BrianNeural'],
  };
  const base = getVoiceFallbacks(primary);
  const extra = (ALL[lang] || []).filter((v) => !base.includes(v));
  return [...base, ...extra];
}

// ─────────────────────── 整段「一口气」合成 + 切句对齐 ───────────────────────
//
// 背景:stock/ai pipeline 把文案拆成 N 句、逐句合成(N 次 edge-tts 网络请求),每句对一个
//   画面镜头。N 越大,越容易撞上 edge-tts 2026-04 的「按 voice 间歇性拒发」(rany2/edge-tts#473)。
//   「一口气」= 整段只发 1 次请求合成,再用 edge-tts 自带的【词/句边界时间戳】把整段音频切回
//   N 段喂回分镜流程。请求数 N→1,被拒概率从根上降下来(对齐 template-pipeline 的单次合成)。
//
//   切句对齐是关键且唯一的风险点:edge-tts 整段的分句/cue 粒度不可控,不能假设 cue 数==句数。
//   这里用【去标点空格的字符流累计映射】把每句的字符区间锚到 cue 的真实时间戳,逐句边界都有
//   真实时间锚点 → 不累积误差。字符流严重对不上(数字/英文被 edge-tts 规整)时返回 null,
//   调用方安全回退到逐句合成,绝不交付错位片。

export interface WholeTtsResult {
  ok: boolean;
  audioPath: string;
  durationSec: number;
  /** 原始逐条 cue(未 group,相对整段起点),切句对齐 + 字幕都用它。 */
  rawCues: TtsCue[];
}

/**
 * 整段合成一次(单 voice;voice fallback 由调用方控制 —— 整段失败换 voice 重合,1 次请求不浪费)。
 * 失败把原因写进 _lastTtsError,返回 ok:false。
 */
export async function synthesizeWhole(text: string, outPath: string, voice: string, rate?: number, opts?: SynthesizeOpts): Promise<WholeTtsResult> {
  const clean = (text || '').trim();
  const fail = (): WholeTtsResult => ({ ok: false, audioPath: outPath, durationSec: 0, rawCues: [] });
  if (!clean) return fail();
  const MAX_ATTEMPTS = Math.max(1, opts?.maxAttempts ?? 5);
  let lastDetail = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (opts?.signal?.aborted) break;
    const run = await runEdgeTts(clean, voice, outPath, rate, opts?.signal);
    if (run.ok) {
      const dur = await probeDuration(outPath);
      return { ok: true, audioPath: outPath, durationSec: dur > 0 ? dur : estimateDuration(clean), rawCues: run.words };
    }
    lastDetail = run.detail || lastDetail;
    if (attempt < MAX_ATTEMPTS && !opts?.signal?.aborted) await sleep(800 * attempt);
  }
  _lastTtsError = lastDetail
    ? `edge-tts 整段合成失败(已重试 ${MAX_ATTEMPTS} 次):${lastDetail.slice(0, 160)}`
    : `edge-tts 整段合成无有效输出(已重试 ${MAX_ATTEMPTS} 次)`;
  return fail();
}
