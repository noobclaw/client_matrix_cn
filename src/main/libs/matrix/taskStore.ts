/**
 * 矩阵任务存储 —— 本地 JSON,与 accounts.json 同目录(见 accountManager)。
 *
 * 约束(产品定义):每平台最多 5 个任务、同平台同类型只允许 1 个(重复无意义);
 * 全局同时只跑 1 个 —— 那个「运行时锁」在 sidecar 侧维护,不在这里。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import { nextRunAt } from './matrixSchedule';
import type { MatrixTask, EngageQuota, ReplyFanConfig, MatrixTaskType, MatrixTaskFrequency } from './types';

/** 任务启用且非 once 才排下次运行;否则清空(手动触发)。 */
function planned(t: { enabled: boolean; frequency: MatrixTaskFrequency }, fromTs: number, isFirst: boolean): number | undefined {
  return t.enabled && t.frequency !== 'once' ? nextRunAt(t.frequency, fromTs, isFirst) : undefined;
}

function baseDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }
function storeFile(): string { return path.join(baseDir(), 'tasks.json'); }

const MAX_PER_PLATFORM = 5;
let cache: MatrixTask[] | null = null;

export function loadTasks(): MatrixTask[] {
  if (cache) return cache;
  const f = storeFile();
  if (!fs.existsSync(f)) { cache = []; return cache; }
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache = Array.isArray(arr) ? arr : [];
  } catch (e) {
    // 坏文件备份留证,不静默清空。
    try { fs.copyFileSync(f, `${f}.corrupt.${Date.now()}`); } catch { /* ignore */ }
    coworkLog('ERROR', 'taskStore', `tasks.json parse failed, backed up; starting empty: ${String(e)}`);
    cache = [];
  }
  return cache;
}

function persist(): void {
  fs.mkdirSync(baseDir(), { recursive: true });
  const f = storeFile();
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache || [], null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

export function listTasks(): MatrixTask[] { return [...loadTasks()]; }
export function getTask(id: string): MatrixTask | undefined { return loadTasks().find((t) => t.id === id); }

export interface SaveTaskInput {
  id?: string;                       // 传则更新,不传则新建
  platform: string;
  type: MatrixTaskType;
  name?: string;
  enabled?: boolean;
  accountIds: string[];
  quota?: EngageQuota;             // engage 必填;reply_fan 可省(存空对象)
  funnel?: ReplyFanConfig;         // reply_fan 用:引流尾巴配置
  concurrency?: number;
  frequency: MatrixTaskFrequency;
}
export interface SaveTaskResult { ok: boolean; error?: string; task?: MatrixTask }

/** 新建/更新任务,带约束校验。 */
export function saveTask(input: SaveTaskInput): SaveTaskResult {
  const tasks = loadTasks();

  if (input.id) {
    const i = tasks.findIndex((t) => t.id === input.id);
    if (i < 0) return { ok: false, error: 'task_not_found' };
    // 改 type 不能撞到同平台已有的别的同类型任务
    const dup = tasks.find((t) => t.id !== input.id && t.platform === input.platform && t.type === input.type);
    if (dup) return { ok: false, error: 'duplicate_type' };
    const updated: MatrixTask = {
      ...tasks[i],
      platform: input.platform, type: input.type,
      name: input.name || tasks[i].name,
      enabled: input.enabled ?? tasks[i].enabled,
      accountIds: input.accountIds || [],
      quota: input.quota || {},
      funnel: input.funnel ?? tasks[i].funnel,
      concurrency: input.concurrency,
      frequency: input.frequency,
    };
    updated.nextPlannedRunAt = planned(updated, Date.now(), true); // 配置变更视为从现在重排
    tasks[i] = updated; cache = tasks; persist();
    return { ok: true, task: updated };
  }

  const platformTasks = tasks.filter((t) => t.platform === input.platform);
  if (platformTasks.length >= MAX_PER_PLATFORM) return { ok: false, error: 'platform_task_limit' };
  if (platformTasks.some((t) => t.type === input.type)) return { ok: false, error: 'duplicate_type' };

  const task: MatrixTask = {
    id: `${input.platform}_${input.type}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    platform: input.platform,
    type: input.type,
    name: input.name || `${input.platform} 互动`,
    enabled: input.enabled ?? true,
    accountIds: input.accountIds || [],
    quota: input.quota || {},
    funnel: input.funnel,
    concurrency: input.concurrency,
    frequency: input.frequency || 'once',
    createdAt: Date.now(),
  };
  task.nextPlannedRunAt = planned(task, Date.now(), true);
  tasks.push(task); cache = tasks; persist();
  return { ok: true, task };
}

export function removeTask(id: string): void {
  cache = loadTasks().filter((t) => t.id !== id);
  persist();
}

export function setTaskEnabled(id: string, enabled: boolean): void {
  const t = getTask(id); if (!t) return;
  t.enabled = enabled;
  t.nextPlannedRunAt = planned(t, Date.now(), true);
  persist();
}

export function setTaskLastRun(id: string, ts: number): void {
  const t = getTask(id); if (!t) return;
  t.lastRunAt = ts;
  t.nextPlannedRunAt = planned(t, ts, false); // 跑完排下一次
  persist();
}

/** 调度器用:到点该自动跑的任务(启用、非 once、已到 nextPlannedRunAt)。 */
export function dueTasks(now: number): MatrixTask[] {
  return loadTasks().filter((t) => t.enabled && t.frequency !== 'once' && t.nextPlannedRunAt != null && t.nextPlannedRunAt <= now);
}
