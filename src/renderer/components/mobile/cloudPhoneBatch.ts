import { Device, normDevice, rawListOf, L, PlatformId, RawTask, api, accountOf, errText, putTasks, sendCommand } from './cloudPhoneShared';

/**
 * 云手机批量操作:每台手机的资格判断 + 执行(最多 4 台并发)。
 * Every write re-reads the phone's task list right before the PUT (never a stale snapshot).
 */

export type BatchAct = 'run' | 'stop' | 'del' | 'new';

const platOf = (t: { platform?: string }): string => t.platform || 'tiktok';
export const taskOfPlatform = (d: Device, pf: string) => d.tasks.find((t) => platOf(t) === pf) || null;
/** Over-limit phones can't be picked. */
export const selectable = (d: Device): boolean => !d.over_limit;
const isRunning = (d: Device): boolean => d.online && d.running;

/** Platform of the task the phone is running now (null = not running / unknown). */
export function runningPlatform(d: Device): string | null {
  if (!isRunning(d)) return null;
  const t = d.tasks.find((x) => x.id === d.progress?.task_id);
  if (t) return platOf(t);
  return d.tasks.length === 1 ? platOf(d.tasks[0]) : null;
}

/** Reason a phone is skipped by 批量运行 for platform `pf` ('' = it will run). */
export function runSkip(d: Device, pf: string): string {
  if (!d.online) return L('离线', '離線', 'offline');
  if (!d.a11y) return L('缺权限', '缺權限', 'permission needed');
  if (d.running) return L('运行中', '運行中', 'running');
  if (!taskOfPlatform(d, pf)) return L('没有该平台任务', '沒有該平台任務', 'no task for this platform');
  return '';
}
export const canStop = (d: Device): boolean => isRunning(d);
export const hasTasksOf = (d: Device, pfs: string[]): boolean => d.tasks.some((t) => pfs.includes(platOf(t)));

/** Why a phone can't receive a batch-created task ('' = it can). */
export function createBlock(d: Device, pfName: string): string {
  if (!d.online) return L('离线', '離線', 'Offline');
  if (!d.a11y) return L('缺权限', '缺權限', 'Permission needed');
  if (d.apps?.tiktok === false) return L(`未装 ${pfName}`, `未裝 ${pfName}`, `${pfName} not installed`);
  if (!accountOf(d)) return L(`未登录 ${pfName}`, `未登入 ${pfName}`, `Not logged in to ${pfName}`);
  return '';
}

const freshId = (): string => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Fresh device state + its raw task list (throws if the server didn't send a full list). */
async function fresh(d: Device): Promise<{ dev: Device; list: RawTask[] }> {
  const r = await api<{ device: Device }>(`/devices/${encodeURIComponent(d.id)}`);
  const list = rawListOf(r.device);
  return { dev: { ...d, ...normDevice(r.device) }, list };
}
/** Stop when the (fresh) phone runs a task of one of `pfs`; then save `build(list)`. */
async function stopThenPut(d: Device, pfs: string[], build: (list: RawTask[]) => RawTask[]): Promise<void> {
  const { dev, list } = await fresh(d);
  let stopped = false;
  if (isRunning(dev)) {
    const rp = runningPlatform(dev);
    if (rp === null || pfs.includes(rp)) { await sendCommand(dev.id, 'stop', dev.progress?.task_id || undefined); stopped = true; }
  }
  try {
    await putTasks(dev.id, build(list));
  } catch (e) {
    if (!stopped) throw e;
    throw new Error(L('已停止，但保存任务失败：', '已停止，但儲存任務失敗：', 'Stopped, but saving the tasks failed: ') + errText(e));
  }
}

export const batchRun = (d: Device, pf: PlatformId) => sendCommand(d.id, 'run', taskOfPlatform(d, pf)!.id);
export const batchStop = (d: Device) => sendCommand(d.id, 'stop', d.progress?.task_id || undefined);

/** Remove the tasks of `pfs` (stops first when the phone is running one of them). */
export function batchDelete(d: Device, pfs: string[]): Promise<void> {
  return stopThenPut(d, pfs, (list) => list.filter((t) => !pfs.includes(platOf(t))));
}

/** Replace the phone's task of `pf` with `task` (fresh id); stops first when that platform is running. */
export function batchCreate(d: Device, pf: string, task: RawTask): Promise<void> {
  return stopThenPut(d, [pf], (list) => [...list.filter((t) => platOf(t) !== pf), { ...task, id: freshId(), platform: pf }]);
}

export interface BatchResult { ok: number; fails: { device: Device; reason: string }[] }

/** Runs `fn` for every phone, at most `limit` at once; `onProgress(done, total)` after each. */
export async function runPool(devices: Device[], fn: (d: Device) => Promise<void>, onProgress: (done: number, total: number) => void, limit = 4): Promise<BatchResult> {
  const res: BatchResult = { ok: 0, fails: [] };
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < devices.length) {
      const d = devices[next++];
      try { await fn(d); res.ok++; } catch (e) { res.fails.push({ device: d, reason: errText(e) }); }
      done++;
      onProgress(done, devices.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, devices.length) }, worker));
  return res;
}
