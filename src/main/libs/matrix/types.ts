/**
 * 矩阵号核心数据模型(本地,不上云)。
 * 见方案 project_matrix_product_plan / 边界 feedback_matrix_isolation_boundary。
 *
 * 铁律:fingerprint.seed 与 proxy 一旦绑定某号即【永久固定】——指纹/IP 漂移本身
 * 就是平台关联信号。
 */

export type AccountStatus =
  | 'idle'          // 可用
  | 'running'       // 正在跑任务
  | 'login_required'// 登录态失效,需重新扫码
  | 'limited'       // 被限流,冷却中
  | 'banned';       // 已封

/** 指纹种子 + 维度,直接映射 fingerprint-chromium 的 --fingerprint-* flag。 */
export interface Fingerprint {
  seed: number;                                   // --fingerprint=<32位整数>,一号一固定种子
  platformOs?: 'windows' | 'macos' | 'linux';     // --fingerprint-platform
  brand?: 'Chrome' | 'Edge' | 'Opera' | 'Vivaldi';// --fingerprint-brand
  hardwareConcurrency?: number;                    // --fingerprint-hardware-concurrency
  lang?: string;                                   // --lang / --accept-lang(与 IP 地域对齐)
  timezone?: string;                               // --timezone(与 IP 地域对齐)
}

/** 出口代理。Chromium --proxy-server 不支持内联账密 → 带 auth 时需本地中转端口。 */
export interface Proxy {
  protocol: 'socks5' | 'socks5h' | 'http' | 'https';
  host: string;
  port: number;
  username?: string;
  password?: string;
  localBridgePort?: number;        // 带 auth 时:本地无认证中转端口(上游带 auth)
  geo?: string;                    // 归属地,需与 fingerprint.timezone/lang 对齐
  ispType?: 'residential' | 'mobile' | 'datacenter';
  health?: 'ok' | 'leaking' | 'banned' | 'dead';
}

/** 一个矩阵账号 = 身份 + 持久 profile + 固定指纹 + 固定代理 + 健康态。 */
export interface MatrixAccount {
  id: string;
  platform: string;                // douyin / xhs / ... (对齐 backend/matrix/drivers 文件名)
  displayName: string;
  group?: string;                  // 赛道/分组
  persona?: string;                // 人设(喂评论 AI 口吻;点赞/关注用不到)
  status: AccountStatus;
  userDataDir: string;             // 持久 profile 目录(登录态长期粘住)
  fingerprint: Fingerprint;
  proxy?: Proxy;
  debugPort?: number;              // 运行时分配的 CDP 调试端口
  lastPostAt?: number;
  lastAliveAt?: number;            // 最近一次确认登录态有效的时间(任务/发布/保活成功时更新);主动保活据此筛「超 N 天没活跃」的号
  // 互动配置:赛道关键词(自动点赞/评论/关注时按这些词搜内容)+ 赛道 id(engageHistory 去重维度)
  keywords?: string[];          // 【原始关键词】用户设的,永不被 AI 衍生覆盖/删除
  // 【AI 衍生关键词池】原始词搜尽时 AI 按赛道衍生的新词,持久化于此(与原始词分开存,上限 30,满了整批换)。
  // 搜索时 = keywords + derivedKeywords 合用(见 accountManager.effectiveKeywords)。
  derivedKeywords?: string[];
  track?: string;
  // 绑定的指纹内核版本(指纹稳定:一号长期用固定版本)。空 = 用任意已装版本。
  kernelVersion?: string;
  // 登录后从平台页面/接口读到的真实身份。nickname 昵称展示;displayId 平台号(抖音号/小红书号/
  // 快手号/@handle/视频号ID 等,用户可辨识);avatar 头像 URL;boundUid 内部 uid(「换号告警」绑定校验)。
  nickname?: string;
  displayId?: string;
  avatar?: string;
  boundUid?: string;
  // 登录场景(仅快手用):'main'=主站 www.kuaishou.com(涨粉互动+读身份)、'creator'=创作者中心
  // cp.kuaishou.com(视频发布)。快手主站与创作端登录互不覆盖(实测),故拆成两类账号、各自登录。
  // 建号时确定、之后不可改。其它平台不设(主站登录即覆盖创作端 / 同域)。
  loginScope?: 'main' | 'creator';
}

