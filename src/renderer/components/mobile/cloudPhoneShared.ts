import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';
import { noobClawAuth } from '../../services/noobclawAuth';

/**
 * 云手机 — shared types, strings and helpers for MyPhonesView / PhoneCard / PhoneTaskDetail / PhoneTaskEditor.
 * API: /api/mobile-console (desktop login token). See the cloud phone contract (devices, tasks, steps, commands).
 */

// ───────────────────────── i18n ─────────────────────────
/** Simplified (zh) · Traditional (zh-TW) · English (everything else). */
export const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};
export const isZh = (): boolean => i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';

// ───────────────────────── types ─────────────────────────
export type Counts = Record<string, number>;
export type PlatformId = 'tiktok' | 'douyin' | 'xhs';
export interface Step { ts: number; c: string; a?: Record<string, unknown> | null }
export type Schedule = { kind: 'every'; hours: number } | { kind: 'daily'; at: string } | { kind: 'manual' };

export interface Progress {
  run_id: string; task_id: string; counts: Counts; targets: Counts; credits: number; usd: number; started_at: number; steps: Step[];
}
export interface TaskView {
  id: string; name: string; script_id: string; platform: string; schedule: Schedule | null; tz: string;
  mode: 'keywords' | 'precise'; keywords: string[]; targets: string[]; level: string; persona: string;
  caps: { likes: number; comments: number; follows: number; leads: number };
  last_run_at: number | null; last_status: string | null; next_run_at: number | null;
  totals: Counts; credits_total: number; usd_total: number;
  last_counts: Counts; last_credits: number; last_usd: number; runs: number;
  raw: RawTask;
}
/** Full task object as stored (mobile_tasks.data.tasks[]); unknown fields are kept untouched. */
export interface RawTask {
  id: string; name: string; script_id: string; platform?: string; schedule?: Schedule; tz?: string;
  max_likes?: number; max_comments?: number; max_follows?: number; persona?: string;
  config?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface Device {
  id: string; vendor: string; app_ver: string; ip?: string; online: boolean; last_seen: number; created_at: number;
  a11y: boolean; running: boolean; over_limit?: boolean;
  apps?: { tiktok?: boolean };
  accounts?: { tiktok?: { handle?: string; nickname?: string } | null };
  tasks: TaskView[];
  progress: Progress | null;
}
export interface Run {
  run_id: string; status: string; reason: string; dry_run: boolean; task_id: string; counts: Counts;
  credits: number; usd: number; duration_ms: number; at: number;
}
export interface ConsoleConfig { apk_url?: string; vmos_url?: string }

// ───────────────────────── API ─────────────────────────
export class ApiError extends Error {
  status: number;
  constructor(code: string, status: number) { super(code); this.status = status; }
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getBackendApiUrl()}/api/mobile-console${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...noobClawAuth.getAuthHeaders(), ...((init?.headers as Record<string, string>) || {}) },
  });
  if (res.status === 401) noobClawAuth.handleAuthExpired();
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(String(j?.error || `HTTP ${res.status}`), res.status);
  return j as T;
}

/** Turns an API error code into a short sentence. */
export function errText(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  switch (code) {
    case 'phone_offline': return L('手机离线', '手機離線', 'The phone is offline');
    case 'phone_over_limit': return L('超出会员可用手机数，升级会员或移除不用的手机', '超出會員可用手機數，升級會員或移除不用的手機', "Over your plan's phone limit — upgrade or remove unused phones");
    case 'app_update_required': return L('请先把手机上的 NoobClaw App 更新到最新版', '請先把手機上的 NoobClaw App 更新到最新版', 'Update the NoobClaw app on the phone first');
    case 'phone_online': return L('手机在线，不能移除', '手機在線，不能移除', 'The phone is online and cannot be removed');
    case 'one_task_per_platform': return L('每个平台只能建 1 个任务', '每個平台只能建 1 個任務', 'Only one task per platform');
    default:
      if (code.startsWith('invalid_')) return L('任务设置有误：', '任務設定有誤：', 'Invalid task settings: ') + code.slice(8);
      return code;
  }
}

export async function putTasks(deviceId: string, tasks: RawTask[]): Promise<void> {
  await api(`/devices/${encodeURIComponent(deviceId)}/tasks`, { method: 'PUT', body: JSON.stringify({ tasks }) });
}
/** Replace (same id) or append one task; every other task is sent back exactly as the server gave it. */
export function saveTask(device: Device, task: RawTask): Promise<void> {
  const list = device.tasks.map((t) => t.raw).filter(Boolean);
  const next = list.some((t) => t.id === task.id) ? list.map((t) => (t.id === task.id ? task : t)) : [...list, task];
  return putTasks(device.id, next);
}
export function deleteTask(device: Device, taskId: string): Promise<void> {
  return putTasks(device.id, device.tasks.map((t) => t.raw).filter((t) => t && t.id !== taskId));
}
export async function sendCommand(deviceId: string, action: 'run' | 'stop', taskId?: string): Promise<void> {
  await api(`/devices/${encodeURIComponent(deviceId)}/command`, { method: 'POST', body: JSON.stringify({ action, task_id: taskId }) });
}

