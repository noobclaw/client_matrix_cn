/**
 * BinanceWorkflowsPage — 币安广场 (Binance Square) 平台工作流页面.
 *
 * 结构镜像 XWorkflowsPage:
 *   - 卡片 grid (目前 2 张: 互动涨粉 + 自动发帖)
 *   - 底部特色 pills 条
 *   - 无 hero 介绍 (之前版本有,用户反馈冗余,与 X/XHS 页面对齐后去掉)
 *
 * v1 scenarios:
 *   binance_square_auto_engage   — 关注 KOL + 热门帖互动 (敬请期待)
 *   binance_square_post_creator  — 每日 1 条加密快评带 cashtag
 *
 * Card order 按用户要求: 互动涨粉/回复 放前面,发帖 放后面。
 */

import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { type Scenario, type Task, type Draft } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { noobClawAuth } from '../../services/noobclawAuth';
import { SourcePickerModal, type RepostSource } from './SourcePickerModal';

interface Props {
  scenarios: Scenario[];           // already filtered to platform='binance' by parent
  tasks: Task[];
  draftsByTask: Map<string, Draft[]>;
  loading: boolean;
  onOpenTask: (task_id: string, fromOverride?: 'create' | 'tasks' | 'history') => void;
  onConfigure: (scenario: Scenario) => void;
  onChanged?: () => void | Promise<void>;
  onGoToMyTasks?: () => void;
}

