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
