/**
 * publishers/types — 视频任务【自动上传到各大平台】的统一接口契约。
 *
 * 设计原则(用户硬约束:运行期发现没登录就跳过,不杀任务):
 *   · 每个平台一个 driver,实现 PublisherDriver 接口
 *   · checkLogin() 返回 'logged_in' / 'not_logged_in' / 'unknown',pipeline 据此跳过
 *   · upload() 任何异常都返回 { ok:false, reason },绝不抛出 —— 单平台失败不影响整体
 *   · 全平台都失败也不 fail 任务(本地 mp4 还在,任务终态 = done + warning 日志)
 *
 * 跟 scenario/phaseRunner 的关系:phaseRunner 已经实现了部分平台的【上传 helper】
 * (publishVideoToBinance、uploadVideoToTwitter 等),但都是嵌在 ctx 上下文里的闭包。
 * 这里把这套能力【提到 module level】,统一接口供 video pipeline 直接调用,不依赖
 * scenario orchestrator 框架 —— video 任务跑完直接 forEach platforms 调 driver,
 * 比启一个 scenario 子任务简单。
 *
 * 跟 chrome-extension 的关系:driver 只调 sendBrowserCommand(browserBridge.ts 暴露
 * 的低级 API),不动 extension 本体。Extension 那边 manifest.platforms 的窗口注册表
 * 是另一个范畴(user 暂不授权改),所以新加平台(快手/视频号/头条号)的窗口识别
 * 可能要靠 PLATFORM_TAB_GROUPS 兜底,driver 本身完全独立。
 */

/**
 * 视频可发布的平台 id。命名沿用 platformLoginDriver.LoginPlatform 的 9 个
 * (去掉 youtube 因为用户没要求),保持跨模块一致。
 */
export type VideoPlatform =
  | 'douyin'      // 抖音(creator.douyin.com)
  | 'xhs'         // 小红书(creator.xiaohongshu.com)
  | 'tiktok'      // TikTok(www.tiktok.com/upload)
  | 'binance'     // 币安广场(binance.com/.../square)
  | 'x'           // 推特/X(x.com)
  | 'bilibili'   // B 站(member.bilibili.com)
  | 'kuaishou'    // 快手(cp.kuaishou.com)
  | 'shipinhao'   // 视频号(channels.weixin.qq.com)
  | 'toutiao'     // 头条号(mp.toutiao.com)
  | 'youtube'     // YouTube(youtube.com/upload → Studio)
  | 'instagram'   // Instagram(创建帖子弹窗,视频=Reel)
  | 'facebook';   // Facebook(创建帖子弹窗,视频帖)

/** 平台展示用元信息(UI 勾选项 + 日志 label)。 */
export interface VideoPlatformMeta {
  id: VideoPlatform;
  zh: string;     // 「抖音」
  en: string;     // 「Douyin」
  emoji: string;  // 「🎵」
}

/** 全部 9 个平台的元数据,UI / 日志 / driver registry 共用。 */
export const VIDEO_PLATFORMS: VideoPlatformMeta[] = [
  { id: 'douyin',    zh: '抖音',     en: 'Douyin',    emoji: '🎵' },
  { id: 'xhs',       zh: '小红书',   en: 'Xiaohongshu', emoji: '📕' },
  { id: 'tiktok',    zh: 'TikTok',   en: 'TikTok',    emoji: '🎬' },
  { id: 'binance',   zh: '币安广场', en: 'Binance',   emoji: '🟡' },
  { id: 'x',         zh: '推特',     en: 'X / Twitter', emoji: '🐦' },
  { id: 'bilibili',  zh: 'B 站',     en: 'Bilibili',  emoji: '📺' },
  { id: 'kuaishou',  zh: '快手',     en: 'Kuaishou',  emoji: '⚡' },
  { id: 'shipinhao', zh: '视频号',   en: 'Channels',  emoji: '🟢' },
  { id: 'toutiao',   zh: '头条号',   en: 'Toutiao',   emoji: '🟠' },
  { id: 'youtube',   zh: 'YouTube',  en: 'YouTube',   emoji: '▶️' },
  { id: 'instagram', zh: 'Instagram', en: 'Instagram', emoji: '📷' },
  { id: 'facebook',  zh: 'Facebook', en: 'Facebook',  emoji: '👥' },
];

