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
import { pruneAccountFromTasks } from './taskStore';
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
  instagram: 'Instagram', facebook: 'Facebook', reddit: 'Reddit',
};
export function accountBadgeLabel(acc: Pick<MatrixAccount, 'platform' | 'displayName' | 'nickname'>, taskId?: string): string {
  const parts: string[] = [PLATFORM_ZH[acc.platform] || acc.platform];
  if (acc.nickname) parts.push(acc.nickname);
  parts.push(acc.displayName);
  if (taskId) parts.push('#' + String(taskId).slice(0, 6));
  return parts.join(' · ');
}

// 浏览器标签分组(蓝色 pill)标题 —— 对齐旧客户端扩展 '🤖 ' + key 的约定:只放【🤖 + 平台 + 任务id缩写】。
// 账号信息(昵称/备注)交给窗口左上角绿色角标(label),pill 不再重复 → 多窗一眼看出「是哪个任务」。
// 任务id缩写取【唯一尾巴】(平台/类型前缀已被平台名覆盖):binance_engage_l8x2k_3a → l8x2k_3a;
//   无下划线分段(异常 id)则回退末 6 位。无 taskId(登录/保活无任务上下文)→ 只 🤖 + 平台。
export function matrixGroupTitle(platform: string, taskId?: string): string {
  const plat = PLATFORM_ZH[platform] || platform;
  if (!taskId) return `🤖 ${plat}`;
  const segs = String(taskId).split('_').filter(Boolean);
  const abbr = segs.length >= 2 ? segs.slice(-2).join('_') : String(taskId).slice(-6);
  return `🤖 ${plat} #${abbr}`;
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
  loginScope?: 'main' | 'creator';   // 仅快手:主站 / 创作者中心
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
    loginScope: args.platform === 'kuaishou' ? (args.loginScope || 'main') : undefined,
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

// SSE 广播注入(sidecar 启动时 setAccountSSEBroadcast(broadcastSSE),动态 import 避免循环依赖)。
// setAccountStatus 变更后广播 'matrix:account' → 渲染层 onAccount 触发 reload,「我的矩阵账号」卡片实时刷新。
// 之前只 persist() 落盘:任务里标 login_required 后,开着的账号页看不到、须重开页才刷新(用户实测币安发帖过期卡片不变红)。
let _accountSSEBroadcast: ((event: string, data: unknown) => void) | null = null;
export function setAccountSSEBroadcast(fn: (event: string, data: unknown) => void): void {
  _accountSSEBroadcast = fn;
}

export function setAccountStatus(id: string, status: AccountStatus): void {
  const a = getAccount(id);
  if (!a) return;
  const changed = a.status !== status;
  a.status = status;
  // 重新连上(翻 idle)即清「主动断开」标记 —— 所有连接成功路径(扫码/导入/刷新/保活自愈)都经这里,单点收口。
  if (status === 'idle' && a.manualDisconnect) delete a.manualDisconnect;
  persist();
  // 状态真变了才广播(避免 running→running 之类空转刷屏);payload 带 id/status,渲染层收到即整表 reload。
  if (changed) { try { _accountSSEBroadcast?.('matrix:account', { id, status }); } catch { /* 广播失败不影响落盘 */ } }
}

/** 标记「刚确认该号登录态有效」(任务/发布/保活成功时调)。主动保活据 lastAliveAt 筛「超 N 天没活跃」的号。 */
export function markAccountAlive(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.lastAliveAt = Date.now();
  persist();
  // 刚确认登录有效 → 若此前被【瞬时误判】标成 login_required(页面没加载完/慢代理/WAF 挑战等),翻回 idle,
  // 别让红「过期」一直挂到手动重连。之前 keepAlive 复验成功只更 lastAliveAt 不清状态 → 好号一旦被误标就永久红,
  // 用户实测「好多号显示过期、点开却登录着」。只翻 login_required 这一种,不动 running/banned/limited。
  if (a.status === 'login_required') setAccountStatus(id, 'idle');
}

// ── 本机出口 IP(无代理号的真实公网出口)──
// 内核里 fetch ip 服务读到的出口 IP(反映是否走 VPN);主进程 undici 不一定走 VPN,所以必须由内核侧探测后写进来
// (见 kernelPool 起内核后的探测)。所有【无代理】号同机同路由共用一个出口,故全局存一个值即可,落小文件跨重启保留。
let localEgressIp: string | null | undefined;  // undefined=未从盘加载, null=未知, string=已知
function localIpFile(): string { return path.join(baseDir(), 'local_ip.json'); }
export function getLocalEgressIp(): string | null {
  if (localEgressIp === undefined) {
    try { const j = JSON.parse(fs.readFileSync(localIpFile(), 'utf8')); localEgressIp = (j && typeof j.ip === 'string') ? j.ip : null; } catch { localEgressIp = null; }
  }
  return localEgressIp || null;
}
export function setLocalEgressIp(ip: string | null): void {
  const v = (ip || '').trim() || null;
  if (v === getLocalEgressIp()) return;  // 没变化不写盘
  localEgressIp = v;
  try { ensureDirs(); fs.writeFileSync(localIpFile(), JSON.stringify({ ip: v, at: Date.now() }), 'utf8'); } catch { /* ignore */ }
}

/**
 * 角标用:该号代理 IP 展示文案 + 是否与别的号【撞 IP】+ 有无代理。
 * 撞 IP 判定规则(2026-06-23 用户明确,本机/代理统一):
 *   · 只在【同一平台】内算(按 platformKey:快手创作端 cp 与主站 www 分开算两个平台);
 *   · 同平台 + 同 IP(本机默认 或 同一个代理 host)的号,按列表顺序【第一个免提示】,第 2 个起复用才标红;
 *   · 本机和代理一视同仁:本机第一个 OK、第 2 个本机号标红;某代理 host 第一个 OK、第 2 个用同 host 的号标红。
 */
export function proxyBadgeInfo(id: string): { text: string; duplicate: boolean; hasProxy: boolean } {
  const accts = loadAccounts();
  const a = accts.find((x) => x.id === id);
  if (!a) return { text: '本机默认', duplicate: false, hasProxy: false };
  const pk = platformKey(a);
  const ipIdOf = (x: MatrixAccount): string => (x.proxy ? x.proxy.host : '__local__');
  const ipId = ipIdOf(a);
  // 同平台 + 同 IP 的号,按列表顺序:第一个免提示,第 2 个起复用才标红。
  const sameBucket = accts.filter((x) => platformKey(x) === pk && ipIdOf(x) === ipId);
  const isFirst = sameBucket.length > 0 && sameBucket[0].id === a.id;
  // 无代理号:显示【真实本机出口 IP】(探到才有),没探到回落「本机默认」。
  const localText = getLocalEgressIp() ? `本机 ${getLocalEgressIp()}` : '本机默认';
  return {
    text: a.proxy ? a.proxy.host : localText,
    duplicate: sameBucket.length > 1 && !isFirst,
    hasProxy: !!a.proxy,
  };
}

export function setAccountProxy(id: string, proxy: Proxy): void {
  const a = getAccount(id);
  if (!a) return;
  a.proxy = proxy;                       // 绑定后视为固定,不应再换 host/port
  persist();
}

/** 写入代理连通性探测结果(连接/刷新/保活时探一次)。卡片「代理IP」chip 据此上色:ok=绿、dead=红。 */
export function setProxyHealth(id: string, health: 'ok' | 'leaking' | 'banned' | 'dead'): void {
  const a = getAccount(id);
  if (!a || !a.proxy) return;
  if (a.proxy.health === health) return;  // 没变化不写盘
  a.proxy.health = health;
  persist();
}

export function setAccountKeywords(id: string, keywords: string[], track?: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.keywords = (keywords || []).filter(Boolean);
  if (track !== undefined) a.track = track;
  persist();
}

/** AI 衍生关键词池上限(到顶且仍耗尽 → 整批换)。 */
export const DERIVED_KEYWORDS_CAP = 30;

/**
 * 把 AI 衍生的新词追加进【衍生池】(account.derivedKeywords),【绝不动原始 keywords】。
 *  · 衍生词若与原始词重复则丢弃(避免冗余)。
 *  · 池未满(<30):去重追加,封顶 30。
 *  · 池已满(>=30)还在衍生(=旧池关键词也搜尽)→ 整批换:丢掉旧衍生池,换成这批新词(封顶 30)。
 * 各任务 runner 的 ctx.appendKeywords 统一走这里 → 原始词永留、衍生池受控可换。
 */
export function appendDerivedKeywords(id: string, newWords: string[]): void {
  const a = getAccount(id);
  if (!a) return;
  const orig = new Set((a.keywords || []).map((k) => String(k || '').trim()).filter(Boolean));
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const w of (newWords || [])) {
    const k = String(w || '').trim();
    if (!k || orig.has(k) || seen.has(k)) continue;
    seen.add(k); fresh.push(k);
  }
  if (!fresh.length) return;
  const cur = (a.derivedKeywords || []).map((k) => String(k || '').trim()).filter(Boolean);
  let next: string[];
  if (cur.length >= DERIVED_KEYWORDS_CAP) {
    next = fresh.slice(0, DERIVED_KEYWORDS_CAP);                 // 整批换
  } else {
    next = Array.from(new Set([...cur, ...fresh])).slice(0, DERIVED_KEYWORDS_CAP); // 追加
  }
  a.derivedKeywords = next;
  persist();
}

/** 搜索用的有效关键词 = 原始词 + 衍生词(去重)。 */
export function effectiveKeywords(acc: { keywords?: string[]; derivedKeywords?: string[] } | null | undefined): string[] {
  if (!acc) return [];
  const orig = (acc.keywords || []).map((k) => String(k || '').trim()).filter(Boolean);
  const der = (acc.derivedKeywords || []).map((k) => String(k || '').trim()).filter(Boolean);
  return Array.from(new Set([...orig, ...der]));
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

/** 用户主动「断开连接」:标记之,让 keepAlive 不再把它当「疑似误标过期」每轮开窗复验(见 MatrixAccount.manualDisconnect)。 */
export function markManualDisconnect(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.manualDisconnect = true;
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
  // 联动清理任务引用:否则 tasks.json 仍带着已删账号 id → 运行时变幽灵号被误判「超额暂停」。
  // (taskStore 不 import accountManager,无循环依赖。)
  pruneAccountFromTasks(id);
}
