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

// 指纹浏览器左上角角标(badge)文案,对齐旧客户端 group 标签:平台名 · 账号昵称 · 备注 [· #任务简写]。
// 昵称登录后才读到(空则省略那段);taskId 仅在有任务上下文时传(登录/取材点一般取不到 → 不显示)。
const PLATFORM_ZH: Record<string, string> = {
  douyin: '抖音', xhs: '小红书', kuaishou: '快手', bilibili: 'B站', shipinhao: '视频号',
  toutiao: '头条', x: 'X', binance: '币安广场', youtube: 'YouTube', tiktok: 'TikTok',
};
export function accountBadgeLabel(acc: Pick<MatrixAccount, 'platform' | 'displayName' | 'nickname'>, taskId?: string): string {
  const parts: string[] = [PLATFORM_ZH[acc.platform] || acc.platform];
  if (acc.nickname) parts.push(acc.nickname);
  parts.push(acc.displayName);
  if (taskId) parts.push('#' + String(taskId).slice(0, 6));
  return parts.join(' · ');
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
/** 登录态/身份读取用的平台 key:快手创作端账号用 'kuaishou_creator'(独立登录态 + cp 接口读身份),
 *  其它(含快手主站)就是 platform 本身。用于 LOGIN_COOKIES / IDENTITY_EXPR 等按场景查表。 */
export function platformKey(acc: Pick<MatrixAccount, 'platform' | 'loginScope'>): string {
  return acc.platform === 'kuaishou' && acc.loginScope === 'creator' ? 'kuaishou_creator' : acc.platform;
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
  persona?: string;
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
    persona: args.persona,
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

/** 编辑账号元信息(备注名/赛道分组/人设/关键词)。只更新传入的字段。 */
export function updateAccountMeta(id: string, patch: { displayName?: string; group?: string; persona?: string; keywords?: string[]; track?: string }): void {
  const a = getAccount(id);
  if (!a) return;
  if (patch.displayName !== undefined) a.displayName = patch.displayName;
  if (patch.group !== undefined) a.group = patch.group;
  if (patch.persona !== undefined) a.persona = patch.persona;
  if (patch.keywords !== undefined) a.keywords = (patch.keywords || []).filter(Boolean);
  if (patch.track !== undefined) a.track = patch.track;
  persist();
}

/** 登录后写入真实身份(昵称/平台号/头像展示 + uid 绑定);只更新传入的非空字段。 */
export function setAccountIdentity(id: string, ident: { nickname?: string; displayId?: string; avatar?: string; boundUid?: string }): void {
  const a = getAccount(id);
  if (!a) return;
  if (ident.nickname) a.nickname = ident.nickname;
  if (ident.displayId) a.displayId = ident.displayId;
  if (ident.avatar) a.avatar = ident.avatar;
  if (ident.boundUid) a.boundUid = ident.boundUid;
  persist();
}

/** 断开关联:清掉读到的身份(昵称/平台号/头像/uid),保留账号配置。 */
export function clearAccountIdentity(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  delete a.nickname; delete a.displayId; delete a.avatar; delete a.boundUid;
  persist();
}

export function markPosted(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.lastPostAt = Date.now();
  persist();
}

/** 启动时清理「残留运行中」:上次任务跑到一半 app 被关 → status 卡在 'running' 写进了库,
 *  重启后卡片一直显示「运行中」。启动那刻没有任何任务在跑,把 running 全部复位成 idle(已关联)。 */
export function resetRunningToIdle(): void {
  const accts = loadAccounts();
  let changed = false;
  for (const a of accts) { if (a.status === 'running') { a.status = 'idle'; changed = true; } }
  if (changed) { cache = accts; persist(); }
}

/** 按平台 + 真实 uid 找【已被别的矩阵号关联】的账号(去重用:同一个真实平台账号不许关联到两个矩阵号)。 */
// platform 传 platformKey(快手区分主站/创作端):同一真实快手号【允许】各绑一个主站号+一个创作端号,
// 只在【同场景】内查重(传 'kuaishou_creator' 只撞创作端、传 'kuaishou' 只撞主站)。
export function findAccountByUid(platform: string, boundUid: string, excludeId: string): MatrixAccount | undefined {
  if (!boundUid) return undefined;
  return loadAccounts().find((a) => a.id !== excludeId && platformKey(a) === platform && a.boundUid === boundUid);
}

export function removeAccount(id: string): void {
  cache = loadAccounts().filter((a) => a.id !== id);
  persist();
}
