/**
 * 模拟器实例池:矩阵账号 ↔ 雷电实例(一对一),负责建/起/停/连、代理、u2 会话、忙碌锁。
 * 对标浏览器那边的 kernelPool,但执行端是安卓 App。设计见 docs/emulator-matrix.md §5.2。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../../coworkLogger';
import { getAccount, listAccounts, setAccountEmulator } from '../accountManager';
import type { MatrixAccount } from '../types';
import { Adb, assertDevicePath, assertPkg, resolveLdSerial } from './adb';
import { getLdPlayer, isSupportedPlatform, LdPlayer, LdInstance } from './ldplayer';
import { applyDeviceProxy } from './emulatorProxy';
import { sleep } from './exec';
import { U2Agent } from './u2Agent';
import { parseHierarchy, summarize, UiNode } from './uiTree';

export interface EmuSession {
  accountId: string;
  index: number;
  serial: string;
  adb: Adb;
  agent: U2Agent;
  proxyMode: 'none' | 'http_bridge';
  startedAt: number;
}

/** 新实例的默认硬件(只调性能,不碰设备身份,见 ldplayer.ts 红线)。 */
const DEFAULT_HW = { width: 720, height: 1280, dpi: 320, cpu: 2 as const, memory: 2048 as const };

const sessions = new Map<string, EmuSession>();
const busy = new Set<string>();

type Log = (msg: string) => void;
const noop: Log = () => { /* ignore */ };

export class EmuError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function requireLd(): Promise<LdPlayer> {
  if (!isSupportedPlatform()) throw new EmuError('unsupported_platform', '模拟器矩阵目前仅支持 Windows');
  const ld = await getLdPlayer();
  if (!ld) throw new EmuError('ld_not_found', '没找到雷电模拟器,请先安装雷电 9,或在设置里指定安装目录');
  return ld;
}

function requireAccount(accountId: string): MatrixAccount {
  const acc = getAccount(accountId);
  if (!acc) throw new EmuError('account_not_found', '账号不存在');
  return acc;
}

export function instanceNameFor(accountId: string): string {
  // ldconsole 名称里避免空格/中文(不同版本对编码处理不一),只用 id。
  return `nc_${accountId}`.replace(/[^\w-]/g, '_').slice(0, 60);
}

export function isEmuBusy(accountId: string): boolean { return busy.has(accountId); }
export function getEmuSession(accountId: string): EmuSession | undefined { return sessions.get(accountId); }

async function withLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(accountId)) throw new EmuError('busy', '该账号的模拟器正在执行其它操作,请稍后');
  busy.add(accountId);
  try { return await fn(); } finally { busy.delete(accountId); }
}

/** 给账号建(或找回)专属实例并写入绑定。已绑定且实例还在 → 直接返回。 */
export async function bindAccount(accountId: string, onLog: Log = noop): Promise<LdInstance> {
  return withLock(accountId, async () => {
    const ld = await requireLd();
    const acc = requireAccount(accountId);
    const name = acc.emulator?.instanceName || instanceNameFor(accountId);
    let inst = await ld.findByName(name);
    if (!inst) {
      onLog('新建雷电实例…');
      inst = await ld.add(name);
      if (!inst) throw new EmuError('create_failed', '新建雷电实例失败(请确认雷电能正常打开)');
      await ld.setHardware(inst.index, DEFAULT_HW);
    }
    setAccountEmulator(accountId, {
      provider: 'ldplayer',
      instanceName: name,
      index: inst.index,
      serial: acc.emulator?.serial,
      packages: acc.emulator?.packages,
      createdAt: acc.emulator?.createdAt || Date.now(),
    });
    return inst;
  });
}

