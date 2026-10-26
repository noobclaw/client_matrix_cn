/**
 * 雷电模拟器(LDPlayer 9 / 14)命令行封装。只用官方 ldconsole.exe 文档化的命令:
 *   https://www.ldplayer.net/support/ldplayer-ldconsole-command-line-developer-usage-guide.html
 *
 * 产品红线(见 docs/emulator-matrix.md §3):
 *   modify 只允许改 resolution / cpu / memory。不提供、也不透传 --imei/--imsi/--androidid/--mac/
 *   --manufacturer/--model/--pnumber/--simserial —— 我们不做设备身份伪造。
 *
 * 雷电由用户自行安装,本模块只负责找到它并调用。仅 Windows。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../../coworkLogger';
import { execFileBuf, decodeConsole } from './exec';

export interface LdInstance {
  index: number;
  name: string;
  topHwnd: string;
  bindHwnd: string;
  androidStarted: boolean;   // 安卓系统已进入(list2 第 5 列)
  pid: number;               // 模拟器进程 PID(0/-1 = 没在跑)
  vboxPid: number;
}

export interface LdHardware {
  width?: number;
  height?: number;
  dpi?: number;
  cpu?: 1 | 2 | 3 | 4;
  memory?: 256 | 512 | 768 | 1024 | 1536 | 2048 | 4096 | 8192;
}

function matrixBaseDir(): string {
  return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
}
function configFile(): string { return path.join(matrixBaseDir(), 'emulator.json'); }

interface EmuConfig { ldDir?: string }

function readConfig(): EmuConfig {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { return {}; }
}
function writeConfig(c: EmuConfig): void {
  fs.mkdirSync(matrixBaseDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

export function isSupportedPlatform(): boolean {
  return process.platform === 'win32';
}

function hasConsole(dir: string): boolean {
  try { return fs.statSync(path.join(dir, 'ldconsole.exe')).isFile(); } catch { return false; }
}

/** 常见安装目录(雷电默认装 C:\leidian\LDPlayer9;不少人装到 D 盘)。 */
function candidateDirs(): string[] {
  const roots = ['C:', 'D:', 'E:', 'F:'];
  const subs = [
    'leidian\\LDPlayer9', 'leidian\\LDPlayer14', 'LDPlayer\\LDPlayer9', 'LDPlayer\\LDPlayer14',
    'Program Files\\leidian\\LDPlayer9', 'Program Files\\LDPlayer\\LDPlayer9',
    'LDPlayer9', 'LDPlayer14', 'ChangZhi\\dnplayer2',
  ];
  const out: string[] = [];
  for (const r of roots) for (const s of subs) out.push(`${r}\\${s}`);
  return out;
}

/** 注册表兜底(尽力而为:键名随版本可能不同,查不到就算了)。 */
async function registryDirs(): Promise<string[]> {
  const keys = [
    'HKCU\\Software\\leidian\\ldplayer9', 'HKCU\\Software\\leidian\\ldplayer14',
    'HKCU\\Software\\XuanZhi\\LDPlayer9', 'HKCU\\Software\\XuanZhi\\LDPlayer14',
    'HKLM\\SOFTWARE\\leidian\\ldplayer9',
  ];
  const found: string[] = [];
  for (const k of keys) {
    const r = await execFileBuf('reg', ['query', k, '/v', 'InstallDir'], { timeoutMs: 5000 });
    if (r.code !== 0) continue;
    const m = decodeConsole(r.stdout).match(/InstallDir\s+REG_\w+\s+(.+)/i);
    if (m) found.push(m[1].trim().replace(/[\\/]+$/, ''));
  }
  return found;
}

/** 找雷电安装目录:用户手动设置 > 环境变量 > 注册表 > 常见目录。找不到返回 null。 */
export async function detectLdDir(): Promise<string | null> {
  if (!isSupportedPlatform()) return null;
  const manual = readConfig().ldDir;
  if (manual && hasConsole(manual)) return manual;
  const env = process.env.NOOBCLAW_LDPLAYER_DIR;
  if (env && hasConsole(env)) return env;
  for (const d of await registryDirs()) if (hasConsole(d)) return d;
  for (const d of candidateDirs()) if (hasConsole(d)) return d;
  return null;
}

/** 用户在设置页手动指定目录。返回是否有效(目录下要有 ldconsole.exe)。 */
export function setLdDir(dir: string | null): boolean {
  const c = readConfig();
  if (!dir) { delete c.ldDir; writeConfig(c); return true; }
  const clean = dir.replace(/[\\/]+$/, '');
  if (!hasConsole(clean)) return false;
  c.ldDir = clean;
  writeConfig(c);
  return true;
}

