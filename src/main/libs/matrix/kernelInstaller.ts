/**
 * 指纹内核安装器(B1 + 多版本管理,对标 AdsPower/比特的内核管理)。
 *
 * 内核不 bundle 进包(包小)。admin 在 system_config.matrix_kernels 配版本列表(每项
 * {version,platform,url,label}),客户端按需从自家 OSS 下载到
 *   userData/runtimes/fingerprint-chromium-<platkey>-<version>/
 * 支持多版本共存;每个账号可绑定一个版本(指纹稳定)。
 *   · win:.zip → Expand-Archive → chrome.exe
 *   · mac:.dmg → hdiutil 挂载 → 拷 Chromium.app → 卸载
 * 下载内核不在 app 包里 → 不参与公证;运行时 spawn 直接拉起(不过 Gatekeeper)。
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getUserDataPath } from '../platformAdapter';
import { coworkLog } from '../coworkLogger';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }

const PLATKEY = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';

export interface KernelEntry { version: string; platform: string; url: string; label: string; installed?: boolean }

function runtimesDir(): string { return path.join(getUserDataPath(), 'runtimes'); }
function versionDir(version: string): string { return path.join(runtimesDir(), `fingerprint-chromium-${PLATKEY}-${version}`); }
function exeIn(dir: string): string {
  return process.platform === 'win32' ? path.join(dir, 'chrome.exe')
    : process.platform === 'darwin' ? path.join(dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
    : path.join(dir, 'chrome');
}

/** 某版本的内核可执行路径;不传 version 则返回任意一个已装版本(没有则 null)。 */
export function installedKernelPath(version?: string): string | null {
  try {
    if (version) { const e = exeIn(versionDir(version)); return fs.existsSync(e) ? e : null; }
    const base = runtimesDir();
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (d.startsWith(`fingerprint-chromium-${PLATKEY}-`)) {
          const e = exeIn(path.join(base, d));
          if (fs.existsSync(e)) return e;
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function fetchKernels(): Promise<KernelEntry[]> {
  try {
    const r = await fetch(`${baseUrl()}/api/matrix/kernel`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [];
    const j: any = await r.json();
    const list: any[] = Array.isArray(j.kernels) ? j.kernels : [];
    return list.filter((k) => k && k.platform === PLATKEY)
      .map((k) => ({ version: String(k.version), platform: String(k.platform), url: String(k.url), label: String(k.label || `${k.platform} ${k.version}`) }));
  } catch { return []; }
}

/** 已装的内核版本(单版本模式下最多一个);没有则 null。 */
export function installedVersion(): string | null {
  try {
    const base = runtimesDir();
    if (!fs.existsSync(base)) return null;
    const prefix = `fingerprint-chromium-${PLATKEY}-`;
    for (const d of fs.readdirSync(base)) {
      if (d.startsWith(prefix) && fs.existsSync(exeIn(path.join(base, d)))) return d.slice(prefix.length);
    }
  } catch { /* ignore */ }
  return null;
}

/** 内核状态(单版本):是否已装 / 已装版本 / 后端配置版本 / 是否需更新。 */
export async function kernelInfo(): Promise<{ installed: boolean; installedVersion: string; configuredVersion: string; needsUpdate: boolean }> {
  const inst = installedVersion() || '';
  const list = await fetchKernels();
  const cfg = list[0]?.version || '';
  return { installed: !!inst, installedVersion: inst, configuredVersion: cfg, needsUpdate: !!(inst && cfg && inst !== cfg) };
}

type ProgressFn = (pct: number, msg: string) => void;

function findFile(dir: string, name: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(full, name); if (hit) return hit; }
    else if (e.name.toLowerCase() === name.toLowerCase()) return full;
  }
  return null;
}
function findDirEndingWith(dir: string, suffix: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.toLowerCase().endsWith(suffix)) return path.join(dir, e.name);
      const hit = findDirEndingWith(path.join(dir, e.name), suffix);
      if (hit) return hit;
    }
  }
  return null;
}

const mb = (n: number) => Math.round(n / 1048576);

async function download(url: string, dest: string, onProgress?: ProgressFn): Promise<boolean> {
  let res: Response;
  try { res = await fetch(url); }
  catch (e: any) { onProgress?.(0, '网络错误:' + String(e?.message || e).slice(0, 80)); return false; }
  if (!res.ok || !res.body) { onProgress?.(0, `下载失败 HTTP ${res.status}`); return false; }

  const total = Number(res.headers.get('content-length') || 0); // CDN/chunked 可能为 0
  const out = fs.createWriteStream(dest);
  let writeErr: Error | null = null;
  out.on('error', (e) => { writeErr = e; }); // 磁盘满/无权限:捕获,避免 uncaught 崩 sidecar
  let got = 0, lastTick = 0;
  try {
    const reader = (res.body as any).getReader();
    for (;;) {
      if (writeErr) throw writeErr;
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      // 背压:write 返回 false 时等 drain(否则大文件内存堆积)
      if (!out.write(buf)) {
        await new Promise<void>((resolve, reject) => {
          out.once('drain', resolve);
          out.once('error', reject);
        });
      }
      got += buf.length;
      const now = Date.now();
      if (now - lastTick > 300) {
        lastTick = now;
        if (total) onProgress?.(Math.round((got / total) * 100), `下载内核 ${mb(got)}/${mb(total)}MB`);
        else onProgress?.(50, `下载内核 ${mb(got)}MB…`); // 无 content-length:显示已下字节
      }
    }
    if (writeErr) throw writeErr;
    await new Promise<void>((resolve, reject) => { out.end(() => resolve()); out.once('error', reject); });
    if (total && got < total) { onProgress?.(0, `下载不完整 ${mb(got)}/${mb(total)}MB`); return false; }
    return true;
  } catch (e: any) {
    try { out.destroy(); } catch { /* ignore */ }
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    onProgress?.(0, '下载中断:' + String(e?.message || e).slice(0, 80));
    return false;
  }
}