export const BinanceWorkflowsPage: React.FC<Props> = ({
  scenarios,
  tasks,
  draftsByTask: _draftsByTask,
  loading,
  onOpenTask: _onOpenTask,
  onConfigure,
  onChanged: _onChanged,
  onGoToMyTasks,
}) => {
  const isZh = i18nService.currentLanguage === 'zh';
  const [loginModalReason, setLoginModalReason] = useState<string | null>(null);
  const [maxTasksModalOpen, setMaxTasksModalOpen] = useState(false);
  const [pendingScenario, setPendingScenario] = useState<Scenario | null>(null);
  // v6.x: 批量搬运扩展到 4 源 (X / XHS / Douyin / TikTok) — 卡点击先弹源选择器,
  // 选完后再走对应 secondaryPlatform 的 login 检查 + 对应 wizard。
  // 不存"已选源",因为 pendingScenario.id 已经唯一编码了源。
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);

  const MAX_TASKS = 5;

  // Fallback so the card opens the wizard before backend list arrives.
  const POST_CREATOR_FALLBACK: Scenario = {
    id: 'binance_square_post_creator',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场 · 自动发帖',
    name_en: 'Binance Square Auto Post',
    description_zh: '每日智能锁定近三周热门行业资讯,AI 深度创作引擎写一条踩点市场快评 + 智能配图,自动挂 cashtag 蹭到币种页主动流量。',
    description_en: 'Daily locks onto hot crypto news from the past 3 weeks — AI deep-creation engine crafts a sharp market take + smart imagery, auto-tagged with cashtags to surface in token-page traffic.',
    icon: '🔶',
    default_config: {
      keywords: ['BTC', 'ETH', 'SOL'],
      persona: '中文 web3 KOL,分享市场观察 / 链上数据 / 行业 alpha,语气克制、不喊单',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 0,
      min_scroll_delay_ms: 0, max_scroll_delay_ms: 0,
      read_dwell_min_ms: 0, read_dwell_max_ms: 0,
      max_run_duration_ms: 600000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };

  const postCreator =
    scenarios.find(s => s.id === 'binance_square_post_creator')
    || scenarios.find(s => (s.platform as any) === 'binance' && s.workflow_type === 'viral_production')
    || POST_CREATOR_FALLBACK;

  // v2.4.59: auto_engage 也加 fallback,避免 backend scenarios 异步加载完成前
  // 卡片是 disabled 状态(用户反馈"开始互动按钮要等几秒才亮")。
  const AUTO_ENGAGE_FALLBACK: Scenario = {
    id: 'binance_square_auto_engage',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'auto_reply' as any,
    category: 'engagement',
    name_zh: '币安广场 · 互动涨粉',
    name_en: 'Binance Square Engage & Grow',
    description_zh: '锁定币安广场上的加密 KOL,AI 写出有观点的深度回复 + 真实点赞,贴着真人节奏自然冒泡,提高被广场推荐流抓到的概率。',
    description_en: 'Locks onto Binance Square crypto KOLs — AI crafts opinionated replies and authentic likes, paced like a real user so the Square recommend engine picks you up.',
    icon: '🤝',
    default_config: {
      keywords: [],
      persona: '中文 web3 用户,关注 BTC/ETH/链上数据/DeFi/Memecoin',
      daily_count: 2,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 30,
      min_scroll_delay_ms: 1500, max_scroll_delay_ms: 3500,
      read_dwell_min_ms: 8000, read_dwell_max_ms: 18000,
      max_run_duration_ms: 7200000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };
  const autoEngage =
    scenarios.find(s => s.id === 'binance_square_auto_engage')
    || AUTO_ENGAGE_FALLBACK;

  // v4.25+ 第 3 张卡:推特搬运。跨 X + 币安两个 tab 跑。
  const FROM_X_REPOST_FALLBACK: Scenario = {
    id: 'binance_from_x_repost',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场 · 推特批量搬运',
    name_en: 'Binance Square · Repost from X',
    description_zh: '从推特 feed 挑带图/视频爆款,AI 进行深度改写为币安风格,图文/视频一并搬运上传,一键发到广场。运行期间占用 X + 币安两个标签页。',
    description_en: 'Pull viral image/video tweets from X, AI rewrite in Chinese Binance style, repost with original media (image + video). Locks both X + Binance tabs.',
    icon: '🔁',
    default_config: {
      keywords: [],
      persona: '中文 web3 KOL,搬运海外 alpha 并加上自己的锐评',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 30,
      min_scroll_delay_ms: 3000, max_scroll_delay_ms: 10000,
      read_dwell_min_ms: 10000, read_dwell_max_ms: 45000,
      max_run_duration_ms: 3600000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };
  const fromXRepost =
    scenarios.find(s => s.id === 'binance_from_x_repost')
    || FROM_X_REPOST_FALLBACK;

  // v4.31.18: 第 4 张卡 — 币安广场 · 推特链接仿写。手动一次性,粘 1-20 个推文 URL。
  const FROM_X_LINK_FALLBACK: Scenario = {
    id: 'binance_from_x_link',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场 · 推特链接仿写',
    name_en: 'Binance Square · From X Link',
    description_zh: '粘贴 1-20 个推文链接,AI 改写成币安风格短帖,原推图片/视频一并下载上传,逐条间隔发到币安广场。运行期间占用推特+币安两个标签页。',
    description_en: 'Paste 1-20 X tweet URLs. AI rewrites in Binance style with original media (image + video). One-shot.',
    icon: '🔗',
    default_config: {
      keywords: [],
      persona: '中文 web3 用户',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 0,
      min_scroll_delay_ms: 0, max_scroll_delay_ms: 0,
      read_dwell_min_ms: 5000, read_dwell_max_ms: 12000,
      max_run_duration_ms: 3600000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };
  const fromXLink =
    scenarios.find(s => s.id === 'binance_from_x_link')
    || FROM_X_LINK_FALLBACK;

  // v6.x: 3 个新搬运源 fallback。backend scenarios 待 PR2-4 落地。
  // 这里的 fallback 让 PR1 阶段 UI 可点,wizard 可保存。
  const FROM_XHS_VIRAL_FALLBACK: Scenario = {
    id: 'binance_from_xhs_viral',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场 · 小红书搬运',
    name_en: 'Binance Square · Repost from Xiaohongshu',
    description_zh: '按关键词检索小红书一周爆文(数据不够延半年),AI 改写,图文/视频(无水印)搬到币安。',
    description_en: 'Search Xiaohongshu by keywords (1-week, fallback 6-month), AI rewrite, repost image/video (watermark-free) to Binance.',
    icon: '📕',
    default_config: {
      keywords: [],
      persona: '中文 web3 KOL,搬运海外/国内 alpha 并加上自己的锐评',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 30,
      min_scroll_delay_ms: 3000, max_scroll_delay_ms: 10000,
      read_dwell_min_ms: 10000, read_dwell_max_ms: 45000,
      max_run_duration_ms: 3600000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };
  const fromXhsViral =
    scenarios.find(s => s.id === 'binance_from_xhs_viral')
    || FROM_XHS_VIRAL_FALLBACK;

  const FROM_DOUYIN_VIRAL_FALLBACK: Scenario = {
    id: 'binance_from_douyin_viral',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场 · 抖音搬运',
    name_en: 'Binance Square · Repost from Douyin',
    description_zh: '按关键词搜抖音(优先一周),AI 改写文案,视频去水印 + 图文一并搬到币安。',
    description_en: 'Search Douyin by keywords (prefer last week), AI rewrite, watermark-removed video + image-text repost to Binance.',
    icon: '🎵',
    default_config: {
      keywords: [],
      persona: '中文 web3 KOL,搬运海外/国内 alpha 并加上自己的锐评',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 30,
      min_scroll_delay_ms: 3000, max_scroll_delay_ms: 10000,
      read_dwell_min_ms: 10000, read_dwell_max_ms: 45000,
      max_run_duration_ms: 3600000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };
  const fromDouyinViral =
    scenarios.find(s => s.id === 'binance_from_douyin_viral')
    || FROM_DOUYIN_VIRAL_FALLBACK;

  // TikTok: 仅视频 (TikTok 无图文 feed)。Wizard 会 lock mediaFilter='video_only'。
  const FROM_TIKTOK_VIRAL_FALLBACK: Scenario = {
    id: 'binance_from_tiktok_viral',
    version: '1.0.0',
    platform: 'binance' as any,
    workflow_type: 'viral_production',
    category: 'creation',
    name_zh: '币安广场 · TikTok 搬运',
    name_en: 'Binance Square · Repost from TikTok',
    description_zh: '按英文关键词搜 TikTok,AI 改写文案(中/英可选),视频去水印搬到币安。仅视频。',
    description_en: 'Search TikTok by EN keywords, AI rewrite (zh/en optional), watermark-removed video repost to Binance. Video only.',
    icon: '🎬',
    default_config: {
      keywords: [],
      persona: '中文 web3 KOL,搬运海外/国内 alpha 并加上自己的锐评',
      daily_count: 1,
      variants_per_post: 1,
      schedule_window: '09:00-23:00',
    } as any,
    risk_caps: {
      max_daily_runs: 1, max_scroll_per_run: 30,
      min_scroll_delay_ms: 3000, max_scroll_delay_ms: 10000,
      read_dwell_min_ms: 10000, read_dwell_max_ms: 45000,
      max_run_duration_ms: 3600000, min_interval_hours: 24,
      weekly_rest_days: 1, cooldown_captcha_hours: 24,
      cooldown_rate_limit_hours: 48, cooldown_account_flag_hours: 72,
    },
    required_login_url: 'https://www.binance.com/square',
    entry_urls: {},
    skills: {},
  };
  const fromTiktokViral =
    scenarios.find(s => s.id === 'binance_from_tiktok_viral')
    || FROM_TIKTOK_VIRAL_FALLBACK;

  // (previously we polled running task ids to drive the inline running-glow
  //  on the "已有任务" list. That list was removed — MyTasksPage is the
  //  single source of truth for running state now. No polling needed here.)

  const handleStart = (scenario: Scenario) => {
    if (tasks.length >= MAX_TASKS) {
      setMaxTasksModalOpen(true);
      return;
    }
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }
    setPendingScenario(scenario);
    setLoginModalReason(scenario.id);
  };

  const handleLoginConfirmed = () => {
    setLoginModalReason(null);
    if (pendingScenario) {
      onConfigure(pendingScenario);
      setPendingScenario(null);
    }
  };

  // 用户在 SourcePickerModal 选了源后走这里:
  //   x       → 沿用原 binance_from_x_repost 流程 (推特保持现状)
  //   xhs     → binance_from_xhs_viral
  //   douyin  → binance_from_douyin_viral
  //   tiktok  → binance_from_tiktok_viral
  // 4 个都要再过一遍 LoginRequiredModal (币安 + 对应 secondaryPlatform)。
  const handleSourcePicked = (source: RepostSource) => {
    setSourcePickerOpen(false);
    const scenarioForSource: Scenario =
      source === 'x'      ? fromXRepost
      : source === 'xhs'    ? fromXhsViral
      : source === 'douyin' ? fromDouyinViral
      :                       fromTiktokViral;
    handleStart(scenarioForSource);
  };

  const tasksByScenario: Record<string, Task[]> = {};
  for (const t of tasks) {
    const key = t.scenario_id;
    if (!tasksByScenario[key]) tasksByScenario[key] = [];
    tasksByScenario[key].push(t);
  }

  // Binance brand colors
  const binanceGold = '#F0B90B';
  const binanceGoldLight = '#FCD535';
  const binanceDark = '#181A20';

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Scenario cards — same layout as X: jump straight to cards, no hero */}
      <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* v4.25.4: 推特搬运放第一个 — 主推卖点
            v6.x: 扩展到 4 源(X / XHS / Douyin / TikTok),点卡先弹 SourcePickerModal */}
        <BinanceCard
          emoji="🔁"
          badgeZh="批量搬运"
          badgeEn="Batch repost"
          titleZh="币安广场 · 批量搬运"
          titleEn="Binance Square · Batch Repost"
          descZh="从 X / 小红书 / 抖音 / TikTok 任选一个源挑爆款,AI 深度改写为币安风格,图文/视频(去水印)一并搬过来发。⚠️ 运行期间占用源平台 + 币安两个标签页,需双平台都登录。"
          descEn="Pull viral posts from X / Xiaohongshu / Douyin / TikTok, AI rewrite in Binance style, repost with original media (watermark-free). ⚠️ Locks source + Binance tabs while running."
          tagsLine={isZh ? '4 源可选 · 图文 + 视频 · 深度二创 · 去水印' : '4 sources · Image + video · Deep rewrite · Watermark-free'}
          ctaZh="立即开始"
          ctaEn="Get Started"
          enabled={true}
          loading={loading}
          scenario={fromXRepost}
          onStart={() => {
            if (tasks.length >= MAX_TASKS) {
              setMaxTasksModalOpen(true);
              return;
            }
            if (!noobClawAuth.getState().isAuthenticated) {
              noobClawAuth.requireLoginUI();
              return;
            }
            setSourcePickerOpen(true);
          }}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          binanceGold={binanceGold}
          binanceGoldLight={binanceGoldLight}
          binanceDark={binanceDark}
        />

        {/* Auto engage */}
        <BinanceCard
          emoji="💬"
          badgeZh="互动涨粉"
          badgeEn="Engage & Grow"
          titleZh="币安广场 · 互动涨粉"
          titleEn="Binance Square Engage & Grow"
          descZh="锁定币安广场上的加密 KOL，AI 写出有观点的深度回复 + 真实点赞，贴着真人节奏自然冒泡，提高被广场推荐流抓到的概率。"
          descEn="Locks onto Binance Square crypto KOLs — AI crafts opinionated replies and drops authentic likes, paced like a real user so the Square recommend engine picks you up."
          tagsLine={isZh ? '关注 · 回复 · 点赞 · 随机节奏' : 'Follow · Reply · Like · Randomized pacing'}
          ctaZh={autoEngage ? '开始互动' : '敬请期待'}
          ctaEn={autoEngage ? 'Start' : 'Coming Soon'}
          enabled={!!autoEngage}
          loading={loading}
          scenario={autoEngage}
          onStart={() => autoEngage && handleStart(autoEngage)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          binanceGold={binanceGold}
          binanceGoldLight={binanceGoldLight}
          binanceDark={binanceDark}
        />

        {/* Post creator — 描述加上"50% 接入爆文库改写"卖点 */}
        <BinanceCard
          emoji="📊"
          badgeZh="自动发帖"
          badgeEn="Daily post"
          titleZh="币安广场 · 自动发帖"
          titleEn="Binance Square Auto Post"
          descZh="每日智能锁定近三周热门行业资讯，AI 深度创作引擎写一条踩点市场快评 + 智能配图（源图直用或 AI 生图），自动挂 cashtag 蹭到币种页主动流量。"
          descEn="Daily locks onto hot crypto news from the past 3 weeks — AI deep-creation engine crafts a sharp market take with smart imagery (source thumbnail or AI-generated), auto-tagged with cashtags to surface in token-page traffic."
          tagsLine={isZh ? '🧠 Pro 深度引擎 · 资讯踩点 · 智能配图 · cashtag 导流' : '🧠 Pro deep engine · News-driven · Smart imagery · Cashtag traffic'}
          ctaZh="立即开始"
          ctaEn="Get Started"
          enabled={true}
          loading={loading}
          scenario={postCreator}
          onStart={() => handleStart(postCreator)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          binanceGold={binanceGold}
          binanceGoldLight={binanceGoldLight}
          binanceDark={binanceDark}
        />

        {/* v4.31.18: 第 4 张卡 — 推特链接仿写。手动一次,粘 1-20 个 URL */}
        <BinanceCard
          emoji="🔗"
          badgeZh="链接仿写"
          badgeEn="From URL"
          titleZh="币安广场 · 推特链接仿写"
          titleEn="Binance Square · From X Link"
          descZh="粘贴 1-20 个推文链接(支持图文/视频帖),AI 改写成币安风格,原推图片 / 视频一并下载上传,逐条间隔发到广场。⚠️ 跨双 tab,需双平台都登录。"
          descEn="Paste 1-20 X tweet URLs (image & video tweets both supported). AI rewrites in Binance style, reuses the tweet's original media. ⚠️ Locks both X + Binance tabs."
          tagsLine={isZh ? '手动一次性 · 1-20 链接 · 图文 + 视频复用' : 'One-shot · 1-20 URLs · Reuse image + video'}
          ctaZh="立即开始"
          ctaEn="Get Started"
          enabled={true}
          loading={loading}
          scenario={fromXLink}
          onStart={() => handleStart(fromXLink)}
          onGoToMyTasks={onGoToMyTasks}
          isZh={isZh}
          binanceGold={binanceGold}
          binanceGoldLight={binanceGoldLight}
          binanceDark={binanceDark}
        />
      </section>

      {/* Features pills — same compact design as X page */}
      <section className="mb-6">
        <div className="flex flex-wrap gap-2">
          {[
            { icon: '✨', zh: '深度二创', en: 'Deep AI rewrite' },
            { icon: '🎬', zh: '图文 + 视频全支持', en: 'Image + video both supported' },
            { icon: '💰', zh: '成本超低（百篇好文<$1）', en: 'Ultra-low cost (<$1 for 100 posts)' },
            { icon: '🛡️', zh: '严风控,完全模拟人类行为(动作间隔时间 + 随机)', en: 'Strict anti-detection, fully human-like (jittered intervals + randomization)' },
            { icon: '🚀', zh: '涨粉丝快(真实互动飞速涨粉)', en: 'Fast follower growth (real engagement → rapid gain)' },
          ].map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border text-gray-700 dark:text-gray-300"
              style={{
                borderColor: `${binanceGold}30`,
                background: `${binanceGold}10`,
              }}
            >
              {p.icon} {isZh ? p.zh : p.en}
            </span>
          ))}
        </div>
      </section>

      {/* "已有任务" 区块去掉 — 用户反馈底部冗余,我的任务 tab 已经有完整列表。
          Per X/XHS pages 也都没有这个区块,统一掉。 */}

      {/* Login gate — binance platform opens binance.com/square.
          v4.25.4: 推特搬运是跨 tab 任务,要同时检查 X tab。其他 binance scenario
          只检查 binance。
          v6.x: 批量搬运的 secondaryPlatform 跟着用户选的源走 (x/xhs/douyin/tiktok)。
          binance_from_x_link 沿用 x,因为只有粘链接没走源选择器。 */}
      {loginModalReason && (
        <LoginRequiredModal
          mode="create"
          platform="binance"
          secondaryPlatform={(() => {
            const id = pendingScenario?.id;
            if (id === 'binance_from_x_repost' || id === 'binance_from_x_link') return 'x';
            if (id === 'binance_from_xhs_viral') return 'xhs';
            if (id === 'binance_from_douyin_viral') return 'douyin';
            if (id === 'binance_from_tiktok_viral') return 'tiktok';
            return undefined;
          })() as any}
          onCancel={() => { setLoginModalReason(null); setPendingScenario(null); }}
          onConfirmed={handleLoginConfirmed}
        />
      )}

      {/* Source picker — 批量搬运卡的前置 modal。4 个源选其一。 */}
      {sourcePickerOpen && (
        <SourcePickerModal
          onPick={handleSourcePicked}
          onCancel={() => setSourcePickerOpen(false)}
        />
      )}

      {/* Max-tasks modal */}
      {maxTasksModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-6 pt-6 pb-2 text-center">
              <div className="text-4xl mb-3">📋</div>
              <h3 className="text-lg font-bold dark:text-white mb-1.5">
                {isZh ? '已达任务上限' : 'Task Limit Reached'}
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                {isZh
                  ? `币安广场已经有 ${tasks.length} 个任务了，最多支持 ${MAX_TASKS} 个`
                  : `You already have ${tasks.length} Binance Square tasks (max ${MAX_TASKS}).`}
                <br />
                {isZh
                  ? '可以先去看看现有任务,停用一些不需要的,再创建新的。'
                  : 'Open My Tasks to disable any you no longer need before creating a new one.'}
              </p>
            </div>
            <div className="px-6 py-4 flex gap-2">
              <button
                type="button"
                onClick={() => setMaxTasksModalOpen(false)}
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                {isZh ? '知道了' : 'Got it'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMaxTasksModalOpen(false);
                  if (onGoToMyTasks) onGoToMyTasks();
                }}
                className="flex-1 text-sm font-medium px-4 py-2 rounded-lg bg-gradient-to-r from-yellow-500 to-amber-500 text-white hover:opacity-90 transition-opacity shadow-sm">
                {isZh ? '去看看现有任务 →' : 'View My Tasks →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


// ── Binance scenario card sub-component ──

interface BinanceCardProps {
  emoji: string;
  badgeZh: string;
  badgeEn: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  tagsLine: string;
  ctaZh: string;
  ctaEn: string;
  enabled: boolean;
  loading: boolean;
  scenario: Scenario | null;
  onStart: () => void;
  onGoToMyTasks?: () => void;
  isZh: boolean;
  binanceGold: string;
  binanceGoldLight: string;
  binanceDark: string;
}

const BinanceCard: React.FC<BinanceCardProps> = ({
  emoji, badgeZh, badgeEn, titleZh, titleEn, descZh, descEn, tagsLine,
  ctaZh, ctaEn, enabled, loading, scenario: _scenario, onStart, onGoToMyTasks, isZh,
  binanceGold, binanceGoldLight, binanceDark,
}) => {
  const dim = !enabled;
  return (
    <div
      className="relative rounded-2xl p-6 overflow-hidden border transition-all hover:shadow-2xl"
      style={{
        background: dim
          ? `linear-gradient(135deg, ${binanceDark}80 0%, #1E202680 100%)`
          : `linear-gradient(135deg, ${binanceDark} 0%, #1E2026 100%)`,
        borderColor: dim ? '#2B3139' : `${binanceGold}30`,
      }}>
      <div
        className="absolute -top-12 -right-12 w-36 h-36 rounded-full pointer-events-none"
        style={{ background: `radial-gradient(circle, ${binanceGold}${dim ? '08' : '15'} 0%, transparent 70%)` }}
      />
      <div className={`relative flex flex-col h-full ${dim ? 'opacity-60' : ''}`}>
        <div className="inline-flex items-center gap-1.5 text-xs font-medium mb-2" style={{ color: binanceGoldLight }}>
          <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: binanceGoldLight }} />
          {isZh ? badgeZh : badgeEn}
        </div>
        <h3 className="text-lg font-bold text-white mb-1.5">
          {emoji} {isZh ? titleZh : titleEn}
        </h3>
        <p className="text-sm text-gray-400 leading-relaxed mb-3 flex-1">
          {isZh ? descZh : descEn}
        </p>
        <div className="text-xs font-mono mb-4" style={{ color: binanceGold }}>
          {tagsLine}
        </div>
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={!enabled || loading}
            className="flex-[7] text-sm font-semibold px-4 py-2.5 rounded-xl transition-all hover:brightness-110 active:brightness-95 shadow-md disabled:cursor-not-allowed disabled:hover:brightness-100"
            style={enabled
              ? {
                  background: `linear-gradient(135deg, ${binanceGold} 0%, ${binanceGoldLight} 100%)`,
                  color: binanceDark,
                }
              : {
                  background: '#2B3139',
                  color: '#6B7280',
                }}>
            {emoji} {isZh ? ctaZh : ctaEn} {enabled ? '→' : ''}
          </button>
          <button
            type="button"
            onClick={() => onGoToMyTasks?.()}
            className="flex-[3] px-2 py-2.5 text-xs font-medium rounded-xl text-gray-300 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors whitespace-nowrap"
          >
            {isZh ? '已有任务' : 'My tasks'} »
          </button>
        </div>
      </div>
    </div>
  );
};

export default BinanceWorkflowsPage;
