/**
 * MatrixReportWizard — 矩阵版「抖音 · 举报」向导(白名单功能,合规优先)。
 *
 * 只有 admin 白名单(system_config.matrix_report_whitelist_uids)里的 UID 能看到入口;
 * 入口显隐由 ScenarioView 按 /api/matrix/config 的 reportEnabled 控制,sidecar 存盘/执行时再校验一次,
 * 后端剧本下发(/scenarios/douyin_report)对非白名单直接 403。
 *
 *   Step 1 — 填 1-4 个被举报的账号主页 / 作品链接,每条选举报原因 + 写举报描述
 *   Step 2 — 选【1 个】执行举报的抖音账号(单选,不可多选)
 *   Step 3 — 确认摘要 + 合规条款 → 创建
 *
 * 合规约束:只能 1 个账号、只能手动执行一次(无频率选项、不进定时)、执行后不可编辑/再运行。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

type WizardStep = 1 | 2 | 3;

export const REPORT_REASON_KEYS = ['porn', 'illegal', 'fraud', 'false_info', 'abuse', 'infringement', 'minors', 'spam', 'impersonation', 'discomfort', 'other'] as const;
export type ReportReasonKey = typeof REPORT_REASON_KEYS[number];
export interface ReportItemInput { url: string; reason: ReportReasonKey | ''; description: string }

const MAX_ITEMS = 4;
const DESC_MIN = 5;
const DESC_MAX = 200;
const DOUYIN_URL_RE = /^https?:\/\/([\w-]+\.)?(douyin|iesdouyin)\.com\//i;

export interface WizardAccount { id: string; displayName: string; status: string; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const t = (k: string) => i18nService.t(k);
export const reportReasonLabel = (k: string) => i18nService.t(`rpReason_${k}`);

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; reportItems: Array<{ url: string; reason: string; description: string }> }) => Promise<void> | void;
}

const emptyItem = (): ReportItemInput => ({ url: '', reason: '', description: '' });

function itemError(it: ReportItemInput, allUrls: string[]): string | null {
  const url = it.url.trim();
  if (!url) return t('rpErrUrlEmpty');
  if (!DOUYIN_URL_RE.test(url)) return t('rpErrUrlInvalid');
  if (allUrls.filter((u) => u === url).length > 1) return t('rpErrUrlDuplicate');
  if (!it.reason) return t('rpErrReasonEmpty');
  const d = it.description.trim();
  if (d.length < DESC_MIN) return t('rpErrDescShort').replace('{n}', String(DESC_MIN));
  if (d.length > DESC_MAX) return t('rpErrDescLong').replace('{n}', String(DESC_MAX));
  return null;
}

const MatrixReportWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  const [items, setItems] = useState<ReportItemInput[]>(() => {
    const src: any[] = Array.isArray(initialTask?.reportItems) ? initialTask.reportItems : [];
    return src.length ? src.slice(0, MAX_ITEMS).map((x) => ({ url: String(x.url || ''), reason: (x.reason || '') as any, description: String(x.description || '') })) : [emptyItem()];
  });
  const [selectedId, setSelectedId] = useState<string>(() => (initialTask?.accountIds?.length ? String(initialTask.accountIds[0]) : ''));
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([false, false, false]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [items, selectedId]);

  const allUrls = useMemo(() => items.map((i) => i.url.trim()), [items]);
  const errors = useMemo(() => items.map((it) => itemError(it, allUrls)), [items, allUrls]);
  const itemsOk = items.length >= 1 && items.length <= MAX_ITEMS && errors.every((e) => !e);
  const selectedAccount = accounts.find((a) => a.id === selectedId);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: itemsOk, reason: t('rpErrFixItems') },
    2: { ok: !!selectedId, reason: t('rpErrSelectAccount') },
    3: { ok: allTermsAccepted, reason: t('rpErrAcceptTerms') },
  };

  const updateItem = (idx: number, patch: Partial<ReportItemInput>) => setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const removeItem = (idx: number) => setItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  const addItem = () => setItems((prev) => (prev.length >= MAX_ITEMS ? prev : [...prev, emptyItem()]));

  const handleSave = async () => {
    if (saving) return;
    for (const s of [1, 2, 3] as WizardStep[]) {
      if (!canAdvance[s].ok) { setSaveError(canAdvance[s].reason || ''); setStep(s); return; }
    }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || t('rpTaskName').replace('{platform}', platformLabel).replace('{n}', String(items.length)),
        accountIds: [selectedId],
        reportItems: items.map((it) => ({ url: it.url.trim(), reason: it.reason as string, description: it.description.trim() })),
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || t('rpErrSaveFailed'));
    } finally { setSaving(false); }
  };

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🚩 {(editing ? t('rpTitleEdit') : t('rpTitleCreate')).replace('{platform}', platformLabel)}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-rose-500/40 text-rose-500 bg-rose-500/5">{t('rpStepIndicator').replace('{n}', String(step))}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300">
              🚩 {t('rpIntro').replace('{n}', String(MAX_ITEMS))}
            </div>
            {items.map((it, idx) => {
              const err = errors[idx];
              const touched = !!(it.url || it.reason || it.description);
              return (
                <div key={idx} className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-600 dark:text-gray-300">{t('rpItemLabel').replace('{n}', String(idx + 1))}</span>
                    {items.length > 1 && (
                      <button type="button" onClick={() => removeItem(idx)} disabled={saving} className="text-[11px] text-gray-400 hover:text-red-500">{t('rpRemoveItem')}</button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={it.url}
                    onChange={(e) => updateItem(idx, { url: e.target.value })}
                    placeholder={t('rpUrlPlaceholder')}
                    disabled={saving}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white font-mono focus:outline-none focus:ring-2 focus:ring-rose-500/40"
                  />
                  <select
                    value={it.reason}
                    onChange={(e) => updateItem(idx, { reason: e.target.value as ReportReasonKey })}
                    disabled={saving}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/40"
                  >
                    <option value="">{t('rpReasonPlaceholder')}</option>
                    {REPORT_REASON_KEYS.map((k) => <option key={k} value={k}>{reportReasonLabel(k)}</option>)}
                  </select>
                  <div>
                    <textarea
                      value={it.description}
                      onChange={(e) => updateItem(idx, { description: e.target.value.slice(0, DESC_MAX) })}
                      placeholder={t('rpDescPlaceholder')}
                      rows={3}
                      disabled={saving}
                      className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white resize-y focus:outline-none focus:ring-2 focus:ring-rose-500/40"
                    />
                    <div className="flex justify-between text-[11px] mt-0.5">
                      <span className="text-red-500">{touched && err ? err : ''}</span>
                      <span className="text-gray-400">{it.description.trim().length}/{DESC_MAX}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {items.length < MAX_ITEMS && (
              <button type="button" onClick={addItem} disabled={saving} className="w-full rounded-xl border border-dashed border-rose-500/40 py-2 text-sm text-rose-500 hover:bg-rose-500/5">
                + {t('rpAddItem').replace('{n}', String(items.length)).replace('{max}', String(MAX_ITEMS))}
              </button>
            )}
          </>
        )}

        {step === 2 && (
          <div>
            <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
              {t('rpSelectAccountLabel').replace('{platform}', platformLabel)}
              <span className="text-xs text-gray-400 font-normal ml-1">{t('rpSelectAccountHint')}</span>
            </label>
            <div className="space-y-1.5 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
              {accounts.length === 0 && accountsLoading && <div className="p-3 text-center text-xs text-gray-400">{t('rpAccountsLoading')}</div>}
              {accounts.length === 0 && !accountsLoading && (
                <div className="p-3 text-center space-y-2.5">
                  <div className="text-xs text-gray-400">{t('rpNoAccounts').replace('{platform}', platformLabel)}</div>
                  <button
                    type="button"
                    onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-rose-500 hover:bg-rose-600 active:scale-95"
                  >{t('rpGoAddAccount')}</button>
                </div>
              )}
              {accounts.map((a) => {
                const ready = a.status !== 'login_required' && a.status !== 'banned';
                const title = a.nickname || a.displayName;
                return (
                  <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                    <input type="radio" name="mx-report-account" checked={selectedId === a.id} onChange={() => ready && setSelectedId(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-rose-500 shrink-0" />
                    {a.avatar
                      ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                      : <span className="w-7 h-7 rounded-full bg-rose-500/20 text-rose-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium truncate dark:text-white">{title}</span>
                        {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{a.displayId}</span>}
                        {!ready && <span className="text-[11px] text-amber-500 shrink-0">{a.status === 'banned' ? t('rpStatusBanned') : t('rpStatusDisconnected')}</span>}
                      </div>
                      <div className="text-[11px] text-gray-400 truncate">{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-2">
              <div className="font-semibold dark:text-gray-200">{t('rpSummaryTitle')}</div>
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-16">{t('rpSummaryAccount')}</span><span className="text-gray-800 dark:text-gray-200">{selectedAccount ? (selectedAccount.nickname || selectedAccount.displayName) : '-'}</span></div>
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-16">{t('rpSummaryRun')}</span><span className="text-gray-800 dark:text-gray-200">{t('rpSummaryRunValue')}</span></div>
              <div className="space-y-1.5 pt-1">
                {items.map((it, i) => (
                  <div key={i} className="text-xs rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5">
                    <div className="font-mono break-all text-gray-800 dark:text-gray-200">{i + 1}. {it.url.trim()}</div>
                    <div className="text-rose-600 dark:text-rose-400">{reportReasonLabel(it.reason)}</div>
                    <div className="text-gray-500 dark:text-gray-400 break-all">{it.description.trim()}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t('rpTermsTitle')}</div>
              {[t('rpTerm1'), t('rpTerm2'), t('rpTerm3')].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-rose-500 shrink-0" />
                  <span className="leading-relaxed">{term}</span>
                </label>
              ))}
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
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{t('rpCancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{t('rpPrev')}</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">{t('rpNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">{saving ? t('rpSaving') : (editing ? t('rpSaveEdit') : t('rpCreate'))}</button>
        )}
      </div>
    </div>
  );
};

export default MatrixReportWizard;