/** 确保实例在跑、adb 连上、代理套好、u2 就绪。返回会话(复用已有)。 */
export async function ensureRunning(accountId: string, onLog: Log = noop): Promise<EmuSession> {
  const existing = sessions.get(accountId);
  if (existing) {
    try { await existing.agent.rpc('ping', [], 5000); return existing; } catch { sessions.delete(accountId); }
  }
  return withLock(accountId, async () => {
    const ld = await requireLd();
    const acc = requireAccount(accountId);
    if (acc.runtime !== 'emulator' || !acc.emulator) throw new EmuError('not_bound', '该账号还没绑定模拟器');
    const inst = await ld.findByName(acc.emulator.instanceName);
    if (!inst) throw new EmuError('instance_missing', '这个账号的雷电实例不见了(可能在雷电多开器里被删除),请重新绑定');

    const adb = new Adb(ld.adb);
    await adb.startServer();
    const before = await adb.onlineSerials();
    if (!(await ld.isRunning(inst.index))) {
      onLog('启动模拟器…');
      await ld.launch(inst.index);
    }
    let serial: string | null = null;
    const t0 = Date.now();
    while (!serial && Date.now() - t0 < 90_000) {
      serial = await resolveLdSerial(adb, inst.index, before);
      if (!serial) await sleep(3000);
    }
    if (!serial) throw new EmuError('adb_not_found', '模拟器已启动,但 ADB 连不上(请在雷电设置里打开「ADB 调试」)');
    onLog('等待系统开机…');
    if (!(await adb.waitBoot(serial, 180_000))) throw new EmuError('boot_timeout', '模拟器开机超时');

    onLog(acc.proxy ? '设置代理…' : '使用本机网络');
    const px = await applyDeviceProxy(adb, serial, acc.proxy);

    onLog('启动控制组件…');
    const agent = new U2Agent(adb, serial);
    await agent.start();

    setAccountEmulator(accountId, { ...acc.emulator, index: inst.index, serial });
    const s: EmuSession = { accountId, index: inst.index, serial, adb, agent, proxyMode: px.mode, startedAt: Date.now() };
    sessions.set(accountId, s);
    coworkLog('INFO', 'emulatorPool', 'session ready', { accountId, serial, proxy: px.mode });
    return s;
  });
}

export async function stopInstance(accountId: string): Promise<void> {
  const s = sessions.get(accountId);
  sessions.delete(accountId);
  if (s) { try { await s.agent.stop(); } catch { /* ignore */ } }
  const acc = getAccount(accountId);
  if (!acc?.emulator) return;
  const ld = await requireLd();
  const inst = await ld.findByName(acc.emulator.instanceName);
  if (inst) await ld.quit(inst.index);
}

/** 删除实例(会清掉实例里的登录态和数据)并解绑。只在用户明确点「删除模拟器」时调用。 */
export async function removeInstance(accountId: string): Promise<void> {
  await withLock(accountId, async () => {
    await stopInstance(accountId).catch((): void => undefined);
    const acc = getAccount(accountId);
    if (acc?.emulator) {
      const ld = await requireLd();
      const inst = await ld.findByName(acc.emulator.instanceName);
      if (inst) { await sleep(2000); await ld.remove(inst.index); }
    }
    setAccountEmulator(accountId, null);
  });
}

export async function stopAllSessions(): Promise<void> {
  for (const s of sessions.values()) { try { await s.agent.stop(); } catch { /* ignore */ } }
  sessions.clear();
}

/** 进程退出前同步收 u2 的 adb 子进程(不关雷电实例本身)。 */
export function killAllSessionsSync(): void {
  for (const s of sessions.values()) { try { s.agent.killSync(); } catch { /* ignore */ } }
  sessions.clear();
}

/** 面板用:所有模拟器号 + 实例运行状态。 */
export async function listEmulatorAccounts(): Promise<Array<{
  accountId: string; displayName: string; platform: string; instanceName: string;
  index?: number; exists: boolean; running: boolean; androidStarted: boolean; connected: boolean;
  serial?: string; proxyMode?: string; busy: boolean;
}>> {
  const accs = listAccounts().filter((a) => a.runtime === 'emulator' && a.emulator);
  if (!accs.length) return [];
  const ld = await getLdPlayer();
  const insts = ld ? await ld.list() : [];
  return accs.map((a) => {
    const inst = insts.find((i) => i.name === a.emulator!.instanceName);
    const s = sessions.get(a.id);
    return {
      accountId: a.id,
      displayName: a.nickname || a.displayName,
      platform: a.platform,
      instanceName: a.emulator!.instanceName,
      index: inst?.index,
      exists: !!inst,
      running: !!inst && inst.pid > 0,
      androidStarted: !!inst?.androidStarted,
      connected: !!s,
      serial: s?.serial || a.emulator!.serial,
      proxyMode: s?.proxyMode,
      busy: busy.has(a.id),
    };
  });
}

