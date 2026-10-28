/**
 * MatrixAccountKeywords — 矩阵向导里「账号横排 + 点开直接改关键词」的共用件(2026-10-28)。
 *
 * 用在所有依赖账号关键词的任务向导:批量拉黑(关键词模式)/ 互动涨粉 / 定向获客(关键词模式)/
 * 图文创作(网络实景图)/ 爆款仿写 / 币安广场搬运。用户不用再跑去「我的矩阵账号」改词。
 *
 * ⚠️ 关键词和「我的矩阵账号」是【同一份】:保存走 matrix.updateAccountMeta({ id, keywords }),
 *   口径与账号编辑框完全一致 —— 编辑框显示的是「原始词 + AI 衍生词」合并后的全集,保存时把这份全集
 *   写回 keywords 并清空衍生池(accountManager.updateAccountMeta)。这里也按同样方式显示/保存,
 *   所以两边看到、改到的是同一份,跑任务用的(effectiveKeywords)也是这一份。
 *
 * 向导拿到的 accounts 是打开时的快照;这里改过的词存在父组件的 overrides 里(onSaved 回调),
 *   父组件用 effectiveKw(a, overrides) 做「没配关键词」之类的校验,不必重新拉账号。
 */

import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';

export interface KwAccount {
  id: string;
  displayName: string;
  nickname?: string;
  avatar?: string;
  group?: string;
  displayId?: string;
  keywords?: string[];
  derivedKeywords?: string[];
}

/** zh / zh-TW / 其它(英文) */
const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};

// ── 关键词解析/回显:与 MatrixView(我的矩阵账号编辑框)完全同口径 ──
// 含空格的词用一对斜杠包起来;空格 / 斜杠 / 换行 / 逗号 / 顿号都是分隔符。
export function keywordsToText(list: string[]): string {
  return (list || []).map((w) => {
    const v = String(w || '').trim();
    if (!v) return '';
    return /\s/.test(v) ? ('/' + v + '/') : v;
  }).filter(Boolean).join('\n');
}
const KW_TOKEN_RE = /\/([^/]*)\/|([^\s,，、\n/]+)/g;
export function parseKeywords(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(KW_TOKEN_RE.source, KW_TOKEN_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(s || ''))) !== null) {
    const v = String(m[1] !== undefined ? m[1] : m[2]).trim().replace(/\s+/g, ' ');
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}
/** 原始词 + AI 衍生词(= 运行时 effectiveKeywords) */
export function mergeKw(base?: string[], derived?: string[]): string[] {
  const seen = new Set<string>();
  return [...(base || []), ...(derived || [])].map((k) => String(k || '').trim()).filter((k) => k && !seen.has(k) && seen.add(k));
}
/** 账号当前的关键词:向导里改过就用改过的,否则用 原始 + 衍生 */
export function effectiveKw(a: KwAccount | undefined | null, overrides?: Record<string, string[]>): string[] {
  if (!a) return [];
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, a.id)) return overrides[a.id] || [];
  return mergeKw(a.keywords, a.derivedKeywords);
}

