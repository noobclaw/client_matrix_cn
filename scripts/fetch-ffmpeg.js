/**
 * fetch-ffmpeg — download the static ffmpeg binary into resources/ for bundling.
 *
 * Runs at BUILD time (CI or local), NOT at runtime. The downloaded binary
 * lands in `client/resources/ffmpeg-<platform>/bin/`; prepare-tauri-resources.js
 * then copies it into `src-tauri/resources/ffmpeg-<platform>/bin/` so Tauri
 * bundles it. At runtime ffmpegRuntime.ts resolves it via getResourcesPath().
 *
 * ffprobe is intentionally NOT downloaded — it was a separate ~100MB binary
 * used only to read duration / WxH metadata, which ffmpegRuntime.ts now parses
 * from `ffmpeg -i` stderr instead. Dropping it roughly halves the bundled
 * ffmpeg footprint.
 *
 * Platform sources:
 *   - Windows x64: gyan.dev "essentials" static build (bundles libx264).
 *   - macOS arm64 + x64: Martin-Riedl.de static builds. Long-running project
 *     (since 2017), build script is open source (Apache-2.0, hosted at
 *     git.martin-riedl.de/ffmpeg/build-script), and the arm64 binaries ship
 *     already signed + notarized. We still re-sign them in build-tauri.yml
 *     with OUR Developer ID (--timestamp --options runtime) because any Mach-O
 *     embedded under Contents/Resources/ must carry a secure timestamp under
 *     OUR identity or the whole .app fails notarization (same treatment the
 *     .node addon gets).
 *   - Linux: NOT bundled — the step no-ops so the build still succeeds; the
 *     app falls back to system PATH ffmpeg, and if absent surfaces a friendly
 *     "ffmpeg unavailable" error.
 *
 * Idempotent: if the target binaries already exist it skips the download.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');

// gyan.dev "essentials" static build — much smaller than BtbN's full GPL
// master build (~85MB exe vs ~195MB) while still bundling everything our
// pipeline uses: libx264 (H.264), AAC, image decoders, drawtext/freetype
// (burned-in subtitles), and the zoompan filter (Ken Burns). Stable URL that
// always points at the current release.
const WIN_FFMPEG_URL =
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

// Martin-Riedl.de static macOS builds. Separate zips per binary, per arch.
// `redirect/latest/.../release/` always points at the current stable release
// (e.g. 8.x) so we never have to chase version numbers. arch token is the
// site's own: aarch64 -> "arm64", x86_64 -> "amd64".
const MAC_FFMPEG_BASE = 'https://ffmpeg.martin-riedl.de/redirect/latest/macos';
// Fallback when martin-riedl.de is down: GitHub-hosted static builds (gzipped single binary).
const MAC_FFMPEG_FALLBACK_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';
function macArchToken(triple) {
  if (triple.startsWith('aarch64') || triple.includes('arm64')) return 'arm64';
  return 'amd64'; // x86_64-apple-darwin
}

function targetTriple() {
  if (process.argv[2]) return process.argv[2];
  if (process.env.SIDECAR_TARGET) return process.env.SIDECAR_TARGET;
  try {
    return execSync('rustc --print host-tuple', { encoding: 'utf8' }).trim();
  } catch {
    if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
    if (process.platform === 'darwin') {
      return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    }
    return 'x86_64-unknown-linux-gnu';
  }
}

/** Recursively find the first file named `name` under `dir`. */
function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

/** Create a fresh scratch dir under FFMPEG_FETCH_TMP (or os.tmpdir()). */
function makeScratchDir() {
  // Allow overriding the scratch dir (FFMPEG_FETCH_TMP) — useful when the
  // system temp volume is space-constrained; defaults to os.tmpdir().
  const tmpBase = process.env.FFMPEG_FETCH_TMP || os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  return fs.mkdtempSync(path.join(tmpBase, 'noobclaw-ffmpeg-'));
}

