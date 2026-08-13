/**
 * 视频成片输出根目录(用户可配置)。
 *
 * 背景:成片原本写死在「文档\NoobClaw\视频创作」,Windows 上 Documents 默认在
 * C 盘 —— app 装在 D 盘的用户反馈"视频全落 C 盘"。这里把根目录做成可配置:
 *   · 配置存 settings.json 的 videoOutputRoot 键(userData 下,main / sidecar 两进程都读得到);
 *   · 没配置(或配置的目录建不出来,如 U 盘被拔)→ 回落默认 Documents 路径,绝不让出片失败;
 *   · 每次出片时现读现用(resolveOutputDirs 调用点),改完配置对下一次运行即时生效,无需重启。
 *
 * 同时提供 videoTempDir():合成期的重活临时目录(素材下载 / ffmpeg 分段)跟着
 * 输出根目录同盘走,避免 C 盘小的用户在合成峰值时被临时文件塞满。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getUserDataPath, getHomePath } from '../platformAdapter';

const SETTINGS_KEY = 'videoOutputRoot';

/** 默认输出根目录(历史行为):文档\NoobClaw\视频创作。 */
export function defaultVideoOutputRoot(): string {
  let docs: string;
  try {
    docs = require('electron').app.getPath('documents');
  } catch {
    docs = path.join(getHomePath(), 'Documents');
  }
  return path.join(docs, 'NoobClaw', '视频创作');
}

function settingsFile(): string {
  return path.join(getUserDataPath(), 'settings.json');
}

/** 读用户配置的根目录;没配 / 配置非法返回 null。 */
export function getConfiguredVideoOutputRoot(): string | null {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const v = parsed?.[SETTINGS_KEY];
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch { /* 文件不存在 / 坏 JSON → 视为未配置 */ }
  return null;
}

/** 生效的输出根目录:配置了且能建目录用配置,否则默认。 */
export function resolveVideoOutputRoot(): string {
  const configured = getConfiguredVideoOutputRoot();
  if (configured) {
    try {
      fs.mkdirSync(configured, { recursive: true });
      return configured;
    } catch { /* 盘被拔 / 权限变了 → 回落默认,出片不能因此失败 */ }
  }
  const def = defaultVideoOutputRoot();
  try { fs.mkdirSync(def, { recursive: true }); } catch {}
  return def;
}

export interface VideoOutputRootInfo {
  /** 当前生效目录(配置优先,回落默认)。 */
  dir: string;
  /** 是否用户自定义(false = 默认 Documents)。 */
  isCustom: boolean;
  /** 默认目录(设置页展示「恢复默认会回到哪」)。 */
  defaultDir: string;
}

export function getVideoOutputRootInfo(): VideoOutputRootInfo {
  const configured = getConfiguredVideoOutputRoot();
  const defaultDir = defaultVideoOutputRoot();
  if (configured) {
    return { dir: configured, isCustom: true, defaultDir };
  }
  return { dir: defaultDir, isCustom: false, defaultDir };
}

/**
 * 设置输出根目录;传 null 恢复默认。写入前做可写探测(建目录 + 写删探针文件),
 * 探测失败直接拒绝,不落盘 —— 避免用户选了只读盘后每次出片都静默回落。
 */
export function setVideoOutputRoot(dir: string | null): { success: boolean; error?: string } {
  if (dir !== null) {
    const trimmed = String(dir).trim();
    if (!trimmed || !path.isAbsolute(trimmed)) {
      return { success: false, error: '请选择一个有效的文件夹' };
    }
    try {
      fs.mkdirSync(trimmed, { recursive: true });
      const probe = path.join(trimmed, `.noobclaw-write-test-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
    } catch (e: any) {
      return { success: false, error: `该文件夹不可写:${e?.message || String(e)}` };
    }
    dir = trimmed;
  }
  try {
    const file = settingsFile();
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* missing / malformed — start fresh */ }
    if (dir === null) delete current[SETTINGS_KEY];
    else current[SETTINGS_KEY] = dir;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

/**
 * 合成期临时目录基座:自定义了输出根 → <根>\.tmp(跟成片同盘,C 盘不吃合成峰值);
 * 未自定义 → 维持 os.tmpdir()(历史行为,系统会自己清)。
 * 自定义盘上的 .tmp 系统不会清,这里顺手扫掉 24h 前的残留(崩溃没走到 rmSync 的)。
 */
export function videoTempBase(): string {
  const configured = getConfiguredVideoOutputRoot();
  if (!configured) return os.tmpdir();
  const base = path.join(configured, '.tmp');
  try {
    fs.mkdirSync(base, { recursive: true });
    sweepStaleTemp(base);
    return base;
  } catch {
    return os.tmpdir();
  }
}

let lastSweep = 0;
function sweepStaleTemp(base: string): void {
  const now = Date.now();
  if (now - lastSweep < 60 * 60 * 1000) return; // 每小时最多扫一次
  lastSweep = now;
  try {
    for (const entry of fs.readdirSync(base)) {
      const p = path.join(base, entry);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > 24 * 60 * 60 * 1000) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch { /* 单条失败不影响其它 */ }
    }
  } catch { /* 扫不动就算了 */ }
}
