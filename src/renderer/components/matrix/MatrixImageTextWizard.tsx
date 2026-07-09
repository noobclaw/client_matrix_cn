/**
 * MatrixImageTextWizard — 矩阵版「图文创作」向导(目前抖音,小红书第二步同款)。
 *
 * 多账号任务:勾选 N 个号,每个号在各自指纹浏览器里按【自己的赛道/人设/关键词】(沿用账号已配身份)
 * + 维度化创意引擎随机文风 → AI 生成各异图文,配图全局二选一(AI 生图 / 按本号关键词搜实景图),
 * 发到各自创作者中心。配图方式/张数/发布全局统一,每号每轮固定 1 篇;参考文案【每号各填一段】可留空(留空按本号身份生成)。
 *
 *   Step 1 — 勾选 N 个账号(多选)
 *   Step 2 — 内容来源二选一:参考文案(每号各填一段,均可留空)/ 选数据源(多选 + 最新几条预览,
 *             运行时每轮从选中源随机挑一条最新内容当选题)
 *   Step 3 — 配图方式 + 张数 + (AI 风格) + 发布方式(每号每轮固定 1 篇)
 *   Step 4 — 运行频率 + 摘要 + 条款
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { fetchImageStyles, FALLBACK_IMAGE_STYLES, ImageStyle } from '../../services/imageStyles';
import MatrixSourcesPreview from './MatrixSourcesPreview';
import { POST_SOURCE_OPTIONS, PostSourceSel, selsFromSourceIds, sourceIdsFromConfig, sourceIdsLabel } from './postSources';

type WizardStep = 1 | 2 | 3 | 4;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };

// AI 生图风格:从 backend /api/image/styles 拉全量目录(~38 个风格·7 大类),失败回退
// FALLBACK_IMAGE_STYLES。风格 id 即后端 orchestrator 认的 key,选中即生效。见组件内 stylesList。

export interface ImageTextWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  // 内容来源二选一:'reference'=各号参考文案(可留空,空则按身份生成,老行为);
  // 'sources'=选数据源(每轮从选中源里随机挑一条最新热点/资讯当选题,AI 围绕它创作)。
  contentSource: 'reference' | 'sources';
  sources: PostSourceSel[];             // 仅 sources 模式:多选数据源
  useRealPhotos: boolean;
  imageCount: number;
  aiImageStyle: string;
  autoPublish: boolean;
  references: Record<string, string>;   // 各号各自参考文案(键=accountId,值可留空);空则该号按身份生成
  // 每号每轮固定 1 篇,不再让用户调篇数。
  imageDownloadAccountId?: string;       // 仅视频号/头条 + 网络图:抖音下图号(用其登录态搜抖音图)
}

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  downloadAccounts?: WizardAccount[];    // 仅视频号/头条 + 网络图:可选的抖音下图号(已登录抖音的号)
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: ImageTextWizardSave) => Promise<void> | void;
}

const MatrixImageTextWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, downloadAccounts, initialTask, onCancel, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);
  // 新增文案内联双语(对齐 FB 向导「不新增 i18n key」惯例;存量文案仍走 i18n)。
  const isZh = i18nService.currentLanguage.startsWith('zh');
  const T = (zh: string, en: string) => (isZh ? zh : en);
  // 视频号/头条本身没图文搜索 → 网络图要借【已登录抖音的号】搜+下图(一个抖音号服务 N 个发布号·串行)。
  const needsDownloadAccount = platform === 'shipinhao' || platform === 'toutiao';
  const dlAccts = downloadAccounts || [];

  // ── 多选账号 ──(默认勾选所有「就绪」号)
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    // 去重:老任务的 accountIds 可能存了重复 id → 计数「已选 2」但列表只有 1 个号(用户实测)。
    if (Array.isArray(initialTask?.accountIds) && initialTask.accountIds.length) return Array.from(new Set(initialTask.accountIds.map(String)));
    return accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id);
  });
  const toggle = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  // 账号加载好后剔除【幽灵 id】(已删除的号残留在 accountIds 里,查不到就不渲染却仍计数 → 计数虚高)。
  //   只在账号真加载完(!loading 且有号)后剪,避免加载中把全部误剪空。
  useEffect(() => {
    if (accountsLoading || !accounts.length) return;
    const live = new Set(accounts.map((a) => a.id));
    setSelectedIds((prev) => { const next = prev.filter((id) => live.has(id)); return next.length === prev.length ? prev : next; });
  }, [accounts, accountsLoading]);

  // ── 图文配置(全局) ──
  const it = initialTask?.imageText || {};
  const [useRealPhotos, setUseRealPhotos] = useState<boolean>(!!it.useRealPhotos);
  const [imageCount, setImageCount] = useState<number>(Math.max(2, Math.min(6, Number(it.imageCount) || (it.useRealPhotos ? 6 : 4))));
  const [aiImageStyle, setAiImageStyle] = useState<string>(it.aiImageStyle || 'ai_auto');
  // 全量风格目录(server-side 单源;拉不到回退兜底列表)。
  const [stylesList, setStylesList] = useState<ImageStyle[]>(FALLBACK_IMAGE_STYLES);
  useEffect(() => { let alive = true; fetchImageStyles().then((r) => { if (alive) setStylesList(r.styles); }); return () => { alive = false; }; }, []);
  const isZhStyle = i18nService.currentLanguage.startsWith('zh');
  const [autoPublish, setAutoPublish] = useState<boolean>(it.autoPublish !== false); // 默认群发
  // 抖音下图号(仅视频号/头条网络图用):默认回填上次选的,否则首个就绪抖音号。
  const [downloadAccountId, setDownloadAccountId] = useState<string>(() => {
    if (it.imageDownloadAccountId) return String(it.imageDownloadAccountId);
    const first = (downloadAccounts || []).find((a) => a.status !== 'banned' && a.status !== 'login_required');
    return first ? first.id : '';
  });
  // 各号各自的参考文案(键=accountId,可留空)。
  const [references, setReferences] = useState<Record<string, string>>(() => {
    const refs = (it.references || {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of Object.keys(refs)) if (typeof refs[k] === 'string') out[k] = refs[k] as string;
    return out;
  });
  const setRef = (id: string, v: string) => setReferences((prev) => ({ ...prev, [id]: v }));
  // 内容来源二选一(老任务无此字段=参考文案模式,行为不变);数据源多选默认微博热搜。
  const [contentSource, setContentSource] = useState<'reference' | 'sources'>(it.contentSource === 'sources' ? 'sources' : 'reference');
  const [sourceIds, setSourceIds] = useState<string[]>(() => sourceIdsFromConfig(it, 'weibo'));
  const toggleSource = (id: string) => setSourceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, useRealPhotos, imageCount, references, contentSource, sourceIds, runInterval]);

  // 网络图模式要求每个选中号都配了关键词(没词没法搜);AI 生图模式不强制。
  const selectedNoKeyword = useMemo(
    () => accounts.filter((a) => selectedIds.includes(a.id) && (!a.keywords || a.keywords.length === 0)),
    [accounts, selectedIds],
  );

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selectedIds.length > 0, reason: i18nService.t('wzImgErrSelectAccount') },
    2: contentSource === 'sources'
      ? { ok: sourceIds.length > 0, reason: T('请至少选择一个数据源', 'Select at least one data source') }
      : { ok: true }, // 参考文案全选填,随时可下一步
    3: useRealPhotos && selectedNoKeyword.length > 0
      ? { ok: false, reason: i18nService.t('wzImgErrNoKeyword').replace('{n}', String(selectedNoKeyword.length)) }
      : (useRealPhotos && needsDownloadAccount && !downloadAccountId)
        ? { ok: false, reason: i18nService.t('wzImgErrNoDownloadAccount').replace('{platform}', platformLabel) }
        : { ok: true },
    4: { ok: allTermsAccepted, reason: i18nService.t('wzImgErrAcceptTerms') },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[4].ok) { setSaveError(canAdvance[4].reason || ''); return; }
    if (selectedIds.length === 0) { setSaveError(canAdvance[1].reason || ''); return; }
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    setSaving(true);
    try {
      // 只保留选中号、非空的参考文案(留空的号不进 map → runner 按身份生成;数据源模式不存参考文案)。
      const refsOut: Record<string, string> = {};
      if (contentSource === 'reference') { for (const id of selectedIds) { const v = (references[id] || '').trim(); if (v) refsOut[id] = v; } }
      await onSave({
        name: initialTask?.name || i18nService.t('wzImgTaskName').replace('{platform}', platformLabel).replace('{n}', String(selectedIds.length)),
        accountIds: selectedIds,
        concurrency: selectedIds.length,
        frequency: runInterval,
        contentSource,
        sources: contentSource === 'sources' ? selsFromSourceIds(sourceIds) : [],
        useRealPhotos,
        imageCount,
        aiImageStyle,
        autoPublish,
        references: refsOut,
        // 仅视频号/头条网络图带上下图号(其它平台/AI生图不需要)。
        imageDownloadAccountId: (useRealPhotos && needsDownloadAccount && downloadAccountId) ? downloadAccountId : undefined,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || i18nService.t('wzImgErrSaveFailed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: i18nService.t('wzImgFreqOnce'), '3h': i18nService.t('wzImgFreq3h'), '6h': i18nService.t('wzImgFreq6h'), daily_random: i18nService.t('wzImgFreqDailyRandomSummary') };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">📝 {editing ? i18nService.t('wzImgTitleEdit').replace('{platform}', platformLabel) : i18nService.t('wzImgTitleCreate').replace('{platform}', platformLabel)}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-emerald-500/40 text-emerald-500 bg-emerald-500/5">{i18nService.t('wzImgStepIndicator').replace('{n}', String(step))}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300">
              📝 {i18nService.t('wzImgStep1Tip').replace('{platform}', platformLabel)}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {i18nService.t('wzImgSelectAccountLabel').replace('{platform}', platformLabel)}<span className="text-xs text-gray-400 font-normal ml-1">· {i18nService.t('wzImgSelectAccountHint').replace('{platform}', platformLabel)}{selectedIds.length ? i18nService.t('wzImgSelectedCount').replace('{n}', String(selectedIds.length)) : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (
                  <div className="p-3 text-center text-xs text-gray-400">{i18nService.t('wzImgAccountsLoading')}</div>
                )}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{i18nService.t('wzImgNoAccounts').replace('{platform}', platformLabel)}</div>
                    <button
                      type="button"
                      onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-emerald-500 hover:bg-emerald-600 active:scale-95"
                    >{i18nService.t('wzImgGoAddAccount')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? i18nService.t('wzImgStateBanned') : a.status === 'login_required' ? i18nService.t('wzImgStateDisconnected') : '';
                  const title = a.nickname || a.displayName;
                  const noKw = !a.keywords || a.keywords.length === 0;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-emerald-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{i18nService.t('wzImgAccountIdLabel').replace('{platform}', PLATFORM_NAME[a.platform || ''] || '')}{a.displayId}</span>}
                          {a.status === 'login_required'
                            ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: a.platform || platform } })); onCancel(); }} title={i18nService.t('wzImgGoLoginTitle')} className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">{i18nService.t('wzImgDisconnectedGoLogin')}</button>
                            : reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
                          {ready && noKw && <span className="text-[11px] text-amber-500 shrink-0">{i18nService.t('wzImgNoKeywordBadge')}</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{i18nService.t('wzImgRemarkLabel')}{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
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
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🧠 {T('内容来源', 'Content source')}<span className="text-xs text-gray-400 font-normal ml-1">· {T('文案从哪来', 'where copy comes from')}</span></label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setContentSource('reference')} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${contentSource === 'reference' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  📄 {T('参考文案', 'Reference copy')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('各号可填一段参考,留空按身份生成', 'Optional per-account reference; empty = by identity')}</div>
                </button>
                <button type="button" onClick={() => setContentSource('sources')} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${contentSource === 'sources' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  📊 {T('选数据源', 'Data sources')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('每轮从热榜/资讯挑最新选题创作', 'Pick fresh topics from trending sources')}</div>
                </button>
              </div>
            </div>

            {contentSource === 'reference' && (
              <>
                <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300">
                  📄 {i18nService.t('wzImgStep2Tip')}
                </div>
                <div className="space-y-2.5">
                  {selectedIds.map((id) => {
                    const a = accounts.find((x) => x.id === id);
                    const title = a?.nickname || a?.displayName || id;
                    return (
                      <div key={id}>
                        <div className="flex items-center gap-1.5 mb-1 text-xs text-gray-600 dark:text-gray-300">
                          {a?.avatar
                            ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-4 h-4 rounded-full object-cover shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                            : <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center text-[9px] font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                          <span className="font-medium truncate">{title}</span>
                          {a?.displayId && <span className="text-gray-400 shrink-0">· {a.displayId}</span>}
                        </div>
                        <textarea value={references[id] || ''} onChange={(e) => setRef(id, e.target.value)} placeholder={i18nService.t('wzImgRefPlaceholder')} rows={2} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 resize-y" disabled={saving} />
                      </div>
                    );
                  })}
                  {selectedIds.length === 0 && <div className="text-xs text-gray-400">{i18nService.t('wzImgNoSelectionBackToStep1')}</div>}
                </div>
              </>
            )}

            {contentSource === 'sources' && (
              <div className="space-y-2.5">
                <div>
                  <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">📊 {T('数据源', 'Data sources')}<span className="text-xs text-gray-400 font-normal ml-1">· {T('可多选,每轮从选中源里随机挑一条最新内容当选题', 'multi-select; each run picks one fresh item as the topic')}{sourceIds.length ? T(` · 已选 ${sourceIds.length} 个`, ` · ${sourceIds.length} selected`) : ''}</span></label>
                  <div className="grid grid-cols-3 gap-2">
                    {POST_SOURCE_OPTIONS.map((s) => (
                      <button key={s.id} type="button" onClick={() => toggleSource(s.id)} className={`px-3 py-2 rounded-lg text-sm border text-left transition-colors ${sourceIds.includes(s.id) ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                        <span className="mr-1">{s.emoji}</span>{isZh ? s.zh : s.en}
                      </button>
                    ))}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-1.5">{T('AI 围绕选题、按各号赛道/人设视角创作,内容互不相同(海外源标题为英文,成稿仍按平台语言)', 'AI writes around the topic from each account’s persona; overseas source titles are English, output follows platform language')}</div>
                </div>
                <MatrixSourcesPreview sourceIds={sourceIds} isZh={isZh} />
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🖼️ {i18nService.t('wzImgImageModeLabel')}<span className="text-xs text-gray-400 font-normal ml-1">· {i18nService.t('wzImgImageModeHint')}</span></label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setUseRealPhotos(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!useRealPhotos ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  🎨 {i18nService.t('wzImgModeAiTitle')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzImgModeAiDesc')}</div>
                </button>
                <button type="button" onClick={() => setUseRealPhotos(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${useRealPhotos ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  🌐 {i18nService.t('wzImgModeWebTitle')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzImgModeWebDesc')}</div>
                </button>
              </div>
              {useRealPhotos && selectedNoKeyword.length > 0 && (
                <div className="text-[11px] text-amber-500 mt-1.5">⚠ {i18nService.t('wzImgWebNoKeywordWarn').replace('{n}', String(selectedNoKeyword.length))}</div>
              )}
              {useRealPhotos && needsDownloadAccount && (
                <div className="mt-3">
                  <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                    🔻 {i18nService.t('wzImgDownloadAccountLabel')}<span className="text-xs text-gray-400 font-normal ml-1">· {i18nService.t('wzImgDownloadAccountHint').replace('{platform}', platformLabel)}</span>
                  </label>
                  {dlAccts.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-700 p-2.5 text-center">
                      <div className="text-xs text-gray-400 mb-1.5">{i18nService.t('wzImgNoDouyinAccount')}</div>
                      <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: 'douyin' } })); onCancel(); }} className="text-[11px] text-emerald-500 underline decoration-dotted hover:text-emerald-400">{i18nService.t('wzImgGoAddDouyin')}</button>
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-48 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                      {dlAccts.map((a) => {
                        const ready = a.status !== 'banned' && a.status !== 'login_required';
                        const reason = a.status === 'banned' ? i18nService.t('wzImgStateBanned') : a.status === 'login_required' ? i18nService.t('wzImgStateDisconnected') : '';
                        const title = a.nickname || a.displayName;
                        return (
                          <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                            <input type="radio" name="mx-it-dlacct" checked={downloadAccountId === a.id} onChange={() => ready && setDownloadAccountId(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-emerald-500 shrink-0" />
                            {a.avatar
                              ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                              : <span className="w-7 h-7 rounded-full bg-emerald-500/20 text-emerald-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">{i18nService.t('wzImgDouyinBadge')}</span>
                                <span className="font-medium truncate dark:text-white">{title}</span>
                                {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{i18nService.t('wzImgDouyinIdLabel')}{a.displayId}</span>}
                                {a.status === 'login_required'
                                  ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: 'douyin' } })); onCancel(); }} title={i18nService.t('wzImgGoLoginDouyinTitle')} className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">{i18nService.t('wzImgDisconnectedGoLogin')}</button>
                                  : reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
                              </div>
                              <div className="text-[11px] text-gray-400 truncate">{i18nService.t('wzImgRemarkLabel')}{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {!useRealPhotos && (
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🎨 {i18nService.t('wzImgAiStyleLabel')}</label>
                <select value={aiImageStyle} onChange={(e) => setAiImageStyle(e.target.value)} disabled={saving} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40">
                  {stylesList.map((opt) => <option key={opt.id} value={opt.id}>{opt.icon} {isZhStyle ? opt.zh : opt.en} — {isZhStyle ? opt.desc_zh : opt.desc_en}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{i18nService.t('wzImgImageCountLabel')} <span className="text-emerald-500 font-bold">{imageCount}</span><span className="text-xs text-gray-400 font-normal ml-2">· {i18nService.t('wzImgImageCountHint')}</span></label>
              <input type="range" min={2} max={6} value={imageCount} onChange={(e) => setImageCount(Number(e.target.value))} disabled={saving} className="w-full accent-emerald-500" />
              <div className="flex justify-between text-[10px] text-gray-400"><span>2</span><span>6</span></div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">📤 {i18nService.t('wzImgAfterGenLabel')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${autoPublish ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  🚀 {i18nService.t('wzImgPublishTitle')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzImgPublishDesc')}</div>
                </button>
                <button type="button" onClick={() => setAutoPublish(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!autoPublish ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  💾 {i18nService.t('wzImgLocalTitle')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{i18nService.t('wzImgLocalDesc')}</div>
                </button>
              </div>
            </div>

          </>
        )}

        {step === 4 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">⏰ {i18nService.t('wzImgFreqLabel')}</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', i18nService.t('wzImgFreqOnce')], ['3h', i18nService.t('wzImgFreq3h')], ['6h', i18nService.t('wzImgFreq6h')], ['daily_random', i18nService.t('wzImgFreqDailyRandom')]].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 {i18nService.t('wzImgSummaryTitle')}</div>
              <SummaryRow label={i18nService.t('wzImgSummaryAccounts')} value={i18nService.t('wzImgSummaryAccountsVal').replace('{n}', String(selectedIds.length))} />
              <SummaryRow label={i18nService.t('wzImgSummaryImage')} value={useRealPhotos ? i18nService.t('wzImgSummaryImageWeb').replace('{n}', String(imageCount)) : i18nService.t('wzImgSummaryImageAi').replace('{n}', String(imageCount)).replace('{style}', (() => { const s = stylesList.find((x) => x.id === aiImageStyle); return s ? (isZhStyle ? s.zh : s.en) : aiImageStyle; })())} />
              <SummaryRow label={i18nService.t('wzImgSummaryCount')} value={i18nService.t('wzImgSummaryCountVal').replace('{n}', String(selectedIds.length))} />
              <SummaryRow label={i18nService.t('wzImgSummaryPublish')} value={autoPublish ? i18nService.t('wzImgSummaryPublishAuto') : i18nService.t('wzImgSummaryPublishLocal')} />
              {contentSource === 'sources'
                ? <SummaryRow label={T('数据源', 'Sources')} value={sourceIdsLabel(sourceIds, isZh)} />
                : <SummaryRow label={i18nService.t('wzImgSummaryRef')} value={i18nService.t('wzImgSummaryRefVal').replace('{filled}', String(selectedIds.filter((id) => (references[id] || '').trim()).length)).replace('{total}', String(selectedIds.length))} />}
              <SummaryRow label={i18nService.t('wzImgSummaryFreq')} value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{i18nService.t('wzImgTermsTitle')}</div>
              {[i18nService.t('wzImgTerm1'), i18nService.t('wzImgTerm2')].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-emerald-500 shrink-0" />
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
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{i18nService.t('wzImgCancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{i18nService.t('wzImgPrev')}</button>}
        {step < 4 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">{i18nService.t('wzImgNext')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">{saving ? i18nService.t('wzImgSaving') : (editing ? i18nService.t('wzImgSaveEdit') : i18nService.t('wzImgCreateTask'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixImageTextWizard;
