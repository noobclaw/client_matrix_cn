/**
 * XhsReplyFansCommentWizard — 小红书自动回复粉丝评论 wizard
 *
 *   Step 1 — 核心引流语 + 概率 + 每次回复目标 + 单篇上限
 *   Step 2 — 运行间隔 + 摘要 + 条款
 *
 * 跟 XhsImageTextWizard 同款 modal 骨架。
 * 引流语为空时,probability slider 灰掉 + 显示"未填,不会带引流尾巴"。
 */

import React, { useMemo, useState, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task } from '../../services/scenario';

interface Props {
  scenario: Scenario;
  initialTask?: Task | null;
  onCancel: () => void;
  onSave: (input: any) => Promise<void> | void;
}

type WizardStep = 1 | 2;

const FUNNEL_PHRASE_MAX = 200;
const FUNNEL_PROB_MIN = 1;
const FUNNEL_PROB_MAX = 100;
const FUNNEL_PROB_DEFAULT = 50;

export const XhsReplyFansCommentWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;
  // v6.x: 这个 wizard 同时服务小红书 / 抖音 / 快手 / 哔哩哔哩四个"回复粉丝评论"
  // 场景,平台相关文案靠 scenario.platform 切换。字段(引流语+概率+间隔)完全
  // 平台无关。小红书是唯一"逐篇笔记进详情页"的流程,其余三个短视频平台都在
  // 各自创作者中心「评论管理」集中回复(作品=video,creator center 名各异)。
  const plat = scenario.platform as any;
  const isXhs = plat === 'xhs';
  // isDouyin 保留给沿用抖音文案的旧分支(短视频平台共用同一套"作品/评论管理"措辞)。
  const isDouyin = !isXhs;
  const ccNameZh = plat === 'kuaishou' ? '快手创作者服务平台'
    : plat === 'bilibili' ? '哔哩哔哩创作中心'
    : plat === 'douyin' ? '抖音创作者中心'
    : plat === 'shipinhao' ? '视频号助手'
    : plat === 'toutiao' ? '头条号后台'
    : '小红书创作者中心';
  const ccNameEn = plat === 'kuaishou' ? 'Kuaishou Creator Platform'
    : plat === 'bilibili' ? 'Bilibili Creator Center'
    : plat === 'douyin' ? 'Douyin Creator Center'
    : plat === 'shipinhao' ? 'WeChat Channels Assistant'
    : plat === 'toutiao' ? 'Toutiao Backend'
    : 'Xiaohongshu Creator Center';
  const itemZh = isXhs ? '笔记' : '作品';

  const [step, setStep] = useState<WizardStep>(1);

  // ── 引流语 ──
  const [funnelPhrase, setFunnelPhrase] = useState<string>(
    String((initialTask as any)?.funnel_phrase || '')
  );
  const hasFunnel = funnelPhrase.trim().length > 0;

  // ── 引流概率 ──
  const [funnelProb, setFunnelProb] = useState<number>(
    // 没配过引流(保存 0)时回落 50% 默认,不夹成 Math.max(1,0)=1(编辑后补引流语会显示 1%,用户实测)。
    typeof (initialTask as any)?.funnel_probability === 'number' && (initialTask as any).funnel_probability >= FUNNEL_PROB_MIN
      ? Math.min(FUNNEL_PROB_MAX, (initialTask as any).funnel_probability)
      : FUNNEL_PROB_DEFAULT
  );

  // ── 调度 ──
  const dailyTime = useMemo(() => {
    if (initialTask?.daily_time) return String(initialTask.daily_time);
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [initialTask]);
  const [runInterval, setRunInterval] = useState<string>(
    ((initialTask as any)?.run_interval as string) || 'daily_random'
  );

  // ── 条款 ──
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (saveError) setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnelPhrase, funnelProb, runInterval]);

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: true },
    2: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[2].ok) {
      setSaveError(canAdvance[2].reason || (isZh ? '请确认条款' : 'Please confirm'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        scenario_id: scenario.id,
        track: 'reply_fan_comment',
        keywords: [],
        persona: '',
        variants_per_post: 1,
        daily_time: dailyTime,
        run_interval: runInterval,
        funnel_phrase: funnelPhrase.trim(),
        funnel_probability: hasFunnel ? funnelProb : 0,
        auto_upload: false,
        auto_publish: false,
      });
    } catch (err) {
      console.error('[XhsReplyFansCommentWizard] save failed:', err);
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败,请重试' : 'Save failed, please retry'));
    } finally {
      setSaving(false);
    }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = {
      'once': isZh ? '不重复（手动触发）' : 'Once (manual only)',
      '6h': isZh ? '每 6 小时' : 'Every 6h',
      'daily': isZh ? '每日固定时间' : 'Daily (fixed time)',
      'daily_random': isZh ? '每日随机时间一次' : 'Once daily (random time)',
    };
    return m[runInterval] || runInterval;
  }, [runInterval, isZh]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="text-base font-semibold dark:text-white">
            💌 {editing
              ? (isZh ? '编辑自动回复粉丝任务' : 'Edit Fan-Comment Reply Task')
              : (isZh ? '配置自动回复粉丝' : 'Configure Fan-Comment Reply')}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full border border-fuchsia-500/40 text-fuchsia-500 bg-fuchsia-500/5">
              {isZh ? `第 ${step} / 2 步` : `Step ${step} / 2`}
            </span>
            <button type="button" onClick={onCancel} disabled={saving}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors" aria-label="close">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {step === 1 && (
            <>
              <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-fuchsia-500/30 bg-fuchsia-500/5 text-fuchsia-700 dark:text-fuchsia-300">
                💌 {isZh
                  ? (isDouyin
                      ? <>本任务在你的<strong>{ccNameZh}评论管理</strong>里逐条读粉丝评论 → AI 写回应 → 真人节奏发送。<strong>已回复过的、自己留的评论自动跳过</strong>,只回复粉丝、从不评论作品本身。</>
                      : <>本任务会自动打开你的<strong>创作者中心</strong>,逐篇笔记进详情页,读粉丝评论 → AI 写回应 → 真人节奏发送。<strong>已回复过的、自己留的评论自动跳过</strong>,从不评论笔记本身。</>)
                  : (isDouyin
                      ? <>This task reads fan comments in your <strong>{ccNameEn} Comment Management</strong> → AI writes replies → posts on human-paced jitter. <strong>Auto-skips already-replied / your own comments</strong>; only replies to fans, never comments on the video itself.</>
                      : <>This task opens your <strong>Creator Center</strong>, walks each note's detail page, reads fan comments → AI writes replies → posts on human-paced jitter. <strong>Auto-skips comments you've already replied to or your own.</strong></>)}
              </div>

              {/* 引流语 textarea */}
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                  {isZh ? '🎣 核心引流语（选填）' : '🎣 Funnel phrase (optional)'}
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    {isZh ? `· 留空则回复不带引流尾巴` : `· Empty = no funnel tail`}
                  </span>
                </label>
                <textarea
                  value={funnelPhrase}
                  onChange={e => setFunnelPhrase(e.target.value.slice(0, FUNNEL_PHRASE_MAX))}
                  placeholder={isZh
                    ? (isDouyin
                        ? '比如：完整教程在我主页置顶视频，需要的可以去看\n或：私信我领西湖路线攻略'
                        : '比如：详细攻略发在我主页置顶笔记里，需要的可以去看一下\n或：私我领西湖路书pdf')
                    : 'e.g. Full guide in my pinned post — feel free to check.\nor: DM me for the West Lake route PDF.'}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-fuchsia-500/40 resize-y min-h-[80px]"
                  disabled={saving}
                />
                <div className="text-[11px] text-gray-400 mt-1">
                  {funnelPhrase.trim().length} / {FUNNEL_PHRASE_MAX} {isZh ? '字' : 'chars'}
                </div>
              </div>

              {/* 引流概率 slider */}
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh
                    ? `🎲 引流尾巴出现概率: ${hasFunnel ? funnelProb : 0}%`
                    : `🎲 Funnel tail probability: ${hasFunnel ? funnelProb : 0}%`}
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    {hasFunnel
                      ? (isZh ? '· AI 会按概率把引流语自然衔接到回复尾部' : '· AI weaves funnel into reply tail by probability')
                      : (isZh ? '· 引流语未填,概率失效' : '· Funnel empty, probability disabled')}
                  </span>
                </label>
                <input
                  type="range"
                  min={FUNNEL_PROB_MIN}
                  max={FUNNEL_PROB_MAX}
                  value={funnelProb}
                  onChange={e => setFunnelProb(parseInt(e.target.value, 10))}
                  disabled={saving || !hasFunnel}
                  className="w-full accent-fuchsia-500 disabled:opacity-40"
                />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '⏰ 运行间隔' : '⏰ Run Interval'}
                </label>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { value: 'once',         label: isZh ? '不重复（手动触发）' : 'Once (manual only)' },
                    { value: '6h',           label: isZh ? '每 6 小时' : 'Every 6h' },
                    { value: 'daily',        label: isZh ? '每日固定时间' : 'Daily (fixed time)' },
                    { value: 'daily_random', label: isZh ? '每日随机时间一次' : 'Once daily (random time)' },
                  ].map(opt => (
                    <button
                      key={opt.value} type="button"
                      onClick={() => setRunInterval(opt.value)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        runInterval === opt.value
                          ? 'border-fuchsia-500 bg-fuchsia-500/10 text-fuchsia-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-fuchsia-500/50'
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
                <div className="font-semibold dark:text-gray-200 mb-1">📋 {isZh ? '任务摘要' : 'Task summary'}</div>
                <SummaryRow
                  label={isZh ? '引流语' : 'Funnel'}
                  value={hasFunnel
                    ? `"${funnelPhrase.trim().slice(0, 40)}${funnelPhrase.trim().length > 40 ? '...' : ''}" · ${funnelProb}%`
                    : (isZh ? '（未填,纯 AI 回复）' : '(empty, pure AI reply)')} />
                <SummaryRow
                  label={isZh ? '回复范围' : 'Scope'}
                  value={isZh ? '逐条回复全部粉丝评论（最近 30 篇文章）' : 'Reply to every fan comment (latest 30 notes)'} />
                <SummaryRow label={isZh ? '运行频率' : 'Frequency'} value={intervalLabel} />
                <SummaryRow
                  label={isZh ? '安全节奏' : 'Pacing'}
                  value={isZh ? ('评论间 30~90s · ' + itemZh + '间 2~5min') : 'Reply 30-90s · Item 2-5min'} />
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  {isZh ? '使用条款' : 'Terms'}
                </div>
                {[
                  isZh
                    ? ('我理解 NoobClaw 会在我本地浏览器代我打开' + ccNameZh + ',所有行为使用我自己的 IP 和账号')
                    : ('I understand NoobClaw drives the ' + ccNameEn + ' inside my own browser using my IP and my account.'),
                  isZh
                    ? '我理解平台账号风险由我自己承担'
                    : 'I accept platform account risk.',
                ].map((term, i) => (
                  <label key={i} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={termsAccepted[i]}
                      onChange={e => {
                        const next = [...termsAccepted];
                        next[i] = e.target.checked;
                        setTermsAccepted(next);
                      }}
                      disabled={saving}
                      className="mt-0.5 h-4 w-4 accent-fuchsia-500 cursor-pointer shrink-0"
                    />
                    <span className="leading-relaxed">{term}</span>
                  </label>
                ))}
              </div>
            </>
          )}

        </div>

        {(!canAdvance[step].ok || saveError) && (
          <div className="px-6 pt-2 pb-1 shrink-0">
            <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
              saveError
                ? 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
                : 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300'
            }`}>
              {saveError
                ? `❌ ${saveError}`
                : `⚠️ ${canAdvance[step].reason || (isZh ? '当前步骤还有必填项未完成' : 'Required fields incomplete on this step')}`}
            </div>
          </div>
        )}

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
          <button type="button" onClick={onCancel} disabled={saving}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2"
          >{isZh ? '取消' : 'Cancel'}</button>
          <div className="flex-1" />
          {step > 1 && (
            <button type="button" onClick={() => setStep((step - 1) as WizardStep)} disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            >← {isZh ? '上一步' : 'Prev'}</button>
          )}
          {step < 2 ? (
            <button type="button"
              onClick={() => {
                if (!canAdvance[step].ok) {
                  setSaveError(canAdvance[step].reason || (isZh ? '当前步骤未填完' : 'Current step incomplete'));
                  return;
                }
                setSaveError(null);
                setStep((step + 1) as WizardStep);
              }}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-fuchsia-500 text-white hover:bg-fuchsia-600 disabled:opacity-50"
              title={!canAdvance[step].ok ? canAdvance[step].reason : undefined}
            >{isZh ? '下一步' : 'Next'} →</button>
          ) : (
            <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-fuchsia-500 text-white hover:bg-fuchsia-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >{saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '💌 ' + (isZh ? '创建任务' : 'Create Task'))}</button>
          )}
        </div>
      </div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs">
    <span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span>
    <span className="text-gray-800 dark:text-gray-200 break-all">{value}</span>
  </div>
);

export default XhsReplyFansCommentWizard;
