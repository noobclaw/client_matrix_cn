/**
 * DouyinConfigWizard — 独立 3-step wizard,镜像 TikTokConfigWizard:
 *
 *   Step 1 — 人设
 *   Step 2 — 互动数量 (3 个 min/max 滑条: 点赞 / 关注 / 评论) + 评论提示词 + 安全提示
 *   Step 3 — 调度 pills + 摘要 + 创建
 *
 * 跟 TikTokConfigWizard 的差异:
 *   - 主色 violet (避开 brand red)
 *   - 评论描述提到中文为主 (抖音受众主要中文,不强调跨语言匹配)
 *   - emoji 🎵 → 🎶
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
// like 30 / follow 20 / comment 50。
const LIKE_HARDCAP = 500;
const FOLLOW_HARDCAP = 100;
const COMMENT_HARDCAP = 100;

// ── Douyin tracks ──
// v5.x+: 优先从 backend manifest.tracks 下发(可热更不需打新版)。下面的 fallback
// 在 scenario.tracks 缺失时使用,确保新 client 装到老 backend 也能工作。
// 海外直播必须放第一位 — 用户要求,抖音 2026 高流量新品类。
// 抖音几乎全中文素材,keywords_en 不必填(英文用户搜中文也能命中)。
type DouyinTrack = { id: string; icon: string; name_zh: string; name_en?: string; keywords_zh: string[]; keywords_en?: string[] };
const DOUYIN_TRACKS_FALLBACK: DouyinTrack[] = [
  // 关键词池跟 backend/scenarios/douyin_auto_engage/manifest.json 的 tracks
  // 严格保持一致(canonical 来源在 manifest)。orchestrator 每次任务只用
  // attemptKeywords[0] 一个关键词,池子越大重复率越低 — 22 个池 1/22 ≈ 4.5%
  // 比之前 9 个池 1/9 ≈ 11% 好 2.5x。
  { id: 'overseas_live', icon: '🌍', name_zh: '海外直播', name_en: 'Overseas Live',
    keywords_zh: ['海外直播', '海外华人', '海外生活', '海外探店', '海外街景', '海外吃播', '海外日常', 'TikTok 直播', '海外购物', '海外旅游', '海外见闻', '海外学习', '外贸创业', '海外婚礼', '海外移民', '海外购车', '海外买房', '海外打工', '留学生活', '国外超市', '国外房租', '国外医疗'] },
  { id: 'food', icon: '🍜', name_zh: '美食 · 探店', name_en: 'Food',
    keywords_zh: ['美食探店', '本地美食', '街边小吃', '网红餐厅', '探店打卡', '吃播', '夜市', '深夜食堂', '人均消费', '私房菜', '自助餐', '火锅', '烧烤', '早餐', '甜品店', '日料店', '韩餐', '烘焙', '农家菜', '米其林', '地方特色', '下午茶', '便当', '外卖测评'] },
  { id: 'daily_vlog', icon: '📷', name_zh: '生活 · vlog', name_en: 'Daily Vlog',
    keywords_zh: ['vlog', '日常分享', '一人居', '工作日常', '生活记录', '周末 vlog', '搬家', '装修日记', '城市 vlog', '单身日常', '学生日常', '上班族日常', '程序员日常', '老师日常', '医生日常', '妈妈日常', '创业日常', '退休生活', '都市生活', '晨间 routine', '夜间 routine', '情侣日常'] },
  { id: 'pet', icon: '🐶', name_zh: '萌宠日常', name_en: 'Pets',
    keywords_zh: ['宠物日常', '猫咪', '狗子', '田园猫', '柯基', '布偶', '橘猫', '萌宠', '养宠新手', '金毛', '二哈', '中华田园犬', '拉布拉多', '仓鼠', '兔子', '鹦鹉', '蛇', '蜥蜴', '宠物美容', '宠物医院', '宠物训练', '宠物搞笑', '猫狗日常', '异宠'] },
  { id: 'music_dance', icon: '🎵', name_zh: '音乐 · 舞蹈', name_en: 'Music & Dance',
    keywords_zh: ['翻唱', '抖音神曲', '舞蹈翻跳', 'kpop 舞', '原创歌曲', '吉他弹唱', '钢琴', '电音', '街舞', '民谣', '摇滚', '古风', '民乐', '笛子', '古筝', '爵士', '翻跳', '现代舞', '中国舞', '民族舞', '街头表演', '音乐 mv'] },
  { id: 'knowledge', icon: '🧠', name_zh: '知识 · 科普', name_en: 'Knowledge',
    keywords_zh: ['知识分享', '科普', '冷知识', '一分钟讲透', '历史', '心理学', '健康知识', '财经科普', '科技', '物理', '化学', '生物', '编程入门', 'AI 科普', '哲学', '法律', '医学', '教育', '育儿知识', '宇宙天文', '考古', '地理'] },
  { id: 'comedy', icon: '😂', name_zh: '搞笑 · 段子', name_en: 'Comedy',
    keywords_zh: ['搞笑', '段子', '反转', '沙雕日常', '抖音笑话', '剧情', '恶搞', '神回复', '配音', '脱口秀', '情景剧', '老板系列', '同事系列', '父母段子', '兄弟段子', '沙雕情侣', '翻车现场', '迷惑行为', '学生段子', '外卖段子'] },
  { id: 'parenting', icon: '👶', name_zh: '母婴 · 亲子', name_en: 'Parenting',
    keywords_zh: ['宝宝日常', '亲子', '辅食', '育儿', '早教', '幼儿园', '萌娃', '孕期', '产后', '带娃', '宝爸', '二胎', '三胎', '月子', '母乳喂养', '婴儿游泳', '新生儿', '宝宝穿搭', '宝妈日常', '亲子游戏', '孩子教育'] },
  { id: 'games', icon: '🎮', name_zh: '游戏', name_en: 'Gaming',
    keywords_zh: ['游戏直播', '王者荣耀', '原神', '和平精英', '手游推荐', '游戏攻略', '主机游戏', '单机游戏', '游戏剪辑', 'lol', '英雄联盟', '永劫无间', '蛋仔派对', '我的世界', '三国杀', '棋牌游戏', '模拟经营', '二次元手游', '派对游戏', 'Steam 游戏', '电竞解说'] },
  { id: 'anime', icon: '🍥', name_zh: '二次元', name_en: 'Anime',
    keywords_zh: ['二次元', '动漫推荐', 'cosplay', '国漫', '日漫', '番剧', '手办', '萌系', '动画剪辑', '异世界', '校园番', '治愈番', '战斗番', '国漫推荐', '漫展', '漫画解读', 'vtuber', '番剧解说', '声优', '动漫 amv', '周边开箱', '二次元配音'] },
  { id: 'movies_tv', icon: '🎬', name_zh: '影视 · 解说', name_en: 'Movie & TV',
    keywords_zh: ['电影解说', '电视剧推荐', '影评', '看片', '国产剧', '韩剧', '美剧', '影视剪辑', '高分电影', '热播剧', '科幻片', '悬疑片', '恐怖片', '喜剧片', '文艺片', '纪录片', '综艺', '真人秀', '经典电影', '院线电影', '短视频解说', '影视吐槽'] },
  { id: 'short_drama', icon: '🎭', name_zh: '小剧场', name_en: 'Mini Drama',
    keywords_zh: ['短剧', '沙雕短剧', '反转剧情', '校园剧', '都市情感', '古装短剧', '搞笑短剧', '悬疑短剧', '穿越短剧', '重生短剧', '总裁短剧', '言情短剧', '复仇短剧', '霸总短剧', '爽剧', '甜宠短剧', '战神短剧', '豪门短剧'] },
  { id: 'sports', icon: '⚽', name_zh: '体育', name_en: 'Sports',
    keywords_zh: ['篮球', '足球', '健身', '跑步', '羽毛球', '乒乓球', '体育赛事', '运动技巧', 'NBA', '世界杯', '网球', '排球', '滑板', '攀岩', '游泳', '射箭', '武术', '健美', '极限运动', '马拉松', '电竞', '高尔夫', '格斗'] },
  { id: 'travel', icon: '✈️', name_zh: '旅行', name_en: 'Travel',
    keywords_zh: ['旅行 vlog', '国内旅游', '自驾游', '周末游', '民宿推荐', '景点打卡', '小众目的地', '城市攻略', 'citywalk', '露营', '高铁游', '西藏', '新疆', '云南', '海南', '川藏线', '318 国道', '穷游攻略', '亲子游', '古镇游', '海岛游', '美食旅行'] },
  { id: 'car', icon: '🚗', name_zh: '汽车', name_en: 'Cars',
    keywords_zh: ['汽车测评', '新车试驾', 'SUV', '新能源汽车', '改装车', '二手车', '汽车文化', '比亚迪', '特斯拉', '性能车', '老车收藏', '摩托车', '改装件', '越野车', '房车', '卡车', '试驾感受', '汽车维修', '汽车保养', '豪车评测', '国产车', '合资车'] },
  { id: 'beauty_outfit', icon: '💄', name_zh: '美妆穿搭', name_en: 'Beauty & Outfit',
    keywords_zh: ['美妆教程', '穿搭', '护肤', '口红试色', '平价好物', '通勤穿搭', 'ootd', '气质穿搭', '彩妆', '发型', '染发', '美甲', '香水', '鞋子推荐', '包包推荐', '配饰', '大码穿搭', '微胖穿搭', '学生穿搭', '约会穿搭', '韩系穿搭', '日系穿搭', '复古风'] },
];

export const DouyinConfigWizard: React.FC<Props> = ({
  scenario,
  initialTask,
  onCancel,
  onSave,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const editing = !!initialTask;

  // 本 wizard 被抖音 / 快手 / 哔哩哔哩三个互动涨粉场景共用,标签/域名靠
  // scenario.platform 自适配,避免快手/B站任务上显示"抖音"字样。
  const plat = (scenario.platform as any) as 'douyin' | 'kuaishou' | 'bilibili';
  const platLabelZh = plat === 'kuaishou' ? '快手' : plat === 'bilibili' ? '哔哩哔哩' : '抖音';
  const platLabelEn = plat === 'kuaishou' ? 'Kuaishou' : plat === 'bilibili' ? 'Bilibili' : 'Douyin';
  const platDomain = plat === 'kuaishou' ? 'kuaishou.com' : plat === 'bilibili' ? 'bilibili.com' : 'douyin.com';

  const [step, setStep] = useState<WizardStep>(1);

  // ── Track + keywords (replaces persona in v5.x) ──
  // tracks 优先取 backend 下发的 scenario.tracks,缺失时用本地 fallback。
  // i18n: zh/zh-TW 用 keywords_zh,其他语言用 keywords_en (抖音几乎全中文,
  // keywords_en 多半 fallback 到 keywords_zh)。
  const lang = i18nService.currentLanguage;
  const langKey: 'zh' | 'en' = (lang === 'zh' || lang === 'zh-TW') ? 'zh' : 'en';
  const TRACKS: DouyinTrack[] = (scenario as any).tracks && (scenario as any).tracks.length > 0
    ? (scenario as any).tracks as DouyinTrack[]
    : DOUYIN_TRACKS_FALLBACK;
  const trackName = (t: DouyinTrack): string => langKey === 'en' ? (t.name_en || t.name_zh) : t.name_zh;
  const trackKeywords = (t: DouyinTrack): string[] => langKey === 'en' ? (t.keywords_en || t.keywords_zh) : t.keywords_zh;
  const initialTrackId = ((initialTask as any)?.track as string)
    || (TRACKS.find(t => t.id === 'overseas_live')?.id || TRACKS[0].id);
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

  // commentPrompt 已从 wizard 移除 (v5.x): AI 按 video metadata + track + keyword 自动写。

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
      console.error('[DouyinConfigWizard] save failed:', err);
      setSaveError(String(err instanceof Error ? err.message : err) || (isZh ? '保存失败,请重试' : 'Save failed, please retry'));
    } finally {
      setSaving(false);
    }
  };

  const intervalLabel = useMemo(() => {
    const m: Record<string, string> = {
      'once': isZh ? '不重复（手动触发）' : 'Once (manual only)',
      '30min': isZh ? '每 30 分钟' : 'Every 30min',
      '1h': isZh ? '每小时' : 'Hourly',
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
            {scenario.icon || '🎶'} {editing
              ? (isZh ? `编辑${platLabelZh}互动任务` : `Edit ${platLabelEn} Engagement Task`)
              : (isZh ? `配置${platLabelZh}互动涨粉` : `Configure ${platLabelEn} Engage & Grow`)}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs px-2.5 py-1 rounded-full border border-violet-500/40 text-violet-500 bg-violet-500/5">
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
                    className="w-full appearance-none rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 pl-3 pr-9 py-2.5 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/40 cursor-pointer"
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
                <div className="mb-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300">
                  ✨ {isZh
                    ? <>关键词决定<strong>会去搜哪些视频做互动</strong>。预填的是各赛道高流量词,可按你账号定位增删。</>
                    : <>Keywords decide <strong>which videos get engaged with</strong>. Pre-filled with each track's high-traffic terms.</>}
                </div>
                <textarea
                  value={keywordsText}
                  onChange={e => setKeywordsText(e.target.value)}
                  placeholder={isZh ? '用空格或逗号分隔,越多越好' : 'Space or comma separated'}
                  rows={5}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-violet-500/40 resize-y"
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
                hardCap={FOLLOW_HARDCAP} hint={isZh ? `每次随机关注 ${folMin}-${folMax} 个作者 (0-${FOLLOW_HARDCAP},关注是${platLabelZh}风控最严的动作,建议保守)` : `Random ${folMin}-${folMax} follows (0-${FOLLOW_HARDCAP}, this is ${platLabelEn}'s most-flagged action — keep low)`}
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
                  <li>{isZh ? `关注默认 0-3 — ${platLabelZh}对自动关注检测最严,长期跑建议保守` : `Follow defaults to 0-3 — ${platLabelEn} flags auto-follow most aggressively, keep low for long-term`}</li>
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
                {/* 运行频率对齐币安互动款:6 选项 + 固定间隔的随机抖动说明。
                   调度内核 computeNextPlannedRun 已对各间隔加真随机(30min/1h →+0-10分,
                   3h/6h →+0-45分,每日随机 →全天随机),这里把它显示出来。 */}
                <div className="flex gap-2 flex-wrap">
                  {[
                    { value: 'once',         label: isZh ? '不重复（手动触发）' : 'Once (manual only)' },
                    { value: '30min',        label: isZh ? '每 30 分钟' : 'Every 30min' },
                    { value: '1h',           label: isZh ? '每小时' : 'Hourly' },
                    { value: '3h',           label: isZh ? '每 3 小时' : 'Every 3h' },
                    { value: '6h',           label: isZh ? '每 6 小时' : 'Every 6h' },
                    { value: 'daily_random', label: isZh ? '每日随机时间' : 'Daily (random time)' },
                  ].map(opt => (
                    <button
                      key={opt.value} type="button"
                      onClick={() => setRunInterval(opt.value)}
                      className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                        runInterval === opt.value
                          ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium'
                          : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'
                      }`}
                    >{opt.label}</button>
                  ))}
                </div>
                {runInterval === 'daily_random' && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {isZh
                      ? '✨ 推荐 — 每天在随机时间触发一次,比固定钟点更像真人,也最不容易被风控判机器人。'
                      : '✨ Recommended — fires once daily at a randomized time; more human-like and least likely to be flagged.'}
                  </p>
                )}
                {(runInterval === '30min' || runInterval === '1h' || runInterval === '3h' || runInterval === '6h') && (
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1.5">
                    {(() => {
                      const isLong = runInterval === '3h' || runInterval === '6h';
                      const range = isLong ? '1-45' : '1-10';
                      return isZh
                        ? `⚠️ 到点后再加 ${range} 分钟随机延迟,避免精准卡点`
                        : `⚠️ +${range}min jitter after threshold (anti-detection).`;
                    })()}
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
                    ? `我理解 NoobClaw 会在我本地浏览器代我浏览 ${platDomain},所有行为使用我自己的 IP 和账号`
                    : `I understand NoobClaw browses ${platDomain} inside my own browser using my IP and my account.`,
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
                      className="mt-0.5 h-4 w-4 accent-violet-500 cursor-pointer shrink-0"
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
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50"
              title={!canAdvance[step].ok ? canAdvance[step].reason : undefined}
            >{isZh ? '下一步' : 'Next'} →</button>
          ) : (
            <button type="button" onClick={handleSave} disabled={saving || !allTermsAccepted}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >{saving
              ? (isZh ? '保存中...' : 'Saving...')
              : (editing ? (isZh ? '✓ 保存修改' : '✓ Save Changes') : '🎶 ' + (isZh ? '创建任务' : 'Create Task'))}</button>
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
        disabled={disabled} accent="violet"
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