/** 登录状态。driver.checkLogin 的返回。 */
export type PublisherLoginStatus = 'logged_in' | 'not_logged_in' | 'unknown';

/** 单平台发布参数(从 task.input 派生)。 */
export interface PublishInput {
  /** 视频本地绝对路径(mp4)。 */
  videoPath: string;
  /** 标题(平台有标题字段时用 —— B 站/快手/头条号 必填,其它平台可空)。 */
  title?: string;
  /** 描述 / 正文 / 配文。所有平台都用,抖音 / 小红书 / TikTok 是描述,币安 / 推特是正文,B 站 / 头条号是简介。 */
  description?: string;
  /** 标签(平台支持 hashtag 的话);driver 自行格式化(抖音 # / 推特 # / 小红书话题 etc)。 */
  tags?: string[];
}

/** 单平台发布结果。 */
export interface PublishResult {
  /** 是否真发出去了(modal 关 / URL 跳到帖子 / 之类的硬信号)。 */
  ok: boolean;
  /** 失败原因(分类标签 + 细节,便于诊断而不暴给最终用户)。 */
  reason?: string;
  /** 可选:平台返回的内容 id / URL(以后做「打开已发布帖子」按钮用)。 */
  publishedUrl?: string;
}

/**
 * 单次发布【运行期上下文】。
 *
 * v6.13 单 tab 复用方案:runPublish 开一个【专用 video_publish 窗口的固定 tab】,
 * 9 个平台【共用这一个 tab】靠 navigate 串行切上传页(不再每平台开一个窗口)。
 * driver 上传时所有 sendBrowserCommand 都要把命令钉到这个 tab —— extension 按
 * `params.tabId` 直接 chrome.tabs.get 寻址,绕过 tabPattern/tabGroup 路由(phaseRunner
 * ScopedTab v5.27+ 同款机制)。
 *
 * 【向后兼容】tabId 缺省(老调用方 / 单测 / 无 window_registry_v6 能力的旧扩展)时,
 * driver 退回原 bridgeOptsFor 的 tabPattern 路由,行为与本次改动前完全一致。
 */
export interface PublishCtx {
  /** 复用的固定发布 tab id。runPublish 开窗后拿到,透传给每个 driver。 */
  tabId?: number;
}

/** 单平台 driver 契约。pipeline 不关心实现细节,只调这 2 个方法。 */
export interface PublisherDriver {
  /** 平台 id。 */
  platform: VideoPlatform;
  /**
   * 检查登录态。绝不抛,不确定就返 'unknown'(pipeline 当未登录处理 → 跳过)。
   * 实现建议:走 platformLoginDriver.checkPlatformLogin(同平台 id),它已经按 tab pattern
   * 检测过登录态;driver 只是包一层。
   * @param ctx 可选运行期上下文(tabId);checkLogin 走全局 tab_list 扫描,通常不需要,
   *   接口对称保留。
   */
  checkLogin(ctx?: PublishCtx): Promise<PublisherLoginStatus>;
  /**
   * 上传视频 + 填正文 + 发布。绝不抛,失败返 { ok:false, reason }。
   * 实现建议:走 sendBrowserCommand(browserBridge.ts)直接驱动 chrome-extension,
   * 复用 phaseRunner 的 publishVideoToBinance / uploadVideoToTwitter 套路(file input
   * + main_world_click + editor_insert_text + click_with_text)。
   * @param onLog 日志回调,driver 推「⏳ 等视频处理…」「✓ 已发布」之类,pipeline 把它
   *   塞到 tracker.progress 让 UI 看到实时进度。
   * @param ctx 运行期上下文。ctx.tabId 存在时,driver 内所有命令钉到该 tab(单 tab 复用);
   *   缺省时退回 bridgeOptsFor 路由(向后兼容)。
   */
  upload(input: PublishInput, onLog?: (msg: string) => void, ctx?: PublishCtx): Promise<PublishResult>;
}
