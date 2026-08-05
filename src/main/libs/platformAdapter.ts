/**
 * Platform Adapter — abstracts Electron-specific APIs.
 * In Electron mode: uses real Electron APIs.
 * In Tauri sidecar mode: uses Node.js equivalents.
 *
 * This allows CoworkRunner and other libs to work in both modes.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { MATRIX_EDITION } from '../matrixEdition';

// ── Mode detection ──

let _mode: 'electron' | 'sidecar' | null = null;

/**
 * Detect which runtime we are in.
 *
 * Historical implementation:
 *   try { require('electron'); _mode = 'electron' } catch { _mode = 'sidecar' }
 *
 * That looked sensible but was wrong in packaged Tauri mode. The Tauri
 * sidecar is produced by esbuild-bundling then running @yao-pkg/pkg, which
 * walks all reachable requires in the bundle and snapshots them into the
 * single exe. Because this repo also targets Electron, `electron` is in
 * node_modules and gets snapshotted alongside everything else — strings
 * of the installed noobclaw-server.exe show:
 *   C:\snapshot\client\node_modules\electron\index.js
 * So `require('electron')` SUCCEEDS inside the Tauri sidecar, the detector
 * returns 'electron', and every `if (isElectronMode())` branch in the whole
 * codebase takes the wrong path. That is how registerNativeMessagingHost
 * kept writing the Electron-flavored bat (pointing at a nonexistent
 * `D:\NoobClaw\node-runtime\node.exe`) even after I switched the else
 * branch to the `--native-messaging-host` sidecar invocation — the else
 * branch was simply never taken.
 *
 * Reliable signals instead:
 *   1. `process.versions.electron` — only set when running inside an
 *      actual Electron runtime (ELECTRON_RUN_AS_NODE does NOT set it),
 *      true for both main and renderer processes, false in plain Node
 *      and in pkg-bundled Node.
 *   2. `process.type` — Electron populates it with 'browser', 'renderer',
 *      or 'worker'. Additional redundant check in case electron changes.
 */
export function getPlatformMode(): 'electron' | 'sidecar' {
  if (_mode) return _mode;

  const isElectronRuntime =
    !!(process as NodeJS.Process & { versions?: { electron?: string } }).versions?.electron
    || !!(process as NodeJS.Process & { type?: string }).type;

  _mode = isElectronRuntime ? 'electron' : 'sidecar';
  return _mode;
}

export function isElectronMode(): boolean {
  return getPlatformMode() === 'electron';
}

export function isSidecarMode(): boolean {
  return getPlatformMode() === 'sidecar';
}

// ── app.getPath() equivalent ──

export function getUserDataPath(): string {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.getPath('userData');
    } catch {}
  }

  // Sidecar fallback: standard OS paths.
  // 矩阵 edition 用独立目录(NoobClawMatrix),与旧 client 的 NoobClaw 彻底分开,
  // 否则两个 app 的 sidecar 共享同一任务库 → 矩阵 app 会误读并自动跑旧 scenario 任务。
  const dirName = MATRIX_EDITION ? 'NoobClawMatrix' : 'NoobClaw';
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), dirName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', dirName);
  }
  return path.join(os.homedir(), MATRIX_EDITION ? '.noobclaw-matrix' : '.noobclaw');
}

// ── app.getPath('home') equivalent ──

export function getHomePath(): string {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.getPath('home');
    } catch {}
  }
  return os.homedir();
}

// ── app.getName() equivalent ──

export function getAppName(): string {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.getName();
    } catch {}
  }
  return 'NoobClaw';
}

// ── app.isPackaged equivalent ──

export function isPackaged(): boolean {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.isPackaged;
    } catch {}
  }
  // Sidecar: always "packaged" (running as compiled binary)
  return true;
}

// ── app.getAppPath() equivalent ──

export function getAppPath(): string {
  if (isElectronMode()) {
    try {
      const { app } = require('electron');
      return app.getAppPath();
    } catch {}
  }
  // Sidecar: use process.cwd() or __dirname
  return process.cwd();
}