function fetchWindows() {
  const destBin = path.join(ROOT, 'resources', 'ffmpeg-win', 'bin');
  const ffmpegOut = path.join(destBin, 'ffmpeg.exe');

  if (fs.existsSync(ffmpegOut)) {
    console.log(`[fetch-ffmpeg] Windows ffmpeg already present in ${destBin}, skipping.`);
    return;
  }

  const tmp = makeScratchDir();
  const zipPath = path.join(tmp, 'ffmpeg-win.zip');
  const extractDir = path.join(tmp, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    console.log(`[fetch-ffmpeg] Downloading ${WIN_FFMPEG_URL}`);
    // curl is present on GitHub windows-latest runners and locally with Git.
    execSync(`curl -L --fail --retry 3 -o "${zipPath}" "${WIN_FFMPEG_URL}"`, { stdio: 'inherit' });

    console.log('[fetch-ffmpeg] Extracting…');
    // Expand-Archive is built into Windows PowerShell; reliable for .zip.
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: 'inherit' },
    );

    const ffmpegSrc = findFile(extractDir, 'ffmpeg.exe');
    if (!ffmpegSrc) {
      throw new Error('ffmpeg.exe not found in the downloaded archive');
    }

    fs.mkdirSync(destBin, { recursive: true });
    fs.copyFileSync(ffmpegSrc, ffmpegOut);

    const mb = (p) => Math.round(fs.statSync(p).size / 1024 / 1024);
    console.log(`[fetch-ffmpeg] ✓ ffmpeg.exe (${mb(ffmpegOut)}MB) → ${destBin}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function fetchMac(triple) {
  const destBin = path.join(ROOT, 'resources', 'ffmpeg-mac', 'bin');
  const ffmpegOut = path.join(destBin, 'ffmpeg');

  if (fs.existsSync(ffmpegOut)) {
    console.log(`[fetch-ffmpeg] macOS ffmpeg already present in ${destBin}, skipping.`);
    return;
  }

  const arch = macArchToken(triple);
  const tmp = makeScratchDir();

  try {
    fs.mkdirSync(destBin, { recursive: true });

    // ffmpeg ships as its own zip on this host (ffprobe no longer fetched).
    const url = `${MAC_FFMPEG_BASE}/${arch}/release/ffmpeg.zip`;
    const zipPath = path.join(tmp, 'ffmpeg.zip');
    const extractDir = path.join(tmp, 'ffmpeg-extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    let src = null;
    try {
      console.log(`[fetch-ffmpeg] Downloading ${url}`);
      // -L follows the redirect/latest -> versioned download URL.
      execSync(`curl -L --fail --retry 3 --retry-all-errors --connect-timeout 30 -o "${zipPath}" "${url}"`, { stdio: 'inherit' });

      console.log('[fetch-ffmpeg] Extracting ffmpeg…');
      // `unzip` is preinstalled on macOS runners (and dev Macs).
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });

      src = findFile(extractDir, 'ffmpeg');
      if (!src) throw new Error(`ffmpeg not found in the downloaded archive (${url})`);
    } catch (e) {
      // 2026-10-21: martin-riedl.de failed on both macOS jobs twice in a row and took the whole
      // Mac build down. Fall back to the GitHub-hosted static build (eugeneware/ffmpeg-static
      // b6.0, checked: --enable-gpl --enable-libx264 --enable-libfreetype --enable-libass
      // --enable-fontconfig, so H.264 / drawtext subtitles / zoompan all work).
      const fbArch = arch === 'arm64' ? 'arm64' : 'x64';
      const fbUrl = `${MAC_FFMPEG_FALLBACK_BASE}/ffmpeg-darwin-${fbArch}.gz`;
      console.warn(`[fetch-ffmpeg] primary source failed (${e && e.message}); falling back to ${fbUrl}`);
      const gzPath = path.join(tmp, 'ffmpeg-fallback.gz');
      execSync(`curl -L --fail --retry 3 --retry-all-errors --connect-timeout 30 -o "${gzPath}" "${fbUrl}"`, { stdio: 'inherit' });
      execSync(`gunzip -f "${gzPath}"`, { stdio: 'inherit' });
      src = gzPath.replace(/\.gz$/, '');
      if (!fs.existsSync(src)) throw new Error(`fallback ffmpeg missing after gunzip (${fbUrl})`);
    }
    fs.copyFileSync(src, ffmpegOut);
    fs.chmodSync(ffmpegOut, 0o755); // ensure the bundled binary stays executable

    const mb = (p) => Math.round(fs.statSync(p).size / 1024 / 1024);
    console.log(
      `[fetch-ffmpeg] ✓ ffmpeg (${mb(ffmpegOut)}MB) → ${destBin} ` +
      `(macos/${arch}). NOTE: build-tauri.yml re-signs this with our Developer ID before bundling.`,
    );
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function main() {
  const triple = targetTriple();
  console.log(`[fetch-ffmpeg] target: ${triple}`);

  if (triple.includes('windows')) {
    fetchWindows();
    return;
  }

  if (triple.includes('darwin') || triple.includes('apple')) {
    fetchMac(triple);
    return;
  }

  // Linux: deferred (see file header). No-op so the build proceeds.
  console.log(
    `[fetch-ffmpeg] No bundled ffmpeg configured for ${triple} — skipping. ` +
    'The app will fall back to system PATH ffmpeg at runtime.',
  );
}

main();
