/**
 * MatrixReportWizard — 「抖音Report」向导(白名单功能)。
 *
 * 逐步填写,一屏只做一件事(用户 2026-10-17 要求,原来一屏堆 4 条太挤):
 *   第 1 步      — 选要 Report 几条(1-4)
 *   第 2..N+1 步 — 每条一步:类型(下拉:作品 / 账号)→ 链接 → 原因(下拉,默认第一个)
 *                 → 具体类型(有的话)→ 详细描述
 *   第 N+2 步    — 选【1 个】执行账号
 *   第 N+3 步    — 确认 + 合规条款 → 创建
 *
 * 原因/具体类型 = 抖音表单原文(reportTaxonomy.ts,真机核对),描述框提示照抄抖音。
 * 合规:单账号、手动触发(每次逐条只提交一次,不重试、不定时);可编辑。
 */

import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import {
  REPORT_TAXONOMY, REPORT_DEFAULT_HINT, findReportReason, validateReportItem,
  type ReportTargetType,
} from '../../../main/libs/matrix/reportTaxonomy';

const MAX_ITEMS = 4;
const DESC_MAX = 200;

export interface ReportItemInput { url: string; targetType: ReportTargetType; reason: string; subReason: string; description: string }
export interface WizardAccount { id: string; displayName: string; status: string; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const t = (k: string) => i18nService.t(k);
export const reportErrText = (code: string) => { const k = `rpErr_${code}`; const v = i18nService.t(k); return v !== k ? v : code; };

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; reportItems: Array<{ url: string; targetType: ReportTargetType; reason: string; subReason?: string; description: string }> }) => Promise<void> | void;
}

/** 某类型下的默认原因 = 第一个;该原因的具体类型必填时默认选第一个具体类型,选填则留空。 */
function defaultsFor(type: ReportTargetType): { reason: string; subReason: string } {
  const g = REPORT_TAXONOMY[type];
  const r = g.reasons[0];
  const subReq = g.subRequired || !!r.subRequired;
  return { reason: r.label, subReason: subReq && r.sub.length ? r.sub[0] : '' };
}
const newItem = (type: ReportTargetType = 'content'): ReportItemInput => ({ url: '', targetType: type, ...defaultsFor(type), description: '' });

const inputCls = 'w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40';
const labelCls = 'text-sm font-medium dark:text-gray-200 mb-1.5 block';

