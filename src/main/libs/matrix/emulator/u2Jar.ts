/**
 * u2.jar(openatx/android-uiautomator-server-jar,MIT)按需下载 + sha256 校验。
 *
 * 它是手机端的 UiAutomator JSON-RPC 服务:adb push 到 /data/local/tmp 后用 app_process 以 shell 身份起,
 * 不需要在设备上装 App、也不需要开无障碍。不打进安装包(3.7MB,且只有模拟器用户需要)。
 *
 * 来源按顺序:安装包自带(resources/emulator/,正常情况都走这条)→ 自家镜像 → GitHub Release。
 * 自家镜像接口待后端补上,没有时 404 自动落到 GitHub。任何来源的文件都必须过 sha256。
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../../coworkLogger';

export const U2_JAR_VERSION = '0.4.1';
export const U2_JAR_SHA256 = '87c8ac9505970d42aa5922baa90114808fda6f47f9e5fbd4caa0f621c2c8d30d';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

function sources(): string[] {
  return [
    `${apiBase()}/api/matrix/emulator/u2jar?v=${U2_JAR_VERSION}`,
    `https://github.com/openatx/android-uiautomator-server-jar/releases/download/${U2_JAR_VERSION}/u2.jar`,
  ];
}

export function u2JarPath(): string {
  const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
  return path.join(base, 'emulator', `u2-${U2_JAR_VERSION}.jar`);
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function u2JarReady(): boolean {
  try { return sha256(fs.readFileSync(u2JarPath())) === U2_JAR_SHA256; } catch { return false; }
}

let inflight: Promise<string | null> | null = null;

/** 安装包自带的那份(scripts/prepare-tauri-resources.js 第 10 步拷进 resources/emulator/)。 */
function bundledCandidates(): string[] {
  const out: string[] = [];
  try {
    // 动态 require:platformAdapter 依赖较多,单测/非打包环境拿不到时不影响下载兜底。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getResourcesPath } = require('../../platformAdapter');
    const base: string = getResourcesPath();
    const name = `u2-${U2_JAR_VERSION}.jar`;
    out.push(path.join(base, 'emulator', name), path.join(base, 'resources', 'emulator', name));
  } catch { /* ignore */ }
  return out;
}

function tryBundled(): string | null {
  for (const p of bundledCandidates()) {
    try {
      const buf = fs.readFileSync(p);
      if (sha256(buf) !== U2_JAR_SHA256) continue;
      fs.mkdirSync(path.dirname(u2JarPath()), { recursive: true });
      fs.writeFileSync(u2JarPath(), buf);
      return u2JarPath();
    } catch { /* next */ }
  }
  return null;
}

/** 确保本地有校验通过的 u2.jar,返回路径;全部来源失败返回 null。并发调用共享同一次下载。 */
export function ensureU2Jar(): Promise<string | null> {
  if (u2JarReady()) return Promise.resolve(u2JarPath());
  const bundled = tryBundled();
  if (bundled) return Promise.resolve(bundled);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      for (const url of sources()) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (sha256(buf) !== U2_JAR_SHA256) {
            coworkLog('WARN', 'u2Jar', 'sha256 mismatch, skip source', { url });
            continue;
          }
          fs.mkdirSync(path.dirname(u2JarPath()), { recursive: true });
          const tmp = u2JarPath() + '.part';
          fs.writeFileSync(tmp, buf);
          fs.renameSync(tmp, u2JarPath());
          return u2JarPath();
        } catch (e: any) {
          coworkLog('WARN', 'u2Jar', 'download failed', { url, err: String(e?.message || e) });
        }
      }
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
