/**
 * Scenario service — thin renderer-side wrapper around window.electron.scenario.
 *
 * All scenario logic (discovery, extraction, composition, risk guard, draft
 * upload) lives in the main process. This file only exposes convenient
 * async methods so React components don't have to reach into window.electron
 * directly.
 */

import type {
  ScenarioManifestIPC,
  ScenarioTaskIPC,
  ScenarioDraftIPC,
  ScenarioRunOutcome,
  ScenarioPlatform,
  ScenarioWorkflowType,
  ScenarioTaskRun,
  ScenarioRunProgress,
  XhsLoginStatus,
} from '../types/scenario';
import { MATRIX_EDITION } from '../matrixEdition';
import { DEFAULT_SCENARIOS } from '../data/defaultScenarios';
import { noobClawAuth } from './noobclawAuth';

// 矩阵操作前置:未登录 NoobClaw 账号则弹登录窗,返回 false(拦在建/改/删/运行任务前)。
function ensureMatrixLogin(): boolean {
  if (noobClawAuth.getState().isAuthenticated) return true;
  noobClawAuth.requireLoginUI();
  return false;
}

export type Scenario = ScenarioManifestIPC;
export type Task = ScenarioTaskIPC;
export type Draft = ScenarioDraftIPC;
export type RunOutcome = ScenarioRunOutcome;

// ─────────────────────────────────────────────────────────────────────────
// 矩阵号(MATRIX_EDITION)适配层
//
// 真 ScenarioView 那套页面(列表/详情/进度/运行记录)全靠 scenarioService 这层
// 取数。矩阵号自成运行时(指纹内核池 + engageRunner + 本地 taskStore/runStore),
// 接口在 window.electron.matrix.*。这里把矩阵的数据形状【转换】成旧页面期望的
// ScenarioTaskIPC / ScenarioRunProgress / 运行记录,使真页面一行不改即可渲染矩阵
// 数据。详见记忆 project_matrix_reuse_scenario_pages。
// ─────────────────────────────────────────────────────────────────────────

const MX = (): any => (window as any).electron?.matrix;
const pad2 = (n: number) => String(n).padStart(2, '0');
const hhmmss = (ts: number) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };

// 矩阵 8 个「互动涨粉」平台 → 后端 backend/matrix/scenarios 的剧本 id(币安是 binance_square_auto_engage)。
// 之前 mxTaskToScenario 把所有平台任务都写成 'douyin_auto_engage' → ScenarioView 按
// scenario.platform 过滤 tab 时,非抖音任务全被归到抖音 tab、对应平台 tab 显示为空,
// 但 saveTask 是按真实 platform 存的 → 再建会撞 duplicate_type。这里按真实 platform 映射修正。
const MATRIX_ENGAGE_SCENARIO_ID: Record<string, string> = {
  douyin: 'douyin_auto_engage', xhs: 'xhs_auto_engage', kuaishou: 'kuaishou_auto_engage',
  bilibili: 'bilibili_auto_engage', x: 'x_auto_engage', binance: 'binance_square_auto_engage',
  youtube: 'youtube_auto_engage', tiktok: 'tiktok_auto_engage',
  // ⚠️ 新平台必须补进来:缺了会兜底成 douyin_auto_engage → 卡片/详情/运行记录全按「抖音」渲染(用户实测)。
  facebook: 'facebook_auto_engage', reddit: 'reddit_auto_engage', instagram: 'instagram_auto_engage',
};
const MATRIX_ENGAGE_ID_TO_PLATFORM: Record<string, string> =
  Object.fromEntries(Object.entries(MATRIX_ENGAGE_SCENARIO_ID).map(([p, id]) => [id, p]));
// 平台展示名/图标:给客户端快照里缺失的 engage 场景兜底。打包快照只从 backend/scenarios 生成,
// 而 xhs_auto_engage 只在 backend/matrix/scenarios → 快照里没有,不补就 lookup 不到 platform → tab 仍为空。
const MATRIX_ENGAGE_META: Record<string, { name_zh: string; icon: string }> = {
  douyin: { name_zh: '抖音 互动涨粉', icon: '🎶' }, xhs: { name_zh: '小红书 互动涨粉', icon: '📕' },
  kuaishou: { name_zh: '快手 互动涨粉', icon: '⚡' }, bilibili: { name_zh: '哔哩哔哩 互动涨粉', icon: '📺' },
  x: { name_zh: '推特 互动涨粉', icon: '🐦' }, binance: { name_zh: '币安广场互动涨粉', icon: '🤝' },
  youtube: { name_zh: 'YouTube 互动涨粉', icon: '▶️' }, tiktok: { name_zh: 'TikTok 互动涨粉', icon: '🎬' },
  facebook: { name_zh: 'Facebook 互动涨粉', icon: '👥' }, reddit: { name_zh: 'Reddit 互动涨粉', icon: '🟠' },
  instagram: { name_zh: 'Instagram 互动涨粉', icon: '📷' },
};
const engageScenarioIdForPlatform = (platform?: string): string =>
  (platform && MATRIX_ENGAGE_SCENARIO_ID[platform]) || 'douyin_auto_engage';

// 「自动回复粉丝」剧本(backend/matrix/scenarios/<platform>_reply_fans_comment)。目前 4 个平台有
// 剧本(xhs 逐篇笔记进详情页;抖音/快手/哔哩哔哩创作中心评论管理集中回复)。同 engage 一样需要补快照,
// 否则 reply_fan 任务的 scenario_id 在 listScenarios 里 lookup 不到 platform → 任务 tab 为空。
const MATRIX_REPLY_SCENARIO_ID: Record<string, string> = {
  xhs: 'xhs_reply_fans_comment', douyin: 'douyin_reply_fans_comment', kuaishou: 'kuaishou_reply_fans_comment',
  bilibili: 'bilibili_reply_fans_comment', toutiao: 'toutiao_reply_fans_comment',
  shipinhao: 'shipinhao_reply_fans_comment',
};
const MATRIX_REPLY_ID_TO_PLATFORM: Record<string, string> =
  Object.fromEntries(Object.entries(MATRIX_REPLY_SCENARIO_ID).map(([p, id]) => [id, p]));
const MATRIX_REPLY_META: Record<string, { name_zh: string; icon: string }> = {
  xhs: { name_zh: '小红书 自动回复粉丝', icon: '💌' }, douyin: { name_zh: '抖音 自动回复粉丝', icon: '💌' },
  kuaishou: { name_zh: '快手 自动回复粉丝', icon: '💌' }, bilibili: { name_zh: '哔哩哔哩 自动回复粉丝', icon: '💌' },
  toutiao: { name_zh: '头条号 自动回复粉丝', icon: '💌' }, shipinhao: { name_zh: '视频号 自动回复粉丝', icon: '💌' },
};

// 「视频无水印下载」剧本(backend/matrix/scenarios/<platform>_video_download)。单账号工具任务:
// 选 1 个号 + 粘贴多个链接,逐个下载。目前仅抖音。同样需补快照,否则任务 scenario_id lookup 不到 platform。
const MATRIX_DOWNLOAD_SCENARIO_ID: Record<string, string> = {
  douyin: 'douyin_video_download', kuaishou: 'kuaishou_video_download',
  bilibili: 'bilibili_video_download', tiktok: 'tiktok_video_download',
  xhs: 'xhs_video_download',
};
const MATRIX_DOWNLOAD_ID_TO_PLATFORM: Record<string, string> =
  Object.fromEntries(Object.entries(MATRIX_DOWNLOAD_SCENARIO_ID).map(([p, id]) => [id, p]));
