/**
 * 雷电模拟器一键下载 + 启动官方安装程序(feat/emulator-matrix)。
 *
 * 只从雷电官方域名下载(ldmnq.com / ldrescdn.com),不打包、不改包、不静默安装:下载完直接打开官方安装程序,
 * 由用户在安装界面里点「安装」(雷电的用户协议由用户自己确认)。装好后 detectLdDir() 轮询到即视为完成。
 *
 * 下载地址可由后端 /api/matrix/config 的 emulatorLdDownloadUrls 覆盖(雷电改了链接时不用发版)。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { coworkLog } from '../../coworkLogger';
import { detectLdDir, isSupportedPlatform } from './ldplayer';
import { sleep } from './exec';

// 2026-10-26 从官方页面取得:国际版 ldplayer.net 版本历史页、国内版 ldmnq.com 首页「模拟器下载」。
const INTL_URLS = [
  'https://res.ldrescdn.com/download/package/LDPlayer9.0.exe?n=LDPlayer9.0_ens_1001_ld.exe',
  'https://res.ldrescdn.com/download/LDPlayer14.exe?n=LDPlayer14_ens_1379_ld.exe',
];
const CN_URLS = [
  'https://lddl01.ldmnq.com/downloader/ldplayerinst14.exe?n=ldplayer14_ld_407593_ld.exe',
];
const ALLOWED_HOST = /(^|\.)(ldmnq\.com|ldrescdn\.com|ldplayer\.net)$/i;

function apiBase(): string { return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com'; }

function preferCn(): boolean {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
    return /Shanghai|Chongqing|Urumqi|Harbin/i.test(tz) || /^zh(-CN|-Hans)?$/i.test(loc);
  } catch { return false; }
}

async function serverUrls(): Promise<string[]> {
  try {
    const r = await fetch(`${apiBase()}/api/matrix/config`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j: any = await r.json();
    const list = j?.emulatorLdDownloadUrls;
    return Array.isArray(list) ? list.filter((u: any) => typeof u === 'string') : [];
  } catch { return []; }
}

function installerDir(): string {
  const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
  return path.join(base, 'emulator', 'installers');
}

export interface LdInstallState {
  phase: 'idle' | 'downloading' | 'installing' | 'done' | 'failed';
  pct?: number;
  msg?: string;
  ldDir?: string;
}

let state: LdInstallState = { phase: 'idle' };
let running: Promise<LdInstallState> | null = null;

export function ldInstallState(): LdInstallState { return state; }

async function download(url: string, onProgress: (pct: number) => void): Promise<string | null> {
  let host = '';
  try { host = new URL(url).hostname; } catch { return null; }
  if (!ALLOWED_HOST.test(host)) { coworkLog('WARN', 'ldInstaller', 'host not allowed', { url }); return null; }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) return null;
  // 跳转后也必须还在官方域名。
  try { if (!ALLOWED_HOST.test(new URL(res.url).hostname)) return null; } catch { return null; }
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(installerDir(), { recursive: true });
  const file = path.join(installerDir(), `ldplayer_setup_${Date.now().toString(36)}.exe`);
  const out = fs.createWriteStream(file);
  let got = 0;
  const reader = (res.body as any).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      out.write(Buffer.from(value));
      if (total) onProgress(Math.min(99, Math.round((got / total) * 100)));
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  // 基本校验:是 Windows 可执行文件、体积合理。
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(2);
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'MZ' || got < 300 * 1024) { try { fs.unlinkSync(file); } catch { /* ignore */ } return null; }
  return file;
}

/** 一键安装:下载官方安装程序 → 打开 → 轮询到装好(最多 40 分钟)。重复调用共享同一次流程。 */
export function installLdPlayer(onState: (s: LdInstallState) => void): Promise<LdInstallState> {
  if (running) return running;
  const set = (s: LdInstallState): void => { state = s; try { onState(s); } catch { /* ignore */ } };
  running = (async (): Promise<LdInstallState> => {
    try {
      if (!isSupportedPlatform()) return (set({ phase: 'failed', msg: '仅支持 Windows' }), state);
      const existing = await detectLdDir();
      if (existing) return (set({ phase: 'done', ldDir: existing, msg: '已安装' }), state);

      const urls = [...(await serverUrls()), ...(preferCn() ? [...CN_URLS, ...INTL_URLS] : [...INTL_URLS, ...CN_URLS])];
      let file: string | null = null;
      for (const u of urls) {
        set({ phase: 'downloading', pct: 0, msg: '正在从雷电官网下载安装程序…' });
        try { file = await download(u, (pct) => set({ phase: 'downloading', pct, msg: `正在下载雷电安装程序 ${pct}%` })); } catch (e: any) {
          coworkLog('WARN', 'ldInstaller', 'download failed', { url: u, err: String(e?.message || e) });
        }
        if (file) break;
      }
      if (!file) return (set({ phase: 'failed', msg: '下载失败,请检查网络,或到雷电官网手动下载安装' }), state);

      set({ phase: 'installing', msg: '已打开雷电安装程序,请在安装窗口里点「安装」,装完回来即可(本页会自动检测)' });
      try {
        const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
      } catch (e: any) {
        return (set({ phase: 'failed', msg: '无法打开安装程序:' + String(e?.message || e) }), state);
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 40 * 60_000) {
        await sleep(10_000);
        const dir = await detectLdDir();
        if (dir) return (set({ phase: 'done', ldDir: dir, msg: '雷电已安装' }), state);
      }
      return (set({ phase: 'failed', msg: '没检测到安装完成。若已装在自定义目录,请在面板里手动填写安装目录' }), state);
    } finally {
      running = null;
    }
  })();
  return running;
}