// ── resourcesPath equivalent ──

/**
 * Locate the bundled `resources/` directory next to the sidecar binary.
 *
 * Previous implementation just took `path.dirname(process.execPath)` and
 * `fs.existsSync(dir + '/resources')` — under @yao-pkg/pkg that `existsSync`
 * probe sometimes returned false for real-filesystem Windows drive paths, so
 * the function silently fell back to `process.execPath`'s parent, and in
 * some launch contexts (Tauri started from Start Menu inheriting
 * `C:\Windows\System32` as cwd) other code paths then joined against cwd
 * and wrote native-messaging-host files into System32. That is how the
 * Chrome extension ended up with a manifest pointing to
 * `C:\Windows\system32\native-messaging-host.bat` in the wild.
 *
 * New behavior: walk an ordered candidate list and return the first one
 * that actually exists. Never return an unverified path. When nothing
 * works, fall through to `path.dirname(process.execPath)` as a last resort.
 */
export function getResourcesPath(): string {
  if (isElectronMode()) {
    try {
      return process.resourcesPath || getAppPath();
    } catch {}
  }

  const tried: string[] = [];
  const tryDir = (dir: string | null | undefined): string | null => {
    if (!dir) return null;
    tried.push(dir);
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {}
    return null;
  };

  // 1. Next to the sidecar binary (normal Tauri install layout on all OS)
  try {
    const exeDir = path.dirname(process.execPath);
    const hit = tryDir(path.join(exeDir, 'resources'));
    if (hit) return hit;
  } catch {}

  // 2. macOS .app bundle layout — if the sidecar sits in
  //    Contents/MacOS/, the Resources dir is a sibling.
  try {
    const exeDir = path.dirname(process.execPath);
    if (path.basename(exeDir) === 'MacOS') {
      const hit = tryDir(path.join(path.dirname(exeDir), 'Resources'));
      if (hit) return hit;
    }
  } catch {}

  // 3. Windows: some Tauri perMachine installs drop resources at the
  //    install root, not in a `resources/` subdir.
  try {
    const exeDir = path.dirname(process.execPath);
    const hit = tryDir(exeDir);
    if (hit && fs.existsSync(path.join(exeDir, 'native-messaging-host.js'))) return hit;
  } catch {}

  // 4. `tauri dev` runs the sidecar from the project root — try cwd/resources.
  try {
    const hit = tryDir(path.join(process.cwd(), 'resources'));
    if (hit) return hit;
  } catch {}

  // 5. Last resort: dirname of execPath, even if we haven't verified it.
  //    Log so we know the robust chain failed and the caller can see it
  //    via coworkLog if they import it later.
  const fallback = (() => {
    try { return path.dirname(process.execPath); } catch { return process.cwd(); }
  })();
  try {
    // eslint-disable-next-line no-console
    console.warn(`[platformAdapter] getResourcesPath: no candidate existed, falling back to ${fallback}. Tried: ${tried.join(' | ')}`);
  } catch {}
  return fallback;
}

// ── shell.openExternal() equivalent ──

/**
 * Windows:找一个【系统上本来就有】的浏览器 exe,给默认关联坏掉时兜底。
 *
 * 之所以要有这层:关联一坏,原来就直接跳到「用指纹内核开」,内核没装就彻底没辙 ——
 * 用户只是想点开一个网页,却被要求先装个几百 MB 的浏览器内核(用户 2026-08-05 实测,
 * 而且他机器上 Edge 明明好好的)。Windows 自带 Edge,先用它,内核降为最后一手。
 * 只返回确实存在的路径,不启动进程。
 */
function winFallbackBrowser(): string {
  if (process.platform !== 'win32') return '';
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  const cands = [
    `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,   // Edge 常态就装在 x86 目录
    `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',   // 单用户装的 Chrome
    `${pf}\\Mozilla Firefox\\firefox.exe`,
    `${pf86}\\Mozilla Firefox\\firefox.exe`,
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* 下一个 */ } }
  return '';
}