const MATRIX_DOWNLOAD_META: Record<string, { name_zh: string; icon: string }> = {
  douyin: { name_zh: '抖音 视频无水印下载', icon: '⬇️' }, kuaishou: { name_zh: '快手 视频无水印下载', icon: '⬇️' },
  bilibili: { name_zh: '哔哩哔哩 视频无水印下载', icon: '⬇️' }, tiktok: { name_zh: 'TikTok 视频无水印下载', icon: '⬇️' },
  xhs: { name_zh: '小红书 视频无水印下载', icon: '⬇️' },
};

// 「图文创作」剧本(backend/matrix/scenarios/<platform>_image_text)。N 个号各自按身份生成图文+配图+发布。
// 目前仅抖音(小红书第二步)。同样需补快照,否则任务 scenario_id lookup 不到 platform。
const MATRIX_IMAGETEXT_SCENARIO_ID: Record<string, string> = {
  douyin: 'douyin_image_text', xhs: 'xhs_image_text', shipinhao: 'shipinhao_image_text',
  toutiao: 'toutiao_image_text',
};
const MATRIX_IMAGETEXT_ID_TO_PLATFORM: Record<string, string> =
  Object.fromEntries(Object.entries(MATRIX_IMAGETEXT_SCENARIO_ID).map(([p, id]) => [id, p]));
const MATRIX_IMAGETEXT_META: Record<string, { name_zh: string; icon: string }> = {
  douyin: { name_zh: '抖音 图文创作', icon: '📝' }, xhs: { name_zh: '小红书 图文创作', icon: '📝' },
  shipinhao: { name_zh: '视频号 图文创作', icon: '📝' }, toutiao: { name_zh: '头条号 图文创作', icon: '📝' },
};

// 「爆款批量仿写」剧本(backend/matrix/scenarios/<platform>_viral_production_career)。目前仅小红书。
const MATRIX_VIRAL_SCENARIO_ID: Record<string, string> = {
  xhs: 'xhs_viral_production_career',
};
const MATRIX_VIRAL_ID_TO_PLATFORM: Record<string, string> =
  Object.fromEntries(Object.entries(MATRIX_VIRAL_SCENARIO_ID).map(([p, id]) => [id, p]));
const MATRIX_VIRAL_META: Record<string, { name_zh: string; icon: string }> = {
  xhs: { name_zh: '小红书 爆款批量仿写', icon: '🔥' },
};

// 「自动发推」剧本(backend/matrix/scenarios/x_post)。N 个号各自 AI 原创一条推 + 可选配图 → 发到各自时间线。目前仅推特。
const MATRIX_TWEET_SCENARIO_ID: Record<string, string> = {
  x: 'x_post',
};
const MATRIX_TWEET_ID_TO_PLATFORM: Record<string, string> =
  Object.fromEntries(Object.entries(MATRIX_TWEET_SCENARIO_ID).map(([p, id]) => [id, p]));
const MATRIX_TWEET_META: Record<string, { name_zh: string; icon: string }> = {
  x: { name_zh: '推特 自动发推', icon: '🐦' },
};

// 「币安广场自动发帖」剧本(backend/matrix/scenarios/binance_post)。N 号各自抓 web3 资讯 AI 原创一条币安广场图文 + 可选配图 → 发币安广场。目前仅币安。
const MATRIX_BINANCE_SCENARIO_ID: Record<string, string> = {
  binance: 'binance_post',
};
const MATRIX_BINANCE_ID_TO_PLATFORM: Record<string, string> =
  Object.fromEntries(Object.entries(MATRIX_BINANCE_SCENARIO_ID).map(([p, id]) => [id, p]));
const MATRIX_BINANCE_META: Record<string, { name_zh: string; icon: string }> = {
  binance: { name_zh: '币安广场 自动发帖', icon: '📊' },
};

// 「币安广场批量搬运」剧本(backend/matrix/scenarios/binance_repost)。1 源平台采集号搜+下 → N 币安号各领一条仿写发。发布目标=币安,scenario_id 固定 'binance_repost'(非平台后缀)。
const MATRIX_REPOST_SCENARIO_ID = 'binance_repost';
const MATRIX_REPOST_PLATFORM = 'binance';

/** 矩阵任务 → 旧 ScenarioTaskIPC(赛道/关键词在账号上,task 这两个字段留空;
 *  配额映射到 daily_*_min/max 这套 douyin_auto_engage 字段)。 */
