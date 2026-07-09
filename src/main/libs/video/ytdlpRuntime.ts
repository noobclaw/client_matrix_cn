/**
 * ytdlpRuntime — 爆帖成片的 YouTube 背景下载器(yt-dlp 单文件二进制,按需下载)。
 *
 * 解析顺序(仿 ffmpegRuntime,第一个能用的胜出):
 *   1. 环境变量 NOOBCLAW_YTDLP_PATH(显式覆盖)
 *   2. userData/runtimes/yt-dlp/yt-dlp(.exe) —— 首次用时从服务端下发的 URL 下载缓存
 *   3. 系统 PATH 上的 yt-dlp(开发机)
 *
 * 跟 ffmpeg 不同:yt-dlp 不随包分发(避免包体+更新频繁),首次使用按需下载
 * (~35MB 单文件,官方 GitHub release;国内用户 admin 可配自家 OSS 镜像)。
 *
 * ⚠️ 代理:此功能的用户必然挂着 VPN(Reddit 本身需要),但【规则型 VPN 不接管
 * Node 子进程的直连流量】(同 主进程 undici 不走 VPN 的老坑)。所以起 yt-dlp 前
 * 探测系统代理(env → Windows 注册表 → mac scutil),有就传 --proxy;
 * TUN/全局模式探不到代理也没关系,流量本来就被接管。
 */

import { spawn, spawnSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getUserDataPath } from '../platformAdapter';

const EXE = process.platform === 'win32' ? '.exe' : '';

function ytdlpDir(): string {
  return path.join(getUserDataPath(), 'runtimes', 'yt-dlp');
}

function ytdlpCachedPath(): string {
  return path.join(ytdlpDir(), `yt-dlp${EXE}`);
}

/** 背景视频缓存目录(一个背景只下一次,跨任务复用)。 */
export function bgCacheDir(): string {
  return path.join(getUserDataPath(), 'bg-cache');
}

function probeOnPath(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 探测系统代理(给 yt-dlp --proxy 用)。探不到返回 ''(直连,TUN/全局模式无需代理)。 */
export function detectSystemProxy(): string {
  // 1. 环境变量(大小写都看,Node 不归一)
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  // 2. Windows 注册表(规则型 VPN 常设系统代理在这)
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out);
      const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
      if (enabled && m && m[1]) {
        // 可能是 "host:port" 或 "http=host:port;https=host:port" 两种形态
        const raw = m[1];
        if (raw.includes('=')) {
          const https = raw.split(';').find((s) => s.startsWith('https='))?.slice(6)
            || raw.split(';').find((s) => s.startsWith('http='))?.slice(5);
          if (https) return `http://${https}`;
        } else {
          return `http://${raw}`;
        }
      }
    } catch { /* 读不到就当没有 */ }
  }
  // 3. macOS scutil
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 5000 });
      const enabled = /HTTPSEnable\s*:\s*1/.test(out);
      const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (enabled && host && port) return `http://${host}:${port}`;
    } catch { /* 同上 */ }
  }
  return '';
}