/** 互动配额区间(各项在 [min,max] 内随机)。 */
export interface EngageQuota {
  daily_like_min?: number; daily_like_max?: number;
  daily_follow_min?: number; daily_follow_max?: number;
  daily_comment_min?: number; daily_comment_max?: number;
}

/**
 * 「自动回复粉丝评论」(reply_fan)任务的配置。无配额(回复对象=粉丝评论本身,不是搜出来的),
 * 只有可选引流尾巴。回复对象/人设/账号身份在各矩阵账号上(persona 喂回复 AI 口吻)。
 */
export interface ReplyFanConfig {
  funnel_phrase?: string;        // 引流文案(选填,空则纯 AI 回复不带尾巴)
  funnel_probability?: number;   // 引流尾巴出现概率 1-100(引流语为空时失效)
}

/**
 * 「图文创作」(image_text)任务配置。N 个号各自按身份(赛道/人设/关键词,沿用账号已有配置)
 * + 可选参考文案 + 维度化创意引擎 → AI 生成各异内容,配图全局二选一(AI生图 / 网络图按本号关键词搜),
 * 发到各自创作者中心。配图方式/张数/篇数全局统一,参考文案可按号填(选填)。
 */
export interface ImageTextConfig {
  useRealPhotos: boolean;        // 配图方式【全局】:false=AI 生图,true=网络图(按账号关键词搜实景图)
  imageCount: number;            // 每篇配图张数 2-6
  dailyCount: number;            // 每号每轮生成几篇 1-50
  aiImageStyle?: string;         // AI 生图风格(仅 useRealPhotos=false 用,缺省 'ai_auto')
  autoPublish: boolean;          // true=直接群发,false=仅本地保存(用户逐条审核后手动发)
  references?: Record<string, string>; // 可选:各账号参考文案 { accountId: text };不填则按身份合成种子
  // 仅【视频号 + 网络图】用:视频号浏览器没登录抖音、游客搜图拿不到 → 选 1 个【已登录抖音】的号当下图号,
  // 用它的浏览器搜+下网络图,再喂给各视频号发布。一个抖音号服务 N 个视频号,故网络图模式整任务串行。
  imageDownloadAccountId?: string;
}

/**
 * 「爆款批量仿写」(viral_rewrite)任务配置(目前仅小红书)。N 个号各自用【自己的赛道/关键词/人设】
 * 去小红书搜本 niche 爆款 → 维度化创意引擎仿写 → AI 生图 → 发布。来源=每号关键词搜(沿用账号已配)。
 */
export interface ViralRewriteConfig {
  dailyCount: number;            // 每号每轮仿写几篇 1-50
  aiImageStyle?: string;         // AI 生图风格(缺省 'ai_auto')
  autoPublish: boolean;          // true=直接发布(坐标),false=仅本地保存
}

/**
 * 「自动发推」(x_post)任务配置(目前仅推特 X)。N 个号各自按【自己的人设/赛道/关键词】(沿用账号已配身份)
 * AI 原创一条推文,发到各自时间线。每号每轮固定 1 条,内容互不相同。
 *   mode='web3':抓近 3 周 web3 热门资讯 → Pro 紧贴资讯原创(web3 KOL 流,复刻旧 x_post_creator);
 *   mode='free':按本号身份 + 可选参考文案 → Pro 自由原创(适合非 web3 赛道)。
 * 配图可选(withImage→AI 生图附到推文);语言 zh/en/mixed(mixed 跟随客户端语言)。
 */
export interface TweetPostConfig {
  mode: 'web3' | 'free';         // 内容来源:web3 资讯流 / 按账号身份自由创作
  withImage: boolean;            // true=AI 生图配图,false=纯文字推
  language: string;   // 'mixed'/'auto'=跟随账号;或 9 种语言码之一(见 postLangs.ts)
  isBlueV: boolean;              // 蓝V(X Premium)→ 字数自由(三档随机);普通号 ≤140 字
  autoPublish: boolean;          // true=直接发布,false=仅本地生成(不发)
  references?: Record<string, string>; // 可选:各账号参考文案 { accountId: text }(仅 free 模式参考);空则按身份生成
}

