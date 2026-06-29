/**
 * MatrixTweetPostWizard — 矩阵版「自动发推」向导(目前仅推特 X)。
 *
 * 多账号任务:勾选 N 个号,每个号在各自指纹浏览器里按【自己的人设/赛道/关键词】(沿用账号已配身份)
 * AI 原创一条推文,可选 AI 配图,发到各自时间线。每号每轮固定 1 条,内容互不相同。
 *   内容来源二选一:web3 资讯深度创作(抓近 3 周热点 → 紧贴资讯原创)/ 按账号身份自由创作。
 *
 *   Step 1 — 勾选 N 个账号(多选)
 *   Step 2 — 内容来源 + 各号参考文案(free 模式各号独立一段,独立滚动区;web3 模式无参考文案)
 *   Step 3 — 写作语言 + 配图 + 蓝V + 生成后(发布方式)
 *   Step 4 — 运行频率 + 摘要 + 条款
 *
 *   参考文案拆成独立一步(不与其它设置同屏),账号多时也不挤。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

type WizardStep = 1 | 2 | 3 | 4;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };

export interface TweetPostWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  mode: 'web3' | 'free';
  withImage: boolean;
  language: 'zh' | 'en' | 'mixed';
  isBlueV: boolean;
  autoPublish: boolean;
  references: Record<string, string>;   // 各号各自参考文案(仅 free 模式;可留空)
}

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: TweetPostWizardSave) => Promise<void> | void;
}

const MatrixTweetPostWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  // ── 多选账号 ──(默认勾选所有「就绪」号)
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (Array.isArray(initialTask?.accountIds) && initialTask.accountIds.length) return initialTask.accountIds.map(String);
    return accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id);
  });
  const toggle = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // ── 发推配置(全局) ──
  const tp = initialTask?.tweetPost || {};
  const [mode, setMode] = useState<'web3' | 'free'>(tp.mode === 'free' ? 'free' : 'web3');
  const [withImage, setWithImage] = useState<boolean>(tp.withImage !== false); // 默认配图开
  const [language, setLanguage] = useState<'zh' | 'en' | 'mixed'>(tp.language || 'mixed');
  const [isBlueV, setIsBlueV] = useState<boolean>(!!tp.isBlueV);
  const [autoPublish, setAutoPublish] = useState<boolean>(tp.autoPublish !== false); // 默认群发
  // 各号各自的参考文案(键=accountId,可留空)。
  const [references, setReferences] = useState<Record<string, string>>(() => {
    const refs = (tp.references || {}) as Record<string, unknown>;
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

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, mode, withImage, language, references, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selectedIds.length > 0, reason: isZh ? '请至少勾选一个已登录账号' : 'Select at least one account' },
    2: { ok: true },
    3: { ok: true },
    4: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[4].ok) { setSaveError(canAdvance[4].reason || ''); return; }
    if (selectedIds.length === 0) { setSaveError(canAdvance[1].reason || ''); return; }
    setSaving(true);
    try {
      // 只保留选中号、非空的参考文案(web3 模式不传参考文案)。
      const refsOut: Record<string, string> = {};
      if (mode === 'free') { for (const id of selectedIds) { const v = (references[id] || '').trim(); if (v) refsOut[id] = v; } }
      await onSave({
        name: initialTask?.name || `推特自动发推 · ${selectedIds.length} 个号`,
        accountIds: selectedIds,
        concurrency: selectedIds.length,
        frequency: runInterval,
        mode,
        withImage,
        language,
        isBlueV,
        autoPublish,
        references: refsOut,
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

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🐦 {editing ? '编辑推特自动发推任务' : '配置推特自动发推'}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-sky-500/40 text-sky-500 bg-sky-500/5">第 {step} / 4 步</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300">
              🐦 勾选多个已登录的{platformLabel}账号。每个号在各自指纹浏览器里按<strong>自己的人设/赛道/关键词</strong>(在「我的矩阵账号」里给每个号设),AI 原创<strong>各不相同</strong>的推文,可选配图后发到各自时间线。选几个号就同时开几个窗。
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                选 {platformLabel} 账号<span className="text-xs text-gray-400 font-normal ml-1">· 已登录{platformLabel}即可{selectedIds.length ? `;已选 ${selectedIds.length}` : ''}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (
                  <div className="p-3 text-center text-xs text-gray-400">账号加载中…</div>
                )}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">该平台还没有账号。先去「我的矩阵账号」添加并扫码登录{platformLabel}。</div>
                    <button
                      type="button"
                      onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-sky-500 hover:bg-sky-600 active:scale-95"
                    >👥 去「我的矩阵账号」添加 →</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? '已封' : a.status === 'login_required' ? '未连接' : '';
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selectedIds.includes(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-sky-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-sky-500/20 text-sky-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">@{a.displayId}</span>}
                          {a.status === 'login_required'
                            ? <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform: a.platform || platform } })); onCancel(); }} title="去「我的矩阵账号」扫码登录这个号" className="text-[11px] text-amber-500 underline decoration-dotted hover:text-amber-400 shrink-0">未连接 · 去登录 →</button>
                            : reason ? <span className="text-[11px] text-amber-500 shrink-0">{reason}</span> : null}
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
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🧠 内容来源<span className="text-xs text-gray-400 font-normal ml-1">· 决定 AI 写什么</span></label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setMode('web3')} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${mode === 'web3' ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>
                  📰 web3 资讯深度创作<div className="text-[11px] text-gray-400 font-normal mt-0.5">抓近 3 周 web3 热点资讯,紧贴事实原创快评。适合加密 / 链上 KOL 号。</div>
                </button>
                <button type="button" onClick={() => setMode('free')} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${mode === 'free' ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>
                  ✍️ 按账号身份自由创作<div className="text-[11px] text-gray-400 font-normal mt-0.5">按每个号的人设/赛道/关键词自由原创。适合任意赛道,可给每号填参考文案。</div>
                </button>
              </div>
            </div>

            {mode === 'free' && (
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">📄 各号参考文案<span className="text-xs text-gray-400 font-normal ml-1">· 均可留空,留空则按本号身份生成</span></label>
                <div className="space-y-2.5 max-h-80 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                  {selectedIds.map((id) => {
                    const a = accounts.find((x) => x.id === id);
                    const title = a?.nickname || a?.displayName || id;
                    return (
                      <div key={id}>
                        <div className="flex items-center gap-1.5 mb-1 text-xs text-gray-600 dark:text-gray-300">
                          <span className="font-medium truncate">{title}</span>
                          {a?.displayId && <span className="text-gray-400 shrink-0">@{a.displayId}</span>}
                        </div>
                        <textarea value={references[id] || ''} onChange={(e) => setRef(id, e.target.value)} placeholder="(选填)给本号粘一段灵感/范文,留空则按本号人设/赛道/关键词生成" rows={2} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40 resize-y" disabled={saving} />
                      </div>
                    );
                  })}
                  {selectedIds.length === 0 && <div className="text-xs text-gray-400">请先返回第 1 步勾选账号</div>}
                </div>
              </div>
            )}

            {mode === 'web3' && (
              <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-sky-500/20 bg-sky-500/5 text-sky-700 dark:text-sky-300">
                📰 web3 资讯模式按热点资讯原创,<strong>无需参考文案</strong>;直接「下一步」设置语言 / 配图 / 发布即可。
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🌐 写作语言</label>
              <div className="flex gap-2 flex-wrap">
                {(['mixed', 'zh', 'en'] as const).map((l) => (
                  <button key={l} type="button" onClick={() => setLanguage(l)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${language === l ? 'border-sky-500 bg-sky-500/10 text-sky-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>{langLabel(l)}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🖼️ 配图</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setWithImage(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!withImage ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>
                  📝 纯文字<div className="text-[11px] text-gray-400 font-normal mt-0.5">只发文字推,最快、零配图成本</div>
                </button>
                <button type="button" onClick={() => setWithImage(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${withImage ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>
                  🎨 配图<div className="text-[11px] text-gray-400 font-normal mt-0.5">更吸睛。web3 资讯优先用原文自带图,无图才 AI 生图(走生图 token)</div>
                </button>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">👑 账号类型 <span className="text-[11px] text-gray-400 font-normal">决定每条推文的字数上限</span></label>
              <button
                type="button"
                onClick={() => setIsBlueV(!isBlueV)}
                disabled={saving}
                aria-pressed={isBlueV}
                className={`w-full px-4 py-3 rounded-xl border text-left transition-colors flex items-center gap-3 disabled:opacity-50 ${
                  isBlueV
                    ? 'border-amber-400 bg-gradient-to-r from-amber-500/15 to-sky-500/10 text-amber-700 dark:text-amber-300 shadow-sm'
                    : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-amber-400/60'
                }`}
              >
                <span className={`shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-sm transition-colors ${isBlueV ? 'bg-amber-400 text-white' : 'border-2 border-gray-400 dark:border-gray-600'}`}>{isBlueV ? '✓' : ''}</span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    🔵 蓝V (X Premium) 账号
                    {isBlueV && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400 text-white font-bold tracking-wide">已开启</span>}
                  </span>
                  <span className="block text-[11px] text-gray-400 font-normal mt-0.5">
                    {isBlueV ? '✅ 字数自由,可发长推(长文)' : '默认普通号:每条 ≤140 字。若你这个号是蓝V会员,点亮可发长推'}
                  </span>
                </span>
              </button>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">📤 生成后</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${autoPublish ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>
                  🚀 直接群发<div className="text-[11px] text-gray-400 font-normal mt-0.5">各号生成后自动发到时间线</div>
                </button>
                <button type="button" onClick={() => setAutoPublish(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!autoPublish ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>
                  💾 仅生成不发<div className="text-[11px] text-gray-400 font-normal mt-0.5">只生成正文(在日志里看),不自动发布</div>
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
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-sky-500 bg-sky-500/10 text-sky-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-sky-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 任务摘要</div>
              <SummaryRow label="账号" value={`${selectedIds.length} 个(各自身份,内容互不相同)`} />
              <SummaryRow label="内容来源" value={mode === 'web3' ? 'web3 资讯深度创作' : '按账号身份自由创作'} />
              <SummaryRow label="语言" value={langLabel(language)} />
              <SummaryRow label="账号类型" value={isBlueV ? '蓝V(长推,字数自由)' : '普通号(≤140 字)'} />
              <SummaryRow label="配图" value={withImage ? 'AI 配图' : '纯文字'} />
              <SummaryRow label="数量" value={`每号每轮 1 条,共 ${selectedIds.length} 条/轮`} />
              <SummaryRow label="发布" value={autoPublish ? '直接群发到各号时间线' : '仅生成不发(日志里看)'} />
              {mode === 'free' && <SummaryRow label="参考文案" value={`${selectedIds.filter((id) => (references[id] || '').trim()).length}/${selectedIds.length} 个号已填`} />}
              <SummaryRow label="运行频率" value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">使用条款</div>
              {['我理解 NoobClaw 会在我本地用各账号专属指纹浏览器代我生成并发布推文', '我理解内容合规与平台账号风险由我自己承担'].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-sky-500 shrink-0" />
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
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50">下一步 →</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-sky-500 text-white hover:bg-sky-600 disabled:opacity-50">{saving ? '保存中...' : (editing ? '✓ 保存修改' : '🐦 创建任务')}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixTweetPostWizard;
