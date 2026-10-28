/**
 * MatrixBlockWizard — 矩阵版「抖音 · 批量拉黑」向导(type='block')。
 *
 * 对应后端 douyin_block 剧本:执行账号逐个打开对方主页 →「…」→「拉黑」→「确认拉黑」。
 *   Step 1 — 名单(主页/作品链接、短链、抖音号,每行 1 个)和/或 关键词(每行 1 个;搜「视频」,
 *            把发这类视频的作者拉黑,自动跳过已关注的人和无关内容)。两者至少填一项,不限人数。
 *   Step 2 — 选执行账号(可多选)
 *   Step 3 — 运行频率 + 摘要
 * 文案内联中/繁/英(同评论区点赞向导的做法)。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { NumBox } from './NumberStepper';

type WizardStep = 1 | 2 | 3;

export const BLOCK_MAX_TARGETS = 2000;   // 和 main/libs/matrix/types.ts BLOCK_LIMITS 一致
export const BLOCK_MAX_KEYWORDS = 20;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

// 名单条目:抖音链接(主页/作品/短链)或抖音号
const DOUYIN_LINK_RE = /^(https?:\/\/)?([\w-]+\.)?(douyin|iesdouyin)\.com\//i;
const DOUYIN_ID_RE = /^[\w.\-]{2,40}$/;
const isTarget = (s: string) => DOUYIN_LINK_RE.test(s) || DOUYIN_ID_RE.test(s);

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
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; blockTargets: string[]; blockKeywords: string[] }) => Promise<void> | void;
}

const MatrixBlockWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  const splitLines = (t: string) => t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const [targetsText, setTargetsText] = useState<string>(() => (Array.isArray(initialTask?.blockTargets) ? initialTask.blockTargets.join('\n') : ''));
  const [keywordsText, setKeywordsText] = useState<string>(() => (Array.isArray(initialTask?.blockKeywords) ? initialTask.blockKeywords.join('\n') : ''));
  const parsedTargets = useMemo(() => splitLines(targetsText), [targetsText]);
  const validTargets = useMemo(() => Array.from(new Set(parsedTargets.filter(isTarget))), [parsedTargets]);
  const badTargets = useMemo(() => parsedTargets.filter((s) => !isTarget(s)), [parsedTargets]);
  const keywords = useMemo(() => Array.from(new Set(splitLines(keywordsText).map((s) => s.slice(0, 30)))), [keywordsText]);

  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>((initialTask?.accountIds || []).map(String)));
  const [concurrency, setConcurrency] = useState<number>(() => Math.max(1, Number(initialTask?.concurrency) || 1));
  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'once');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [targetsText, keywordsText, selected, runInterval]);

  const readyAccounts = accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required');
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: validTargets.length === 0 && keywords.length === 0
      ? { ok: false, reason: L('名单和关键词至少填一项', '名單和關鍵詞至少填一項', 'Enter at least one account or keyword') }
      : validTargets.length > BLOCK_MAX_TARGETS
        ? { ok: false, reason: L(`名单最多 ${BLOCK_MAX_TARGETS} 条`, `名單最多 ${BLOCK_MAX_TARGETS} 條`, `At most ${BLOCK_MAX_TARGETS} accounts`) }
        : keywords.length > BLOCK_MAX_KEYWORDS
          ? { ok: false, reason: L(`关键词最多 ${BLOCK_MAX_KEYWORDS} 个`, `關鍵詞最多 ${BLOCK_MAX_KEYWORDS} 個`, `At most ${BLOCK_MAX_KEYWORDS} keywords`) }
          : { ok: true },
    2: { ok: selected.size > 0, reason: L('请至少选 1 个执行账号', '請至少選 1 個執行帳號', 'Select at least one account') },
    3: { ok: true },
  };

  const handleSave = async () => {
    if (saving) return;
    for (const s of [1, 2, 3] as WizardStep[]) { if (!canAdvance[s].ok) { setSaveError(canAdvance[s].reason || ''); setStep(s); return; } }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || L(`${platformLabel} 批量拉黑`, `${platformLabel} 批量封鎖`, `${platformLabel} Batch Block`),
        accountIds: Array.from(selected),
        concurrency: Math.min(concurrency, Math.max(1, selected.size)),
        frequency: runInterval,
        blockTargets: validTargets.slice(0, BLOCK_MAX_TARGETS),
        blockKeywords: keywords.slice(0, BLOCK_MAX_KEYWORDS),
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || L('保存失败', '儲存失敗', 'Save failed'));
    } finally { setSaving(false); }
  };

  const freqOptions: Array<[string, string]> = [
    ['once', L('仅手动运行', '僅手動執行', 'Manual only')],
    ['6h', L('每 6 小时', '每 6 小時', 'Every 6h')],
    ['daily_random', L('每天随机一次', '每天隨機一次', 'Once a day (random time)')],
  ];
  const freqLabel = (freqOptions.find(([v]) => v === runInterval) || [runInterval, runInterval])[1];

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
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
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300">
              🚫 {L(
                '名单和关键词至少填一项,不限人数。执行账号会逐个打开对方主页,点「…」→「拉黑」→「确认拉黑」,每次间隔 3~15 秒;之前拉黑过的自动跳过。关键词:搜「视频」,把发这类视频的作者拉黑 —— 已关注的人、和关键词无关的内容不拉黑。拉黑后对方无法搜索到你,也不能给你发私信。',
                '名單和關鍵詞至少填一項,不限人數。執行帳號會逐個打開對方主頁,點「…」→「拉黑」→「確認拉黑」,每次間隔 3~15 秒;之前封鎖過的自動跳過。關鍵詞:搜「影片」,把發這類影片的作者封鎖 —— 已關注的人、和關鍵詞無關的內容不封鎖。封鎖後對方無法搜尋到你,也不能傳私訊給你。',
                'Fill in a list and/or keywords; no limit on count. Each account opens the profile and blocks it (… → Block → Confirm), 3-15s apart; already-blocked accounts are skipped. Keywords search videos and block their authors, skipping accounts you follow and unrelated results. Blocked users can no longer find or message you.',
              )}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                👤 {L('名单', '名單', 'Accounts')}<span className="text-xs text-gray-400 font-normal ml-1">{L('每行 1 个:主页链接 / 作品链接 / 短链 / 抖音号', '每行 1 個:主頁連結 / 作品連結 / 短連結 / 抖音號', 'one per line: profile link / post link / short link / Douyin ID')}</span>
              </label>
              <textarea value={targetsText} onChange={(e) => setTargetsText(e.target.value)} rows={6} disabled={saving}
                placeholder={'https://www.douyin.com/user/MS4wLjABAAAA...\nhttps://v.douyin.com/xxxxxx/\nhttps://www.douyin.com/video/7xxxxxxxxxxxx\ndy123456  (抖音号)'}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 resize-y min-h-[110px] font-mono" />
              <div className="flex items-center gap-3 text-[11px] mt-1">
                <span className="text-red-500">{L(`有效 ${validTargets.length} 条`, `有效 ${validTargets.length} 條`, `${validTargets.length} valid`)}</span>
                {badTargets.length > 0 && <span className="text-amber-500">{L(`${badTargets.length} 条认不出,会被忽略`, `${badTargets.length} 條無法辨識,會被忽略`, `${badTargets.length} unrecognized (ignored)`)}</span>}
              </div>
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                🔎 {L('关键词', '關鍵詞', 'Keywords')}<span className="text-xs text-gray-400 font-normal ml-1">{L(`每行 1 个,最多 ${BLOCK_MAX_KEYWORDS} 个;多个词用空格隔开表示都要出现`, `每行 1 個,最多 ${BLOCK_MAX_KEYWORDS} 個;多個詞用空格隔開表示都要出現`, `one per line, up to ${BLOCK_MAX_KEYWORDS}; space-separated words must all appear`)}</span>
              </label>
              <textarea value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} rows={3} disabled={saving}
                placeholder={L('美食探店\n北京 火锅', '美食探店\n北京 火鍋', 'food review\nbeijing hotpot')}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/40 resize-y min-h-[70px]" />
              <div className="text-[11px] mt-1 text-red-500">{L(`${keywords.length} 个关键词`, `${keywords.length} 個關鍵詞`, `${keywords.length} keywords`)}</div>
            </div>
          </>
        )}

        {step === 2 && (
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
                  <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-red-500 hover:bg-red-600 active:scale-95">{L('去添加账号', '去新增帳號', 'Add an account')}</button>
                </div>
              )}
              {accounts.map((a) => {
                const ready = a.status !== 'login_required' && a.status !== 'banned';
                const title = a.nickname || a.displayName;
                return (
                  <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-red-500 shrink-0" />
                    {a.avatar
                      ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                      : <span className="w-7 h-7 rounded-full bg-red-500/20 text-red-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium truncate dark:text-white">{title}</span>
                        {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">@{a.displayId}</span>}
                        {!ready && <span className="text-[11px] text-amber-500 shrink-0">{a.status === 'banned' ? L('已封禁', '已封鎖', 'banned') : L('掉线,需重新登录', '離線,需重新登入', 'logged out')}</span>}
                      </div>
                      <div className="text-[11px] text-gray-400 truncate">{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                    </div>
                  </label>
                );
              })}
            </div>
            {selected.size > 1 && (
              <div className="mt-3 flex items-center gap-3 text-sm dark:text-gray-200">
                <span>{L('同时运行账号数', '同時執行帳號數', 'Run in parallel')}</span>
                <NumBox value={Math.min(concurrency, selected.size)} onChange={setConcurrency} min={1} max={Math.max(1, Math.min(5, selected.size))} accent="rose" disabled={saving} />
              </div>
            )}
          </div>
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
              <SummaryRow label={L('名单', '名單', 'Accounts list')} value={L(`${validTargets.length} 条`, `${validTargets.length} 條`, `${validTargets.length}`)} />
              <SummaryRow label={L('关键词', '關鍵詞', 'Keywords')} value={keywords.length ? keywords.join('、') : L('无', '無', 'none')} />
              <SummaryRow label={L('执行账号', '執行帳號', 'Accounts')} value={L(`${selected.size} 个`, `${selected.size} 個`, `${selected.size}`)} />
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
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{L('上一步', '上一步', 'Back')}</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50">{L('下一步', '下一步', 'Next')}</button>
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
