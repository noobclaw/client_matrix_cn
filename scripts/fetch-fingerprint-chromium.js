/**
 * fetch-fingerprint-chromium — 下载 adryfish/fingerprint-chromium 引擎级指纹内核
 * 进 resources/ 供打包。BUILD 时跑(CI 或本地),不是 runtime。
 *
 * 下载落地 `resources/fingerprint-chromium-<platform>/`;prepare-tauri-resources.js
 * 再拷进 `src-tauri/resources/` 让 Tauri bundle。运行时 kernelPool.resolveBundledKernel()
 * 解析:win → <dir>/chrome.exe;mac → <dir>/Chromium.app/Contents/MacOS/Chromium。
 *
 * 版本:win 用最新 144;mac 作者不是每版都出,最近 mac 构建是 142 → mac 固定 142。
 * Linux:暂 no-op(build 只跑 win+mac)。
 * 幂等:目标已存在则跳过。
 *
 * ⚠️ macOS:bundle 的 Chromium 含大量嵌套 Mach-O,打包后必须在 build-tauri.yml 里
 *    用 Developer ID 重签(codesign --deep --force --timestamp --options runtime),
 *    否则整个 app 公证失败。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

const WIN_URL = 'https://github.com/adryfish/fingerprint-chromium/releases/download/144.0.7559.132/ungoogled-chromium_144.0.7559.132-1.1_windows_x64.zip';
const MAC_URL = 'https://github.com/adryfish/fingerprint-chromium/releases/download/142.0.7444.175/ungoogled-chromium_142.0.7444.175-1.1_macos.dmg';

function targetTriple() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.SIDECAR_TARGET) return process.env.SIDECAR_TARGET;
  try { return execSync('rustc --print host-tuple', { encoding: 'utf8' }).trim(); }
  catch {
    if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
    if (process.platform === 'darwin') return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    return 'x86_64-unknown-linux-gnu';
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(full, name); if (hit) return hit; }
    else if (e.name.toLowerCase() === name.toLowerCase()) return full;
  }
  return null;
}
function findDirEndingWith(dir, suffix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name.toLowerCase().endsWith(suffix)) return path.join(dir, e.name);
      const hit = findDirEndingWith(path.join(dir, e.name), suffix);
      if (hit) return hit;
    }
  }
  return null;
}
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isSymbolicLink()) { try { fs.symlinkSync(fs.readlinkSync(s), d); } catch { fs.copyFileSync(s, d); } }
    else fs.copyFileSync(s, d);
  }
}
function scratch() {
  const base = process.env.FFMPEG_FETCH_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'noobclaw-fpc-'));
}

function fetchWindows() {
  const dest = path.join(ROOT, 'resources', 'fingerprint-chromium-win');
  if (fs.existsSync(path.join(dest, 'chrome.exe'))) { console.log('[fpc] win already present, skip'); return; }
  const tmp = scratch();
  const zip = path.join(tmp, 'fpc-win.zip');
  const ex = path.join(tmp, 'ex'); fs.mkdirSync(ex, { recursive: true });
  console.log('[fpc] downloading win', WIN_URL);
  execSync(`curl -L --fail --retry 3 -o "${zip}" "${WIN_URL}"`, { stdio: 'inherit' });
  console.log('[fpc] extracting…');
  execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zip}' -DestinationPath '${ex}' -Force"`, { stdio: 'inherit' });
  const chromeExe = findFile(ex, 'chrome.exe');
  if (!chromeExe) throw new Error('chrome.exe not found in win zip');
  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(path.dirname(chromeExe), dest); // 整个内核目录(chrome.exe + dll + 资源)
  console.log('[fpc] ✓ win →', dest);
}

function fetchMac() {
  // mac:打成 .tgz(数据文件,不参与公证) → 运行时首次本地解压。彻底绕开
  // "给 notarized app 里的 Chromium 逐个嵌套签名" 的地狱。
  const tgz = path.join(ROOT, 'resources', 'fingerprint-chromium-mac.tgz');
  if (fs.existsSync(tgz)) { console.log('[fpc] mac tgz already present, skip'); return; }
  const tmp = scratch();
  const dmg = path.join(tmp, 'fpc-mac.dmg');
  console.log('[fpc] downloading mac', MAC_URL);
  execSync(`curl -L --fail --retry 3 -o "${dmg}" "${MAC_URL}"`, { stdio: 'inherit' });
  const mnt = path.join(tmp, 'mnt');
  fs.mkdirSync(mnt, { recursive: true });
  console.log('[fpc] mounting dmg…');
  execSync(`hdiutil attach "${dmg}" -nobrowse -readonly -mountpoint "${mnt}"`, { stdio: 'inherit' });
  const stage = path.join(tmp, 'stage');
  fs.mkdirSync(stage, { recursive: true });
  try {
    const app = findDirEndingWith(mnt, '.app');
    if (!app) throw new Error('.app not found in mac dmg');
    // 统一命名 Chromium.app;cp -R 保留 framework 符号链接
    const appStage = path.join(stage, 'Chromium.app');
    execSync(`cp -R "${app}" "${appStage}"`, { stdio: 'inherit' });
    const macosDir = path.join(appStage, 'Contents', 'MacOS');
    if (!fs.existsSync(path.join(macosDir, 'Chromium'))) {
      const first = fs.readdirSync(macosDir)[0];
      if (first) execSync(`ln -sf "${first}" "${path.join(macosDir, 'Chromium')}"`, { stdio: 'inherit' });
    }
    fs.mkdirSync(path.dirname(tgz), { recursive: true });
    // tar 保留符号链接;-C stage 让包内顶层就是 Chromium.app
    execSync(`tar -czf "${tgz}" -C "${stage}" Chromium.app`, { stdio: 'inherit' });
    console.log(`[fpc] ✓ mac tgz (${Math.round(fs.statSync(tgz).size/1024/1024)}MB) →`, tgz);
  } finally {
    try { execSync(`hdiutil detach "${mnt}"`, { stdio: 'inherit' }); } catch { /* ignore */ }
  }
}

const triple = targetTriple();
console.log('[fpc] target:', triple);
if (triple.includes('windows')) fetchWindows();
else if (triple.includes('darwin') || triple.includes('apple')) fetchMac();
else console.log('[fpc] linux/other — no-op (falls back to system chrome at runtime)');