export function openExternal(url: string | undefined): void {
  if (!url) return;
  try {
    if (window.electron?.shell?.openExternal) { void window.electron.shell.openExternal(url); return; }
  } catch { /* fall through */ }
  window.open(url, '_blank', 'noopener');
}

// ───────────────────────── scripts / levels ─────────────────────────
export interface Platform { id: PlatformId; name: () => string; live: boolean }
export const PLATFORMS: Platform[] = [
  { id: 'tiktok', name: () => 'TikTok', live: true },
  { id: 'douyin', name: () => L('抖音', '抖音', 'Douyin'), live: false },
  { id: 'xhs', name: () => L('小红书', '小紅書', 'RedNote'), live: false },
];

/** Platforms not hidden by the compliance config (complianceHiddenPlatforms from /api/matrix/config). */
export const visiblePlatforms = (hidden: string[]): Platform[] => PLATFORMS.filter((p) => !hidden.includes(p.id));

export const SCRIPT_IDS = ['tiktok_comment_like', 'tiktok_lead_engage'] as const;
export type ScriptId = typeof SCRIPT_IDS[number];
export const isLead = (scriptId: string): boolean => scriptId === 'tiktok_lead_engage';
export const scriptName = (scriptId: string): string => (isLead(scriptId)
  ? L('定向获客任务', '定向獲客任務', 'Lead engage task')
  : L('评论区点赞任务', '評論區點讚任務', 'Comment likes task'));
export const scriptShort = (scriptId: string): string => (isLead(scriptId)
  ? L('定向获客', '定向獲客', 'Lead engage')
  : L('评论区点赞', '評論區點讚', 'Comment likes'));

export interface Caps { likes: number; comments: number; follows: number; leads: number }
export const LEVELS: Record<ScriptId, Record<'low' | 'mid' | 'high', Caps>> = {
  tiktok_comment_like: { low: { likes: 30, comments: 5, follows: 0, leads: 0 }, mid: { likes: 100, comments: 15, follows: 0, leads: 0 }, high: { likes: 300, comments: 30, follows: 0, leads: 0 } },
  tiktok_lead_engage: { low: { likes: 10, comments: 5, follows: 10, leads: 10 }, mid: { likes: 30, comments: 15, follows: 30, leads: 30 }, high: { likes: 100, comments: 30, follows: 50, leads: 100 } },
};

/** Count keys shown for a script, in display order, with emoji + label. */
export function countKeys(scriptId: string): { k: string; icon: string; label: () => string }[] {
  return isLead(scriptId)
    ? [
      { k: 'lead_new', icon: '🎯', label: () => L('新客户', '新客戶', 'Leads') },
      { k: 'follow', icon: '➕', label: () => L('关注', '關注', 'Follows') },
      { k: 'comment', icon: '💬', label: () => L('评论', '評論', 'Comments') },
      { k: 'like', icon: '👍', label: () => L('点赞', '點讚', 'Likes') },
    ]
    : [
      { k: 'like', icon: '👍', label: () => L('点赞', '點讚', 'Likes') },
      { k: 'comment', icon: '💬', label: () => L('回复', '回覆', 'Replies') },
    ];
}
/** "点赞 1,286 · 回复 174" (lead scripts skip likes unless there are some). */
export function fmtTotals(scriptId: string, c: Counts | null | undefined): string {
  return countKeys(scriptId)
    .filter(({ k }) => !(isLead(scriptId) && k === 'like' && !(c?.[k])))
    .map(({ k, label }) => `${label()} ${num(c?.[k] || 0)}`).join(' · ');
}
/** "👍 86 · 💬 12" for run rows. */
export function fmtCountsIcons(scriptId: string, c: Counts | null | undefined): string {
  const parts = countKeys(scriptId).filter(({ k }) => (c?.[k] || 0) > 0).map(({ k, icon }) => `${icon} ${num(c![k])}`);
  return parts.join(' · ') || '—';
}
export function capsText(scriptId: string, caps: Partial<Caps> | null | undefined): string {
  const c = caps || {};
  return isLead(scriptId)
    ? `${L('新客户', '新客戶', 'Leads')} ${c.leads || 0} · ${L('关注', '關注', 'Follows')} ${c.follows || 0} · ${L('评论', '評論', 'Comments')} ${c.comments || 0}`
    : `${L('点赞', '點讚', 'Likes')} ${c.likes || 0} · ${L('回复', '回覆', 'Replies')} ${c.comments || 0}`;
}
/** Label of the "where" row: keywords, or links (comment likes) / rival accounts (lead). */
export function targetLabel(scriptId: string, mode: string): string {
  if (mode !== 'precise') return L('关键词', '關鍵詞', 'Keywords');
  return isLead(scriptId) ? L('同行账号', '同行帳號', 'Rival accounts') : L('链接', '連結', 'Links');
}
export const modeName = (mode: string): string => (mode === 'precise' ? L('精准模式', '精準模式', 'Precise mode') : L('关键词模式', '關鍵詞模式', 'Keyword mode'));
export const shortTarget = (s: string): string => s.replace(/^https?:\/\/(www\.)?/i, '');

