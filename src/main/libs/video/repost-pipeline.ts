/**
 * repost-pipeline —— 翻译搬运(engine='repost')。
 *
 * 拿一条现成视频(链接或本地文件)→ 抽音 → 后端 ASR 转带时间戳字幕 → 句子重组 →
 * 翻译 → 逐句配音并对齐原时间轴 → 换音轨(可选保留原声垫底)+ 可选烧译文字幕 →
 * 多平台发布。前半段(下载/转写/重组/翻译)是本引擎独有;后半段(发布文案 + 发布)
 * 完全复用现有基建。
 *
 * 音画对齐策略(比"纯顺延"更稳):逐句 TTS 后
 *   · 说得比原句短 → 尾部垫静音到下一句原始起点(硬锚点,自动纠偏回正);
 *   · 说得比原句长、溢出 ≤15% → atempo 微压到原时长(无明显电音);
 *   · 溢出 >15% → 压到 1.15x 上限后顺延后续,时间轴向后漂移、靠句间空隙还债。
 * 每句 TTS 先 trim 首尾静音(synthesize 已在内部处理),否则拼接漂移会雪崩。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { runFfmpeg, probeDuration, probeImageSize, isFfmpegAvailable, getFfmpegPath } from './ffmpegRuntime';
import { getYtdlpPath } from './ytdlpRuntime';
import { getVideoConfig } from './videoConfig';
import { synthesize, getVoiceFallbacks, getLastTtsError, alignSentencesToCues, type TtsCue } from './tts';
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
const REPOST_STEPS = [
  { key: 'source', label: '获取源视频' },
  { key: 'transcribe', label: '语音转写' },
  { key: 'translate', label: '翻译文案' },
  { key: 'voice', label: '配音并对齐' },
  { key: 'compose', label: '合成成片' },
  { key: 'publish', label: '发布到各大平台' },
];

// ASR 返回的一条字幕(时间戳单位=秒)。
interface Seg { start: number; end: number; text: string }

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

// ── 源视频:本地文件直接用;URL 走 yt-dlp 通用下载(YouTube/TikTok/B站等上千站点)──
async function resolveSourceVideo(
  input: VideoCreationInput, destDir: string, onLog: (m: string) => void, signal?: AbortSignal,
): Promise<{ ok: boolean; videoPath?: string; error?: string }> {
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
  const ok = await new Promise<boolean>((resolve) => {
    // 优先 mp4(h264/aac,后续换音轨可 -c:v copy);合并交给 yt-dlp/ffmpeg。
    // ⚠️ 别用 ext=mp4 限制:个别站(TikTok)的"最佳 mp4"可能是【纯视频无音轨】,下下来抽音必挂。
    //   bv*+ba/b = 最佳视频+最佳音频合并,再不行退最佳单流(通常也带音轨)→ 保证有声音。
    const args = [
      '-f', 'bv*+ba/b',
      '--no-playlist', '--retries', '5', '--no-progress',
      '--merge-output-format', 'mp4',
      '-o', outPath, url,
    ];
    // ⚠️ 关键:显式告诉 yt-dlp 打包 ffmpeg 的位置。用户机器 ffmpeg 不在 PATH,yt-dlp 找不到
    //   就放弃合并、退回下"单个最佳格式" —— TikTok 的单格式可能是纯视频流(无音轨),
    //   这正是「抽取音轨失败」的根因。传了 location 合并必然可用。
    try { const ff = getFfmpegPath(); if (ff && ff !== 'ffmpeg') args.push('--ffmpeg-location', ff); } catch { /* PATH 上有就不传 */ }
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) args.push('--proxy', proxy);
    const child = spawn(ytdlp, args, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d) => { err += String(d); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => { if (code !== 0) onLog(`yt-dlp 退出码 ${code}${err ? ' · ' + err.slice(-160) : ''}`); resolve(code === 0); });
    signal?.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(false); }, { once: true });
  });
  if (!ok || !fs.existsSync(outPath)) {
    return { ok: false, error: '源视频下载失败(该链接可能不受支持或需要登录/VPN)。可改用本地文件。' };
  }
  return { ok: true, videoPath: outPath };
}