function mxTaskToScenario(t: any): ScenarioTaskIPC {
  const q = t?.quota || {};
  // 「自动回复粉丝」(type='reply_fan')任务:映射到对应平台的 *_reply_fans_comment 剧本 +
  //   track='reply_fan_comment',并带上引流语/概率 —— TaskDetailPage 靠这两个判定 isReplyFan
  //   并展示引流配置(funnel_phrase/funnel_probability);否则会被当互动任务、引流配置丢失。
  const isReply = t?.type === 'reply_fan';
  const isEngage = t?.type === 'engage';
  const isDownload = t?.type === 'video_download';
  const isImageText = t?.type === 'image_text';
  const isViral = t?.type === 'viral_rewrite';
  const isTweet = t?.type === 'x_post';
  const isBinancePost = t?.type === 'binance_post';
  const isFacebookPost = t?.type === 'facebook_post';
  const isRedditPost = t?.type === 'reddit_post';
  const isInstagramPost = t?.type === 'instagram_post';
  const isRepost = t?.type === 'binance_repost';
  const fn = t?.funnel || {};
  const dlUrls: string[] = Array.isArray(t?.urls) ? t.urls : [];
  return {
    id: t.id,
    // 任务真实 platform 必须透传:ScenarioView 矩阵模式按 t.platform 过滤 tab(FB/Reddit/Ins 剧本
    //   不在客户端注册表里,scenario_id 映射不到)。之前没带 → 过滤后所有任务全部隐身(用户实测)。
    platform: t.platform,
    // 按任务真实 platform + 类型映射剧本 id(原来写死 douyin/engage → 非抖音 tab 看不到任务、回复粉丝错显成互动)。
    scenario_id: isReply ? `${t.platform}_reply_fans_comment` : isDownload ? `${t.platform}_video_download` : isImageText ? `${t.platform}_image_text` : isViral ? `${t.platform}_viral_production_career` : isRepost ? 'binance_repost' : (isTweet || isBinancePost || isFacebookPost || isRedditPost || isInstagramPost) ? `${t.platform}_post` : engageScenarioIdForPlatform(t.platform),
    track: isReply ? 'reply_fan_comment' : isDownload ? 'video_download' : isImageText ? 'image_text' : isViral ? 'viral_production' : isTweet ? 'x_post' : isBinancePost ? 'binance_post' : isFacebookPost ? 'facebook_post' : isRedditPost ? 'reddit_post' : isInstagramPost ? 'instagram_post' : isRepost ? 'binance_repost' : 'matrix',
    // image_text / viral_rewrite / x_post / binance_post / facebook_post / reddit_post / instagram_post / binance_repost 配置透传(详情页/编辑回填 + updateTask 兜底不丢配置)。
    imageText: isImageText ? t.imageText : undefined,
    viralRewrite: isViral ? t.viralRewrite : undefined,
    tweetPost: isTweet ? t.tweetPost : undefined,
    binancePost: isBinancePost ? t.binancePost : undefined,
    facebookPost: isFacebookPost ? t.facebookPost : undefined,
    redditPost: isRedditPost ? t.redditPost : undefined,
    instagramPost: isInstagramPost ? t.instagramPost : undefined,
    binanceRepost: isRepost ? t.binanceRepost : undefined,
    // viral_rewrite 也摊平 AI 风格/发布给详情页(它也走 AI 生图 + 发布)。
    ...(isViral && t.viralRewrite ? { ai_image_style: t.viralRewrite.aiImageStyle || '', auto_publish: !!t.viralRewrite.autoPublish, auto_upload: !!t.viralRewrite.autoPublish } : {}),
    // 摊平给详情页 ConfigCard 读(它读 use_real_photos / real_photo_count / ai_image_style 这套老字段)。
    //   之前只传 imageText 对象 → 详情页读 task.use_real_photos=undefined → 选了网络图也恒显「AI 生图」。
    use_real_photos: isImageText ? !!(t.imageText && t.imageText.useRealPhotos) : undefined,
    real_photo_count: (isImageText && t.imageText && typeof t.imageText.imageCount === 'number') ? t.imageText.imageCount : undefined,
    ai_image_style: (isImageText && t.imageText) ? (t.imageText.aiImageStyle || '') : undefined,
    auto_publish: isImageText ? !!(t.imageText && t.imageText.autoPublish) : undefined,
    auto_upload: isImageText ? !!(t.imageText && t.imageText.autoPublish) : undefined,
    keywords: [],
    persona: '',
    // video_download:粘贴的链接清单(详情页/编辑回填用),daily_count = 链接数。
    urls: isDownload ? dlUrls : undefined,
    daily_count: isDownload ? (dlUrls.length || 1) : 1,
    variants_per_post: 1,
    daily_time: '',
    run_interval: t.frequency,
    enabled: !!t.enabled,
    active: !!t.enabled,
    next_planned_run_at: t.nextPlannedRunAt,
    daily_like_min: q.daily_like_min, daily_like_max: q.daily_like_max,
    daily_follow_min: q.daily_follow_min, daily_follow_max: q.daily_follow_max,
    daily_comment_min: q.daily_comment_min, daily_comment_max: q.daily_comment_max,
    // 回复粉丝 + 互动(评论引流)都带引流尾巴配置(供详情页展示 + 编辑回填)。
    // 互动任务的引流用于「评论时按概率把引流语融进 AI 评论」(见 engageRunner.makeAiCall)。
    funnel_phrase: (isReply || isEngage) ? (fn.funnel_phrase || '') : undefined,
    funnel_probability: (isReply || isEngage) ? (typeof fn.funnel_probability === 'number' ? fn.funnel_probability : 0) : undefined,
    account_ids: t.accountIds || [],
    created_at: t.createdAt || 0,
    updated_at: t.createdAt || 0,
  } as any;
}

