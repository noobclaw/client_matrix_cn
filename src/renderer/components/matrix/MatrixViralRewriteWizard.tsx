/**
 * MatrixViralRewriteWizard — 矩阵版「小红书爆款批量仿写」向导。
 *
 * 多账号:勾选 N 个号,每个号用【自己的赛道/关键词/人设】去小红书搜本 niche 爆款 → 维度化创意引擎
 * 仿写 → AI 生图 → 发布。来源=每号关键词搜(沿用账号已配,不在向导填)。比图文创作更简:无参考文案、
 * 无配图模式(固定 AI 生图)。
 *
 *   Step 1 — 勾选 N 个账号
 *   Step 2 — 每号每轮仿写篇数 + AI 风格 + 发布方式
 *   Step 3 — 运行频率 + 摘要 + 条款
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { fetchImageStyles, FALLBACK_IMAGE_STYLES, ImageStyle } from '../../services/imageStyles';

type WizardStep = 1 | 2 | 3;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok' };

// AI 生图风格:从 backend /api/image/styles 拉全量目录(~38 个风格·7 大类),失败回退
// FALLBACK_IMAGE_STYLES。风格 id 即后端 orchestrator 认的 key。见组件内 stylesList。

export interface ViralRewriteWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  dailyCount: number;
  aiImageStyle: string;
  autoPublish: boolean;
}

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: ViralRewriteWizardSave) => Promise<void> | void;
}

const MatrixViralRewriteWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (Array.isArray(initialTask?.accountIds) && initialTask.accountIds.length) return initialTask.accountIds.map(String);
    return accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id);
  });
  const toggle = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const vr = initialTask?.viralRewrite || {};
  const [dailyCount, setDailyCount] = useState<number>(Math.max(1, Math.min(20, Number(vr.dailyCount) || 1)));
  const [aiImageStyle, setAiImageStyle] = useState<string>(vr.aiImageStyle || 'ai_auto');
  // 全量风格目录(server-side 单源;拉不到回退兜底列表)。
  const [stylesList, setStylesList] = useState<ImageStyle[]>(FALLBACK_IMAGE_STYLES);
  useEffect(() => { let alive = true; fetchImageStyles().then((r) => { if (alive) setStylesList(r.styles); }); return () => { alive = false; }; }, []);
  const isZhStyle = i18nService.currentLanguage.startsWith('zh');
  const [autoPublish, setAutoPublish] = useState<boolean>(vr.autoPublish !== false);

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, dailyCount, runInterval]);

  // 每个选中号都要有关键词(没词没法搜爆款)。
  const selectedNoKeyword = useMemo(
    () => accounts.filter((a) => selectedIds.includes(a.id) && (!a.keywords || a.keywords.length === 0)),
    [accounts, selectedIds],
  );

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: selectedIds.length === 0
      ? { ok: false, reason: i18nService.t('wzViralNeedOneAccount') }
      : selectedNoKeyword.length > 0
        ? { ok: false, reason: i18nService.t('wzViralNoKeywordBlock').replace('{n}', String(selectedNoKeyword.length)) }
        : { ok: true },
    2: { ok: true },
    3: { ok: allTermsAccepted, reason: i18nService.t('wzViralNeedTerms') },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    if (!canAdvance[1].ok) { setSaveError(canAdvance[1].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || i18nService.t('wzViralTaskName').replace('{platform}', platformLabel).replace('{n}', String(selectedIds.length)),
        accountIds: selectedIds,
        concurrency: selectedIds.length,
        frequency: runInterval,
        dailyCount,
        aiImageStyle,
        autoPublish,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || i18nService.t('wzViralSaveFailed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: i18nService.t('wzViralFreqOnce'), '3h': i18nService.t('wzViralFreq3h'), '6h': i18nService.t('wzViralFreq6h'), daily_random: i18nService.t('wzViralFreqDailyRandomLong') };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🔥 {editing ? i18nService.t('wzViralTitleEdit').replace('{platform}', platformLabel) : i18nService.t('wzViralTitleNew').replace('{platform}', platformLabel)}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-rose-500/40 text-rose-500 bg-rose-500/5">{i18nService.t('wzViralStepIndicator').replace('{step}', String(step))}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-rose-500/30 bg-rose-500/5 text-rose-700 dark:text-rose-300">
              🔥 {i18nService.t('wzViralIntro').replace('{platform}', platformLabel)}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {i18nService.t('wzViralSelectAccounts').replace('{platform}', platformLabel)}<span className="text-xs text-gray-400 font-normal ml-1">· {i18nService.t('wzViralLoggedInOk')}{selectedIds.length ? i18nService.t('wzViralSelectedCount').replace('{n}', String(selectedIds.length)) : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (<div className="p-3 text-center text-xs text-gray-400">{i18nService.t('wzViralAccountsLoading')}</div>)}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{i18nService.t('wzViralNoAccounts').replace('{platform}', platformLabel)}</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-rose-500 hover:bg-rose-600 active:scale-95">{i18nService.t('wzViralGoAddAccounts')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? i18nService.t('wzViralStatusBanned') : a.status === 'login_required' ? i18nService.t('wzViralStatusDisconnected') : '';
                  const title = a.nickname || a.displayName;
                  const noKw = !a.keywords || a.keywords.length === 0;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-rose-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-rose-500/20 text-rose-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{i18nService.t('wzViralAccountIdLabel').replace('{platform}', PLATFORM_NAME[a.platform || ''] || '')}{a.displayId}</span>}
                          {a.status === 'login_required'
                            ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: a.platform || platform } })); onCancel(); }} title={i18nService.t('wzViralGoLoginTitle')} className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">{i18nService.t('wzViralGoLogin')}</button>
                            : reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
                          {ready && noKw && <span className="text-[11px] text-amber-500 shrink-0">{i18nService.t('wzViralNoKeywordTag')}</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{i18nService.t('wzViralRemarkLabel')}{a.displayName}{a.group ? ` · ${a.group}` : ''}{a.keywords && a.keywords.length ? ` · 🏷️ ${a.keywords.join('/')}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
              {selectedNoKeyword.length > 0 && <div className="text-[11px] text-amber-500 mt-1.5">⚠ {i18nService.t('wzViralNoKeywordWarn').replace('{n}', String(selectedNoKeyword.length))}</div>}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{i18nService.t('wzViralPerRoundPrefix')} <span className="text-rose-500 font-bold">{dailyCount}</span> {i18nService.t('wzViralPerRoundSuffix')}</label>
              <input type="range" min={1} max={20} value={dailyCount} onChange={(e) => setDailyCount(Number(e.target.value))} disabled={saving} className="w-full accent-rose-500" />
              <div className="flex justify-between text-[10px] text-gray-400"><span>1</span><span>20</span></div>
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🎨 {i18nService.t('wzViralAiStyleLabel')}<span className="text-xs text-gray-400 font-normal ml-1">· {i18nService.t('wzViralAiStyleHint')}</span></label>
              <select value={aiImageStyle} onChange={(e) => setAiImageStyle(e.target.value)} disabled={saving} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500/40">
                {stylesList.map((opt) => <option key={opt.id} value={opt.id}>{opt.icon} {isZhStyle ? opt.zh : opt.en} — {isZhStyle ? opt.desc_zh : opt.desc_en}</option>)}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">📤 {i18nService.t('wzViralAfterGen')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${autoPublish ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-rose-500/50'}`}>
                  🚀 {i18nService.t('wzViralPublishNow')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzViralPublishNowDesc')}</div>
                </button>
                <button type="button" onClick={() => setAutoPublish(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!autoPublish ? 'border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-rose-500/50'}`}>
                  💾 {i18nService.t('wzViralLocalOnly')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzViralLocalOnlyDesc')}</div>
                </button>
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">⏰ {i18nService.t('wzViralFreqLabel')}</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', i18nService.t('wzViralFreqOnce')], ['3h', i18nService.t('wzViralFreq3h')], ['6h', i18nService.t('wzViralFreq6h')], ['daily_random', i18nService.t('wzViralFreqDailyRandom')]].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-rose-500 bg-rose-500/10 text-rose-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-rose-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 {i18nService.t('wzViralSummaryTitle')}</div>
              <SummaryRow label={i18nService.t('wzViralSummaryAccount')} value={i18nService.t('wzViralSummaryAccountVal').replace('{n}', String(selectedIds.length))} />
              <SummaryRow label={i18nService.t('wzViralSummaryCount')} value={i18nService.t('wzViralSummaryCountVal').replace('{daily}', String(dailyCount)).replace('{total}', String(selectedIds.length * dailyCount))} />
              <SummaryRow label={i18nService.t('wzViralSummaryImage')} value={i18nService.t('wzViralSummaryImageVal').replace('{style}', (() => { const s = stylesList.find((x) => x.id === aiImageStyle); return s ? (isZhStyle ? s.zh : s.en) : aiImageStyle; })())} />
              <SummaryRow label={i18nService.t('wzViralSummaryPublish')} value={autoPublish ? i18nService.t('wzViralSummaryPublishAuto') : i18nService.t('wzViralSummaryPublishLocal')} />
              <SummaryRow label={i18nService.t('wzViralSummaryFreq')} value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{i18nService.t('wzViralTermsTitle')}</div>
              {[i18nService.t('wzViralTerm1'), i18nService.t('wzViralTerm2')].map((term, i) => (
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
          <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">❌ {saveError}</div>{/* saveError already localized */}
        </div>
      )}

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{i18nService.t('wzViralCancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{i18nService.t('wzViralPrev')}</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">{i18nService.t('wzViralNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-rose-500 text-white hover:bg-rose-600 disabled:opacity-50">{saving ? i18nService.t('wzViralSaving') : (editing ? i18nService.t('wzViralSaveEdit') : i18nService.t('wzViralCreate'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixViralRewriteWizard;
