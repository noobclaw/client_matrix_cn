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
import { execFileBuf } from './exec';
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
let lastFailReason = '';

export function ldInstallState(): LdInstallState { return state; }

async function download(url: string, onProgress: (pct: number | null, mb: number) => void): Promise<string | null> {
  const okUrl = (u: string): boolean => { try { const x = new URL(u); return x.protocol === 'https:' && ALLOWED_HOST.test(x.hostname); } catch { return false; } };
  if (!okUrl(url)) { coworkLog('WARN', 'ldInstaller', 'url not allowed', { url }); return null; }
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) return null;
  // 跳转后也必须还是 https + 官方域名。
  if (!okUrl(res.url)) { coworkLog('WARN', 'ldInstaller', 'redirect not allowed', { url: res.url }); return null; }
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(installerDir(), { recursive: true });
  const file = path.join(installerDir(), `ldplayer_setup_${Date.now().toString(36)}.exe`);
  const out = fs.createWriteStream(file);
  let writeErr: Error | null = null;
  out.on('error', (e) => { writeErr = e; });   // 磁盘满/没权限:必须有监听,否则未捕获异常打崩 sidecar
  let got = 0;
  let lastMb = -1;
  const reader = (res.body as any).getReader();
  try {
    for (;;) {
      if (writeErr) throw writeErr;
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      out.write(Buffer.from(value));
      const mb = Math.round(got / 1048576);
      if (mb !== lastMb) { lastMb = mb; onProgress(total ? Math.min(99, Math.round((got / total) * 100)) : null, mb); }
    }
  } catch (e) {
    out.destroy();
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    throw e;
  } finally {
    if (!out.destroyed) await new Promise<void>((r) => out.end(() => r()));
  }
  if (writeErr) { try { fs.unlinkSync(file); } catch { /* ignore */ } return null; }
  // 基本校验:是 Windows 可执行文件、体积合理。
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(2);
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'MZ' || got < 300 * 1024) { try { fs.unlinkSync(file); } catch { /* ignore */ } return null; }
  // 运行前校验 Windows 数字签名必须有效(Authenticode Valid),防止被中间人换包。
  const sig = await authenticodeStatus(file);
  if (sig.status !== 'Valid') {
    coworkLog('WARN', 'ldInstaller', 'installer signature not valid', { file, status: sig.status, signer: sig.signer });
    lastFailReason = '安装程序数字签名校验未通过(' + sig.status + ')';
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    return null;
  }
  coworkLog('INFO', 'ldInstaller', 'installer signature ok', { signer: sig.signer });
  return file;
}

async function openWithShell(file: string): Promise<{ ok: boolean; reason?: string }> {
  const prev = process.env.NC_LD_SETUP;
  process.env.NC_LD_SETUP = file;
  try {
    const r = await execFileBuf('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      'try { Start-Process -FilePath $env:NC_LD_SETUP -ErrorAction Stop; Write-Output OK } catch { Write-Output ("ERR " + $_.Exception.Message) }'], { timeoutMs: 120_000 });
    const out = r.stdout.toString('utf8').trim();
    if (/^OK/m.test(out)) return { ok: true };
    // 用户在 UAC 框里点了「否」也会走到这里(The operation was canceled by the user)。
    return { ok: false, reason: (out.replace(/^ERR\s*/, '') || 'unknown').slice(0, 120) };
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e).slice(0, 120) };
  } finally {
    if (prev === undefined) delete process.env.NC_LD_SETUP; else process.env.NC_LD_SETUP = prev;
  }
}

async function authenticodeStatus(file: string): Promise<{ status: string; signer: string }> {
  // 路径经环境变量传入,不拼进命令字符串(防注入)。
  const ps = '$s = Get-AuthenticodeSignature -LiteralPath $env:NC_SIG_FILE; Write-Output ($s.Status.ToString() + "|" + $s.SignerCertificate.Subject)';
  const prev = process.env.NC_SIG_FILE;
  process.env.NC_SIG_FILE = file;
  try {
    const r = await execFileBuf('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 30_000 });
    const out = r.stdout.toString('utf8').trim();
    const i = out.indexOf('|');
    return { status: i >= 0 ? out.slice(0, i) : out, signer: i >= 0 ? out.slice(i + 1) : '' };
  } catch { return { status: 'Unknown', signer: '' }; } finally {
    if (prev === undefined) delete process.env.NC_SIG_FILE; else process.env.NC_SIG_FILE = prev;
  }
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

      lastFailReason = '';
      const urls = [...(await serverUrls()), ...(preferCn() ? [...CN_URLS, ...INTL_URLS] : [...INTL_URLS, ...CN_URLS])];
      let file: string | null = null;
      for (const u of urls) {
        set({ phase: 'downloading', pct: 0, msg: '正在从雷电官网下载安装程序…' });
        try { file = await download(u, (pct, mb) => set({ phase: 'downloading', pct: pct ?? undefined, msg: pct !== null ? `正在下载雷电安装程序 ${pct}%(${mb}MB)` : `正在下载雷电安装程序 ${mb}MB…` })); } catch (e: any) {
          coworkLog('WARN', 'ldInstaller', 'download failed', { url: u, err: String(e?.message || e) });
        }
        if (file) break;
      }
      if (!file) return (set({ phase: 'failed', msg: (lastFailReason || '下载失败') + ',请检查网络,或到雷电官网手动下载安装' }), state);

      // 雷电安装程序要管理员权限:Node 直接 spawn 会因 ERROR_ELEVATION_REQUIRED(740)失败,而且是异步
      //   'error' 事件(try/catch 接不住,没监听还会打崩 sidecar)。改用 PowerShell Start-Process(ShellExecute),
      //   系统会正常弹 UAC 确认框,再出安装界面。路径走环境变量传入,不拼命令字符串。
      const opened = await openWithShell(file);
      if (!opened.ok) {
        // 打不开就把文件在资源管理器里选中,让用户自己双击。
        try { const c = spawn('explorer.exe', ['/select,', file], { detached: true, stdio: 'ignore' }); c.on('error', () => { /* ignore */ }); c.unref(); } catch { /* ignore */ }
        set({ phase: 'installing', msg: '安装程序已下载,但没能自动打开(' + opened.reason + ')。已在资源管理器里选中它,请双击运行:' + file });
      } else {
        set({ phase: 'installing', msg: '已打开雷电安装程序(可能先弹出管理员确认,请点「是」),在安装窗口里点「安装」,装完回来即可(本页会自动检测)' });
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