// ── 手机指令(driver ctx 与面板共用)──

export async function dumpNodes(accountId: string): Promise<{ nodes: UiNode[]; xml: string }> {
  const s = await ensureRunning(accountId);
  const xml = await s.agent.dumpXml();
  return { nodes: parseHierarchy(xml), xml };
}

/** 开发工具:匯出目前画面的 XML + 截图 + 精简节点列表,存到 matrix/emulator/dumps/。 */
export async function exportUiDump(accountId: string): Promise<{ dir: string; xmlPath: string; pngPath?: string; summary: string; currentPackage?: string }> {
  const s = await ensureRunning(accountId);
  const xml = await s.agent.dumpXml();
  const info = await s.agent.deviceInfo().catch(() => ({} as any));
  const b64 = await s.agent.screenshotBase64().catch((): null => null);
  const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
  const dir = path.join(base, 'emulator', 'dumps');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pkg = String(info?.currentPackageName || 'unknown');
  const stem = path.join(dir, `${accountId}_${pkg}_${stamp}`);
  fs.writeFileSync(stem + '.xml', xml);
  let pngPath: string | undefined;
  if (b64) { pngPath = stem + '.jpg'; fs.writeFileSync(pngPath, Buffer.from(b64, 'base64')); }
  const summary = summarize(parseHierarchy(xml), 400);
  fs.writeFileSync(stem + '.txt', summary);
  return { dir, xmlPath: stem + '.xml', pngPath, summary, currentPackage: pkg };
}

export async function appStart(accountId: string, pkg: string): Promise<void> {
  const s = await ensureRunning(accountId);
  await s.adb.shell(s.serial, ['monkey', '-p', assertPkg(pkg), '-c', 'android.intent.category.LAUNCHER', '1']);
}

export async function appStop(accountId: string, pkg: string): Promise<void> {
  const s = await ensureRunning(accountId);
  await s.adb.shell(s.serial, ['am', 'force-stop', assertPkg(pkg)]);
}

export async function isAppInstalled(accountId: string, pkg: string): Promise<boolean> {
  const s = await ensureRunning(accountId);
  const out = await s.adb.shell(s.serial, ['pm', 'list', 'packages', assertPkg(pkg)]);
  return out.split(/\r?\n/).some((l) => l.trim() === `package:${pkg}`);
}

/** 本机媒体文件 → 模拟器相册(/sdcard/DCIM/NoobClaw/),触发媒体扫描,返回设备路径。 */
export async function pushMedia(accountId: string, localPath: string): Promise<string> {
  const s = await ensureRunning(accountId);
  if (!fs.existsSync(localPath)) throw new EmuError('file_not_found', '文件不存在:' + localPath);
  const ext = (path.extname(localPath) || '').toLowerCase().replace(/[^.\w]/g, '');
  const remote = assertDevicePath(`/sdcard/DCIM/NoobClaw/nc_${Date.now().toString(36)}${ext}`);
  await s.adb.shell(s.serial, ['mkdir', '-p', '/sdcard/DCIM/NoobClaw']);
  if (!(await s.adb.push(s.serial, localPath, remote))) throw new EmuError('push_failed', '文件推送到模拟器失败');
  await s.adb.shell(s.serial, ['am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remote}`]);
  return remote;
}

/** 把账号的模拟器窗口提到前面(用户手动登录/查看用):雷电没有单独的置顶命令,用 sortWnd 排列 + 已启动即可见。 */
export async function showInstance(accountId: string): Promise<void> {
  const ld = await requireLd();
  const acc = requireAccount(accountId);
  if (!acc.emulator) throw new EmuError('not_bound', '该账号还没绑定模拟器');
  const inst = await ld.findByName(acc.emulator.instanceName);
  if (!inst) throw new EmuError('instance_missing', '实例不存在');
  if (!(await ld.isRunning(inst.index))) await ld.launch(inst.index);
  await ld.sortWindows();
}
