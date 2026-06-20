/**
 * 账号池 —— 矩阵号本地账号库(不上云,见 feedback_matrix_isolation_boundary)。
 *
 * 一号 = 身份 + 持久 profile 目录 + 固定指纹种子 + 固定代理 + 健康态。数据落本地
 * JSON;profile 目录持久(登录态长期粘)。指纹种子/代理一旦分配即固定,不漂移。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import type { MatrixAccount, AccountStatus, Fingerprint, Proxy } from './types';

function baseDir(): string {
  // 可被 env 覆盖(测试/自定义);默认放用户目录下,与成片输出同根。
  return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
}
function storeFile(): string { return path.join(baseDir(), 'accounts.json'); }
function profilesDir(): string { return path.join(baseDir(), 'profiles'); }

let cache: MatrixAccount[] | null = null;

function ensureDirs(): void {
  fs.mkdirSync(baseDir(), { recursive: true });
  fs.mkdirSync(profilesDir(), { recursive: true });
}

export function loadAccounts(): MatrixAccount[] {
  if (cache) return cache;
  const f = storeFile();
  if (!fs.existsSync(f)) { cache = []; return cache; }
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache = Array.isArray(arr) ? arr : [];
  } catch (e) {
    // 解析失败【绝不静默清空】(否则丢光账号 + 永久固定指纹种子,不可恢复)。
    // 先把坏文件备份留证,再以空集起步,让用户知道并可从备份/profile 目录抢救。
    try { fs.copyFileSync(f, `${f}.corrupt.${Date.now()}`); } catch { /* ignore */ }
    coworkLog('ERROR', 'accountManager', `accounts.json parse failed, backed up; starting empty: ${String(e)}`);
    cache = [];
  }
  return cache;
}

function persist(): void {
  ensureDirs();
  // 原子写:先写临时文件再 rename,避免写到一半被 kill 导致 JSON 截断损坏。
  const f = storeFile();
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache || [], null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

export function listAccounts(): MatrixAccount[] {
  return [...loadAccounts()];
}
export function getAccount(id: string): MatrixAccount | undefined {
  return loadAccounts().find((a) => a.id === id);
}
export function accountsByPlatform(platform: string): MatrixAccount[] {
  return loadAccounts().filter((a) => a.platform === platform);
}
export function accountsByGroup(group: string): MatrixAccount[] {
  return loadAccounts().filter((a) => a.group === group);
}

/** 新建一个号:生成固定指纹种子 + 持久 profile 目录。代理后续单独绑定。 */
export function createAccount(args: {
  platform: string;
  displayName: string;
  group?: string;
  fingerprint?: Partial<Fingerprint>;
  proxy?: Proxy;
  keywords?: string[];
  track?: string;
  kernelVersion?: string;
}): MatrixAccount {
  ensureDirs();
  const accounts = loadAccounts();
  const id = `${args.platform}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const seed = args.fingerprint?.seed ?? Math.floor(Math.random() * 0xffffffff);
  const account: MatrixAccount = {
    id,
    platform: args.platform,
    displayName: args.displayName,
    group: args.group,
    status: 'login_required',           // 新号默认需扫码登录
    userDataDir: path.join(profilesDir(), id),
    fingerprint: {
      seed,
      platformOs: args.fingerprint?.platformOs ?? 'windows',
      brand: args.fingerprint?.brand ?? 'Chrome',
      hardwareConcurrency: args.fingerprint?.hardwareConcurrency ?? 8,
      lang: args.fingerprint?.lang ?? 'zh-CN',
      timezone: args.fingerprint?.timezone ?? 'Asia/Shanghai',
    },
    proxy: args.proxy,
    keywords: Array.isArray(args.keywords) ? args.keywords.filter(Boolean) : [],
    track: args.track || `${args.platform}_default`,
    kernelVersion: args.kernelVersion || undefined,
  };
  accounts.push(account);
  cache = accounts;
  persist();
  return account;
}

export function upsertAccount(account: MatrixAccount): void {
  const accounts = loadAccounts();
  const i = accounts.findIndex((a) => a.id === account.id);
  if (i >= 0) accounts[i] = account; else accounts.push(account);
  cache = accounts;
  persist();
}

export function setAccountStatus(id: string, status: AccountStatus): void {
  const a = getAccount(id);
  if (!a) return;
  a.status = status;
  persist();
}

export function setAccountProxy(id: string, proxy: Proxy): void {
  const a = getAccount(id);
  if (!a) return;
  a.proxy = proxy;                       // 绑定后视为固定,不应再换 host/port
  persist();
}

export function setAccountKeywords(id: string, keywords: string[], track?: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.keywords = (keywords || []).filter(Boolean);
  if (track !== undefined) a.track = track;
  persist();
}

export function setAccountKernelVersion(id: string, version: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.kernelVersion = version || undefined;
  persist();
}

export function markPosted(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.lastPostAt = Date.now();
  persist();
}

export function removeAccount(id: string): void {
  cache = loadAccounts().filter((a) => a.id !== id);
  persist();
}
