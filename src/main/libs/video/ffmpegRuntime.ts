/**
 * ffmpegRuntime — 解析并运行 ffmpeg。
 *
 * 解析顺序(第一个能跑通的胜出):
 *   1. 环境变量 NOOBCLAW_FFMPEG_PATH(显式覆盖)
 *   2. 打包后的 bundled 目录(resources/ffmpeg-<platform>/bin/…)—— M0 里塞进来
 *   3. userData/runtimes/ffmpeg-<platform>/bin/…(从 bundled 同步出来的)
 *   4. 系统 PATH 上的 ffmpeg(开发机直接用)
 *
 * 一期(开发/自测)走第 4 条:本机 choco 装的 ffmpeg 8.1。打包分发再补 M0 的
 * 资源内置(参考 pythonRuntime 的 bundle → 同步 → resolve 套路)。
 *
 * NOTE: 不再打包 ffprobe(单独一个二进制就近 100MB)。它原本只用来读
 * 时长 / 宽高 这类元数据,而 `ffmpeg -i <file>` 在 stderr 里同样会打印
 * `Duration:` 和视频流的 `WxH`,所以 probeDuration / probeImageSize 改成
 * 解析 ffmpeg 的 stderr,省掉了 ffprobe 这份冗余体积。
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isPackaged, getResourcesPath, getUserDataPath } from '../platformAdapter';

const PLATFORM_DIR = process.platform === 'win32'
  ? 'ffmpeg-win'
  : process.platform === 'darwin'
    ? 'ffmpeg-mac'
    : 'ffmpeg-linux';

const EXE = process.platform === 'win32' ? '.exe' : '';

function bundledBinDirs(): string[] {
  const dirs: string[] = [];
  // For each resource root, the binary may sit directly under
  // <root>/<platform>/bin/… or, on layouts that omit the bin subdir,
  // <root>/<platform>/… — probe both.
  const pushRoot = (root: string) => {
    dirs.push(path.join(root, PLATFORM_DIR, 'bin'));
    dirs.push(path.join(root, PLATFORM_DIR));
  };

  if (isPackaged()) {
    const res = getResourcesPath();
    const exeDir = path.dirname(process.execPath);

    // Tauri bundles resources via the `resources/**/*` glob, which PRESERVES
    // the leading `resources/` path segment. On Windows the resource root is
    // the install dir, so files land at <install>/resources/<platform>/… and
    // getResourcesPath() (== <install>/resources) lines up directly. On macOS
    // the resource root is already Contents/Resources, so the same glob nests
    // the payload one level deeper at Contents/Resources/resources/<platform>/…
    // while getResourcesPath() returns Contents/Resources — i.e. one segment
    // short. Probe BOTH the root and the nested `resources/` variant so we
    // resolve on every platform. This mirrors the dual-path walk that
    // nativeDesktopMac.ts already uses for the .node addon.
    pushRoot(res);
    pushRoot(path.join(res, 'resources'));

    // Belt-and-braces: walk relative to the sidecar binary too, covering the
    // macOS .app sibling layout if getResourcesPath ever returns a different
    // parent than expected.
    pushRoot(path.join(exeDir, 'resources'));
    pushRoot(path.join(exeDir, '..', 'Resources'));
    pushRoot(path.join(exeDir, '..', 'Resources', 'resources'));
  } else {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
    pushRoot(path.join(projectRoot, 'resources'));
  }
  // userData synced copy
  pushRoot(path.join(getUserDataPath(), 'runtimes'));
  return dirs;
}

function probeOnPath(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ['-version'], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

let _ffmpegPath: string | null = null;

function resolveBinary(
  name: 'ffmpeg',
  envVar: string,
): string {
  const envOverride = process.env[envVar];
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  const tried: string[] = [];
  for (const dir of bundledBinDirs()) {
    const candidate = path.join(dir, `${name}${EXE}`);
    tried.push(candidate);
    if (fs.existsSync(candidate)) {
      console.log(`[ffmpegRuntime] resolved ${name} → ${candidate} (packaged=${isPackaged()})`);
      return candidate;
    }
  }

  // System PATH — verify it actually runs before committing to it.
  if (probeOnPath(name)) {
    console.log(`[ffmpegRuntime] resolved ${name} → system PATH`);
    return name;
  }

  // Last resort: return the bare name; callers surface the spawn error.
  console.warn(
    `[ffmpegRuntime] could NOT resolve ${name} (packaged=${isPackaged()}); ` +
      `falling back to bare "${name}". Tried:\n  ${tried.join('\n  ')}`,
  );
  return name;
}

export function getFfmpegPath(): string {
  if (!_ffmpegPath) _ffmpegPath = resolveBinary('ffmpeg', 'NOOBCLAW_FFMPEG_PATH');
  return _ffmpegPath;
}

/** 一旦确认可用就记住:探测本身偶发超时(见下),不该让后续任务反复重判。 */
let _ffmpegAvailable: boolean | null = null;

/** ffmpeg 是否可用(spawn 能跑通 -version)。UI 不可用时给友好提示。
 *
 * ⚠️【2026-07-22 修「偶尔 ffmpeg 不可用」】原来单次 spawnSync -version、8s 超时、无重试、不缓存。
 *   Windows 上首次 spawn 内置 ffmpeg.exe 偶尔慢(Defender 首扫该 exe / 出片时系统繁忙)→ 探测超 8s
 *   → 误报不可用、任务第一步就挂(现象:开跑后恰好 8s 报错)。改为:① 成功结果缓存;② 超时放宽 20s
 *   + 重试一次;③ 探测失败但【解析到的是真实存在的二进制文件】→ 判可用(文件在,只是 spawn 慢),
 *   只有连文件都没有(裸名 / ENOENT)才真判不可用。 */
export function isFfmpegAvailable(): boolean {
  if (_ffmpegAvailable === true) return true;
  const p = getFfmpegPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = spawnSync(p, ['-version'], { stdio: 'ignore', timeout: 20000 });
      if (r.status === 0) { _ffmpegAvailable = true; return true; }
      console.warn(
        `[ffmpegRuntime] isFfmpegAvailable(try ${attempt + 1}): spawn of "${p}" returned ` +
          `status=${r.status} signal=${r.signal ?? 'none'}` +
          (r.error ? ` error=${String(r.error)}` : ''),
      );
    } catch (e) {
      console.warn(`[ffmpegRuntime] isFfmpegAvailable(try ${attempt + 1}): spawn of "${p}" threw ${String(e)}`);
    }
  }
  // 探测两次都没跑通,但解析到的是【真实存在的文件】(非裸 "ffmpeg")→ 判可用:文件明明在,
  //   多半只是首次 spawn 被杀软扫描/系统繁忙拖慢。只有连文件都没有才真判不可用。
  if (p !== 'ffmpeg') {
    let exists = false;
    try { exists = fs.existsSync(p); } catch { /* ignore */ }
    if (exists) {
      console.warn(`[ffmpegRuntime] isFfmpegAvailable: -version probe failed but binary file exists ("${p}"); treating as available`);
      _ffmpegAvailable = true;
      return true;
    }
  }
  return false;
}

export interface RunFfmpegOptions {
  /** 每行 stderr 回调(ffmpeg 的进度都打在 stderr)。 */
  onStderr?: (line: string) => void;
  /** 超时毫秒,默认 5 分钟。 */
  timeoutMs?: number;
  cwd?: string;
  /** 中断信号:abort 时立即 SIGKILL 子进程(用户「停止」视频任务)。 */
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

/** 模块级「当前视频任务中断信号」:composeVideo 设置后,本文件所有 runFfmpeg 调用
 *  (含内部 helper renderClipsBg 等十多处)在 abort 时统一 SIGKILL,无需逐个传参。
 *  单任务足够;并发多任务时以最后设置者为准(视频出片通常串行)。 */
let _videoAbortSignal: AbortSignal | undefined;
export function setVideoAbortSignal(s: AbortSignal | undefined): void { _videoAbortSignal = s; }

/** 跑一条 ffmpeg 命令。args 不含可执行名本身。 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<RunResult> {
  const bin = getFfmpegPath();
  return runProcess(bin, args, opts);
}

function runProcess(bin: string, args: string[], opts: RunFfmpegOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    // 中断信号:本次 opts.signal 优先,否则用模块级(composeVideo 设的当前任务 signal)。
    const sig = opts.signal ?? _videoAbortSignal;
    // 已被中断:不起进程,直接返回。
    if (sig?.aborted) { resolve({ ok: false, code: null, stderr: '[aborted]' }); return; }
    let settled = false;
    let stderr = '';
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true });

    // 用户「停止」→ 立即 SIGKILL,结束本条 ffmpeg。
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, code: null, stderr: stderr + '\n[aborted]' });
    };
    sig?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve({ ok: false, code: null, stderr: stderr + '\n[timeout]' });
      }
    }, opts.timeoutMs ?? 300_000);

    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      if (opts.onStderr) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) opts.onStderr(line);
        }
      }
      // keep memory bounded
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stderr: `${stderr}\n[spawn error] ${String(err)}` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr });
    });
  });
}

// `ffmpeg -i <file>`(不给输出)会以非 0 退出,但 stderr 里照样打印容器/流
// 元数据:`Duration: HH:MM:SS.ss` 和每条流的 `Video: …, WxH`。probeDuration /
// probeImageSize 解析这份 stderr,代替原来的 ffprobe(省掉一个 ~100MB 二进制)。
//
// stockProvider 对同一个下载文件会连着调 probeDuration + probeImageSize,所以
// 按 (path, mtime) 缓存一次 `ffmpeg -i` 的 stderr,避免重复起进程。mtime 变了
// 自动失效(文件被覆盖/重下时重新探)。
const _probeCache = new Map<string, { mtimeMs: number; stderr: string }>();

function runProbe(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    let mtimeMs = -1;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch {}
    if (mtimeMs >= 0) {
      const cached = _probeCache.get(filePath);
      if (cached && cached.mtimeMs === mtimeMs) return resolve(cached.stderr);
    }
    const child = spawn(getFfmpegPath(), ['-hide_banner', '-i', filePath], { windowsHide: true });
    let err = '';
    let settled = false;
    // ⚠️ 必须有超时:`ffmpeg -i` 对【坏文件】(防盗链返回的 HTML / 截断数据 — 下载海外图常见)
    //   有概率卡住不退出 → 没超时就永不 resolve → probeImageSize / downloadTo 整个卡死
    //   (热搜成片 / stock 配图都靠它探尺寸,曾表现为「准备画面素材」一直卡)。8s 足够探元数据。
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (mtimeMs >= 0) {
        _probeCache.set(filePath, { mtimeMs, stderr: err });
        // 粗暴限大小:超 256 条删最老的(Map 保留插入序)。
        if (_probeCache.size > 256) {
          const oldest = _probeCache.keys().next().value;
          if (oldest !== undefined) _probeCache.delete(oldest);
        }
      }
      resolve(err);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(); }, 8000);
    child.stderr?.on('data', (b: Buffer) => { err += b.toString(); });
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(''); } });
    child.on('close', () => finish());
  });
}

/** 出图片/视频首个视频流的宽高(解析 ffmpeg -i stderr)。失败返回 {width:0,height:0}。 */
export async function probeImageSize(filePath: string): Promise<{ width: number; height: number }> {
  const err = await runProbe(filePath);
  for (const line of err.split(/\r?\n/)) {
    if (!line.includes('Video:')) continue;
    // 形如 `… , 1920x1080 [SAR 1:1 DAR 16:9], …`;SAR/DAR 用冒号,不会误配 WxH。
    const m = line.match(/\b(\d{2,5})x(\d{2,5})\b/);
    if (m) return { width: parseInt(m[1], 10) || 0, height: parseInt(m[2], 10) || 0 };
  }
  return { width: 0, height: 0 };
}

/** 出媒体时长(秒)(解析 ffmpeg -i stderr 的 `Duration:`)。失败返回 0。 */
export async function probeDuration(filePath: string): Promise<number> {
  const err = await runProbe(filePath);
  // `Duration: N/A` 时正则不匹配 → 0(坏 clip / 非媒体,正是要过滤的)。
  const m = err.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!m) return 0;
  const sec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}
