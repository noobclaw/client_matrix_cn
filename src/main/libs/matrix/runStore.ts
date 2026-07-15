/**
 * 矩阵运行记录存储 —— 每次任务跑完存一条(供「矩阵涨粉运行记录」页查看),
 * 本地 JSON,与 accounts.json / tasks.json 同目录。对齐老客户端 runRecords 的概念。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../coworkLogger';

function baseDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }
function storeFile(): string { return path.join(baseDir(), 'runs.json'); }

const MAX_RECORDS = 200;

export interface MatrixRunItem { accountId: string; displayName?: string; state: 'success' | 'failed' | 'skipped'; reason?: string; counts?: { like: number; follow: number; comment: number }; chargedCredits?: number; chargedUsd?: number }
export interface MatrixRunRecord {
  id: string;
  taskId: string;
  taskName: string;
  platform: string;
  // 任务类型(engage/reply_fan/video_download/image_text/viral_rewrite/x_post/binance_post/…)。
  // 运行记录显示端按此还原正确的场景名(缺=老记录→回退 engage)。
  type?: string;
  startedAt: number;
  finishedAt: number;
  success: number;
  failed: number;
  skipped: number;
  // like/follow/comment=互动维度;post(图文发帖数)/download(视频下载条数)按任务类型可选,
  // 各任务只填自己有的那个(engage 三类、image_text 填 post、video_download 填 download)。
  totals: { like: number; follow: number; comment: number; post?: number; download?: number };
  // 本次运行总扣费(各号实际扣费之和):credits=积分,usd=美元。缺省视为 0(老记录无此字段)。
  cost?: { credits: number; usd: number };
  items: MatrixRunItem[];
}

let cache: MatrixRunRecord[] | null = null;

function load(): MatrixRunRecord[] {
  if (cache) return cache;
  const f = storeFile();
  if (!fs.existsSync(f)) { cache = []; return cache; }
  try { const arr = JSON.parse(fs.readFileSync(f, 'utf8')); cache = Array.isArray(arr) ? arr : []; }
  catch (e) { coworkLog('ERROR', 'matrixRunStore', `runs.json parse failed: ${String(e)}`); cache = []; }
  return cache;
}
function persist(): void {
  fs.mkdirSync(baseDir(), { recursive: true });
  const f = storeFile(); const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache || [], null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

/** 新增一条运行记录(最新在前,封顶 MAX_RECORDS)。 */
export function addRun(rec: Omit<MatrixRunRecord, 'id'>): MatrixRunRecord {
  const list = load();
  const full: MatrixRunRecord = { ...rec, id: `run_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}` };
  list.unshift(full);
  if (list.length > MAX_RECORDS) list.length = MAX_RECORDS;
  cache = list; persist();
  return full;
}

export function listRuns(taskId?: string): MatrixRunRecord[] {
  const all = load();
  return taskId ? all.filter((r) => r.taskId === taskId) : [...all];
}