export class LdPlayer {
  readonly dir: string;
  readonly console: string;
  readonly adb: string;

  constructor(dir: string) {
    this.dir = dir;
    this.console = path.join(dir, 'ldconsole.exe');
    // 雷电目录自带 adb.exe;优先用它(版本与模拟器匹配),没有再用 PATH 里的。
    const bundled = path.join(dir, 'adb.exe');
    this.adb = fs.existsSync(bundled) ? bundled : 'adb';
  }

  private async run(args: string[], timeoutMs = 60_000): Promise<string> {
    const r = await execFileBuf(this.console, args, { timeoutMs, cwd: this.dir });
    const out = decodeConsole(r.stdout).trim();
    if (r.timedOut) coworkLog('WARN', 'ldplayer', 'ldconsole timeout', { args: args.join(' ') });
    return out;
  }

  /** list2:索引,标题,顶层窗口句柄,绑定窗口句柄,是否进入android,进程PID,VBox进程PID[,宽,高,dpi] */
  async list(): Promise<LdInstance[]> {
    const out = await this.run(['list2'], 20_000);
    return parseList2(out);
  }

  async findByName(name: string): Promise<LdInstance | undefined> {
    return (await this.list()).find((i) => i.name === name);
  }

  async isRunning(index: number): Promise<boolean> {
    const out = await this.run(['isrunning', '--index', String(index)], 15_000);
    return /running/i.test(out) && !/stop/i.test(out);
  }

  /** 新建实例(全新,不复制别的实例 —— 复制会把源实例的登录态/数据一起带过去)。 */
  async add(name: string): Promise<LdInstance | undefined> {
    await this.run(['add', '--name', name], 120_000);
    return this.findByName(name);
  }

  async remove(index: number): Promise<void> {
    await this.run(['remove', '--index', String(index)], 120_000);
  }

  async rename(index: number, title: string): Promise<void> {
    await this.run(['rename', '--index', String(index), '--title', title]);
  }

  async launch(index: number): Promise<void> {
    await this.run(['launch', '--index', String(index)], 60_000);
  }

  async quit(index: number): Promise<void> {
    await this.run(['quit', '--index', String(index)], 60_000);
  }

  async reboot(index: number): Promise<void> {
    await this.run(['reboot', '--index', String(index)], 60_000);
  }

  /** 只改硬件性能参数(重启实例后生效)。见文件头红线。 */
  async setHardware(index: number, hw: LdHardware): Promise<void> {
    const args = ['modify', '--index', String(index)];
    if (hw.width && hw.height) args.push('--resolution', `${hw.width},${hw.height},${hw.dpi || 320}`);
    if (hw.cpu) args.push('--cpu', String(hw.cpu));
    if (hw.memory) args.push('--memory', String(hw.memory));
    if (args.length === 3) return;
    await this.run(args, 60_000);
  }

  async installApk(index: number, apkPath: string): Promise<void> {
    await this.run(['installapp', '--index', String(index), '--filename', apkPath], 300_000);
  }

  async runApp(index: number, pkg: string): Promise<void> {
    await this.run(['runapp', '--index', String(index), '--packagename', pkg], 60_000);
  }

  async killApp(index: number, pkg: string): Promise<void> {
    await this.run(['killapp', '--index', String(index), '--packagename', pkg], 30_000);
  }

  /** 让雷电自己把所有实例窗口排列整齐(多开时用户好找)。 */
  async sortWindows(): Promise<void> {
    await this.run(['sortWnd'], 15_000);
  }
}

export function parseList2(out: string): LdInstance[] {
  const rows: LdInstance[] = [];
  for (const line of out.split(/\r?\n/)) {
    const p = line.split(',');
    if (p.length < 7) continue;
    const index = parseInt(p[0], 10);
    if (!Number.isFinite(index)) continue;
    rows.push({
      index,
      name: p[1],
      topHwnd: p[2],
      bindHwnd: p[3],
      androidStarted: p[4] === '1',
      pid: parseInt(p[5], 10) || 0,
      vboxPid: parseInt(p[6], 10) || 0,
    });
  }
  return rows;
}

let cached: { dir: string; ld: LdPlayer } | null = null;

/** 拿当前可用的 LdPlayer 实例;没装/非 Windows 返回 null。 */
export async function getLdPlayer(): Promise<LdPlayer | null> {
  const dir = await detectLdDir();
  if (!dir) return null;
  if (cached && cached.dir === dir) return cached.ld;
  cached = { dir, ld: new LdPlayer(dir) };
  return cached.ld;
}
