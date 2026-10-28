/**
 * MatrixBlockWizard — 矩阵版「抖音 · 批量拉黑」向导(type='block')。布局对齐互动任务向导。
 *
 * 对应后端 douyin_block 剧本:执行账号逐个打开对方主页 →「…」→「拉黑」→「确认拉黑」。
 *   Step 1 — 顶上选模式(🎯 精准 / 🔎 关键词),下面勾执行账号
 *   Step 2 — 精准模式:给每个账号填它要拉黑的名单(主页/作品链接、短链、抖音号,每行 1 个);
 *            关键词模式:展示每个账号自己的关键词,点「修改」直接改 —— 和「我的矩阵账号」是同一份,
 *            这里改了矩阵账号那边也跟着变(调 matrix.updateAccountMeta)。
 *   Step 3 — 运行频率 + 摘要
 * 文案内联中/繁/英(同评论区点赞向导的做法)。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

type WizardStep = 1 | 2 | 3;
export type BlockMode = 'precise' | 'keyword';

export const BLOCK_MAX_TARGETS = 2000;   // 每个账号的名单上限,和 main/libs/matrix/types.ts BLOCK_LIMITS 一致

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; derivedKeywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

// 名单条目:抖音链接(主页/作品/短链)或抖音号
const DOUYIN_LINK_RE = /^(https?:\/\/)?([\w-]+\.)?(douyin|iesdouyin)\.com\//i;
const DOUYIN_ID_RE = /^[\w.\-]{2,40}$/;
const isTarget = (s: string) => DOUYIN_LINK_RE.test(s) || DOUYIN_ID_RE.test(s);
const splitLines = (t: string) => String(t || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);

// ── 关键词解析/回显:与 MatrixView(我的矩阵账号编辑框)完全同口径,保证两边改的是同一份、格式一致 ──
// 含空格的词用一对斜杠包起来;空格 / 斜杠 / 换行 / 逗号 / 顿号都是分隔符。
function keywordsToText(list: string[]): string {
  return (list || []).map((w) => {
    const v = String(w || '').trim();
    if (!v) return '';
    return /\s/.test(v) ? ('/' + v + '/') : v;
  }).filter(Boolean).join('\n');
}
const KW_TOKEN_RE = /\/([^/]*)\/|([^\s,，、\n/]+)/g;
function parseKeywords(s: string): string[] {
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
// 原始词 + AI 衍生词(= 运行时 effectiveKeywords,所见即所用)
function mergeKw(base?: string[], derived?: string[]): string[] {
  const seen = new Set<string>();
  return [...(base || []), ...(derived || [])].map((k) => String(k || '').trim()).filter((k) => k && !seen.has(k) && seen.add(k));
}

/** zh / zh-TW / 其它语言(英文)三选一。 */
const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; blockMode: BlockMode; blockTargetsByAccount: Record<string, string[]> }) => Promise<void> | void;
}

const MatrixBlockWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  // 模式:编辑按存的 blockMode 回填;老任务(无该字段)有名单 → 精准,否则 → 关键词。
  const [mode, setMode] = useState<BlockMode>(() => {
    const m = initialTask?.blockMode;
    if (m === 'precise' || m === 'keyword') return m;
    if (editing) return Array.isArray(initialTask?.blockTargets) && initialTask.blockTargets.length ? 'precise' : 'keyword';
    return 'precise';
  });
  const preciseMode = mode === 'precise';

  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>((initialTask?.accountIds || []).map(String)));
  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'once');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 精准模式:各账号名单原文。老任务的共用名单回填给每个已选账号。
  const [targetsText, setTargetsText] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    const by = initialTask?.blockTargetsByAccount;
    if (by && typeof by === 'object') { for (const k of Object.keys(by)) init[k] = (Array.isArray(by[k]) ? by[k] : []).join('\n'); }
    else if (Array.isArray(initialTask?.blockTargets) && initialTask.blockTargets.length) {
      for (const id of (initialTask?.accountIds || []).map(String)) init[id] = initialTask.blockTargets.join('\n');
    }
    return init;
  });
  const parsedFor = (id: string) => {
    const lines = splitLines(targetsText[id] || '');
    return { valid: Array.from(new Set(lines.filter(isTarget))), bad: lines.filter((s) => !isTarget(s)) };
  };

  // 关键词模式:本地改过的关键词(保存到矩阵账号后覆盖显示,不必等父组件重新拉账号)。
  const [kwOverride, setKwOverride] = useState<Record<string, string[]>>({});
  const [kwEditing, setKwEditing] = useState<string | null>(null);
  const [kwDraft, setKwDraft] = useState('');
  const [kwSaving, setKwSaving] = useState(false);
  const [kwError, setKwError] = useState<string | null>(null);
  const kwOf = (a: WizardAccount): string[] => kwOverride[a.id] ?? mergeKw(a.keywords, a.derivedKeywords);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [targetsText, selected, runInterval, mode, kwOverride]);

  const linked = (a: WizardAccount) => a.status !== 'banned' && a.status !== 'login_required';
  const selectedAccounts = useMemo(() => accounts.filter((a) => selected.has(a.id)), [accounts, selected]);
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const readyAccounts = accounts.filter(linked);

  const preciseFilled = selectedAccounts.filter((a) => parsedFor(a.id).valid.length > 0);
  const preciseTotal = preciseFilled.reduce((s, a) => s + parsedFor(a.id).valid.length, 0);
  const kwMissing = selectedAccounts.filter((a) => kwOf(a).length === 0);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size > 0, reason: L('请至少选 1 个执行账号', '請至少選 1 個執行帳號', 'Select at least one account') },
    2: preciseMode
      ? (preciseFilled.length === 0
        ? { ok: false, reason: L('请至少给一个账号填要拉黑的名单', '請至少給一個帳號填要封鎖的名單', 'Enter a block list for at least one account') }
        : selectedAccounts.some((a) => parsedFor(a.id).valid.length > BLOCK_MAX_TARGETS)
          ? { ok: false, reason: L(`每个账号的名单最多 ${BLOCK_MAX_TARGETS} 条`, `每個帳號的名單最多 ${BLOCK_MAX_TARGETS} 條`, `At most ${BLOCK_MAX_TARGETS} per account`) }
          : { ok: true })
      : (kwMissing.length === selectedAccounts.length
        ? { ok: false, reason: L('选中的账号都没配关键词,请先修改关键词', '選中的帳號都沒設定關鍵詞,請先修改關鍵詞', 'None of the selected accounts has keywords — add some first') }
        : kwEditing ? { ok: false, reason: L('还有关键词没保存', '還有關鍵詞沒儲存', 'Save the keywords you are editing first') } : { ok: true }),
    3: { ok: true },
  };

  const handleSave = async () => {
    if (saving) return;
    for (const s of [1, 2, 3] as WizardStep[]) { if (!canAdvance[s].ok) { setSaveError(canAdvance[s].reason || ''); setStep(s); return; } }
    setSaving(true);
    try {
      const byAcc: Record<string, string[]> = {};
      if (preciseMode) for (const a of selectedAccounts) { const v = parsedFor(a.id).valid; if (v.length) byAcc[a.id] = v.slice(0, BLOCK_MAX_TARGETS); }
      await onSave({
        name: initialTask?.name || L(`${platformLabel} 批量拉黑`, `${platformLabel} 批量封鎖`, `${platformLabel} Batch Block`),
        accountIds: Array.from(selected),
        concurrency: Math.max(1, selected.size),   // 勾几个号就几个号一起跑(同互动任务;runner 内部有上限兜底)
        frequency: runInterval,
        blockMode: mode,
        blockTargetsByAccount: byAcc,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || L('保存失败', '儲存失敗', 'Save failed'));
    } finally { setSaving(false); }
  };

  // 关键词保存 → 写回矩阵账号(updateAccountMeta 会把这份当全集、清空 AI 衍生池,和账号编辑框同一口径)。
  const saveKeywords = async (id: string) => {
    if (kwSaving) return;
    const list = parseKeywords(kwDraft);
    setKwSaving(true); setKwError(null);
    try {
      const r = await (window as any).electron?.matrix?.updateAccountMeta?.({ id, keywords: list });
      if (!r?.ok) throw new Error(L('保存失败', '儲存失敗', 'Save failed'));
      setKwOverride((prev) => ({ ...prev, [id]: list }));
      setKwEditing(null);
    } catch (e) {
      setKwError(String(e instanceof Error ? e.message : e));
    } finally { setKwSaving(false); }
  };

  const goAccounts = () => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); };

  const freqOptions: Array<[string, string]> = [
    ['once', L('仅手动运行', '僅手動執行', 'Manual only')],
    ['6h', L('每 6 小时', '每 6 小時', 'Every 6h')],
    ['daily_random', L('每天随机一次', '每天隨機一次', 'Once a day (random time)')],
  ];
  const freqLabel = (freqOptions.find(([v]) => v === runInterval) || [runInterval, runInterval])[1];

  const avatar = (a: WizardAccount) => {
    const title = a.nickname || a.displayName;
    return a.avatar
      ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
      : <span className="w-7 h-7 rounded-full bg-red-500/20 text-red-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>;
  };

  const modeOpts: Array<{ on: BlockMode; icon: string; title: string; desc: string }> = [
    { on: 'precise', icon: '🎯', title: L('精准模式', '精準模式', 'Targeted mode'),
      desc: L('给每个账号粘它要拉黑的名单(主页/作品链接、短链、抖音号),不限人数,逐个打开主页拉黑。',
        '給每個帳號貼它要封鎖的名單(主頁/作品連結、短連結、抖音號),不限人數,逐個打開主頁封鎖。',
        'Paste a block list for each account (profile/post links, short links, Douyin IDs); no limit, blocked one by one.') },
    { on: 'keyword', icon: '🔎', title: L('关键词模式', '關鍵詞模式', 'Keyword mode'),
      desc: L('用账号自己的关键词在「综合」里搜,把发这类内容的作者逐个拉黑;已关注的人、和关键词无关的内容不拉黑。',
        '用帳號自己的關鍵詞在「綜合」裡搜,把發這類內容的作者逐個封鎖;已關注的人、和關鍵詞無關的內容不封鎖。',
        'Searches with each account\'s own keywords and blocks the creators posting that content; skips people you follow and unrelated results.') },
  ];

  return (
    <div className="w-full max-w-2xl max-h-[90vh] mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🚫 {editing ? L('编辑', '編輯', 'Edit') + ' · ' : ''}{platformLabel} · {L('批量拉黑', '批量封鎖', 'Batch Block')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-red-500/40 text-red-500 bg-red-500/5">{L(`第 ${step}/3 步`, `第 ${step}/3 步`, `Step ${step}/3`)}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {modeOpts.map((o) => {
                const active = mode === o.on;
                return (
                  <button key={o.on} type="button" disabled={saving} onClick={() => setMode(o.on)}
                    className={`text-left rounded-xl border px-4 py-3 transition-colors ${active ? 'border-red-500 bg-red-500/5 ring-1 ring-red-500/40' : 'border-gray-200 dark:border-gray-700 hover:border-red-500/40'} ${saving ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-3.5 w-3.5 rounded-full border shrink-0 ${active ? 'border-red-500 bg-red-500' : 'border-gray-400'}`} />
                      <span className="text-sm font-medium dark:text-gray-200">{o.icon} {o.title}</span>
                    </div>
                    <div className="text-[11px] text-gray-400 leading-relaxed mt-1">{o.desc}</div>
                  </button>
                );
              })}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {L(`选择执行账号(${platformLabel},可多选)`, `選擇執行帳號(${platformLabel},可多選)`, `Accounts (${platformLabel}, multiple allowed)`)}
                <span className="text-xs text-gray-400 font-normal ml-1">{L(`已选 ${selected.size} 个`, `已選 ${selected.size} 個`, `${selected.size} selected`)}</span>
                {readyAccounts.length > 0 && (
                  <button type="button" className="ml-2 text-xs text-red-500 hover:underline" onClick={() => setSelected(selected.size === readyAccounts.length ? new Set() : new Set(readyAccounts.map((a) => a.id)))}>
                    {selected.size === readyAccounts.length ? L('全不选', '全不選', 'Clear') : L('全选', '全選', 'Select all')}
                  </button>
                )}
              </label>
              <div className="space-y-1.5 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && <div className="p-3 text-center text-xs text-gray-400">{L('账号加载中…', '帳號載入中…', 'Loading accounts…')}</div>}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{L(`还没有 ${platformLabel} 账号`, `還沒有 ${platformLabel} 帳號`, `No ${platformLabel} accounts yet`)}</div>
                    <button type="button" onClick={goAccounts} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-red-500 hover:bg-red-600 active:scale-95">{L('去添加账号', '去新增帳號', 'Add an account')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = linked(a);
                  const title = a.nickname || a.displayName;
                  const kws = kwOf(a);
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-red-500 shrink-0" />
                      {avatar(a)}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{L('抖音号:', '抖音號:', 'ID: ')}{a.displayId}</span>}
                          {a.status === 'login_required'
                            ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); goAccounts(); }} className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">{L('掉线,去登录', '離線,去登入', 'logged out — log in')}</button>
                            : a.status === 'banned' ? <span className="text-[11px] text-amber-500 shrink-0">{L('已封禁', '已封鎖', 'banned')}</span>
                              : (!preciseMode && kws.length === 0) ? <span className="text-[11px] text-amber-500 shrink-0">{L('未配关键词,下一步可补', '未設定關鍵詞,下一步可補', 'no keywords — add next step')}</span> : null}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{a.displayName}{a.group ? ` · ${a.group}` : ''}{!preciseMode && kws.length ? ` · 🏷️ ${kws.join('/')}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {step === 2 && preciseMode && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300">
              🎯 {L('给每个账号填它要拉黑的名单,每行 1 个:主页链接 / 作品链接 / 短链 / 抖音号。不限人数,每次间隔 3~15 秒,之前拉黑过的自动跳过。没填的账号这次不跑。',
                '給每個帳號填它要封鎖的名單,每行 1 個:主頁連結 / 作品連結 / 短連結 / 抖音號。不限人數,每次間隔 3~15 秒,之前封鎖過的自動跳過。沒填的帳號這次不跑。',
                'Enter a block list for each account, one per line: profile link / post link / short link / Douyin ID. No limit, 3-15s apart; already-blocked accounts are skipped. Accounts left empty are skipped this run.')}
            </div>
            {selectedAccounts.map((a, idx) => {
              const p = parsedFor(a.id);
              return (
                <div key={a.id} className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {avatar(a)}
                    <span className="font-medium text-sm truncate dark:text-white">{a.nickname || a.displayName}</span>
                    {a.displayId && <span className="text-[11px] text-gray-500 shrink-0">{L('抖音号:', '抖音號:', 'ID: ')}{a.displayId}</span>}
                    {idx === 0 && selectedAccounts.length > 1 && (
                      <button type="button" disabled={saving || !p.valid.length}
                        onClick={() => setTargetsText((prev) => { const n = { ...prev }; for (const b of selectedAccounts) n[b.id] = prev[a.id] || ''; return n; })}
                        className="ml-auto text-[11px] text-red-500 hover:underline disabled:opacity-40 shrink-0">{L('复制到其他账号', '複製到其他帳號', 'Copy to all accounts')}</button>
                    )}
                  </div>
                  <textarea value={targetsText[a.id] || ''} onChange={(e) => { const v = e.target.value; setTargetsText((prev) => ({ ...prev, [a.id]: v })); }} rows={4} disabled={saving}
                    placeholder={'https://www.douyin.com/user/MS4wLjABAAAA...\nhttps://v.douyin.com/xxxxxx/\nhttps://www.douyin.com/video/7xxxxxxxxxxxx\ndy123456'}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 resize-y min-h-[90px] font-mono" />
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className={p.valid.length ? 'text-red-500' : 'text-gray-400'}>{L(`有效 ${p.valid.length} 条`, `有效 ${p.valid.length} 條`, `${p.valid.length} valid`)}</span>
                    {p.bad.length > 0 && <span className="text-amber-500">{L(`${p.bad.length} 条认不出,会被忽略`, `${p.bad.length} 條無法辨識,會被忽略`, `${p.bad.length} unrecognized (ignored)`)}</span>}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {step === 2 && !preciseMode && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300">
              🔎 {L('每个账号用它自己的关键词在「综合」里搜,把发这类内容的作者逐个拉黑(已关注的人、和关键词无关的内容不拉黑,间隔 3~15 秒)。关键词和「我的矩阵账号」是同一份 —— 在这里改,矩阵账号那边也会跟着改。没配关键词的账号这次不跑。',
                '每個帳號用它自己的關鍵詞在「綜合」裡搜,把發這類內容的作者逐個封鎖(已關注的人、和關鍵詞無關的內容不封鎖,間隔 3~15 秒)。關鍵詞和「我的矩陣帳號」是同一份 —— 在這裡改,矩陣帳號那邊也會跟著改。沒設定關鍵詞的帳號這次不跑。',
                'Each account searches with its own keywords and blocks the creators posting that content (skips people you follow and unrelated results, 3-15s apart). These are the same keywords as in My Matrix Accounts — editing here changes them there too. Accounts without keywords are skipped.')}
            </div>
            {kwError && <div className="text-[11px] text-red-500">❌ {kwError}</div>}
            {selectedAccounts.map((a) => {
              const kws = kwOf(a);
              const isEd = kwEditing === a.id;
              return (
                <div key={a.id} className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {avatar(a)}
                    <span className="font-medium text-sm truncate dark:text-white">{a.nickname || a.displayName}</span>
                    {a.group && <span className="text-[11px] text-gray-500 truncate">· {a.group}</span>}
                    {!isEd && (
                      <button type="button" disabled={saving || (!!kwEditing && kwEditing !== a.id)}
                        onClick={() => { setKwError(null); setKwDraft(keywordsToText(kws)); setKwEditing(a.id); }}
                        className="ml-auto text-xs px-2.5 py-1 rounded-md border border-red-500/40 text-red-500 hover:bg-red-500/10 disabled:opacity-40 shrink-0">✏️ {L('修改', '修改', 'Edit')}</button>
                    )}
                  </div>
                  {isEd ? (
                    <div className="space-y-1.5">
                      <textarea value={kwDraft} onChange={(e) => setKwDraft(e.target.value)} rows={4} disabled={kwSaving} autoFocus
                        className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 resize-y min-h-[80px]" />
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-gray-400 flex-1">{L(`空格 / 换行 / 逗号分隔;含空格的词用 /…/ 包起来 · 识别 ${parseKeywords(kwDraft).length} 个`, `空格 / 換行 / 逗號分隔;含空格的詞用 /…/ 包起來 · 辨識 ${parseKeywords(kwDraft).length} 個`, `separate by space / newline / comma; wrap phrases in /…/ · ${parseKeywords(kwDraft).length} detected`)}</span>
                        <button type="button" disabled={kwSaving} onClick={() => { setKwEditing(null); setKwError(null); }} className="px-2.5 py-1 rounded-md text-gray-500 hover:text-gray-700 dark:hover:text-gray-200">{L('取消', '取消', 'Cancel')}</button>
                        <button type="button" disabled={kwSaving} onClick={() => saveKeywords(a.id)} className="px-3 py-1 rounded-md bg-red-500 text-white font-semibold hover:bg-red-600 disabled:opacity-50">{kwSaving ? L('保存中…', '儲存中…', 'Saving…') : L('保存到账号', '儲存到帳號', 'Save to account')}</button>
                      </div>
                    </div>
                  ) : kws.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {kws.map((k) => <span key={k} className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-300">{k}</span>)}
                    </div>
                  ) : (
                    <div className="text-[11px] text-amber-500">{L('还没配关键词 —— 点「修改」补上,否则这个账号这次不跑', '還沒設定關鍵詞 —— 點「修改」補上,否則這個帳號這次不跑', 'No keywords yet — click Edit to add some, otherwise this account is skipped')}</div>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={goAccounts} disabled={saving || kwSaving} className="text-[11px] text-gray-500 hover:text-red-500 underline decoration-dotted">{L('去「我的矩阵账号」管理(会关闭本向导)', '去「我的矩陣帳號」管理(會關閉本精靈)', 'Open My Matrix Accounts (closes this wizard)')}</button>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{L('运行频率', '執行頻率', 'Schedule')}</label>
              <div className="flex gap-2 flex-wrap">
                {freqOptions.map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-red-500 bg-red-500/10 text-red-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-red-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">{L('任务摘要', '任務摘要', 'Summary')}</div>
              <SummaryRow label={L('模式', '模式', 'Mode')} value={preciseMode ? L('🎯 精准模式', '🎯 精準模式', '🎯 Targeted') : L('🔎 关键词模式', '🔎 關鍵詞模式', '🔎 Keyword')} />
              <SummaryRow label={L('执行账号', '執行帳號', 'Accounts')} value={L(`${selected.size} 个`, `${selected.size} 個`, `${selected.size}`)} />
              {preciseMode
                ? <SummaryRow label={L('名单', '名單', 'Lists')} value={L(`${preciseFilled.length} 个账号填了名单,共 ${preciseTotal} 条`, `${preciseFilled.length} 個帳號填了名單,共 ${preciseTotal} 條`, `${preciseFilled.length} accounts, ${preciseTotal} targets`)} />
                : <SummaryRow label={L('关键词', '關鍵詞', 'Keywords')} value={L(`用各账号自己的关键词${kwMissing.length ? `(${kwMissing.length} 个账号没配,不跑)` : ''}`, `用各帳號自己的關鍵詞${kwMissing.length ? `(${kwMissing.length} 個帳號沒設定,不跑)` : ''}`, `each account's own keywords${kwMissing.length ? ` (${kwMissing.length} without keywords skipped)` : ''}`)} />}
              <SummaryRow label={L('节奏', '節奏', 'Pace')} value={L('不限人数,每次间隔 3~15 秒', '不限人數,每次間隔 3~15 秒', 'no limit, 3-15s apart')} />
              <SummaryRow label={L('运行频率', '執行頻率', 'Schedule')} value={freqLabel} />
            </div>
          </>
        )}
      </div>

      {saveError && (
        <div className="px-6 pt-2 pb-1 shrink-0">
          <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">❌ {saveError}</div>
        </div>
      )}

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{L('取消', '取消', 'Cancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => { setKwEditing(null); setStep((step - 1) as WizardStep); }} disabled={saving || kwSaving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{L('上一步', '上一步', 'Back')}</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving || kwSaving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50">{L('下一步', '下一步', 'Next')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50">{saving ? L('保存中…', '儲存中…', 'Saving…') : (editing ? L('保存修改', '儲存修改', 'Save') : L('创建任务', '建立任務', 'Create task'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixBlockWizard;
