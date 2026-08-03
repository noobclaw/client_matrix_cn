/**
 * bgm — 解析背景音乐路径(本地内置 / 云端曲库 / 用户上传)。
 *
 * 向导把选中的 BGM 用 token 传进来,这里在【合成前】还原成一个本地绝对路径:
 *   · `builtin:<id>`   → 随包 bundle 的 resources/bgm/<id>.mp3(8 首本地内置)。
 *   · `remote:<url>`   → 云端曲库。首次合成时从 url 下载并缓存到
 *                        <userData>/bgm-cache/,之后命中缓存直接复用,绝不重复下载。
 *   · 其它绝对路径      → 用户自己上传的 BGM,原样返回。
 *   · 空 / undefined    → undefined(不加 BGM)。
 *
 * 内置曲库来源:MoneyPrinterTurbo 自带 resource/songs(重命名 bgm-01..bgm-08)。
 * 云端曲库:我们手动传 R2、把「中英标题 + 下载链接」配在客户端清单里(REMOTE_BGM),
 * 用户选中后在出片时按需下载 —— 不随安装包发,装机体积小。
 *
 * 多根探测套用 compose.ts.bundledFontDirs 的同款逻辑,覆盖 Win/mac/dev。
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';

/** 本地内置 BGM token 前缀。 */
export const BUILTIN_BGM_PREFIX = 'builtin:';
/** 云端曲库 token 前缀(后接完整下载 URL)。 */
export const REMOTE_BGM_PREFIX = 'remote:';

/** 已下载云端曲目的本地缓存目录。 */
function bgmCacheDir(): string {
  return path.join(getUserDataPath(), 'bgm-cache');
}

/** 内置 BGM 可能落地的目录集合(同 compose.bundledFontDirs 的多根探测)。 */
function bundledBgmDirs(): string[] {
  const dirs: string[] = [];
  const pushRoot = (root: string): number => dirs.push(path.join(root, 'bgm'));
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
  // Dev / non-CI fallback: prepare-tauri-resources.js (a CI-only step) is what
  // copies bgm into the bundled resources dir, and isPackaged() is ALWAYS true
  // in the sidecar binary — so under `tauri:dev` the packaged branch above can
  // never find the built-in songs. Always also probe the committed source
  // `client/resources/bgm` by walking up from this file and from cwd. These
  // dirs don't exist in a real install, so existsSync() just skips them.
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

/** 内置 token → 随包 bundle 的绝对路径(找不到返回 undefined)。 */
function resolveBuiltin(id: string): string | undefined {
  const safeId = path.basename(id.trim()); // 挡路径穿越
  if (!safeId) return undefined;
  const probed = bundledBgmDirs();
  for (const dir of probed) {
    const p = path.join(dir, `${safeId}.mp3`);
    if (fs.existsSync(p)) return p;
  }
  // 固定路径都没命中 → 兜底在安装目录里扫一遍(装包布局跟我们猜的不一样时自愈,
  // 比如资源被多套了一层、或者 sidecar 不在安装根)。只扫一次,结果缓存。
  const scanned = scanForBgmDir(safeId);
  if (scanned) {
    const p = path.join(scanned, `${safeId}.mp3`);
    if (fs.existsSync(p)) return p;
  }
  // 诊断:内置 BGM 找不到(试听失败:未取到音频)时,打出探测过的目录 + 运行时
  // 路径锚点,方便定位 Tauri sidecar 进程里资源的真实落点。
  try {
    console.warn('[bgm] builtin "' + safeId + '.mp3" not found. packaged=' + isPackaged()
      + ' execPath=' + process.execPath + ' resources=' + getResourcesPath()
      + ' probed=' + JSON.stringify(probed.map((d) => d + (fs.existsSync(d) ? ' [dir✓]' : ''))));
  } catch { /* ignore */ }
  return undefined;
}

/** 扫到过的 bgm 目录(null = 扫过但没找到,不再重复扫)。 */
let _scannedBgmDir: string | null | undefined;

/**
 * scanForBgmDir — 在安装目录附近有界地找 <id>.mp3 所在的目录。
 *
 * 为什么要这个:内置曲目能不能试听/合成,完全取决于「资源在装包后落到哪」,
 * 而这个落点随打包器版本/安装方式(perMachine、便携版、mac 嵌套)变。固定路径列表
 * 猜错一次,用户看到的就是「试听失败:未取到音频」,而且没法自己修。这里宽度深度都设上限
 * (只看目录、跳过明显无关的大目录),命中即缓存,代价可以忽略。
 */
function scanForBgmDir(id: string): string | undefined {
  if (_scannedBgmDir !== undefined) return _scannedBgmDir || undefined;
  _scannedBgmDir = null;
  const target = `${id}.mp3`;
  const SKIP = new Set(['node_modules', '.git', 'chrome-extension', 'runtimes', 'python', 'SKILLs', 'Cache', 'logs']);
  const MAX_DIRS = 1500;                      // 硬上限,别把安装盘扫穿
  const roots: string[] = [];
  try {
    const exeDir = path.dirname(process.execPath);
    roots.push(exeDir, path.dirname(exeDir), getResourcesPath(), path.dirname(getResourcesPath()));
  } catch { /* ignore */ }
  let seen = 0;
  for (const root of roots) {
    // 盘根(D:)之类的别扫,只在像安装目录的地方找
    if (!root || root === path.parse(root).root) continue;
    // 逐层 BFS,最多 4 层
    let level = [root];
    for (let depth = 0; depth < 4 && level.length; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (seen++ > MAX_DIRS) { return undefined; }
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (e.isFile()) {
            if (e.name === target) { _scannedBgmDir = dir; return dir; }
          } else if (e.isDirectory() && !SKIP.has(e.name)) {
            next.push(path.join(dir, e.name));
          }
        }
      }
      level = next;
    }
  }
  return undefined;
}

