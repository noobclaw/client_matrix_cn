/**
 * YoutubeConfigWizard — 独立 3-step wizard,字段对齐 Twitter 互动涨粉:
 *
 *   Step 1 — 人设
 *   Step 2 — 互动数量 (3 个 min/max 滑条: 点赞 / 订阅 / 评论) + 评论提示词 + 安全提示
 *   Step 3 — 调度 pills + 摘要 + 创建
 *
 * 跟之前 v1 的根本差异 — 不再用"每天处理 N 个视频 + 三 toggle",改用
 * Twitter 同款"每次运行 randInt(min, max) 个动作"配额。Orchestrator 按
 * 配额跑,跟视频个数解耦 — 可能某个视频做 2 个动作,某个做 0 个,直到
 * 三个配额都用完才结束。
 *
 * 主色 indigo (避开 YouTube brand red 跟其它平台已用的 sky / emerald /
 * amber / rose 区分清楚)。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { Scenario, Task } from '../../services/scenario';
import { NumMinMax } from '../matrix/NumberStepper';

interface Props {
  scenario: Scenario;
  initialTask?: Task | null;
  onCancel: () => void;
  onSave: (input: any) => Promise<void> | void;
}

type WizardStep = 1 | 2 | 3;

// Per-action hard caps — 跟 Twitter (x_auto_engage) ConfigWizard 看齐:
// like 30 / subscribe 20 / comment 50。之前 5 / 15 是过度保守,跟 Twitter 不
// 对齐用户配多平台时区间感会很别扭。
const LIKE_HARDCAP = 500;
const SUBSCRIBE_HARDCAP = 100;
const COMMENT_HARDCAP = 100;

// ── YouTube tracks ──
// v5.x+: tracks 从 backend manifest.tracks 下发(支持热更新关键词不需要打新版
// 客户端)。下面的硬编码列表是 fallback,scenario.tracks 缺失/空时使用,保证
// 老 backend 部署 + 新 client 仍能跑;未来若想强制走 backend 可移除 fallback。
type YoutubeTrack = { id: string; icon: string; name_zh: string; name_en?: string; keywords_zh: string[]; keywords_en?: string[] };
const YOUTUBE_TRACKS_FALLBACK: YoutubeTrack[] = [
  { id: 'tech_review', icon: '💻', name_zh: '科技 · 数码评测',
    keywords_zh: ['iPhone 评测', '科技数码', '开箱视频', '笔电评测', 'macbook 评测', '安卓评测', '智能手表', '游戏装备', '智能家居'],
    keywords_en: ['iPhone review', 'tech 2026', 'gadget unboxing', 'laptop review', 'macbook', 'android review', 'pixel review', 'wearable tech', 'smart home', 'gaming gear'] },
  { id: 'gaming', icon: '🎮', name_zh: '游戏 · 实况攻略',
    keywords_zh: ['游戏实况', '游戏攻略', '我的世界', '原神', '王者荣耀', '手游推荐', 'speedrun', '游戏评测', '吃鸡'],
    keywords_en: ['gameplay walkthrough', 'minecraft', 'fortnite', 'valorant', 'speedrun', 'tier list', 'game review', 'genshin', 'roblox', 'pokemon'] },
  { id: 'music_mv', icon: '🎵', name_zh: '音乐 · MV / 翻唱',
    keywords_zh: ['官方 MV', '翻唱', '歌词版', 'live 现场', '华语流行', 'kpop', '钢琴翻奏', '吉他弹唱', 'lofi'],
    keywords_en: ['official music video', 'cover song', 'lyrics', 'live performance', 'kpop', 'jpop', 'piano cover', 'guitar acoustic', 'lofi mix', 'remix'] },
  { id: 'tutorial', icon: '📚', name_zh: '教程 · How-To',
    keywords_zh: ['教程', '入门指南', '新手教学', '速成课', '一步步教', '10 分钟学会', '深度讲解'],
    keywords_en: ['tutorial', 'how to', 'beginner guide', 'crash course', 'step by step', 'in 10 minutes', 'explained', 'masterclass', 'learn fast'] },
  { id: 'vlog', icon: '📷', name_zh: '生活 · Vlog',
    keywords_zh: ['日常 vlog', '一天 vlog', '晨间 routine', '生产力', '远程办公', '极简生活', '居家 vlog'],
    keywords_en: ['day in the life', 'morning routine', 'productivity', 'work from home', 'vlog', 'aesthetic vlog', 'minimalist lifestyle', 'wfh routine'] },
  { id: 'fitness', icon: '💪', name_zh: '健身 · 运动',
    keywords_zh: ['居家健身', 'hiit', '瑜伽', '普拉提', '减脂', '健身教程', '帕梅拉', '徒手训练', '10 分钟燃脂'],
    keywords_en: ['home workout', 'hiit', 'yoga', 'pilates', 'fat loss', 'workout routine', 'pamela reif', 'chloe ting', '10 min workout', 'no equipment workout'] },
  { id: 'finance', icon: '💰', name_zh: '理财 · 投资',
    keywords_zh: ['股票投资', '理财入门', '加密货币', '基金定投', '被动收入', '指数基金', '巴菲特', '股息投资'],
    keywords_en: ['stock market', 'investing', 'crypto', 'personal finance', 'passive income', 'index fund', 'warren buffett', 'dividend stocks', 'real estate'] },
  { id: 'ai_news', icon: '🤖', name_zh: 'AI · 资讯前沿',
    keywords_zh: ['ChatGPT 教程', 'Claude AI', 'AI 工具', '机器学习', 'AI 资讯', 'Gemini', 'Sora', 'AI 编程', 'AI 工作流'],
    keywords_en: ['chatgpt', 'claude ai', 'llm', 'ai tools', 'machine learning', 'ai news', 'gemini ai', 'sora video', 'ai agent', 'ai coding'] },
];

export const YoutubeConfigWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;

  const [step, setStep] = useState<WizardStep>(1);

  // ── Track + keywords (replaces persona in v5.x) ──
  // i18n: zh / zh-TW 客户端默认填中文 keywords,其他语言 (en/ko/ja/ru/fr/de) 填英文。
  // tracks 优先取 backend 下发的 scenario.tracks,缺失时用本地 fallback 列表。
  const lang = i18nService.currentLanguage;
  const langKey: 'zh' | 'en' = (lang === 'zh' || lang === 'zh-TW') ? 'zh' : 'en';
  const TRACKS: YoutubeTrack[] = (scenario as any).tracks && (scenario as any).tracks.length > 0
    ? (scenario as any).tracks as YoutubeTrack[]
    : YOUTUBE_TRACKS_FALLBACK;
  const trackName = (t: YoutubeTrack): string => langKey === 'en' ? (t.name_en || t.name_zh) : t.name_zh;
  const trackKeywords = (t: YoutubeTrack): string[] => langKey === 'en' ? (t.keywords_en || t.keywords_zh) : t.keywords_zh;
  const initialTrackId = ((initialTask as any)?.track as string)
    || (TRACKS.find(t => t.id === 'tech_review')?.id || TRACKS[0].id);
  const [trackId, setTrackId] = useState<string>(
    TRACKS.find(t => t.id === initialTrackId) ? initialTrackId : TRACKS[0].id
  );
  const initialKeywords: string[] = Array.isArray((initialTask as any)?.keywords) && (initialTask as any).keywords.length > 0
    ? (initialTask as any).keywords
    : trackKeywords(TRACKS.find(t => t.id === initialTrackId) || TRACKS[0]);
  const [keywordsText, setKeywordsText] = useState<string>(initialKeywords.join(' '));
  const handleTrackChange = (newTrackId: string) => {
    setTrackId(newTrackId);
    const preset = TRACKS.find(t => t.id === newTrackId);
    if (preset) setKeywordsText(trackKeywords(preset).join(' '));
  };
  function parseKeywords(raw: string): string[] {
    return raw.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  }

  // ── Slider state with auto-clamp setters (mirrors ConfigWizard pattern) ──
  // v5.x+: 默认值跟 Twitter (ConfigWizard.tsx:685-691) 看齐 — like 0/5
  const [likeMin, setLikeMinRaw] = useState<number>(
    typeof (initialTask as any)?.daily_like_min === 'number' ? (initialTask as any).daily_like_min : 0
  );
  const [likeMax, setLikeMaxRaw] = useState<number>(
    typeof (initialTask as any)?.daily_like_max === 'number' ? (initialTask as any).daily_like_max : 5
  );
  const setLikeMin = (v: number) => {
    const n = Math.max(0, Math.min(LIKE_HARDCAP, v));
    setLikeMinRaw(n);
    setLikeMaxRaw(prev => (prev < n ? n : prev));
  };
  const setLikeMax = (v: number) => {
    const n = Math.max(0, Math.min(LIKE_HARDCAP, v));
    setLikeMaxRaw(n);
    setLikeMinRaw(prev => (prev > n ? n : prev));
  };

  // v5.x+: 默认值跟 Twitter follow 0/3 看齐
  const [subMin, setSubMinRaw] = useState<number>(
    typeof (initialTask as any)?.daily_subscribe_min === 'number' ? (initialTask as any).daily_subscribe_min : 0
  );
  const [subMax, setSubMaxRaw] = useState<number>(
    typeof (initialTask as any)?.daily_subscribe_max === 'number' ? (initialTask as any).daily_subscribe_max : 3
  );
  const setSubMin = (v: number) => {
    const n = Math.max(0, Math.min(SUBSCRIBE_HARDCAP, v));
    setSubMinRaw(n);
    setSubMaxRaw(prev => (prev < n ? n : prev));
  };
  const setSubMax = (v: number) => {
    const n = Math.max(0, Math.min(SUBSCRIBE_HARDCAP, v));
    setSubMaxRaw(n);
    setSubMinRaw(prev => (prev > n ? n : prev));
  };

  // v5.x+: 默认值跟 Twitter reply 2/2 看齐
  const [cmtMin, setCmtMinRaw] = useState<number>(
    typeof (initialTask as any)?.daily_comment_min === 'number' ? (initialTask as any).daily_comment_min : 2
  );
  const [cmtMax, setCmtMaxRaw] = useState<number>(
    typeof (initialTask as any)?.daily_comment_max === 'number' ? (initialTask as any).daily_comment_max : 2
  );
  const setCmtMin = (v: number) => {
    const n = Math.max(0, Math.min(COMMENT_HARDCAP, v));
    setCmtMinRaw(n);
    setCmtMaxRaw(prev => (prev < n ? n : prev));
  };
  const setCmtMax = (v: number) => {
    const n = Math.max(0, Math.min(COMMENT_HARDCAP, v));
    setCmtMaxRaw(n);
    setCmtMinRaw(prev => (prev > n ? n : prev));
  };

  // commentPrompt 已从 wizard 移除 (v5.x): AI 按 video metadata + track + keyword
  // 自己写评论,不需要用户写额外提示词。orchestrator 仍接受 task.comment_prompt
  // 字段保持向后兼容,但 wizard 不再设值,默认空。

  // daily_time not user-editable — pills replace HH:MM picker. Compute as memo.
  const dailyTime = useMemo(() => {
    if (initialTask?.daily_time) return String(initialTask.daily_time);
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [initialTask]);
  const [runInterval, setRunInterval] = useState<string>(
    ((initialTask as any)?.run_interval as string) || 'daily_random'
  );

  // v5.x+: 使用条款默认勾选 — UI 上仍保留 checkbox 让用户可见,但保存时
  // 把勾选状态当作"已确认"。
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const totalMaxActions = likeMax + subMax + cmtMax;

  useEffect(() => {
    if (saveError) setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, keywordsText, likeMin, likeMax, subMin, subMax, cmtMin, cmtMax, runInterval]);

  const parsedKeywords = parseKeywords(keywordsText);
  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: { ok: parsedKeywords.length >= 1, reason: isZh ? '请至少填一个关键词' : 'Add at least one keyword' },
    2: totalMaxActions === 0
        ? { ok: false, reason: isZh ? '至少配置一项动作 (max > 0)' : 'Configure at least one action (max > 0)' }
        : { ok: true },
    3: { ok: allTermsAccepted, reason: isZh ? '请勾选使用条款' : 'Please accept the terms' },
  };

  const handleSave = async () => {
    if (saving) return;
    if (!canAdvance[3].ok) {
      setSaveError(canAdvance[3].reason || (isZh ? '请确认条款' : 'Please confirm'));
      return;
    }
    setSaving(true);
    try {
      await onSave({
        scenario_id: scenario.id,
        track: trackId,
        keywords: parsedKeywords,
        persona: '',
        // legacy daily_count = sum of upper-bound quotas (informational only,
        // orchestrator drives off the per-action min/max ranges below).
        daily_count: Math.max(1, totalMaxActions),
        variants_per_post: 1,
        daily_time: dailyTime,
        run_interval: runInterval,
        // YouTube engagement quotas — orchestrator reads these.
        daily_like_min: likeMin,
        daily_like_max: likeMax,
        daily_subscribe_min: subMin,
        daily_subscribe_max: subMax,
        daily_comment_min: cmtMin,
        daily_comment_max: cmtMax,
        comment_prompt: '',
      });
    } catch (err) {
      console.error('[YoutubeConfigWizard] save failed:', err);
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败,请重试' : 'Save failed, please retry'));
    } finally {
      setSaving(false);
    }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = {
      'once': isZh ? '不重复（手动触发）' : 'Once (manual only)',
      '3h': isZh ? '每 3 小时' : 'Every 3h',
      '6h': isZh ? '每 6 小时' : 'Every 6h',
      'daily_random': isZh ? '每日随机时间一次' : 'Once daily (random time)',
    };
    return m[runInterval] || runInterval;
  }, [runInterval, isZh]);

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="text-base font-semibold dark:text-white">
            📺 {editing
              ? (isZh ? '编辑 YouTube 互动任务' : 'Edit YouTube Engagement Task')
              : (isZh ? '配置 YouTube 互动涨粉' : 'Configure YouTube Engage & Grow')}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full border border-indigo-500/40 text-indigo-500 bg-indigo-500/5">
              {isZh ? `第 ${step} / 3 步` : `Step ${step} / 3`}
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
              disabled={saving}
              aria-label="close"
            >✕</button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* ── Step 1: track + keywords (v5.x replaces persona) ── */}
          {step === 1 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '选择赛道' : 'Select Track'}
                </label>
                <div className="relative">
                  <select
                    value={trackId}
                    onChange={e => handleTrackChange(e.target.value)}
                    className="w-full appearance-none rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2.5 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40 cursor-pointer"
                    disabled={saving}
                  >
                    {TRACKS.map(t => (
                      <option key={t.id} value={t.id}>{t.icon} {trackName(t)}</option>
                    ))}
                  </select>
                  <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                  {isZh ? '关键词' : 'Keywords'}
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    {isZh ? '· 每次运行随机选 1 个搜索匹配视频去互动' : '· Each run picks 1 random keyword to search'}
                  </span>
                </label>
                <div className="mb-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-indigo-500/30 bg-indigo-500/5 text-indigo-700 dark:text-indigo-300">
                  ✨ {isZh
                    ? <>关键词决定<strong>会去搜哪些视频做互动</strong>。预填的是各赛道高流量词,可按你账号定位增删。</>
                    : <>Keywords decide <strong>which videos get engaged with</strong>. Pre-filled with each track's high-traffic terms.</>}
                </div>
                <textarea
                  value={keywordsText}
                  onChange={e => setKeywordsText(e.target.value)}
                  placeholder={isZh ? '用空格或逗号分隔,越多越好' : 'Space or comma separated'}
                  rows={5}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/40 resize-y"
                  disabled={saving}
                />
                <div className="text-[11px] text-gray-400 mt-1">
                  {isZh ? '当前 ' + parsedKeywords.length + ' 个关键词' : parsedKeywords.length + ' keywords'}
                </div>
              </div>
            </>
          )}

          {/* ── Step 2: 3 sliders + comment_prompt + safety ── */}
          {step === 2 && (
            <>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                {isZh
                  ? '每次运行,下面三项动作分别按"随机区间 [min, max]"决定做几次。设为 0/0 则该动作不执行。'
                  : 'Each run rolls a random count for each action from its [min, max] range. Set both to 0 to disable that action.'}
              </div>

              <RangeSlider
                label={isZh ? '每次运行点赞数量' : 'Likes per run'}
                min={likeMin} max={likeMax} setMin={setLikeMin} setMax={setLikeMax}
                hardCap={LIKE_HARDCAP} hint={isZh ? `每次随机点赞 ${likeMin}-${likeMax} 个视频 (0-${LIKE_HARDCAP},越大风险越高)` : `Random ${likeMin}-${likeMax} likes (0-${LIKE_HARDCAP}, higher = riskier)`}
                disabled={saving}
              />

              <RangeSlider
                label={isZh ? '每次运行订阅数量' : 'Subscribes per run'}
                min={subMin} max={subMax} setMin={setSubMin} setMax={setSubMax}
                hardCap={SUBSCRIBE_HARDCAP} hint={isZh ? `每次随机订阅 ${subMin}-${subMax} 个频道 (0-${SUBSCRIBE_HARDCAP},订阅是 YouTube 风控最严的动作,建议保守)` : `Random ${subMin}-${subMax} subscribes (0-${SUBSCRIBE_HARDCAP}, this is YouTube's most-flagged action — keep low)`}
                disabled={saving}
              />

              <RangeSlider
                label={isZh ? '每次运行评论数量' : 'Comments per run'}
                min={cmtMin} max={cmtMax} setMin={setCmtMin} setMax={setCmtMax}
                hardCap={COMMENT_HARDCAP} hint={isZh ? `每次随机发 ${cmtMin}-${cmtMax} 条评论 (0-${COMMENT_HARDCAP},内容由 AI 按视频上下文 + 关键词自动写)` : `Random ${cmtMin}-${cmtMax} comments (0-${COMMENT_HARDCAP}, AI auto-writes from video context + keyword)`}
                disabled={saving}
              />

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
                <div className="font-semibold">⚠️ {isZh ? '安全提示' : 'Safety notes'}</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{isZh ? '订阅默认 0-3 — YouTube 对自动订阅检测最严,长期跑建议保守' : 'Subscribe defaults to 0-3 — YouTube flags auto-subscribe most aggressively, keep low for long-term'}</li>
                  <li>{isZh ? '动作之间随机停 30 秒-3 分钟,模拟真人节奏;视频数会按需采集' : 'Random 30s-3min between actions; video count auto-derived from quotas'}</li>
                </ul>
              </div>
            </>
          )}

          {/* ── Step 3: schedule + summary + confirm ── */}
          {step === 3 && (
            <>
              <div>
                <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
                  {isZh ? '⏰ 运行间隔' : '⏰ Run Interval'}
                </label>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { value: 'once',         label: isZh ? '不重复（手动触发）' : 'Once (manual only)' },
                    { value: '3h',           label: isZh ? '每 3 小时' : 'Every 3h' },
                    { value: '6h',           label: isZh ? '每 6 小时' : 'Every 6h' },
                    { value: 'daily_random', label: isZh ? '每日随机时间一次' : 'Once daily (random time)' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setRunInterval(opt.value)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        runInterval === opt.value
                          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-indigo-500/50'
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
                {runInterval === 'daily_random' && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {isZh
                      ? '⚠️ 互动类任务为避免被风控判定为机器人,禁止固定每日时间,每天会在随机时间点触发一次。'
                      : '⚠️ Engagement tasks must not run at the same hour daily — that pattern flags as bot. Triggers once per day at a randomized time.'}
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
                <div className="font-semibold dark:text-gray-200 mb-1">📋 {isZh ? '任务摘要' : 'Task summary'}</div>
                <SummaryRow label={isZh ? '赛道' : 'Track'} value={(TRACKS.find(t => t.id === trackId) ? trackName(TRACKS.find(t => t.id === trackId)!) : trackId) + (isZh ? ' · ' + parsedKeywords.length + ' 关键词' : ' · ' + parsedKeywords.length + ' kw')} />
                <SummaryRow label={isZh ? '点赞数' : 'Likes'} value={`${likeMin}-${likeMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '订阅数' : 'Subscribes'} value={`${subMin}-${subMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '评论数' : 'Comments'} value={`${cmtMin}-${cmtMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '运行频率' : 'Frequency'} value={intervalLabel} />
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  {isZh ? '使用条款' : 'Terms'}
                </div>
                {[
                  isZh
                    ? '我理解 NoobClaw 会在我本地浏览器代我浏览 youtube.com,所有行为使用我自己的 IP 和账号'
                    : 'I understand NoobClaw browses youtube.com inside my own browser using my IP and my account.',
                  isZh
                    ? '我理解平台账号风险由我自己承担'
                    : 'I accept that account risk on the platform is my own responsibility.',
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
                      className="mt-0.5 h-4 w-4 accent-indigo-500 cursor-pointer shrink-0"
                    />
                    <span className="leading-relaxed">{term}</span>
                  </label>
                ))}
              </div>

            </>
          )}
        </div>

        {/* v1.x: 持久化校验提示行 — 用户反馈"按钮点不动不知道为啥"。
            saveError(API 失败)优先红色;否则当前 step 校验失败显示 amber
            提示,内容由 canAdvance[step].reason 实时计算,用户改字段就消失。 */}
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

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2"
          >{isZh ? '取消' : 'Cancel'}</button>
          <div className="flex-1" />
          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep((step - 1) as WizardStep)}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            >← {isZh ? '上一步' : 'Prev'}</button>
          )}
          {step < 3 ? (
            <button
              type="button"
              onClick={() => {
                if (!canAdvance[step].ok) {
                  setSaveError(canAdvance[step].reason || (isZh ? '当前步骤未填完' : 'Current step incomplete'));
                  return;
                }
                setSaveError(null);
                setStep((step + 1) as WizardStep);
              }}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
              title={!canAdvance[step].ok ? canAdvance[step].reason : undefined}
            >{isZh ? '下一步' : 'Next'} →</button>
          ) : (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !allTermsAccepted}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >{saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '📺 ' + (isZh ? '创建任务' : 'Create Task'))}</button>
          )}
        </div>
      </div>
    </div>
  );
};

// ── RangeSlider sub-component (mirrors ConfigWizard's twin-slider pattern) ──

type RangeSliderProps = {
  label: string;
  min: number;
  max: number;
  setMin: (v: number) => void;
  setMax: (v: number) => void;
  hardCap: number;
  hint: string;
  disabled?: boolean;
};

const RangeSlider: React.FC<RangeSliderProps> = ({ label, min, max, setMin, setMax, hardCap, hint, disabled }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  return (
    <div>
      <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{label}（{isZh ? '随机区间' : 'random range'}）</label>
      <NumMinMax
        min={min} max={max} setMin={setMin} setMax={setMax} lo={0} hi={hardCap}
        minLabel={isZh ? '最少' : 'Min'} maxLabel={isZh ? '最多' : 'Max'}
        disabled={disabled} accent="sky"
      />
      <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">{hint}</div>
    </div>
  );
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs">
    <span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span>
    <span className="text-gray-800 dark:text-gray-200 break-all">{value}</span>
  </div>
);
