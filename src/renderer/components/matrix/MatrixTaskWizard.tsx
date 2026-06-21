/**
 * MatrixTaskWizard — 直接照搬老客户端 DouyinConfigWizard 的样式/结构(violet 3-step
 * 向导 + RangeSlider 滑条 + 摘要卡 + 条款),只改两处:
 *   Step 1:赛道/关键词 → 「勾选多个已登录账号」(矩阵号:赛道/关键词/人设在各账号上设)
 *   onSave:走矩阵 saveTask(accountIds + 配额 + 频率 + 同时开窗)
 * 跟老客户端唯一区别就是「控制 1 个账号 vs 多个账号」。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';

const LIKE_HARDCAP = 500;
const FOLLOW_HARDCAP = 100;
const COMMENT_HARDCAP = 100;

type WizardStep = 1 | 2 | 3;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string }
interface Props {
  platformLabel: string;
  accounts: WizardAccount[];               // 可选账号(已登录 + 配了关键词)
  initialTask?: any | null;                // 编辑时传入矩阵任务
  onCancel: () => void;
  onSave: (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; quota: any }) => Promise<void> | void;
}

const MatrixTaskWizard: React.FC<Props> = ({ platformLabel, accounts, initialTask, onCancel, onSave }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  const [name, setName] = useState<string>(initialTask?.name || `${platformLabel}互动`);
  // 默认勾选所有「可用」账号(配了关键词 + 未封);编辑时用任务已存的账号。
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (initialTask?.accountIds) return new Set(initialTask.accountIds);
    return new Set(accounts.filter((a) => a.keywords && a.keywords.length && a.status !== 'banned').map((a) => a.id));
  });
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const q = initialTask?.quota || {};
  const [likeMin, setLikeMinRaw] = useState<number>(typeof q.daily_like_min === 'number' ? q.daily_like_min : 3);
  const [likeMax, setLikeMaxRaw] = useState<number>(typeof q.daily_like_max === 'number' ? q.daily_like_max : 8);
  const setLikeMin = (v: number) => { const n = Math.max(0, Math.min(LIKE_HARDCAP, v)); setLikeMinRaw(n); setLikeMaxRaw((p) => (p < n ? n : p)); };
  const setLikeMax = (v: number) => { const n = Math.max(0, Math.min(LIKE_HARDCAP, v)); setLikeMaxRaw(n); setLikeMinRaw((p) => (p > n ? n : p)); };
  const [folMin, setFolMinRaw] = useState<number>(typeof q.daily_follow_min === 'number' ? q.daily_follow_min : 0);
  const [folMax, setFolMaxRaw] = useState<number>(typeof q.daily_follow_max === 'number' ? q.daily_follow_max : 2);
  const setFolMin = (v: number) => { const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v)); setFolMinRaw(n); setFolMaxRaw((p) => (p < n ? n : p)); };
  const setFolMax = (v: number) => { const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v)); setFolMaxRaw(n); setFolMinRaw((p) => (p > n ? n : p)); };
  const [cmtMin, setCmtMinRaw] = useState<number>(typeof q.daily_comment_min === 'number' ? q.daily_comment_min : 1);
  const [cmtMax, setCmtMaxRaw] = useState<number>(typeof q.daily_comment_max === 'number' ? q.daily_comment_max : 3);
  const setCmtMin = (v: number) => { const n = Math.max(0, Math.min(COMMENT_HARDCAP, v)); setCmtMinRaw(n); setCmtMaxRaw((p) => (p < n ? n : p)); };
  const setCmtMax = (v: number) => { const n = Math.max(0, Math.min(COMMENT_HARDCAP, v)); setCmtMaxRaw(n); setCmtMinRaw((p) => (p > n ? n : p)); };

  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'daily_random');
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const totalMaxActions = likeMax + folMax + cmtMax;
  useEffect(() => { if (saveError) setSaveError(null); /* eslint-disable-next-line */ }, [selected, likeMin, likeMax, folMin, folMax, cmtMin, cmtMax, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: selected.size >= 1, reason: isZh ? '请至少勾选一个已登录账号' : 'Select at least one account' },
    2: totalMaxActions === 0 ? { ok: false, reason: isZh ? '至少配置一项动作 (max > 0)' : 'Configure at least one action' } : { ok: true },
    3: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) { setSaveError(canAdvance[3].reason || ''); return; }
    setSaving(true);
    try {
      await onSave({
        name: name.trim() || `${platformLabel}互动`,
        accountIds: [...selected],
        concurrency: selected.size,   // 选几个号就同时开几个窗(runner 内部有安全上限兜底)
        frequency: runInterval,
        quota: { daily_like_min: likeMin, daily_like_max: likeMax, daily_follow_min: folMin, daily_follow_max: folMax, daily_comment_min: cmtMin, daily_comment_max: cmtMax },
      });
    } catch (err) {
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败' : 'Save failed'));
    } finally { setSaving(false); }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = { once: '不重复（手动触发）', '30min': '每 30 分钟', '1h': '每小时', '3h': '每 3 小时', '6h': '每 6 小时', daily_random: '每日随机时间一次' };
    return m[runInterval] || runInterval;
  }, [runInterval]);

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">🎶 {editing ? `编辑${platformLabel}互动任务` : `配置${platformLabel}互动涨粉`}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-violet-500/40 text-violet-500 bg-violet-500/5">第 {step} / 3 步</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">任务名</label>
              <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/40" disabled={saving} />
            </div>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                选账号<span className="text-xs text-gray-400 font-normal ml-1">· 已登录且配了关键词;已选 {selected.size}</span>
              </label>
              <div className="space-y-1.5 max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
                {accounts.length === 0 && <div className="text-xs text-gray-400 p-2">该平台还没有账号。先去「我的矩阵号」添加并扫码登录、配关键词。</div>}
                {accounts.map((a) => {
                  const hasKw = !!(a.keywords && a.keywords.length);
                  // 放宽:配了词且没被封即可勾(profile cookie 持久,登录态只是标记;真没登录时跑会自动跳过)
                  const ready = hasKw && a.status !== 'banned';
                  const reason = a.status === 'banned' ? '已封' : !hasKw ? '未配关键词' : (a.status === 'login_required' ? '可能需登录' : '');
                  return (
                    <label key={a.id} className={`flex items-center gap-2 text-sm px-1.5 py-1 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-50 cursor-not-allowed'}`}>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => ready && toggle(a.id)} disabled={saving || !ready} className="h-4 w-4 accent-violet-500 shrink-0" />
                      <span className="font-medium whitespace-nowrap shrink-0">{a.displayName}</span>
                      {a.group && <span className="text-xs text-gray-400 whitespace-nowrap shrink-0">· {a.group}</span>}
                      {hasKw ? <span className="text-xs text-gray-400 truncate min-w-0 flex-1">[{(a.keywords || []).join('/')}]</span> : <span className="flex-1" />}
                      {reason && <span className="text-[11px] text-amber-500 shrink-0">{reason}</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">每次运行,下面三项动作分别按"随机区间 [min, max]"决定做几次。设为 0/0 则该动作不执行。每个账号各自跑。</div>
            <RangeSlider label="每次运行点赞数量" min={likeMin} max={likeMax} setMin={setLikeMin} setMax={setLikeMax} hardCap={LIKE_HARDCAP} hint={`每次随机点赞 ${likeMin}-${likeMax} 个视频 (0-${LIKE_HARDCAP},越大风险越高)`} disabled={saving} />
            <RangeSlider label="每次运行关注数量" min={folMin} max={folMax} setMin={setFolMin} setMax={setFolMax} hardCap={FOLLOW_HARDCAP} hint={`每次随机关注 ${folMin}-${folMax} 个作者 (0-${FOLLOW_HARDCAP},关注是风控最严的动作,建议保守)`} disabled={saving} />
            <RangeSlider label="每次运行评论数量" min={cmtMin} max={cmtMax} setMin={setCmtMin} setMax={setCmtMax} hardCap={COMMENT_HARDCAP} hint={`每次随机发 ${cmtMin}-${cmtMax} 条评论 (0-${COMMENT_HARDCAP},内容由 AI 按视频上下文+该号人设自动写)`} disabled={saving} />
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
              <div className="font-semibold">⚠️ 安全提示</div>
              <ul className="list-disc list-inside space-y-0.5">
                <li>关注默认 0-2 — 平台对自动关注检测最严,长期跑建议保守</li>
                <li>多开账号务必每号配独立 IP(在「我的矩阵号」里设),否则同 IP 易被风控</li>
              </ul>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">⏰ 运行间隔</label>
              <div className="flex gap-2 flex-wrap">
                {[['once', '不重复（手动触发）'], ['30min', '每 30 分钟'], ['1h', '每小时'], ['3h', '每 3 小时'], ['6h', '每 6 小时'], ['daily_random', '每日随机时间']].map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'}`}>{label}</button>
                ))}
              </div>
              {runInterval === 'daily_random' && <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">✨ 推荐 — 每天在随机时间触发一次,比固定钟点更像真人,也最不容易被风控判机器人。</p>}
              {(runInterval === '30min' || runInterval === '1h' || runInterval === '3h' || runInterval === '6h') && <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">⚠️ 到点后再加 {(runInterval === '3h' || runInterval === '6h') ? '1-45' : '1-10'} 分钟随机延迟,避免精准卡点</p>}
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 任务摘要</div>
              <SummaryRow label="账号" value={`${selected.size} 个(各用自己的赛道词)`} />
              <SummaryRow label="点赞数" value={`${likeMin}-${likeMax} / 次`} />
              <SummaryRow label="关注数" value={`${folMin}-${folMax} / 次`} />
              <SummaryRow label="评论数" value={`${cmtMin}-${cmtMax} / 次`} />
              <SummaryRow label="同时开窗" value={`${selected.size} 个号一起跑`} />
              <SummaryRow label="运行频率" value={intervalLabel} />
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">使用条款</div>
              {['我理解 NoobClaw 会在我本地用各账号专属指纹浏览器代我浏览平台,所有行为使用各账号自己的 IP 和账号', '我理解平台账号风险由我自己承担'].map((term, i) => (
                <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                  <input type="checkbox" checked={termsAccepted[i]} onChange={(e) => { const next = [...termsAccepted]; next[i] = e.target.checked; setTermsAccepted(next); }} disabled={saving} className="mt-0.5 h-4 w-4 accent-violet-500 shrink-0" />
                  <span className="leading-relaxed">{term}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {/* 仅在用户点了「下一步/创建」校验不过(saveError 被置)时才提示;不再常驻显示「请勾选」 */}
      {saveError && (
        <div className="px-6 pt-2 pb-1 shrink-0">
          <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">
            ❌ {saveError}
          </div>
        </div>
      )}

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">取消</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">← 上一步</button>}
        {step < 3 ? (
          <button type="button" onClick={() => { if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; } setSaveError(null); setStep((step + 1) as WizardStep); }} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">下一步 →</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted} className="px-5 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{saving ? '保存中...' : (editing ? '✓ 保存修改' : '🎶 创建任务')}</button>
        )}
      </div>
    </div>
  );
};

const RangeSlider: React.FC<{ label: string; min: number; max: number; setMin: (v: number) => void; setMax: (v: number) => void; hardCap: number; hint: string; disabled?: boolean }> = ({ label, min, max, setMin, setMax, hardCap, hint, disabled }) => (
  <div>
    <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{label}（随机区间）</label>
    <div className="grid grid-cols-2 gap-4">
      <div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">最少: <span className="font-bold text-violet-500">{min}</span></div>
        <input type="range" min={0} max={hardCap} value={min} onChange={(e) => setMin(parseInt(e.target.value, 10))} disabled={disabled} className="w-full accent-violet-500" />
      </div>
      <div>
        <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">最多: <span className="font-bold text-violet-500">{max}</span></div>
        <input type="range" min={0} max={hardCap} value={max} onChange={(e) => setMax(parseInt(e.target.value, 10))} disabled={disabled} className="w-full accent-violet-500" />
      </div>
    </div>
    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{hint}</div>
  </div>
);

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixTaskWizard;