/** 下载 yt-dlp 单文件二进制到 userData 缓存。已存在直接返回。 */
async function ensureYtdlpDownloaded(downloadUrl: string, onLog?: (m: string) => void): Promise<string | null> {
  const dest = ytdlpCachedPath();
  if (fs.existsSync(dest)) return dest;
  try {
    fs.mkdirSync(ytdlpDir(), { recursive: true });
    onLog?.('⬇️ 首次使用:正在下载 yt-dlp(约 35MB,只下一次)…');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180_000);
    try {
      const res = await fetch(downloadUrl, { signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`yt-dlp download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) throw new Error(`yt-dlp download too small (${buf.length}B)`);
      const tmp = `${dest}.part`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, dest);
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    } finally {
      clearTimeout(timer);
    }
    onLog?.('✅ yt-dlp 下载完成');
    return dest;
  } catch (e) {
    onLog?.(`⚠️ yt-dlp 下载失败:${String((e as Error)?.message || e)}`);
    try { fs.unlinkSync(`${dest}.part`); } catch { /* 清理残留 */ }
    return null;
  }
}

let _ytdlpPath: string | null = null;

/**
 * 解析 yt-dlp 可执行路径;缓存没有则按需从 downloadUrl 下载。
 * 全部失败返回 null(调用方给用户明确报错,别让 spawn ENOENT 糊脸)。
 */
export async function getYtdlpPath(downloadUrl: string, onLog?: (m: string) => void): Promise<string | null> {
  if (_ytdlpPath) return _ytdlpPath;
  const envOverride = process.env.NOOBCLAW_YTDLP_PATH;
  if (envOverride && fs.existsSync(envOverride)) { _ytdlpPath = envOverride; return envOverride; }
  const cached = ytdlpCachedPath();
  if (fs.existsSync(cached)) { _ytdlpPath = cached; return cached; }
  if (probeOnPath('yt-dlp')) { _ytdlpPath = 'yt-dlp'; return 'yt-dlp'; }
  const downloaded = await ensureYtdlpDownloaded(downloadUrl, onLog);
  if (downloaded) { _ytdlpPath = downloaded; return downloaded; }
  return null;
}

/**
 * 确保某个 YouTube 背景视频已缓存,返回本地 mp4 路径。
 * 缓存 key = 背景 id(服务端清单换 URL 时改 id 即可强制重下)。
 * 失败返回 null(调用方回落到别的背景或报错)。
 */
export async function ensureBgVideo(
  bg: { id: string; url: string; label?: string },
  ytdlpUrl: string,
  onLog?: (m: string) => void,
  signal?: AbortSignal,
): Promise<string | null> {
  const outPath = path.join(bgCacheDir(), `thread-${bg.id}.mp4`);
  if (fs.existsSync(outPath)) {
    try { if (fs.statSync(outPath).size > 5_000_000) return outPath; } catch { /* 重下 */ }
  }
  const bin = await getYtdlpPath(ytdlpUrl, onLog);
  if (!bin) return null;

  fs.mkdirSync(bgCacheDir(), { recursive: true });
  const proxy = detectSystemProxy();
  const partPath = `${outPath}.dl`;
  // 抄 RedditVideoMakerBot 的格式选择(bestvideo ≤1080p mp4),背景不要音轨;
  // 多级 fallback 防某些视频没有独立视频流。
  const args = [
    '-f', 'bestvideo[height<=1080][ext=mp4]/best[height<=1080][ext=mp4]/best',
    '--no-playlist',
    '--retries', '5',
    '--force-overwrites',
    '-o', partPath,
    bg.url,
  ];
  if (proxy) args.unshift('--proxy', proxy);

  onLog?.(`⬇️ 下载背景「${bg.label || bg.id}」(约 1-2 小时的长视频,只下一次,请耐心)…`);
  const ok = await new Promise<boolean>((resolve) => {
    if (signal?.aborted) return resolve(false);
    const child = spawn(bin, args, { windowsHide: true });
    let settled = false;
    let lastPct = -10;
    const finish = (v: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    // 长视频最多给 30 分钟;背景是一次性成本,超时基本 = 网络不通
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } finish(false); }, 1_800_000);
    signal?.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } finish(false); }, { once: true });
    const onData = (b: Buffer) => {
      const m = b.toString().match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (m) {
        const pct = parseFloat(m[1]);
        if (pct - lastPct >= 10) { lastPct = pct; onLog?.(`⬇️ 背景下载 ${Math.floor(pct)}%`); }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });

  if (!ok) {
    try { fs.unlinkSync(partPath); } catch { /* 无残留 */ }
    onLog?.(`⚠️ 背景「${bg.label || bg.id}」下载失败(检查 VPN/代理是否可达 YouTube)`);
    return null;
  }
  // yt-dlp 对 -o xxx.dl 可能实际落地为 xxx.dl 或 xxx.dl.mp4(合流时),两个都探
  const actual = fs.existsSync(partPath) ? partPath : (fs.existsSync(`${partPath}.mp4`) ? `${partPath}.mp4` : '');
  if (!actual) return null;
  try { fs.renameSync(actual, outPath); } catch { return null; }
  onLog?.(`✅ 背景「${bg.label || bg.id}」已就绪`);
  return outPath;
}
