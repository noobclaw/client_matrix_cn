/**
 * MatrixImageTextWizard — 矩阵版「图文创作」向导(目前抖音,小红书第二步同款)。
 *
 * 多账号任务:勾选 N 个号,每个号在各自指纹浏览器里按【自己的赛道/人设/关键词】(沿用账号已配身份)
 * + 维度化创意引擎随机文风 → AI 生成各异图文,配图全局二选一(AI 生图 / 按本号关键词搜实景图),
 * 发到各自创作者中心。配图方式/张数/篇数/发布全局统一;参考文案可选(填了应用到所有选中号,留空按身份生成)。
 *
 *   Step 1 — 勾选 N 个账号(多选)
 *   Step 2 — 配图方式 + 张数 + 每号篇数 + (AI 风格) + 发布方式 + (可选)参考文案
 *   Step 3 — 运行频率 + 摘要 + 条款
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

type WizardStep = 1 | 2 | 3;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };

// AI 生图风格(对齐 backend imageStyles 的常用 key;未知值后端回落通用风格,不会报错)。
const AI_STYLES: { value: string; label: string }[] = [
  { value: 'ai_auto', label: '自动(按内容选)' },
  { value: 'text_card', label: '文字卡片' },
  { value: 'minimalist', label: '极简' },
  { value: 'photographic', label: '写实摄影' },
  { value: 'illustration', label: '插画' },
];

export interface ImageTextWizardSave {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  useRealPhotos: boolean;
  imageCount: number;
  aiImageStyle: string;
  autoPublish: boolean;
  references: Record<string, string>;   // 各号各自参考文案(键=accountId,值可留空);空则该号按身份生成
  // 每号每轮固定 1 篇,不再让用户调篇数。
}

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onSave: (input: ImageTextWizardSave) => Promise<void> | void;
}

const MatrixImageTextWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  // ── 多选账号 ──(默认勾选所有「就绪」号)
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    if (Array.isArray(initialTask?.accountIds) && initialTask.accountIds.length) return initialTask.accountIds.map(String);
    return accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id);
  });
  const toggle = (id: string) => setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // ── 图文配置(全局) ──
  const it = initialTask?.imageText || {};
  const [useRealPhotos, setUseRealPhotos] = useState<boolean>(!!it.useRealPhotos);
  const [imageCount, setImageCount] = useState<number>(Math.max(2, Math.min(6, Number(it.imageCount) || (it.useRealPhotos ? 6 : 4))));
  const [aiImageStyle, setAiImageStyle] = useState<string>(it.aiImageStyle || 'ai_auto');
  const [autoPublish, setAutoPublish] = useState<boolean>(it.autoPublish !== false); // 默认群发
  // 各号各自的参考文案(键=accountId,可留空)。
  const [references, setReferences] = useState<Record<string, string>>(() => {
    const refs = (it.references || {}) as Record<string, unknown>;
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

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selectedIds, useRealPhotos, imageCount, references, runInterval]);

  // 网络图模式要求每个选中号都配了关键词(没词没法搜);AI 生图模式不强制。
  const selectedNoKeyword = useMemo(
    () => accounts.filter((a) => selectedIds.includes(a.id) && (!a.keywords || a.keywords.length === 0)),
    [accounts, selectedIds],
  );

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selectedIds.length > 0, reason: isZh ? '请至少勾选一个已登录账号' : 'Select at least one account' },
    2: useRealPhotos && selectedNoKeyword.length > 0
      ? { ok: false, reason: `网络图模式需要每个号都配关键词,有 ${selectedNoKeyword.length} 个号未配(到「我的矩阵账号」编辑里加)` }
      : { ok: true },
    3: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    if (selectedIds.length === 0) { setSaveError(canAdvance[1].reason || ''); return; }
    if (!canAdvance[2].ok) { setSaveError(canAdvance[2].reason || ''); return; }
    setSaving(true);
    try {
      // 只保留选中号、非空的参考文案(留空的号不进 map → runner 按身份生成)。
      const refsOut: Record<string, string> = {};
      for (const id of selectedIds) { const v = (references[id] || '').trim(); if (v) refsOut[id] = v; }
      await onSave({
        name: initialTask?.name || `${platformLabel}图文创作 · ${selectedIds.length} 个号`,
        accountIds: selectedIds,
        concurrency: selectedIds.length,
        frequency: runInterval,
        useRealPhotos,
        imageCount,
        aiImageStyle,
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

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">📝 {editing ? `编辑${platformLabel}图文创作任务` : `配置${platformLabel}图文创作`}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-emerald-500/40 text-emerald-500 bg-emerald-500/5">第 {step} / 3 步</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300">
              📝 勾选多个已登录的{platformLabel}账号。每个号在各自指纹浏览器里按<strong>自己的赛道/人设/关键词</strong>(在「我的矩阵账号」里给每个号设)+ 随机文风,AI 生成<strong>各不相同</strong>的图文,自动配图并发到各自创作者中心。选几个号就同时开几个窗。
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
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-emerald-500 hover:bg-emerald-600 active:scale-95"
                    >👥 去「我的矩阵账号」添加 →</button>
                  </div>
                )}
                {accounts.map((a) => {
                  const ready = a.status !== 'login_required' && a.status !== 'banned';
                  const reason = a.status === 'banned' ? '已封' : a.status === 'login_required' ? '未连接' : '';
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
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{PLATFORM_NAME[a.platform || ''] || ''}号:{a.displayId}</span>}
                          {reason && <span className="text-[11px] text-amber-500 shrink-0">{reason}</span>}
                          {ready && noKw && <span className="text-[11px] text-amber-500 shrink-0">未配关键词</span>}
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
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">🖼️ 配图方式<span className="text-xs text-gray-400 font-normal ml-1">· 全局统一,每个号各自找图</span></label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setUseRealPhotos(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!useRealPhotos ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  🎨 AI 生图<div className="text-[11px] text-gray-400 font-normal mt-0.5">每张独立生成,每号天然不同;质量稳、可控,成本较高</div>
                </button>
                <button type="button" onClick={() => setUseRealPhotos(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${useRealPhotos ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  🌐 网络图<div className="text-[11px] text-gray-400 font-normal mt-0.5">按本号关键词去抖音「图文」搜实景图(各号词不同→不撞图);近免费</div>
                </button>
              </div>
              {useRealPhotos && selectedNoKeyword.length > 0 && (
                <div className="text-[11px] text-amber-500 mt-1.5">⚠ 有 {selectedNoKeyword.length} 个选中号没配关键词,网络图模式下它们会被跳过</div>
              )}
            </div>

            {!useRealPhotos && (
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">🎨 AI 生图风格</label>
                <select value={aiImageStyle} onChange={(e) => setAiImageStyle(e.target.value)} disabled={saving} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40">
                  {AI_STYLES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">每篇配图张数 <span className="text-emerald-500 font-bold">{imageCount}</span><span className="text-xs text-gray-400 font-normal ml-2">· 每个号每次运行生成 1 篇</span></label>
              <input type="range" min={2} max={6} value={imageCount} onChange={(e) => setImageCount(Number(e.target.value))} disabled={saving} className="w-full accent-emerald-500" />
              <div className="flex justify-between text-[10px] text-gray-400"><span>2</span><span>6</span></div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">📤 生成后</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAutoPublish(true)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${autoPublish ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  🚀 直接群发<div className="text-[11px] text-gray-400 font-normal mt-0.5">各号生成后自动发布到创作者中心</div>
                </button>
                <button type="button" onClick={() => setAutoPublish(false)} className={`px-3 py-2.5 rounded-lg text-sm border text-left transition-colors ${!autoPublish ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>
                  💾 仅本地<div className="text-[11px] text-gray-400 font-normal mt-0.5">只生成存本地,你审核后手动发</div>
                </button>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">📄 参考文案<span className="text-xs text-gray-400 font-normal ml-1">· 给每个号各填一段(均可留空);填了该号参考它创作,留空则该号按自己的赛道/人设/关键词生成</span></label>
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
                      <textarea value={references[id] || ''} onChange={(e) => setRef(id, e.target.value)} placeholder="(选填)给本号粘一段灵感/范文,留空则按本号赛道/人设/关键词生成" rows={2} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 resize-y" disabled={saving} />
                    </div>
                  );
                })}
                {selectedIds.length === 0 && <div className="text-xs text-gray-400">请先在第 1 步勾选账号</div>}
              </div>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">⏰ 运行频率</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', '不重复（手动触发）'], ['3h', '每 3 小时'], ['6h', '每 6 小时'], ['daily_random', '每日随机时间']].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-emerald-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 任务摘要</div>
              <SummaryRow label="账号" value={`${selectedIds.length} 个(各自身份+随机文风,内容互不相同)`} />
              <SummaryRow label="配图" value={useRealPhotos ? `网络图,每篇 ${imageCount} 张(按本号关键词搜)` : `AI 生图,每篇 ${imageCount} 张(${AI_STYLES.find((s) => s.value === aiImageStyle)?.label || aiImageStyle})`} />
              <SummaryRow label="数量" value={`每号每轮 1 篇,共 ${selectedIds.length} 篇/轮`} />
              <SummaryRow label="发布" value={autoPublish ? '直接群发到各号创作者中心' : '仅本地保存(手动审核后发)'} />
              <SummaryRow label="参考文案" value={`${selectedIds.filter((id) => (references[id] || '').trim()).length}/${selectedIds.length} 个号已填(其余按身份生成)`} />
              <SummaryRow label="运行频率" value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">使用条款</div>
              {['我理解 NoobClaw 会在我本地用各账号专属指纹浏览器代我生成图文并发布', '我理解内容合规与平台账号风险由我自己承担'].map((term, i) => (
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
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">取消</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">← 上一步</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">下一步 →</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">{saving ? '保存中...' : (editing ? '✓ 保存修改' : '📝 创建任务')}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixImageTextWizard;
