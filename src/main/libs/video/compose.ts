/**
 * compose — 把「画面 + 配音 + 字幕」合成成一条 mp4。
 *
 * 升级到 MoneyPrinterTurbo 风格的「多片段换镜」:
 *   1. 每个分镜先出一段【无声背景】scene_bg_NNN.mp4 —— 时长 = 该句配音时长,但画面
 *      由【多段素材】拼成(每段封顶 maxClipSeconds 秒),所以画面一直在换,不再「一句话
 *      盯着一个空镜几秒」。素材不够就循环复用。
 *   2. 所有 scene_bg concat 成 master_bg(无声);所有配音 concat 成 master_audio。
 *   3. 字幕:优先用上层传入的精确 cue(edge-tts 词边界),没有则按各镜已知时长估算;
 *      再把全部 cue 用【一遍 drawtext】烧到 master_bg 上(font/textfile 用相对名,
 *      绕开 Windows 盘符冒号转义),最后 mux 上 master_audio。字幕关 → 直接 mux。
 *   4. 可选 BGM 低音量混入。
 *
 * 字体:优先用打包内置的思源黑体(Source Han Sans SC Bold,开源 SIL OFL,商用 OK),
 * 保证任何用户机器上中文字幕都不会变成「豆腐块」;内置找不到才退回系统字体。
 *
 * 画幅(W×H)由上层按 aspect 传入(9:16 / 16:9 / 1:1),不再写死竖屏。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runFfmpeg, probeDuration, probeImageSize } from './ffmpegRuntime';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';

const FPS = 30;
/** 每段素材最长秒数(换镜节奏);上层不传时的默认值。 */
const DEFAULT_MAX_CLIP_SEC = 4;

/**
 * 成片首尾留白(秒):开头停一拍再起旁白、结尾留一拍再收,避免「一上来就开口 / 最后一字
 * 戛然而止」的生硬感(尤其严格逐字模式下配音正好卡满全片时)。画面用 tpad 冻结首/尾帧
 * 撑住,音频用 adelay 延后起播 + apad 补尾;开了 BGM 时音乐会自然盖住这两段留白。
 */
const DEFAULT_LEAD_IN_SEC = 0.4;
const DEFAULT_TAIL_OUT_SEC = 2.0;

/** 内置 CJK 字体文件名(随包 bundle 在 resources/fonts/ 下)。 */
const BUNDLED_FONT_FILE = 'SourceHanSansSC-Bold.otf';

/**
 * 内置字体可能落地的目录集合 —— 套用 ffmpegRuntime.bundledBinDirs 的多根探测,
 * 覆盖 Windows(<install>/resources/fonts)/ macOS(Contents/Resources[/resources]/fonts)
 * / 开发态(client/resources/fonts)。
 */
function bundledFontDirs(): string[] {
  const dirs: string[] = [];
  const pushRoot = (root: string) => dirs.push(path.join(root, 'fonts'));
  if (isPackaged()) {
    const res = getResourcesPath();
    const exeDir = path.dirname(process.execPath);
    pushRoot(res);
    pushRoot(path.join(res, 'resources'));
    pushRoot(path.join(exeDir, 'resources'));
    pushRoot(path.join(exeDir, '..', 'Resources'));
    pushRoot(path.join(exeDir, '..', 'Resources', 'resources'));
  } else {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
    pushRoot(path.join(projectRoot, 'resources'));
  }
  // Dev / non-CI fallback: 同 bgm.bundledBgmDirs。sidecar 二进制里 isPackaged() 恒为
  // true,上面 packaged 分支在 `tauri:dev` 下永远找不到随包字体(那些只由 CI-only 的
  // prepare-tauri-resources.js 拷进去)。所以无条件再探一遍源码里的 client/resources/fonts:
  // 从本文件和 cwd 往上走。真实安装包里这些目录不存在,existsSync() 自然跳过。
  for (const base of [
    path.resolve(__dirname, '..', '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..'),
    process.cwd(),
    path.join(process.cwd(), 'client'),
  ]) {
    pushRoot(path.join(base, 'resources'));
  }
  pushRoot(path.join(getUserDataPath(), 'runtimes'));
  return dirs;
}