/** 旧 createTask/updateTask 入参(ScenarioTaskIPC 形状)→ 矩阵 saveTask 入参。 */
function scenarioInputToMxSave(input: any, id?: string): any {
  const accountIds: string[] = input.account_ids || [];
  // 回复粉丝任务(scenario_id 以 _reply_fans_comment 结尾):保持 type='reply_fan' + 透传引流尾巴,
  // 否则经 updateTask(如 MyTasksPage 改启用)兜底回 type='engage' → 任务被错改成互动、引流配置丢。
  if (typeof input.scenario_id === 'string' && input.scenario_id.endsWith('_reply_fans_comment')) {
    const rPlatform = MATRIX_REPLY_ID_TO_PLATFORM[input.scenario_id] || 'xhs';
    return {
      id,
      platform: rPlatform,
      type: 'reply_fan',
      name: input.name || (accountIds.length ? `${rPlatform}回复粉丝 · ${accountIds.length} 个号` : `${rPlatform}回复粉丝`),
      accountIds,
      quota: {},
      funnel: {
        funnel_phrase: input.funnel_phrase || '',
        funnel_probability: typeof input.funnel_probability === 'number' ? input.funnel_probability : 0,
      },
      concurrency: accountIds.length,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // 视频下载任务(scenario_id 以 _video_download 结尾):保持 type='video_download' + 透传 urls,
  // 否则经 updateTask 兜底会被改成 engage、链接清单丢失。
  if (typeof input.scenario_id === 'string' && input.scenario_id.endsWith('_video_download')) {
    const dPlatform = MATRIX_DOWNLOAD_ID_TO_PLATFORM[input.scenario_id] || 'douyin';
    const urls: string[] = Array.isArray(input.urls) ? input.urls : [];
    return {
      id,
      platform: dPlatform,
      type: 'video_download',
      name: input.name || (urls.length ? `${dPlatform}视频下载 · ${urls.length} 条` : `${dPlatform}视频下载`),
      accountIds,                 // 单账号(数组长度 1)
      quota: {},
      urls,
      concurrency: 1,             // 单账号顺序下载,不多开
      frequency: input.run_interval || 'once',
      enabled: input.enabled !== false,
    };
  }
  // 图文创作任务(scenario_id 以 _image_text 结尾):保持 type='image_text' + 透传 imageText 配置,
  // 否则经 updateTask 兜底会被改成 engage、图文配置丢失。
  if (typeof input.scenario_id === 'string' && input.scenario_id.endsWith('_image_text')) {
    const iPlatform = MATRIX_IMAGETEXT_ID_TO_PLATFORM[input.scenario_id] || 'douyin';
    return {
      id,
      platform: iPlatform,
      type: 'image_text',
      name: input.name || (accountIds.length ? `${iPlatform}图文创作 · ${accountIds.length} 个号` : `${iPlatform}图文创作`),
      accountIds,
      quota: {},
      imageText: input.imageText,
      concurrency: accountIds.length,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // 爆款仿写任务(scenario_id 以 _viral_production_career 结尾):保持 type='viral_rewrite' + 透传 viralRewrite。
  if (typeof input.scenario_id === 'string' && input.scenario_id.endsWith('_viral_production_career')) {
    const vPlatform = MATRIX_VIRAL_ID_TO_PLATFORM[input.scenario_id] || 'xhs';
    return {
      id,
      platform: vPlatform,
      type: 'viral_rewrite',
      name: input.name || (accountIds.length ? `${vPlatform}爆款仿写 · ${accountIds.length} 个号` : `${vPlatform}爆款仿写`),
      accountIds,
      quota: {},
      viralRewrite: input.viralRewrite,
      concurrency: accountIds.length,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // 自动发推任务(scenario_id = x_post):保持 type='x_post' + 透传 tweetPost,否则经 updateTask 兜底会被改成 engage、配置丢失。
  if (typeof input.scenario_id === 'string' && MATRIX_TWEET_ID_TO_PLATFORM[input.scenario_id]) {
    const xPlatform = MATRIX_TWEET_ID_TO_PLATFORM[input.scenario_id];
    return {
      id,
      platform: xPlatform,
      type: 'x_post',
      name: input.name || (accountIds.length ? `推特发推 · ${accountIds.length} 个号` : '推特发推'),
      accountIds,
      quota: {},
      tweetPost: input.tweetPost,
      concurrency: accountIds.length,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // 币安广场发帖任务(scenario_id = binance_post):保持 type='binance_post' + 透传 binancePost,否则经 updateTask 兜底会被改成 engage、配置丢失。
  if (typeof input.scenario_id === 'string' && MATRIX_BINANCE_ID_TO_PLATFORM[input.scenario_id]) {
    const bnPlatform = MATRIX_BINANCE_ID_TO_PLATFORM[input.scenario_id];
    return {
      id,
      platform: bnPlatform,
      type: 'binance_post',
      name: input.name || (accountIds.length ? `币安广场发帖 · ${accountIds.length} 个号` : '币安广场发帖'),
      accountIds,
      quota: {},
      binancePost: input.binancePost,
      concurrency: accountIds.length,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // Facebook 发帖任务(scenario_id = facebook_post):保持 type='facebook_post' + 透传 facebookPost,否则兜底会被改成 engage、数据源配置丢失。
  if (input.scenario_id === 'facebook_post') {
    return {
      id,
      platform: 'facebook',
      type: 'facebook_post',
      name: input.name || (accountIds.length ? `Facebook 发帖 · ${accountIds.length} 个号` : 'Facebook 发帖'),
      accountIds,
      quota: {},
      facebookPost: input.facebookPost,
      concurrency: accountIds.length,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // Reddit 发帖任务(scenario_id = reddit_post):保持 type='reddit_post' + 透传 redditPost。
  if (input.scenario_id === 'reddit_post') {
    return {
      id,
      platform: 'reddit',
      type: 'reddit_post',
      name: input.name || (accountIds.length ? `Reddit 发帖 · ${accountIds.length} 个号` : 'Reddit 发帖'),
      accountIds,
      quota: {},
      redditPost: input.redditPost,
      concurrency: accountIds.length,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // Instagram 发帖任务(scenario_id = instagram_post):保持 type='instagram_post' + 透传 instagramPost。
  if (input.scenario_id === 'instagram_post') {
    return {
      id,
      platform: 'instagram',
      type: 'instagram_post',
      name: input.name || (accountIds.length ? `Instagram 发帖 · ${accountIds.length} 个号` : 'Instagram 发帖'),
      accountIds,
      quota: {},
      instagramPost: input.instagramPost,
      concurrency: accountIds.length,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // 币安广场搬运任务(scenario_id = binance_repost):保持 type='binance_repost' + 透传 binanceRepost,否则经 updateTask 兜底会被改成 engage、配置丢失。
  if (input.scenario_id === MATRIX_REPOST_SCENARIO_ID) {
    return {
      id,
      platform: MATRIX_REPOST_PLATFORM,
      type: 'binance_repost',
      name: input.name || (accountIds.length ? `币安广场搬运 · ${accountIds.length} 个号` : '币安广场搬运'),
      accountIds,
      quota: {},
      binanceRepost: input.binanceRepost,
      concurrency: 1,
      frequency: input.run_interval || 'daily_random',
      enabled: input.enabled !== false,
    };
  }
  // 真实 platform 从 scenario_id 反推(原来写死 douyin)。matrix engage 主路径走 ScenarioView.saveMatrixTask
  // 直传 platform、不经此函数;这里是 scenarioService.create/updateTask 的兜底,保持平台一致。
  const platform = MATRIX_ENGAGE_ID_TO_PLATFORM[input.scenario_id] || 'douyin';
  return {
    id,
    platform,
    type: 'engage',
    name: input.name || (accountIds.length ? `抖音互动 · ${accountIds.length} 个号` : '抖音互动'),
    accountIds,
    quota: {
      daily_like_min: input.daily_like_min, daily_like_max: input.daily_like_max,
      daily_follow_min: input.daily_follow_min, daily_follow_max: input.daily_follow_max,
      daily_comment_min: input.daily_comment_min, daily_comment_max: input.daily_comment_max,
    },
    // 互动评论引流:透传引流配置,否则经 updateTask 兜底(如 MyTasksPage 改启用)会把 funnel 丢掉。
    // 老任务 / 未填 → funnel_phrase 为 undefined → 存 {'',0} 视作未配,评论纯 AI(向后兼容)。
    funnel: {
      funnel_phrase: input.funnel_phrase || '',
      funnel_probability: typeof input.funnel_probability === 'number' ? input.funnel_probability : 0,
    },
    concurrency: accountIds.length,
    frequency: input.run_interval || 'daily_random',
    enabled: input.enabled !== false,
  };
}

function mxRunStatusOf(r: any): ScenarioTaskRun['status'] {
  if (r.success > 0) return 'ok';        // 全成/部分成功都按 ok 计入累计
  if (r.failed > 0) return 'failed';
  return 'skipped';
}

/** 矩阵运行记录 → 旧 ScenarioTaskRun(getTaskStats / runStatus 用,驱动累计统计)。 */
function mxRunToTaskRun(r: any): ScenarioTaskRun {
  const t = r.totals || {};
  return {
    task_id: r.taskId,
    started_at: r.startedAt,
    ended_at: r.finishedAt,
    status: mxRunStatusOf(r),
    // post(图文发帖)/download(视频下载)仅当运行记录里有该键才带上 → engage 不受影响、不会多出 📤0/⬇️0。
    action_counts: {
      like: t.like || 0, follow: t.follow || 0, comment: t.comment || 0,
      ...(typeof t.post === 'number' ? { post: t.post } : {}),
      ...(typeof t.download === 'number' ? { download: t.download } : {}),
    },
    // 累计/上次消耗:从运行记录的 cost 取(老记录无 cost → 0)。
    tokens_used: Number(r.cost?.credits) || 0,
    cost_usd: Number(r.cost?.usd) || 0,
  };
}

/** 矩阵运行记录 → 旧「富运行记录」(RunHistoryPage / RunRecordDetailPage 用)。 */
function mxRunToRecord(r: any): any {
  const t = r.totals || {};
  const status = r.failed > 0 && r.success === 0 ? 'error' : r.failed > 0 ? 'partial' : 'done';
  const items: any[] = Array.isArray(r.items) ? r.items : [];
  // ⚠️ step 字段必须给:RunRecordDetailPage 按 log.step 分组(Object.keys→Number),
  // 缺了 step 会得到 key='undefined'→Number('undefined')=NaN→stepGroups[NaN]=undefined→
  // `logs.length` 整块崩(「渲染错误 MainView:matrixRuns — undefined is not an object 'logs.length'」)。
  // 矩阵是逐号互动、没有多步骤概念,统一归到第 1 步。
  const step_logs = items.map((it) => ({
    time: hhmmss(r.finishedAt || r.startedAt),
    step: 1,
    status: it.state === 'success' ? 'done' : it.state === 'failed' ? 'error' : 'running',
    message: `[${it.displayName || it.accountId}] ${it.state}${it.counts ? ` 赞${it.counts.like || 0}/关${it.counts.follow || 0}/评${it.counts.comment || 0}` : ''}${it.reason ? ` (${it.reason})` : ''}`,
  }));
  // 运行记录也按真实 platform 还原 scenario_snapshot(原来写死抖音 → 运行记录 tab 同样错位)。
  const rPlatform = r.platform || 'douyin';
  const rMeta = MATRIX_ENGAGE_META[rPlatform];
  return {
    id: r.id,
    task_id: r.taskId,
    scenario_snapshot: { id: engageScenarioIdForPlatform(rPlatform), name_zh: rMeta?.name_zh || '互动涨粉', name_en: '', icon: rMeta?.icon || '🤝', platform: rPlatform },
    task_snapshot: { track: 'matrix', name: r.taskName, account_ids: items.map((it) => it.accountId) },
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    status,
    result: {
      action_counts: {
        like: t.like || 0, follow: t.follow || 0, comment: t.comment || 0,
        ...(typeof t.post === 'number' ? { post: t.post } : {}),
        ...(typeof t.download === 'number' ? { download: t.download } : {}),
      },
      action_targets: {},
      tokens_used: Number(r.cost?.credits) || 0, cost_usd: Number(r.cost?.usd) || 0, collected_count: 0, draft_count: 0,
    },

    summary: `成功 ${r.success || 0} · 失败 ${r.failed || 0} · 跳过 ${r.skipped || 0}（共 ${items.length} 个号）`,
    step_logs,
  };
}

/** 矩阵实时进度 → 旧 ScenarioRunProgress(真 TaskDetailPage 每 2s 轮询渲染)。 */
function mxProgressToScenario(taskId: string, resp: any): ScenarioRunProgress | null {
  const p = resp?.progress;
  if (!p || p.taskId !== taskId) return null;
  const status: ScenarioRunProgress['status'] = p.status === 'running' ? 'running' : p.status === 'error' ? 'error' : p.status === 'done' ? 'done' : 'idle';
  const running = status === 'running';
  const allLogs: Array<{ ts: number; accountId: string; msg: string }> = Array.isArray(p.logs) ? p.logs : [];
  const mapped = allLogs.map((l, i) => ({
    time: hhmmss(l.ts),
    status: (running && i === allLogs.length - 1) ? ('running' as const) : ('done' as const),
    message: `[${l.accountId}] ${l.msg}`,
  }));
  // 3 步与 STEP_NAMES_DOUYIN_AUTO_ENGAGE 对齐;互动全过程归到第 2 步(逐个互动)。
  const steps: any[] = [
    { name: '', status: 'done', logs: [] },
    { name: '', status: running ? 'running' : status === 'error' ? 'error' : 'done', logs: mapped },
    { name: '', status: status === 'done' ? 'done' : 'waiting', logs: [] },
  ];
  const apOf = (tg: any, dn: any): Record<string, { done: number; target: number }> => {
    const ap: Record<string, { done: number; target: number }> = {};
    for (const k of ['like', 'follow', 'comment']) {
      if ((tg || {})[k] > 0 || (dn || {})[k] > 0) ap[k] = { done: (dn || {})[k] || 0, target: (tg || {})[k] || 0 };
    }
    return ap;
  };
  const action_progress = apOf(p.targets, p.done);
  // 每个账号独立进度(详情页聚合进度下方逐号展示)。
  const pa = p.perAccount || {};
  const accounts = Object.keys(pa).map((id) => {
    const a = pa[id];
    return {
      id, name: a.displayName || id, status: a.status || 'running',
      action_progress: apOf(a.targets, a.done),
      logs: (a.logs || []).map((l: any, i: number) => ({ time: hhmmss(l.ts), status: (running && i === (a.logs.length - 1) ? 'running' : 'done') as any, message: l.msg })),
    };
  });
  // 本次消耗:💎 = p.cost.credits(钱包真实扣的积分),$ = p.cost.usd(后端按 token_price_per_million 算好)。
  // 之前没映射 → TaskDetailPage 的「本次消耗」恒显 0,即使钱已经扣了。
  const cost = p.cost || { credits: 0, usd: 0 };
  return { taskId, status, currentStep: status === 'done' ? 3 : 2, steps, error: p.error, action_progress, accounts, tokens_used: Number(cost.credits) || 0, cost_usd: Number(cost.usd) || 0 };
}

class ScenarioService {
  // ── Catalogue ──

  async listScenarios(): Promise<Scenario[]> {
    // 矩阵号:用打包内置的场景快照,并补齐快照里缺失的 engage 场景(主要是 xhs_auto_engage —
    // 快照只从 backend/scenarios 生成,而它只在 backend/matrix/scenarios)。否则按 scenario.platform
    // 过滤任务 tab 时,小红书等平台 lookup 不到 platform → tab 永远为空。
    if (MATRIX_EDITION) {
      const have = new Set(DEFAULT_SCENARIOS.map((s) => s.id));
      const synth = Object.entries(MATRIX_ENGAGE_SCENARIO_ID)
        .filter(([, sid]) => !have.has(sid))
        .map(([platform, sid]) => ({
          id: sid, version: '1.0.0', platform, workflow_type: 'auto_reply', category: 'engagement',
          name_zh: MATRIX_ENGAGE_META[platform]?.name_zh || sid, name_en: '',
          icon: MATRIX_ENGAGE_META[platform]?.icon || '🤝',
        }));
      // 同理补「自动回复粉丝」剧本快照,让 reply_fan 任务能按 platform 归到对应 tab。
      const synthReply = Object.entries(MATRIX_REPLY_SCENARIO_ID)
        .filter(([, sid]) => !have.has(sid))
        .map(([platform, sid]) => ({
          id: sid, version: '1.0.0', platform, workflow_type: 'reply_fans_comment', category: 'engagement',
          name_zh: MATRIX_REPLY_META[platform]?.name_zh || sid, name_en: '',
          icon: MATRIX_REPLY_META[platform]?.icon || '💌',
        }));
      // 同理补「视频无水印下载」剧本快照,让 video_download 任务能按 platform 归到对应 tab。
      const synthDownload = Object.entries(MATRIX_DOWNLOAD_SCENARIO_ID)
        .filter(([, sid]) => !have.has(sid))
        .map(([platform, sid]) => ({
          id: sid, version: '1.0.0', platform, workflow_type: 'video_download', category: 'tool',
          name_zh: MATRIX_DOWNLOAD_META[platform]?.name_zh || sid, name_en: '',
          icon: MATRIX_DOWNLOAD_META[platform]?.icon || '⬇️',
        }));
      // 同理补「图文创作」剧本快照,让 image_text 任务能按 platform 归到对应 tab。
      const synthImageText = Object.entries(MATRIX_IMAGETEXT_SCENARIO_ID)
        .filter(([, sid]) => !have.has(sid))
        .map(([platform, sid]) => ({
          id: sid, version: '1.0.0', platform, workflow_type: 'image_text', category: 'knowledge',
          name_zh: MATRIX_IMAGETEXT_META[platform]?.name_zh || sid, name_en: '',
          icon: MATRIX_IMAGETEXT_META[platform]?.icon || '📝',
        }));
      const synthViral = Object.entries(MATRIX_VIRAL_SCENARIO_ID)
        .filter(([, sid]) => !have.has(sid))
        .map(([platform, sid]) => ({
          id: sid, version: '1.0.0', platform, workflow_type: 'viral_production', category: 'knowledge',
          name_zh: MATRIX_VIRAL_META[platform]?.name_zh || sid, name_en: '',
          icon: MATRIX_VIRAL_META[platform]?.icon || '🔥',
        }));
      // 同理补「自动发推」剧本快照,让 x_post 任务能按 platform 归到推特 tab。
      const synthTweet = Object.entries(MATRIX_TWEET_SCENARIO_ID)
        .filter(([, sid]) => !have.has(sid))
        .map(([platform, sid]) => ({
          id: sid, version: '1.0.0', platform, workflow_type: 'x_post_creation', category: 'creation',
          name_zh: MATRIX_TWEET_META[platform]?.name_zh || sid, name_en: '',
          icon: MATRIX_TWEET_META[platform]?.icon || '🐦',
        }));
      // 同理补「币安广场自动发帖」剧本快照,让 binance_post 任务能按 platform 归到币安 tab。
      const synthBinance = Object.entries(MATRIX_BINANCE_SCENARIO_ID)
        .filter(([, sid]) => !have.has(sid))
        .map(([platform, sid]) => ({
          id: sid, version: '1.0.0', platform, workflow_type: 'binance_post_creation', category: 'creation',
          name_zh: MATRIX_BINANCE_META[platform]?.name_zh || sid, name_en: '',
          icon: MATRIX_BINANCE_META[platform]?.icon || '📊',
        }));
      // 同理补「币安广场批量搬运」剧本快照,让 binance_repost 任务能归到币安 tab。
      const synthRepost = have.has(MATRIX_REPOST_SCENARIO_ID) ? [] : [{
        id: MATRIX_REPOST_SCENARIO_ID, version: '1.0.0', platform: MATRIX_REPOST_PLATFORM, workflow_type: 'binance_repost_creation', category: 'creation',
        name_zh: '币安广场 批量搬运', name_en: '', icon: '♻️',
      }];
      return [...DEFAULT_SCENARIOS, ...synth, ...synthReply, ...synthDownload, ...synthImageText, ...synthViral, ...synthTweet, ...synthBinance, ...synthRepost] as unknown as Scenario[];
    }
    try {
      const res = await window.electron.scenario.listScenarios();
      return res?.scenarios || [];
    } catch {
      return [];
    }
  }

  /** Filter scenarios by platform and workflow type. */
  async listScenariosFor(platform: ScenarioPlatform, workflow?: ScenarioWorkflowType): Promise<Scenario[]> {
    const all = await this.listScenarios();
    return all.filter(
      s => s.platform === platform && (!workflow || s.workflow_type === workflow)
    );
  }

  // ── Tasks ──

  async listTasks(): Promise<Task[]> {
    if (MATRIX_EDITION) {
      try { const r = await MX()?.listTasks?.(); return r?.ok && Array.isArray(r.tasks) ? r.tasks.map(mxTaskToScenario) : []; } catch { return []; }
    }
    try {
      const r = await window.electron.scenario.listTasks();
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  }

  async listTasksFor(platform: ScenarioPlatform): Promise<Task[]> {
    const [tasks, scenarios] = await Promise.all([this.listTasks(), this.listScenarios()]);
    const scenarioById = new Map(scenarios.map(s => [s.id, s]));
    // 矩阵任务行自带 platform(mxTaskToScenario 透传),优先用它 —— FB/Reddit/Ins 剧本不在注册表,
    // 只按注册表映射会把这些任务滤没;registry 兜底照顾缺 platform 的行。
    return tasks.filter(t => (((t as any).platform) || scenarioById.get(t.scenario_id)?.platform) === platform);
  }

  async getTask(id: string): Promise<Task | null> {
    if (MATRIX_EDITION) { const all = await this.listTasks(); return all.find(t => t.id === id) || null; }
    return window.electron.scenario.getTask(id);
  }

  async createTask(input: Omit<Task, 'id' | 'created_at' | 'updated_at'>): Promise<Task> {
    if (MATRIX_EDITION) {
      if (!ensureMatrixLogin()) throw new Error('请先登录 NoobClaw 账号');
      const r = await MX()?.saveTask?.(scenarioInputToMxSave(input));
      if (!r?.ok) throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限', duplicate_type: '该平台已有同类型(互动)任务,直接编辑它即可', task_not_found: '任务不存在' } as any)[r?.error] || r?.error || '保存失败');
      return mxTaskToScenario(r.task);
    }
    return window.electron.scenario.createTask(input);
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
    if (MATRIX_EDITION) {
      if (!ensureMatrixLogin()) return null;
      // 把现有任务读出来合并 patch(矩阵 saveTask 是整体 upsert)。
      const cur = await this.getTask(id);
      if (!cur) return null;
      const merged: any = { ...cur, ...patch };
      const r = await MX()?.saveTask?.(scenarioInputToMxSave(merged, id));
      return r?.ok ? mxTaskToScenario(r.task) : null;
    }
    return window.electron.scenario.updateTask(id, patch);
  }

  async deleteTask(id: string): Promise<boolean> {
    if (MATRIX_EDITION) { if (!ensureMatrixLogin()) return false; const r = await MX()?.removeTask?.({ id }); return !!r?.ok; }
    return window.electron.scenario.deleteTask(id);
  }

  async runTaskNow(id: string): Promise<RunOutcome> {
    if (MATRIX_EDITION) {
      if (!ensureMatrixLogin()) return { status: 'skipped', reason: 'login_required' };
      const r = await MX()?.runTaskById?.({ taskId: id });
      if (r?.ok) return { status: 'started' };
      // another_task_running = 同平台已在跑;concurrency_full = 并发已达上限。都归到「上限」提示(TaskDetailPage 有人话)。
      const reason = (r?.error === 'another_task_running' || r?.error === 'concurrency_full') ? 'concurrency_limit_reached' : (r?.error || 'unknown');
      return { status: 'skipped', reason };
    }
    return window.electron.scenario.runTaskNow(id);
  }

  /** Upload a single already-generated draft. Used by TaskDetailPage
   *  per-draft 📤 button when auto_upload was false. */
  uploadDraft(taskId: string, draftId: string): Promise<{ status: string; reason?: string }> {
    return (window.electron.scenario as any).uploadDraft(taskId, draftId);
  }

  async runStatus(id: string): Promise<{ runs: ScenarioTaskRun[]; cooldown_ends_at: number }> {
    if (MATRIX_EDITION) {
      try { const r = await MX()?.listRuns?.({ taskId: id }); const runs = r?.ok && Array.isArray(r.runs) ? r.runs.map(mxRunToTaskRun) : []; return { runs, cooldown_ends_at: 0 }; } catch { return { runs: [], cooldown_ends_at: 0 }; }
    }
    return window.electron.scenario.runStatus(id);
  }

  // ── Drafts ──

  async listDrafts(taskId?: string): Promise<Draft[]> {
    if (MATRIX_EDITION) return [];   // 互动涨粉无草稿概念
    try {
      const r = await window.electron.scenario.listDrafts(taskId);
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  }

  pushDraft(draftId: string): Promise<{ status: 'ready_for_user' | 'failed'; error?: string }> {
    return window.electron.scenario.pushDraft(draftId);
  }

  deleteDraft(draftId: string): Promise<boolean> {
    return window.electron.scenario.deleteDraft(draftId);
  }

  markDraftIgnored(draftId: string): Promise<Draft | null> {
    return window.electron.scenario.markDraftIgnored(draftId);
  }

  // ── Active task management ──

  setActiveTask(id: string): Promise<Task | null> {
    return window.electron.scenario.setActiveTask(id);
  }

  getActiveTask(): Promise<Task | null> {
    return window.electron.scenario.getActiveTask();
  }

  // ── Running state ──

  async getRunningTaskId(): Promise<string | null> {
    if (MATRIX_EDITION) { const ids = await this.getRunningTaskIds(); return ids[0] || null; }
    try {
      const r = await window.electron.scenario.getRunningTaskId();
      return r?.runningTaskId || null;
    } catch {
      return null;
    }
  }

  /** Multi-tab concurrency (Twitter v1): returns ALL running task ids —
   *  can be > 1 when XHS task + Twitter task are both in flight. */
  async getRunningTaskIds(): Promise<string[]> {
    if (MATRIX_EDITION) {
      // 矩阵可【并发】跑多个平台任务(douyin + xhs 同时),但 matrix:getRunProgress 不传 taskId
      // 只回「任一在跑」的一条 → 列表只有一个任务亮绿,其它在跑的(也是 running)显示「下次运行」。
      // 改成逐任务查各自 running 态,汇总所有在跑的 id,列表才能把每个在跑的任务都标记运行中。
      try {
        const tasks = await this.listTasks();
        const checks = await Promise.all(tasks.map(async (t) => {
          try { const r = await MX()?.getRunProgress?.(t.id); return r?.running ? t.id : null; } catch { return null; }
        }));
        return checks.filter((x): x is string => !!x);
      } catch { return []; }
    }
    try {
      const r = await window.electron.scenario.getRunningTaskIds();
      return Array.isArray(r?.runningTaskIds) ? r.runningTaskIds : [];
    } catch {
      return [];
    }
  }

  /** Connected browser extensions, with their reported versions + when
   *  the bridge accepted the connection. Used to detect outdated
   *  extensions: an extension that pre-dates the version-reporting
   *  protocol (< 1.2.0) shows up with version === '' AND has been
   *  connected for > 5s without sending hello (older versions don't
   *  send it at all). */
  async getConnectedExtensions(): Promise<Array<{ id: string; version: string; tabCount: number; connectedAt: number }>> {
    if (MATRIX_EDITION) return [];   // 矩阵走指纹内核,不用扩展
    try {
      const r = await window.electron.scenario.getConnectedExtensions();
      return Array.isArray(r?.extensions) ? r.extensions : [];
    } catch {
      return [];
    }
  }

  /** All recorded runs across every task, newest-first. Used by the
   *  Run History page. */
  async getAllRuns(): Promise<Array<{
    task_id: string;
    started_at: number;
    finished_at?: number;
    status: 'success' | 'failure' | 'skipped' | 'running';
    reason?: string;
    collected_count?: number;
    draft_count?: number;
  }>> {
    if (MATRIX_EDITION) {
      try { const r = await MX()?.listRuns?.(); return r?.ok && Array.isArray(r.runs) ? r.runs.map((x: any) => ({ task_id: x.taskId, started_at: x.startedAt, finished_at: x.finishedAt, status: (x.failed > 0 && x.success === 0 ? 'failure' : 'success') as any, collected_count: 0, draft_count: 0 })) : []; } catch { return []; }
    }
    try {
      const r = await window.electron.scenario.getAllRuns();
      return Array.isArray(r?.runs) ? r.runs : [];
    } catch {
      return [];
    }
  }

  /** Rich run records (v2.4.22+) — full task snapshot + step logs +
   *  output dir. Replaces getAllRuns for the Run History UI. */
  async listRunRecords(filter?: { task_id?: string; platform?: string; light?: boolean }): Promise<Array<any>> {
    if (MATRIX_EDITION) {
      // 按 platform tab 过滤:runStore 只按 taskId 过滤,不认 platform → 之前「我的矩阵运行记录」
      // 抖音 tab 下混进币安/推特/小红书的记录。按记录真实 platform(runStore 每条都存了)再筛一遍。
      // 仅在「无 task_id」的全局按平台列表时筛;带 task_id 时已是单任务(单平台)记录,不再叠 platform
      // 过滤——否则 openHistoryForTask 对非 x/xhs/binance 平台回退 currentPlatform、一旦不匹配会把
      // 该任务历史整个筛空。
      try {
        const r = await MX()?.listRuns?.(filter?.task_id ? { taskId: filter.task_id } : undefined);
        const runs = r?.ok && Array.isArray(r.runs) ? r.runs : [];
        const scoped = (filter?.platform && !filter?.task_id)
          ? runs.filter((x: any) => (x?.platform || 'douyin') === filter.platform)
          : runs;
        return scoped.map(mxRunToRecord);
      } catch { return []; }
    }
    try {
      const r = await window.electron.scenario.listRunRecords(filter);
      return Array.isArray(r?.records) ? r.records : [];
    } catch {
      return [];
    }
  }

  /** Single record lookup, for the read-only detail page. */
  async getRunRecord(id: string): Promise<any | null> {
    if (MATRIX_EDITION) {
      try { const r = await MX()?.listRuns?.(); const rec = r?.ok && Array.isArray(r.runs) ? r.runs.find((x: any) => x.id === id) : null; return rec ? mxRunToRecord(rec) : null; } catch { return null; }
    }
    try {
      const r = await window.electron.scenario.getRunRecord(id);
      return r?.record || null;
    } catch {
      return null;
    }
  }

  async getRunProgress(taskId?: string): Promise<ScenarioRunProgress | null> {
    if (MATRIX_EDITION) {
      if (!taskId) return null;
      // 按任务取进度(并发跑多个任务时各取各的,不串台)。
      try { const r = await MX()?.getRunProgress?.(taskId); return mxProgressToScenario(taskId, r); } catch { return null; }
    }
    try {
      return await window.electron.scenario.getRunProgress(taskId) || null;
    } catch {
      return null;
    }
  }

  /** v4.31.41: Persistent fallback for the detail page —— in-memory progress
   *  gets cleared 30s after task end, but runRecords keeps step_logs forever.
   *  UI mounts: read latest record, show its step_logs as a baseline; live
   *  polling overlays in-memory progress when task is actively running. */
  async getLatestRunRecord(taskId: string): Promise<any | null> {
    if (MATRIX_EDITION) {
      try { const r = await MX()?.listRuns?.({ taskId }); const recs = r?.ok && Array.isArray(r.runs) ? r.runs : []; return recs.length ? mxRunToRecord(recs[0]) : null; } catch { return null; }
    }
    try {
      return await (window.electron.scenario as any).getLatestRunRecord(taskId) || null;
    } catch {
      return null;
    }
  }

  async requestAbort(_taskId?: string): Promise<void> {
    if (MATRIX_EDITION) {
      // 按平台并发:只停【这个任务所在平台】,不连累其它平台正在跑的任务。拿不到平台才全停。
      try {
        let platform: string | undefined;
        if (_taskId) { const t = await this.getTask(_taskId); platform = t ? MATRIX_ENGAGE_ID_TO_PLATFORM[(t as any).scenario_id] : undefined; }
        await MX()?.stopTask?.(platform ? { platform } : undefined);
      } catch {}
      return;
    }
    try {
      await window.electron.scenario.requestAbort(_taskId);
    } catch {}
  }

  // ── XHS login gate ──

  async checkXhsLogin(platform: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' = 'xhs'): Promise<XhsLoginStatus> {
    // 矩阵号:登录是【每个账号在各自指纹内核里】扫码完成的(在「我的矩阵账号」里),
    // 不存在「一个浏览器登录态」这回事 → 运行前登录门禁恒通过(没登录的号跑时自动跳过)。
    if (MATRIX_EDITION) return { loggedIn: true };
    try {
      return await window.electron.scenario.checkXhsLogin(platform as any);
    } catch (err) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  }

  async openXhsLogin(platform: 'xhs' | 'x' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao' = 'xhs'): Promise<{ ok: boolean; reason?: string }> {
    if (MATRIX_EDITION) return { ok: true };
    try {
      return await window.electron.scenario.openXhsLogin(platform as any);
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  // ── Creator center secondary gate (xhs / douyin 图文创作专用) ──
  // 首页 tab 不等于创作者中心 tab,LoginRequiredModal 额外加一行检查保证用户
  // 真打开过 creator.* 子域、且不是停在登录重定向页。

  async checkCreatorCenter(platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao'): Promise<XhsLoginStatus> {
    try {
      return await window.electron.scenario.checkCreatorCenter(platform as any);
    } catch (err) {
      return { loggedIn: false, reason: 'browser_not_connected' };
    }
  }

  async openCreatorCenter(platform: 'xhs' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao'): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await window.electron.scenario.openCreatorCenter(platform as any);
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  }

  /** 视频任务登录预检【cookie 快路径】(req 3):返回 {loggedIn} 或 null(拿不准 → 调用方回退老校验)。 */
  async checkVideoLoginByCookie(platform: string, which?: 'main' | 'creator'): Promise<{ loggedIn: boolean } | null> {
    try {
      return await (window.electron.scenario as any).checkVideoLoginByCookie(platform, which);
    } catch {
      return null;
    }
  }

  /** 【多平台】一次性 cookie 预检:一次 CDP 读全部、按域名+名逐平台判。返回 { [platform]: true|false|null }。 */
  async checkVideoLoginByCookieBatch(items: { platform: string; which?: 'main' | 'creator' }[]): Promise<Record<string, boolean | null>> {
    try {
      return await (window.electron.scenario as any).checkVideoLoginByCookieBatch(items) || {};
    } catch {
      return {};
    }
  }

  /** 在唯一的检查/登录窗里给某平台开一个 tab 登录(一窗多 tab,不再每点开新窗;role 各平台不同)。 */
  async openVideoLoginInCheckWindow(url: string, role?: string): Promise<{ ok: boolean; diag?: string }> {
    const fn = (window.electron?.scenario as any)?.openLoginInCheckWindow;
    if (typeof fn !== 'function') {
      return { ok: false, diag: 'preload 没暴露 openLoginInCheckWindow(typeof=' + typeof fn + ')' };
    }
    try {
      const r: any = await fn(url, role);
      if (r && typeof r === 'object' && typeof r.diag === 'string') return r;   // 主进程新代码:带 diag,透传
      return { ok: !!(r && r.ok), diag: '主进程返回无 diag(=主bundle可能是旧的): ' + JSON.stringify(r) };
    } catch (e: any) {
      return { ok: false, diag: 'IPC 抛错: ' + String(e?.message || e) };       // reject:无 handler / 主进程抛异常
    }
  }

  /** 模态关闭时收掉检查/登录窗。 */
  async closeVideoLoginCheckWindow(): Promise<void> {
    try { await (window.electron.scenario as any).closeLoginCheckWindow(); } catch { /* ignore */ }
  }

  // ── Derived helpers ──

  /** Aggregate per-task stats the task dashboard likes to show.
   *
   *  v5.x+: the previous 3 cards (累计采集 / 生成草稿 / 已推送) were
   *  replaced with 累计完成 / 累计消耗 / 上次完成 / 上次消耗. The new
   *  fields are computed from per-run telemetry (`action_counts`,
   *  `tokens_used`, `cost_usd`) that orchestrators emit via
   *  `ctx.addActionCount()` + the auto-summed token/cost maps in
   *  scenarioManager. Pre-rollout runs lack these fields, so they
   *  contribute 0 to the cumulative totals and the UI shows '-' for
   *  the "last run" panel until a fresh run lands. */
  async getTaskStats(taskId: string): Promise<{
    runs: ScenarioTaskRun[];
    draft_count: number;
    pending_draft_count: number;
    pushed_draft_count: number;
    last_run_at: number | null;
    last_run_status: ScenarioTaskRun['status'] | null;
    cooldown_ends_at: number;
    /** Sum across every recorded successful run, keyed by free-form
     *  action type ('like' / 'follow' / 'comment' / 'reply' / 'post'). */
    cumulative_action_counts: Record<string, number>;
    /** Sum of credits consumed across every recorded run. */
    cumulative_tokens_used: number;
    /** Sum of USD cost across every recorded run (computed at run-time
     *  from system_config.token_price_per_million). */
    cumulative_cost_usd: number;
    /** action_counts of the most recent run, or {} if it doesn't have any. */
    last_run_action_counts: Record<string, number>;
    /** Credits consumed by the most recent run, or 0. */
    last_run_tokens_used: number;
    /** USD cost of the most recent run, or 0. */
    last_run_cost_usd: number;
  }> {
    const [runStatusResult, drafts] = await Promise.all([
      this.runStatus(taskId).catch(() => ({ runs: [], cooldown_ends_at: 0 })),
      this.listDrafts(taskId),
    ]);
    const runs = Array.isArray(runStatusResult?.runs) ? runStatusResult.runs : [];
    const cooldown_ends_at = runStatusResult?.cooldown_ends_at || 0;
    // v6.x: '上次完成' 是上一次真正跑完的统计 — 不能选 status='running' 的当前
    //   in-progress run(那个 action_counts 永远是空/0,会把上次的正确数据顶掉)。
    //   优先找最近一条 status≠'running' 的 run;全是 running 才回退到末尾。
    // 「上次完成」= 最近一次【非 running】的 run。矩阵 runStore 返回【最新在前】
    //   (addRun unshift),而老逻辑「最高下标=最新」在这种顺序下会取到【最旧】那条
    //   → 详情页上次完成与运行记录对不上。改为按 started_at 取最大,与数组顺序无关。
    let last: any = null;
    for (const r of runs) {
      if (!r || r.status === 'running') continue;
      if (!last || (r.started_at || 0) > (last.started_at || 0)) last = r;
    }
    // 全是 running / 没有非 running 时 → 回退到 started_at 最大的那条。
    if (!last) for (const r of runs) { if (r && (!last || (r.started_at || 0) > (last.started_at || 0))) last = r; }

    // Cumulative aggregation. Iterate all runs (including failed/skipped —
    // an action that succeeded before a later failure still counts).
    const cumulative_action_counts: Record<string, number> = {};
    let cumulative_tokens_used = 0;
    let cumulative_cost_usd = 0;
    for (const r of runs) {
      const ac = r.action_counts;
      if (ac && typeof ac === 'object') {
        for (const [k, v] of Object.entries(ac)) {
          cumulative_action_counts[k] = (cumulative_action_counts[k] || 0) + (Number(v) || 0);
        }
      }
      cumulative_tokens_used += Number(r.tokens_used) || 0;
      cumulative_cost_usd    += Number(r.cost_usd)    || 0;
    }

    return {
      runs,
      draft_count: drafts.length,
      pending_draft_count: drafts.filter(d => d.status === 'pending').length,
      pushed_draft_count: drafts.filter(d => d.status === 'pushed').length,
      last_run_at: last?.started_at || null,
      last_run_status: last?.status || null,
      cooldown_ends_at,
      cumulative_action_counts,
      cumulative_tokens_used,
      cumulative_cost_usd,
      last_run_action_counts: (last?.action_counts && typeof last.action_counts === 'object') ? last.action_counts : {},
      last_run_tokens_used: Number(last?.tokens_used) || 0,
      last_run_cost_usd: Number(last?.cost_usd) || 0,
    };
  }
}

export const scenarioService = new ScenarioService();
