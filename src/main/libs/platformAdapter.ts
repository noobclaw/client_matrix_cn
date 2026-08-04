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
 * Windows:http 的默认浏览器关联是不是【真的能用】。
 *
 * 顺序跟系统一致:先看用户选择(UserChoice.ProgId),没有再退回 HKCR\http。
 * 拿到 ProgId 后解析 `shell\open\command`,把命令行里的 exe 抠出来看文件在不在。
 * 任何一步断了都返回 false —— 宁可让上层用指纹内核开,也别静默什么都不做。
 * ⚠️ 只做静态体检,不启动进程,所以不会有副作用、也不会慢。
 */
function winUrlHandlerLooksUsable(): boolean {
  if (process.platform !== 'win32') return true;
  try {
    const { execFileSync } = require('child_process');
    const q = (key: string, val: string): string => {
      try {
        const out = String(execFileSync('reg', ['query', key, ...(val ? ['/v', val] : ['/ve']), ...['/reg:64']],
          { encoding: 'utf8', timeout: 4000, windowsHide: true }));
        // 形如:    ProgId    REG_SZ    ChromeHTML
        const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/m);
        return m ? m[1].trim() : '';
      } catch { return ''; }
    };
    const progId = q('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', 'ProgId')
      || q('HKCR\\http', '');
    if (!progId) return false;
    const cmd = q(`HKCR\\${progId}\\shell\\open\\command`, '');
    if (!cmd) return false;
    // 命令行首个 token 就是 exe:带引号取引号内,不带引号取到第一个空格前。
    const exe = cmd.startsWith('"') ? cmd.slice(1, cmd.indexOf('"', 1)) : cmd.split(/\s+/)[0];
    if (!exe) return false;
    return require('fs').existsSync(exe);
  } catch {
    // 体检本身失败(reg 不可用等)→ 不要因此把正常的打开也挡掉,按可用处理。
    return true;
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
        // ⚠️ `start` 走 ShellExecute:默认浏览器关联坏掉时它【照样退出码 0】,execSync 不抛,
        //    于是这里恒返回 true —— sidecar 的指纹内核兜底(只在 !opened 时触发)、renderer
        //    的 opener 插件 / window.open / 「打开链接失败」弹窗【全都进不去】。用户看到的就是
        //    「toast 一闪,什么都没发生,连报错都没有」。macOS 那支早就会抓 stderr 判错,
        //    Windows 这支一直裸奔。
        //    这里补一道【事前体检】:把 http 的默认关联解析到真实 exe,解析不出来或文件不在
        //    就直接判失败,让内核兜底有机会接手。(能启动但自己崩掉的浏览器仍检测不到 ——
        //    那种只能靠 renderer 那个手动出口。)
        if (!winUrlHandlerLooksUsable()) {
          console.warn('[platformAdapter] Windows 默认浏览器关联不可用,交给上层兜底');
          return false;
        }
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