/**
 * 「币安广场自动发帖」(binance_post)任务配置(目前仅币安广场)。N 个号各自按【自己的人设/赛道/关键词】
 * (沿用账号已配身份)抓近 3 周 web3 热门资讯 → Pro 紧贴资讯深度创作一条币安广场图文,发到币安广场。
 * 每号每轮固定 1 条,内容互不相同。仅 web3 资讯模式(对齐旧 binance_square_post_creator)。
 * 配图可选(withImage→源资讯原图优先,无则 AI 生图);语言 zh/en/mixed(mixed 跟随客户端语言)。
 */
export interface BinancePostConfig {
  withImage: boolean;            // true=配图(源图优先→AI 生图),false=纯文字
  language: string;   // 'mixed'/'auto'=跟随账号;或 9 种语言码之一(见 postLangs.ts)
  autoPublish: boolean;          // true=直接发布,false=仅本地生成(不发)
}

/**
 * 「Facebook 自动发帖」(facebook_post)任务配置。同 binance_post 骨架(N 号各自 AI 原创一条图文 + 可选配图 → 发布),
 * 但 FB 不是 web3 专场 → 数据源可选:sourceKind 'news'(web3 深度资讯)/ 'category'(hotspot 分类如 tech)/
 * 'hot'(微博/抖音/知乎/百度/B站/雪球/海外热榜)。source=hot 模式的热榜名;catKey=category 模式的分类键(web3/tech)。
 * 复用 binancePostRunner(runBinancePostTask 按 ${platform}_post 解析剧本 = facebook_post)。
 */
export interface FacebookPostConfig {
  withImage: boolean;
  language: string;   // 'mixed'/'auto'=跟随账号;或 9 种语言码之一(见 postLangs.ts)
  autoPublish: boolean;
  sourceKind: 'news' | 'category' | 'hot';  // 数据源类型
  source?: string;                          // hot 模式:热榜名(如 "微博热搜")
  catKey?: string;                          // category 模式:分类键(web3 / tech)
}

/**
 * 「Reddit 自动发帖」(reddit_post)任务配置。同 facebook_post 的可选数据源,但发布走 Reddit API(POST /api/submit,
 * self/文字帖),且需指定目标 subreddit。无配图(Reddit 图片帖要 media lease 上传,二期)。
 * 复用 binancePostRunner(scenarioId = reddit_post)。
 */
export interface RedditPostConfig {
  language: string;   // 'mixed'/'auto'=跟随账号;或 9 种语言码之一(见 postLangs.ts)
  autoPublish: boolean;
  sourceKind: 'news' | 'category' | 'hot';
  source?: string;
  catKey?: string;
  subreddit: string;                        // 目标 subreddit(必填,不带 r/ 前缀也行)
}

/**
 * 「Instagram 自动发帖」(instagram_post)任务配置。同 facebook_post 的可选数据源,但发布走 IG「新建帖子」
 * 多步弹窗(上传图 → 下一步 → 写文案 → 分享)。**Instagram 网页帖必须带图** → withImage 恒 true(拿不到图判失败)。
 * 复用 binancePostRunner(scenarioId = instagram_post)。
 */
export interface InstagramPostConfig {
  withImage: boolean; // 恒 true(IG 帖必带图);保留字段与 facebook 对齐
  language: string;   // 'mixed'/'auto'=跟随账号;或 9 种语言码之一(见 postLangs.ts)
  autoPublish: boolean;
  sourceKind: 'news' | 'category' | 'hot';
  source?: string;
  catKey?: string;
}

/**
 * 「币安广场批量搬运」(binance_repost)任务配置。区别于其它矩阵任务:本任务有【两种账号角色】——
 *   · 1 个【采集号】(sourceAccountId,在 sourcePlatform 上已登录):按关键词搜索 → 筛选 → 下载,
 *     一次性采够 N 条候选素材(图文 / 视频);
 *   · N 个【币安号】(task.accountIds):各领一条候选,AI 仿写改成币安口吻 + 配图 → 发到各自币安广场。
 * 「采集发布解耦」:采集只跑一次(不需要每个币安号自己登录源平台),候选任务级去重保证两号不撞同源,
 * 每号独立改写降低连坐。计费按成功条数(repost_image_text / repost_video)+ AI 仿写 token。
 *   material='image':搬图文(源图 + 仿写正文 → 币安图文帖);'video':搬视频(无水印源视频 → 币安视频帖)。
 *   sourcePlatform 决定采集剧本(douyin/xhs/tiktok/x);keyword 为空则用采集号自己的关键词。
 */
