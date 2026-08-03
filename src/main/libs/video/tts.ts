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
import { getNoobClawAuthToken } from '../claudeSettings';

function apiBase(): string { return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com'; }

/** 豆包音色 id 形如 zh_male_xxx_bigtts / zh_female_xxx(edge 是 xx-XX-XxxNeural)。 */
export function isDoubaoVoice(v: string | undefined): boolean {
  const id = String(v || '');
  return /_(male|female)_/i.test(id) && !/Neural$/i.test(id);
}

/**
 * 配音供应商的人话标签。进度日志一律带上它 —— 用户看到「正在合成配音…」根本不知道
 * 这一步花不花钱:豆包按字符计费(成本×2),Edge 完全免费,差别是实打实的钱。
 */
export function voiceProviderLabel(voice: string | undefined): string {
  return isDoubaoVoice(voice) ? '豆包真人(按字数计费)' : 'Edge 微软(免费)';
}

/**
 * 豆包(火山)大模型语音合成:走后端代理 /api/tts/synthesize(key 不下发、按字符×2 计费)。
 * 成功写 mp3 到 outPath;任何失败返回 null → 调用方回退 edge-tts(用户拍板的兜底策略)。
 */
/**
 * 豆包(火山)大模型语音合成:走后端代理 /api/tts/synthesize(key 不下发、按字符×2 计费)。
 *
 * 长度不用管:后端按字节自动分流 —— ≤1024 字节走在线合成 HTTP,超了自动改走火山的
 * 异步长文本接口(单次 10 万字符),返回体形状一致。客户端这边不再做任何切分。
 *
 * ⚠️【长文本必须走 job 轮询,不能干等】火山长文本要 1~3 分钟,而 **Cloudflare 100 秒就掐连接**
 *    → 客户端收到 524。整段合成上线以来一次都没成功过,全卡在这。现在:超 1024 字节时发
 *    `async:true`,后端立刻回 202 + job_id,客户端轮询 `/api/tts/job/:id` 取结果。
 */
const LONG_TEXT_BYTES = 1024;          // 与后端 SYNC_MAX_BYTES 对齐

/**
 * 本进程内异步长文本接口是否已被判定不可用。
 *
 * ⚠️ 整段合成会按 voiceChain 逐个音色重试。长文本接口若真的挂了(真机:143 字的口播
 *   轮询 300 秒仍未完成),每个音色都要重等一遍 —— 一条视频白白磨掉十几分钟才回退逐句。
 *   一次失败就置位,本次进程后续直接跳过整段路径、立刻走逐句,别拿用户的时间试错。
 */
let _longTextBroken = false;
export function isLongTextTtsBroken(): boolean { return _longTextBroken; }
const JOB_POLL_INTERVAL_MS = 3_000;
const JOB_POLL_MAX_MS = 420_000;       // 7 分钟(后端上游上限 5 分钟 + 下载余量)

async function pollTtsJob(jobId: string, token: string, signal?: AbortSignal, onProgress?: (m: string) => void): Promise<any | null> {
  const deadline = Date.now() + JOB_POLL_MAX_MS;
  const t0 = Date.now();
  let lastTick = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) { _lastTtsError = '已停止'; return null; }
    await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
    if (signal?.aborted) { _lastTtsError = '已停止'; return null; }
    // 每 10 秒报一次等待时长 —— 长文本接口要 30~90 秒,不报的话界面就是「请稍候」然后死寂。
    const waited = Math.round((Date.now() - t0) / 1000);
    if (onProgress && waited - lastTick >= 10) {
      lastTick = waited;
      onProgress(`🎤 整段合成中… 已等 ${waited}s(长文本接口,通常 30~90s)`);
    }
    try {
      const r = await fetch(`${apiBase()}/api/tts/job/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      const j: any = await r.json().catch(() => ({}));
      if (j?.status === 'done') return j;
      if (j?.status === 'failed') { _lastTtsError = `豆包长文本合成失败:${String(j?.error || '').slice(0, 140)}`; return null; }
      // 4xx 是确定性错误(job 过期 404 / 登录失效 401 / 不是本人 403),再轮也不会变 —— 立刻退出,
      //   否则要空转到 7 分钟超时才报错,用户干等。5xx/429 是瞬时的,继续轮询。
      if (r.status >= 400 && r.status < 500) {
        _lastTtsError = r.status === 404 ? '豆包长文本任务已过期' : `豆包长文本查询失败(${r.status})`;
        return null;
      }
      // queued / processing → 继续轮询
    } catch {
      // 单次查询抖动不算失败,下一轮再试
    }
  }
  _lastTtsError = `豆包长文本合成超时(${Math.round(JOB_POLL_MAX_MS / 1000)}s 未完成)`;
  return null;
}

async function synthDoubao(
  text: string, outPath: string, voice: string, rate?: number, signal?: AbortSignal,
  opts?: { needTimestamps?: boolean; onProgress?: (m: string) => void },
): Promise<{ ok: boolean; tokens: number; costUsd: number; sentences?: TtsCue[] } | null> {
  const token = getNoobClawAuthToken();
  if (!token) return null;
  // edge 的 rate 是百分比偏移(-50..50),豆包是倍率(0.1..2.0)。
  const speedRatio = Math.max(0.5, Math.min(2, 1 + (Number(rate) || 0) / 100));
  const clean = (text || '').trim();
  if (!clean) return null;
  // ⚠️【整段合成为什么一直失败】火山有两个合成接口:
  //    · 在线同步 HTTP —— 快(几秒),但**不支持 enable_timestamp**,不回 sentences/words
  //    · 异步长文本   —— 慢(提交+轮询),但支持时间戳,且没有长度下限
  //    旧逻辑只按「>1024 字节」分流,而 45 秒视频的口播才 200 来字 ≈ 600 字节 → 永远走同步 →
  //    永远拿不到时间戳 → synthesizeWhole 永远 fail → 每次都回退逐句。在线素材/热搜/模板
  //    的整段合成因此**从来没成功过**。所以:【要时间戳就强制走异步,不看长度】。
  //    计费不变(都按字符实扣),只是多等一会儿。
  const isLong = Buffer.byteLength(clean, 'utf8') > LONG_TEXT_BYTES;
  const useAsync = isLong || !!opts?.needTimestamps;
  try {
    const resp = await fetch(`${apiBase()}/api/tts/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        text: clean, voice, speedRatio, encoding: 'mp3',
        ...(useAsync ? { async: true, wantTimestamps: true } : {}),
      }),
      // 短文本在线合成:120s 足够。长文本这一发只是「提交」,后端立刻回 202。
      // ⚠️ 必须 any([signal, timeout]):旧代码是 `signal || timeout`,一旦上层传了 signal
      //    这个 fetch 就【彻底没有超时】—— 上游挂住时整条任务无限期卡在这里。
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    if (!resp.ok && resp.status !== 202) {
      const j: any = await resp.json().catch(() => ({}));
      _lastTtsError = `豆包配音失败(${resp.status}):${String(j?.message || j?.error || '').slice(0, 120)}`;
      return null;
    }
    let j: any = await resp.json();
    // 202 = 长文本 job 已入队 → 轮询取结果(绕开 Cloudflare 100s)。
    if (j?.job_id) {
      const done = await pollTtsJob(String(j.job_id), token, signal, opts?.onProgress);
      if (!done) {
        // 超时/上游失败 → 本进程别再走长文本了(见 _longTextBroken)。用户主动停止不算。
        if (!signal?.aborted) _longTextBroken = true;
        return null;
      }
      j = done;
    }
    const b64 = typeof j?.audioBase64 === 'string' ? j.audioBase64 : '';
    if (!b64) { _lastTtsError = '豆包配音返回空音频'; return null; }
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    // 长文本接口开了 enable_timestamp → 回 sentences[]{text,start,end,words[]}(秒)。
    //   有它就能把整段音频按【真实时间戳】切回每一句 —— 电影级每镜时长、字幕落点都不再靠估算。
    //   ⚠️ 优先摊平逐字 words:alignSentencesToCues 是按【字符流】对齐的,粒度越细误差越小;
    //      句级只有 N 个锚点,句内字符只能均分,长句里字幕仍会飘。没有 words 才退回句级。
    const rawSents: any[] = Array.isArray(j?.sentences) ? j.sentences : [];
    const flatWords: TtsCue[] = [];
    for (const x of rawSents) {
      if (!Array.isArray(x?.words)) continue;
      for (const w of x.words) {
        const t = String(w?.text || '');
        const st = Number(w?.start) || 0;
        const en = Number(w?.end) || 0;
        if (t && en > st) flatWords.push({ text: t, start: st, end: en });
      }
    }
    const sentences: TtsCue[] | undefined = flatWords.length
      ? flatWords
      : (rawSents
          .map((x: any) => ({ text: String(x?.text || ''), start: Number(x?.start) || 0, end: Number(x?.end) || 0 }))
          .filter((x: TtsCue) => x.text && x.end > x.start) || undefined);
    return {
      ok: true,
      tokens: Number(j?.chargedTokens) || 0,
      costUsd: Number(j?.costUsd) || 0,
      sentences: sentences && sentences.length ? sentences : undefined,
    };
  } catch (e) {
    _lastTtsError = `豆包配音异常:${String((e as Error)?.message || e).slice(0, 100)}`;
    return null;
  }
}