// Tailwind 只认字面量类名 → 每个主题色写全。
export type KwAccent = 'red' | 'violet' | 'cyan' | 'emerald' | 'rose' | 'amber';
const ACCENT: Record<KwAccent, { tabOn: string; tabHover: string; btn: string; btnSolid: string; chip: string; ring: string; avatar: string }> = {
  red:     { tabOn: 'border-red-500 bg-red-500/10 ring-1 ring-red-500/40',             tabHover: 'hover:border-red-500/40',     btn: 'border-red-500/40 text-red-500 hover:bg-red-500/10',             btnSolid: 'bg-red-500 hover:bg-red-600',         chip: 'bg-red-500/10 text-red-600 dark:text-red-300',             ring: 'focus:ring-red-500/40',     avatar: 'bg-red-500/20 text-red-500' },
  violet:  { tabOn: 'border-violet-500 bg-violet-500/10 ring-1 ring-violet-500/40',    tabHover: 'hover:border-violet-500/40',  btn: 'border-violet-500/40 text-violet-500 hover:bg-violet-500/10',    btnSolid: 'bg-violet-500 hover:bg-violet-600',   chip: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',    ring: 'focus:ring-violet-500/40',  avatar: 'bg-violet-500/20 text-violet-500' },
  cyan:    { tabOn: 'border-cyan-500 bg-cyan-500/10 ring-1 ring-cyan-500/40',          tabHover: 'hover:border-cyan-500/40',    btn: 'border-cyan-500/40 text-cyan-500 hover:bg-cyan-500/10',          btnSolid: 'bg-cyan-500 hover:bg-cyan-600',       chip: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-300',          ring: 'focus:ring-cyan-500/40',    avatar: 'bg-cyan-500/20 text-cyan-500' },
  emerald: { tabOn: 'border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/40', tabHover: 'hover:border-emerald-500/40', btn: 'border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10', btnSolid: 'bg-emerald-500 hover:bg-emerald-600', chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', ring: 'focus:ring-emerald-500/40', avatar: 'bg-emerald-500/20 text-emerald-500' },
  rose:    { tabOn: 'border-rose-500 bg-rose-500/10 ring-1 ring-rose-500/40',          tabHover: 'hover:border-rose-500/40',    btn: 'border-rose-500/40 text-rose-500 hover:bg-rose-500/10',          btnSolid: 'bg-rose-500 hover:bg-rose-600',       chip: 'bg-rose-500/10 text-rose-600 dark:text-rose-300',          ring: 'focus:ring-rose-500/40',    avatar: 'bg-rose-500/20 text-rose-500' },
  amber:   { tabOn: 'border-amber-500 bg-amber-500/10 ring-1 ring-amber-500/40',       tabHover: 'hover:border-amber-500/40',   btn: 'border-amber-500/40 text-amber-500 hover:bg-amber-500/10',       btnSolid: 'bg-amber-500 hover:bg-amber-600',     chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',       ring: 'focus:ring-amber-500/40',   avatar: 'bg-amber-500/20 text-amber-500' },
};

export function accountAvatar(a: KwAccount, accent: KwAccent = 'red'): React.ReactNode {
  const title = a.nickname || a.displayName;
  return a.avatar
    ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
    : <span className={`w-7 h-7 rounded-full ${ACCENT[accent].avatar} flex items-center justify-center text-xs font-bold shrink-0`}>{(title || '?').slice(0, 1)}</span>;
}

/** 账号横排一行 tab(可横向滚动);badge 显示在名字下面,warn=黄字。 */
export const AccountTabRow: React.FC<{
  accounts: KwAccount[];
  activeId: string;
  onPick: (id: string) => void;
  badge: (a: KwAccount) => { t: string; warn: boolean };
  accent?: KwAccent;
  disabled?: boolean;
  lockOthers?: boolean;           // 正在改关键词时锁住别的 tab,免得草稿丢
  lockTitle?: string;
}> = ({ accounts, activeId, onPick, badge, accent = 'red', disabled, lockOthers, lockTitle }) => (
  <div className="flex gap-2 overflow-x-auto pb-1">
    {accounts.map((a) => {
      const on = a.id === activeId, b = badge(a);
      return (
        <button key={a.id} type="button" disabled={disabled || (lockOthers && !on)} onClick={() => onPick(a.id)}
          title={lockOthers && !on ? lockTitle : undefined}
          className={`shrink-0 flex items-center gap-2 rounded-xl border pl-1.5 pr-3 py-1.5 text-left transition-colors ${on ? ACCENT[accent as KwAccent].tabOn : `border-gray-200 dark:border-gray-700 ${ACCENT[accent as KwAccent].tabHover}`} disabled:opacity-40 disabled:cursor-not-allowed`}>
          {accountAvatar(a, accent as KwAccent)}
          <span className="min-w-0">
            <span className="block text-xs font-medium max-w-[110px] truncate dark:text-white">{a.nickname || a.displayName}</span>
            <span className={`block text-[10px] ${b.warn ? 'text-amber-500' : 'text-gray-500 dark:text-gray-400'}`}>{b.t}</span>
          </span>
        </button>
      );
    })}
  </div>
);

/**
 * 单个账号的关键词:展示成小标签,点「修改关键词」就地改,保存直接写回矩阵账号。
 * editing / onEditingChange 由外层持有,方便外层在编辑中锁住切号、拦下一步。
 */
export const AccountKeywordEditor: React.FC<{
  account: KwAccount;
  keywords: string[];
  onSaved: (id: string, list: string[]) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  accent?: KwAccent;
  disabled?: boolean;
  emptyHint?: string;             // 没配关键词时的提示(各任务后果不同:不跑 / 走推荐流 / 没法搜图…)
}> = ({ account, keywords, onSaved, editing, onEditingChange, accent = 'red', disabled, emptyHint }) => {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = ACCENT[accent as KwAccent];
  const n = parseKeywords(draft).length;

  const start = () => { setErr(null); setDraft(keywordsToText(keywords)); onEditingChange(true); };
  const cancel = () => { setErr(null); onEditingChange(false); };
  const save = async () => {
    if (busy) return;
    const list = parseKeywords(draft);
    setBusy(true); setErr(null);
    try {
      const r = await (window as any).electron?.matrix?.updateAccountMeta?.({ id: account.id, keywords: list });
      if (!r?.ok) throw new Error(L('保存失败,请重试', '儲存失敗,請重試', 'Save failed, please retry'));
      onSaved(account.id, list);
      onEditingChange(false);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-sm truncate dark:text-white">{account.nickname || account.displayName}</span>
        {account.group && <span className="text-[11px] text-gray-500 truncate">· {account.group}</span>}
        {!editing && (
          <button type="button" disabled={disabled} onClick={start}
            className={`ml-auto text-xs px-2.5 py-1 rounded-md border ${c.btn} disabled:opacity-40 shrink-0`}>✏️ {L('修改关键词', '修改關鍵詞', 'Edit keywords')}</button>
        )}
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} disabled={busy} autoFocus
            className={`w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 ${c.ring} resize-y min-h-[100px]`} />
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-gray-400 flex-1">{L(`空格 / 换行 / 逗号分隔;含空格的词用 /…/ 包起来 · 识别 ${n} 个`, `空格 / 換行 / 逗號分隔;含空格的詞用 /…/ 包起來 · 辨識 ${n} 個`, `separate by space / newline / comma; wrap phrases in /…/ · ${n} detected`)}</span>
            <button type="button" disabled={busy} onClick={cancel} className="px-2.5 py-1 rounded-md text-gray-500 hover:text-gray-700 dark:hover:text-gray-200">{L('取消', '取消', 'Cancel')}</button>
            <button type="button" disabled={busy} onClick={save} className={`px-3 py-1 rounded-md ${c.btnSolid} text-white font-semibold disabled:opacity-50`}>{busy ? L('保存中…', '儲存中…', 'Saving…') : L('保存到账号', '儲存到帳號', 'Save to account')}</button>
          </div>
        </div>
      ) : keywords.length ? (
        <div className="flex flex-wrap gap-1.5">
          {keywords.map((k) => <span key={k} className={`text-[11px] px-2 py-0.5 rounded-full ${c.chip}`}>{k}</span>)}
        </div>
      ) : (
        <div className="text-[11px] text-amber-500">{emptyHint || L('还没配关键词 —— 点「修改关键词」补上', '還沒設定關鍵詞 —— 點「修改關鍵詞」補上', 'No keywords yet — click Edit keywords to add some')}</div>
      )}
      {err && <div className="text-[11px] text-red-500">❌ {err}</div>}
    </div>
  );
};

/**
 * 组合件:选中账号横排 + 当前账号的关键词编辑。大多数向导直接用这个。
 * 父组件持有 overrides(改过的词)和 editingId(有值 = 正在改,父组件据此拦「下一步」)。
 */
export const AccountKeywordTabs: React.FC<{
  accounts: KwAccount[];
  overrides: Record<string, string[]>;
  onSaved: (id: string, list: string[]) => void;
  editingId: string | null;
  onEditingIdChange: (id: string | null) => void;
  accent?: KwAccent;
  disabled?: boolean;
  emptyHint?: string;
  emptyBadge?: string;            // tab 上没词时的小字(默认「没关键词」)
  intro?: React.ReactNode;        // tab 上方的说明
  onGoAccounts?: () => void;      // 「去我的矩阵账号管理」(会关掉向导);不传就不显示
}> = ({ accounts, overrides, onSaved, editingId, onEditingIdChange, accent = 'red', disabled, emptyHint, emptyBadge, intro, onGoAccounts }) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  if (!accounts.length) return null;
  const cur = accounts.find((a) => a.id === activeId) || accounts[0];
  const kws = effectiveKw(cur, overrides);
  return (
    <div className="space-y-2.5">
      {intro}
      <AccountTabRow
        accounts={accounts}
        activeId={cur.id}
        onPick={(id) => setActiveId(id)}
        accent={accent}
        disabled={disabled}
        lockOthers={!!editingId}
        lockTitle={L('先保存或取消正在改的关键词', '先儲存或取消正在改的關鍵詞', 'Save or cancel the keywords you are editing first')}
        badge={(a) => { const n = effectiveKw(a, overrides).length; return n ? { t: L(`${n} 个词`, `${n} 個詞`, `${n} kw`), warn: false } : { t: emptyBadge || L('没关键词', '沒關鍵詞', 'no kw'), warn: true }; }}
      />
      <AccountKeywordEditor
        key={cur.id}
        account={cur}
        keywords={kws}
        onSaved={onSaved}
        editing={editingId === cur.id}
        onEditingChange={(on) => onEditingIdChange(on ? cur.id : null)}
        accent={accent}
        disabled={disabled}
        emptyHint={emptyHint}
      />
      {onGoAccounts && (
        <button type="button" onClick={onGoAccounts} disabled={disabled || !!editingId} className="text-[11px] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline decoration-dotted disabled:opacity-40">{L('去「我的矩阵账号」管理(会关闭本向导)', '去「我的矩陣帳號」管理(會關閉本精靈)', 'Open My Matrix Accounts (closes this wizard)')}</button>
      )}
    </div>
  );
};