const MatrixReportWizard: React.FC<Props> = ({ platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;

  const [items, setItems] = useState<ReportItemInput[]>(() => {
    const src: any[] = Array.isArray(initialTask?.reportItems) ? initialTask.reportItems : [];
    if (!src.length) return [newItem()];
    return src.slice(0, MAX_ITEMS).map((x) => {
      const type: ReportTargetType = x.targetType === 'account' ? 'account' : 'content';
      return { url: String(x.url || ''), targetType: type, reason: String(x.reason || defaultsFor(type).reason), subReason: String(x.subReason || ''), description: String(x.description || '') };
    });
  });
  const count = items.length;
  // 步骤:0 = 选条数;1..count = 第 i 条;count+1 = 选账号;count+2 = 确认
  const [step, setStep] = useState(0);
  const totalSteps = count + 3;
  const accountStep = count + 1;
  const confirmStep = count + 2;

  // 执行账号可多选(2026-10-18):每个号各自把全部条目逐条提交一次,按顺序一个号跑完再跑下一个
  const [selectedIds, setSelectedIds] = useState<string[]>(() => (initialTask?.accountIds || []).map(String).filter(Boolean));
  const toggleAccount = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([false, false]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [items, selectedIds, step]);

  const setCount = (n: number) => setItems((prev) => {
    if (n === prev.length) return prev;
    if (n < prev.length) return prev.slice(0, n);
    return [...prev, ...Array.from({ length: n - prev.length }, () => newItem())];
  });
  const updateItem = (idx: number, patch: Partial<ReportItemInput>) => setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const itemError = (idx: number): string | null => {
    const it = items[idx];
    if (!it) return null;
    if (!it.url.trim()) return t('rpErrUrlEmpty');
    const dup = items.findIndex((x) => x.url.trim() === it.url.trim());
    if (dup !== idx) return reportErrText('report_duplicate_url');
    const code = validateReportItem({ ...it, subReason: it.subReason || undefined });
    return code ? reportErrText(code) : null;
  };

  const stepError = (s: number): string | null => {
    if (s >= 1 && s <= count) return itemError(s - 1);
    if (s === accountStep) return selectedIds.some((id) => accounts.some((a) => a.id === id)) ? null : t('rpErrSelectAccount');
    if (s === confirmStep) return allTermsAccepted ? null : t('rpErrAcceptTerms');
    return null;
  };

  const next = () => {
    const err = stepError(step);
    if (err) { setSaveError(err); return; }
    setSaveError(null);
    setStep((s) => Math.min(s + 1, confirmStep));
  };

  const handleSave = async () => {
    if (saving) return;
    for (let s = 1; s <= confirmStep; s++) {
      const err = stepError(s);
      if (err) { setSaveError(err); setStep(s); return; }
    }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || t('rpTaskName').replace('{n}', String(count)),
        // 只保留仍在列表里的号(编辑旧任务时某号可能已删除)
        accountIds: selectedIds.filter((id) => accounts.some((a) => a.id === id)),
        reportItems: items.map((it) => ({ url: it.url.trim(), targetType: it.targetType, reason: it.reason, subReason: it.subReason || undefined, description: it.description.trim() })),
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || t('rpErrSaveFailed'));
    } finally { setSaving(false); }
  };

  const selectedAccounts = accounts.filter((a) => selectedIds.includes(a.id));

  // ── 单条表单(第 1..count 步)──
  const renderItemStep = (idx: number) => {
    const it = items[idx];
    const group = REPORT_TAXONOMY[it.targetType];
    const def = findReportReason(it.targetType, it.reason);
    const subReq = group.subRequired || !!def?.subRequired;
    const hint = def?.hint || REPORT_DEFAULT_HINT;
    return (
      <div className="space-y-4">
        <div className="text-sm font-semibold dark:text-white">{t('rpItemLabel').replace('{n}', String(idx + 1))} <span className="text-xs font-normal text-gray-400">/ {count}</span></div>

        <div>
          <label className={labelCls}>{t('rpTypeLabel')}</label>
          <select value={it.targetType} disabled={saving} className={inputCls}
            onChange={(e) => { const type = e.target.value as ReportTargetType; updateItem(idx, { targetType: type, ...defaultsFor(type) }); }}>
            <option value="content">{t('rpTypeContent')}</option>
            <option value="account">{t('rpTypeAccount')}</option>
          </select>
        </div>

        <div>
          <label className={labelCls}>{t('rpLinkLabel')}</label>
          <input type="text" value={it.url} onChange={(e) => updateItem(idx, { url: e.target.value })} disabled={saving}
            placeholder={it.targetType === 'account' ? t('rpUrlPlaceholderAccount') : t('rpUrlPlaceholderContent')}
            className={`${inputCls} font-mono`} />
        </div>

        <div>
          <label className={labelCls}>{t('rpReasonLabel')}</label>
          <select value={it.reason} disabled={saving} className={inputCls}
            onChange={(e) => {
              const d = findReportReason(it.targetType, e.target.value);
              const req = group.subRequired || !!d?.subRequired;
              updateItem(idx, { reason: e.target.value, subReason: req && d && d.sub.length ? d.sub[0] : '' });
            }}>
            {group.reasons.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
          </select>
        </div>

        {def && def.sub.length > 0 && (
          <div>
            <label className={labelCls}>{t('rpSubLabel')}{!subReq && <span className="text-xs text-gray-400 font-normal ml-1">{t('rpOptional')}</span>}</label>
            <select value={it.subReason} disabled={saving} className={inputCls} onChange={(e) => updateItem(idx, { subReason: e.target.value })}>
              {!subReq && <option value="">{t('rpSubNone')}</option>}
              {def.sub.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        <div>
          <label className={labelCls}>{t('rpDescLabel')}</label>
          <textarea value={it.description} onChange={(e) => updateItem(idx, { description: e.target.value.slice(0, DESC_MAX) })} placeholder={hint} rows={4} disabled={saving} className={`${inputCls} resize-y`} />
          <div className="text-right text-[11px] text-gray-400 mt-0.5">{it.description.trim().length}/{DESC_MAX}</div>
        </div>
      </div>
    );
  };

  const isLast = step === confirmStep;

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">📋 {editing ? t('rpTitleEdit') : t('rpTitleCreate')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-sky-500/40 text-sky-500 bg-sky-500/5">{t('rpStepIndicator').replace('{n}', String(step + 1)).replace('{total}', String(totalSteps))}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {step === 0 && (
          <div className="space-y-4">
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300">📋 {t('rpIntro')}</div>
            <div>
              <label className={labelCls}>{t('rpCountLabel')}</label>
              <div className="flex gap-2">
                {Array.from({ length: MAX_ITEMS }, (_, i) => i + 1).map((n) => (
                  <button key={n} type="button" disabled={saving} onClick={() => setCount(n)}
                    className={`w-14 py-2 rounded-lg text-sm border transition-colors ${count === n ? 'border-sky-500 bg-sky-500/10 text-sky-500 font-semibold' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">{t('rpCountHint')}</p>
            </div>
          </div>
        )}

        {step >= 1 && step <= count && renderItemStep(step - 1)}

        {step === accountStep && (
          <div>
            <label className={labelCls}>
              {t('rpSelectAccountLabel')}
              <span className="text-xs text-gray-400 font-normal ml-1">{t('rpSelectAccountHint')}</span>
            </label>
            <div className="space-y-1.5 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
              {accounts.length === 0 && accountsLoading && <div className="p-3 text-center text-xs text-gray-400">{t('rpAccountsLoading')}</div>}
              {accounts.length === 0 && !accountsLoading && (
                <div className="p-3 text-center space-y-2.5">
                  <div className="text-xs text-gray-400">{t('rpNoAccounts')}</div>
                  <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-sky-500 hover:bg-sky-600 active:scale-95">{t('rpGoAddAccount')}</button>
                </div>
              )}
              {accounts.map((a) => {
                const ready = a.status !== 'login_required' && a.status !== 'banned';
                const title = a.nickname || a.displayName;
                return (
                  <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                    <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => ready && toggleAccount(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-sky-500 shrink-0" />
                    {a.avatar
                      ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                      : <span className="w-7 h-7 rounded-full bg-sky-500/20 text-sky-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
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

        {step === confirmStep && (
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-2">
              <div className="font-semibold dark:text-gray-200">{t('rpSummaryTitle')}</div>
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-16">{t('rpSummaryAccount')}</span><span className="text-gray-800 dark:text-gray-200">{selectedAccounts.length ? selectedAccounts.map((a) => a.nickname || a.displayName).join('、') : '-'}</span></div>
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-16">{t('rpSummaryRun')}</span><span className="text-gray-800 dark:text-gray-200">{t('rpSummaryRunValue')}</span></div>
              <div className="space-y-1.5 pt-1">
                {items.map((it, i) => (
                  <button key={i} type="button" onClick={() => setStep(i + 1)} className="w-full text-left text-xs rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 hover:border-sky-500/50">
                    <div className="font-mono break-all text-gray-800 dark:text-gray-200">{i + 1}. [{it.targetType === 'account' ? t('rpTypeAccount') : t('rpTypeContent')}] {it.url.trim()}</div>
                    <div className="text-sky-600 dark:text-sky-400">{it.reason}{it.subReason ? ` › ${it.subReason}` : ''}</div>
                    <div className="text-gray-500 dark:text-gray-400 break-all">{it.description.trim()}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{t('rpTermsTitle')}</div>
              {[t('rpTerm1'), t('rpTerm2')].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const nx = [...termsAccepted]; nx[i] = e.target.checked; setTermsAccepted(nx); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-sky-500 shrink-0" />
                  <span className="leading-relaxed">{term}</span>
                </label>
              ))}
            </div>
          </div>
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
        {step > 0 && <button type="button" onClick={() => { setSaveError(null); setStep(step - 1); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{t('rpPrev')}</button>}
        {!isLast ? (
          <button type="button" onClick={next} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50">{t('rpNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50">{saving ? t('rpSaving') : (editing ? t('rpSaveEdit') : t('rpCreate'))}</button>
        )}
      </div>
    </div>
  );
};

export default MatrixReportWizard;