/** 给一个下载 URL 算出稳定、防碰撞、可读的缓存文件名(<10位hash>-<basename>)。 */
function cacheFileFor(url: string): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
  let base = 'bgm';
  try {
    const b = path.basename(new URL(url).pathname);
    if (b) base = b;
  } catch { /* 非法 URL 时用默认 base */ }
  base = base.replace(/[^\w.\-]/g, '_').slice(-40);
  if (!/\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(base)) base += '.mp3';
  return path.join(bgmCacheDir(), `${hash}-${base}`);
}

/** 下载到 dest(先写 .part 再原子改名,避免半截文件污染缓存)。失败返回 false,绝不抛。 */
async function downloadTo(url: string, dest: string, onLog?: (m: string) => void): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    onLog?.('☁️ 正在下载云端背景音乐…');
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) { onLog?.(`⚠️ 背景音乐下载失败(HTTP ${resp.status})`); return false; }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) { onLog?.('⚠️ 背景音乐下载为空'); return false; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    onLog?.(`✅ 背景音乐已缓存(${(buf.length / 1024 / 1024).toFixed(1)}MB),下次复用不再下载`);
    return true;
  } catch {
    onLog?.('⚠️ 背景音乐下载异常');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把向导传来的 bgmPath 解析成可用的本地绝对路径。云端曲目会在此按需下载并缓存。
 * 失败(下载不到 / 内置缺失)返回 undefined,由 pipeline 兜底为「不加 BGM」。绝不抛。
 */
export async function resolveBgmPath(
  bgmPath?: string,
  onLog?: (m: string) => void,
): Promise<string | undefined> {
  if (!bgmPath) return undefined;

  if (bgmPath.startsWith(BUILTIN_BGM_PREFIX)) {
    return resolveBuiltin(bgmPath.slice(BUILTIN_BGM_PREFIX.length));
  }

  if (bgmPath.startsWith(REMOTE_BGM_PREFIX)) {
    const url = bgmPath.slice(REMOTE_BGM_PREFIX.length).trim();
    if (!/^https?:\/\//i.test(url)) return undefined;
    const dest = cacheFileFor(url);
    // 命中缓存(且非空)→ 直接复用,不重复下载。
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
    const ok = await downloadTo(url, dest, onLog);
    return ok ? dest : undefined;
  }

  // 用户上传的绝对路径,原样返回(pipeline 再 existsSync 兜底)。
  return bgmPath;
}

/**
 * 解析「该 BGM 应该打开的目录」——给 UI「打开文件夹」用:不下载、不要求文件已存在,
 * 比 resolveBgmPath 健壮(后者 remote 必须先下载成功才有路径,网络/CDN 出问题就拿不到)。
 *   · builtin: → 内置 bgm 目录(bundledBgmDirs 第一个存在的;都不在则返回第一个候选)
 *   · remote:  → 云端缓存目录 bgm-cache(确保已建好便于打开;没下载过的曲目自然不在里面)
 *   · 上传绝对路径 → 该文件所在目录
 */
export function resolveBgmFolder(bgmPath?: string): string | undefined {
  if (!bgmPath) return undefined;
  if (bgmPath.startsWith(BUILTIN_BGM_PREFIX)) {
    // 关键:复用【出片那套已验证能定位到文件】的 resolveBuiltin(找 <dir>/<id>.mp3 文件存在),
    // 而不是只判"目录存在" —— 后者会命中存在但没歌的候选目录、或在 sidecar 里探不到而落空,
    // 导致出片能用 BGM、这里却「找不到」。出片找得到的目录,这里就一定打得开(完全对齐)。
    const id = bgmPath.slice(BUILTIN_BGM_PREFIX.length);
    const file = resolveBuiltin(id);
    if (file) return path.dirname(file);
    // 真没探到(dev / 资源未就位):退回缓存目录(建好它),保证总能打开一个真实存在的目录。
    const cache = bgmCacheDir();
    try { fs.mkdirSync(cache, { recursive: true }); } catch { /* ignore */ }
    return cache;
  }
  if (bgmPath.startsWith(REMOTE_BGM_PREFIX)) {
    const dir = bgmCacheDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return dir;
  }
  return path.dirname(bgmPath);
}

// ────────────────────────────────────────────────────────────────────────────
// 分段 BGM(电影级分镜表用)
//
// 老行为:整片循环【一首】BGM。而分镜表里每一镜带 bgmMood(轻快/紧张/悬疑/大气…),
// 叙事推进时音乐该跟着变 —— 悬疑开场 → 冲突转紧张 → 反转转轻快 → 结尾钢琴收。
//
// 做法:把相邻同情绪的镜合成一个「段」,每段按情绪从云端曲库挑一首,截到该段时长,
// 段间 1.2s 交叉淡入淡出,拼成一条完整 BGM 轨,再交给 compose 当普通 bgmPath 混音。
// 曲库靠【中文曲名前缀】识别情绪(命名规范:`<emoji> <分类> · <细分>`,见 project_video_bgm_library)。
// 任何一步失败 → 返回 undefined,调用方回落到单曲 BGM(绝不阻塞出片)。
// ────────────────────────────────────────────────────────────────────────────

const REMOTE_BGM_MANIFEST_URL = 'https://static.noobclaw.com/bgm/manifest.json';

interface RemoteBgmEntry { id: string; zh: string; en: string; url: string }

let _manifestCache: RemoteBgmEntry[] | null = null;

/** 拉云端曲库清单(进程内缓存一次)。失败返回 []。 */
async function fetchBgmManifest(): Promise<RemoteBgmEntry[]> {
  if (_manifestCache) return _manifestCache;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(`${REMOTE_BGM_MANIFEST_URL}?t=${Date.now()}`, { signal: ctrl.signal });
    if (!resp.ok) return [];
    const json: unknown = await resp.json();
    const arr = Array.isArray(json) ? json : (json as { items?: unknown })?.items;
    if (!Array.isArray(arr)) return [];
    _manifestCache = arr
      .filter((x): x is RemoteBgmEntry => !!x && typeof (x as RemoteBgmEntry).url === 'string')
      .map((x) => ({ id: String(x.id || ''), zh: String(x.zh || ''), en: String(x.en || ''), url: String(x.url) }));
    return _manifestCache;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** 曲名 → 情绪分类。命名规范是 `<emoji> <分类> · <细分>`,取中文标签里的分类词。 */
function moodOfTrack(zh: string): string {
  const m = (zh || '').replace(/^[^\u4e00-\u9fa5A-Za-z]+/, '').split('·')[0].trim();
  return m;
}

/** 分镜给的情绪词 → 曲库分类词(容错同义)。 */
function normalizeMood(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const MAP: Array<[RegExp, string]> = [
    [/轻快|明快|愉快/, '轻快'],
    [/节拍|鼓点|律动/, '节拍'],
    [/大气|史诗|恢弘|磅礴/, '大气'],
    [/舒缓|平静|温柔|安静|钢琴/, '舒缓'],
    [/轻柔|柔和/, '轻柔'],
    [/悠闲|闲适/, '悠闲'],
    [/紧张|急促|压迫/, '紧张'],
    [/悬疑|神秘|诡异/, '悬疑'],
    [/欢快|欢乐|喜悦/, '欢快'],
    [/开场|片头/, '开场'],
    [/动感|激烈|燃/, '动感'],
    [/新闻|资讯/, '新闻'],
  ];
  for (const [re, tag] of MAP) if (re.test(s)) return tag;
  return s;
}

export interface BgmSegmentSpec {
  /** 情绪词(来自分镜表 bgmMood)。空 = 沿用上一段。 */
  mood: string;
  /** 该段时长(秒)。 */
  seconds: number;
}

/**
 * 按情绪段拼一条完整 BGM 轨。
 *
 * @param segments  分镜的 (情绪, 时长) 序列 —— 内部会把相邻同情绪的合并
 * @param workDir   临时目录(放中间片段与成品)
 * @param fallback  没匹配到曲子时用的单曲本地路径(通常是用户选的那首)
 * @returns 拼好的音频绝对路径;条件不足/失败返回 undefined(调用方回落单曲)
 */
export async function buildMoodBgmTrack(
  segments: BgmSegmentSpec[],
  workDir: string,
  runFfmpegFn: (args: string[], opts?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<{ ok: boolean }>,
  fallback?: string,
  onLog?: (m: string) => void,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    // 1. 合并相邻同情绪 → 段
    const merged: BgmSegmentSpec[] = [];
    let lastMood = '';
    for (const s of segments) {
      const mood = normalizeMood(s.mood) || lastMood;
      const dur = Math.max(0, Number(s.seconds) || 0);
      if (dur <= 0) continue;
      if (merged.length > 0 && merged[merged.length - 1].mood === mood) {
        merged[merged.length - 1].seconds += dur;
      } else {
        merged.push({ mood, seconds: dur });
      }
      lastMood = mood;
    }
    // 只有一段(或没情绪信息)→ 没必要分段,让调用方走原来的单曲循环。
    if (merged.length < 2) return undefined;

    const manifest = await fetchBgmManifest();
    if (manifest.length === 0) { onLog?.('⚠️ 云端曲库清单拉取失败,分段配乐回退单曲'); return undefined; }

    // 2. 每段选曲:同情绪的曲子里按段序轮换(相邻段不撞曲)
    const byMood = new Map<string, RemoteBgmEntry[]>();
    for (const t of manifest) {
      const m = moodOfTrack(t.zh);
      if (!m) continue;
      if (!byMood.has(m)) byMood.set(m, []);
      byMood.get(m)!.push(t);
    }

    const parts: string[] = [];
    const XFADE = 1.2; // 段间交叉淡入淡出秒数
    for (let i = 0; i < merged.length; i++) {
      if (signal?.aborted) return undefined;
      const seg = merged[i];
      const pool = byMood.get(seg.mood) || [];
      let srcLocal: string | undefined;
      if (pool.length > 0) {
        const pick = pool[i % pool.length];
        srcLocal = await resolveBgmPath(`${REMOTE_BGM_PREFIX}${pick.url}`, onLog);
      }
      if (!srcLocal || !fs.existsSync(srcLocal)) srcLocal = fallback;
      if (!srcLocal || !fs.existsSync(srcLocal)) {
        onLog?.(`⚠️ 情绪「${seg.mood}」没匹配到曲子,分段配乐回退单曲`);
        return undefined;
      }
      // 截到该段时长(+ 交叉淡出余量),循环补足短曲,首尾各加淡入淡出。
      const need = seg.seconds + (i < merged.length - 1 ? XFADE : 0);
      const out = path.join(workDir, `bgmseg_${String(i).padStart(3, '0')}.mp3`);
      const fadeOutAt = Math.max(0, need - XFADE);
      const r = await runFfmpegFn([
        '-y', '-stream_loop', '-1', '-i', srcLocal,
        '-t', need.toFixed(2),
        '-af', `afade=t=in:st=0:d=${XFADE.toFixed(2)},afade=t=out:st=${fadeOutAt.toFixed(2)}:d=${XFADE.toFixed(2)}`,
        '-ar', '48000', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '112k', out,
      ], { timeoutMs: 120_000, signal });
      if (!r.ok || !fs.existsSync(out)) { onLog?.('⚠️ 分段配乐切片失败,回退单曲'); return undefined; }
      parts.push(out);
    }

    // 3. concat 成一条
    const listPath = path.join(workDir, 'bgm_segments.txt');
    fs.writeFileSync(
      listPath,
      parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );
    const finalPath = path.join(workDir, 'bgm_mood.mp3');
    const cat = await runFfmpegFn([
      '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c:a', 'libmp3lame', '-b:a', '112k', '-ar', '48000', '-ac', '2', finalPath,
    ], { timeoutMs: 180_000, signal });
    if (!cat.ok || !fs.existsSync(finalPath)) { onLog?.('⚠️ 分段配乐拼接失败,回退单曲'); return undefined; }

    onLog?.(`🎵 分段配乐已生成:${merged.length} 段(${merged.map((m) => m.mood || '默认').join(' → ')})`);
    return finalPath;
  } catch {
    return undefined;
  }
}