// TtsCue 定义在 ttsAlign(纯模块,便于测试);这里 re-export 保持既有 import 路径不变。
export type { TtsCue } from './ttsAlign';
export { alignSentencesToCues } from './ttsAlign';

export interface TtsResult {
  ok: boolean;
  /** 失败原因(供上层直接展示给用户)。成功时为空。 */
  error?: string;
  /** 音频文件路径(成功是真人声,失败是静音兜底)。 */
  audioPath: string;
  durationSec: number;
  /** true = 真 TTS;false = 静音兜底。 */
  synthesized: boolean;
  /**
   * 本次合成【服务端实扣】的积分(仅豆包;Edge 免费恒为 0)。
   * ⚠️ 以前这个数在 synthesize() 里被丢掉了 —— 于是账单里一串「豆包真人配音」扣费,
   *    任务页的「本次消耗」却一分不含,用户对不上账,只能怀疑重复扣费。
   */
  chargedTokens?: number;
  /** 本次合成的服务端权威 USD 成本(同上,仅豆包)。 */
  costUsd?: number;
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
  /**
   * 进度回调 —— 长等待期间往任务日志推一行,别让界面看着像卡死。
   * ⚠️ 整段合成(synthesizeWhole)走豆包异步长文本接口:提交后要轮询 30~90 秒,
   *    期间原来一个字都不输出,用户只看到「配音合成中…请稍候」然后没动静。
   */
  onProgress?: (msg: string) => void;
}