/** 解析内置思源黑体路径;找不到返回 null(退回系统字体)。thread-pipeline 顶部抬头 drawtext 也用。 */
export function resolveBundledFont(): string | null {
  for (const dir of bundledFontDirs()) {
    const p = path.join(dir, BUNDLED_FONT_FILE);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 按用户选中的字体文件名解析 resources/fonts/ 下的字体路径。
 * 用 path.basename 强制只取文件名(防目录穿越),且只接受 .otf/.ttf/.ttc;
 * 找不到 / 非法 → 返回 null,由调用方退回默认思源黑体。
 */
function resolveBundledFontByName(name?: string): string | null {
  const raw = (name || '').trim();
  if (!raw) return null;
  const base = path.basename(raw);
  if (!/\.(otf|ttf|ttc)$/i.test(base)) return null;
  for (const dir of bundledFontDirs()) {
    const p = path.join(dir, base);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 找一个系统里的中文字体给 drawtext 用(内置字体缺失时的兜底)。 */
function resolveCjkFont(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        'C:/Windows/Fonts/msyh.ttc',
        'C:/Windows/Fonts/msyhbd.ttc',
        'C:/Windows/Fonts/simhei.ttf',
        'C:/Windows/Fonts/simsun.ttc',
        'C:/Windows/Fonts/Deng.ttf',
      ]
    : process.platform === 'darwin'
      ? [
          '/System/Library/Fonts/PingFang.ttc',
          '/System/Library/Fonts/STHeiti Medium.ttc',
          '/Library/Fonts/Arial Unicode.ttf',
        ]
      : [
          '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 按字幕文种挑字体:内置的是【中文】字体(思源黑体 SC / 得意黑,不含韩文 Hangul、日文假名)——
 * 韩/日字幕用它会渲染成豆腐块(用户实测韩语字幕全乱码)。含 Hangul → 韩文系统字体;含假名 →
 * 日文系统字体(也覆盖汉字)。纯中文/拉丁 → 返回 null,照用内置中文字体(不影响原有行为)。
 * 找不到对应系统字体 → null(退回内置,至少中文/拉丁不豆腐)。真机上 macOS/Windows 都自带这些。
 */
function resolveScriptFont(sample: string): string | null {
  const s = sample || '';
  const hasHangul = /[가-힣ᄀ-ᇿ㄰-㆏]/.test(s);
  const hasKana = /[぀-ゟ゠-ヿ]/.test(s);
  if (!hasHangul && !hasKana) return null;
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const cands: string[] = [];
  if (hasHangul) {
    if (isMac) cands.push('/System/Library/Fonts/AppleSDGothicNeo.ttc', '/System/Library/Fonts/Supplemental/AppleGothic.ttf');
    else if (isWin) cands.push('C:/Windows/Fonts/malgunbd.ttf', 'C:/Windows/Fonts/malgun.ttf', 'C:/Windows/Fonts/gulim.ttc');
  }
  if (hasKana) {
    if (isMac) cands.push('/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc', '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc');
    else if (isWin) cands.push('C:/Windows/Fonts/YuGothB.ttc', 'C:/Windows/Fonts/YuGothM.ttc', 'C:/Windows/Fonts/meiryob.ttc', 'C:/Windows/Fonts/msgothic.ttc');
  }
  // 通用兜底(全 CJK+KR+JP):老 macOS 的 Arial Unicode / Linux Noto CJK。
  if (isMac) cands.push('/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf');
  else if (!isWin) cands.push('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc');
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

const isWideChar = (ch: string) => /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\uff00-\uffef]/.test(ch);
const charUnit = (ch: string) => (isWideChar(ch) ? 1 : 0.5);
/** 文本的【可视宽度】:中文/全角=1,拉丁/数字/空格=0.5。字符数不能直接当宽度用。 */
function widthUnits(s: string): number {
  let u = 0;
  for (const ch of Array.from(s)) u += charUnit(ch);
  return u;
}

/**
 * 按【可视宽度】把文本切成若干段,**优先在空格处断词**。
 *
 * ⚠️【真机 bug】:原来 splitPhrases 里是 `for (i += PHRASE_MAX) r.slice(i, i+PHRASE_MAX)` ——
 *   纯按字符数硬切、完全不看空格。"Far from being nothing" 共 22 字符 > 20,被切成
 *   "Far from being nothi" + "ng",烧进画面就是半个单词(用户实测截图)。
 *   翻译搬运没这毛病,是因为它走 ASS 的 wrapAssLine,那条认空格。
 *
 * 只有【整段没有空格】(中文,或一个超长英文单词)时才硬切 —— 那时也没别的办法。
 */
function cutByWidth(text: string, maxUnits: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const out: string[] = [];
  let cur = ''; let units = 0; let lastSpace = -1;
  for (const ch of Array.from(clean)) {
    cur += ch; units += charUnit(ch);
    if (ch === ' ') lastSpace = cur.length;
    if (units >= maxUnits) {
      const cut = (lastSpace > 0 && lastSpace < cur.length) ? lastSpace : cur.length;
      const piece = cur.slice(0, cut).trim();
      if (piece) out.push(piece);
      cur = cur.slice(cut);
      units = widthUnits(cur);
      lastSpace = cur.lastIndexOf(' ') >= 0 ? cur.lastIndexOf(' ') + 1 : -1;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 把一句话按【可视宽度】折行:中文=1 字宽、拉丁/数字/空格≈0.5 字宽,英文优先在空格处断词
 *  (真机反馈:英文每个字母被当全宽算 → 行只用一半宽还从单词中间劈开)。 */
function wrapSubtitle(text: string, maxPerLine = 14): string {
  return cutByWidth(text, maxPerLine).slice(0, 3).join('\n'); // 最多 3 行,别糊满屏
}

/**
 * 把整句切成「短语」做逐句渐进字幕(无 Whisper 词边界时的兜底)。
 * 先按标点切,过长的再按 ~PHRASE_MAX 字硬切。
 */
// 单屏字幕目标字数上限。原来按标点切的短句【各自成屏】→ 每屏字太少;现在贪心【合并相邻短句】
// 到接近这个上限,每屏显示更多字(wrapSubtitle 再折成最多 3 行)。调大 = 每屏更多字。
const PHRASE_MAX = 20;
function splitPhrases(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const rough = clean.split(/[,，、;；:：]+/).map((s) => s.trim()).filter(Boolean);
  const phrases: string[] = [];
  let buf = '';
  // ⚠️ 三处长度判断【必须按可视宽度算,不能按字符数】。PHRASE_MAX=20 的本意是「20 个中文字
  //    那么宽」,而 20 个英文字符只有 3~4 个单词、连半屏都不到 —— 英文因此几乎每段都触发
  //    下面那条超长分支,再被硬切断词。widthUnits 把拉丁按 0.5 计,20 单位 ≈ 40 个英文字符。
  for (const r of rough) {
    if (widthUnits(r) > PHRASE_MAX) {
      // 单段本身超长:先收掉缓冲,再按可视宽度切(cutByWidth 会优先在空格处断词)
      if (buf) { phrases.push(buf); buf = ''; }
      for (const piece of cutByWidth(r, PHRASE_MAX)) phrases.push(piece);
    } else if (!buf) {
      buf = r;
    } else if (widthUnits(buf) + widthUnits(r) <= PHRASE_MAX) {
      // 合并相邻短句到同一屏。中文紧凑不加分隔;拉丁必须补空格 ——
      //   rough 是按逗号切的,逗号已被丢掉,直接 += 会把 "nothing" + "it" 粘成 "nothingit"。
      const needSpace = !isWideChar(buf.slice(-1)) && !isWideChar(r[0] || '');
      buf += (needSpace ? ' ' : '') + r;
    } else {
      phrases.push(buf);
      buf = r;
    }
  }
  if (buf) phrases.push(buf);
  return phrases;
}

export interface SubtitleCue {
  text: string;
  start: number;
  end: number;
}

/** 按字数比例把 [startSec,endSec] 这段时间分配给各短语,返回绝对时间 cue。 */
function allocateCues(phrases: string[], startSec: number, endSec: number): SubtitleCue[] {
  const span = Math.max(0.4, endSec - startSec);
  const totalChars = phrases.reduce((n, p) => n + p.length, 0) || 1;
  const cues: SubtitleCue[] = [];
  let acc = 0;
  for (let i = 0; i < phrases.length; i++) {
    const s = startSec + (acc / totalChars) * span;
    acc += phrases[i].length;
    const e = i === phrases.length - 1 ? endSec : startSec + (acc / totalChars) * span;
    cues.push({ text: phrases[i], start: s, end: e });
  }
  return cues;
}

// 抖音混剪模糊带高度(占画高)。位置不固定 —— 跟着字幕走、包裹字幕(见 subtitleCenterRatio + maskBottomBar)。
const REMIX_MASK_H = 0.18;

export interface SubtitleStyle {
  /** 是否烧字幕。false = 完全不烧。 */
  enabled: boolean;
  /** 字号(在成片原始分辨率下的像素)。 */
  fontSize: number;
  /** 位置。 */
  position: 'top' | 'center' | 'lower' | 'bottom';
  /** 字幕文字颜色(#RRGGBB 或颜色名)。空 = 白色。 */
  color?: string;
  /** 描边颜色(#RRGGBB 或颜色名)。空 = 不描边(沿用半透明黑底盒)。 */
  strokeColor?: string;
  /** 字幕字体文件名(resources/fonts/ 下,如 SmileySans-Oblique.ttf)。空 = 默认思源黑体。 */
  fontFile?: string;
}

/** 把 #RRGGBB / RRGGBB / 颜色名归一成 ffmpeg drawtext 认的写法(#RRGGBB → 0xRRGGBB)。 */
function normalizeColor(c: string | undefined, fallback: string): string {
  const v = (c || '').trim();
  if (!v) return fallback;
  const hex = v.replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `0x${hex.toUpperCase()}`;
  // 已经是颜色名或 0x 前缀,原样用
  return v;
}

export interface SceneSpec {
  /**
   * 该镜的多段画面视频素材(绝对路径,按顺序拼,每段封顶 maxClipSeconds)。
   * 优先于 imagePath。素材不够该镜时长就循环复用。
   */
  clips?: string[];
  /** 单段画面视频(兼容老调用;clips 为空时用)。 */
  videoPath?: string;
  /** 画面图片绝对路径;clips/videoPath 都空时用;再为空 = 纯色文字卡。 */
  imagePath?: string;
  /** 该镜配音绝对路径(mp3)。纯画面模式(narration=false)可不传。 */
  audioPath?: string;
  /** 时长(秒)。 */
  durationSec: number;
  /** 字幕文案(原句),用于无 Whisper 时估算 cue。 */
  subtitle: string;
  /**
   * 盖住素材自带的【底部烧死字幕】(抖音混剪用):在画面底部叠一条不透明黑块,
   * 把原视频烧进去的字幕遮掉,我们自己的字幕再画在上面。默认 false(图片/普通素材不需要)。
   */
  maskBottomBar?: boolean;
}

/** 把绝对路径转成 concat list 里的安全行。 */
function concatLine(p: string): string {
  return `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

/** 多段视频背景:切 N 段(每段 ≤maxClip)cover-crop 拼接。失败抛错(由上层降级)。 */
async function renderClipsBg(
  workDir: string, out: string, clips: string[], dur: number, W: number, H: number, maxClip: number,
  maskBottomBar = false, subtitlePos: SubtitleStyle['position'] = 'lower',
): Promise<void> {
  const segCount = Math.max(1, Math.min(8, Math.ceil(dur / Math.max(1, maxClip))));
  const segDur = dur / segCount;
  // 单片段(AI 自动成片每镜=一个≈该镜时长的片段)时:各段要从片段内【不同位置】往后截
  // (0→segDur→2segDur…)连续播,而不是每段都从第 0 秒截 → 否则同一段前几秒被重复播
  // (这就是"连着重复、不流畅"的根)。多片段(stock 一镜多素材)保持轮换、各段从 0 截。
  const single = clips.length === 1;
  const args: string[] = ['-y'];
  const filters: string[] = [];
  for (let s = 0; s < segCount; s++) {
    const clip = single ? clips[0] : clips[s % clips.length];
    // -stream_loop -1 保证够长(片段比镜短时兜底);单片段够长时各段落在片段内不同区间,不重复。
    args.push('-stream_loop', '-1', '-i', clip);
    const trimStart = single ? s * segDur : 0;
    filters.push(
      `[${s}:v]trim=${trimStart.toFixed(3)}:${(trimStart + segDur).toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `fps=${FPS},setsar=1[v${s}]`,
    );
  }
  const concatInputs = Array.from({ length: segCount }, (_, s) => `[v${s}]`).join('');
  // 抖音混剪:concat 后对原字幕带做局部高斯模糊,把素材烧死的原字幕糊掉(主流搬运号做法 ——
  //   不通栏、不挡画面,比纯黑块自然)。模糊带【跟着字幕走】:中心 = 字幕中心(subtitleCenterRatio),
  //   高度固定包裹字幕,字幕在主合成 drawtext 画在带的正中央。
  let fc: string;
  if (maskBottomBar) {
    const maskH = Math.round(H * REMIX_MASK_H);
    const maskCenter = Math.round(H * subtitleCenterRatio(subtitlePos));
    const maskY = Math.max(0, Math.min(maskCenter - Math.round(maskH / 2), H - maskH));
    fc = `${filters.join(';')};${concatInputs}concat=n=${segCount}:v=1:a=0[vcat];`
      + `[vcat]split[vbase][vm];[vm]crop=${W}:${maskH}:0:${maskY},boxblur=24:2[vmb];`
      + `[vbase][vmb]overlay=0:${maskY},format=yuv420p[v]`;
  } else {
    fc = `${filters.join(';')};${concatInputs}concat=n=${segCount}:v=1:a=0,format=yuv420p[v]`;
  }
  args.push(
    '-filter_complex', fc,
    '-map', '[v]', '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-r', String(FPS), '-pix_fmt', 'yuv420p',
    '-t', dur.toFixed(2),
    out,
  );
  const r = await runFfmpeg(args, { timeoutMs: 180_000, cwd: workDir });
  if (!r.ok || !fs.existsSync(out)) throw new Error(`clips bg failed: ${r.stderr.slice(-400)}`);
}

/** 单图 Ken Burns 背景。失败抛错(由上层降级到纯色卡)。
 *  maskBottomBar=true 时在字幕处叠一条局部高斯模糊带(跟视频镜同款),让图文/视频两种模式观感统一。 */
async function renderImageBg(
  workDir: string, out: string, imagePath: string, dur: number, W: number, H: number,
  maskBottomBar = false, subtitlePos: SubtitleStyle['position'] = 'lower',
): Promise<void> {
  const durFrames = Math.round(dur * FPS);
  // Ken Burns 链(不带 format,后面按是否加模糊带决定收尾)。
  const kb = [
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
    `scale=${W * 2}:${H * 2}`,
    `zoompan=z='min(zoom+0.0012,1.18)':d=${durFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}`,
  ].join(',');
  let fc: string;
  if (maskBottomBar) {
    const maskH = Math.round(H * REMIX_MASK_H);
    const maskCenter = Math.round(H * subtitleCenterRatio(subtitlePos));
    const maskY = Math.max(0, Math.min(maskCenter - Math.round(maskH / 2), H - maskH));
    fc = `[0:v]${kb}[vk];[vk]split[vbase][vm];[vm]crop=${W}:${maskH}:0:${maskY},boxblur=24:2[vmb];`
      + `[vbase][vmb]overlay=0:${maskY},format=yuv420p[v]`;
  } else {
    fc = `[0:v]${kb},format=yuv420p[v]`;
  }
  const args = [
    '-y', '-loop', '1', '-i', imagePath,
    '-filter_complex', fc,
    '-map', '[v]', '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-r', String(FPS), '-pix_fmt', 'yuv420p',
    '-t', dur.toFixed(2),
    out,
  ];
  const r = await runFfmpeg(args, { timeoutMs: 180_000, cwd: workDir });
  if (!r.ok || !fs.existsSync(out)) throw new Error(`image bg failed: ${r.stderr.slice(-400)}`);
}

/** 纯色文字卡背景(最终兜底,lavfi 合成最稳)。失败抛错(此时基本是 ffmpeg 本身坏了)。 */
async function renderColorBg(out: string, dur: number, W: number, H: number): Promise<void> {
  const r = await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `color=c=0x14142a:s=${W}x${H}:r=${FPS}`,
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-t', dur.toFixed(2), out,
  ], { timeoutMs: 60_000 });
  if (!r.ok || !fs.existsSync(out)) throw new Error(`color bg failed: ${r.stderr.slice(-400)}`);
}

/**
 * 合成单镜【无声背景】→ scene_bg_NNN.mp4。
 *
 * 抄 MPT 的「坏素材不拖垮整片」容错(combine_videos 里每段 clip 都 try/except 继续):
 *   1. 先用 probeDuration(ffmpeg -i)过滤掉【探不到时长】的坏 clip(下载损坏 / 非视频),只留可解码的;
 *   2. 视频分支失败 → 降级到图片 Ken Burns;
 *   3. 图片分支失败 → 降级到纯色文字卡;
 *   4. 只有连纯色卡都失败(ffmpeg 本身坏)才真的 throw。
 * 这样任何一镜的素材出问题,最坏退成文字卡,整条视频仍能出片。
 */
async function renderSceneBg(
  workDir: string,
  idx: number,
  scene: SceneSpec,
  W: number,
  H: number,
  maxClip: number,
  subtitlePos: SubtitleStyle['position'] = 'lower',
): Promise<string> {
  const out = path.join(workDir, `scene_bg_${String(idx).padStart(3, '0')}.mp4`);
  const dur = Math.max(1.2, scene.durationSec);

  let clips = (scene.clips && scene.clips.length > 0)
    ? scene.clips.filter((c) => c && fs.existsSync(c))
    : (scene.videoPath && fs.existsSync(scene.videoPath) ? [scene.videoPath] : []);

  // G1:过滤探不到时长的坏 clip(损坏 / 编码异常),避免单段坏素材让 ffmpeg 报错拖垮整片。
  if (clips.length > 0) {
    const valid: string[] = [];
    for (const c of clips) {
      if (await probeDuration(c) > 0) valid.push(c);
    }
    clips = valid;
  }

  // 视频 → 图片 → 纯色,逐级降级,绝不因单镜素材问题让整条视频失败。
  if (clips.length > 0) {
    try { await renderClipsBg(workDir, out, clips, dur, W, H, maxClip, !!scene.maskBottomBar, subtitlePos); return out; }
    catch { /* 落到图片/纯色兜底 */ }
  }
  if (scene.imagePath && fs.existsSync(scene.imagePath)) {
    try { await renderImageBg(workDir, out, scene.imagePath, dur, W, H, !!scene.maskBottomBar, subtitlePos); return out; }
    catch { /* 落到纯色兜底 */ }
  }
  await renderColorBg(out, dur, W, H);
  return out;
}

/** concat 一组 mp4(优先 copy,失败重编码)。 */
async function concatVideos(workDir: string, paths: string[], outPath: string): Promise<void> {
  const listFile = path.join(workDir, `vlist_${Date.now()}.txt`);
  fs.writeFileSync(listFile, paths.map(concatLine).join('\n') + '\n', 'utf8');
  const copyR = await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath,
  ], { timeoutMs: 180_000 });
  if (copyR.ok && fs.existsSync(outPath)) return;
  const reR = await runFfmpeg([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    outPath,
  ], { timeoutMs: 240_000 });
  if (!reR.ok || !fs.existsSync(outPath)) {
    throw new Error(`concat videos failed: ${reR.stderr.slice(-400)}`);
  }
}

/** 把多段配音 concat 成一条 aac 音频(用 concat 滤镜,鲁棒于不同 mp3 参数)。 */
async function concatAudios(workDir: string, audioPaths: string[], outPath: string): Promise<void> {
  const args: string[] = ['-y'];
  for (const a of audioPaths) args.push('-i', a);
  const inputs = audioPaths.map((_, i) => `[${i}:a]`).join('');
  args.push(
    '-filter_complex', `${inputs}concat=n=${audioPaths.length}:v=0:a=1[a]`,
    '-map', '[a]',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    outPath,
  );
  const r = await runFfmpeg(args, { timeoutMs: 180_000 });
  if (!r.ok || !fs.existsSync(outPath)) {
    throw new Error(`concat audios failed: ${r.stderr.slice(-400)}`);
  }
}

/** 由各镜已知时长 + 文案估算 cue(无 Whisper 时兜底)。 */
function deriveCuesFromScenes(scenes: SceneSpec[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let t = 0;
  for (const sc of scenes) {
    const dur = Math.max(0.8, sc.durationSec);
    const phrases = splitPhrases(sc.subtitle);
    if (phrases.length > 0) {
      cues.push(...allocateCues(phrases, t, t + dur));
    }
    t += dur;
  }
  return cues;
}

/** 把过长的 cue 文案再按短语细分到它自己的时间窗内,保证字幕可读。 */
function refineCues(cues: SubtitleCue[]): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const c of cues) {
    const phrases = splitPhrases(c.text);
    if (phrases.length <= 1) {
      if (c.text.trim()) out.push(c);
    } else {
      out.push(...allocateCues(phrases, c.start, c.end));
    }
  }
  return out;
}

/** 字幕(及包裹它的模糊带)垂直中心,占画高,按位置。蒙层中心 = 字幕中心 → 蒙层跟字幕走、包裹字幕。 */
function subtitleCenterRatio(position: SubtitleStyle['position']): number {
  switch (position) {
    case 'top': return 0.13;
    case 'center': return 0.50;
    case 'lower': return 0.70;   // 中下方(抖音混剪默认):略偏上,字幕+模糊带一起落这。调小=更靠上
    case 'bottom':
    default: return 0.86;
  }
}

/** 字幕 y 坐标表达式:文字垂直居中于 subtitleCenterRatio 给的中心(与模糊带同心)。 */
function subtitleY(position: SubtitleStyle['position'], H: number): string {
  return `${Math.round(H * subtitleCenterRatio(position))}-text_h/2`;
}

/** 由 cue 列表生成一遍 drawtext 滤镜串(font/textfile 用相对名)。 */
function buildDrawtextChain(
  workDir: string,
  cues: SubtitleCue[],
  style: SubtitleStyle,
  fontRel: string | null,
  H: number,
  W: number,
): string[] {
  const yExpr = subtitleY(style.position, H);
  const fontColor = normalizeColor(style.color, 'white');
  // 选了描边色 → MPT 风格描边(borderw 随字号放大),不再用半透明黑底盒;
  // 没选 → 沿用原来的半透明黑底盒(可读性兜底)。
  const stroke = (style.strokeColor || '').trim();
  const borderW = Math.max(2, Math.round(style.fontSize * 0.06));
  // 每行最大字数按【字号 + 画宽】自适应:左右各留 ~6% 安全边距,字号越大每行越少字
  //   (中文方块字宽≈字号)。避免大字号(超大80/特大100)一行铺满甚至溢出、两侧不留白。
  const safeX = Math.round(W * 0.06);
  const maxPerLine = Math.max(6, Math.floor((W - 2 * safeX) / Math.max(16, style.fontSize)));
  const filters: string[] = [];
  cues.forEach((cue, j) => {
    const wrapped = wrapSubtitle(cue.text, maxPerLine);
    if (!wrapped) return;
    const txtName = `cue_${String(j).padStart(4, '0')}.txt`;
    fs.writeFileSync(path.join(workDir, txtName), wrapped, 'utf8');
    const styleParts = stroke
      ? [`bordercolor=${normalizeColor(stroke, 'black')}`, `borderw=${borderW}`]
      : ['box=1', 'boxcolor=black@0.45', 'boxborderw=24'];
    const parts = [
      fontRel ? `fontfile=${fontRel}` : '',
      `textfile=${txtName}`,
      `fontcolor=${fontColor}`,
      `fontsize=${Math.max(16, Math.round(style.fontSize))}`,
      'line_spacing=14',
      ...styleParts,
      'x=(w-text_w)/2',
      `y=${yExpr}`,
      `enable='between(t,${cue.start.toFixed(2)},${cue.end.toFixed(2)})'`,
    ].filter(Boolean);
    filters.push(`drawtext=${parts.join(':')}`);
  });
  return filters;
}

/**
 * 花字(打在画面上的大字)。与底部字幕是【两层】:
 *   · 字幕 = 把口播念的每句话滚出来,小字、贴底、全程有
 *   · 花字 = 关键数字 / 金句 / 身份条,大字、偏上、只在指定时间段出现
 * 电影级的分镜表里 on_screen_text 就落到这里。没有花字时这一层完全不生成滤镜,零开销。
 */
export interface KeyTextCue {
  text: string;
  start: number;
  end: number;
}

/** 由花字 cue 生成一遍 drawtext(大号粗体 + 强描边 + 偏上,避开底部字幕区)。 */
function buildKeyTextChain(
  workDir: string,
  cues: KeyTextCue[],
  fontRel: string | null,
  H: number,
  W: number,
): string[] {
  if (!cues.length) return [];
  // 花字要显眼:字号取画宽的 ~7.5%(1080 宽 → 81px),明显大于常规字幕(默认 ~48)。
  const fontSize = Math.max(32, Math.round(W * 0.075));
  const borderW = Math.max(4, Math.round(fontSize * 0.08));
  const safeX = Math.round(W * 0.08);
  const maxPerLine = Math.max(4, Math.floor((W - 2 * safeX) / Math.max(16, fontSize)));
  // 放在画面上部 28% 处 —— 底部留给常规字幕,中间留给画面主体。
  const yExpr = `${Math.round(H * 0.28)}-text_h/2`;
  const filters: string[] = [];
  cues.forEach((cue, j) => {
    const wrapped = wrapSubtitle(cue.text, maxPerLine);
    if (!wrapped) return;
    const txtName = `key_${String(j).padStart(4, '0')}.txt`;
    fs.writeFileSync(path.join(workDir, txtName), wrapped, 'utf8');
    const parts = [
      fontRel ? `fontfile=${fontRel}` : '',
      `textfile=${txtName}`,
      'fontcolor=white',
      `fontsize=${fontSize}`,
      'line_spacing=10',
      'bordercolor=black@0.85',
      `borderw=${borderW}`,
      'x=(w-text_w)/2',
      `y=${yExpr}`,
      `enable='between(t,${cue.start.toFixed(2)},${cue.end.toFixed(2)})'`,
    ].filter(Boolean);
    filters.push(`drawtext=${parts.join(':')}`);
  });
  return filters;
}

export interface ComposeOptions {
  scenes: SceneSpec[];
  outputPath: string;
  /** 花字层(可选)。空/不传 = 不生成这一层。 */
  keyTexts?: KeyTextCue[];
  /** 成片宽高(上层按 aspect 算)。默认 1080×1920。 */
  width?: number;
  height?: number;
  /** 每段素材最长秒数(换镜节奏)。默认 4。 */
  maxClipSeconds?: number;
  /** 字幕样式 + 开关。不传 = 底部白字常规字号。 */
  subtitle?: SubtitleStyle;
  /** 可选背景音乐(本地音频文件路径)。 */
  bgmPath?: string;
  /** BGM 音量(0~1),默认 0.18。 */
  bgmVolume?: number;
  /** 每合成完一镜背景回调(用于进度)。 */
  onScene?: (done: number, total: number) => void;
  /**
   * 字幕精确 cue(edge-tts 词边界,时间已对齐到总时间轴)。传入则直接用;
   * 为空/未传 → 自动退回按各镜时长估算的 cue。
   */
  cues?: SubtitleCue[];
  /** 片头留白(秒):旁白延后起播,画面冻结首帧撑住。默认 0.4,传 0 关闭。 */
  leadInSeconds?: number;
  /** 片尾留白(秒):旁白结束后再留一拍,画面冻结尾帧撑住。默认 1.2,传 0 关闭。 */
  tailOutSeconds?: number;
  /**
   * 是否有口播旁白。默认 true(逐镜 concat 旁白音轨)。
   * false = 纯画面模式(Seedance 关旁白):不拼旁白音轨、不烧字幕,
   * 音频只用 BGM(没传 BGM 则补一条静音轨),scenes 不需要 audioPath。
   */
  narration?: boolean;
}

/**
 * 把 BGM 混进已合成好旁白的视频。
 */
async function mixBgm(
  mergedPath: string,
  bgmPath: string,
  outputPath: string,
  bgmVolume: number,
): Promise<boolean> {
  if (!fs.existsSync(bgmPath)) return false;
  const dur = await probeDuration(mergedPath);
  if (dur <= 0) return false;
  const fadeStart = Math.max(0, dur - 2);
  const vol = Math.min(1, Math.max(0, bgmVolume));

  const r = await runFfmpeg([
    '-y',
    '-i', mergedPath,
    '-stream_loop', '-1', '-i', bgmPath,
    '-filter_complex',
    `[1:a]volume=${vol.toFixed(2)},afade=t=out:st=${fadeStart.toFixed(2)}:d=2[bg];` +
      `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`,
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k',
    '-t', dur.toFixed(2),
    '-movflags', '+faststart',
    outputPath,
  ], { timeoutMs: 180_000 });

  return r.ok && fs.existsSync(outputPath);
}

/** 主合成入口。 */
export async function composeVideo(opts: ComposeOptions): Promise<string> {
  const { scenes, outputPath } = opts;
  if (scenes.length === 0) throw new Error('no scenes to compose');

  const W = opts.width && opts.width > 0 ? Math.round(opts.width) : 1080;
  const H = opts.height && opts.height > 0 ? Math.round(opts.height) : 1920;
  const maxClip = opts.maxClipSeconds && opts.maxClipSeconds > 0 ? opts.maxClipSeconds : DEFAULT_MAX_CLIP_SEC;
  const style: SubtitleStyle = opts.subtitle ?? { enabled: true, fontSize: 52, position: 'bottom' };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-video-'));

  // 字体拷进 workDir,filtergraph 里只用相对名(避开 C: 转义)。
  // 优先用户选中的字体(style.fontFile),其次内置思源黑体(任何机器中文都不豆腐),
  // 都缺失才退回系统字体。
  let fontRel: string | null = null;
  // 韩/日字幕:内置中文字体渲染成豆腐 → 先按字幕文种挑覆盖字体(见 resolveScriptFont);
  //   纯中文/拉丁才照旧走用户选中字体 / 内置思源黑体 / 系统中文兜底。
  const subSample = ((opts.cues && opts.cues.length ? opts.cues.map((c) => c.text || '') : opts.scenes.map((s) => s.subtitle || '')) || []).join('');
  const fontSrc = resolveScriptFont(subSample) ?? resolveBundledFontByName(style.fontFile) ?? resolveBundledFont() ?? resolveCjkFont();
  if (fontSrc) {
    try {
      fontRel = `font${path.extname(fontSrc) || '.ttf'}`;
      fs.copyFileSync(fontSrc, path.join(workDir, fontRel));
    } catch {
      fontRel = null;
    }
  }

  try {
    // 1. 逐镜出无声背景
    const bgPaths: string[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const p = await renderSceneBg(workDir, i, scenes[i], W, H, maxClip, style.position);
      bgPaths.push(p);
      opts.onScene?.(i + 1, scenes.length);
    }

    // 2. master_bg + master_audio
    const masterBg = path.join(workDir, 'master_bg.mp4');
    await concatVideos(workDir, bgPaths, masterBg);

    // v6.x: 纯画面模式(Seedance 关旁白)— 无旁白音轨、无字幕,音频只用 BGM
    //   (没传 BGM 则补一条静音 aac 轨,避免部分平台拒收无音轨视频)。完全不碰
    //   下面的旁白合成路径。
    if (opts.narration === false) {
      const leadSec0 = opts.leadInSeconds !== undefined && opts.leadInSeconds >= 0 ? opts.leadInSeconds : DEFAULT_LEAD_IN_SEC;
      const tailSec0 = opts.tailOutSeconds !== undefined && opts.tailOutSeconds >= 0 ? opts.tailOutSeconds : DEFAULT_TAIL_OUT_SEC;
      const vPad0 = (leadSec0 > 0 || tailSec0 > 0)
        ? `tpad=start_duration=${leadSec0.toFixed(2)}:start_mode=clone:stop_duration=${tailSec0.toFixed(2)}:stop_mode=clone,`
        : '';
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      // 先把画面(可选首尾留白)定帧出一条无声视频。
      const silentVid = path.join(workDir, 'silent.mp4');
      const rv = await runFfmpeg([
        '-y', '-i', masterBg,
        '-vf', `${vPad0}format=yuv420p`,
        '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-r', String(FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        silentVid,
      ], { timeoutMs: 300_000, cwd: workDir });
      if (!rv.ok || !fs.existsSync(silentVid)) {
        throw new Error(`silent video build failed: ${rv.stderr.slice(-400)}`);
      }
      const wantBgm0 = !!(opts.bgmPath && fs.existsSync(opts.bgmPath));
      if (wantBgm0) {
        const vol = Math.min(1, Math.max(0, opts.bgmVolume ?? 0.18));
        const rb = await runFfmpeg([
          '-y', '-i', silentVid,
          '-stream_loop', '-1', '-i', opts.bgmPath!,
          '-filter_complex', `[1:a]volume=${vol}[a]`,
          '-map', '0:v', '-map', '[a]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
          '-shortest', '-movflags', '+faststart',
          outputPath,
        ], { timeoutMs: 180_000, cwd: workDir });
        if (!rb.ok || !fs.existsSync(outputPath)) {
          try { fs.copyFileSync(silentVid, outputPath); } catch {}
        }
      } else {
        const rs = await runFfmpeg([
          '-y', '-i', silentVid,
          '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
          '-shortest', '-movflags', '+faststart',
          outputPath,
        ], { timeoutMs: 120_000, cwd: workDir });
        if (!rs.ok || !fs.existsSync(outputPath)) {
          try { fs.copyFileSync(silentVid, outputPath); } catch {}
        }
      }
      return outputPath;
    }

    const masterAudio = path.join(workDir, 'master_audio.m4a');
    await concatAudios(workDir, scenes.map((s) => s.audioPath!), masterAudio);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // 首尾留白:画面冻结首/尾帧、音频延后起播 + 补尾,避免开口太突/收尾太硬。
    const leadSec = opts.leadInSeconds !== undefined && opts.leadInSeconds >= 0 ? opts.leadInSeconds : DEFAULT_LEAD_IN_SEC;
    const tailSec = opts.tailOutSeconds !== undefined && opts.tailOutSeconds >= 0 ? opts.tailOutSeconds : DEFAULT_TAIL_OUT_SEC;
    const hasPad = leadSec > 0 || tailSec > 0;

    // 3. 字幕 cue(开了字幕才算):优先用上层传入的精确 cue,空则按各镜时长估算。
    //    有片头留白时把所有 cue 整体后移 leadSec,才能跟延后起播的旁白对齐。
    let drawtext: string[] = [];
    if (style.enabled) {
      const rawCues = (opts.cues && opts.cues.length > 0) ? opts.cues : deriveCuesFromScenes(scenes);
      const cues = leadSec > 0
        ? rawCues.map((c) => ({ ...c, start: c.start + leadSec, end: c.end + leadSec }))
        : rawCues;
      drawtext = buildDrawtextChain(workDir, refineCues(cues), style, fontRel, H, W);
    }
    // 花字层:与字幕开关无关(用户可能关字幕但仍要关键数字弹出),同样要吃 leadSec 偏移。
    const keyTextCues = (opts.keyTexts || [])
      .filter((k) => k && k.text && k.end > k.start)
      .map((k) => (leadSec > 0 ? { ...k, start: k.start + leadSec, end: k.end + leadSec } : k));
    const keyDraw = buildKeyTextChain(workDir, keyTextCues, fontRel, H, W);

    // 4. 烧字幕 / 加留白(或直接 mux)→ merged
    const wantBgm = !!(opts.bgmPath && fs.existsSync(opts.bgmPath));
    const mergedPath = wantBgm ? path.join(workDir, 'merged.mp4') : outputPath;

    // 画面滤镜链:留白(tpad 冻结首/尾帧)→ 字幕 → 像素格式。
    const vPad = hasPad
      ? `tpad=start_duration=${leadSec.toFixed(2)}:start_mode=clone:stop_duration=${tailSec.toFixed(2)}:stop_mode=clone`
      : '';
    // 花字画在字幕之后 → 叠在字幕之上(两层位置本就错开:花字偏上、字幕贴底)。
    const vParts = [vPad, ...drawtext, ...keyDraw, 'format=yuv420p'].filter(Boolean);
    const needVideoFilter = vPad !== '' || drawtext.length > 0 || keyDraw.length > 0;
    // 音频:adelay 把旁白整体后移 leadSec,apad 无限补尾;配合 -shortest 由画面总时长(已含
    // 首尾留白)裁齐 → 实际尾部留白 = 全片时长 - 旁白结束点。
    const aFilter = hasPad ? `[1:a]adelay=${Math.round(leadSec * 1000)}:all=1,apad[a]` : '';

    if (needVideoFilter) {
      const fcParts = [`[0:v]${vParts.join(',')}[v]`];
      if (aFilter) fcParts.push(aFilter);
      const r = await runFfmpeg([
        '-y',
        '-i', masterBg,
        '-i', masterAudio,
        '-filter_complex', fcParts.join(';'),
        '-map', '[v]', '-map', aFilter ? '[a]' : '1:a',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-r', String(FPS), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-shortest', '-movflags', '+faststart',
        mergedPath,
      ], { timeoutMs: 300_000, cwd: workDir });
      if (!r.ok || !fs.existsSync(mergedPath)) {
        throw new Error(`burn/pad failed: ${r.stderr.slice(-400)}`);
      }
    } else {
      // 无字幕、无留白:画面 copy,只 mux 音频(最快路径)
      const r = await runFfmpeg([
        '-y',
        '-i', masterBg,
        '-i', masterAudio,
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
        '-shortest', '-movflags', '+faststart',
        mergedPath,
      ], { timeoutMs: 180_000 });
      if (!r.ok || !fs.existsSync(mergedPath)) {
        throw new Error(`mux failed: ${r.stderr.slice(-400)}`);
      }
    }

    // 5. 混 BGM(失败降级用无 BGM 成片)
    if (wantBgm) {
      const ok = await mixBgm(mergedPath, opts.bgmPath!, outputPath, opts.bgmVolume ?? 0.18);
      if (!ok || !fs.existsSync(outputPath)) {
        try { fs.copyFileSync(mergedPath, outputPath); } catch {}
      }
    }

    return outputPath;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}


/**
 * 电影级专用:把 Seedance 片段【直接拼起来】,不重编码、不丢音轨。
 *
 * ⚠️ 为什么不能走 composeVideo:那条路每一步都带 `-an`,片段音轨全被丢掉。
 *   而 Seedance 1.5-pro 开了 generate_audio 之后,人声、口型、环境音、BGM 是【和画面
 *   一起生成的】—— 音画同源、毫秒同步,正是我们要的东西,丢了就白花钱了。
 *   所以电影级本地只剩这一件事:拼。不配音、不烧字幕、不加蒙层、不做时间轴对齐。
 *
 * 片段来自同一次生成,分辨率/帧率/编码一致 → concat demuxer + `-c copy` 零转码。
 *   万一某段参数不一致导致 copy 失败,回退重编码一次(慢但一定成)。
 */
export async function concatNativeClips(opts: {
  clipPaths: string[];
  outputPath: string;
  /** 可选:额外 BGM 垫在原声之下(Seedance 自带音乐时一般不用)。 */
  bgmPath?: string;
  bgmVolume?: number;
  /**
   * 可选:烧字幕。
   *
   * 内容直接来自分镜表的每镜台词(就是喂给 Seedance 念的那句),时间轴来自【实测的片段
   * 时长】—— 比以前靠 TTS 词边界估算更准:那时字幕对的是我们自己合成的音频,现在对的
   * 是成片里真实播放的那段。
   * ⚠️ 一旦要烧字幕就【必须重编码】,零转码拼接用不了 —— 这是烧字幕的固有代价。
   */
  subtitles?: { text: string; start: number; end: number }[];
  /**
   * 可选:从【拼好的成片】现场生成字幕,优先于 subtitles。
   *
   * 🚨 电影级为什么必须走这条:声音是 Seedance 生成的,不是我们的 TTS。它是生成模型不是
   *   朗读器 —— 即便 prompt 明写「人物说:「台词」」也【不保证逐字念】,实测会改词、换语序、
   *   甚至说别的。于是"字幕用分镜稿的台词"必然和真实人声对不上(用户 2026-08-04 实测
   *   「文字和配音内容都完全对不上」)。唯一能保证对上的做法:把成片音频转写出来当字幕 ——
   *   字幕就是它实际说的那句,时间轴就是它实际说话的时刻。
   * 回调拿到的是【已拼接、已混 BGM】的文件;返回空数组 = 转写失败/没人声 → 回落到 subtitles。
   */
  subtitlesFromAudio?: (mergedPath: string) => Promise<{ text: string; start: number; end: number }[]>;
  /** 字幕字号档(同 compose 的口径,默认 20)。 */
  subtitleFontSize?: number;
  /** 画面宽高(烧字幕时用于换算字号/边距);不传则从首个片段探测。 */
  width?: number;
  height?: number;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const clips = opts.clipPaths.filter((c) => c && fs.existsSync(c));
  if (clips.length === 0) throw new Error('没有可拼接的片段');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-ainative-'));
  try {
    const listPath = path.join(workDir, 'concat.txt');
    // ⚠️ 复用 concatLine,别自己再写一遍转义:第一版写成 `"'\''"`,而在 JS 里那是三个引号
    //    —— 反斜杠在解析期就没了,路径里带撇号(用户名 O'Brien 之类)直接拼接失败。
    //    concatLine 还顺带把反斜杠转成正斜杠,Windows 路径也才对。
    fs.writeFileSync(listPath, clips.map(concatLine).join('\n') + '\n', 'utf8');

    let merged = path.join(workDir, 'merged.mp4');
    opts.onProgress?.(`拼接 ${clips.length} 个片段(保留原声,零转码)`);
    let r = await runFfmpeg(
      ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', merged],
      { timeoutMs: 300_000, signal: opts.signal },
    );
    if (!r.ok || !fs.existsSync(merged)) {
      // 片段参数不一致 → 重编码兜底(音频统一 aac,视频统一 h264)。
      opts.onProgress?.('零转码拼接失败,改用重编码拼接');
      merged = path.join(workDir, 'merged_re.mp4');
      r = await runFfmpeg(
        ['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', merged],
        { timeoutMs: 900_000, signal: opts.signal },
      );
      if (!r.ok || !fs.existsSync(merged)) throw new Error('片段拼接失败');
    }

    // 可选 BGM:垫在原声之下。原声必须保持主导 —— 它才是台词所在。
    const bgm = opts.bgmPath;
    if (bgm && fs.existsSync(bgm)) {
      const vol = typeof opts.bgmVolume === 'number' && opts.bgmVolume >= 0 ? opts.bgmVolume : 0.12;
      const withBgm = path.join(workDir, 'with_bgm.mp4');
      const rb = await runFfmpeg(
        ['-y', '-i', merged, '-stream_loop', '-1', '-i', bgm,
          '-filter_complex', `[1:a]volume=${vol}[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]`,
          '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
          '-movflags', '+faststart', withBgm],
        { timeoutMs: 300_000, signal: opts.signal },
      );
      if (rb.ok && fs.existsSync(withBgm)) merged = withBgm;
      else opts.onProgress?.('BGM 混音失败,保留纯原声');
    }

    // 烧字幕(可选)。放在最后一步,和 BGM 分开做 —— BGM 那步是 `-c:v copy`,
    //   这一步必须重编码,合在一起会让没开字幕的用户也白白转码一遍。
    // 字幕来源:优先【转写成片音频】(电影级 —— 保证字幕就是实际说出来的那句),
    //   转写失败/没人声再回落到调用方给的稿子。
    let cueSource = opts.subtitles || [];
    if (opts.subtitlesFromAudio) {
      try {
        const asrCues = await opts.subtitlesFromAudio(merged);
        if (asrCues && asrCues.length > 0) cueSource = asrCues;
        else opts.onProgress?.('⚠️ 音频转写没拿到结果,字幕回落到分镜稿台词(可能与人声不完全一致)');
      } catch (e) {
        opts.onProgress?.('⚠️ 音频转写失败,字幕回落到分镜稿台词(可能与人声不完全一致)');
      }
    }
    const cues = cueSource.filter((c) => c.text && c.end > c.start);
    if (cues.length > 0) {
      const dim = (opts.width && opts.height)
        ? { width: opts.width, height: opts.height }
        : await probeImageSize(merged).catch(() => ({ width: 1080, height: 1920 }));
      const W = dim.width > 0 ? dim.width : 1080;
      const H = dim.height > 0 ? dim.height : 1920;
      const assPath = path.join(workDir, 'sub.ass');
      fs.writeFileSync(assPath, buildNativeAss(cues, W, H, opts.subtitleFontSize || 20), 'utf8');
      const burned = path.join(workDir, 'burned.mp4');
      opts.onProgress?.('烧录字幕(需重编码)');
      const rs = await runFfmpeg(
        ['-y', '-i', merged, '-vf', `subtitles='${escAssPath(assPath)}'`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'copy', '-movflags', '+faststart', burned],
        { timeoutMs: 900_000, signal: opts.signal },
      );
      // 烧失败不该让整条片子作废 —— 保留无字幕版本交付。
      if (rs.ok && fs.existsSync(burned)) merged = burned;
      else opts.onProgress?.('⚠️ 字幕烧录失败,输出无字幕版本');
    }

    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.copyFileSync(merged, opts.outputPath);
    return opts.outputPath;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}


/** subtitles 滤镜的路径转义(Windows 盘符冒号 + 反斜杠)。 */
function escAssPath(p: string): string {
  // 三样都要:反斜杠→正斜杠、盘符冒号转义、撇号转义。和 repost-pipeline.escSubPath 同口径 ——
  //   少了撇号那条,路径里带撇号时 subtitles='...' 会被提前闭合,滤镜串直接语法错。
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function assTime(sec: number): string {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = Math.floor(t % 60);
  const cs = Math.round((t - Math.floor(t)) * 100);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${h}:${p2(m)}:${p2(ss)}.${p2(cs)}`;
}

/**
 * 电影级原生路径的 ASS 字幕。
 *
 * 用 ASS 而不是 SRT + force_style:后者的 FontSize 是按 libass 内部 288 高的虚拟画布算的,
 *   竖屏 1920 高会被放大约 6.7 倍 → 20 号变成 130+px 的巨字糊满屏(老 bug)。
 *   ASS 里 PlayRes 直接写真实分辨率,字号所见即所得。
 * 折行复用 cutByWidth —— 按可视宽度断,英文不会从单词中间劈开。
 */
function buildNativeAss(
  cues: { text: string; start: number; end: number }[],
  W: number, H: number, fontSetting: number,
): string {
  const fontPx = Math.max(18, Math.round(H * (fontSetting / 700)));
  const marginV = Math.round(H * 0.06);
  const outline = Math.max(1, Math.round(fontPx / 18));
  // 每行最多几个字宽:留 8% 安全边,拉丁按 0.5 字宽算(cutByWidth 内部处理)。
  const maxPerLine = Math.max(6, Math.floor((W * 0.92) / fontPx));
  const esc = (t: string) => cutByWidth(t.replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim(), maxPerLine)
    .slice(0, 2)               // 电影级画面为主,字幕最多两行
    .join('\\N');
  return [
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
    ...cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,${esc(c.text)}`),
  ].join('\n');
}
