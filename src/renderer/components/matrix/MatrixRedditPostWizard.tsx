/**
 * MatrixRedditPostWizard — 矩阵版「Reddit 自动发帖」向导。
 *
 * 多账号:勾选 N 个号,每号按人设,内容来源二选一(参考文案 / 数据源)→ AI 原创一条帖(标题+正文)→
 * Reddit API 发到指定 subreddit(留空发个人主页)。无配图(Reddit self/文字帖)。文案内联双语。
 *
 *   Step 1 — 勾选账号
 *   Step 2 — 内容来源二选一(参考文案 / 数据源 + 仅账号赛道相关)
 *   Step 3 — 目标 subreddit + 写作语言 + 发布方式
 *   Step 4 — 频率 + 摘要 + 条款
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { POST_LANGS, postLangLabel } from './postLangs';
import { POST_SOURCE_OPTIONS, PostSourceSel, selsFromSourceIds, sourceIdsFromConfig, sourceIdsLabel } from './postSources';

type WizardStep = 1 | 2 | 3 | 4;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

export interface RedditPostWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  language: string;
  autoPublish: boolean;
  // 内容来源二选一:'reference'=参考文案(按身份+可选参考文案自由创作);'sources'=数据源选题。
  contentSource: 'reference' | 'sources';
  references: Record<string, string>;   // 仅 reference 模式:各号各自参考文案(可留空)
  // 多选数据源(运行时每轮随机挑 1 个取题);旧单选字段同步写第一个选中源,兼容未更新的生产 orchestrator。
  sources: PostSourceSel[];
  sourceTrackMatch: boolean;   // 仅账号赛道相关(默认开)
  sourceKind: 'news' | 'category' | 'hot';
  source?: string;
  catKey?: string;
  subreddit: string;
}

// Reddit 面向海外受众,只放海外源在前的子集(清单本体共享自 postSources.ts)。
const REDDIT_SOURCE_IDS = ['web3', 'tech', 'hackernews', 'reddit', 'googletrends', 'youtube', 'weibo', 'zhihu'];
const SOURCE_OPTIONS = REDDIT_SOURCE_IDS
  .map((id) => POST_SOURCE_OPTIONS.find((s) => s.id === id))
  .filter((s): s is NonNullable<typeof s> => !!s);

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: RedditPostWizardSave) => Promise<void> | void;
}

const MatrixRedditPostWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
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

  const rp = initialTask?.redditPost || {};
  // 内容来源二选一(老任务无 contentSource=数据源模式,行为不变)。
  const [contentSource, setContentSource] = useState<'reference' | 'sources'>(rp.contentSource === 'reference' ? 'reference' : 'sources');
  // 多选:新任务默认 Web3;老任务(单选字段)映射成单元素数组。
  const [sourceIds, setSourceIds] = useState<string[]>(() => sourceIdsFromConfig(rp, 'web3'));
  const toggleSource = (id: string) => setSourceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const [sourceTrackMatch, setSourceTrackMatch] = useState<boolean>(rp.sourceTrackMatch !== false); // 默认开:仅账号赛道相关
  const [subreddit, setSubreddit] = useState<string>(String(rp.subreddit || '').replace(/^\/?r\//i, ''));
  const [language, setLanguage] = useState<string>(rp.language || 'mixed');
  const [autoPublish, setAutoPublish] = useState<boolean>(rp.autoPublish !== false);
  // 各号各自的参考文案(键=accountId,可留空)。
  const [references, setReferences] = useState<Record<string, string>>(() => {
    const refs = (rp.references || {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of Object.keys(refs)) if (typeof refs[k] === 'string') out[k] = refs[k] as string;
    return out;
  });
  const setRef = (id: string, v: string) => setReferences((prev) => ({ ...prev, [id]: v }));

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, contentSource, sourceIds, references, subreddit, language, runInterval]);

  const selSources = selsFromSourceIds(sourceIds);
  const firstSource = selSources[0] || { kind: 'news' as const };
  // subreddit 选填(2026-07-06 用户要求):留空 = 发到账号自己的个人主页(u_用户名,无版块门槛);填了才校验格式。
  const subTrim = subreddit.trim();
  const subOk = subTrim === '' || /^[A-Za-z0-9_]{2,21}$/.test(subTrim);
  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selectedIds.length > 0, reason: T('请至少选择一个账号', 'Select at least one account') },
    2: contentSource === 'sources'
      ? { ok: sourceIds.length > 0, reason: T('请至少选择一个数据源', 'Select at least one data source') }
      : { ok: true },
    3: !subOk
      ? { ok: false, reason: T('subreddit 格式不对(2-21 位字母数字下划线,不带 r/;留空=发自己主页)', 'Invalid subreddit (2-21 chars, no r/; empty = own profile)') }
      : { ok: true },
    4: { ok: allTermsAccepted, reason: T('请勾选同意条款', 'Please accept the terms') },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[2].ok) { setStep(2); setSaveError(canAdvance[2].reason || ''); return; }
    if (!canAdvance[3].ok) { setStep(3); setSaveError(canAdvance[3].reason || ''); return; }
    if (!canAdvance[4].ok) { setSaveError(canAdvance[4].reason || ''); return; }
    if (selectedIds.length === 0) { setSaveError(canAdvance[1].reason || ''); return; }
    setSaving(true);
    try {
      const refsOut: Record<string, string> = {};
      if (contentSource === 'reference') { for (const id of selectedIds) { const v = (references[id] || '').trim(); if (v) refsOut[id] = v; } }
      await onSave({
        name: initialTask?.name || T(`Reddit 发帖 · ${subTrim ? `r/${subTrim}` : '个人主页'}`, `Reddit Post · ${subTrim ? `r/${subTrim}` : 'Profile'}`),
        accountIds: selectedIds, concurrency: selectedIds.length, frequency: runInterval,
        language, autoPublish,
        contentSource,
        references: refsOut,
        sources: contentSource === 'sources' ? selSources : [],
        sourceTrackMatch,
        // 旧单选字段 = 第一个选中源(生产 orchestrator 未更新前照跑)。
        sourceKind: firstSource.kind, source: firstSource.source, catKey: firstSource.catKey,
        subreddit: subTrim,
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
  const btn = (active: boolean) => `px-2.5 py-1 rounded-md text-xs border transition-colors ${active ? 'border-orange-500 bg-orange-500/10 text-orange-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-orange-500/50'}`;
  const bigBtn = (active: boolean) => `px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${active ? 'border-orange-500 bg-orange-500/10 text-orange-600 dark:text-orange-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-orange-500/50'}`;

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🟠 {editing ? T('编辑 · Reddit 自动发帖', 'Edit · Reddit Auto Post') : T('新建 · Reddit 自动发帖', 'New · Reddit Auto Post')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-orange-500/40 text-orange-500 bg-orange-500/5">{T(`第 ${step} / 4 步`, `Step ${step} / 4`)}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-orange-500/30 bg-orange-500/5 text-orange-700 dark:text-orange-300">
              🟠 {T('勾选已登录的 Reddit 账号,每号按人设 AI 原创一条帖发到你指定的 subreddit(须挂 VPN,账号需满足该版发帖门槛)。', 'Pick logged-in Reddit accounts; each posts one AI-original post to your target subreddit (VPN required; account must meet the subreddit rules).')}
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {T('选择账号', 'Select accounts')}<span className="text-xs text-gray-400 font-normal ml-1">{selectedIds.length ? T(`已选 ${selectedIds.length} 个`, `${selectedIds.length} selected`) : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (<div className="p-3 text-center text-xs text-gray-400">{T('加载账号中…', 'Loading accounts…')}</div>)}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">{T('还没有已登录的 Reddit 账号', 'No logged-in Reddit accounts yet')}</div>
                    <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-orange-500 hover:bg-orange-600 active:scale-95">{T('去添加账号', 'Add account')}</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? T('已封禁', 'Banned') : a.status === 'login_required' ? T('登录已断开', 'Disconnected') : '';
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-orange-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-500">{platformLabel}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{a.displayId}</span>}
                          {reason ? <span className="text-[11px] text-orange-500 shrink-0">{reason}</span> : null}
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
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🧠 {T('内容来源', 'Content source')}<span className="text-xs text-gray-400 font-normal ml-1">· {T('文案从哪来', 'where copy comes from')}</span></label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setContentSource('reference')} className={bigBtn(contentSource === 'reference')}>
                  📄 {T('参考文案', 'Reference copy')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('各号可填一段参考,留空按身份创作', 'Optional per-account reference; empty = by identity')}</div>
                </button>
                <button type="button" onClick={() => setContentSource('sources')} className={bigBtn(contentSource === 'sources')}>
                  📊 {T('选数据源', 'Data sources')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('每轮从热榜/资讯挑最新选题创作', 'Pick fresh topics from trending sources')}</div>
                </button>
              </div>
            </div>

            {contentSource === 'reference' && (
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">📄 {T('各号参考文案', 'Per-account reference')}<span className="text-xs text-gray-400 font-normal ml-1">· {T('可留空,留空则该号按自己身份自由创作', 'optional; empty = free creation by identity')}</span></label>
                <div className="space-y-2.5 max-h-80 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                  {selectedIds.map((id) => {
                    const a = accounts.find((x) => x.id === id);
                    const title = a?.nickname || a?.displayName || id;
                    return (
                      <div key={id}>
                        <div className="flex items-center gap-1.5 mb-1 text-xs text-gray-600 dark:text-gray-300">
                          {a?.avatar
                            ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-4 h-4 rounded-full object-cover shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                            : <span className="w-4 h-4 rounded-full bg-orange-500/20 text-orange-500 flex items-center justify-center text-[9px] font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                          <span className="font-medium truncate">{title}</span>
                          {a?.displayId && <span className="text-gray-400 shrink-0">{a.displayId}</span>}
                        </div>
                        <textarea value={references[id] || ''} onChange={(e) => setRef(id, e.target.value)} placeholder={T('可粘贴一段参考文案/主题/要点,AI 会参考它的主题与风格原创(不照抄)。留空则按本号身份自由创作。', 'Paste a reference/topic/notes; AI writes around its theme & style (no copy). Empty = free creation by identity.')} rows={2} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500/40 resize-y" disabled={saving} />
                      </div>
                    );
                  })}
                  {selectedIds.length === 0 && <div className="text-xs text-gray-400">{T('请先在上一步选择账号', 'Select accounts in the previous step first')}</div>}
                </div>
              </div>
            )}

            {contentSource === 'sources' && (
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{T('数据源', 'Data source')}<span className="text-xs text-gray-400 font-normal ml-1">{T('可多选,每轮从选中源里随机挑一个取题', 'multi-select; each run picks one at random')}{sourceIds.length ? T(` · 已选 ${sourceIds.length} 个`, ` · ${sourceIds.length} selected`) : ''}</span></label>
                <div className="grid grid-cols-3 gap-2">
                  {SOURCE_OPTIONS.map((s) => (<button key={s.id} type="button" onClick={() => toggleSource(s.id)} className={bigBtn(sourceIds.includes(s.id))}><span className="mr-1">{s.emoji}</span>{isZh ? s.zh : s.en}</button>))}
                </div>
                <div className="mt-2.5">
                  <button type="button" onClick={() => setSourceTrackMatch(!sourceTrackMatch)} aria-pressed={sourceTrackMatch} disabled={saving}
                    className={`w-full px-4 py-3 rounded-xl border text-left transition-colors flex items-start gap-3 disabled:opacity-50 ${sourceTrackMatch ? 'border-orange-400 bg-gradient-to-r from-orange-500/15 to-orange-500/5 text-orange-700 dark:text-orange-300 shadow-sm' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-orange-400/60'}`}>
                    <span className={`shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-sm transition-colors ${sourceTrackMatch ? 'bg-orange-500 text-white' : 'border-2 border-gray-400 dark:border-gray-600'}`}>{sourceTrackMatch ? '✓' : ''}</span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-semibold">🎯 {T('仅选用账号赛道相关内容', 'Only niche-relevant topics')}{sourceTrackMatch && <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500 text-white font-bold tracking-wide">{T('已开', 'ON')}</span>}</span>
                      <span className="block text-[11px] text-gray-500 dark:text-gray-400 font-normal mt-0.5">{T('勾选此项,则 AI 会从数据源中筛选符合每个矩阵号赛道的热点进行选题创作', "When on, AI filters the data sources for topics matching each account's niche")}</span>
                    </span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{T('目标 subreddit', 'Target subreddit')}<span className="text-xs text-gray-400 font-normal ml-1">{T('选填,留空发自己主页', 'optional; empty = own profile')}</span></label>
              <div className="flex items-center gap-2">
                <span className="text-gray-400 text-sm">r/</span>
                <input value={subreddit} onChange={(e) => setSubreddit(e.target.value.replace(/^\/?r\//i, '').trim())} placeholder={T('例如 technology', 'e.g. technology')} className={`flex-1 px-3 py-2 rounded-lg text-sm bg-white dark:bg-gray-800 border ${subreddit && !subOk ? 'border-red-500' : 'border-gray-300 dark:border-gray-700'} dark:text-white focus:outline-none focus:border-orange-500`} />
              </div>
              <div className="text-[11px] text-gray-400 mt-1">{T('填了发到该版块(账号需满足其发帖门槛 karma/账号年龄/需先加入);留空发到账号自己的个人主页(u/用户名),无门槛但曝光主要来自粉丝。', "If set, posts to that subreddit (account must meet its rules); if empty, posts to the account's own profile (no gate, reach is mostly followers).")}</div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{T('写作语言', 'Language')}</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-orange-500/40">
                {POST_LANGS.map((l) => <option key={l.code} value={l.code}>{isZh ? l.zh : l.en}</option>)}
              </select>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{T('发布方式', 'After generation')}</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={bigBtn(autoPublish)}>{T('自动发布', 'Auto-publish')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('生成后直接发到 subreddit', 'Post to the subreddit')}</div></button>
                <button type="button" onClick={() => setAutoPublish(false)} className={bigBtn(!autoPublish)}>{T('仅生成', 'Draft only')}<div className="text-[11px] text-gray-400 font-normal mt-0.5">{T('只存本地,不发布', 'Save locally, no publish')}</div></button>
              </div>
            </div>
          </>
        )}

        {step === 4 && (
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
              <SummaryRow label={'subreddit'} value={subTrim ? `r/${subTrim}` : T('个人主页', 'Own profile')} />
              <SummaryRow label={T('内容来源', 'Source')} value={contentSource === 'reference'
                ? T(`参考文案(${selectedIds.filter((id) => (references[id] || '').trim()).length}/${selectedIds.length} 已填)`, `Reference (${selectedIds.filter((id) => (references[id] || '').trim()).length}/${selectedIds.length} filled)`)
                : sourceIdsLabel(sourceIds, isZh)} />
              <SummaryRow label={T('语言', 'Language')} value={langLabel(language)} />
              <SummaryRow label={T('发布', 'Publish')} value={autoPublish ? T('自动发布', 'Auto') : T('仅生成', 'Draft')} />
              <SummaryRow label={T('频率', 'Frequency')} value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{T('使用须知', 'Terms')}</div>
              {[T('我已知悉自动发帖有平台风控/封号风险,由我自行承担。', 'I understand auto-posting carries platform/ban risk, borne by me.'), T('内容由 AI 生成,我会对发布内容与所选 subreddit 规则负责。', 'Content is AI-generated; I am responsible for it and the subreddit rules.')].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-orange-500 shrink-0" />
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
        {step < 4 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50">{T('下一步', 'Next')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50">{saving ? T('保存中…', 'Saving…') : (editing ? T('保存修改', 'Save') : T('创建任务', 'Create'))}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixRedditPostWizard;
