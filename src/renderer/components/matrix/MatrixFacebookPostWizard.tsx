/**
 * MatrixFacebookPostWizard — 矩阵版「Facebook 自动发帖」向导。
 *
 * 多账号任务:勾选 N 个号,每个号在各自指纹浏览器里按【自己的人设】,从你选的【数据源】取材 →
 * AI 深度创作一条 Facebook 图文(可选配图)→ 发到各自 Facebook。每号每轮 1 条,内容互不相同。
 *
 *   Step 1 — 勾选 N 个账号(多选)
 *   Step 2 — 数据源 + 写作语言 + 配图 + 发布方式
 *   Step 3 — 运行频率 + 摘要 + 条款
 *
 * 与 binance_post 的差异:Facebook 不是 web3 专场 → Step 2 增加【数据源选择】(Web3 资讯 / 科技 / 各热榜),
 * 复用模板速生的热榜清单。文案内联双语(不新增 i18n key)。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { POST_LANGS, postLangLabel } from './postLangs';
import { POST_SOURCE_OPTIONS, PostSourceSel, selsFromSourceIds, sourceIdsFromConfig, sourceIdsLabel } from './postSources';

type WizardStep = 1 | 2 | 3;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

export interface FacebookPostWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  withImage: boolean;
  language: string;
  autoPublish: boolean;
  // 多选数据源(运行时每轮随机挑 1 个取题);旧单选字段同步写第一个选中源,兼容未更新的生产 orchestrator。
  sources: PostSourceSel[];
  sourceTrackMatch: boolean;   // 仅账号赛道相关(默认开)
  sourceKind: 'news' | 'category' | 'hot';
  source?: string;
  catKey?: string;
}

// 数据源清单抽到 postSources.ts 共享(hot 的 source 名必须与后端 /api/web3/hot-search 一致)。
const SOURCE_OPTIONS = POST_SOURCE_OPTIONS;

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: FacebookPostWizardSave) => Promise<void> | void;
}

const MatrixFacebookPostWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const T = (zh: string, en: string) => (isZh ? zh : en);
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

  const fp = initialTask?.facebookPost || {};
  // 多选:新任务默认 Web3;老任务(单选字段)映射成单元素数组。
  const [sourceIds, setSourceIds] = useState<string[]>(() => sourceIdsFromConfig(fp, 'web3'));
  const toggleSource = (id: string) => setSourceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const [sourceTrackMatch, setSourceTrackMatch] = useState<boolean>(fp.sourceTrackMatch !== false); // 默认开:仅账号赛道相关
  const [withImage, setWithImage] = useState<boolean>(fp.withImage !== false);
  const [language, setLanguage] = useState<string>(fp.language || 'mixed');
  const [autoPublish, setAutoPublish] = useState<boolean>(fp.autoPublish !== false);

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selSources = selsFromSourceIds(sourceIds);
  const firstSource = selSources[0] || { kind: 'news' as const };
  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selectedIds.length > 0, reason: T('请至少选择一个账号', 'Select at least one account') },
    2: { ok: sourceIds.length > 0, reason: T('请至少选择一个数据源', 'Select at least one data source') },
    3: { ok: allTermsAccepted, reason: T('请勾选同意条款', 'Please accept the terms') },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    if (selectedIds.length === 0) { setSaveError(canAdvance[1].reason || ''); return; }
    if (!canAdvance[2].ok) { setStep(2); setSaveError(canAdvance[2].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || T(`Facebook 发帖 · ${selectedIds.length} 个号`, `Facebook Post · ${selectedIds.length} accts`),
        accountIds: selectedIds,
        concurrency: selectedIds.length,
        frequency: runInterval,
        withImage, language, autoPublish,
        sources: selSources,
        sourceTrackMatch,
        // 旧单选字段 = 第一个选中源(生产 orchestrator 未更新前照跑)。
        sourceKind: firstSource.kind,
        source: firstSource.source,
        catKey: firstSource.catKey,
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || T('保存失败', 'Save failed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: T('仅一次', 'Once'), '3h': T('每 3 小时', 'Every 3h'), '6h': T('每 6 小时', 'Every 6h'), daily_random: T('每天随机一次', 'Daily (random)') };
    return m[runInterval] || runInterval;
  }, [runInterval, isZh]);

  const langLabel = (l: string) => postLangLabel(l, isZh);
  const btn = (active: boolean) => `px-2.5 py-1 rounded-md text-xs border transition-colors ${active ? 'border-blue-500 bg-blue-500/10 text-blue-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-blue-500/50'}`;
  const bigBtn = (active: boolean) => `px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${active ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-blue-500/50'}`;

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">👥 {editing ? T('编辑 · Facebook 自动发帖', 'Edit · Facebook Auto Post') : T('新建 · Facebook 自动发帖', 'New · Facebook Auto Post')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-blue-500/40 text-blue-500 bg-blue-500/5">{T(`第 ${step} / 3 步`, `Step ${step} / 3`)}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300">
              👥 {T('勾选已登录的 Facebook 账号,每号按自己的人设从所选数据源取材,AI 原创一条帖子并发布(须挂 VPN)。', 'Pick logged-in Facebook accounts; each posts one AI-original post from the chosen data source (VPN required).')}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {T('选择账号', 'Select accounts')}<span className="text-xs text-gray-400 font-normal ml-1">{selectedIds.length ? T(`已选 ${selectedIds.length} 个`, `${selectedIds.length} selected`) : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (<div className="p-3 text-center text-xs text-gray-400">{T('加载账号中…', 'Loading accounts…')}</div>)}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{T('还没有已登录的 Facebook 账号', 'No logged-in Facebook accounts yet')}</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-blue-500 hover:bg-blue-600 active:scale-95">{T('去添加账号', 'Add account')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? T('已封禁', 'Banned') : a.status === 'login_required' ? T('登录已断开', 'Disconnected') : '';
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-blue-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-blue-500/20 text-blue-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">{platformLabel}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">@{a.displayId}</span>}
                          {reason ? <span className="text-[11px] text-blue-500 shrink-0">{reason}</span> : null}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{T('备注:', 'Note: ')}{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
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
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{T('数据源', 'Data source')}<span className="text-xs text-gray-400 font-normal ml-1">{T('可多选,每轮从选中源里随机挑一个取题', 'multi-select; each run picks one at random')}{sourceIds.length ? T(` · 已选 ${sourceIds.length} 个`, ` · ${sourceIds.length} selected`) : ''}</span></label>
              <div className="grid grid-cols-3 gap-2">
                {SOURCE_OPTIONS.map((s) => (
                  <button key={s.id} type="button" onClick={() => toggleSource(s.id)} className={bigBtn(sourceIds.includes(s.id))}>
                    <span className="mr-1">{s.emoji}</span>{isZh ? s.zh : s.en}
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-gray-400 mt-1.5">{T('Web3=深度资讯(带摘要+原图);其余为热榜/分类标题当选题(海外源须英文号 + VPN)', 'Web3 = deep news (summary + image); others use trending titles as topics (overseas sources need EN account + VPN)')}</div>
              <label className="flex items-start gap-2 mt-2.5 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                <input type="checkbox" checked={sourceTrackMatch} onChange={(e) => setSourceTrackMatch(e.target.checked)} className="mt-0.5 h-4 w-4 accent-blue-500 shrink-0" />
                <span className="leading-relaxed">{T('仅选用与账号赛道相关的内容', 'Only topics matching each account’s niche')}<span className="text-gray-400 font-normal">{T('(每个号只从自己赛道的热点/资讯里取题;某轮无相关则按赛道自由创作)', ' (each account picks topics from its own niche; falls back to free creation when none match)')}</span></span>
              </label>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{T('写作语言', 'Language')}</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40">
                {POST_LANGS.map((l) => <option key={l.code} value={l.code}>{isZh ? l.zh : l.en}</option>)}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{T('配图', 'Image')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setWithImage(false)} className={bigBtn(!withImage)}>{T('纯文字', 'Text only')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('不配图,发得快', 'No image, faster')}</div></button>
                <button type="button" onClick={() => setWithImage(true)} className={bigBtn(withImage)}>{T('配图', 'With image')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('源图优先,无则 AI 生图', 'Source thumb first, else AI-gen')}</div></button>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{T('发布方式', 'After generation')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={bigBtn(autoPublish)}>{T('自动发布', 'Auto-publish')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('生成后直接发到 Facebook', 'Post to Facebook directly')}</div></button>
                <button type="button" onClick={() => setAutoPublish(false)} className={bigBtn(!autoPublish)}>{T('仅生成', 'Draft only')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('只存本地,不发布', 'Save locally, no publish')}</div></button>
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{T('运行频率', 'Frequency')}</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', T('仅一次', 'Once')], ['3h', T('每 3 小时', 'Every 3h')], ['6h', T('每 6 小时', 'Every 6h')], ['daily_random', T('每天随机', 'Daily random')]].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={btn(runInterval === value)}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">{T('确认', 'Summary')}</div>
              <SummaryRow label={T('账号', 'Accounts')} value={T(`${selectedIds.length} 个`, `${selectedIds.length}`)} />
              <SummaryRow label={T('数据源', 'Source')} value={sourceIdsLabel(sourceIds, isZh)} />
              <SummaryRow label={T('语言', 'Language')} value={langLabel(language)} />
              <SummaryRow label={T('配图', 'Image')} value={withImage ? T('配图', 'Yes') : T('纯文字', 'No')} />
              <SummaryRow label={T('发布', 'Publish')} value={autoPublish ? T('自动发布', 'Auto') : T('仅生成', 'Draft')} />
              <SummaryRow label={T('频率', 'Frequency')} value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{T('使用须知', 'Terms')}</div>
              {[T('我已知悉自动发帖有平台风控风险,由我自行承担。', 'I understand auto-posting carries platform risk, borne by me.'), T('内容由 AI 生成,我会对发布内容负责。', 'Content is AI-generated; I am responsible for what is posted.')].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-blue-500 shrink-0" />
                  <span className="leading-relaxed">{term}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {saveError && (<div className="px-6 pt-2 pb-1 shrink-0"><div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">❌ {saveError}</div></div>)}

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{T('取消', 'Cancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{T('上一步', 'Back')}</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50">{T('下一步', 'Next')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50">{saving ? T('保存中…', 'Saving…') : (editing ? T('保存修改', 'Save') : T('创建任务', 'Create'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixFacebookPostWizard;