// ───────────────────────── formatting ─────────────────────────
export const num = (n: number): string => Number(n || 0).toLocaleString('en-US');
export const fmtUsd = (usd: number): string => `$${Number(usd || 0).toFixed(4)}`;
export const fmtCost = (credits: number, usd: number): string => `💎 ${num(credits)} ≈ ${fmtUsd(usd)}`;
const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const hhmm = (ms: number): string => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** "10:12" today, "10/30 21:10" otherwise. */
export function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return sameDay(d, new Date()) ? hhmm(ms) : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hhmm(ms)}`;
}
/** "今天 20:00" / "明天 09:30" / "11/02 09:30". */
export function fmtNext(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const day = sameDay(d, now) ? L('今天', '今天', 'Today') : sameDay(d, tomorrow) ? L('明天', '明天', 'Tomorrow') : `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return `${day} ${hhmm(ms)}`;
}
export function fmtRelFuture(ms: number): string {
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (mins < 60) return L(`${mins} 分钟后`, `${mins} 分鐘後`, `in ${mins} min`);
  if (mins < 24 * 60) { const h = Math.round(mins / 60); return L(`${h} 小时后`, `${h} 小時後`, `in ${h} h`); }
  const dd = Math.round(mins / 1440); return L(`${dd} 天后`, `${dd} 天後`, `in ${dd} d`);
}
export const fmtDuration = (ms: number): string => {
  const m = Math.max(1, Math.round((ms || 0) / 60000));
  return L(`${m} 分钟`, `${m} 分鐘`, `${m} min`);
};

export function scheduleText(s: Schedule | null | undefined): string {
  if (!s || s.kind === 'manual') return L('手动', '手動', 'Manual');
  if (s.kind === 'daily') return L(`每天 ${s.at}`, `每天 ${s.at}`, `Daily ${s.at}`);
  if (s.hours === 0.5) return L('每 30 分钟', '每 30 分鐘', 'Every 30 min');
  return L(`每 ${s.hours} 小时`, `每 ${s.hours} 小時`, `Every ${s.hours} h`);
}
export const isManual = (s: Schedule | null | undefined): boolean => !s || s.kind === 'manual';
export function nextRunText(t: TaskView): string {
  if (isManual(t.schedule)) return L('手动运行', '手動運行', 'Manual');
  return t.next_run_at ? fmtNext(t.next_run_at) : '—';
}
/** Warning for the last run when it was cut short by something the user should know about. */
export function lastWarn(status: string | null | undefined): string {
  switch (status) {
    case 'verify_stop': return L('上次被验证打断', '上次被驗證打斷', 'Last run hit a TikTok verification');
    case 'not_logged_in': return L('上次 TikTok 未登录', '上次 TikTok 未登入', 'TikTok was logged out last time');
    case 'error': case 'failed': return L('上次运行出错', '上次運行出錯', 'Last run failed');
    default: return '';
  }
}
/** Status chip of a finished run. */
export function runStatus(r: Run): { text: string; tone: 'done' | 'stop' } {
  if (r.status === 'done') return { text: L('完成', '完成', 'Done'), tone: 'done' };
  if (r.status === 'stopped') return { text: L('已停止', '已停止', 'Stopped'), tone: 'stop' };
  return { text: L('被打断', '被打斷', 'Interrupted'), tone: 'stop' };
}

