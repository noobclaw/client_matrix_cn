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

type WizardStep = 1 | 2 | 3 | 4;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };

// 来源平台按【搬运形态】给:图文→小红书;视频→TikTok(须 VPN)。其余敬请期待。
type SrcOpt = { id: 'xhs' | 'douyin' | 'tiktok' | 'x'; label: string; enabled: boolean };
const SOURCE_BY_MATERIAL: Record<'image' | 'video', SrcOpt[]> = {
  image: [
    { id: 'xhs', label: '小红书', enabled: true },
    { id: 'x', label: 'X', enabled: false },
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
  keyword: string;
  material: 'image' | 'video';
  withImage: boolean;
  language: 'zh' | 'en' | 'mixed';
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
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (Array.isArray(initialTask?.accountIds) && initialTask.accountIds.length) return initialTask.accountIds.map(String);
    return accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id);
  });
  const toggle = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const br = initialTask?.binanceRepost || {};
  const [sourcePlatform, setSourcePlatform] = useState<'xhs' | 'douyin' | 'tiktok' | 'x'>(br.sourcePlatform || 'xhs');
  const [sourceAccountId, setSourceAccountId] = useState<string>(br.sourceAccountId || '');
  const [keyword, setKeyword] = useState<string>(br.keyword || '');
  const [material, setMaterial] = useState<'image' | 'video'>(br.material || 'image');
  const [withImage, setWithImage] = useState<boolean>(br.withImage !== false);
  const [language, setLanguage] = useState<'zh' | 'en' | 'mixed'>(br.language || 'mixed');
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
  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, sourcePlatform, sourceAccountId, keyword, withImage, language, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selectedIds.length > 0, reason: isZh ? '请至少勾选一个已登录币安账号' : 'Select at least one account' },
    2: { ok: !!sourceAccountId, reason: isZh ? '请选择一个采集号(源平台上已登录的号)' : 'Pick a source account' },
    3: { ok: true },
    4: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[4].ok) { setSaveError(canAdvance[4].reason || ''); return; }
    if (selectedIds.length === 0) { setSaveError(canAdvance[1].reason || ''); return; }
    if (!sourceAccountId) { setSaveError(canAdvance[2].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || `币安广场批量搬运 · ${PLATFORM_NAME[sourcePlatform]}→币安 · ${selectedIds.length} 个号`,
        accountIds: selectedIds,
        concurrency: 1,
        frequency: runInterval,
        sourcePlatform,
        sourceAccountId,
        keyword: keyword.trim(),
        material,
        withImage,
        language,
        autoPublish,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败' : 'Save failed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: '不重复（手动触发）', '3h': '每 3 小时', '6h': '每 6 小时', daily_random: '每日随机时间一次' };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  const langLabel = (l: string) => (l === 'zh' ? '中文' : l === 'en' ? 'English' : '随账号语言(默认中文)');
  const srcAcc = sourceCandidates.find((a) => a.id === sourceAccountId);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">♻️ {editing ? '编辑币安广场搬运任务' : '配置币安广场批量搬运'}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-amber-500/40 text-amber-500 bg-amber-500/5">第 {step} / 4 步</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300">
              ♻️ 勾选多个已登录的{platformLabel}发布号。下一步再选 1 个源平台采集号:它按关键词搜+下素材,采够后每个币安号<strong>各领一条独立仿写</strong>发出去(两号不撞同源、文案各不同)。
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                选 {platformLabel} 发布号<span className="text-xs text-gray-400 font-normal ml-1">· 已登录即可{selectedIds.length ? `;已选 ${selectedIds.length}` : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (<div className="p-3 text-center text-xs text-gray-400">账号加载中…</div>)}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">该平台还没有账号。先去「我的矩阵账号」添加并扫码登录{platformLabel}。</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-amber-500 hover:bg-amber-600 active:scale-95">👥 去「我的矩阵账号」添加 →</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? '已封' : a.status === 'login_required' ? '未连接' : '';
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
                        <div className="text-[11px] text-gray-400 truncate">备注:{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
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
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🎞️ 搬运形态<span className="text-xs text-gray-400 font-normal ml-1">· 先选形态,下面来源平台跟着变</span></label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => { setMaterial('image'); setSourcePlatform(firstEnabledSource('image')); setSourceAccountId(''); }} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${material === 'image' ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  🖼️ 图文<div className="text-[11px] text-gray-400 font-normal mt-0.5">小红书源图 + 仿写正文 → 币安图文帖</div>
                </button>
                <button type="button" onClick={() => { setMaterial('video'); setSourcePlatform(firstEnabledSource('video')); setSourceAccountId(''); }} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${material === 'video' ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  🎬 视频<div className="text-[11px] text-gray-400 font-normal mt-0.5">抖音 / TikTok 无水印源视频 + 仿写配文 → 币安视频帖(TikTok 须VPN)</div>
                </button>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🌐 来源平台<span className="text-xs text-gray-400 font-normal ml-1">· {material === 'image' ? '图文源:小红书(X 敬请期待)' : '视频源:抖音 / TikTok'}</span></label>
              <div className="flex gap-2 flex-wrap">
                {SOURCE_BY_MATERIAL[material].map((sp) => (
                  <button key={sp.id} type="button" disabled={!sp.enabled} onClick={() => { if (sp.enabled) { setSourcePlatform(sp.id); setSourceAccountId(''); } }} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${sourcePlatform === sp.id ? 'border-amber-500 bg-amber-500/10 text-amber-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'} ${!sp.enabled ? 'opacity-40 cursor-not-allowed' : ''}`}>{sp.label}{!sp.enabled ? '(敬请期待)' : ''}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🧺 采集号<span className="text-xs text-gray-400 font-normal ml-1">· 选 1 个{PLATFORM_NAME[sourcePlatform]}上已登录的号(它负责搜+下素材)</span></label>
              <div className="space-y-1.5 max-h-48 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {sourceCandidates.length === 0 && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">没有{PLATFORM_NAME[sourcePlatform]}账号。先去「我的矩阵账号」添加并登录一个{PLATFORM_NAME[sourcePlatform]}号当采集号。</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: sourcePlatform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-amber-500 hover:bg-amber-600 active:scale-95">👥 去添加{PLATFORM_NAME[sourcePlatform]}号 →</button>
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
                          {!ready && <span className="text-[11px] text-amber-500 shrink-0">{a.status === 'banned' ? '已封' : '未连接'}</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">备注:{a.displayName}{a.group ? ` · ${a.group}` : ''}{Array.isArray(a.keywords) && a.keywords.length > 0 ? ` · 关键词:${a.keywords.join('、')}` : ''}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🔍 搜索关键词<span className="text-xs text-gray-400 font-normal ml-1">· 空则用采集号自己的关键词</span></label>
              <input type="text" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={srcAcc && Array.isArray(srcAcc.keywords) && srcAcc.keywords.length ? `留空则用:${srcAcc.keywords[0]}` : '例:比特币、链上数据、DeFi'} className="w-full px-3 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 dark:text-white focus:border-amber-500 outline-none" />
            </div>

          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🌐 仿写语言</label>
              <div className="flex gap-2 flex-wrap">
                {(['mixed', 'zh', 'en'] as const).map((l) => (
                  <button key={l} type="button" onClick={() => setLanguage(l)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${language === l ? 'border-amber-500 bg-amber-500/10 text-amber-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>{langLabel(l)}</button>
                ))}
              </div>
            </div>
            {material === 'image' && (
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🖼️ 配图</label>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setWithImage(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${withImage ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                    🎨 配源图<div className="text-[11px] text-gray-400 font-normal mt-0.5">用采集号下好的源图(贴合内容、零生图成本)</div>
                  </button>
                  <button type="button" onClick={() => setWithImage(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!withImage ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                    📝 纯文字<div className="text-[11px] text-gray-400 font-normal mt-0.5">只发仿写正文,不配图</div>
                  </button>
                </div>
              </div>
            )}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">📤 生成后</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${autoPublish ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  🚀 直接群发<div className="text-[11px] text-gray-400 font-normal mt-0.5">各号仿写后自动发到币安广场</div>
                </button>
                <button type="button" onClick={() => setAutoPublish(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!autoPublish ? 'border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>
                  💾 仅生成不发<div className="text-[11px] text-gray-400 font-normal mt-0.5">只生成正文(日志里看),不自动发布</div>
                </button>
              </div>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">⏰ 运行频率</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', '不重复（手动触发）'], ['3h', '每 3 小时'], ['6h', '每 6 小时'], ['daily_random', '每日随机时间']].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-amber-500 bg-amber-500/10 text-amber-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 任务摘要</div>
              <SummaryRow label="来源" value={`${PLATFORM_NAME[sourcePlatform]} · 采集号 ${srcAcc ? (srcAcc.nickname || srcAcc.displayName) : '(未选)'}`} />
              <SummaryRow label="关键词" value={keyword.trim() || '(用采集号关键词)'} />
              <SummaryRow label="形态" value={material === 'image' ? '图文(源图+仿写)' : '视频'} />
              <SummaryRow label="发布号" value={`${selectedIds.length} 个币安号,各领一条独立仿写`} />
              <SummaryRow label="语言" value={langLabel(language)} />
              <SummaryRow label="配图" value={material === 'video' ? '视频帖(自带画面)' : (withImage ? '配源图' : '纯文字')} />
              <SummaryRow label="节奏" value="每号顺序发,相邻两条间隔 1-2 分钟" />
              <SummaryRow label="发布" value={autoPublish ? '直接群发到币安广场' : '仅生成不发'} />
              <SummaryRow label="运行频率" value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">使用条款</div>
              {['我理解 NoobClaw 会在我本地用采集号搜集素材、用各币安号专属指纹浏览器代我仿写并发布', '我理解搬运内容的版权/合规与平台账号风险由我自己承担'].map((term, i) => (
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
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">取消</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">← 上一步</button>}
        {step < 4 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">下一步 →</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">{saving ? '保存中...' : (editing ? '✓ 保存修改' : '♻️ 创建任务')}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixBinanceRepostWizard;
