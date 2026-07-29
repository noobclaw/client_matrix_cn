/**
 * repost-pipeline —— 翻译搬运(engine='repost')。
 *
 * 拿一条现成视频(链接或本地文件)→ 抽音 → 后端 ASR 转带时间戳字幕 → 句子重组 →
 * 翻译 → 逐句配音并对齐原时间轴 → 换音轨(可选保留原声垫底)+ 可选烧译文字幕 →
 * 多平台发布。前半段(下载/转写/重组/翻译)是本引擎独有;后半段(发布文案 + 发布)
 * 完全复用现有基建。
 *
 * 音画对齐策略(比"纯顺延"更稳):翻译时按原句秒数给时长预算(超长是「画面完了配音还响」的根因),逐句 TTS 后
 *   · 说得比原句短 → 尾部垫静音到下一句原始起点(硬锚点,自动纠偏回正);
 *   · 溢出 >40% → AI 把这句压缩改写再配一次(源头治超长);
 *   · 仍比原句长 → atempo 压到原时长,封顶 1.3x(听感自然);
 *   · 还不够 → 顺延后续,时间轴向后漂移、靠句间空隙还债。
 * 每句 TTS 先 trim 首尾静音(synthesize 已在内部处理),否则拼接漂移会雪崩。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { runFfmpeg, probeDuration, probeImageSize, isFfmpegAvailable, getFfmpegPath } from './ffmpegRuntime';
import { getYtdlpPath, detectSystemProxy } from './ytdlpRuntime';
import { resolveBgmPath } from './bgm';
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
    '-f', 'bv*+ba/b',
    '--no-playlist', '--retries', '5', '--no-progress',
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

  const runYtdlp = (args: string[]): Promise<{ ok: boolean; err: string }> => new Promise((resolve) => {
    const child = spawn(ytdlp, args, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d) => { err += String(d); });
    child.on('error', (e) => resolve({ ok: false, err: String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, err }));
    signal?.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve({ ok: false, err: 'aborted' }); }, { once: true });
  });

  let r = await runYtdlp(baseArgs);
  // YouTube 签名坎(真机实报):新版 yt-dlp 解 web 端签名需要外部 JS runtime(deno),
  // 用户机器没有 → 「s may be missing / EJS」+ 403。android/ios 播放端不走 JS 签名,
  // 大多数视频可直接下 → 自动换端重试一次,不用装任何东西。
  if (!r.ok && !signal?.aborted && /youtu\.?be/i.test(url) && /403|EJS|signature|s may be missing|nsig/i.test(r.err)) {
    onLog('⚙️ YouTube 签名受限,自动换 android/ios 播放端重试…');
    try { fs.unlinkSync(outPath); } catch { /* 无残留 */ }
    r = await runYtdlp(['--extractor-args', 'youtube:player_client=android,ios', ...baseArgs]);
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
  audioPath: string, durationSec: number, sourceLang: string,
): Promise<{ ok: boolean; segments?: Seg[]; language?: string; tokens?: number; costUsd?: number; error?: string; noSpeech?: boolean }> {
  const token = getNoobClawAuthToken();
  if (!token) return { ok: false, error: '未登录 NoobClaw,无法转写' };
  try {
    // 5xx(502/504 网关错/后端重启抖动)自动重试 2 次(等 10s):multipart 上传大 wav 期间
    // 撞上 pm2 重启窗口是真机实报的 502 场景,重试大多能过;4xx 业务错不重试。
    let resp!: Response;
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append('audio', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
      form.append('durationSec', String(Math.max(0, Math.round(durationSec))));
      if (sourceLang && sourceLang !== 'auto') form.append('language', sourceLang);
      resp = await fetch(`${apiBase()}/api/asr/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(200_000),
      });
      if (resp.status < 500 || attempt >= 2) break;
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
  // v2(真机 bug):抖音/TikTok 的自动字幕【没有标点】——老逻辑先并组再按句末标点切,
  // 一个标点都没有 → 58 条并成 1 句 119s,整片文字糊满屏、一次 TTS 念全文。
  // 现在沿【原始字幕条】滚动累积,三个断句条件任一命中即收句(时间轴用真实条边界,不再按字符比例摊):
  //   ① 本条以句末标点收尾;② 与下一条停顿 >1s;③ 累积口播量到上限(≈8s,无标点字幕的兜底)。
  const unitsOf = (t: string) => Array.from(t.replace(/\s/g, '')).reduce((acc, ch) => acc + (/[\u2e80-\u9fff\uac00-\ud7ff\u3040-\u30ff]/.test(ch) ? 1 : 0.5), 0);
  const out: Seg[] = [];
  let buf = ''; let bStart = -1; let bEnd = 0;
  const flush = () => {
    const t = buf.replace(/\s+/g, ' ').trim();
    if (t && bStart >= 0 && bEnd > bStart) out.push({ start: bStart, end: bEnd, text: t });
    buf = ''; bStart = -1;
  };
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg.text.trim()) continue;
    if (bStart < 0) bStart = seg.start;
    buf += (buf ? ' ' : '') + seg.text;
    bEnd = seg.end;
    const gapNext = i + 1 < segs.length ? segs[i + 1].start - seg.end : 99;
    const endsSent = SENT_END.test(seg.text.trim().slice(-1));
    if (endsSent || gapNext > 1.0 || unitsOf(buf) >= 36) flush();
  }
  flush();
  // 过短碎句(<4 字宽)并入前句,别单独占屏。
  const merged: Seg[] = [];
  for (const s2 of out) {
    if (merged.length > 0 && unitsOf(s2.text) < 4 && s2.start - merged[merged.length - 1].end <= 1.0) {
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
  // 每句长度预算直接算成【具体数字】给模型(比让它自己按语速换算服从得多):
  // CJK ≈ 5 字/秒,其它 ≈ 2.6 词/秒(边界略宽松 —— 超出的部分配音端先自动提速、
  // 再 atempo,轻度压缩只做最后手段,避免译文被砍得太干)。
  const cjkTarget = /中文|日本|日語|한국|Chinese|Japanese|Korean/i.test(targetLangLabel);
  const budgetOf = (s: Seg) => {
    const sec = Math.max(0.6, s.end - s.start);
    // 拉丁语预算 2.6→3.2 词/秒:中文信息密度高,2.6 逼着模型狠删细节(真机反馈英文太简短);
    // 超出部分交给 全局提速≤15% + 画面伸缩≤15% + 逐句提速 消化,极端才精简。
    return Math.max(3, Math.floor(sec * (cjkTarget ? 5 : 3.2)));
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
        const r = await callDeepSeek(system, user, true, 60_000, 'noobclawai-chat', 0.2);
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

// ── 逐句配音 + 对齐:静音填充 + AI 压缩重配 + atempo 微压 + 顺延漂移 ──
async function synthAndAlign(
  segs: Seg[], voice: string, rate: number, assetDir: string, targetTotalDur: number,
  onLog: (m: string) => void, signal?: AbortSignal, onCost?: (tk: number, usd: number) => void,
): Promise<{ voiceTrackPath: string; totalDur: number; cues: TtsCue[] } | null> {
  const pieces: string[] = []; // 按时间轴排好的音频片段(含静音)文件列表
  const cues: TtsCue[] = [];
  let cursor = 0; // 当前已排到的音频末尾(秒)
  const chain = getVoiceFallbacks(voice);

  // ── 全局自适应语速(温和版):先按基准语速把全部句子配一遍测总长,算 r=配音总长/原口播总长。
  //    r>1.08 → 全片统一提速(封顶 +15%);r<0.90 → 全片统一放慢(封顶 -10%,治「译文偏短
  //    →到处垫静音很怪」)。语速全片一致(不再忽快忽慢);首轮结果缓存,r 正常时零额外开销。
  const preTts = new Map<number, { path: string; dur: number }>();
  let preSum = 0, preTarget = 0;
  for (let i = 0; i < segs.length; i++) {
    throwIfAborted(signal);
    const seg = segs[i];
    if (!seg.text.trim()) continue;
    for (const v of chain) {
      const out = path.join(assetDir, `seg_${String(i).padStart(3, '0')}.mp3`);
      const r0 = await synthesize(seg.text, out, v, rate);
      if (r0.synthesized && r0.durationSec > 0) { preTts.set(i, { path: r0.audioPath, dur: r0.durationSec }); break; }
    }
    const got = preTts.get(i);
    if (got) { preSum += got.dur; preTarget += Math.max(0.6, seg.end - seg.start); }
  }
  let globalRate = rate;
  if (preTarget > 3 && preTts.size >= 3) {
    const ratio = preSum / preTarget;
    if (ratio > 1.08) globalRate = Math.min(50, rate + Math.min(15, Math.round((ratio - 1) * 100)));
    else if (ratio < 0.9) globalRate = Math.max(-50, rate - Math.min(10, Math.round((1 - ratio) * 50)));
    if (globalRate !== rate) onLog(`🎚️ 语速自适应:配音/原口播时长比 ${ratio.toFixed(2)} → 全片语速 ${globalRate > 0 ? '+' : ''}${globalRate}%`);
  }

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

    // TTS 本句:全局率=基准 → 直接复用预测速那轮;否则按全局率重配(失败退回首轮结果)。
    let ttsPath = ''; let ttsDur = 0;
    const cached = preTts.get(i);
    if (globalRate === rate && cached) { ttsPath = cached.path; ttsDur = cached.dur; }
    else {
      for (const v of chain) {
        const out = path.join(assetDir, `seg_${String(i).padStart(3, '0')}_g.mp3`);
        const r = await synthesize(seg.text, out, v, globalRate);
        if (r.synthesized && r.durationSec > 0) { ttsPath = r.audioPath; ttsDur = r.durationSec; break; }
      }
      if (!ttsPath && cached) { ttsPath = cached.path; ttsDur = cached.dur; }
    }
    if (!ttsPath) { onLog(`⚠️ 第 ${i + 1} 句配音失败,跳过:${getLastTtsError().slice(0, 60)}`); continue; }

    const targetDur = Math.max(0.6, seg.end - seg.start);
    // 超长治理【先提语速、后动文字】(真机反馈:直接 AI 压缩砍得太狠、译文太干):
    //   ① 溢出 >60% → 同文本按 edge-tts 语速 +25% 重配一次(声库原生提速,比 atempo 自然,零改文字);
    //   ② 提速后仍溢出 >90% → 才轻度 AI 压缩(只压到 1.6×窗口,后面还有 atempo+顺延消化);
    //   ③ 最后 atempo ≤1.3x + 顺延靠句间空隙还债。
    if (ttsDur > targetDur * 1.6 && !signal?.aborted) {
      const outF = path.join(assetDir, `seg_${String(i).padStart(3, '0')}_f.mp3`);
      for (const v of chain) {
        const rf = await synthesize(seg.text, outF, v, Math.min(50, globalRate + 20));
        if (rf.synthesized && rf.durationSec > 0 && rf.durationSec < ttsDur) {
          onLog(`⏩ 第 ${i + 1} 句偏长,自动提速重配(${ttsDur.toFixed(1)}s→${rf.durationSec.toFixed(1)}s)`);
          ttsPath = rf.audioPath; ttsDur = rf.durationSec;
          break;
        }
      }
    }
    if (ttsDur > targetDur * 1.9 && seg.text.trim().length > 6 && !signal?.aborted) {
      const budget = Math.max(6, Math.floor(seg.text.trim().length * ((targetDur * 1.6) / ttsDur)));
      try {
        const r = await callDeepSeek(
          '你是口播精简器。把给定句子用【同一种语言】略微精简:删冗余修饰和口头语,核心信息一个都不能丢,输出不超过 ' + budget + ' 个字符。只返回精简后的句子,不要引号、不要解释。',
          seg.text, false, 30_000, 'noobclawai-chat', 0.3);
        onCost?.(r.tokens || 0, r.costUsd || 0);
        const short = (r.content || '').trim().replace(/^["'「『]|["'」』]$/g, '').trim();
        if (short && short.length < seg.text.trim().length) {
          const out2 = path.join(assetDir, `seg_${String(i).padStart(3, '0')}_c.mp3`);
          for (const v of chain) {
            const r2 = await synthesize(short, out2, v, Math.min(50, globalRate + 20));
            if (r2.synthesized && r2.durationSec > 0 && r2.durationSec < ttsDur) {
              onLog(`✂️ 第 ${i + 1} 句仍超长,轻度精简重配(${ttsDur.toFixed(1)}s→${r2.durationSec.toFixed(1)}s)`);
              ttsPath = r2.audioPath; ttsDur = r2.durationSec; seg.text = short;
              break;
            }
          }
        }
      } catch { /* 精简失败走 atempo+顺延兜底 */ }
    }
    // 溢出压到原时长,真实压缩封顶 1.3x(听感仍自然;再多就只压 1.3、剩余顺延)。
    const tempo = ttsDur > targetDur ? Math.min(1.25, ttsDur / targetDur) : 1;
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
      asr = await transcribeAudio(audioPath, srcDur, String((input as any).repostSourceLang || 'auto'));
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
      const regrouped = regroupSegments(asrSegments);
      tracker.done('transcribe', subsSegs
        ? `✅ 源字幕就绪(免转写费)· ${asrSegments.length} 条 → 重组 ${regrouped.length} 句`
        : `✅ 转写完成 · ${asrSegments.length} 条 → 重组 ${regrouped.length} 句`);

      // ── STEP 3:翻译 ──
      throwIfAborted(signal);
      tracker.start('translate', `🌐 翻译为 ${targetLabel}…`);
      translated = await translateSegments(regrouped, targetLabel, (tk, usd) => { tracker.addTokens(tk, usd); aiCostUsd += usd; }, signal, (m) => tracker.progress(m));
      const nonEmpty = translated.filter((s) => s.text.trim());
      if (nonEmpty.length === 0) { const err = '翻译结果为空'; tracker.fail('translate', err); return { ok: false, error: err }; }
      tracker.done('translate', `✅ 翻译完成 · ${nonEmpty.length} 句`);

      // ── STEP 4:配音 + 对齐 ──
      throwIfAborted(signal);
      tracker.start('voice', '🎤 逐句配音并对齐原时间轴…');
      const voice = input.voice || 'zh-CN-YunjianNeural';
      const rate = typeof input.voiceRate === 'number' ? input.voiceRate : 0;
      aligned = await synthAndAlign(translated, voice, rate, assetDir, srcDur, (m) => tracker.progress(m), signal, (tk, usd) => { tracker.addTokens(tk, usd); aiCostUsd += usd; });
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
      // ── 画面微伸缩(温和版,用户拍板):配音总长超过原片 ≤15% 时,整条画面 setpts 放慢
      //    到正好匹配(15% 以内肉眼基本无感),超出部分仍靠冻结末帧。配音不长则不动画面。
      const vStretch = srcDur > 0 && aligned.totalDur > srcDur + 0.3
        ? Math.min(1.15, aligned.totalDur / srcDur) : 1;
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
            '-filter_complex', `[0:v]${vStretch > 1.005 ? `setpts=PTS*${vStretch.toFixed(4)},` : ''}tpad=stop_mode=clone:stop_duration=${finalDur.toFixed(3)}[v]`,
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