// ───────────────────────── friendly steps ─────────────────────────
const str = (v: unknown): string => (v == null ? '' : String(v));
/** Renders one step code; unknown codes return '' (the caller skips them). */
export function stepText(step: Step): string {
  const a = step.a || {};
  switch (step.c) {
    case 'open_app': return L('打开 TikTok', '打開 TikTok', 'Open TikTok');
    case 'account_ok': return L('确认账号', '確認帳號', 'Account checked');
    case 'search': return L(`搜索「${str(a.kw)}」`, `搜尋「${str(a.kw)}」`, `Search “${str(a.kw)}”`);
    case 'open_link': return L('打开指定作品', '打開指定作品', 'Open the chosen video');
    case 'open_rival': return L('打开同行主页', '打開同行主頁', "Open a rival's profile");
    case 'open_comments': return L('打开视频，看评论区', '打開影片，看評論區', 'Open a video and read the comments');
    case 'ai_writing': return L('AI 正在写回复', 'AI 正在寫回覆', 'AI is writing a reply');
    case 'replied': return L(`回复已发出：“${str(a.text)}”`, `回覆已發出：「${str(a.text)}」`, `Reply sent: “${str(a.text)}”`);
    case 'video_summary': return L(`这条视频：点赞 ${str(a.likes || 0)} · 回复 ${str(a.replies || 0)}`, `這條影片：點讚 ${str(a.likes || 0)} · 回覆 ${str(a.replies || 0)}`, `This video: ${str(a.likes || 0)} likes · ${str(a.replies || 0)} replies`);
    case 'next_video': return L('换下一条视频', '換下一條影片', 'Next video');
    case 'reach_old_leads': return L('先联系之前找到的潜在客户', '先聯繫之前找到的潛在客戶', 'Reaching leads found earlier');
    case 'collect_leads': return L('在评论区找潜在客户', '在評論區找潛在客戶', 'Looking for leads in the comments');
    case 'leads_found': return L(`已找到 ${str(a.n || 0)} 个潜在客户`, `已找到 ${str(a.n || 0)} 個潛在客戶`, `Found ${str(a.n || 0)} leads`);
    case 'reach_leads': return L('开始联系潜在客户', '開始聯繫潛在客戶', 'Reaching out to leads');
    case 'reach_lead': return L('打开一位潜在客户的主页', '打開一位潛在客戶的主頁', "Open a lead's profile");
    case 'lead_liked': return L('给 TA 的作品点了赞', '給 TA 的作品點了讚', 'Liked their video');
    case 'lead_commented': return L(`给 TA 留言：“${str(a.text)}”`, `給 TA 留言：「${str(a.text)}」`, `Commented: “${str(a.text)}”`);
    case 'lead_followed': return L('关注了 TA', '關注了 TA', 'Followed them');
    case 'done': return L('本次运行完成', '本次運行完成', 'Run finished');
    case 'cap_reached': return L('达到本次上限，结束', '達到本次上限，結束', 'Reached the limit for this run');
    case 'time_up': return L('到达本次运行时长，结束', '到達本次運行時長，結束', 'Time is up for this run');
    case 'not_logged_in': return L('TikTok 未登录，已停止', 'TikTok 未登入，已停止', 'TikTok is logged out — stopped');
    case 'verify_stop': return L('TikTok 弹出验证，已自动停止', 'TikTok 彈出驗證，已自動停止', 'TikTok asked for verification — stopped');
    case 'stopped': return L('已停止', '已停止', 'Stopped');
    case 'stopped_other': return L('运行中断', '運行中斷', 'Run interrupted');
    default: return '';
  }
}
/** Steps → [{time, text}] with unknown codes dropped. */
export function stepLines(steps: Step[] | null | undefined): { time: string; text: string }[] {
  return (steps || []).map((s) => ({ time: s.ts ? hhmm(s.ts) : '', text: stepText(s) })).filter((x) => x.text);
}

// ───────────────────────── account avatar ─────────────────────────
const AV = ['#7b5cf6', '#00a3ff', '#ff6a3d', '#e2468a', '#14b8a6', '#f59e0b', '#6366f1', '#22c55e'];
/** Stable colour per account: the same handle always gets the same colour. */
export function avatarColor(handle: string): string {
  let n = 0;
  for (const c of String(handle)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return AV[n % AV.length];
}
export function accountOf(d: Device): { handle: string; nickname: string } | null {
  const a = d.accounts?.tiktok;
  if (!a || !a.handle) return null;
  const handle = a.handle.startsWith('@') ? a.handle : `@${a.handle}`;
  return { handle, nickname: a.nickname || '' };
}

// ───────────────────────── shared class names ─────────────────────────
export const txt = 'dark:text-claude-darkText text-claude-text';
export const sub = 'dark:text-claude-darkTextSecondary text-claude-textSecondary';
export const bd = 'dark:border-claude-darkBorder border-claude-border';
export const surface = 'dark:bg-claude-darkSurface bg-claude-surface';
export const surface2 = 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover';
export const btnBase = 'inline-flex items-center justify-center font-bold rounded-[10px] border transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
export const btnGhost = `${btnBase} ${bd} ${surface2} ${txt} hover:border-claude-accent/60`;
export const btnPrimary = `${btnBase} border-claude-accent bg-claude-accent text-[#04140c] hover:opacity-90`;