/**
 * 绕开系统的 URL 关联,直接用机器上现成的浏览器 exe 打开。
 *
 * 给「系统那条点了没反应」的手动出口用:那种假成功(ShellExecute 退出码 0 却没弹窗)从调用方
 * 检测不到,但指定 exe 拉起来是另一条路,通常就能开。这一步不需要用户装任何东西 ——
 * 指纹内核只在这条也不行时才该出场。
 */
export function openUrlWithAnyBrowser(url: string): boolean {
  try {
    const b = winFallbackBrowser();
    if (!b) return false;
    const { execFile } = require('child_process');
    execFile(b, [url], { windowsHide: false }, () => { /* detached, 不等 */ });
    console.log('[platformAdapter] opened via', b);
    return true;
  } catch (e) {
    console.warn('[platformAdapter] openUrlWithAnyBrowser failed:', e);
    return false;
  }
}

export async function openExternal(url: string): Promise<boolean> {
  if (isElectronMode()) {
    try {
      const { shell } = require('electron');
      // shell.openPath for local paths (opens in explorer/finder); openExternal for URLs
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
        await shell.openExternal(url);
      } else {
        await shell.openPath(url);
      }
      return true;
    } catch {}
  }

  // Sidecar fallback: use OS-specific commands
  try {
    if (process.platform === 'win32') {
      // Windows:
      //   - `cmd /c start` chokes on Chinese paths (cp936 vs UTF-8 mismatch)
      //   - `execFile('explorer.exe', [path])` passes args via UTF-16 wire, no codepage issue
      // Use explorer for local paths, cmd start for URLs.
      const { execFile } = require('child_process');
      if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
        // 🚨【这里出过一次回归,别再动】
        //   Windows 打开外链从来就是这一句 `start`,一直好用(用户实测 3.4.6 正常)。
        //   2026-08-04 为了修 macOS「点了没反应也不报错」,顺手给 Windows 也加了一道
        //   【关联体检】,体检不过就跳去指纹内核 —— 而那个体检靠 reg.exe,它在 Node 里
        //   【本来就可能调不通】(本机实测 execFileSync/spawnSync/execSync 四种方式全报
        //   「无效项名」,同一条命令在 PowerShell 里却正常)。于是体检恒判死、start 一次都不走,
        //   没装内核的人彻底打不开链接 —— Windows 本来没病,是被修 mac 的药毒到的。
        //   已回退成原样。要再动这里,先想清楚【Windows 到底出了什么问题】,
        //   别为了别的平台的毛病给它加判断。
        //   (打不开时的出口仍在:提示条那条手动入口会用系统现成的浏览器直开,见 openUrlWithAnyBrowser。)
        execSync(`start "" "${url}"`, { windowsHide: true });
      } else {
        execFile('explorer.exe', [url], { windowsHide: false }, () => {});
      }
    } else if (process.platform === 'darwin') {
      // 不只看退出码:LaunchServices 损坏时 `open` 可能 exit 0 但打印错误(或啥都不干)。
      // 捕获 stderr,出现错误字样也判失败 —— 让 sidecar 的指纹内核兜底有机会接手。
      // (「exit 0 + 零输出 + 没弹窗」的纯静默失败仍无法从调用方检测,只能修系统。)
      const { spawnSync } = require('child_process');
      const r = spawnSync('open', [url], { encoding: 'utf8', timeout: 15_000 });
      const errText = String(r.stderr || '');
      if (r.status !== 0 || /unable to find|lsopen|does not exist|error/i.test(errText)) {
        console.warn('[platformAdapter] open failed:', r.status, errText.slice(0, 200));
        return false;
      }
    } else {
      execSync(`xdg-open "${url}"`);
    }
    return true;
  } catch {
    return false;
  }
}

// ── Ensure data directories exist ──

export function ensureDataDirs(): void {
  const dirs = [
    getUserDataPath(),
    path.join(getUserDataPath(), 'logs'),
    path.join(getUserDataPath(), 'cowork'),
    path.join(getUserDataPath(), 'cowork', 'bin'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
