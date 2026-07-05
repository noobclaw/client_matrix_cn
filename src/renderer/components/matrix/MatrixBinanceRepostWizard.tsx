/**
 * MatrixBinanceRepostWizard — 矩阵版「币安广场批量搬运」向导。
 *
 * 两种账号角色:① 1 个【采集号】(源平台:小红书/抖音/TikTok/X)按关键词搜+下素材;
 * ② N 个【币安发布号】各领一条候选,AI 仿写 + 配源图 → 发币安广场。采集只跑一次,候选去重,每号独立改写。
 *
 *   Step 1 — 勾选 N 个币安发布号(多选)
 *   Step 2 — 来源:源平台 + 采集号(单选)+ 搜索关键词 + 形态(图文/视频)
 *   Step 3 — 写作语言 + 配图 + 发布方式
 *   Step 4 — 运行频率 + 摘要 + 条款
 *
 * v1 仅【小红书来源 + 图文搬运】跑通;其余源平台 / 视频搬运 UI 上标「敬请期待」禁用。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { POST_LANGS, postLangLabel } from './postLangs';

type WizardStep = 1 | 2 | 3 | 4;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };

// 来源平台按【搬运形态】给:图文→小红书 / X;视频→抖音 / TikTok。只列已实现的平台(不展示「敬请期待」)。
type SrcOpt = { id: 'xhs' | 'douyin' | 'tiktok' | 'x'; label: string; enabled: boolean };
const SOURCE_BY_MATERIAL: Record<'image' | 'video', SrcOpt[]> = {
  image: [
    { id: 'xhs', label: '小红书', enabled: true },
    { id: 'x', label: 'X(须VPN)', enabled: true },
  ],
  video: [
    { id: 'douyin', label: '抖音', enabled: true },
    { id: 'tiktok', label: 'TikTok(须VPN)', enabled: true },
  ],
};
function firstEnabledSource(material: 'image' | 'video'): SrcOpt['id'] {
  const list = SOURCE_BY_MATERIAL[material];
  return (list.find((s) => s.enabled) || list[0]).id;
}

export interface BinanceRepostWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  sourcePlatform: 'xhs' | 'douyin' | 'tiktok' | 'x';
  sourceAccountId: string;
  material: 'image' | 'video';
  withImage: boolean;
  language: string;   // 'mixed'/'auto'=跟随账号;或 9 种语言码之一(见 postLangs.ts)
  autoPublish: boolean;
}

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];          // 币安发布号(多选)
  sourceAccounts: WizardAccount[];    // 全部账号(挑采集号用,按所选源平台过滤)
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: BinanceRepostWizardSave) => Promise<void> | void;
}

const MatrixBinanceRepostWizard: React.FC<Props> = ({ platformLabel, platform, accounts, sourceAccounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

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

  const br = initialTask?.binanceRepost || {};
  const [material, setMaterial] = useState<'image' | 'video'>(br.material || 'video'); // 默认视频
  const [sourcePlatform, setSourcePlatform] = useState<'xhs' | 'douyin' | 'tiktok' | 'x'>(br.sourcePlatform || firstEnabledSource(br.material || 'video'));
  const [sourceAccountId, setSourceAccountId] = useState<string>(br.sourceAccountId || '');
  const [withImage, setWithImage] = useState<boolean>(br.withImage !== false);
  const [language, setLanguage] = useState<string>(br.language || 'mixed');
  const [autoPublish, setAutoPublish] = useState<boolean>(br.autoPublish !== false);

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 按所选源平台过滤可选采集号。
  const sourceCandidates = useMemo(
    () => sourceAccounts.filter((a) => a.platform === sourcePlatform),
    [sourceAccounts, sourcePlatform],
  );
  // 切换源平台后,若当前采集号不属于新平台 → 清空。
  useEffect(() => {
    if (sourceAccountId && !sourceCandidates.some((a) => a.id === sourceAccountId)) setSourceAccountId('');
  }, [sourcePlatform]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, sourcePlatform, sourceAccountId, withImage, language, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selectedIds.length > 0, reason: i18nService.t('wzBnRepostReasonSelectAccount') },
    2: { ok: !!sourceAccountId, reason: i18nService.t('wzBnRepostReasonPickSource') },
    3: { ok: true },
    4: { ok: allTermsAccepted, reason: i18nService.t('wzBnRepostReasonAcceptTerms') },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[4].ok) { setSaveError(canAdvance[4].reason || ''); return; }
    if (selectedIds.length === 0) { setSaveError(canAdvance[1].reason || ''); return; }
    if (!sourceAccountId) { setSaveError(canAdvance[2].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || i18nService.t('wzBnRepostTaskName').replace('{platform}', PLATFORM_NAME[sourcePlatform]).replace('{n}', String(selectedIds.length)),
        accountIds: selectedIds,
        concurrency: 1,
        frequency: runInterval,
        sourcePlatform,
        sourceAccountId,
        material,
        withImage,
        language,
        autoPublish,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || i18nService.t('wzBnRepostSaveFailed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: i18nService.t('wzBnRepostIntervalOnceFull'), '3h': i18nService.t('wzBnRepostInterval3h'), '6h': i18nService.t('wzBnRepostInterval6h'), daily_random: i18nService.t('wzBnRepostIntervalDailyRandomFull') };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  const langLabel = (l: string) => postLangLabel(l, i18nService.currentLanguage === 'zh');
  const srcAcc = sourceCandidates.find((a) => a.id === sourceAccountId);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">♻️ {editing ? i18nService.t('wzBnRepostTitleEdit') : i18nService.t('wzBnRepostTitleCreate')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-amber-500/40 text-amber-500 bg-amber-500/5">{i18nService.t('wzBnRepostStepIndicator').replace('{n}', String(step))}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300">
              ♻️ {i18nService.t('wzBnRepostStep1IntroA').replace('{platform}', platformLabel)}<strong>{i18nService.t('wzBnRepostStep1IntroStrong')}</strong>{i18nService.t('wzBnRepostStep1IntroB')}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {i18nService.t('wzBnRepostSelectPublisherLabel').replace('{platform}', platformLabel)}<span className="text-xs text-gray-400 font-normal ml-1">{i18nService.t('wzBnRepostSelectPublisherHint')}{selectedIds.length ? i18nService.t('wzBnRepostSelectedCount').replace('{n}', String(selectedIds.length)) : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (<div className="p-3 text-center text-xs text-gray-400">{i18nService.t('wzBnRepostAccountsLoading')}</div>)}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{i18nService.t('wzBnRepostNoAccounts').replace('{platform}', platformLabel)}</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-amber-500 hover:bg-amber-600 active:scale-95">{i18nService.t('wzBnRepostGoAddAccounts')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? i18nService.t('wzBnRepostStatusBanned') : a.status === 'login_required' ? i18nService.t('wzBnRepostStatusDisconnected') : '';
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
                          {reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{i18nService.t('wzBnRepostRemarkPrefix')}{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🎞️ {i18nService.t('wzBnRepostMaterialLabel')}<span className="text-xs text-gray-400 font-normal ml-1">{i18nService.t('wzBnRepostMaterialHint')}</span></label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setMaterial('image'); setSourcePlatform(firstEnabledSource('image')); setSourceAccountId(''); }} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${material === 'image' ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  🖼️ {i18nService.t('wzBnRepostMaterialImage')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnRepostMaterialImageDesc')}</div>
                </button>
                <button type="button" onClick={() => { setMaterial('video'); setSourcePlatform(firstEnabledSource('video')); setSourceAccountId(''); }} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${material === 'video' ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  🎬 {i18nService.t('wzBnRepostMaterialVideo')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnRepostMaterialVideoDesc')}</div>
                </button>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🌐 {i18nService.t('wzBnRepostSourcePlatformLabel')}<span className="text-xs text-gray-400 font-normal ml-1">· {material === 'image' ? i18nService.t('wzBnRepostSourceHintImage') : i18nService.t('wzBnRepostSourceHintVideo')}</span></label>
              <div className="flex gap-2 flex-wrap">
                {SOURCE_BY_MATERIAL[material].map((sp) => (
                  <button key={sp.id} type="button" disabled={!sp.enabled} onClick={() => { if (sp.enabled) { setSourcePlatform(sp.id); setSourceAccountId(''); } }} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${sourcePlatform === sp.id ? 'border-amber-500 bg-amber-500/10 text-amber-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'} ${!sp.enabled ? 'opacity-40 cursor-not-allowed' : ''}`}>{sp.label}{!sp.enabled ? i18nService.t('wzBnRepostComingSoon') : ''}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🧺 {i18nService.t('wzBnRepostCollectorLabel')}<span className="text-xs text-gray-400 font-normal ml-1">{i18nService.t('wzBnRepostCollectorHint').replace('{platform}', PLATFORM_NAME[sourcePlatform])}</span></label>
              <div className="space-y-1.5 max-h-48 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {sourceCandidates.length === 0 && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{i18nService.t('wzBnRepostNoCollector').replace('{platform}', PLATFORM_NAME[sourcePlatform])}</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: sourcePlatform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-amber-500 hover:bg-amber-600 active:scale-95">{i18nService.t('wzBnRepostGoAddCollector').replace('{platform}', PLATFORM_NAME[sourcePlatform])}</button>
                  </div>
                )}
                {sourceCandidates.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="radio" name="src-acc" checked={sourceAccountId === a.id} onChange={() => ready && setSourceAccountId(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-amber-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-amber-500/20 text-amber-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">@{a.displayId}</span>}
                          {!ready && <span className="text-[11px] text-amber-500 shrink-0">{a.status === 'banned' ? i18nService.t('wzBnRepostStatusBanned') : i18nService.t('wzBnRepostStatusDisconnected')}</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{i18nService.t('wzBnRepostRemarkPrefix')}{a.displayName}{a.group ? ` · ${a.group}` : ''}{Array.isArray(a.keywords) && a.keywords.length > 0 ? `${i18nService.t('wzBnRepostKeywordsPrefix')}${a.keywords.join('、')}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🔍 {i18nService.t('wzBnRepostKeywordLabel')}<span className="text-xs text-gray-400 font-normal ml-1">{i18nService.t('wzBnRepostKeywordHint')}</span></label>
              <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 px-3 py-2 text-[12px] text-gray-600 dark:text-gray-300 min-h-[38px] flex items-center">
                {srcAcc && Array.isArray(srcAcc.keywords) && srcAcc.keywords.length > 0
                  ? srcAcc.keywords.join('、')
                  : <span className="text-amber-500">{i18nService.t('wzBnRepostNoKeywords')}</span>}
              </div>
            </div>

          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🌐 {i18nService.t('wzBnRepostRewriteLangLabel')}</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500/40">
                {POST_LANGS.map((l) => <option key={l.code} value={l.code}>{i18nService.currentLanguage === 'zh' ? l.zh : l.en}</option>)}
              </select>
            </div>
            {material === 'image' && (
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🖼️ {i18nService.t('wzBnRepostImageLabel')}</label>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setWithImage(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${withImage ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                    🎨 {i18nService.t('wzBnRepostImageWithSource')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnRepostImageWithSourceDesc')}</div>
                  </button>
                  <button type="button" onClick={() => setWithImage(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!withImage ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                    📝 {i18nService.t('wzBnRepostImageTextOnly')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnRepostImageTextOnlyDesc')}</div>
                  </button>
                </div>
              </div>
            )}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">📤 {i18nService.t('wzBnRepostAfterGenLabel')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${autoPublish ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  🚀 {i18nService.t('wzBnRepostPublishNow')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnRepostPublishNowDesc')}</div>
                </button>
                <button type="button" onClick={() => setAutoPublish(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!autoPublish ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  💾 {i18nService.t('wzBnRepostGenOnly')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzBnRepostGenOnlyDesc')}</div>
                </button>
              </div>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">⏰ {i18nService.t('wzBnRepostFrequencyLabel')}</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', i18nService.t('wzBnRepostIntervalOnce')], ['3h', i18nService.t('wzBnRepostInterval3h')], ['6h', i18nService.t('wzBnRepostInterval6h')], ['daily_random', i18nService.t('wzBnRepostIntervalDailyRandom')]].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-amber-500 bg-amber-500/10 text-amber-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 {i18nService.t('wzBnRepostSummaryTitle')}</div>
              <SummaryRow label={i18nService.t('wzBnRepostSummarySource')} value={`${PLATFORM_NAME[sourcePlatform]} · ${i18nService.t('wzBnRepostSummarySourceCollector').replace('{name}', srcAcc ? (srcAcc.nickname || srcAcc.displayName) : i18nService.t('wzBnRepostSummaryNotSelected'))}`} />
              <SummaryRow label={i18nService.t('wzBnRepostSummaryKeyword')} value={srcAcc && Array.isArray(srcAcc.keywords) && srcAcc.keywords.length ? i18nService.t('wzBnRepostSummaryKeywordCount').replace('{n}', String(srcAcc.keywords.length)) : i18nService.t('wzBnRepostSummaryKeywordPlain')} />
              <SummaryRow label={i18nService.t('wzBnRepostSummaryMaterial')} value={material === 'image' ? i18nService.t('wzBnRepostSummaryMaterialImage') : i18nService.t('wzBnRepostSummaryMaterialVideo')} />
              <SummaryRow label={i18nService.t('wzBnRepostSummaryPublisher')} value={i18nService.t('wzBnRepostSummaryPublisherValue').replace('{n}', String(selectedIds.length))} />
              <SummaryRow label={i18nService.t('wzBnRepostSummaryLanguage')} value={langLabel(language)} />
              <SummaryRow label={i18nService.t('wzBnRepostSummaryImage')} value={material === 'video' ? i18nService.t('wzBnRepostSummaryImageVideo') : (withImage ? i18nService.t('wzBnRepostSummaryImageWithSource') : i18nService.t('wzBnRepostSummaryImageTextOnly'))} />
              <SummaryRow label={i18nService.t('wzBnRepostSummaryPace')} value={i18nService.t('wzBnRepostSummaryPaceValue')} />
              <SummaryRow label={i18nService.t('wzBnRepostSummaryPublish')} value={autoPublish ? i18nService.t('wzBnRepostSummaryPublishAuto') : i18nService.t('wzBnRepostSummaryPublishGenOnly')} />
              <SummaryRow label={i18nService.t('wzBnRepostSummaryFrequency')} value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{i18nService.t('wzBnRepostTermsTitle')}</div>
              {[i18nService.t('wzBnRepostTerm1'), i18nService.t('wzBnRepostTerm2')].map((term, i) => (
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
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{i18nService.t('wzBnRepostCancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{i18nService.t('wzBnRepostPrev')}</button>}
        {step < 4 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">{i18nService.t('wzBnRepostNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">{saving ? i18nService.t('wzBnRepostSaving') : (editing ? i18nService.t('wzBnRepostSaveEdit') : i18nService.t('wzBnRepostCreate'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixBinanceRepostWizard;
