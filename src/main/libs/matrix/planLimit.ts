/**
 * 会员号数墙 —— 当前生效的「每平台号数上限」本地镜像。
 *
 * 背景:矩阵号存在本地(不上云),号数墙是客户端概念。运行时截断(超额号暂停)+ 列表置灰
 * 都需要知道「当前档位每平台能跑几个号」。这个值由渲染进程从 /api/ai/balance 拿到后推下来
 * (matrix:setPlanLimit),sidecar 的 runMatrixTaskById 读它来截断 —— 这样定时任务(无 auth
 * token、跑在 sidecar)也能正确按档位封顶,不用 sidecar 自己鉴权打后端。
 *
 * 默认(从未推送过)= maxAccountsPerPlatform 很大 → 不暂停任何号(宁可不拦,绝不误杀)。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../coworkLogger';

export interface PlanLimit {
  maxAccountsPerPlatform: number;
  planCode: string;
  subExpireAt: string | null;
  updatedAt: number;
}

const DEFAULT: PlanLimit = { maxAccountsPerPlatform: 9999, planCode: 'free', subExpireAt: null, updatedAt: 0 };

function baseDir(): string {
  return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
}
function storeFile(): string { return path.join(baseDir(), 'plan-limit.json'); }

let cache: PlanLimit | null = null;

export function getPlanLimit(): PlanLimit {
  if (cache) return cache;
  try {
    const f = storeFile();
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (obj && typeof obj.maxAccountsPerPlatform === 'number' && obj.maxAccountsPerPlatform > 0) {
        cache = { ...DEFAULT, ...obj };
        return cache;
      }
    }
  } catch (e) {
    coworkLog('WARN', 'planLimit', `read failed, using default: ${String(e)}`);
  }
  cache = { ...DEFAULT };
  return cache;
}

export function setPlanLimit(v: Partial<PlanLimit>): PlanLimit {
  const next: PlanLimit = {
    maxAccountsPerPlatform: typeof v.maxAccountsPerPlatform === 'number' && v.maxAccountsPerPlatform > 0 ? v.maxAccountsPerPlatform : DEFAULT.maxAccountsPerPlatform,
    planCode: v.planCode || DEFAULT.planCode,
    subExpireAt: v.subExpireAt ?? null,
    updatedAt: Date.now(),
  };
  cache = next;
  try {
    fs.mkdirSync(baseDir(), { recursive: true });
    const f = storeFile();
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) {
    coworkLog('WARN', 'planLimit', `persist failed: ${String(e)}`);
  }
  return next;
}

/**
 * 给定一个平台的全部账号(按绑定先后),返回「允许运行」的账号 id 集合 = 最早绑定的前 N 个。
 * 绑定顺序优先用 id 内嵌的 base36 创建时间戳(`${platform}_<ts36>_<rand>`),解析不出则回退入参顺序。
 */
export function allowedAccountIds(platformAccounts: Array<{ id: string }>, limit: number): Set<string> {
  if (!Number.isFinite(limit) || limit <= 0) return new Set(platformAccounts.map((a) => a.id));
  const sorted = [...platformAccounts].sort((a, b) => createdTs(a.id) - createdTs(b.id));
  return new Set(sorted.slice(0, limit).map((a) => a.id));
}

function createdTs(id: string): number {
  const seg = String(id).split('_')[1] || '';
  const n = parseInt(seg, 36);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
