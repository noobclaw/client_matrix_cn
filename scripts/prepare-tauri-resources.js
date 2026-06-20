/**
 * Prepare resources for Tauri bundling.
 * Copies SKILLs, tray icons, system prompt, and WASM
 * into src-tauri/resources/ so Tauri can bundle them without ../  paths
 * (which create _up_ directories in NSIS installers).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(ROOT, 'src-tauri', 'resources');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules in skills to reduce size
      if (entry.name === 'node_modules') {
        // Only copy node_modules for skills that need them (web-search, pptx, etc)
        copyDirRecursive(srcPath, destPath);
      } else {
        count += copyDirRecursive(srcPath, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

function main() {
  console.log('Preparing Tauri resources...');

  // Clean previous resources
  if (fs.existsSync(RESOURCES_DIR)) {
    fs.rmSync(RESOURCES_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(RESOURCES_DIR, { recursive: true });

  // 1. SKILLs
  const skillsSrc = path.join(ROOT, 'SKILLs');
  const skillsDest = path.join(RESOURCES_DIR, 'SKILLs');
  const skillCount = copyDirRecursive(skillsSrc, skillsDest);
  console.log(`  SKILLs: ${skillCount} files`);

  // 2. Tray icons (chrome-extension is no longer bundled — users install
  //    the NoobClaw Browser Assistant from Chrome / Firefox / Edge stores)
  const traySrc = path.join(ROOT, 'resources', 'tray');
  const trayDest = path.join(RESOURCES_DIR, 'tray');
  const trayCount = copyDirRecursive(traySrc, trayDest);
  console.log(`  tray: ${trayCount} files`);

  // 3. System prompt
  const promptSrc = path.join(ROOT, 'sandbox', 'agent-runner', 'AGENT_SYSTEM_PROMPT.md');
  if (fs.existsSync(promptSrc)) {
    const promptDest = path.join(RESOURCES_DIR, 'AGENT_SYSTEM_PROMPT.md');
    fs.copyFileSync(promptSrc, promptDest);
    console.log('  AGENT_SYSTEM_PROMPT.md: copied');
  }

  // 4. sql-wasm.wasm (from sidecar build)
  const wasmSrc = path.join(ROOT, 'src-tauri', 'binaries', 'sql-wasm.wasm');
  if (fs.existsSync(wasmSrc)) {
    fs.copyFileSync(wasmSrc, path.join(RESOURCES_DIR, 'sql-wasm.wasm'));
    console.log('  sql-wasm.wasm: copied');
  }

  // 4b. macOS native desktop addon (compiled by node-gyp before this step
  //     runs; see .github/workflows/build-tauri.yml). The .node file is
  //     only built on macOS — Windows and Linux skip silently. The
  //     sidecar loader in src/main/libs/nativeDesktopMac.ts looks for
  //     this file at <resources>/native/noobclaw_desktop.node at runtime.
  if (process.platform === 'darwin') {
    const nodeAddonSrc = path.join(
      ROOT,
      'native',
      'macos-desktop',
      'build',
      'Release',
      'noobclaw_desktop.node'
    );
    if (fs.existsSync(nodeAddonSrc)) {
      const nativeDestDir = path.join(RESOURCES_DIR, 'native');
      fs.mkdirSync(nativeDestDir, { recursive: true });
      const nodeAddonDest = path.join(nativeDestDir, 'noobclaw_desktop.node');
      fs.copyFileSync(nodeAddonSrc, nodeAddonDest);
      const sizeKb = Math.round(fs.statSync(nodeAddonDest).size / 1024);
      console.log(`  native/noobclaw_desktop.node: copied (${sizeKb} KB)`);
    } else {
      console.warn(
        '  native/noobclaw_desktop.node: NOT FOUND — sidecar will fall back to osascript. ' +
          'Build it first with: cd native/macos-desktop && npm install && npm run build'
      );
    }
  }

  // 4c. Windows native desktop addon — same pattern as 4b but for the
  //     C++ BitBlt/SendInput addon built from native/win-desktop/. The
  //     sidecar loader at src/main/libs/nativeDesktopWin.ts looks for
  //     the .node file in the same <resources>/native/ directory.
  if (process.platform === 'win32') {
    const winAddonSrc = path.join(
      ROOT,
      'native',
      'win-desktop',
      'build',
      'Release',
      'noobclaw_desktop_win.node'
    );
    if (fs.existsSync(winAddonSrc)) {
      const nativeDestDir = path.join(RESOURCES_DIR, 'native');
      fs.mkdirSync(nativeDestDir, { recursive: true });
      const winAddonDest = path.join(nativeDestDir, 'noobclaw_desktop_win.node');
      fs.copyFileSync(winAddonSrc, winAddonDest);
      const sizeKb = Math.round(fs.statSync(winAddonDest).size / 1024);
      console.log(`  native/noobclaw_desktop_win.node: copied (${sizeKb} KB)`);
    } else {
      console.warn(
        '  native/noobclaw_desktop_win.node: NOT FOUND — sidecar will fall back to PowerShell. ' +
          'Build it first with: cd native/win-desktop && npm install && npm run build'
      );
    }
  }

  // 5. Native messaging host JS source only. The .bat / .sh wrappers are
  //    generated at runtime by registerNativeMessagingHost() using absolute
  //    paths derived from the actual install location, and in Tauri mode
  //    the wrapper just calls `noobclaw-server.exe --native-messaging-host`
  //    so it does not even need the .js file to exist on disk. We still
  //    ship the .js for Electron builds that may share this resource dir.
  {
    const name = 'native-messaging-host.js';
    const candidates = [
      path.join(ROOT, 'resources', name),
      path.join(ROOT, name),
    ];
    for (const src of candidates) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(RESOURCES_DIR, name));
        console.log(`  ${name}: copied from ${src}`);
        break;
      }
    }
  }

  // 6. Bundled ffmpeg/ffprobe (downloaded by scripts/fetch-ffmpeg.js into
  //    client/resources/ffmpeg-<platform>/). Copy into src-tauri/resources/
  //    so Tauri bundles them; ffmpegRuntime.ts resolves them at runtime via
  //    getResourcesPath()/ffmpeg-<platform>/bin/. copyFileSync preserves the
  //    source mode, but chmod +x defensively on POSIX so the bundled binary
  //    stays executable.
  {
    const platformDir = process.platform === 'win32'
      ? 'ffmpeg-win'
      : process.platform === 'darwin'
        ? 'ffmpeg-mac'
        : 'ffmpeg-linux';
    const ffmpegSrc = path.join(ROOT, 'resources', platformDir);
    const ffmpegDest = path.join(RESOURCES_DIR, platformDir);
    if (fs.existsSync(ffmpegSrc)) {
      const count = copyDirRecursive(ffmpegSrc, ffmpegDest);
      if (process.platform !== 'win32') {
        for (const exe of ['ffmpeg', 'ffprobe']) {
          const p = path.join(ffmpegDest, 'bin', exe);
          if (fs.existsSync(p)) {
            try { fs.chmodSync(p, 0o755); } catch {}
          }
        }
      }
      console.log(`  ${platformDir}: ${count} files`);
    } else {
      console.warn(
        `  ${platformDir}: NOT FOUND (run "node scripts/fetch-ffmpeg.js" first) — ` +
        'video creation will fall back to system PATH ffmpeg, or surface a friendly ' +
        '"ffmpeg unavailable" error if none is installed.',
      );
    }
  }

  // 6b. Bundled fingerprint-chromium 指纹内核(scripts/fetch-fingerprint-chromium.js
  //     下载到 client/resources/fingerprint-chromium-<platform>/)。拷进
  //     src-tauri/resources/ 让 Tauri bundle;kernelPool.resolveBundledKernel() 运行时
  //     解析 win→chrome.exe / mac→Chromium.app/Contents/MacOS/Chromium。
  {
    const kdir = process.platform === 'win32'
      ? 'fingerprint-chromium-win'
      : process.platform === 'darwin'
        ? 'fingerprint-chromium-mac'
        : 'fingerprint-chromium-linux';
    const kSrc = path.join(ROOT, 'resources', kdir);
    const kDest = path.join(RESOURCES_DIR, kdir);
    if (fs.existsSync(kSrc)) {
      if (process.platform === 'darwin') {
        // ⚠️ Chromium.app 含大量 symlink(framework Versions/Current 等),
        // copyDirRecursive 会跟随/拷坏 → 必须用 cp -R 保留 symlink。
        fs.rmSync(kDest, { recursive: true, force: true });
        fs.mkdirSync(kDest, { recursive: true });
        require('child_process').execSync(`cp -R "${kSrc}/." "${kDest}/"`, { stdio: 'inherit' });
        const exe = path.join(kDest, 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
        try { if (fs.existsSync(exe)) fs.chmodSync(exe, 0o755); } catch {}
        console.log(`  ${kdir}: copied via cp -R (symlinks preserved)`);
      } else {
        const count = copyDirRecursive(kSrc, kDest);
        console.log(`  ${kdir}: ${count} files`);
      }
    } else {
      console.warn(`  ${kdir}: NOT FOUND (run "node scripts/fetch-fingerprint-chromium.js" first) — 矩阵互动会回落系统 Chrome(无真指纹隔离)。`);
    }
  }

  // 7. Bundled CJK subtitle font (Source Han Sans SC Bold, SIL OFL, commercial
  //    OK). Committed to client/resources/fonts/. compose.ts resolves it at
  //    runtime via getResourcesPath()/fonts/ so Chinese subtitles never render
  //    as tofu boxes regardless of the user's installed system fonts.
  {
    const fontsSrc = path.join(ROOT, 'resources', 'fonts');
    const fontsDest = path.join(RESOURCES_DIR, 'fonts');
    if (fs.existsSync(fontsSrc)) {
      const count = copyDirRecursive(fontsSrc, fontsDest);
      console.log(`  fonts: ${count} files`);
    } else {
      console.warn(
        '  fonts: NOT FOUND — Chinese subtitles will fall back to system fonts ' +
        '(may render as tofu boxes on machines without a CJK font).',
      );
    }
  }

  // 8. Bundled background-music library (MoneyPrinterTurbo's royalty-free songs,
  //    renamed bgm-01..bgm-08). Committed to client/resources/bgm/. The wizard
  //    offers these as "built-in BGM" via a builtin:<id> token; pipeline/bgm.ts
  //    resolves the token to getResourcesPath()/bgm/<id>.mp3 at runtime.
  {
    const bgmSrc = path.join(ROOT, 'resources', 'bgm');
    const bgmDest = path.join(RESOURCES_DIR, 'bgm');
    if (fs.existsSync(bgmSrc)) {
      const count = copyDirRecursive(bgmSrc, bgmDest);
      console.log(`  bgm: ${count} files`);
    } else {
      console.warn('  bgm: NOT FOUND — built-in background music will be unavailable (upload still works).');
    }
  }

  // 9. Bundled GSAP (vendored client/resources/gsap/gsap.min.js, GreenSock
  //    standard license). The headless HTML renderer blocks ALL network, so the
  //    "AI 自由排版" (ai_freeform) templates can't load GSAP from a CDN — we inline
  //    this source string into the scene HTML at render time. gsapAsset.ts resolves
  //    it at runtime via getResourcesPath()/gsap/gsap.min.js.
  {
    const gsapSrc = path.join(ROOT, 'resources', 'gsap');
    const gsapDest = path.join(RESOURCES_DIR, 'gsap');
    if (fs.existsSync(gsapSrc)) {
      const count = copyDirRecursive(gsapSrc, gsapDest);
      console.log(`  gsap: ${count} files`);
    } else {
      console.warn('  gsap: NOT FOUND — ai_freeform templates that use GSAP timelines will fail to render.');
    }
  }

  console.log(`Done. Resources prepared in ${RESOURCES_DIR}`);
}

main();