/**
 * 给一句文案配音,输出 mp3 到 outPath。失败自动退化为静音 mp3。
 */
export async function synthesize(text: string, outPath: string, voice?: string, rate?: number, opts?: SynthesizeOpts): Promise<TtsResult> {
  const clean = (text || '').trim();
  const estDur = estimateDuration(clean || '。');
  const useVoice = voice || getTtsVoice();

  // 豆包音色 → 先走后端代理(更像真人);失败自动回退 edge-tts(同音色语言的默认音色)。
  if (clean && isDoubaoVoice(useVoice)) {
    const d = await synthDoubao(clean, outPath, useVoice, rate, opts?.signal);
    if (d?.ok) {
      const dur = await probeDuration(outPath);
      return {
        ok: true, audioPath: outPath, durationSec: dur > 0 ? dur : estDur, synthesized: true,
        chargedTokens: d.tokens, costUsd: d.costUsd,
        // 豆包长文本带回的句级时间戳(短文走在线接口时没有)→ 字幕直接用真时间,不再估算。
        cues: d.sentences,
      };
    }
    // ⚠️ 豆包合成失败【不回退 Edge】。回退等于把用户选的音色悄悄换成另一个人的声音,
    //    出来的片子他根本不会要 —— 而钱已经花在出图/生成上了。宁可这一步失败让他重试,
    //    也不交一条声音不对的成片。(用户 2026-07-31 明确要求)
    return {
      ok: false,
      audioPath: outPath,
      durationSec: estDur,
      synthesized: false,
      error: `豆包音色 ${useVoice} 合成失败${_lastTtsError ? `:${_lastTtsError.slice(0, 120)}` : ''}`,
    };
  }

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
  /** 服务端实扣积分(仅豆包;Edge 免费恒为 0/undefined)。不带上来的话整段路径的钱会漏计。 */
  chargedTokens?: number;
  costUsd?: number;
}

/**
 * 整段合成一次(单 voice;voice fallback 由调用方控制 —— 整段失败换 voice 重合,1 次请求不浪费)。
 * 失败把原因写进 _lastTtsError,返回 ok:false。
 */
export async function synthesizeWhole(text: string, outPath: string, voice: string, rate?: number, opts?: SynthesizeOpts): Promise<WholeTtsResult> {
  const clean = (text || '').trim();
  const fail = (): WholeTtsResult => ({ ok: false, audioPath: outPath, durationSec: 0, rawCues: [] });
  if (!clean) return fail();
  // ── 豆包:走长文本接口整段合成,用它返回的时间戳当 cue ──────────────────────
  //  以前这里直接拒绝豆包,因为整段路径是纯 edge 实现、且豆包不给词边界。
  //  现在走火山【异步长文本】接口(开 enable_timestamp),回的是逐字时间戳 ——
  //  精度不输 edge 的词边界。于是豆包也能整段:
  //    · 一次合成,韵律比逐句拼接自然(句与句之间没有接缝)
  //    · 切句和字幕都用真实时间戳,不再按字数估
  //  ⚠️ needTimestamps 必须传:在线同步接口不支持时间戳,而 45 秒视频的口播 200 来字
  //     根本到不了 1024 字节的分流线 —— 不强制走异步,整段合成对短口播永远失败。
  if (isDoubaoVoice(voice)) {
    // 本进程已判定长文本接口不可用 → 直接失败让调用方走逐句,别再为每个备用音色重等一轮。
    if (_longTextBroken) { _lastTtsError = '长文本接口本次不可用,直接逐句合成'; return fail(); }
    opts?.onProgress?.('🎤 整段合成:已提交长文本任务,等待返回(带时间戳,切句和字幕用真实时间)');
    const d = await synthDoubao(clean, outPath, voice, rate, opts?.signal, { needTimestamps: true, onProgress: opts?.onProgress });
    if (!d?.ok) return fail();
    if (!d.sentences || d.sentences.length === 0) {
      // 强制走了异步接口还没回时间戳 = 上游没给,只能退回逐句(不是长度问题了)。
      _lastTtsError = '豆包整段合成未返回时间戳(上游未回),改用逐句合成';
      return fail();
    }
    const dur = await probeDuration(outPath);
    return {
      ok: true,
      audioPath: outPath,
      durationSec: dur > 0 ? dur : estimateDuration(clean),
      rawCues: d.sentences,
      chargedTokens: d.tokens,
      costUsd: d.costUsd,
    };
  }
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
