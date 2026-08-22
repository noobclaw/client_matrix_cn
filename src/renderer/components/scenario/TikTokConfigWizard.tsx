/**
 * TikTokConfigWizard — 独立 3-step wizard,镜像 YoutubeConfigWizard:
 *
 *   Step 1 — 人设
 *   Step 2 — 互动数量 (3 个 min/max 滑条: 点赞 / 关注 / 评论) + 评论提示词 + 安全提示
 *   Step 3 — 调度 pills + 摘要 + 创建
 *
 * 跟 YoutubeConfigWizard 的差异:
 *   - 关注 (follow) 而不是订阅 (subscribe)
 *   - 主色 cyan (避开 TikTok brand pink + 跟其它平台色区分)
 *   - 字段 enable_follow / daily_follow_min / daily_follow_max
 *
 * 字段隔离 — 不读其它平台的 KOL pool / track,完全独立避免 UI 串台。
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
// like 30 / follow 20 / comment 50。之前 5 / 15 是过度保守,跟 Twitter 不
// 对齐用户配多平台时区间感会很别扭。
const LIKE_HARDCAP = 500;
const FOLLOW_HARDCAP = 100;
const COMMENT_HARDCAP = 100;

// ── TikTok tracks ──
// v5.x+: tracks 优先从 backend manifest.tracks 下发(可热更新关键词不需打新版)。
// 下面是 fallback,scenario.tracks 缺失时用,确保新 client 装到老 backend 仍能跑。
type TiktokTrack = { id: string; icon: string; name_zh: string; name_en?: string; keywords_zh: string[]; keywords_en?: string[] };
const TIKTOK_TRACKS_FALLBACK: TiktokTrack[] = [
  { id: 'dance', icon: '💃', name_zh: '舞蹈 · 翻跳',
    keywords_zh: ['舞蹈翻跳', 'kpop 舞蹈', '抖音舞蹈', '编舞', '热门舞蹈', '街舞'],
    keywords_en: ['dance challenge', 'kpop dance', 'tiktok dance', 'choreography', 'dance trend', 'viral dance'] },
  { id: 'comedy', icon: '😂', name_zh: '搞笑 · 段子',
    keywords_zh: ['搞笑', '段子', '反转', '神回复', '整蛊', '沙雕日常', 'fyp'],
    keywords_en: ['funny', 'comedy', 'meme', 'lol', 'reaction', 'prank', 'fyp'] },
  { id: 'food', icon: '🍜', name_zh: '美食 · 探店',
    keywords_zh: ['美食', '探店', '吃货', '街边小吃', '食谱', '做饭', 'asmr 美食'],
    keywords_en: ['food', 'restaurant review', 'foodie', 'street food', 'recipe', 'cooking', 'asmr food'] },
  { id: 'travel_intl', icon: '✈️', name_zh: '海外旅行',
    keywords_zh: ['海外旅行', '泰国', '日本', '巴厘岛', '东京', '韩国', '背包客', '一人旅行', '旅行 vlog'],
    keywords_en: ['travel', 'thailand', 'japan', 'bali', 'tokyo', 'korea', 'backpacking', 'solo travel', 'vlog travel'] },
  { id: 'diy_hacks', icon: '🔧', name_zh: '生活妙招',
    keywords_zh: ['生活妙招', 'diy', '清洁妙招', '收纳', '小技巧', '厨房妙招'],
    keywords_en: ['life hack', 'diy', 'cleaning hack', 'organization', 'tips', 'kitchen hack', 'gadget review'] },
  { id: 'pet', icon: '🐶', name_zh: '萌宠日常',
    keywords_zh: ['猫咪', '狗子', '小狗', '小猫', '萌宠', '猫奴', '狗狗才艺'],
    keywords_en: ['cat', 'dog', 'puppy', 'kitten', 'cute pet', 'cat lover', 'dog tricks', 'pet'] },
  { id: 'fashion', icon: '👗', name_zh: '穿搭 · 时尚',
    keywords_zh: ['穿搭', 'ootd', '时尚', '二手淘货', '风格分享', '街头风'],
    keywords_en: ['outfit', 'ootd', 'fashion', 'thrift haul', 'styling', 'street style', 'capsule wardrobe'] },
  { id: 'tech_short', icon: '📱', name_zh: '科技 · 数码短视频',
    keywords_zh: ['科技', 'iPhone 技巧', 'app 推荐', '数码', '效率工具'],
    keywords_en: ['tech', 'iphone tips', 'app review', 'gadget', 'productivity hack', 'phone tricks'] },
  { id: 'games', icon: '🎮', name_zh: '游戏',
    keywords_zh: ['游戏', '王者荣耀', '原神', '手游', '游戏攻略', '主机游戏', '游戏剪辑'],
    keywords_en: ['gaming', 'gameplay', 'minecraft', 'fortnite', 'valorant', 'roblox', 'speedrun', 'mobile game'] },
  { id: 'anime', icon: '🍥', name_zh: '二次元 · 动漫',
    keywords_zh: ['二次元', '动漫', 'cosplay', '国漫', '日漫', '番剧推荐', '手办', '萌系'],
    keywords_en: ['anime', 'manga', 'cosplay', 'otaku', 'anime edit', 'anime opening', 'jpop anime', 'anime amv'] },
  { id: 'movies_tv', icon: '🎬', name_zh: '影视 · 解说',
    keywords_zh: ['电影解说', '电视剧推荐', '影评', '美剧', '韩剧', '影视剪辑', '高分电影'],
    keywords_en: ['movie review', 'tv show', 'netflix', 'movie scene', 'film analysis', 'movie clip', 'series recap'] },
  { id: 'short_drama', icon: '🎭', name_zh: '小剧场',
    keywords_zh: ['短剧', '沙雕短剧', '反转剧情', '校园剧', '都市情感', '搞笑短剧'],
    keywords_en: ['short drama', 'mini drama', 'plot twist', 'storytime', 'short film', 'skit', 'pov'] },
  { id: 'sports', icon: '⚽', name_zh: '体育',
    keywords_zh: ['篮球', '足球', '健身', '跑步', '羽毛球', '体育赛事', 'NBA'],
    keywords_en: ['basketball', 'football', 'soccer', 'workout', 'gym', 'nba', 'sports highlights', 'training tips'] },
  { id: 'car', icon: '🚗', name_zh: '汽车',
    keywords_zh: ['汽车测评', '新车试驾', 'SUV', '新能源汽车', '改装车', '特斯拉', '比亚迪'],
    keywords_en: ['car review', 'tesla', 'electric car', 'supercar', 'car detailing', 'auto trends', 'car mods'] },
];

export const TikTokConfigWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;

  const [step, setStep] = useState<WizardStep>(1);

  // ── Track + keywords (replaces persona in v5.x) ──
  // i18n: zh / zh-TW 客户端默认填中文 keywords,其他语言填英文。
  // tracks 优先取 backend 下发的 scenario.tracks,缺失时用本地 fallback。
  const lang = i18nService.currentLanguage;
  const langKey: 'zh' | 'en' = (lang === 'zh' || lang === 'zh-TW') ? 'zh' : 'en';
  const TRACKS: TiktokTrack[] = (scenario as any).tracks && (scenario as any).tracks.length > 0
    ? (scenario as any).tracks as TiktokTrack[]
    : TIKTOK_TRACKS_FALLBACK;
  const trackName = (t: TiktokTrack): string => langKey === 'en' ? (t.name_en || t.name_zh) : t.name_zh;
  const trackKeywords = (t: TiktokTrack): string[] => langKey === 'en' ? (t.keywords_en || t.keywords_zh) : t.keywords_zh;
  const initialTrackId = ((initialTask as any)?.track as string)
    || (TRACKS.find(t => t.id === 'dance')?.id || TRACKS[0].id);
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
  const [folMin, setFolMinRaw] = useState<number>(
    typeof (initialTask as any)?.daily_follow_min === 'number' ? (initialTask as any).daily_follow_min : 0
  );
  const [folMax, setFolMaxRaw] = useState<number>(
    typeof (initialTask as any)?.daily_follow_max === 'number' ? (initialTask as any).daily_follow_max : 3
  );
  const setFolMin = (v: number) => {
    const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v));
    setFolMinRaw(n);
    setFolMaxRaw(prev => (prev < n ? n : prev));
  };
  const setFolMax = (v: number) => {
    const n = Math.max(0, Math.min(FOLLOW_HARDCAP, v));
    setFolMaxRaw(n);
    setFolMinRaw(prev => (prev > n ? n : prev));
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

  // commentPrompt 已从 wizard 移除 (v5.x): AI 按 video metadata + track + keyword 自动写,不需要用户填提示词。

  const dailyTime = useMemo(() => {
    if (initialTask?.daily_time) return String(initialTask.daily_time);
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [initialTask]);
  const [runInterval, setRunInterval] = useState<string>(
    ((initialTask as any)?.run_interval as string) || 'daily_random'
  );

  // v5.x+: 使用条款默认勾选,UI 上仍保留 checkbox 让用户可见。
  const [termsAccepted, setTermsAccepted] = useState<boolean[]>([true, true]);
  const allTermsAccepted = termsAccepted.every(Boolean);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const totalMaxActions = likeMax + folMax + cmtMax;

  useEffect(() => {
    if (saveError) setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, keywordsText, likeMin, likeMax, folMin, folMax, cmtMin, cmtMax, runInterval]);

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
        daily_count: Math.max(1, totalMaxActions),
        variants_per_post: 1,
        daily_time: dailyTime,
        run_interval: runInterval,
        daily_like_min: likeMin,
        daily_like_max: likeMax,
        daily_follow_min: folMin,
        daily_follow_max: folMax,
        daily_comment_min: cmtMin,
        daily_comment_max: cmtMax,
        comment_prompt: '',
      });
    } catch (err) {
      console.error('[TikTokConfigWizard] save failed:', err);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
          <div className="text-base font-semibold dark:text-white">
            🎵 {editing
              ? (isZh ? '编辑 TikTok 互动任务' : 'Edit TikTok Engagement Task')
              : (isZh ? '配置 TikTok 互动涨粉' : 'Configure TikTok Engage & Grow')}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full border border-cyan-500/40 text-cyan-500 bg-cyan-500/5">
              {isZh ? `第 ${step} / 3 步` : `Step ${step} / 3`}
            </span>
            <button type="button" onClick={onCancel} disabled={saving}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors" aria-label="close">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

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
                    className="w-full appearance-none rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2.5 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40 cursor-pointer"
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
                <div className="mb-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-cyan-500/30 bg-cyan-500/5 text-cyan-700 dark:text-cyan-300">
                  ✨ {isZh
                    ? <>关键词决定<strong>会去搜哪些视频做互动</strong>。预填的是各赛道高流量词,可按你账号定位增删。</>
                    : <>Keywords decide <strong>which videos get engaged with</strong>. Pre-filled with each track's high-traffic terms.</>}
                </div>
                <textarea
                  value={keywordsText}
                  onChange={e => setKeywordsText(e.target.value)}
                  placeholder={isZh ? '用空格或逗号分隔,越多越好' : 'Space or comma separated'}
                  rows={5}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40 resize-y"
                  disabled={saving}
                />
                <div className="text-[11px] text-gray-400 mt-1">
                  {isZh ? '当前 ' + parsedKeywords.length + ' 个关键词' : parsedKeywords.length + ' keywords'}
                </div>
              </div>
            </>
          )}

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
                label={isZh ? '每次运行关注数量' : 'Follows per run'}
                min={folMin} max={folMax} setMin={setFolMin} setMax={setFolMax}
                hardCap={FOLLOW_HARDCAP} hint={isZh ? `每次随机关注 ${folMin}-${folMax} 个作者 (0-${FOLLOW_HARDCAP},关注是 TikTok 风控最严的动作,建议保守)` : `Random ${folMin}-${folMax} follows (0-${FOLLOW_HARDCAP}, this is TikTok's most-flagged action — keep low)`}
                disabled={saving}
              />

              <RangeSlider
                label={isZh ? '每次运行评论数量' : 'Comments per run'}
                min={cmtMin} max={cmtMax} setMin={setCmtMin} setMax={setCmtMax}
                hardCap={COMMENT_HARDCAP} hint={isZh ? `每次随机发 ${cmtMin}-${cmtMax} 条评论 (0-${COMMENT_HARDCAP},内容由 AI 按下方提示词生成,语言会自动匹配视频与评论区)` : `Random ${cmtMin}-${cmtMax} comments (0-${COMMENT_HARDCAP}, AI writes from prompt below; language auto-matches video & comments)`}
                disabled={saving}
              />

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed space-y-1">
                <div className="font-semibold">⚠️ {isZh ? '安全提示' : 'Safety notes'}</div>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>{isZh ? '关注默认 0-3 — TikTok 对自动关注检测最严,长期跑建议保守' : 'Follow defaults to 0-3 — TikTok flags auto-follow most aggressively, keep low for long-term'}</li>
                  <li>{isZh ? '动作之间随机停 30 秒-3 分钟,模拟真人节奏' : 'Random 30s-3min between actions to mimic human cadence'}</li>
                </ul>
              </div>
            </>
          )}

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
                      key={opt.value} type="button"
                      onClick={() => setRunInterval(opt.value)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        runInterval === opt.value
                          ? 'border-cyan-500 bg-cyan-500/10 text-cyan-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-cyan-500/50'
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
                <SummaryRow label={isZh ? '关注数' : 'Follows'} value={`${folMin}-${folMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '评论数' : 'Comments'} value={`${cmtMin}-${cmtMax} / ${isZh ? '次' : 'run'}`} />
                <SummaryRow label={isZh ? '运行频率' : 'Frequency'} value={intervalLabel} />
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                  {isZh ? '使用条款' : 'Terms'}
                </div>
                {[
                  isZh
                    ? '我理解 NoobClaw 会在我本地浏览器代我浏览 tiktok.com,所有行为使用我自己的 IP 和账号'
                    : 'I understand NoobClaw browses tiktok.com inside my own browser using my IP and my account.',
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
                      className="mt-0.5 h-4 w-4 accent-cyan-500 cursor-pointer shrink-0"
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
          {step < 3 ? (
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
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-cyan-500 text-white hover:bg-cyan-600 disabled:opacity-50"
              title={!canAdvance[step].ok ? canAdvance[step].reason : undefined}
            >{isZh ? '下一步' : 'Next'} →</button>
          ) : (
            <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-cyan-500 text-white hover:bg-cyan-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >{saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '🎵 ' + (isZh ? '创建任务' : 'Create Task'))}</button>
          )}
        </div>
      </div>
    </div>
  );
};

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
        disabled={disabled} accent="cyan"
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
