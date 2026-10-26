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

// ── 多开并发上限:按内存估算(每个实例约 2~2.5GB,给系统和 NoobClaw 留 4GB)。 ──
export function maxConcurrentInstances(): number {
  const env = parseInt(process.env.NOOBCLAW_EMU_MAX || '', 10);
  if (Number.isFinite(env) && env > 0) return Math.min(env, 20);
  const gb = os.totalmem() / 1024 ** 3;
  return Math.max(1, Math.min(12, Math.floor((gb - 4) / 2.5)));
}

let slotsInUse = 0;
const slotWaiters = new Set<() => void>();

/** 占一个「同时运行实例」名额(任务批量跑时用,防止一次起太多把电脑拖死)。 */
export async function acquireSlot(signal?: AbortSignal): Promise<() => void> {
  while (slotsInUse >= maxConcurrentInstances()) {
    if (signal?.aborted) throw new EmuError('aborted', '已停止');
    // 等「有名额释放」或 5s 兜底(防漏唤醒);无论哪个先到都把自己从等待集合里摘掉,集合不会越积越多。
    await new Promise<void>((r) => {
      const wake = (): void => { clearTimeout(t); slotWaiters.delete(wake); r(); };
      const t = setTimeout(wake, 5000);
      slotWaiters.add(wake);
    });
  }
  slotsInUse++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slotsInUse = Math.max(0, slotsInUse - 1);
    const w = slotWaiters.values().next().value;
    if (w) w();
  };
}

export function isEmuBusy(accountId: string): boolean { return busy.has(accountId) || inUse.has(accountId); }

// 任务正在用这个号的模拟器(整段运行期间)。期间面板的停止/删除一律拒绝,免得半路把任务的设备拔掉。
const inUse = new Set<string>();
export function markInUse(accountId: string): void { inUse.add(accountId); }
export function releaseInUse(accountId: string): void { inUse.delete(accountId); }
function assertNotInUse(accountId: string): void {
  if (inUse.has(accountId)) throw new EmuError('in_use', '该账号正在跑任务,请先停止任务');
}
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
    try { await existing.agent.rpc('ping', [], 5000); return existing; } catch {
      sessions.delete(accountId);
      try { await existing.agent.stop(); } catch { /* ignore */ }   // 收掉旧的 adb 子进程和端口转发
    }
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
    try { await agent.start(); } catch (e) { try { await agent.stop(); } catch { /* ignore */ } throw e; }

    setAccountEmulator(accountId, { ...acc.emulator, index: inst.index, serial });
    const s: EmuSession = { accountId, index: inst.index, serial, adb, agent, proxyMode: px.mode, startedAt: Date.now() };
    sessions.set(accountId, s);
    coworkLog('INFO', 'emulatorPool', 'session ready', { accountId, serial, proxy: px.mode });
    return s;
  });
}

export async function stopInstance(accountId: string, opts?: { force?: boolean }): Promise<void> {
  if (!opts?.force) assertNotInUse(accountId);
  const s = sessions.get(accountId);
  sessions.delete(accountId);
  if (s) {
    // 关之前清掉系统代理:adb reverse 和本机中转随会话消失,留着 http_proxy 会让下次手动开的实例完全没网。
    try { await s.adb.shell(s.serial, ['settings', 'put', 'global', 'http_proxy', ':0']); } catch { /* ignore */ }
    try { await s.agent.stop(); } catch { /* ignore */ }
  }
  const acc = getAccount(accountId);
  if (!acc?.emulator) return;
  const ld = await requireLd();
  const inst = await ld.findByName(acc.emulator.instanceName);
  if (inst) await ld.quit(inst.index);
}

/** 删除实例(会清掉实例里的登录态和数据)并解绑。只在用户明确点「删除模拟器」时调用。 */
export async function removeInstance(accountId: string): Promise<void> {
  assertNotInUse(accountId);
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

/** 实例当前是否在跑(任务据此决定跑完要不要关:任务自己开的才关,用户本来开着的留着)。 */
export async function isInstanceRunning(accountId: string): Promise<boolean> {
  const acc = getAccount(accountId);
  if (!acc?.emulator) return false;
  const ld = await getLdPlayer();
  if (!ld) return false;
  const inst = await ld.findByName(acc.emulator.instanceName);
  return !!inst && inst.pid > 0;
}

// ── 批量(多开)──

/** 给一批账号补建实例(已绑定且实例在的跳过)。串行:ldconsole add 并发会互相打架。 */
export async function bindMany(accountIds: string[], onLog: (accountId: string, msg: string) => void): Promise<{ ok: string[]; failed: Array<{ accountId: string; error: string }> }> {
  const ok: string[] = [];
  const failed: Array<{ accountId: string; error: string }> = [];
  for (const id of accountIds) {
    try { await bindAccount(id, (m) => onLog(id, m)); ok.push(id); onLog(id, '实例已就绪'); } catch (e: any) {
      failed.push({ accountId: id, error: e?.message || String(e) });
      onLog(id, '❌ ' + (e?.message || String(e)));
    }
  }
  return { ok, failed };
}

/**
 * 批量启动:同时最多 maxConcurrentInstances() 个在启动,启动之间错开 8 秒(雷电同时冷启动多个会卡死)。
 * 不阻塞调用方太久的话由 sidecar 放后台跑,进度走 onLog。
 */
export async function startMany(accountIds: string[], onLog: (accountId: string, msg: string, extra?: Record<string, unknown>) => void): Promise<void> {
  const cap = maxConcurrentInstances();
  let cursor = 0;
  const lane = async (laneIdx: number): Promise<void> => {
    await sleep(laneIdx * 8000);
    for (;;) {
      const i = cursor++;
      if (i >= accountIds.length) return;
      const id = accountIds[i];
      try {
        const s = await ensureRunning(id, (m) => onLog(id, m));
        onLog(id, '已就绪', { done: true, ok: true, serial: s.serial, proxyMode: s.proxyMode });
      } catch (e: any) {
        onLog(id, e?.message || String(e), { done: true, ok: false, code: e?.code });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cap, accountIds.length)) }, (_v, k) => lane(k)));
  try { const ld = await getLdPlayer(); if (ld) await ld.sortWindows(); } catch { /* ignore */ }
}

export async function stopMany(accountIds: string[]): Promise<void> {
  for (const id of accountIds) { try { await stopInstance(id); } catch { /* ignore */ } }
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
  // 建号时雷电还没装(绑定失败)的号也列出来,面板上给「建立实例」。
  const accs = listAccounts().filter((a) => a.runtime === 'emulator');
  if (!accs.length) return [];
  const ld = await getLdPlayer();
  const insts = ld ? await ld.list() : [];
  return accs.map((a) => {
    const instanceName = a.emulator?.instanceName || instanceNameFor(a.id);
    const inst = insts.find((i) => i.name === instanceName);
    const s = sessions.get(a.id);
    return {
      accountId: a.id,
      displayName: a.nickname || a.displayName,
      platform: a.platform,
      instanceName,
      index: inst?.index,
      exists: !!inst,
      running: !!inst && inst.pid > 0,
      androidStarted: !!inst?.androidStarted,
      connected: !!s,
      serial: s?.serial || a.emulator?.serial,
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
