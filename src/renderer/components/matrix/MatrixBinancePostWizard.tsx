/**
 * MatrixBinancePostWizard — 矩阵版「币安广场自动发帖」向导(目前仅币安广场)。
 *
 * 多账号任务:勾选 N 个号,每个号在各自指纹浏览器里按【自己的人设/赛道/关键词】(沿用账号已配身份)
 * 抓近 3 周 web3 热门资讯 → AI 紧贴资讯深度创作一条币安广场图文,可选配图,发到币安广场。
 * 每号每轮固定 1 条,内容互不相同。仅 web3 资讯模式(对齐旧 binance_square_post_creator)。
 *
 *   Step 1 — 勾选 N 个账号(多选)
 *   Step 2 — 写作语言 + 配图 + 生成后(发布方式)
 *   Step 3 — 运行频率 + 摘要 + 条款
 *
 * 仿 MatrixTweetPostWizard,裁去内容来源选择(恒 web3)/蓝V/各号参考文案。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import Web3NewsSourcesPreview from './Web3NewsSourcesPreview';
import { POST_LANGS, postLangLabel } from './postLangs';

type WizardStep = 1 | 2 | 3;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };

export interface BinancePostWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  withImage: boolean;
  language: string;
  autoPublish: boolean;
}

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: BinancePostWizardSave) => Promise<void> | void;
}

const MatrixBinancePostWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  // ── 多选账号 ──(默认勾选所有「就绪」号)
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (Array.isArray(initialTask?.accountIds) && initialTask.accountIds.length) return Array.from(new Set(initialTask.accountIds.map(String)));
    return accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id);
  });
  const toggle = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  // 账号加载好后剔除【幽灵 id】(已删除的号残留在 accountIds 里,查不到就不渲染却仍计数 → 计数虚高,用户实测)。
  useEffect(() => {
    if (accountsLoading || !accounts.length) return;
    const live = new Set(accounts.map((a) => a.id));
    setSelectedIds((prev) => { const next = prev.filter((id) => live.has(id)); return next.length === prev.length ? prev : next; });
  }, [accounts, accountsLoading]);

  // ── 发帖配置(全局) ──
  const bp = initialTask?.binancePost || {};
  const [withImage, setWithImage] = useState<boolean>(bp.withImage !== false); // 默认配图开
  const [language, setLanguage] = useState<string>(bp.language || 'mixed');
  const [autoPublish, setAutoPublish] = useState<boolean>(bp.autoPublish !== false); // 默认群发

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, withImage, language, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selectedIds.length > 0, reason: i18nService.t('wzBnPostErrSelectAccount') },
    2: { ok: true },
    3: { ok: allTermsAccepted, reason: i18nService.t('wzBnPostErrAcceptTerms') },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    if (selectedIds.length === 0) { setSaveError(canAdvance[1].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || i18nService.t('wzBnPostDefaultTaskName').replace('{n}', String(selectedIds.length)),
        accountIds: selectedIds,
        concurrency: selectedIds.length,
        frequency: runInterval,
        withImage,
        language,
        autoPublish,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || i18nService.t('wzBnPostErrSaveFailed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: i18nService.t('wzBnPostFreqOnce'), '3h': i18nService.t('wzBnPostFreq3h'), '6h': i18nService.t('wzBnPostFreq6h'), daily_random: i18nService.t('wzBnPostFreqDailyRandomOnce') };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  const langLabel = (l: string) => postLangLabel(l, i18nService.currentLanguage === 'zh');

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">📊 {editing ? i18nService.t('wzBnPostTitleEdit') : i18nService.t('wzBnPostTitleCreate')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-amber-500/40 text-amber-500 bg-amber-500/5">{i18nService.t('wzBnPostStepIndicator').replace('{n}', String(step))}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300">
              📊 {i18nService.t('wzBnPostIntroPart1').replace('{platform}', platformLabel)}<strong>{i18nService.t('wzBnPostIntroStrong1')}</strong>{i18nService.t('wzBnPostIntroPart2')}<strong>{i18nService.t('wzBnPostIntroStrong2')}</strong>{i18nService.t('wzBnPostIntroPart3')}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {i18nService.t('wzBnPostSelectAccountLabel').replace('{platform}', platformLabel)}<span className="text-xs text-gray-400 font-normal ml-1">{i18nService.t('wzBnPostSelectAccountHint').replace('{platform}', platformLabel)}{selectedIds.length ? i18nService.t('wzBnPostSelectedCount').replace('{n}', String(selectedIds.length)) : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (
                  <div className="p-3 text-center text-xs text-gray-400">{i18nService.t('wzBnPostAccountsLoading')}</div>
                )}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{i18nService.t('wzBnPostNoAccounts').replace('{platform}', platformLabel)}</div>
                    <button
                      type="button"
                      onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-amber-500 hover:bg-amber-600 active:scale-95"
                    >{i18nService.t('wzBnPostGoAddAccount')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? i18nService.t('wzBnPostStatusBanned') : a.status === 'login_required' ? i18nService.t('wzBnPostStatusDisconnected') : '';
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-amber-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-amber-500/20 text-amber-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">@{a.displayId}</span>}
                          {a.status === 'login_required'
                            ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: a.platform || platform } })); onCancel(); }} title={i18nService.t('wzBnPostGoLoginTitle')} className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">{i18nService.t('wzBnPostGoLogin')}</button>
                            : reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{i18nService.t('wzBnPostRemarkPrefix')}{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
            <Web3NewsSourcesPreview isZh={isZh} />
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{i18nService.t('wzBnPostLangLabel')}</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/40">
                {POST_LANGS.map((l) => <option key={l.code} value={l.code}>{i18nService.currentLanguage === 'zh' ? l.zh : l.en}</option>)}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{i18nService.t('wzBnPostImageLabel')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setWithImage(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!withImage ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  {i18nService.t('wzBnPostImageTextOnly')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnPostImageTextOnlyDesc')}</div>
                </button>
                <button type="button" onClick={() => setWithImage(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${withImage ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  {i18nService.t('wzBnPostImageWith')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnPostImageWithDesc')}</div>
                </button>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{i18nService.t('wzBnPostAfterGenLabel')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${autoPublish ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  {i18nService.t('wzBnPostPublishAuto')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnPostPublishAutoDesc')}</div>
                </button>
                <button type="button" onClick={() => setAutoPublish(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!autoPublish ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  {i18nService.t('wzBnPostPublishDraft')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnPostPublishDraftDesc')}</div>
                </button>
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{i18nService.t('wzBnPostFreqLabel')}</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', i18nService.t('wzBnPostFreqOnce')], ['3h', i18nService.t('wzBnPostFreq3h')], ['6h', i18nService.t('wzBnPostFreq6h')], ['daily_random', i18nService.t('wzBnPostFreqDailyRandom')]].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-amber-500 bg-amber-500/10 text-amber-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">{i18nService.t('wzBnPostSummaryTitle')}</div>
              <SummaryRow label={i18nService.t('wzBnPostSummaryAccounts')} value={i18nService.t('wzBnPostSummaryAccountsValue').replace('{n}', String(selectedIds.length))} />
              <SummaryRow label={i18nService.t('wzBnPostSummarySource')} value={i18nService.t('wzBnPostSummarySourceValue')} />
              <SummaryRow label={i18nService.t('wzBnPostSummaryLanguage')} value={langLabel(language)} />
              <SummaryRow label={i18nService.t('wzBnPostSummaryImage')} value={withImage ? i18nService.t('wzBnPostSummaryImageWith') : i18nService.t('wzBnPostSummaryImageTextOnly')} />
              <SummaryRow label={i18nService.t('wzBnPostSummaryCount')} value={i18nService.t('wzBnPostSummaryCountValue').replace('{n}', String(selectedIds.length))} />
              <SummaryRow label={i18nService.t('wzBnPostSummaryPublish')} value={autoPublish ? i18nService.t('wzBnPostSummaryPublishAuto') : i18nService.t('wzBnPostSummaryPublishDraft')} />
              <SummaryRow label={i18nService.t('wzBnPostSummaryFreq')} value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{i18nService.t('wzBnPostTermsTitle')}</div>
              {[i18nService.t('wzBnPostTerm1'), i18nService.t('wzBnPostTerm2')].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-amber-500 shrink-0" />
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
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{i18nService.t('wzBnPostCancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{i18nService.t('wzBnPostPrev')}</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">{i18nService.t('wzBnPostNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">{saving ? i18nService.t('wzBnPostSaving') : (editing ? i18nService.t('wzBnPostSaveEdit') : i18nService.t('wzBnPostCreateTask'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixBinancePostWizard;