export interface BinanceRepostConfig {
  sourcePlatform: 'douyin' | 'xhs' | 'tiktok' | 'x'; // 搬运来源平台(决定采集剧本)
  sourceAccountId: string;       // 采集号(该 sourcePlatform 上已登录的矩阵账号 id)
  keyword?: string;              // 搜索词(选填;空则用采集号 account.keywords)
  material: 'image' | 'video';   // 搬运形态:图文 / 视频
  withImage: boolean;            // 图文模式恒配源图;视频模式此项保留兼容(一般 true)
  language: string;   // 'mixed'/'auto'=跟随账号;或 9 种语言码之一(见 postLangs.ts) // 仿写语言(mixed 跟随客户端)
  autoPublish: boolean;          // true=直接发布,false=仅本地生成(不发)
  perRunCount?: number;          // 本轮目标条数;缺省=min(币安号数, 候选池数)。封顶见 runner
}

// 互动(点赞/评论/关注)= engage;自动回复粉丝评论 = reply_fan(抖音创作者中心评论管理);
// 视频无水印下载 = video_download(单账号:选 1 个号 + 粘贴多个链接,逐个下载,不多开);
// 图文创作 = image_text(N 个号各自按身份生成图文 + 配图 + 发到各自创作者中心);
// 爆款批量仿写 = viral_rewrite(N 个号各自按关键词搜小红书爆款 → 仿写 → AI 生图 → 发布);
// 自动发推 = x_post(N 个号各自按身份 AI 原创一条推文 + 可选配图 → 发到各自时间线,仅推特);
// 币安广场自动发帖 = binance_post(N 个号各自抓 web3 资讯 AI 原创一条币安广场图文 + 可选配图 → 发币安广场,仅币安);
// 币安广场批量搬运 = binance_repost(1 个采集号从源平台搜+下 N 条 → N 个币安号各领一条 AI 仿写 + 配图 → 发币安广场)。
export type MatrixTaskType = 'engage' | 'reply_fan' | 'video_download' | 'image_text' | 'viral_rewrite' | 'x_post' | 'binance_post' | 'binance_repost' | 'facebook_post' | 'reddit_post' | 'instagram_post';
// 频率枚举对齐老客户端 DouyinConfigWizard(便于复用频率算法/文案)。
export type MatrixTaskFrequency = 'once' | '30min' | '1h' | '3h' | '6h' | 'daily_random';

/**
 * 矩阵任务 = 某平台一类自动化(目前只有互动)的「可保存配置 + 调度」。
 * 约束:每平台最多 5 个任务、同平台同类型只允许 1 个;全局同时只跑 1 个(运行时锁)。
 */
export interface MatrixTask {
  id: string;
  platform: string;
  type: MatrixTaskType;
  name: string;
  enabled: boolean;                // 定时调度是否启用(手动运行不受此限)
  accountIds: string[];            // 勾选的(已登录)账号
  quota: EngageQuota;              // 仅 engage 用;reply_fan / video_download 任务为空对象
  funnel?: ReplyFanConfig;         // 仅 reply_fan 用:引流尾巴配置
  imageText?: ImageTextConfig;     // 仅 image_text 用:图文创作配置
  viralRewrite?: ViralRewriteConfig; // 仅 viral_rewrite 用:爆款仿写配置
  tweetPost?: TweetPostConfig;     // 仅 x_post 用:自动发推配置
  binancePost?: BinancePostConfig; // 仅 binance_post 用:币安广场自动发帖配置
  facebookPost?: FacebookPostConfig; // 仅 facebook_post 用:Facebook 自动发帖配置(含数据源)
  redditPost?: RedditPostConfig;   // 仅 reddit_post 用:Reddit 自动发帖配置(含数据源 + subreddit)
  instagramPost?: InstagramPostConfig; // 仅 instagram_post 用:Instagram 自动发帖配置(含数据源,图必带)
  binanceRepost?: BinanceRepostConfig; // 仅 binance_repost 用:币安广场批量搬运配置
  urls?: string[];                 // 仅 video_download 用:用户粘贴的待下载视频链接清单
  concurrency?: number;            // 同时开窗数(video_download 固定 1,单账号顺序下载)
  frequency: MatrixTaskFrequency;  // 运行频率
  nextPlannedRunAt?: number;       // 下次计划运行(epoch ms;调度器预排,UI 展示)
  lastRunAt?: number;              // 上次运行(调度判断 + 展示)
  createdAt: number;
}
