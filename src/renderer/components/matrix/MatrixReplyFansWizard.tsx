/**
 * MatrixReplyFansWizard — 矩阵版「抖音 · 自动回复粉丝评论」向导。
 *
 * 由老客户端 XhsReplyFansCommentWizard(引流语 + 概率 + 频率 + 条款)迁移而来,
 * 唯一区别 = 把「控制 1 个账号」改成「勾选多个已登录账号」(账号勾选段照搬
 * MatrixTaskWizard 的 Step 1)。reply_fan 没有配额(回复对象是粉丝评论本身,不按
 * 关键词搜),所以没有点赞/关注/评论滑条。
 *
 *   Step 1 — 勾选多个抖音账号(各号在自己的指纹浏览器创作者中心评论管理里回复)
 *   Step 2 — 核心引流语(选填)+ 引流尾巴出现概率
 *   Step 3 — 运行间隔 + 摘要 + 条款
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

type WizardStep = 1 | 2 | 3;

const FUNNEL_PHRASE_MAX = 200;
const FUNNEL_PROB_MIN = 1;
const FUNNEL_PROB_MAX = 100;
const FUNNEL_PROB_DEFAULT = 50;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

// 平台 id → 中文名(账号行里标出来)。
const PLATFORM_NAME: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: 'X', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };

interface Props {
  platformLabel: string;
  platform?: string;                       // 平台 id(用于「无账号」引导跳到对应 tab)
  accounts: WizardAccount[];               // 可选账号(已登录)
  accountsLoading?: boolean;
  initialTask?: any | null;                // 编辑时传入矩阵任务
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; funnel: { funnel_phrase: string; funnel_probability: number } }) => Promise<void> | void;
}

const MatrixReplyFansWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onSave }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  // 平台相关文案。小红书是唯一「逐篇笔记进详情页」的流程,其余短视频平台在各自创作者中心
  // 「评论管理」集中回复。创作者中心中文名 + 作品/笔记 量词按平台切。
  const isXhs = platform === 'xhs';
  const ccNameZh = platform === 'kuaishou' ? '快手创作者服务平台'
    : platform === 'bilibili' ? '哔哩哔哩创作中心'
    : platform === 'xhs' ? '小红书创作者中心'
    : platform === 'shipinhao' ? '视频号助手'
    : platform === 'toutiao' ? '头条号后台'
    : '抖音创作者中心';
  const itemZh = isXhs ? '笔记' : '作品';

  // ── 账号(回复粉丝评论不需要关键词,只要已登录创作者中心) ──
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialTask?.accountIds) return new Set(initialTask.accountIds);
    return new Set(accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required').map((a) => a.id));
  });
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ── 引流语 + 概率 ──
  const [funnelPhrase, setFunnelPhrase] = useState<string>(String(initialTask?.funnel?.funnel_phrase || ''));
  const hasFunnel = funnelPhrase.trim().length > 0;
  const [funnelProb, setFunnelProb] = useState<number>(
    typeof initialTask?.funnel?.funnel_probability === 'number'
      ? Math.max(FUNNEL_PROB_MIN, Math.min(FUNNEL_PROB_MAX, initialTask.funnel.funnel_probability))
      : FUNNEL_PROB_DEFAULT
  );

  // ── 调度(对齐矩阵 MatrixTaskFrequency:回复评论用 once/3h/6h/每日随机) ──
  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');

  // ── 条款 ──
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selected, funnelPhrase, funnelProb, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size >= 1, reason: isZh ? '请至少勾选一个已登录账号' : 'Select at least one account' },
    2: { ok: true },
    3: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: initialTask?.name || `${platformLabel}回复粉丝 · ${selected.size}号`,
        accountIds: [...selected],
        concurrency: selected.size,
        frequency: runInterval,
        funnel: { funnel_phrase: funnelPhrase.trim(), funnel_probability: hasFunnel ? funnelProb : 0 },
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
        <div className="text-base font-semibold dark:text-white">💌 {editing ? `编辑${platformLabel}回复粉丝任务` : `配置${platformLabel}自动回复粉丝`}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-fuchsia-500/40 text-fuchsia-500 bg-fuchsia-500/5">第 {step} / 3 步</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-fuchsia-500/30 bg-fuchsia-500/5 text-fuchsia-700 dark:text-fuchsia-300">
              💌 每个勾选的账号会在<strong>自己的指纹浏览器</strong>里打开<strong>{ccNameZh}</strong>{isXhs ? <>,逐篇笔记进详情页</> : <>评论管理</>},逐条读粉丝评论 → AI 写回应 → 真人节奏发送。<strong>已回复过的、自己留的评论自动跳过</strong>,只回复粉丝、绝不评论{itemZh}本身。回复口吻按各账号设的<strong>人设</strong>。
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                选 {platformLabel} 账号<span className="text-xs text-gray-400 font-normal ml-1">· 已登录{ccNameZh}即可(无需配关键词);已选 {selected.size}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && accountsLoading && (
                  <div className="p-3 text-center text-xs text-gray-400">账号加载中…</div>
                )}
                {accounts.length === 0 && !accountsLoading && (
                  <div className="p-3 text-center space-y-2.5">
                    <div className="text-xs text-gray-400">该平台还没有账号。先去「我的矩阵账号」添加并扫码登录{ccNameZh}。</div>
                    <button
                      type="button"
                      onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }}
                      className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-fuchsia-500 hover:bg-fuchsia-600 active:scale-95"
                    >👥 去「我的矩阵账号」添加 →</button>
                  </div>
                )}
                {accounts.map((a) => {
                  // 回复粉丝只要已登录(未封、未掉线)即可,不要求关键词。
                  const linked = a.status !== 'login_required' && a.status !== 'banned';
                  const ready = linked;
                  const reason = a.status === 'banned' ? '已封' : a.status === 'login_required' ? '未连接' : '';
                  const title = a.nickname || a.displayName;
                  return (
                    <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-fuchsia-500 shrink-0" />
                      {a.avatar
                        ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        : <span className="w-7 h-7 rounded-full bg-fuchsia-500/20 text-fuchsia-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-500">{PLATFORM_NAME[a.platform || ''] || a.platform}</span>
                          <span className="font-medium truncate dark:text-white">{title}</span>
                          {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{PLATFORM_NAME[a.platform || ''] || ''}号:{a.displayId}</span>}
                          {reason && <span className="text-[11px] text-amber-500 shrink-0">{reason}</span>}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">
                          备注:{a.displayName}{a.group ? ` · ${a.group}` : ''}
                        </div>
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
            {/* 引流语 textarea */}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                🎣 核心引流语（选填）<span className="text-xs text-gray-400 font-normal ml-1">· 留空则回复不带引流尾巴</span>
              </label>
              <textarea
                value={funnelPhrase}
                onChange={(e) => setFunnelPhrase(e.target.value.slice(0, FUNNEL_PHRASE_MAX))}
                placeholder={'比如：完整教程在我主页置顶视频，需要的可以去看\n或：私信我领西湖路线攻略'}
                rows={3}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-y min-h-[80px]"
                disabled={saving}
              />
              <div className="text-[11px] text-gray-400 mt-1">{funnelPhrase.trim().length} / {FUNNEL_PHRASE_MAX} 字</div>
            </div>

            {/* 引流概率 slider */}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                🎲 引流尾巴出现概率: {hasFunnel ? funnelProb : 0}%
                <span className="text-xs text-gray-400 font-normal ml-1">
                  {hasFunnel ? '· AI 会按概率把引流语自然衔接到回复尾部' : '· 引流语未填,概率失效'}
                </span>
              </label>
              <input
                type="range"
                min={FUNNEL_PROB_MIN}
                max={FUNNEL_PROB_MAX}
                value={funnelProb}
                onChange={(e) => setFunnelProb(parseInt(e.target.value, 10))}
                disabled={saving || !hasFunnel}
                className="w-full accent-fuchsia-500 disabled:opacity-40"
              />
            </div>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
              <div className="font-semibold">⚠️ 安全提示</div>
              <ul className="list-disc list-inside space-y-0.5">
                <li>只回复粉丝评论,绝不给{itemZh}本身发新评论;已回复 / 自己的评论自动跳过</li>
                <li>多开账号务必每号配独立 IP(在「我的矩阵账号」里设),否则同 IP 易被风控</li>
              </ul>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">⏰ 运行间隔</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', '不重复（手动触发）'], ['3h', '每 3 小时'], ['6h', '每 6 小时'], ['daily_random', '每日随机时间']].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-fuchsia-500/50'}`}>{label}</button>
                ))}
              </div>
              {runInterval === 'daily_random' && <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">✨ 推荐 — 每天在随机时间触发一次,比固定钟点更像真人。</p>}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 任务摘要</div>
              <SummaryRow label="账号" value={`${selected.size} 个(各自回复自己${itemZh}下的粉丝评论)`} />
              <SummaryRow label="引流语" value={hasFunnel ? `"${funnelPhrase.trim().slice(0, 40)}${funnelPhrase.trim().length > 40 ? '...' : ''}" · ${funnelProb}%` : '（未填,纯 AI 回复）'} />
              <SummaryRow label="回复范围" value={`逐条回复全部粉丝评论（最近 30 ${isXhs ? '篇笔记' : '个作品'}）`} />
              <SummaryRow label="同时开窗" value={`${selected.size} 个号一起跑`} />
              <SummaryRow label="运行频率" value={intervalLabel} />
              <SummaryRow label="安全节奏" value={isXhs ? '评论间 30~90s · 笔记间 2~5min' : '评论间 30~90s · 作品间 45~150s'} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">使用条款</div>
              {[`我理解 NoobClaw 会在我本地用各账号专属指纹浏览器代我打开${ccNameZh},所有行为使用各账号自己的 IP 和账号`, '我理解平台账号风险由我自己承担'].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-fuchsia-500 shrink-0" />
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
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-fuchsia-500 text-white hover:bg-fuchsia-600 disabled:opacity-50">下一步 →</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-fuchsia-500 text-white hover:bg-fuchsia-600 disabled:opacity-50">{saving ? '保存中...' : (editing ? '✓ 保存修改' : '💌 创建任务')}</button>
        )}
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixReplyFansWizard;