// ── 后端 ASR:上传音轨 → 带时间戳字幕 ──
async function transcribeAudio(
  audioPath: string, durationSec: number, sourceLang: string,
): Promise<{ ok: boolean; segments?: Seg[]; language?: string; tokens?: number; costUsd?: number; error?: string; noSpeech?: boolean }> {
  const token = getNoobClawAuthToken();
  if (!token) return { ok: false, error: '未登录 NoobClaw,无法转写' };
  try {
    const form = new FormData();
    form.append('audio', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
    form.append('durationSec', String(Math.max(0, Math.round(durationSec))));
    if (sourceLang && sourceLang !== 'auto') form.append('language', sourceLang);
    const resp = await fetch(`${apiBase()}/api/asr/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(200_000),
    });
    if (!resp.ok) {
      const j: any = await resp.json().catch(() => ({}));
      if (resp.status === 402) return { ok: false, error: '积分余额不足,无法转写(请充值后重试)' };
      // 422=未识别到人声(纯音乐/静音)。不算错误 → 让 pipeline 走「原片直发保留原声」兜底。
      if (resp.status === 422) return { ok: true, segments: [], noSpeech: true, tokens: 0, costUsd: 0 };
      if (resp.status === 503) return { ok: false, error: '转写服务未配置(请联系管理员填 ASR key)' };
      return { ok: false, error: `转写失败:${j?.message || j?.error || resp.status}` };
    }
    const j: any = await resp.json();
    const segs: Seg[] = (Array.isArray(j?.segments) ? j.segments : [])
      .map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text || '').trim() }))
      .filter((s: Seg) => s.text && s.end > s.start);
    if (segs.length === 0) return { ok: true, segments: [], noSpeech: true, tokens: 0, costUsd: 0 };
    // ASR 端点已按真实时长扣了【一份】;返回 costUsd 供 pipeline 累计 →「token 消耗翻倍」时再扣一份。
    return { ok: true, segments: segs, language: String(j?.language || '').trim(), tokens: Number(j?.chargedTokens) || 0, costUsd: Number(j?.costUsd) || 0 };
  } catch (e: any) {
    return { ok: false, error: `转写请求异常:${String(e?.message || e).slice(0, 120)}` };
  }
}

// ── 句子重组:gap≤1s 合并 → 句末标点重切 → 时间按字符比例回摊 ──
// (借鉴 Voice-Pro 的"先合完整句再翻/配音"思路,自研实现。翻译质量与配音韵律都更好。)
const SENT_END = /[。！？.!?…]/;
function regroupSegments(segs: Seg[]): Seg[] {
  if (segs.length === 0) return [];
  // 1) 相邻 gap ≤1s 归一组
  const groups: Seg[][] = [];
  let cur: Seg[] = [segs[0]];
  for (let i = 1; i < segs.length; i++) {
    const gap = segs[i].start - segs[i - 1].end;
    if (gap <= 1.0) cur.push(segs[i]);
    else { groups.push(cur); cur = [segs[i]]; }
  }
  groups.push(cur);

  const out: Seg[] = [];
  for (const g of groups) {
    const gStart = g[0].start;
    const gEnd = g[g.length - 1].end;
    const gDur = Math.max(0.5, gEnd - gStart);
    const joined = g.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    if (!joined) continue;
    // 2) 按句末标点切;标点跟随前句。
    const sents: string[] = [];
    let buf = '';
    for (const ch of joined) {
      buf += ch;
      if (SENT_END.test(ch)) { sents.push(buf.trim()); buf = ''; }
    }
    if (buf.trim()) sents.push(buf.trim());
    // 3) 过短不完整句并入上一句(<8 CJK 字符视为碎句)。
    const merged: string[] = [];
    for (const s of sents) {
      const isShort = s.replace(/\s/g, '').length < 8 && !SENT_END.test(s.slice(-1));
      if (isShort && merged.length > 0) merged[merged.length - 1] += s;
      else merged.push(s);
    }
    const finalSents = merged.length > 0 ? merged : [joined];
    // 4) 时间按字符比例回摊(起点接上一句终点,夹在组边界内)。
    const totalChars = finalSents.reduce((a, s) => a + Math.max(1, s.replace(/\s/g, '').length), 0);
    let cursor = gStart;
    for (const s of finalSents) {
      const share = Math.max(1, s.replace(/\s/g, '').length) / totalChars;
      const dur = Math.max(0.8, gDur * share);
      const start = cursor;
      const end = Math.min(gEnd, start + dur);
      out.push({ start, end: end > start ? end : start + 0.8, text: s });
      cursor = end;
    }
  }
  return out;
}

// ── 翻译:批量调 DeepSeek,协议壳强制一一对应,不合并不拆分 ──
async function translateSegments(
  segs: Seg[], targetLangLabel: string, onCost: (tk: number, usd: number) => void, signal?: AbortSignal,
): Promise<Seg[]> {
  const BATCH = 20;
  const system = [
    '你是字幕翻译器(json)。把输入 texts 数组每一项翻译成【' + targetLangLabel + '】。',
    '# 硬规则(违反任一 = 失败):',
    '1. 必须与输入数组一一对应:第 N 条输入只翻译成第 N 条输出。禁止跨条目借用、合并、拆分、增删条目。',
    '2. 若某条源文本本身是不完整短语/半句/续句,译文也保持同样边界,不要擅自补成完整句。',
    '3. 等价翻译,不解释、不扩写。数字、代码、URL、@handle、无公认译法的专有名词可保留原文。',
    '4. 删除口播里的导流/社媒/订阅引导(如 like and subscribe / 关注我)——这类整条译成空字符串 "".',
    '# 只返回 JSON:{ "translations": ["译文1", "译文2", ...] },数组长度必须等于输入长度。',
  ].join('\n');

  const out: Seg[] = [];
  for (let i = 0; i < segs.length; i += BATCH) {
    throwIfAborted(signal);
    const batch = segs.slice(i, i + BATCH);
    const user = '翻译下面 ' + batch.length + ' 条:\n' + JSON.stringify({ texts: batch.map((s) => s.text) });
    let translations: string[] | null = null;
    try {
      const r = await callDeepSeek(system, user, true, 60_000, 'noobclawai-chat', 0.2);
      onCost(r.tokens || 0, r.costUsd || 0);
      const m = r.content.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : JSON.parse(r.content);
      if (Array.isArray(parsed?.translations)) translations = parsed.translations.map((x: any) => String(x ?? ''));
    } catch { /* 单批失败 → 保原文,不炸整任务 */ }
    for (let k = 0; k < batch.length; k++) {
      const t = translations && translations.length === batch.length ? translations[k].trim() : batch[k].text;
      out.push({ start: batch[k].start, end: batch[k].end, text: t });
    }
  }
  return out;
}

// ── 逐句配音 + 对齐:静音填充 + atempo 微压 + 顺延漂移 ──
async function synthAndAlign(
  segs: Seg[], voice: string, rate: number, assetDir: string, targetTotalDur: number,
  onLog: (m: string) => void, signal?: AbortSignal,
): Promise<{ voiceTrackPath: string; totalDur: number; cues: TtsCue[] } | null> {
  const pieces: string[] = []; // 按时间轴排好的音频片段(含静音)文件列表
  const cues: TtsCue[] = [];
  let cursor = 0; // 当前已排到的音频末尾(秒)
  const chain = getVoiceFallbacks(voice);

  const makeSilence = async (dur: number, out: string): Promise<boolean> => {
    if (dur <= 0.02) return false;
    const r = await runFfmpeg(['-y', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo`, '-t', dur.toFixed(3), '-c:a', 'aac', '-b:a', '128k', out], { timeoutMs: 30_000, signal });
    return r.ok && fs.existsSync(out);
  };

  for (let i = 0; i < segs.length; i++) {
    throwIfAborted(signal);
    const seg = segs[i];
    if (!seg.text.trim()) continue; // 被翻成空(导流句)→ 跳过,原位留空

    // 起点静音:补到本句原始 start(硬锚点纠偏);若已越过 start 则不补(顺延)。
    if (seg.start > cursor) {
      const sil = path.join(assetDir, `sil_${i}.m4a`);
      if (await makeSilence(seg.start - cursor, sil)) { pieces.push(sil); cursor = seg.start; }
    }
    const placeStart = Math.max(cursor, seg.start);

    // TTS 本句(带 voice fallback)。
    let ttsPath = ''; let ttsDur = 0;
    for (const v of chain) {
      const out = path.join(assetDir, `seg_${String(i).padStart(3, '0')}.mp3`);
      const r = await synthesize(seg.text, out, v, rate);
      if (r.synthesized && r.durationSec > 0) { ttsPath = r.audioPath; ttsDur = r.durationSec; break; }
    }
    if (!ttsPath) { onLog(`⚠️ 第 ${i + 1} 句配音失败,跳过:${getLastTtsError().slice(0, 60)}`); continue; }

    const targetDur = Math.max(0.6, seg.end - seg.start);
    // 溢出压到原时长,真实压缩封顶 1.15x(再多就只压 1.15、剩余顺延)。
    const tempo = ttsDur > targetDur ? Math.min(1.15, ttsDur / targetDur) : 1;
    // ⚠️ 必须把每句【归一化成 aac 48k 立体声】:TTS 出的是 mp3、静音片段是 aac,格式不统一
    //    concat demuxer -c copy 会失败。这一步同时做 atempo(需要时),一趟 ffmpeg 搞定。
    const norm = path.join(assetDir, `seg_${String(i).padStart(3, '0')}_n.m4a`);
    const filt = tempo > 1.005 ? `atempo=${tempo.toFixed(3)}` : 'anull';
    const nr = await runFfmpeg(['-y', '-i', ttsPath, '-filter:a', filt, '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', norm], { timeoutMs: 30_000, signal });
    if (!nr.ok || !fs.existsSync(norm)) { onLog(`⚠️ 第 ${i + 1} 句音频归一化失败,跳过`); continue; }
    const effDur = tempo > 1.005 ? ttsDur / tempo : ttsDur;
    pieces.push(norm);
    // 记字幕 cue(最终时间轴)。
    cues.push({ text: seg.text, start: placeStart, end: placeStart + effDur });
    cursor = placeStart + effDur;

    // 尾部补静音到下一句原始 start(说得短时保持后续同步)。
    const nextStart = i + 1 < segs.length ? segs[i + 1].start : cursor;
    if (nextStart > cursor) {
      const sil = path.join(assetDir, `siltail_${i}.m4a`);
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
  const fontPx = Math.max(18, Math.round(H * (fontSetting / 700))); // 20 → 1920高≈55px / 1080高≈31px
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

    // 抽音轨(用于 ASR)。抽成 WAV(pcm_s16le)—— 任何 ffmpeg 都自带 pcm 编码器(不像 libmp3lame
    //   可能没编进静态包,Mac 版尤其);火山/whisper 都收 WAV。16k 单声道正是火山要的格式、体积小。
    throwIfAborted(signal);
    tracker.start('transcribe', '🎧 抽取音轨…');
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
    const srcDur = await probeDuration(sourceVideoPath).catch(() => 0);

    // ── STEP 2:转写 ──
    tracker.progress('☁️ 上传音轨转写(按音频分钟计费)…');
    const asr = await transcribeAudio(audioPath, srcDur, String((input as any).repostSourceLang || 'auto'));
    if (!asr.ok) { const err = asr.error || '转写失败'; tracker.fail('transcribe', err); return { ok: false, error: err }; }
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
      const regrouped = regroupSegments(asrSegments);
      tracker.done('transcribe', `✅ 转写完成 · ${asrSegments.length} 条 → 重组 ${regrouped.length} 句`);

      // ── STEP 3:翻译 ──
      throwIfAborted(signal);
      tracker.start('translate', `🌐 翻译为 ${targetLabel}…`);
      translated = await translateSegments(regrouped, targetLabel, (tk, usd) => { tracker.addTokens(tk, usd); aiCostUsd += usd; }, signal);
      const nonEmpty = translated.filter((s) => s.text.trim());
      if (nonEmpty.length === 0) { const err = '翻译结果为空'; tracker.fail('translate', err); return { ok: false, error: err }; }
      tracker.done('translate', `✅ 翻译完成 · ${nonEmpty.length} 句`);

      // ── STEP 4:配音 + 对齐 ──
      throwIfAborted(signal);
      tracker.start('voice', '🎤 逐句配音并对齐原时间轴…');
      const voice = input.voice || 'zh-CN-YunjianNeural';
      const rate = typeof input.voiceRate === 'number' ? input.voiceRate : 0;
      aligned = await synthAndAlign(translated, voice, rate, assetDir, srcDur, (m) => tracker.progress(m), signal);
      if (!aligned) { const err = '配音失败(edge-tts 不可用或全部句子合成失败)'; tracker.fail('voice', err); return { ok: false, error: err }; }
      tracker.done('voice', `✅ 配音就绪 · ${aligned.cues.length} 句 · 共 ${aligned.totalDur.toFixed(1)}s`);
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
        const r2 = await runFfmpeg(['-y', '-i', sourceVideoPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outPath], { timeoutMs: 600_000, signal });
        if (!r2.ok || !fs.existsSync(outPath)) { const err = '合成失败(原片直发出错)'; tracker.fail('compose', err); return { ok: false, error: err }; }
      }
      tracker.done('compose', `📦 原片直发就绪(保留原声)· 📂 ${destDir}`);
    } else {
      // 有配音:组装最终音轨(配音为主;可选原声压低垫底保 BGM/音效)+ 换音轨(可选烧字幕)。
      let finalAudio = aligned.voiceTrackPath;
      if ((input as any).repostKeepBgm) {
        const mixed = path.join(assetDir, 'final_audio.m4a');
        // ⚠️ 原声垫底用【源视频音轨】,不用上面抽的 wav(那是 16k 单声道给 ASR 用的,做垫底会难听)。
        const r = await runFfmpeg([
          '-y', '-i', aligned.voiceTrackPath, '-i', sourceVideoPath,
          '-filter_complex', '[1:a]volume=0.12[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]',
          '-map', '[a]', '-c:a', 'aac', '-b:a', '160k', mixed,
        ], { timeoutMs: 120_000, signal });
        if (r.ok && fs.existsSync(mixed)) finalAudio = mixed;
        else tracker.progress('⚠️ 原声混音失败,改用纯配音');
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
        const vf = `[0:v]tpad=stop_mode=clone:stop_duration=${finalDur.toFixed(3)}[vext];`
          + `[vext]split[vb][vm];[vm]crop=iw:ih*0.16:0:ih*0.84,boxblur=20:2[vmb];`
          + `[vb][vmb]overlay=0:H*0.84[vbg];[vbg]subtitles='${escSubPath(assPath)}'[v]`;
        const r = await runFfmpeg([
          '-y', '-i', sourceVideoPath, '-i', finalAudio,
          '-filter_complex', vf,
          '-map', '[v]', '-map', '1:a:0',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
          '-c:a', 'aac', '-b:a', '160k', '-t', finalDur.toFixed(3), '-movflags', '+faststart', outPath,
        ], { timeoutMs: 600_000, signal });
        if (!r.ok || !fs.existsSync(outPath)) { const err = '合成失败(字幕烧录/编码出错)'; tracker.fail('compose', err); return { ok: false, error: err }; }
      } else {
        const finalDur = aligned.totalDur;
        // 配音比源视频长 → 必须冻结末帧延长画面(copy 无法延长,得重编码);否则「音频没播完画面停了」。
        const needExtend = !(srcDur > 0) || finalDur > srcDur + 0.3;
        if (needExtend) {
          const r = await runFfmpeg([
            '-y', '-i', sourceVideoPath, '-i', finalAudio,
            '-filter_complex', `[0:v]tpad=stop_mode=clone:stop_duration=${finalDur.toFixed(3)}[v]`,
            '-map', '[v]', '-map', '1:a:0',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac', '-b:a', '160k', '-t', finalDur.toFixed(3), '-movflags', '+faststart', outPath,
          ], { timeoutMs: 600_000, signal });
          if (!r.ok || !fs.existsSync(outPath)) { const err = '合成失败(换音轨/延长画面出错)'; tracker.fail('compose', err); return { ok: false, error: err }; }
        } else {
          // 配音不长于视频:换音轨零转码(音频已 apad 到视频长,-shortest 对齐)。
          const r = await runFfmpeg([
            '-y', '-i', sourceVideoPath, '-i', finalAudio,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', outPath,
          ], { timeoutMs: 300_000, signal });
          if (!r.ok || !fs.existsSync(outPath)) { const err = '合成失败(换音轨出错)'; tracker.fail('compose', err); return { ok: false, error: err }; }
        }
      }
      tracker.done('compose', `📦 成片就绪 · 📂 ${destDir}`);
    }
    refundOnExit = false; // 成片已产出 → 费用照收(发布失败不退,与其它引擎一致)

    // ── STEP 6:发布(复用现有)──
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
    tracker.fail('compose', err.slice(0, 300));
    return { ok: false, error: err.slice(0, 300) };
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