/**
 * 确保指定版本内核就绪(已装则直接返回路径;否则下载+解压)。
 * version 不传 → 用列表里第一个版本。返回可执行路径或 null。
 */
export async function ensureKernel(version?: string, onProgress?: ProgressFn): Promise<string | null> {
  const list = await fetchKernels();
  const entry = version ? list.find((k) => k.version === version) : list[0];
  if (!entry) { onProgress?.(0, '后端未配置可用内核版本(matrix_kernels)'); return null; }

  const have = installedKernelPath(entry.version);
  if (have) { onProgress?.(100, '内核已就绪'); return have; }

  const d = versionDir(entry.version);
  fs.mkdirSync(runtimesDir(), { recursive: true });
  const tmp = path.join(runtimesDir(), `_k-${entry.version}.${process.platform === 'win32' ? 'zip' : 'dmg'}`);
  onProgress?.(0, `开始下载内核 ${entry.label}…`);
  try {
    const ok = await download(entry.url, tmp, onProgress);
    if (!ok) return null;
    onProgress?.(100, '下载完成,正在解压…');

    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });

    if (process.platform === 'win32') {
      // 先解到临时目录,再把"含 chrome.exe 的那层目录"整体 rename 成 d(原子,
      // 避免逐项搬动的 EEXIST,且不论 zip 顶层嵌套几层都对)。
      const exDir = `${d}_ex`;
      fs.rmSync(exDir, { recursive: true, force: true });
      fs.mkdirSync(exDir, { recursive: true });
      const ps = (p: string) => p.replace(/'/g, "''"); // PowerShell 单引号转义(用户名含 ' 时)
      const ex = spawnSync('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${ps(tmp)}' -DestinationPath '${ps(exDir)}' -Force`], { stdio: 'ignore' });
      if (ex.status !== 0) coworkLog('ERROR', 'kernelInstaller', 'Expand-Archive failed', { status: ex.status, err: String(ex.error || '') });
      const chromeExe = findFile(exDir, 'chrome.exe');
      if (chromeExe) {
        fs.rmSync(d, { recursive: true, force: true });
        fs.renameSync(path.dirname(chromeExe), d); // 整个内核根目录搬到 d
      }
      fs.rmSync(exDir, { recursive: true, force: true });
    } else if (process.platform === 'darwin') {
      const mnt = path.join(runtimesDir(), `_mnt-${entry.version}`);
      try { spawnSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' }); } catch { /* 清上次残留挂载 */ }
      fs.mkdirSync(mnt, { recursive: true });
      const att = spawnSync('hdiutil', ['attach', tmp, '-nobrowse', '-readonly', '-mountpoint', mnt], { stdio: 'ignore' });
      if (att.status !== 0) coworkLog('ERROR', 'kernelInstaller', 'hdiutil attach failed', { status: att.status, err: String(att.error || '') });
      try {
        const app = findDirEndingWith(mnt, '.app');
        if (app) {
          spawnSync('cp', ['-R', app, path.join(d, 'Chromium.app')], { stdio: 'ignore' });
          const macos = path.join(d, 'Chromium.app', 'Contents', 'MacOS');
          if (fs.existsSync(macos) && !fs.existsSync(path.join(macos, 'Chromium'))) {
            const first = fs.readdirSync(macos)[0];
            if (first) spawnSync('ln', ['-sf', first, path.join(macos, 'Chromium')], { stdio: 'ignore' });
          }
        }
      } finally {
        spawnSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' });
      }
      spawnSync('xattr', ['-cr', path.join(d, 'Chromium.app')], { stdio: 'ignore' });
      try { fs.chmodSync(path.join(d, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), 0o755); } catch { /* ignore */ }
    }

    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    const exe = installedKernelPath(entry.version);
    // 单版本模式:装好新版后清掉其它版本目录,只留当前(省空间 + launch 不会误用旧版)。
    if (exe) {
      const prefix = `fingerprint-chromium-${PLATKEY}-`;
      const keep = `${prefix}${entry.version}`;
      try {
        for (const dd of fs.readdirSync(runtimesDir())) {
          if (dd.startsWith(prefix) && dd !== keep) fs.rmSync(path.join(runtimesDir(), dd), { recursive: true, force: true });
        }
      } catch { /* ignore */ }
    }
    onProgress?.(100, exe ? `内核就绪 (${entry.label})` : '解压后未找到内核(格式异常)');
    if (!exe) coworkLog('ERROR', 'kernelInstaller', 'kernel exe not found after extract', { version: entry.version });
    return exe;
  } catch (e: any) {
    onProgress?.(0, '内核安装失败:' + String(e?.message || e).slice(0, 100));
    coworkLog('ERROR', 'kernelInstaller', 'ensureKernel failed', { err: String(e) });
    return null;
  }
}
