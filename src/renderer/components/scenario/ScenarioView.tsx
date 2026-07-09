/**
 * ScenarioView — top-level replacement for QuickUseView.
 *
 * Owns the internal navigation state for the "一键使用" area:
 *   - Platform tab (xhs / x / douyin / tiktok / youtube)
 *   - Page within that platform (workflows list / workflow detail / task detail)
 *   - Modals (config wizard)
 *
 * Only xhs is functional in Phase 1. Everything else renders a placeholder.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';
import { scenarioService, type Scenario, type Task, type Draft } from '../../services/scenario';
import { DEFAULT_SCENARIOS } from '../../data/defaultScenarios';
import { XhsWorkflowsPage } from './XhsWorkflowsPage';
import { XWorkflowsPage } from './XWorkflowsPage';
import { TaskDetailPage } from './TaskDetailPage';
import { PlatformPlaceholder } from './PlatformPlaceholder';
import { ConfigWizard } from './ConfigWizard';
import { SensitiveCheckPage } from './SensitiveCheckPage';
import { MyTasksPage } from './MyTasksPage';
import { RunHistoryPage } from './RunHistoryPage';
import { RunRecordDetailPage } from './RunRecordDetailPage';
import { BinanceWorkflowsPage } from './BinanceWorkflowsPage';
import { YoutubeWorkflowsPage } from './YoutubeWorkflowsPage';
import { TikTokWorkflowsPage } from './TikTokWorkflowsPage';
import { DouyinWorkflowsPage } from './DouyinWorkflowsPage';
import { ShipinhaoWorkflowsPage } from './ShipinhaoWorkflowsPage';
import { ToutiaoWorkflowsPage } from './ToutiaoWorkflowsPage';
import { KuaishouWorkflowsPage } from './KuaishouWorkflowsPage';
import { BilibiliWorkflowsPage } from './BilibiliWorkflowsPage';
import { VideoWorkflowsPage } from './video/VideoWorkflowsPage';
import { WalletBadge } from '../common/WalletBadge';
import LuckyBag from '../cowork/LuckyBag';
import { ErrorBoundary } from '../ErrorBoundary';
import MatrixTaskWizard, { type WizardAccount } from '../matrix/MatrixTaskWizard';
import MatrixReplyFansWizard from '../matrix/MatrixReplyFansWizard';
import MatrixVideoDownloadWizard from '../matrix/MatrixVideoDownloadWizard';
import MatrixImageTextWizard, { type ImageTextWizardSave } from '../matrix/MatrixImageTextWizard';
import MatrixTweetPostWizard, { type TweetPostWizardSave } from '../matrix/MatrixTweetPostWizard';
import MatrixBinancePostWizard, { type BinancePostWizardSave } from '../matrix/MatrixBinancePostWizard';
import MatrixFacebookPostWizard, { type FacebookPostWizardSave } from '../matrix/MatrixFacebookPostWizard';
import MatrixRedditPostWizard, { type RedditPostWizardSave } from '../matrix/MatrixRedditPostWizard';
import MatrixInstagramPostWizard, { type InstagramPostWizardSave } from '../matrix/MatrixInstagramPostWizard';
import MatrixBinanceRepostWizard, { type BinanceRepostWizardSave } from '../matrix/MatrixBinanceRepostWizard';
import MatrixViralRewriteWizard, { type ViralRewriteWizardSave } from '../matrix/MatrixViralRewriteWizard';
import { HIDE_WEB3 } from '../../buildFlags';

type PlatformId = 'xhs' | 'x' | 'binance' | 'douyin' | 'shipinhao' | 'toutiao' | 'kuaishou' | 'bilibili' | 'tiktok' | 'youtube' | 'instagram' | 'facebook' | 'reddit' | 'video';

// 矩阵 tab 顺序:多平台视频创作放最前(用户要求),其后与「我的矩阵账号」平台顺序一致(含视频号/头条)。
const MATRIX_TAB_ORDER: PlatformId[] = ['video', 'douyin', 'xhs', 'kuaishou', 'bilibili', 'shipinhao', 'toutiao', 'x', 'binance', 'youtube', 'tiktok', 'facebook', 'reddit', 'instagram'];
// 后端 backend/matrix/scenarios 有 <platform>_auto_engage 互动涨粉剧本的平台(共 8 个)。
// 视频号/头条暂无 engage 剧本 → tab 仍展示(与账号页一致),但「开始创作」标注「即将上线」不放行,避免跑出错任务。
const MATRIX_ENGAGE_PLATFORMS = new Set<PlatformId>(['douyin', 'xhs', 'kuaishou', 'bilibili', 'x', 'binance', 'youtube', 'tiktok', 'facebook', 'reddit', 'instagram']);
// 后端 backend/matrix/scenarios 有 <platform>_reply_fans_comment「自动回复粉丝」剧本的平台。
// 小红书(逐篇笔记进详情页回复,主站登录态即覆盖创作者中心)+ 快手(创作者中心评论管理,需
// loginScope='creator' 账号)+ 哔哩哔哩(member.bilibili.com 创作中心评论管理,登录 cookie 挂
// 父域 .bilibili.com,主站登录态即覆盖创作中心,取主站号即可);其余平台后续逐步开放。
// 账号 scope 过滤见 replyAccountFilter。
// 头条号(mp.toutiao.com 后台「评论管理」集中回复,主站登录态即覆盖创作端,无 loginScope → 取主站号即可)。
// 视频号(channels.weixin.qq.com/platform 视频号助手「互动管理 · 评论」集中回复,助手即创作端、无独立主站,
// 无 loginScope → 取主站号即可;页面为 wujie 微前端 open shadowRoot,剧本已处理)。
// 抖音(creator.douyin.com 创作者中心「评论管理」集中回复,登录 cookie 挂父域 .douyin.com,主站登录态即覆盖
// 创作者中心,取主站号即可,无 loginScope;后端剧本 douyin_reply_fans_comment 已就位)。
const MATRIX_REPLY_FAN_PLATFORMS = new Set<PlatformId>(['douyin', 'xhs', 'kuaishou', 'bilibili', 'toutiao', 'shipinhao']);
// 后端 backend/matrix/scenarios 有 <platform>_video_download「视频无水印下载」剧本的平台(单账号工具任务)。
// 抖音(页面 fetch wrapper 签名拿 detail)/快手(读 <video> src)/哔哩哔哩(playurl html5 单文件 mp4)/
// TikTok(SSR __UNIVERSAL_DATA__ + 多级 fallback,须 VPN 真机)。都走【主站】登录态,取主站号。
const MATRIX_VIDEO_DOWNLOAD_PLATFORMS = new Set<PlatformId>(['douyin', 'kuaishou', 'bilibili', 'tiktok', 'xhs']);
// 后端 backend/matrix/scenarios 有 <platform>_image_text「图文创作」剧本的平台(N 号各自生成图文+发布)。
// 抖音(creator.douyin.com)/小红书(creator.xiaohongshu.com)/视频号(channels.weixin.qq.com 助手「发表新动态」,
// wujie 微前端 shadowRoot 发布)/头条号(mp.toutiao.com 微头条,byte-design 普通页,无标题/封面)。
// 视频号/头条本身无图文搜索,网络图借抖音下图号取——见 imageDownloadAccountId。
const MATRIX_IMAGE_TEXT_PLATFORMS = new Set<PlatformId>(['douyin', 'xhs', 'shipinhao', 'toutiao']);
// 「爆款批量仿写」目前仅小红书。
const MATRIX_VIRAL_PLATFORMS = new Set<PlatformId>(['xhs']);
// 后端 backend/matrix/scenarios 有 x_post「自动发推」剧本的平台(N 号各自 AI 原创一条推+可选配图→发时间线)。目前仅推特。
const MATRIX_TWEET_POST_PLATFORMS = new Set<PlatformId>(['x']);
// 后端 backend/matrix/scenarios 有 binance_post「币安广场自动发帖」剧本的平台(N 号各自抓 web3 资讯 AI 原创一条币安广场图文+可选配图→发币安广场)。目前仅币安。
const MATRIX_BINANCE_POST_PLATFORMS = new Set<PlatformId>(['binance']);
// 后端 backend/matrix/scenarios 有 facebook_post「Facebook 自动发帖」剧本的平台(N 号各自按人设从所选数据源取材 AI 原创一条帖 + 可选配图 → 发 FB)。目前仅 FB。
const MATRIX_FB_POST_PLATFORMS = new Set<PlatformId>(['facebook']);
// 后端有 reddit_post「Reddit 自动发帖」剧本的平台(取材可选源 + subreddit,API 发 self 帖)。目前仅 Reddit。
const MATRIX_REDDIT_POST_PLATFORMS = new Set<PlatformId>(['reddit']);
// 后端有 instagram_post「Instagram 自动发帖」剧本的平台(取材可选源,IG「新建帖子」多步弹窗发图文,图必带)。目前仅 Instagram。
const MATRIX_IG_POST_PLATFORMS = new Set<PlatformId>(['instagram']);
// 「币安广场批量搬运」(binance_repost):1 个源平台采集号搜+下 → N 个币安号各领一条仿写发。发布目标=币安。
const MATRIX_BINANCE_REPOST_PLATFORMS = new Set<PlatformId>(['binance']);

// Top-level navigation:
//   create  — scenario cards (current XhsWorkflowsPage / XWorkflowsPage,
//             but with the bottom task list stripped out — those are now
//             over in `tasks`).
//   tasks   — unified "我的自动化运营任务" page across all platforms,
//             filtered by the active platform sub-tab.
//   history — unified "运行记录" page across all platforms, filtered by
//             the active platform sub-tab.
type SectionId = 'create' | 'tasks' | 'history';

type ViewState =
  | { kind: 'main'; section: SectionId; platform: PlatformId; filterTaskId?: string | null }
  | { kind: 'task_detail'; task_id: string; from?: SectionId }
  | { kind: 'record_detail'; record_id: string; from_platform: PlatformId; filterTaskId?: string | null }
  | { kind: 'sensitive_check' };

interface ScenarioViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  /** v4.31.44: 主页涨粉标签传入,初始选中对应 platform tab。undefined 时默认 video
   *  (多平台视频创作)—— 视频创作是当下主推入口,直接进 3 个菜单(新建/我的/运行记录)
   *  时落在它上面,比早期落在「币安广场」更贴当前产品方向。 */
  initialPlatform?: PlatformId;
  /** v1.x: 顶栏右上角"分享给好友"按钮点击 → 跳邀请返佣页 */
  onShowInvite?: () => void;
  /** v6.x: 左侧菜单拆分 —— 同一个 ScenarioView 现在被三个顶级菜单复用:
   *   'create'  = 「✨ 新建涨粉任务」新建页(只显示平台 tab + 新建内容,隐藏段标题)。
   *   'manage'  = 「📋 我的涨粉任务」(段标题 + 平台 tab + 任务列表)。
   *   'runs'    = 「📊 涨粉运行记录」(段标题 + 平台 tab + 运行记录列表)。
   *  三者是独立的顶级菜单实例(App 里 ErrorBoundary key={mainView} 切换时重挂载)。
   *  原 manage 内的「我的涨粉任务 / 运行记录」L1 段 tab 已拆成两个独立菜单,不再内切。 */
  mode?: 'create' | 'manage' | 'runs';
  /** manage 模式下任何「新建涨粉任务」入口 → 切到「一键涨粉」create 菜单(干净拆分,
   *  避免两个菜单内容重叠)。由 App 注入,内部切 mainView='scenarioCreate'。 */
  onSwitchToCreate?: (platform?: PlatformId) => void;
  /** v6.x: create 模式(「一键涨粉」新建页)右上角「查看已有的涨粉任务」按钮 →
   *  切到「我的涨粉任务」manage 菜单。由 App 注入,内部切 mainView='quickuse'。
   *  可带 platform:视频卡片「已有任务」传 'video',让管理页直接定位到视频 tab。 */
  onSwitchToManage?: (platform?: PlatformId) => void;
  /** 进入/退出【任务详情 / 运行记录详情】时上报。create / runs 菜单下钻到任务详情时,
   *  任务详情逻辑上属于「我的涨粉任务」→ App 据此把左侧菜单高亮切到「我的涨粉任务」,
   *  使侧栏高亮 + 顶栏标题不再停在「新建涨粉任务 / 涨粉运行记录」。 */
  onInDetailChange?: (inDetail: boolean) => void;
  /** 侧栏每次点同一/任一涨粉菜单时 App 递增此值 → 本组件退回列表(修:在运行记录/任务详情里点
   *  侧栏菜单,setMainView 同值是 no-op、退不出详情)。 */
  navNonce?: number;
  /** 矩阵号 edition:锁死抖音平台、隐藏平台 tab、标题改「矩阵涨粉」、新建/编辑走
   *  MatrixView(matrixTaskNew)。数据经 scenarioService 的 MATRIX 适配层接矩阵后端。 */
  matrixMode?: boolean;
}

const PLATFORM_TABS: Array<{ id: PlatformId; labelKey: string; icon: string; enabled: boolean }> = [
  // 第一行: 视频创作 + 海外/全球平台
  { id: 'video', labelKey: 'scenarioPlatformVideo', icon: '🎬', enabled: true },
  { id: 'binance', labelKey: 'scenarioPlatformBinance', icon: '🔶', enabled: true },
  { id: 'x', labelKey: 'scenarioPlatformX', icon: '🐦', enabled: true },
  { id: 'youtube', labelKey: 'scenarioPlatformYoutube', icon: '📺', enabled: true },
  { id: 'tiktok', labelKey: 'scenarioPlatformTiktok', icon: '🎵', enabled: true },
  { id: 'facebook', labelKey: 'scenarioPlatformFacebook', icon: '👥', enabled: true },
  { id: 'reddit', labelKey: 'scenarioPlatformReddit', icon: '🟠', enabled: true },
  { id: 'instagram', labelKey: 'scenarioPlatformInstagram', icon: '📷', enabled: true },
  // 国内平台:接在后面同一行排,放不下由容器(flex-wrap)自然换行,不再写死断行。
  { id: 'xhs', labelKey: 'scenarioPlatformXhs', icon: '📕', enabled: true },
  { id: 'douyin', labelKey: 'scenarioPlatformDouyin', icon: '🎶', enabled: true },
  { id: 'kuaishou', labelKey: 'scenarioPlatformKuaishou', icon: '⚡', enabled: true },
  { id: 'shipinhao', labelKey: 'scenarioPlatformShipinhao', icon: '📱', enabled: true },
  { id: 'bilibili', labelKey: 'scenarioPlatformBilibili', icon: '📺', enabled: true },
  { id: 'toutiao', labelKey: 'scenarioPlatformToutiao', icon: '📰', enabled: true },
];

// v6.x: 原 SECTION_TABS(我的涨粉任务 / 运行记录 两个 L1 段 tab)已移除 —
// 两段拆成两个独立左侧菜单(manage / runs),头部改为静态段标题,不再内切。

export const ScenarioView: React.FC<ScenarioViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  initialPlatform,
  onShowInvite,
  mode = 'manage',
  onSwitchToCreate,
  onSwitchToManage,
  onInDetailChange,
  navNonce,
  matrixMode,
}) => {
  const isMac = window.electron.platform === 'darwin';
  // v6.x: 菜单拆分后,本实例的「主页/落地段」由 mode 决定:
  //   create 模式落在 'create'(新建页);manage 模式落在 'tasks'(我的涨粉任务)。
  const baseSection: SectionId = mode === 'create' ? 'create' : mode === 'runs' ? 'history' : 'tasks';
  // 默认平台 tab:统一默认【多平台视频创作】(video)。
  const defaultPlatform: PlatformId = 'video';
  const [view, setView] = useState<ViewState>({ kind: 'main', section: baseSection, platform: initialPlatform || defaultPlatform });

  // Seed scenarios from the bundled snapshot so the "立即开始" buttons in
  // every WorkflowsPage are clickable from first paint, not greyed out
  // while we wait on the network. listScenarios() result REPLACES this
  // once the API call comes back, so any backend-side scenario change
  // still reaches the user within the normal refresh cycle.
  const [scenarios, setScenarios] = useState<Scenario[]>(() => DEFAULT_SCENARIOS);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  // 视频是本地工具,任务/运行记录详情是 VideoWorkflowsPage 的内部状态(view 仍是
  // 'main'),进详情时由它上报,这里据此隐藏顶部 L1/L2 tab,对齐 scenario 详情页全屏。
  const [videoInDetail, setVideoInDetail] = useState(false);

  // 下钻到【任务详情 / 运行记录详情】时上报给 App —— 任务详情逻辑上属于「我的涨粉任务」,
  // 让 App 把左侧菜单高亮 + 顶栏标题切过去(create/runs 菜单下钻后不再停在原菜单)。
  // ⚠️ 视频本地任务(AI自动成片)的详情是 VideoWorkflowsPage 内部状态、view.kind 仍是 'main',
  //    必须把 videoInDetail 也算进来,否则点视频任务进详情时导航不切。
  const inDetailView = view.kind === 'task_detail' || view.kind === 'record_detail' || videoInDetail;
  useEffect(() => { onInDetailChange?.(inDetailView); }, [inDetailView, onInDetailChange]);
  useEffect(() => () => { onInDetailChange?.(false); }, [onInDetailChange]);
  // 侧栏点涨粉菜单(navNonce 递增)→ 退回本 mode 的列表页(不重挂、不重拉数据)。修:在运行记录详情里
  //   点「涨粉运行记录」,App setMainView 同值是 no-op,原来退不出详情、且高亮乱跳。mount 时无害(等于初值)。
  useEffect(() => {
    setView({ kind: 'main', section: baseSection, platform: initialPlatform || defaultPlatform });
    setVideoInDetail(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navNonce]);

  // Wizard state (keyword/track tasks)
  const [wizardScenario, setWizardScenario] = useState<Scenario | null>(null);
  const [wizardEditingTask, setWizardEditingTask] = useState<Task | null>(null);
  // 矩阵号:互动涨粉向导(选账号 + 配额 + 频率;账号制,赛道/关键词/人设在账号上)。
  const [matrixWizardPlatform, setMatrixWizardPlatform] = useState<string | null>(null);
  const [matrixAccounts, setMatrixAccounts] = useState<WizardAccount[]>([]);
  const [matrixAccountsLoading, setMatrixAccountsLoading] = useState(false); // 账号异步加载中(弹窗先开,账号后填)
  const [matrixWizardTask, setMatrixWizardTask] = useState<any | null>(null); // 编辑时的初始任务(回填账号/配额/频率);新建为 null
  // 「自动回复粉丝」向导(独立于互动向导:账号取【创作者中心】scope、无配额、带引流尾巴)。
  const [matrixReplyPlatform, setMatrixReplyPlatform] = useState<string | null>(null);
  const [matrixReplyAccounts, setMatrixReplyAccounts] = useState<WizardAccount[]>([]);
  const [matrixReplyAccountsLoading, setMatrixReplyAccountsLoading] = useState(false);
  const [matrixReplyTask, setMatrixReplyTask] = useState<any | null>(null); // 编辑时回填(账号/引流/频率);新建 null
  // 「视频无水印下载」向导(单账号工具任务:选 1 个号 + 粘贴链接)。
  const [matrixDownloadPlatform, setMatrixDownloadPlatform] = useState<string | null>(null);
  const [matrixDownloadAccounts, setMatrixDownloadAccounts] = useState<WizardAccount[]>([]);
  const [matrixDownloadAccountsLoading, setMatrixDownloadAccountsLoading] = useState(false);
  const [matrixDownloadTask, setMatrixDownloadTask] = useState<any | null>(null);
  // 「图文创作」向导(多账号:勾选 N 个号 + 全局配图/篇数 + 可选参考文案)。
  const [matrixImageTextPlatform, setMatrixImageTextPlatform] = useState<string | null>(null);
  const [matrixImageTextAccounts, setMatrixImageTextAccounts] = useState<WizardAccount[]>([]);
  const [matrixImageTextAccountsLoading, setMatrixImageTextAccountsLoading] = useState(false);
  // 视频号/头条网络图用的「抖音下图号」候选(已登录抖音的主站号),传给 MatrixImageTextWizard。
  const [matrixImageTextDownloadAccounts, setMatrixImageTextDownloadAccounts] = useState<WizardAccount[]>([]);
  const [matrixImageTextTask, setMatrixImageTextTask] = useState<any | null>(null);
  const [matrixTweetPlatform, setMatrixTweetPlatform] = useState<string | null>(null);
  const [matrixTweetAccounts, setMatrixTweetAccounts] = useState<WizardAccount[]>([]);
  const [matrixTweetAccountsLoading, setMatrixTweetAccountsLoading] = useState(false);
  const [matrixTweetTask, setMatrixTweetTask] = useState<any | null>(null);
  const [matrixBinancePlatform, setMatrixBinancePlatform] = useState<string | null>(null);
  const [matrixBinanceAccounts, setMatrixBinanceAccounts] = useState<WizardAccount[]>([]);
  const [matrixBinanceAccountsLoading, setMatrixBinanceAccountsLoading] = useState(false);
  const [matrixBinanceTask, setMatrixBinanceTask] = useState<any | null>(null);
  // ── Facebook 自动发帖(facebook_post)向导状态 ──
  const [matrixFacebookPlatform, setMatrixFacebookPlatform] = useState<string | null>(null);
  const [matrixFacebookAccounts, setMatrixFacebookAccounts] = useState<WizardAccount[]>([]);
  const [matrixFacebookAccountsLoading, setMatrixFacebookAccountsLoading] = useState(false);
  const [matrixFacebookTask, setMatrixFacebookTask] = useState<any | null>(null);
  // ── Reddit 自动发帖(reddit_post)向导状态 ──
  const [matrixRedditPlatform, setMatrixRedditPlatform] = useState<string | null>(null);
  const [matrixRedditAccounts, setMatrixRedditAccounts] = useState<WizardAccount[]>([]);
  const [matrixRedditAccountsLoading, setMatrixRedditAccountsLoading] = useState(false);
  const [matrixRedditTask, setMatrixRedditTask] = useState<any | null>(null);
  // ── Instagram 自动发帖(instagram_post)向导状态 ──
  const [matrixInstagramPlatform, setMatrixInstagramPlatform] = useState<string | null>(null);
  const [matrixInstagramAccounts, setMatrixInstagramAccounts] = useState<WizardAccount[]>([]);
  const [matrixInstagramAccountsLoading, setMatrixInstagramAccountsLoading] = useState(false);
  const [matrixInstagramTask, setMatrixInstagramTask] = useState<any | null>(null);
  // ── 币安广场批量搬运(binance_repost)向导状态 ──
  const [matrixRepostPlatform, setMatrixRepostPlatform] = useState<string | null>(null);
  const [matrixRepostAccounts, setMatrixRepostAccounts] = useState<WizardAccount[]>([]);        // 币安发布号
  const [matrixRepostSourceAccounts, setMatrixRepostSourceAccounts] = useState<WizardAccount[]>([]); // 全部号(挑采集号)
  const [matrixRepostAccountsLoading, setMatrixRepostAccountsLoading] = useState(false);
  const [matrixRepostTask, setMatrixRepostTask] = useState<any | null>(null);
  // 「爆款批量仿写」向导(多账号:勾选 N 个号 + 篇数/AI风格/发布)。
  const [matrixViralPlatform, setMatrixViralPlatform] = useState<string | null>(null);
  const [matrixViralAccounts, setMatrixViralAccounts] = useState<WizardAccount[]>([]);
  const [matrixViralAccountsLoading, setMatrixViralAccountsLoading] = useState(false);
  const [matrixViralTask, setMatrixViralTask] = useState<any | null>(null);
  // 指纹浏览器内核守卫:没装内核时弹「去下载」,后续流程不走(创建/运行矩阵任务都先过这关)。
  const [matrixKernelMissing, setMatrixKernelMissing] = useState(false);
  const [matrixKernelBusy, setMatrixKernelBusy] = useState(false);
  // 重复任务提示:某平台已有同类型任务时,关掉向导并弹此提示,给「去查看 / 编辑」入口跳对应管理 tab。
  const [dupNotice, setDupNotice] = useState<{ platform: string; label: string } | null>(null);
  // 一个平台每种任务只允许 1 个(taskStore duplicate_type)。点「创建」时先查重:已有同类型任务
  // 直接弹「去查看编辑」,不让用户填完整个向导才在保存时报错。listTasks 慢(sidecar 忙)时 1.5s
  // 超时放行 —— 查重失败/超时都不拦创建,保存时的 duplicate_type 仍是最终兜底。
  const hasDupTask = async (platform: string, type: string, label: string): Promise<boolean> => {
    try {
      const r: any = await Promise.race([
        (window as any).electron?.matrix?.listTasks?.(),
        new Promise((res) => setTimeout(() => res(null), 1500)),
      ]);
      const tasks: any[] = r?.ok && Array.isArray(r.tasks) ? r.tasks : [];
      if (tasks.some((t) => t?.platform === platform && t?.type === type)) {
        setDupNotice({ platform, label });
        return true;
      }
    } catch { /* 查不出来就放行 */ }
    return false;
  };
  const ensureMatrixKernel = async (): Promise<boolean> => {
    try {
      const r = await (window as any).electron?.matrix?.kernelStatus?.();
      if (r?.installed) return true;
    } catch { /* 视为未安装 */ }
    setMatrixKernelMissing(true);
    return false;
  };
  const downloadMatrixKernel = async () => {
    setMatrixKernelBusy(true);
    try {
      await (window as any).electron?.matrix?.ensureKernel?.();
      // 下载在后台,ensureKernel 可能先返回 → 轮询到装好为止(最多 ~4min)。
      for (let i = 0; i < 120; i++) {
        const r = await (window as any).electron?.matrix?.kernelStatus?.();
        if (r?.installed) { setMatrixKernelMissing(false); break; }
        await new Promise((res) => setTimeout(res, 2000));
      }
    } finally { setMatrixKernelBusy(false); }
  };
  const openMatrixWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; } // 未登录 → 弹登录窗
    if (await hasDupTask(platform, 'engage', '互动')) return;
    // 先秒开弹窗:内核检查 + 账号加载都后台异步(sidecar 忙时 IPC 排队,await 在开弹窗前会卡几秒)。
    setMatrixAccounts([]);
    setMatrixAccountsLoading(true);
    setMatrixWizardTask(null);          // 新建:清掉编辑态(否则会被上次编辑的任务回填)
    setMatrixWizardPlatform(platform);
    void ensureMatrixKernel();          // 缺内核 → 后台弹下载提示(z-60 覆盖在向导上),不阻塞弹窗
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      // 互动涨粉走【主站】(浏览首页/搜索做赞关评),只能选主站账号;快手「创作者中心」(loginScope='creator')
      // 是发布端登录态,不能拿来互动 → 过滤掉。非快手账号无 loginScope(默认主站)不受影响。
      setMatrixAccounts(accs.filter((a) => a.platform === platform && (a.loginScope || 'main') === 'main').map((a) => ({ id: a.id, displayName: a.displayName, status: a.status, keywords: a.keywords, group: a.group, platform: a.platform, nickname: a.nickname, displayId: a.displayId, avatar: a.avatar })));
    } catch { setMatrixAccounts([]); }
    finally { setMatrixAccountsLoading(false); }
  };
  // 编辑现有矩阵互动任务:加载该平台账号 + 把任务映成 wizard 的 initialTask(回填账号/配额/频率)。
  const openMatrixWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'douyin';
    // 编辑只是改配置,不需要内核;也不等 listAccounts 完成 —— 先把弹窗开起来(秒开),账号异步填。
    // (运行中 sidecar 忙,kernelStatus/listAccounts 都可能慢;之前都 await 在 setMatrixWizardTask 前 → 弹窗卡几秒。)
    setMatrixAccounts([]);
    setMatrixAccountsLoading(true);
    setMatrixWizardTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      quota: {
        daily_like_min: task.daily_like_min, daily_like_max: task.daily_like_max,
        daily_follow_min: task.daily_follow_min, daily_follow_max: task.daily_follow_max,
        daily_comment_min: task.daily_comment_min, daily_comment_max: task.daily_comment_max,
        // 评论语言回填:漏了会在编辑时显示 auto、保存后把已存语言洗掉(mxTaskToScenario 已透传该字段)。
        comment_lang: (task as any).comment_lang,
      },
      // 评论引流回填(老任务无此字段 → 空 → 向导显示未填)。
      funnel: { funnel_phrase: (task as any).funnel_phrase || '', funnel_probability: (task as any).funnel_probability ?? 0 },
      frequency: task.run_interval,
    });
    setMatrixWizardPlatform(plat);
    // 账号异步加载(只选主站账号,排除快手创作者中心 loginScope='creator')
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixAccounts(accs.filter((a) => a.platform === plat && (a.loginScope || 'main') === 'main').map((a) => ({ id: a.id, displayName: a.displayName, status: a.status, keywords: a.keywords, group: a.group, platform: a.platform, nickname: a.nickname, displayId: a.displayId, avatar: a.avatar })));
    } catch { setMatrixAccounts([]); }
    finally { setMatrixAccountsLoading(false); }
  };
  const saveMatrixTask = async (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; quota: any; funnel?: { funnel_phrase: string; funnel_probability: number } }) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    // 带 id = 更新现有任务(saveTask 是整体 upsert);无 id = 新建。
    // funnel:互动评论引流(选填),留空 → funnel_probability=0 → 评论纯 AI(向后兼容)。
    const r = await m?.saveTask?.({ id: matrixWizardTask?.id, platform: matrixWizardPlatform, type: 'engage', name: input.name, accountIds: input.accountIds, quota: input.quota, funnel: input.funnel, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixWizardPlatform; setMatrixWizardPlatform(null); setMatrixWizardTask(null); setDupNotice({ platform: dp as string, label: '互动' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixWizardTask?.id;
    const plat = matrixWizardPlatform;
    setMatrixWizardPlatform(null);
    setMatrixWizardTask(null);
    await refreshAll();
    // 编辑(从详情页进的)→ refreshAll 已就地刷新当前详情数据,不跳走(否则被踢回列表还要重新点进去);
    // 新建 → 切到管理页看新任务。
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };

  // ── 自动回复粉丝向导 ────────────────────────────────────────────────
  // 账号 scope:回复粉丝在创作者中心评论管理操作 —— 快手只能选【创作者中心】(loginScope='creator')
  // 账号(主站号是涨粉互动用的,登录态不通用)。其它平台无 loginScope → 取主站默认。
  const replyAccountFilter = (a: any, platform: string): boolean =>
    a.platform === platform && (platform === 'kuaishou' ? a.loginScope === 'creator' : (a.loginScope || 'main') === 'main');
  // 视频下载在【主站】操作(douyin/kuaishou/bilibili/tiktok 都打开 www.* 主站拿无水印源),所以
  // 一律取主站号 —— 快手也取主站(loginScope!='creator'),不同于回复粉丝那条用 creator scope。
  const downloadAccountFilter = (a: any, platform: string): boolean =>
    a.platform === platform && (a.loginScope || 'main') === 'main';
  const mapWizardAccount = (a: any): WizardAccount => ({ id: a.id, displayName: a.displayName, status: a.status, keywords: a.keywords, group: a.group, platform: a.platform, nickname: a.nickname, displayId: a.displayId, avatar: a.avatar });
  const openMatrixReplyWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'reply_fan', '回复粉丝')) return;
    // 先秒开弹窗,内核检查 + 账号加载后台异步(对齐编辑流程,避免 sidecar 忙时卡几秒)。
    setMatrixReplyAccounts([]);
    setMatrixReplyAccountsLoading(true);
    setMatrixReplyTask(null);
    setMatrixReplyPlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixReplyAccounts(accs.filter((a) => replyAccountFilter(a, platform)).map(mapWizardAccount));
    } catch { setMatrixReplyAccounts([]); }
    finally { setMatrixReplyAccountsLoading(false); }
  };
  // 编辑现有回复粉丝任务:回填账号/引流/频率 + 加载创作者中心账号(异步,弹窗先开)。
  const openMatrixReplyWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'kuaishou';
    setMatrixReplyAccounts([]);
    setMatrixReplyAccountsLoading(true);
    setMatrixReplyTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      funnel: { funnel_phrase: (task as any).funnel_phrase || '', funnel_probability: (task as any).funnel_probability ?? 0 },
      frequency: task.run_interval,
    });
    setMatrixReplyPlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixReplyAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
    } catch { setMatrixReplyAccounts([]); }
    finally { setMatrixReplyAccountsLoading(false); }
  };
  const saveMatrixReplyFanTask = async (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; funnel: { funnel_phrase: string; funnel_probability: number } }) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    // type='reply_fan' + funnel(无配额)。与同平台互动任务是不同 type,可并存。
    const r = await m?.saveTask?.({ id: matrixReplyTask?.id, platform: matrixReplyPlatform, type: 'reply_fan', name: input.name, accountIds: input.accountIds, funnel: input.funnel, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixReplyPlatform; setMatrixReplyPlatform(null); setMatrixReplyTask(null); setDupNotice({ platform: dp as string, label: '回复粉丝' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixReplyTask?.id;
    const plat = matrixReplyPlatform;
    setMatrixReplyPlatform(null);
    setMatrixReplyTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // 「视频无水印下载」向导(单账号):账号取主站 scope(同 replyAccountFilter,douyin 走主站登录态)。
  const openMatrixDownloadWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'video_download', '视频下载')) return;
    // 先秒开弹窗,内核检查 + 账号加载后台异步(对齐编辑流程,避免 sidecar 忙时卡几秒)。
    setMatrixDownloadAccounts([]);
    setMatrixDownloadAccountsLoading(true);
    setMatrixDownloadTask(null);
    setMatrixDownloadPlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixDownloadAccounts(accs.filter((a) => downloadAccountFilter(a, platform)).map(mapWizardAccount));
    } catch { setMatrixDownloadAccounts([]); }
    finally { setMatrixDownloadAccountsLoading(false); }
  };
  const openMatrixDownloadWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'douyin';
    setMatrixDownloadAccounts([]);
    setMatrixDownloadAccountsLoading(true);
    setMatrixDownloadTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      urls: Array.isArray((task as any).urls) ? (task as any).urls : [],
      frequency: task.run_interval,
    });
    setMatrixDownloadPlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixDownloadAccounts(accs.filter((a) => downloadAccountFilter(a, plat)).map(mapWizardAccount));
    } catch { setMatrixDownloadAccounts([]); }
    finally { setMatrixDownloadAccountsLoading(false); }
  };
  const saveMatrixDownloadTask = async (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; urls: string[] }) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    // type='video_download' + urls(单账号、无配额)。与同平台互动/回复是不同 type,可并存。
    const r = await m?.saveTask?.({ id: matrixDownloadTask?.id, platform: matrixDownloadPlatform, type: 'video_download', name: input.name, accountIds: input.accountIds, urls: input.urls, quota: {}, concurrency: 1, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixDownloadPlatform; setMatrixDownloadPlatform(null); setMatrixDownloadTask(null); setDupNotice({ platform: dp as string, label: '视频下载' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixDownloadTask?.id;
    const plat = matrixDownloadPlatform;
    setMatrixDownloadPlatform(null);
    setMatrixDownloadTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // 「图文创作」向导(多账号):账号取主站 scope(同 replyAccountFilter,douyin 主站登录态即覆盖创作者中心)。
  const openMatrixImageTextWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'image_text', '图文创作')) return;
    // 先秒开弹窗,内核检查 + 账号加载后台异步(对齐编辑流程,避免 sidecar 忙时卡几秒)。
    setMatrixImageTextAccounts([]);
    setMatrixImageTextAccountsLoading(true);
    setMatrixImageTextTask(null);
    setMatrixImageTextPlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixImageTextAccounts(accs.filter((a) => replyAccountFilter(a, platform)).map(mapWizardAccount));
      // 抖音下图号候选(视频号/头条网络图用):已登录抖音的主站号。
      setMatrixImageTextDownloadAccounts(accs.filter((a) => a.platform === 'douyin' && (a.loginScope || 'main') === 'main').map(mapWizardAccount));
    } catch { setMatrixImageTextAccounts([]); setMatrixImageTextDownloadAccounts([]); }
    finally { setMatrixImageTextAccountsLoading(false); }
  };
  const openMatrixImageTextWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'douyin';
    setMatrixImageTextAccounts([]);
    setMatrixImageTextAccountsLoading(true);
    setMatrixImageTextTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      imageText: (task as any).imageText,
      frequency: task.run_interval,
    });
    setMatrixImageTextPlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixImageTextAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
      setMatrixImageTextDownloadAccounts(accs.filter((a) => a.platform === 'douyin' && (a.loginScope || 'main') === 'main').map(mapWizardAccount));
    } catch { setMatrixImageTextAccounts([]); setMatrixImageTextDownloadAccounts([]); }
    finally { setMatrixImageTextAccountsLoading(false); }
  };
  const saveMatrixImageTextTask = async (input: ImageTextWizardSave) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    // 各号各自参考文案(wizard 已过滤空值,只含填了的号);每号每轮固定 1 篇。
    const imageText = {
      useRealPhotos: input.useRealPhotos,
      imageCount: input.imageCount,
      dailyCount: 1,
      aiImageStyle: input.aiImageStyle,
      autoPublish: input.autoPublish,
      references: input.references,
      // 内容来源:'reference'(参考文案,老行为)/ 'sources'(数据源选题,多选源每轮随机挑一条)。
      contentSource: input.contentSource,
      sources: input.sources,
      // 视频号/头条网络图:抖音下图号(runner 据此启抖音内核串行搜图);其它平台/AI生图为 undefined。
      imageDownloadAccountId: input.imageDownloadAccountId,
    };
    const r = await m?.saveTask?.({ id: matrixImageTextTask?.id, platform: matrixImageTextPlatform, type: 'image_text', name: input.name, accountIds: input.accountIds, imageText, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixImageTextPlatform; setMatrixImageTextPlatform(null); setMatrixImageTextTask(null); setDupNotice({ platform: dp as string, label: '图文创作' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixImageTextTask?.id;
    const plat = matrixImageTextPlatform;
    setMatrixImageTextPlatform(null);
    setMatrixImageTextTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // 「自动发推」向导(多账号):账号取主站 scope(推特主站登录态,发推在 x.com 主站)。
  const openMatrixTweetWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'x_post', '自动发推')) return;
    // 先秒开弹窗,内核检查 + 账号加载后台异步(对齐编辑流程,避免 sidecar 忙时卡几秒)。
    setMatrixTweetAccounts([]);
    setMatrixTweetAccountsLoading(true);
    setMatrixTweetTask(null);
    setMatrixTweetPlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixTweetAccounts(accs.filter((a) => replyAccountFilter(a, platform)).map(mapWizardAccount));
    } catch { setMatrixTweetAccounts([]); }
    finally { setMatrixTweetAccountsLoading(false); }
  };
  const openMatrixTweetWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'x';
    setMatrixTweetAccounts([]);
    setMatrixTweetAccountsLoading(true);
    setMatrixTweetTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      tweetPost: (task as any).tweetPost,
      frequency: task.run_interval,
    });
    setMatrixTweetPlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixTweetAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
    } catch { setMatrixTweetAccounts([]); }
    finally { setMatrixTweetAccountsLoading(false); }
  };
  const saveMatrixTweetTask = async (input: TweetPostWizardSave) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    const tweetPost = {
      mode: input.mode,
      sources: input.sources,   // 数据源模式的多选源(每轮随机挑 1 个取题)
      withImage: input.withImage,
      language: input.language,
      isBlueV: input.isBlueV,
      autoPublish: input.autoPublish,
      references: input.references,
    };
    const r = await m?.saveTask?.({ id: matrixTweetTask?.id, platform: matrixTweetPlatform, type: 'x_post', name: input.name, accountIds: input.accountIds, tweetPost, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixTweetPlatform; setMatrixTweetPlatform(null); setMatrixTweetTask(null); setDupNotice({ platform: dp as string, label: '自动发推' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixTweetTask?.id;
    const plat = matrixTweetPlatform;
    setMatrixTweetPlatform(null);
    setMatrixTweetTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // 「币安广场自动发帖」向导(多账号):账号取主站 scope(币安主站登录态即覆盖币安广场)。
  const openMatrixBinanceWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'binance_post', '币安广场发帖')) return;
    // 先秒开弹窗,内核检查 + 账号加载后台异步(对齐编辑流程,避免 sidecar 忙时卡几秒)。
    setMatrixBinanceAccounts([]);
    setMatrixBinanceAccountsLoading(true);
    setMatrixBinanceTask(null);
    setMatrixBinancePlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixBinanceAccounts(accs.filter((a) => replyAccountFilter(a, platform)).map(mapWizardAccount));
    } catch { setMatrixBinanceAccounts([]); }
    finally { setMatrixBinanceAccountsLoading(false); }
  };
  const openMatrixBinanceWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'binance';
    setMatrixBinanceAccounts([]);
    setMatrixBinanceAccountsLoading(true);
    setMatrixBinanceTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      binancePost: (task as any).binancePost,
      frequency: task.run_interval,
    });
    setMatrixBinancePlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixBinanceAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
    } catch { setMatrixBinanceAccounts([]); }
    finally { setMatrixBinanceAccountsLoading(false); }
  };
  const saveMatrixBinanceTask = async (input: BinancePostWizardSave) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    const binancePost = {
      withImage: input.withImage,
      language: input.language,
      autoPublish: input.autoPublish,
    };
    const r = await m?.saveTask?.({ id: matrixBinanceTask?.id, platform: matrixBinancePlatform, type: 'binance_post', name: input.name, accountIds: input.accountIds, binancePost, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixBinancePlatform; setMatrixBinancePlatform(null); setMatrixBinanceTask(null); setDupNotice({ platform: dp as string, label: '币安广场发帖' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixBinanceTask?.id;
    const plat = matrixBinancePlatform;
    setMatrixBinancePlatform(null);
    setMatrixBinanceTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // ── Facebook 自动发帖向导(复用 binancePostRunner + facebook_post 剧本) ──
  const openMatrixFacebookWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'facebook_post', 'Facebook 发帖')) return;
    setMatrixFacebookAccounts([]);
    setMatrixFacebookAccountsLoading(true);
    setMatrixFacebookTask(null);
    setMatrixFacebookPlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixFacebookAccounts(accs.filter((a) => replyAccountFilter(a, platform)).map(mapWizardAccount));
    } catch { setMatrixFacebookAccounts([]); }
    finally { setMatrixFacebookAccountsLoading(false); }
  };
  const openMatrixFacebookWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'facebook';
    setMatrixFacebookAccounts([]);
    setMatrixFacebookAccountsLoading(true);
    setMatrixFacebookTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      facebookPost: (task as any).facebookPost,
      frequency: task.run_interval,
    });
    setMatrixFacebookPlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixFacebookAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
    } catch { setMatrixFacebookAccounts([]); }
    finally { setMatrixFacebookAccountsLoading(false); }
  };
  const saveMatrixFacebookTask = async (input: FacebookPostWizardSave) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    const facebookPost = {
      withImage: input.withImage,
      language: input.language,
      autoPublish: input.autoPublish,
      sources: input.sources,   // 多选源(每轮随机挑 1 个);旧单选字段=第一个选中源,兼容旧 orchestrator
      sourceKind: input.sourceKind,
      source: input.source,
      catKey: input.catKey,
    };
    const r = await m?.saveTask?.({ id: matrixFacebookTask?.id, platform: matrixFacebookPlatform, type: 'facebook_post', name: input.name, accountIds: input.accountIds, facebookPost, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixFacebookPlatform; setMatrixFacebookPlatform(null); setMatrixFacebookTask(null); setDupNotice({ platform: dp as string, label: 'Facebook 发帖' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixFacebookTask?.id;
    const plat = matrixFacebookPlatform;
    setMatrixFacebookPlatform(null);
    setMatrixFacebookTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // ── Reddit 自动发帖向导(复用 binancePostRunner + reddit_post 剧本) ──
  const openMatrixRedditWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'reddit_post', 'Reddit 发帖')) return;
    setMatrixRedditAccounts([]);
    setMatrixRedditAccountsLoading(true);
    setMatrixRedditTask(null);
    setMatrixRedditPlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixRedditAccounts(accs.filter((a) => replyAccountFilter(a, platform)).map(mapWizardAccount));
    } catch { setMatrixRedditAccounts([]); }
    finally { setMatrixRedditAccountsLoading(false); }
  };
  const openMatrixRedditWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'reddit';
    setMatrixRedditAccounts([]);
    setMatrixRedditAccountsLoading(true);
    setMatrixRedditTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      redditPost: (task as any).redditPost,
      frequency: task.run_interval,
    });
    setMatrixRedditPlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixRedditAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
    } catch { setMatrixRedditAccounts([]); }
    finally { setMatrixRedditAccountsLoading(false); }
  };
  const saveMatrixRedditTask = async (input: RedditPostWizardSave) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    const redditPost = {
      language: input.language,
      autoPublish: input.autoPublish,
      sources: input.sources,   // 多选源(每轮随机挑 1 个);旧单选字段=第一个选中源,兼容旧 orchestrator
      sourceKind: input.sourceKind,
      source: input.source,
      catKey: input.catKey,
      subreddit: input.subreddit,
    };
    const r = await m?.saveTask?.({ id: matrixRedditTask?.id, platform: matrixRedditPlatform, type: 'reddit_post', name: input.name, accountIds: input.accountIds, redditPost, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixRedditPlatform; setMatrixRedditPlatform(null); setMatrixRedditTask(null); setDupNotice({ platform: dp as string, label: 'Reddit 发帖' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixRedditTask?.id;
    const plat = matrixRedditPlatform;
    setMatrixRedditPlatform(null);
    setMatrixRedditTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // ── Instagram 自动发帖向导(复用 binancePostRunner + instagram_post 剧本) ──
  const openMatrixInstagramWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'instagram_post', 'Instagram 发帖')) return;
    setMatrixInstagramAccounts([]);
    setMatrixInstagramAccountsLoading(true);
    setMatrixInstagramTask(null);
    setMatrixInstagramPlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixInstagramAccounts(accs.filter((a) => replyAccountFilter(a, platform)).map(mapWizardAccount));
    } catch { setMatrixInstagramAccounts([]); }
    finally { setMatrixInstagramAccountsLoading(false); }
  };
  const openMatrixInstagramWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'instagram';
    setMatrixInstagramAccounts([]);
    setMatrixInstagramAccountsLoading(true);
    setMatrixInstagramTask({
      id: task.id,
      name: task.name,
      accountIds: task.account_ids || [],
      instagramPost: (task as any).instagramPost,
      frequency: task.run_interval,
    });
    setMatrixInstagramPlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixInstagramAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
    } catch { setMatrixInstagramAccounts([]); }
    finally { setMatrixInstagramAccountsLoading(false); }
  };
  const saveMatrixInstagramTask = async (input: InstagramPostWizardSave) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    const instagramPost = {
      withImage: true,
      language: input.language,
      autoPublish: input.autoPublish,
      sources: input.sources,   // 多选源(每轮随机挑 1 个);旧单选字段=第一个选中源,兼容旧 orchestrator
      sourceKind: input.sourceKind,
      source: input.source,
      catKey: input.catKey,
    };
    const r = await m?.saveTask?.({ id: matrixInstagramTask?.id, platform: matrixInstagramPlatform, type: 'instagram_post', name: input.name, accountIds: input.accountIds, instagramPost, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixInstagramPlatform; setMatrixInstagramPlatform(null); setMatrixInstagramTask(null); setDupNotice({ platform: dp as string, label: 'Instagram 发帖' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixInstagramTask?.id;
    const plat = matrixInstagramPlatform;
    setMatrixInstagramPlatform(null);
    setMatrixInstagramTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // ── 币安广场批量搬运向导:发布号取币安(replyAccountFilter),采集号取【全部账号】(按所选源平台过滤在 wizard 内做)。 ──
  const loadRepostAccounts = async (plat: string) => {
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixRepostAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
      setMatrixRepostSourceAccounts(accs.map(mapWizardAccount));
    } catch { setMatrixRepostAccounts([]); setMatrixRepostSourceAccounts([]); }
    finally { setMatrixRepostAccountsLoading(false); }
  };
  const openMatrixRepostWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'binance_repost', '币安广场搬运')) return;
    setMatrixRepostAccounts([]); setMatrixRepostSourceAccounts([]);
    setMatrixRepostAccountsLoading(true);
    setMatrixRepostTask(null);
    setMatrixRepostPlatform(platform);
    await loadRepostAccounts(platform);
  };
  const openMatrixRepostWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'binance';
    setMatrixRepostAccounts([]); setMatrixRepostSourceAccounts([]);
    setMatrixRepostAccountsLoading(true);
    setMatrixRepostTask({ id: task.id, name: task.name, accountIds: task.account_ids || [], binanceRepost: (task as any).binanceRepost, frequency: task.run_interval });
    setMatrixRepostPlatform(plat);
    await loadRepostAccounts(plat);
  };
  const saveMatrixRepostTask = async (input: BinanceRepostWizardSave) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    const binanceRepost = {
      sourcePlatform: input.sourcePlatform,
      sourceAccountId: input.sourceAccountId,
      material: input.material,
      withImage: input.withImage,
      language: input.language,
      autoPublish: input.autoPublish,
    };
    const r = await m?.saveTask?.({ id: matrixRepostTask?.id, platform: matrixRepostPlatform, type: 'binance_repost', name: input.name, accountIds: input.accountIds, binanceRepost, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixRepostPlatform; setMatrixRepostPlatform(null); setMatrixRepostTask(null); setDupNotice({ platform: dp as string, label: '币安广场搬运' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixRepostTask?.id;
    const plat = matrixRepostPlatform;
    setMatrixRepostPlatform(null);
    setMatrixRepostTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // 「爆款批量仿写」向导(多账号):账号取主站 scope(同 replyAccountFilter,小红书主站登录态)。
  const openMatrixViralWizard = async (platform: string) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    if (await hasDupTask(platform, 'viral_rewrite', '爆款仿写')) return;
    // 先秒开弹窗,内核检查 + 账号加载后台异步(对齐编辑流程,避免 sidecar 忙时卡几秒)。
    setMatrixViralAccounts([]);
    setMatrixViralAccountsLoading(true);
    setMatrixViralTask(null);
    setMatrixViralPlatform(platform);
    void ensureMatrixKernel();
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixViralAccounts(accs.filter((a) => replyAccountFilter(a, platform)).map(mapWizardAccount));
    } catch { setMatrixViralAccounts([]); }
    finally { setMatrixViralAccountsLoading(false); }
  };
  const openMatrixViralWizardEdit = async (task: any) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); return; }
    const plat = (task?.platform as string) || currentPlatform || 'xhs';
    setMatrixViralAccounts([]);
    setMatrixViralAccountsLoading(true);
    setMatrixViralTask({ id: task.id, name: task.name, accountIds: task.account_ids || [], viralRewrite: (task as any).viralRewrite, frequency: task.run_interval });
    setMatrixViralPlatform(plat);
    try {
      const r = await (window as any).electron?.matrix?.listAccounts?.();
      const accs: any[] = r?.ok && Array.isArray(r.accounts) ? r.accounts : [];
      setMatrixViralAccounts(accs.filter((a) => replyAccountFilter(a, plat)).map(mapWizardAccount));
    } catch { setMatrixViralAccounts([]); }
    finally { setMatrixViralAccountsLoading(false); }
  };
  const saveMatrixViralTask = async (input: ViralRewriteWizardSave) => {
    if (!noobClawAuth.getState().isAuthenticated) { noobClawAuth.requireLoginUI(); throw new Error('请先登录 NoobClaw 账号'); }
    const m = (window as any).electron?.matrix;
    const viralRewrite = { dailyCount: input.dailyCount, aiImageStyle: input.aiImageStyle, autoPublish: input.autoPublish };
    const r = await m?.saveTask?.({ id: matrixViralTask?.id, platform: matrixViralPlatform, type: 'viral_rewrite', name: input.name, accountIds: input.accountIds, viralRewrite, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) {
      if (r?.error === 'duplicate_type') { const dp = matrixViralPlatform; setMatrixViralPlatform(null); setMatrixViralTask(null); setDupNotice({ platform: dp as string, label: '爆款仿写' }); return; }
      throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限' } as any)[r?.error] || r?.error || '保存失败');
    }
    const wasEdit = !!matrixViralTask?.id;
    const plat = matrixViralPlatform;
    setMatrixViralPlatform(null);
    setMatrixViralTask(null);
    await refreshAll();
    if (!wasEdit) onSwitchToManage?.(plat as any);
  };
  // Link-mode edit modal (separate from the keyword wizard — they capture
  // completely different inputs and users were confusing them)
  const [linkEditTask, setLinkEditTask] = useState<Task | null>(null);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      // Load tasks and drafts first (local, fast)
      const [t, d] = await Promise.all([
        scenarioService.listTasks().catch(() => []),
        scenarioService.listDrafts().catch(() => []),
      ]);
      setTasks(Array.isArray(t) ? t : []);
      setDrafts(Array.isArray(d) ? d : []);
      setLoading(false);

      // Load scenarios in background (network, slow) — don't block UI.
      // Only REPLACE the bundled DEFAULT_SCENARIOS snapshot when the API
      // returns a non-empty array. If the API call fails or returns []
      // (e.g. user is offline / backend down) we keep the bundled
      // snapshot so the UI stays usable.
      scenarioService.listScenarios().then(s => {
        if (Array.isArray(s) && s.length > 0) setScenarios(s);
      }).catch(() => {});
    } catch (err) {
      console.error('[ScenarioView] refreshAll failed:', err);
      setFatalError(String(err instanceof Error ? err.message : err));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    // Sidecar might not be ready on first mount — retry once after 2s
    const t1 = setTimeout(() => void refreshAll(), 2000);
    return () => { clearTimeout(t1); };
  }, [refreshAll]);

  // Live window title showing running tasks. Polls running task ids + each
  // task's current step every 3s. Shows e.g.:
  //   "推特任务-步骤2 · 小红书任务-步骤1 — NoobClaw"
  // when 2 tasks are running, or just "NoobClaw" when idle. The user can
  // glance at the OS window list / dock and see status without bringing
  // the app to foreground.
  useEffect(() => {
    let cancelled = false;
    const baseTitle = 'NoobClaw';
    const tick = async () => {
      try {
        const ids = await scenarioService.getRunningTaskIds();
        if (cancelled) return;
        if (ids.length === 0) {
          document.title = baseTitle;
          return;
        }
        const scenarioById = new Map(scenarios.map(s => [s.id, s]));
        const parts: string[] = [];
        for (const id of ids) {
          const t = tasks.find(t => t.id === id);
          if (!t) continue;
          const s = scenarioById.get(t.scenario_id);
          const platform = s?.platform === 'x' ? '推特'
            : s?.platform === 'xhs' ? '小红书'
            : s?.platform === 'binance' ? '币安广场'
            : s?.platform === 'tiktok' ? 'TikTok'
            : s?.platform === 'youtube' ? 'YouTube'
            : s?.platform === 'douyin' ? '抖音'
            : s?.platform === 'shipinhao' ? '视频号'
            : s?.platform === 'toutiao' ? '头条号'
            : (s?.platform as string) === 'facebook' ? 'Facebook'
            : (s?.platform as string) === 'reddit' ? 'Reddit'
            : (s?.platform as string) === 'instagram' ? 'Instagram'
            : (s?.platform || '');
          // Get this task's progress to know which step it's in
          const prog = await scenarioService.getRunProgress(id).catch(() => null);
          if (prog && prog.status === 'running' && prog.currentStep > 0) {
            parts.push(`${platform}任务-步骤${prog.currentStep}`);
          } else if (prog && prog.status === 'done') {
            parts.push(`${platform}任务-已结束`);
          } else if (prog && prog.status === 'error') {
            parts.push(`${platform}任务-异常`);
          } else {
            parts.push(`${platform}任务-启动中`);
          }
        }
        document.title = parts.length > 0 ? `${parts.join(' · ')} — ${baseTitle}` : baseTitle;
      } catch {
        if (!cancelled) document.title = baseTitle;
      }
    };
    void tick();
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); document.title = baseTitle; };
  }, [tasks, scenarios]);

  // Derive the platform tab to highlight + return to:
  //   - workflows view  → use view.platform directly
  //   - task_detail     → look up task → its scenario → scenario.platform
  //                       (so Twitter tasks keep the 🐦 tab active)
  //   - sensitive_check → XHS-only feature, fall back to 'xhs'
  const currentPlatform: PlatformId = (() => {
    if (view.kind === 'main') return view.platform;
    if (view.kind === 'task_detail') {
      const t = tasks.find(t => t.id === view.task_id);
      const s = t ? scenarios.find(s => s.id === t.scenario_id) : null;
      // 优先用任务自带 platform:发帖类 scenario(facebook_post/reddit_post/instagram_post 等)
      //   常不在 scenarios 快照里 → s=null → 原来落到下面 'xhs' 兜底,FB 任务返回错跳小红书 tab。
      const p = (t as any)?.platform || s?.platform;
      // v2.4.61: 漏了 'binance' — 进币安任务详情然后返回会跳回小红书 tab
      // v6.x:  漏了 'video' — 翻译二创(scenario.platform='video')详情返回也会掉小红书 tab
      if (p === 'xhs' || p === 'x' || p === 'binance' || p === 'douyin' || p === 'shipinhao' || p === 'toutiao' || p === 'kuaishou' || p === 'bilibili' || p === 'tiktok' || p === 'youtube' || (p as string) === 'facebook' || (p as string) === 'reddit' || (p as string) === 'instagram' || p === 'video') return p as PlatformId;
      return 'xhs';
    }
    return 'xhs';
  })();

  // The currently-active top-level section (create / tasks / history). Used
  // to highlight the right L1 tab AND to remember which section to go back
  // to after viewing a task detail.
  const currentSection: SectionId = (() => {
    if (view.kind === 'main') return view.section;
    if (view.kind === 'task_detail') return view.from || 'tasks';
    return 'create';
  })();

  const setSection = (section: SectionId) => {
    // Clear any task filter when manually switching sections via the L1 tabs.
    setView({ kind: 'main', section, platform: currentPlatform });
  };

  const setPlatform = (platform: PlatformId) => {
    // 平台间互切一律沿用当前 section(tasks/history/create):
    //   - 创建态点别的平台 tab → 停在该平台的创建页(跟用户在"新建涨粉任务"里切 tab 的预期一致);
    //   - 任务页 / 运行记录页 切 tab → 看该平台对应的同一 section。
    // 视频创作以前被特判过(强制掉到 'tasks'),但 VideoWorkflowsPage 已经完整支持
    //   三种 section(含 history → VideoRunHistory),不需要再特判。
    setView({ kind: 'main', section: currentSection, platform });
  };

  // 进入视频创建流。跟其他平台「新建」一致先过积分门槛(余额 < 10000 弹"积分
  // 不足"提示框,点充值跳钱包页),通过才真正切到 create。两个入口(落地页占位框 /
  // 右上 CTA)都走这里,保证门槛一致。
  const goVideoCreate = () => {
    // manage 模式不自带新建页 —— 切到「一键涨粉」create 菜单(视频 tab)。
    if (mode !== 'create') { onSwitchToCreate?.('video'); return; }
    if (!noobClawAuth.hasEnoughBalanceForTask()) return;
    setView({ kind: 'main', section: 'create', platform: 'video' });
  };

  /** 进入某平台的新建流。create 模式留在本实例切 create 段;manage 模式切到
   *  「一键涨粉」create 菜单(干净拆分)。两条路都先过积分门槛。 */
  const goCreatePlatform = (platform: PlatformId) => {
    if (!noobClawAuth.hasEnoughBalanceForTask()) return;
    if (mode === 'create') { setView({ kind: 'main', section: 'create', platform }); return; }
    onSwitchToCreate?.(platform);
  };

  const openTask = (task_id: string, fromOverride?: SectionId) => {
    // `fromOverride` lets callers (e.g. link-mode quick-create flows in
    // XhsWorkflowsPage / XWorkflowsPage) say "treat this as if user came
    // from My Tasks" so the back button doesn't dump them back into the
    // creation form they just submitted. Defaults to currentSection.
    setView({ kind: 'task_detail', task_id, from: fromOverride || currentSection });
  };

  /** Jump from a task's detail page to Run History filtered by that task. */
  const openHistoryForTask = (task_id: string) => {
    // Resolve platform from the task so the right L2 sub-tab is active.
    const t = tasks.find(t => t.id === task_id);
    const s = t ? scenarios.find(s => s.id === t.scenario_id) : null;
    const p = (s?.platform === 'x' || s?.platform === 'xhs' || s?.platform === 'binance') ? s.platform : currentPlatform;
    setView({ kind: 'main', section: 'history', platform: p, filterTaskId: task_id });
  };

  const openSensitiveCheck = () => {
    setView({ kind: 'sensitive_check' });
  };

  // Go back to the section the user was on before opening a detail page.
  // task_detail remembers via `view.from`; record_detail returns to the
  // history section it came from (optionally still filtered); sensitive_check
  // just goes home.
  const goBack = () => {
    if (view.kind === 'task_detail' && view.from) {
      setView({ kind: 'main', section: view.from, platform: currentPlatform });
    } else if (view.kind === 'record_detail') {
      setView({ kind: 'main', section: 'history', platform: view.from_platform, filterTaskId: view.filterTaskId });
    } else {
      setView({ kind: 'main', section: baseSection, platform: currentPlatform });
    }
  };

  /** Open a run record's read-only detail page. Remembers where we came
   *  from so the back button takes the user back to the right filtered
   *  history view. */
  const openRecord = (record_id: string) => {
    const currentFilter = view.kind === 'main' ? view.filterTaskId || null : null;
    setView({ kind: 'record_detail', record_id, from_platform: currentPlatform, filterTaskId: currentFilter });
  };

  const openWizardFor = (scenario: Scenario) => {
    setWizardScenario(scenario);
    setWizardEditingTask(null);
  };

  const openWizardEdit = (task: Task, scenario: Scenario) => {
    // Link-mode tasks have a completely different input shape (URLs vs
    // keywords) — open the dedicated link editor instead of the keyword
    // wizard so users aren't asked to pick a track for links they already
    // supplied.
    const isLinkMode = task.track === 'link_mode'
      || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
    if (isLinkMode) {
      setLinkEditTask(task);
      return;
    }
    setWizardScenario(scenario);
    setWizardEditingTask(task);
  };

  const closeWizard = () => {
    setWizardScenario(null);
    setWizardEditingTask(null);
  };

  const closeLinkEdit = () => setLinkEditTask(null);

  const handleWizardSave = async (input: {
    scenario_id: string;
    track: string;
    keywords: string[];
    persona: string;
    daily_count: number;
    variants_per_post: number;
    daily_time: string;
    /** Twitter v1: extra optional fields. Spread through unchanged. */
    language?: 'zh' | 'en' | 'mixed';
    user_context?: string;
    urls?: string[];
    /** douyin_image_text: 3 段灵感来源,跟 keywords 互斥 */
    source_segments?: string[];
    /** douyin_image_text / xhs viral_production: 自动上传草稿 vs 仅生成 */
    auto_upload?: boolean;
    /** douyin_image_text: true=直接发布,false=存草稿(仅 auto_upload=true 时生效) */
    auto_publish?: boolean;
  }) => {
    let landingTaskId: string | null = null;
    let createdLinkRewrite = false;
    if (wizardEditingTask) {
      // Edit → always activate as scheduled task
      await scenarioService.updateTask(wizardEditingTask.id, { ...input, active: true, enabled: true });
      landingTaskId = wizardEditingTask.id;
    } else {
      // Create → land on the new task's detail page (v2.4.30+) so the
      // user immediately sees the task they just configured instead of
      // staring at the empty Create page wondering "did it work?".
      // createTask returns the persisted Task with its assigned id.
      const created = await scenarioService.createTask({ ...input, enabled: true, active: true });
      landingTaskId = created?.id || null;
      // v4.28.x: 链接仿写场景(x_link_rewrite / binance_from_x_link)创建后立刻 runTaskNow,
      // 跟 X / XHS workflows 页面里的"快速 link 模式"行为对齐 —— 用户粘了 URL 列表
      // 就是想立刻看结果,不应该等下一次 scheduler tick 或者手动点"立即运行"。
      // 普通调度型场景(post_creator / repost / auto_engage)保持原行为(等 scheduler)。
      if (created?.id && (input.scenario_id === 'x_link_rewrite' || input.scenario_id === 'binance_from_x_link')) {
        createdLinkRewrite = true;
      }
    }
    closeWizard();
    // Refresh BEFORE navigating so TaskDetailPage can find the new task
    // in the freshly-loaded tasks[] (otherwise it would render the
    // "task deleted" empty state for a split second).
    await refreshAll();
    if (landingTaskId) {
      setView({ kind: 'task_detail', task_id: landingTaskId, from: baseSection });
      if (createdLinkRewrite) {
        // 异步触发,不阻塞跳转
        scenarioService.runTaskNow(landingTaskId).catch(e => {
          console.error('[ScenarioView] link-rewrite auto-run failed:', e);
        });
      }
    }
  };

  const tasksForPlatform = useMemo(() => {
    if (!Array.isArray(tasks)) return [];
    // 矩阵任务优先按 t.platform 过滤(mxTaskToScenario 已透传)—— 不能只走 scenario 注册表 byId 映射:
    //   FB/Reddit/Instagram 等新平台的剧本不在客户端 scenarios 注册表里 → byId 映射不到 → 任务【看不见】,
    //   而 hasDupTask 按 t.platform 又能查到 → 报「已有任务却看不见、也创建不了」(用户实测)。
    //   同时保留 byId 兜底:platform 字段缺失的旧任务行仍按 scenario_id 归位,不能全部隐身(用户实测回归)。
    if (matrixMode) {
      const byId = new Map((Array.isArray(scenarios) ? scenarios : []).map(s => [s.id, s]));
      return tasks.filter((t) => ((t as any).platform || byId.get(t.scenario_id)?.platform) === currentPlatform);
    }
    if (!Array.isArray(scenarios)) return [];
    const byId = new Map(scenarios.map(s => [s.id, s]));
    return tasks.filter(t => byId.get(t.scenario_id)?.platform === currentPlatform);
  }, [tasks, scenarios, currentPlatform, matrixMode]);

  const draftsByTask = useMemo(() => {
    const map = new Map<string, Draft[]>();
    if (!Array.isArray(drafts)) return map;
    for (const d of drafts) {
      const arr = map.get(d.task_id) || [];
      arr.push(d);
      map.set(d.task_id, arr);
    }
    return map;
  }, [drafts]);

  // ── Render ──

  const platformTabContent = (() => {
    if (view.kind === 'sensitive_check') {
      return <SensitiveCheckPage onBack={goBack} />;
    }
    if (view.kind === 'record_detail') {
      return (
        <RunRecordDetailPage
          recordId={view.record_id}
          onBack={goBack}
          onOpenTask={openTask}
        />
      );
    }
    if (view.kind === 'task_detail') {
      const task = tasks.find(t => t.id === view.task_id);
      if (!task) {
        // Empty state for "task was deleted" — common path now that the
        // History page deep-links by task id (the underlying task may
        // have been deleted since the run finished). Pre-2.4.27 we just
        // showed "暂无任务。从下面选一个场景开始。" which had no buttons,
        // so the user was stuck and had to click L1 nav manually. Now
        // we offer one-click jumps to the create page for either platform.
        // 余额门槛 + create/manage 分流统一走 goCreatePlatform。
        const goCreate = (platform: PlatformId) => goCreatePlatform(platform);
        return (
          <div className="p-10 max-w-xl mx-auto">
            <div className="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
              <div className="text-5xl mb-3">🗑️</div>
              <div className="text-base font-medium text-gray-700 dark:text-gray-200 mb-1">
                {i18nService.t('svTaskDeleted')}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                {i18nService.t('svTaskDeletedHint')}
              </div>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  type="button"
                  onClick={() => goCreate('xhs')}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-green-500 text-white text-sm font-semibold hover:bg-green-600 shadow-sm shadow-green-500/25 transition-all active:scale-95"
                >
                  📕 {i18nService.t('svNewXhsTask')}
                </button>
                <button
                  type="button"
                  onClick={() => goCreate('x')}
                  className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-sky-500 text-white text-sm font-semibold hover:bg-sky-600 shadow-sm shadow-sky-500/25 transition-all active:scale-95"
                >
                  🐦 {i18nService.t('svNewTwitterTask')}
                </button>
              </div>
              <button
                type="button"
                onClick={goBack}
                className="mt-5 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                ← {i18nService.t('svBack')}
              </button>
            </div>
          </div>
        );
      }
      const scenario = scenarios.find(s => s.id === task.scenario_id);
      return (
        <TaskDetailPage
          task={task}
          scenario={scenario || null}
          onBack={goBack}
          /* 矩阵号:编辑打开账号多选向导(回填该任务的账号/配额/频率),不开原版 ConfigWizard */
          onEdit={() => { if (matrixMode) { if (/_video_download$/.test(String(task.scenario_id || ''))) { void openMatrixDownloadWizardEdit(task); } else if (/_image_text$/.test(String(task.scenario_id || ''))) { void openMatrixImageTextWizardEdit(task); } else if (/_viral_production_career$/.test(String(task.scenario_id || ''))) { void openMatrixViralWizardEdit(task); } else if (String(task.scenario_id || '') === 'x_post') { void openMatrixTweetWizardEdit(task); } else if (String(task.scenario_id || '') === 'binance_post') { void openMatrixBinanceWizardEdit(task); } else if (String(task.scenario_id || '') === 'facebook_post') { void openMatrixFacebookWizardEdit(task); } else if (String(task.scenario_id || '') === 'reddit_post') { void openMatrixRedditWizardEdit(task); } else if (String(task.scenario_id || '') === 'instagram_post') { void openMatrixInstagramWizardEdit(task); } else if (String(task.scenario_id || '') === 'binance_repost') { void openMatrixRepostWizardEdit(task); } else if (/_reply_fans_comment$/.test(String(task.scenario_id || ''))) { void openMatrixReplyWizardEdit(task); } else { void openMatrixWizardEdit(task); } return; } if (scenario) openWizardEdit(task, scenario); }}
          onChanged={refreshAll}
          onOpenHistory={() => openHistoryForTask(task.id)}
        />
      );
    }

    // 多平台视频创作 —— 本地合成工具,不走 scenario 任务体系,但交互跟其他 tab
    // 对齐:section='create' 走创建向导,否则(tasks)走落地页(占位框 + 卡片)。
    // 返回 / 新建由 ScenarioView 顶部头部统一处理(见下方 header 区块)。
    if (currentPlatform === 'video') {
      return (
        <VideoWorkflowsPage
          matrixMode={matrixMode}
          section={currentSection === 'create' ? 'create' : currentSection === 'history' ? 'history' : 'tasks'}
          onGoCreate={goVideoCreate}
          onBack={() => setView({ kind: 'main', section: 'tasks', platform: 'video' })}
          /* create 模式(「新建涨粉任务」菜单)点「已有任务」→ 跳「我的涨粉任务」管理页并定位
             视频 tab(切顶层 mainView,侧栏高亮 + 标题都对);manage/runs 模式不传 → 回退用 onBack
             内部切到 tasks。 */
          onGoTasks={mode === 'create' && onSwitchToManage ? () => onSwitchToManage('video') : undefined}
          onDetailChange={setVideoInDetail}
          onRefresh={refreshAll}
        />
      );
    }

    // Section + platform branching. Each L1 section has a per-platform
    // view; the user picked the platform via the L2 sub-tabs above.
    // Platform display label — locale-aware so the My Tasks / History
    // page headers don't show Chinese names in EN mode.
    const isZh = i18nService.currentLanguage === 'zh';
    const platformLabel = currentPlatform === 'xhs' ? (isZh ? '小红书' : 'Xiaohongshu')
      : currentPlatform === 'x' ? (isZh ? '推特' : 'Twitter')
      : currentPlatform === 'binance' ? (isZh ? '币安广场' : 'Binance Square')
      : currentPlatform === 'tiktok' ? 'TikTok'
      : currentPlatform === 'youtube' ? 'YouTube'
      : currentPlatform === 'douyin' ? (isZh ? '抖音' : 'Douyin')
      : currentPlatform === 'shipinhao' ? (isZh ? '视频号' : 'WeChat Channels')
      : currentPlatform === 'toutiao' ? (isZh ? '头条号' : 'Toutiao')
      : currentPlatform === 'kuaishou' ? (isZh ? '快手' : 'Kuaishou')
      : currentPlatform === 'bilibili' ? (isZh ? '哔哩哔哩' : 'Bilibili')
      : currentPlatform === 'facebook' ? 'Facebook'
      : currentPlatform === 'reddit' ? 'Reddit'
      : currentPlatform === 'instagram' ? 'Instagram'
      : currentPlatform;

    if (currentSection === 'tasks') {
      return (
        <MyTasksPage
          tasks={tasksForPlatform}
          scenarios={scenarios}
          loading={loading}
          platformLabel={platformLabel}
          platformId={currentPlatform === 'x' ? 'x' : currentPlatform === 'binance' ? 'binance' : 'xhs'}
          onOpenTask={openTask}
          onRefresh={refreshAll}
          onGoCreate={() => goCreatePlatform(currentPlatform)}
        />
      );
    }

    if (currentSection === 'history') {
      const filterTaskId = view.kind === 'main' ? view.filterTaskId || null : null;
      return (
        <RunHistoryPage
          tasks={tasksForPlatform}
          scenarios={scenarios}
          platformId={currentPlatform}
          platformLabel={platformLabel}
          onOpenRecord={openRecord}
          filterByTaskId={filterTaskId}
          onClearFilter={() => setView({ kind: 'main', section: 'history', platform: currentPlatform })}
        />
      );
    }

    // currentSection === 'create' — show the platform's scenario cards
    // 矩阵号:每个平台只有「互动涨粉」一个卡片(账号制),点开 MatrixTaskWizard。
    if (matrixMode) {
      const platLabel = platformLabel;
      // 视频号/头条暂无 engage 剧本 → tab 在(与账号页一致),但「开始创作」改为「即将上线」不放行。
      const engageReady = MATRIX_ENGAGE_PLATFORMS.has(currentPlatform);
      return (
        <div className="p-6 max-w-5xl mx-auto">
          {/* 新建任务卡片:每行 2 个(互动涨粉 + 自动回复粉丝),与其它新建 tab 的卡片网格一致 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
          {/* 互动涨粉卡:仅在该平台有 engage 剧本(MATRIX_ENGAGE_PLATFORMS)时显示。
              视频号/头条号无 engage → 不显示这张卡(它们仍有自动回复粉丝卡,tab 不会空),
              而不是显示一张「即将上线」占位卡。 */}
          {engageReady && (
          <div className="rounded-2xl border border-violet-500/30 bg-violet-500/5 dark:bg-violet-500/10 p-6 flex flex-col">
            <div className="flex items-center gap-2 text-xs font-semibold text-violet-600 dark:text-violet-400 mb-2">
              <span className="w-1.5 h-1.5 rounded-full bg-violet-500" /> {i18nService.t('svSectionEngage')}
            </div>
            <div className="text-xl font-bold dark:text-white mb-1">🎯 {platLabel} · {i18nService.t('svCardEngageTitle')}</div>
            <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
              {i18nService.t('svCardEngageDesc1')}<strong>{i18nService.t('svCardEngageDescStrong')}</strong>{i18nService.t('svCardEngageDesc2')}
            </div>
            <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-500 text-white text-sm font-bold hover:bg-violet-600 shadow-sm shadow-violet-500/25 transition-all active:scale-95"
              >
                🎯 {i18nService.t('svStartEngage')}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
            </div>
          </div>
          )}
          {/* 自动回复粉丝(矩阵多账号)—— 小红书/快手/哔哩哔哩:在创作者中心评论管理里逐条回复自己作品下的粉丝评论。 */}
          {MATRIX_REPLY_FAN_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-fuchsia-500/30 bg-fuchsia-500/5 dark:bg-fuchsia-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-fuchsia-600 dark:text-fuchsia-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-500" /> {i18nService.t('svSectionReply')}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">💌 {platLabel} · {i18nService.t('svCardReplyTitle')}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.t('svCardReplyDesc1')}<strong>{i18nService.t('svCardReplyDescStrong')}</strong>{i18nService.t('svCardReplyDesc2')}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixReplyWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-fuchsia-500 text-white text-sm font-bold hover:bg-fuchsia-600 shadow-sm shadow-fuchsia-500/25 transition-all active:scale-95"
              >
                💌 {i18nService.t('svStartReply')}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* 爆款批量仿写(矩阵多账号)—— 小红书:每号关键词搜本niche爆款→仿写→AI生图→发布。 */}
          {MATRIX_VIRAL_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 dark:bg-rose-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-rose-600 dark:text-rose-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> {i18nService.t('svSectionViral')}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">🔥 {platLabel} · {i18nService.t('svCardViralTitle')}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.t('svCardViralDesc1')}<strong>{i18nService.t('svCardViralDescStrong1')}</strong>{i18nService.t('svCardViralDesc2')}<strong>{i18nService.t('svCardViralDescStrong2')}</strong>{i18nService.t('svCardViralDesc3')}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixViralWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-rose-500 text-white text-sm font-bold hover:bg-rose-600 shadow-sm shadow-rose-500/25 transition-all active:scale-95"
              >
                🔥 {i18nService.t('svStartViral')}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* 图文创作(矩阵多账号)—— 抖音:N 个号各自按身份+随机文风生成图文,配图+发到各自创作者中心。 */}
          {MATRIX_IMAGE_TEXT_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> {i18nService.t('svSectionImageText')}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">📝 {platLabel} · {i18nService.t('svCardImageTextTitle')}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.t('svCardImageTextDesc1')}<strong>{i18nService.t('svUniqueEach')}</strong>{i18nService.t('svCardImageTextDesc2')}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixImageTextWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-bold hover:bg-emerald-600 shadow-sm shadow-emerald-500/25 transition-all active:scale-95"
              >
                📝 {i18nService.t('svStartCreate')}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* 自动发推(矩阵多账号)—— 推特:N 个号各自按身份 AI 原创一条推 + 可选配图 → 发到各自时间线。 */}
          {MATRIX_TWEET_POST_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 dark:bg-sky-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-sky-600 dark:text-sky-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-sky-500" /> {i18nService.t('svSectionTweet')}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">🐦 {platLabel} · {i18nService.t('svCardTweetTitle')}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.t('svCardTweetDesc1')}<strong>{i18nService.t('svUniqueEach')}</strong>{i18nService.t('svCardTweetDesc2')}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixTweetWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-sky-500 text-white text-sm font-bold hover:bg-sky-600 shadow-sm shadow-sky-500/25 transition-all active:scale-95"
              >
                🐦 {i18nService.t('svStartTweet')}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* 币安广场自动发帖(矩阵多账号)—— 币安:N 个号各自抓 web3 资讯 AI 原创一条币安广场图文 + 可选配图 → 发币安广场。 */}
          {MATRIX_BINANCE_POST_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> {i18nService.t('svSectionBinancePost')}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">📊 {platLabel} · {i18nService.t('svCardBinancePostTitle')}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.t('svCardBinancePostDesc1')}<strong>{i18nService.t('svUniqueEach')}</strong>{i18nService.t('svCardBinancePostDesc2')}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixBinanceWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-bold hover:bg-amber-600 shadow-sm shadow-amber-500/25 transition-all active:scale-95"
              >
                📊 {i18nService.t('svStartBinancePost')}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* Facebook 自动发帖(矩阵多账号)—— N 个号各自按人设从所选数据源(web3/科技/各热榜)取材 AI 原创一条帖 + 可选配图 → 发 FB。 */}
          {MATRIX_FB_POST_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-blue-500/30 bg-blue-500/5 dark:bg-blue-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-blue-600 dark:text-blue-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" /> {i18nService.currentLanguage === 'zh' ? 'Facebook 发帖' : 'Facebook Post'}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">👥 {platLabel} · {i18nService.currentLanguage === 'zh' ? '自动发帖' : 'Auto Post'}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.currentLanguage === 'zh'
                  ? <>N 个号各自按人设,从你选的数据源(Web3 / 科技 / 微博·抖音等热榜)取材,AI 原创一条 Facebook 图文,<strong>每号内容互不相同</strong>,可选配图 → 发到各自 Facebook(须挂 VPN)。</>
                  : <>Each account posts one AI-original Facebook post from your chosen data source (Web3 / tech / trending boards), <strong>all different</strong>, optional image (VPN required).</>}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixFacebookWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-500 text-white text-sm font-bold hover:bg-blue-600 shadow-sm shadow-blue-500/25 transition-all active:scale-95"
              >
                👥 {i18nService.currentLanguage === 'zh' ? '开始发帖' : 'Start Posting'}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* Reddit 自动发帖(矩阵多账号)—— N 个号各自按人设从所选数据源取材 AI 原创一条帖 → API 发到指定 subreddit。 */}
          {MATRIX_REDDIT_POST_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-orange-500/30 bg-orange-500/5 dark:bg-orange-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-orange-600 dark:text-orange-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-500" /> {i18nService.currentLanguage === 'zh' ? 'Reddit 发帖' : 'Reddit Post'}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">🟠 {platLabel} · {i18nService.currentLanguage === 'zh' ? '自动发帖' : 'Auto Post'}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.currentLanguage === 'zh'
                  ? <>N 个号各自按人设,从你选的数据源取材,AI 原创一条帖(标题+正文),<strong>每号内容互不相同</strong> → 发到你指定的 subreddit(须挂 VPN)。</>
                  : <>Each account posts one AI-original post (title + body) from your chosen data source, <strong>all different</strong>, to your target subreddit (VPN required).</>}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixRedditWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-orange-500 text-white text-sm font-bold hover:bg-orange-600 shadow-sm shadow-orange-500/25 transition-all active:scale-95"
              >
                🟠 {i18nService.currentLanguage === 'zh' ? '开始发帖' : 'Start Posting'}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* Instagram 自动发帖(矩阵多账号)—— N 个号各自按人设从所选数据源取材 AI 原创一条图文 + 配图 → 走「新建帖子」发到各自 IG(图必带)。 */}
          {MATRIX_IG_POST_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-pink-500/30 bg-pink-500/5 dark:bg-pink-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-pink-600 dark:text-pink-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-pink-500" /> {i18nService.currentLanguage === 'zh' ? 'Instagram 发帖' : 'Instagram Post'}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">📷 {platLabel} · {i18nService.currentLanguage === 'zh' ? '自动发帖' : 'Auto Post'}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.currentLanguage === 'zh'
                  ? <>N 个号各自按人设,从你选的数据源(Web3 / 科技 / 微博·抖音等热榜)取材,AI 原创一条 Instagram 图文,<strong>每号内容互不相同</strong>,恒配图 → 发到各自 Instagram(须挂 VPN)。</>
                  : <>Each account posts one AI-original Instagram post from your chosen data source (Web3 / tech / trending boards), <strong>all different</strong>, always with an image (VPN required).</>}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixInstagramWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-pink-500 text-white text-sm font-bold hover:bg-pink-600 shadow-sm shadow-pink-500/25 transition-all active:scale-95"
              >
                📷 {i18nService.currentLanguage === 'zh' ? '开始发帖' : 'Start Posting'}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* 币安广场批量搬运(矩阵多账号)—— 币安:1 个源平台采集号搜+下素材 → N 个币安号各领一条 AI 仿写 + 配源图 → 发币安广场。 */}
          {MATRIX_BINANCE_REPOST_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> {i18nService.t('svSectionRepost')}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">♻️ {platLabel} · {i18nService.t('svCardRepostTitle')}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.t('svCardRepostDesc1')}<strong>{i18nService.t('svCardRepostDescStrong')}</strong>{i18nService.t('svCardRepostDesc2')}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
                <button type="button" onClick={() => openMatrixRepostWizard(currentPlatform)} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-bold hover:bg-amber-600 shadow-sm shadow-amber-500/25 transition-all active:scale-95">♻️ {i18nService.t('svStartRepost')}</button>
                <button type="button" onClick={() => onSwitchToManage?.(currentPlatform as any)} className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white">{i18nService.t('svHasTasks')}</button>
              </div>
            </div>
          )}
          {/* 视频无水印下载(单账号工具)—— 仅抖音:选 1 个号 + 粘贴链接逐个下载。 */}
          {MATRIX_VIDEO_DOWNLOAD_PLATFORMS.has(currentPlatform) && (
            <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 dark:bg-sky-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-sky-600 dark:text-sky-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-sky-500" /> {i18nService.t('svSectionDownload')}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">⬇️ {platLabel} · {i18nService.t('svCardDownloadTitle')}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.t('svCardDownloadDesc1')}<strong>{i18nService.t('svCardDownloadDescStrong')}</strong>{i18nService.t('svCardDownloadDesc2')}{currentPlatform === 'tiktok' ? i18nService.t('svCardDownloadTiktokVpn') : ''}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openMatrixDownloadWizard(currentPlatform)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-sky-500 text-white text-sm font-bold hover:bg-sky-600 shadow-sm shadow-sky-500/25 transition-all active:scale-95"
              >
                ⬇️ {i18nService.t('svStartDownload')}
              </button>
              <button
                type="button"
                onClick={() => onSwitchToManage?.(currentPlatform as any)}
                className="ml-3 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
              >
                {i18nService.t('svHasTasks')}
              </button>
              </div>
            </div>
          )}
          {/* 敏感词检查(小红书工具,账号无关)—— 跟旧版一样,粘文案查违禁词/广告法/引流/限流风险,不选账号。 */}
          {currentPlatform === 'xhs' && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 p-6 flex flex-col">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> {i18nService.t('svSectionSensitive')}
              </div>
              <div className="text-xl font-bold dark:text-white mb-1">🛡️ {i18nService.t('svCardSensitiveTitle')}</div>
              <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed mb-4">
                {i18nService.t('svCardSensitiveDesc1')}<strong>{i18nService.t('svCardSensitiveDescStrong')}</strong>{i18nService.t('svCardSensitiveDesc2')}
              </div>
              <div className="mt-auto flex items-center flex-wrap pt-1">
              <button
                type="button"
                onClick={() => openSensitiveCheck()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-bold hover:bg-amber-600 shadow-sm shadow-amber-500/25 transition-all active:scale-95"
              >
                🛡️ {i18nService.t('svStartSensitive')}
              </button>
              </div>
            </div>
          )}
          </div>
          {/* 优势标签(对齐旧版各平台 WorkflowsPage 底部):矩阵涨粉通用卖点。 */}
          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            {[['🛡️', i18nService.t('svBannerNoBan')], ['🚀', i18nService.t('svBannerFastGrow')], ['💰', i18nService.t('svBannerLowCost')], ['🤖', i18nService.t('svBannerSmart')]].map(([icon, t]) => (
              <span key={t} className="inline-flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-full border border-violet-500/20 bg-violet-500/5 text-gray-700 dark:text-gray-300">{icon} {t}</span>
            ))}
          </div>
        </div>
      );
    }
    if (currentPlatform === 'xhs') {
      return (
        <XhsWorkflowsPage
          scenarios={scenarios.filter(s => s.platform === 'xhs')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onOpenSensitiveCheck={openSensitiveCheck}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'xhs' })}
        />
      );
    }

    if (currentPlatform === 'x') {
      return (
        <XWorkflowsPage
          scenarios={scenarios.filter(s => s.platform === 'x')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'x' })}
        />
      );
    }

    if (currentPlatform === 'binance') {
      return (
        <BinanceWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'binance')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'binance' })}
        />
      );
    }

    if (currentPlatform === 'youtube') {
      return (
        <YoutubeWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'youtube')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'youtube' })}
        />
      );
    }

    if (currentPlatform === 'tiktok') {
      return (
        <TikTokWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'tiktok')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'tiktok' })}
        />
      );
    }

    if (currentPlatform === 'douyin') {
      return (
        <DouyinWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'douyin')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'douyin' })}
        />
      );
    }

    if (currentPlatform === 'shipinhao') {
      return (
        <ShipinhaoWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'shipinhao')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'shipinhao' })}
        />
      );
    }

    if (currentPlatform === 'toutiao') {
      return (
        <ToutiaoWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'toutiao')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'toutiao' })}
        />
      );
    }

    if (currentPlatform === 'kuaishou') {
      return (
        <KuaishouWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'kuaishou')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'kuaishou' })}
        />
      );
    }

    if (currentPlatform === 'bilibili') {
      return (
        <BilibiliWorkflowsPage
          scenarios={scenarios.filter(s => (s.platform as any) === 'bilibili')}
          tasks={tasksForPlatform}
          draftsByTask={draftsByTask}
          loading={loading}
          onOpenTask={openTask}
          onConfigure={openWizardFor}
          onChanged={refreshAll}
          onGoToMyTasks={() => setView({ kind: 'main', section: 'tasks', platform: 'bilibili' })}
        />
      );
    }

    // No remaining platforms — keep placeholder for future expansion.
    return <PlatformPlaceholder platform={currentPlatform} />;
  })();

  return (
    <div className="flex flex-col h-full dark:bg-claude-darkBg bg-claude-bg">
      {/* NoobCoin 福袋红包空投 — self-positioned overlay,监听 backend SSE 触发。
          逻辑跟 chat 对话框那个一致(同 LuckyBag 组件)。 */}
      <ErrorBoundary name="LuckyBag">
        <LuckyBag />
      </ErrorBoundary>
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {/* 下钻到任务/运行记录详情时,标题归到「我的涨粉任务」(详情逻辑上属于该菜单),
                不再停在「新建涨粉任务 / 涨粉运行记录」。 */}
            {matrixMode
              ? (inDetailView
                  ? '🧬 ' + i18nService.t('matrixMyFanTasks')
                  : mode === 'runs'
                    ? '🧬 ' + i18nService.t('matrixRunHistory')
                    : '🧬 ' + i18nService.t('matrixMyFanTasks'))
              : inDetailView
                ? i18nService.t('myFanTasks')
                : mode === 'create'
                  ? i18nService.t('quickUse')
                  : mode === 'runs'
                    ? i18nService.t('svRunHistory')
                    : i18nService.t('myFanTasks')}
          </h1>
          {/* v1.x: 钱包余额 + 充值入口紧跟标题,跟 CoworkView 顶栏一致 */}
          <div className="non-draggable">
            <WalletBadge />
          </div>
        </div>
        {/* v1.x: 顶栏右上角"分享给好友"入口 — 一键使用页是用户日常驻留点之一,
            把邀请入口顶到这儿让"邀请赚 BUSDT"在用户视线里。点击跳邀请返佣页。
            包裹 div 不加 non-draggable(否则 macOS 拖窗口热区丢失),仅 button
            本身 non-draggable 让点击事件不被 -webkit-app-region:drag 吃掉。 */}
        <div className="flex items-center gap-2 h-8">
          {onShowInvite && (
            <button
              type="button"
              onClick={onShowInvite}
              className="non-draggable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap bg-green-500/10 text-green-500 border border-green-500/40 hover:bg-green-500/20 hover:border-green-500/60 active:scale-95"
              title={i18nService.t('svShareInviteTitle')}
              aria-label={i18nService.t('svShareToFriends')}
            >
              <span aria-hidden>🎁</span>
              <span>{i18nService.t('svShareToFriends')}</span>
            </button>
          )}
          <WindowTitleBar inline />
        </div>
      </div>

      {/* L1 — section tabs (Create / My Tasks / History). Hidden when in
          a sub-page (task_detail / sensitive_check) so the user gets a
          full-bleed page without competing nav.
          Matches the L2 platform-tabs treatment: every tab is a visible
          card with a frame even when inactive, and the active one shifts
          to a green tint + green border + slight glow. Inactive tabs were
          previously borderless which made them look unclickable. */}
      {/* Two header modes:
          - "list" mode (section = tasks / history): L1 tabs on the left
            + "+ 新建涨粉任务" CTA on the right
          - "create" mode (section = create): a "← 返回" button replaces
            the L1 tabs; CTA hides because we're already inside Create.
            This makes Create feel like a pushed sub-page rather than
            another tab equal to the others — matches user expectation
            of "task vs view" actions. */}
      {view.kind === 'main' && currentSection !== 'create' && !(currentPlatform === 'video' && videoInDetail) && (() => {
        const isVideo = currentPlatform === 'video';
        const isHistory = currentSection === 'history';
        // v6.x: 原「我的涨粉任务 / 运行记录」两个 L1 段 tab 已拆成两个独立左侧菜单,
        // 这里改成只展示【当前菜单】的段标题(样式对齐「✨ 新建涨粉任务」头部)。
        //   manage 菜单 → 📋 我的涨粉任务(视频实例叫「我的视频任务」)
        //   runs   菜单 → 📊 涨粉运行记录
        // 仅当从【我的涨粉任务】里某任务详情下钻到该任务的运行记录(manage 内部
        // section 临时切到 history)时,补一个「← 返回」回到任务列表,避免没了 L1
        // tab 之后无路可退。
        const sectionTitle = isHistory
          ? i18nService.t('svRunHistoryTitle')
          : isVideo ? i18nService.t('svMyVideosTitle')
                    : i18nService.t('svMyTasksTitle');
        return (
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {mode === 'manage' && isHistory && (
              <button
                type="button"
                onClick={() => setSection('tasks')}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/80 border border-gray-400 dark:border-gray-500 transition-colors whitespace-nowrap"
                title={i18nService.t('svBackToMyTasks')}
              >
                <span>←</span>
                <span>{i18nService.t('svBack')}</span>
              </button>
            )}
            <h2 className="text-base font-bold dark:text-white text-gray-900 whitespace-nowrap">
              {sectionTitle}
            </h2>
          </div>
          {/* Right-aligned CTA — 只在「我的涨粉任务」(tasks)展示;运行记录页无需新建入口。
              Always clickable; per-platform task-cap (>= 5) check happens inside the
              create page's scenario cards. Video tab is local-only (rose tint). */}
          {currentSection === 'tasks' && (
          <button
            type="button"
            onClick={() => {
              if (isVideo) { goVideoCreate(); return; }
              goCreatePlatform(currentPlatform);
            }}
            className={`shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all whitespace-nowrap active:scale-95 text-white ${
              isVideo
                ? 'shadow-md shadow-rose-500/30 bg-rose-500 hover:bg-rose-600 border border-rose-500'
                : 'shadow-md shadow-green-500/30 bg-green-500 hover:bg-green-600 border border-green-500'
            }`}
          >
            <span>✨</span>
            <span>{isVideo ? i18nService.t('svNewVideoTask') : i18nService.t('svNewFanTask')}</span>
          </button>
          )}
        </div>
        );
      })()}

      {/* Create-mode header. v6.x: 'create' 模式是顶级菜单(「一键涨粉」),没有
          上一页可回 —— 隐藏返回按钮,只留段标题。仅 manage 模式(已不会进 create
          段)才保留返回按钮,但实际上 manage 不再渲染本块。 */}
      {view.kind === 'main' && currentSection === 'create' && (
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {mode !== 'create' && (
            <button
              type="button"
              onClick={() => setSection('tasks')}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/80 border border-gray-400 dark:border-gray-500 transition-colors whitespace-nowrap"
              title={currentPlatform === 'video' ? i18nService.t('svBackToVideoCreate') : i18nService.t('svBackToMyTasks')}
            >
              <span>←</span>
              <span>{i18nService.t('svBack')}</span>
            </button>
            )}
            <h2 className="text-base font-bold dark:text-white text-gray-900 ml-2 whitespace-nowrap">
              ✨ {currentPlatform === 'video' ? i18nService.t('svNewVideoTask') : i18nService.t('svNewFanTask')}
            </h2>
          </div>
          {/* v6.x: 「涨粉教程」入口 → 外部浏览器打开文档站。样式与「我的涨粉任务」
              页一致(琥珀渐变胶囊按钮),靠 justify-between 顶到头部右侧。 */}
          {mode === 'create' && (() => {
            // tab=「多平台视频创作」(currentPlatform==='video')→ 文字「视频教程」+ 视频文档链接(中文/英文分开);
            //   其它 tab 保持原样:「涨粉教程」+ 文档首页(用户要求)。
            const isVideoTab = currentPlatform === 'video';
            const isZhDoc = i18nService.currentLanguage === 'zh';
            const tutorialUrl = isVideoTab
              ? (isZhDoc ? 'https://docs.noobclaw.com/zhong-wen-ban/kua-ping-tai-shi-pin-chuang-zuo' : 'https://docs.noobclaw.com/english/video-creation')
              : 'https://docs.noobclaw.com';
            const tutorialLabel = isVideoTab
              ? i18nService.t('svVideoTutorial')
              : i18nService.t('svGrowthTutorial');
            return (
            <button
              type="button"
              onClick={() => { try { window.electron?.shell?.openExternal(tutorialUrl); } catch { /* sandbox/无 xdg-open 时静默 */ } }}
              className="group relative shrink-0 inline-flex items-center gap-1.5 text-xs font-medium
                         px-3.5 py-1.5 rounded-full
                         bg-gradient-to-r from-amber-500/15 via-orange-500/15 to-rose-500/15
                         hover:from-amber-500/25 hover:via-orange-500/25 hover:to-rose-500/25
                         text-amber-700 dark:text-amber-300
                         border border-amber-500/30 hover:border-amber-500/60
                         shadow-sm hover:shadow-md hover:shadow-amber-500/20
                         transition-all duration-200 hover:-translate-y-0.5"
              title={tutorialLabel}
            >
              <span className="text-sm leading-none">📖</span>
              <span>{tutorialLabel}</span>
              <span className="opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all duration-200">→</span>
            </button>
            );
          })()}
        </div>
      )}

      {/* L2 — platform sub-tabs (XHS / Twitter / YouTube / TikTok / Douyin /
          Binance). Inactive border was bumped from gray-300/gray-600 to
          gray-400/gray-500 because the prior tone was nearly invisible
          against the page background — user couldn't tell at a glance which
          buttons were tappable vs decorative. Now every tab carries a
          visible frame; the active one differentiates only by green tint
          + green border + slight glow shadow, matching the L1 section tabs'
          active treatment. */}
      {view.kind === 'main' && !(currentPlatform === 'video' && videoInDetail) && (
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          {/* 矩阵号:显示「视频创作」(热搜成片)+ 支持「互动涨粉」的平台(其余无 engage 剧本)。 */}
          {/* 国内版(HIDE_WEB3):过滤掉「币安广场」平台 tab(web3),其余含海外平台保留。 */}
          {(matrixMode ? MATRIX_TAB_ORDER.map((id) => PLATFORM_TABS.find((t) => t.id === id)!).filter(Boolean) : PLATFORM_TABS).filter((tab) => !(HIDE_WEB3 && tab.id === 'binance')).map((tab) => {
            const active = currentPlatform === tab.id;
            // 矩阵号:对齐「我的矩阵账号」的简洁 pill 切换(纯文字 + violet 选中,rounded-full),
            // 顺序同账号页(MATRIX_TAB_ORDER 已与 PLATFORMS 一致)。非矩阵(旧视频版)保持原绿卡样式。
            if (matrixMode) {
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setPlatform(tab.id)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm border transition-colors whitespace-nowrap ${
                    active
                      ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium'
                      : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'
                  }`}
                >
                  <span className="text-base leading-none">{tab.icon}</span>
                  <span>{i18nService.t(tab.labelKey)}</span>
                </button>
              );
            }
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setPlatform(tab.id)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-green-500/15 text-green-500 border border-green-500/50 shadow-sm shadow-green-500/20'
                    : 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800/60 hover:bg-gray-200 dark:hover:bg-gray-700/80 border border-gray-400 dark:border-gray-500'
                }`}
              >
                <span className="text-base">{tab.icon}</span>
                <span>{i18nService.t(tab.labelKey)}</span>
                {!tab.enabled && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-500">
                    {i18nService.t('scenarioPlatformSoon')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Main content */}
      {/* Main content — guarded with a fallback so a render crash doesn't black-screen the app */}
      <div className="flex-1 overflow-y-auto">
        {fatalError ? (
          <div className="p-8 text-center">
            <div className="text-4xl mb-4">⚠️</div>
            <div className="text-sm text-red-500 mb-4">{fatalError}</div>
            <button
              type="button"
              onClick={() => { setFatalError(null); void refreshAll(); }}
              className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900"
            >
              {i18nService.t('svRetry')}
            </button>
          </div>
        ) : (
          platformTabContent
        )}
      </div>

      {/* Config wizard modal */}
      {wizardScenario && (
        <ConfigWizard
          scenario={wizardScenario}
          initialTask={wizardEditingTask}
          onCancel={closeWizard}
          onSave={handleWizardSave}
        />
      )}

      {/* 指纹浏览器未安装 → 去下载弹窗(没内核不创建/不运行矩阵任务) */}
      {matrixKernelMissing && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
          <div className="w-[28rem] max-w-full rounded-2xl p-6 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-base font-semibold mb-2 dark:text-white">🧬 {i18nService.t('svKernelTitle')}</div>
            <div className="text-sm text-gray-600 dark:text-gray-300 mb-5 leading-relaxed">{i18nService.t('svKernelBody')}</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setMatrixKernelMissing(false)} disabled={matrixKernelBusy} className="px-3.5 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15 disabled:opacity-50">{i18nService.t('svCancel')}</button>
              <button onClick={downloadMatrixKernel} disabled={matrixKernelBusy} className="px-3.5 py-1.5 text-sm rounded-lg bg-violet-500 hover:bg-violet-600 text-white disabled:opacity-50">{matrixKernelBusy ? i18nService.t('svDownloading') : i18nService.t('svDownloadKernel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 重复任务提示:某平台已有同类型任务 → 关掉向导并弹此提示,给「去查看 / 编辑」入口跳对应管理 tab */}
      {dupNotice && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="text-xl leading-none">⚠️</span>
              <div className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">
                {i18nService.t('svDupNotice').replace('{label}', dupNotice.label)}
              </div>
            </div>
            <div className="mt-5 flex gap-2 justify-end">
              <button type="button" onClick={() => setDupNotice(null)} className="px-4 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">{i18nService.t('svClose')}</button>
              <button type="button" onClick={() => { const p = dupNotice.platform; setDupNotice(null); onSwitchToManage?.(p as any); }} className="px-4 py-2 rounded-lg text-sm font-semibold bg-violet-500 text-white hover:bg-violet-600">{i18nService.t('svGoViewEdit')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 矩阵号互动涨粉向导(选账号 + 配额 + 频率) */}
      {matrixWizardPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixTaskWizard
              platformLabel={(() => {
                const p = matrixWizardPlatform;
                return p === 'douyin' ? '抖音' : p === 'kuaishou' ? '快手' : p === 'bilibili' ? '哔哩哔哩'
                  : p === 'xhs' ? '小红书' : p === 'x' ? '推特' : p === 'binance' ? '币安广场'
                  : p === 'youtube' ? 'YouTube' : p === 'tiktok' ? 'TikTok' : String(p);
              })()}
              platform={matrixWizardPlatform}
              accounts={matrixAccounts}
              accountsLoading={matrixAccountsLoading}
              initialTask={matrixWizardTask}
              onCancel={() => { setMatrixWizardPlatform(null); setMatrixWizardTask(null); }}
              onSave={saveMatrixTask}
            />
          </div>
        </div>
      )}

      {/* 矩阵号自动回复粉丝向导(选创作者中心账号 + 引流尾巴 + 频率) */}
      {matrixReplyPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixReplyFansWizard
              platformLabel={(() => {
                const p = matrixReplyPlatform;
                return p === 'douyin' ? '抖音' : p === 'kuaishou' ? '快手' : p === 'bilibili' ? '哔哩哔哩'
                  : p === 'xhs' ? '小红书' : p === 'shipinhao' ? '视频号' : p === 'toutiao' ? '头条号' : String(p);
              })()}
              platform={matrixReplyPlatform}
              accounts={matrixReplyAccounts}
              accountsLoading={matrixReplyAccountsLoading}
              initialTask={matrixReplyTask}
              onCancel={() => { setMatrixReplyPlatform(null); setMatrixReplyTask(null); }}
              onSave={saveMatrixReplyFanTask}
            />
          </div>
        </div>
      )}

      {/* 矩阵号视频无水印下载向导(单账号 + 粘贴链接 + 频率) */}
      {matrixDownloadPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixVideoDownloadWizard
              platformLabel={(() => { const p = matrixDownloadPlatform; return p === 'douyin' ? '抖音' : p === 'kuaishou' ? '快手' : p === 'bilibili' ? '哔哩哔哩' : p === 'tiktok' ? 'TikTok' : p === 'xhs' ? '小红书' : String(p); })()}
              platform={matrixDownloadPlatform}
              accounts={matrixDownloadAccounts}
              accountsLoading={matrixDownloadAccountsLoading}
              initialTask={matrixDownloadTask}
              onCancel={() => { setMatrixDownloadPlatform(null); setMatrixDownloadTask(null); }}
              onSave={saveMatrixDownloadTask}
            />
          </div>
        </div>
      )}

      {matrixImageTextPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixImageTextWizard
              platformLabel={(() => { const p = matrixImageTextPlatform; return p === 'douyin' ? '抖音' : p === 'xhs' ? '小红书' : p === 'shipinhao' ? '视频号' : p === 'toutiao' ? '头条号' : String(p); })()}
              platform={matrixImageTextPlatform}
              accounts={matrixImageTextAccounts}
              accountsLoading={matrixImageTextAccountsLoading}
              downloadAccounts={matrixImageTextDownloadAccounts}
              initialTask={matrixImageTextTask}
              onCancel={() => { setMatrixImageTextPlatform(null); setMatrixImageTextTask(null); }}
              onSave={saveMatrixImageTextTask}
            />
          </div>
        </div>
      )}

      {matrixTweetPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixTweetPostWizard
              platformLabel={(() => { const p = matrixTweetPlatform; return p === 'x' ? '推特' : String(p); })()}
              platform={matrixTweetPlatform}
              accounts={matrixTweetAccounts}
              accountsLoading={matrixTweetAccountsLoading}
              initialTask={matrixTweetTask}
              onCancel={() => { setMatrixTweetPlatform(null); setMatrixTweetTask(null); }}
              onSave={saveMatrixTweetTask}
            />
          </div>
        </div>
      )}

      {matrixBinancePlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixBinancePostWizard
              platformLabel={(() => { const p = matrixBinancePlatform; return p === 'binance' ? '币安广场' : String(p); })()}
              platform={matrixBinancePlatform}
              accounts={matrixBinanceAccounts}
              accountsLoading={matrixBinanceAccountsLoading}
              initialTask={matrixBinanceTask}
              onCancel={() => { setMatrixBinancePlatform(null); setMatrixBinanceTask(null); }}
              onSave={saveMatrixBinanceTask}
            />
          </div>
        </div>
      )}

      {matrixFacebookPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixFacebookPostWizard
              platformLabel={(() => { const p = matrixFacebookPlatform; return p === 'facebook' ? 'Facebook' : String(p); })()}
              platform={matrixFacebookPlatform}
              accounts={matrixFacebookAccounts}
              accountsLoading={matrixFacebookAccountsLoading}
              initialTask={matrixFacebookTask}
              onCancel={() => { setMatrixFacebookPlatform(null); setMatrixFacebookTask(null); }}
              onSave={saveMatrixFacebookTask}
            />
          </div>
        </div>
      )}

      {matrixRedditPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixRedditPostWizard
              platformLabel={(() => { const p = matrixRedditPlatform; return p === 'reddit' ? 'Reddit' : String(p); })()}
              platform={matrixRedditPlatform}
              accounts={matrixRedditAccounts}
              accountsLoading={matrixRedditAccountsLoading}
              initialTask={matrixRedditTask}
              onCancel={() => { setMatrixRedditPlatform(null); setMatrixRedditTask(null); }}
              onSave={saveMatrixRedditTask}
            />
          </div>
        </div>
      )}

      {matrixInstagramPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixInstagramPostWizard
              platformLabel={(() => { const p = matrixInstagramPlatform; return p === 'instagram' ? 'Instagram' : String(p); })()}
              platform={matrixInstagramPlatform}
              accounts={matrixInstagramAccounts}
              accountsLoading={matrixInstagramAccountsLoading}
              initialTask={matrixInstagramTask}
              onCancel={() => { setMatrixInstagramPlatform(null); setMatrixInstagramTask(null); }}
              onSave={saveMatrixInstagramTask}
            />
          </div>
        </div>
      )}

      {matrixRepostPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixBinanceRepostWizard
              platformLabel={(() => { const p = matrixRepostPlatform; return p === 'binance' ? '币安广场' : String(p); })()}
              platform={matrixRepostPlatform}
              accounts={matrixRepostAccounts}
              sourceAccounts={matrixRepostSourceAccounts}
              accountsLoading={matrixRepostAccountsLoading}
              initialTask={matrixRepostTask}
              onCancel={() => { setMatrixRepostPlatform(null); setMatrixRepostTask(null); }}
              onSave={saveMatrixRepostTask}
            />
          </div>
        </div>
      )}

      {matrixViralPlatform && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-auto">
          <div className="w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
            <MatrixViralRewriteWizard
              platformLabel={(() => { const p = matrixViralPlatform; return p === 'xhs' ? '小红书' : String(p); })()}
              platform={matrixViralPlatform}
              accounts={matrixViralAccounts}
              accountsLoading={matrixViralAccountsLoading}
              initialTask={matrixViralTask}
              onCancel={() => { setMatrixViralPlatform(null); setMatrixViralTask(null); }}
              onSave={saveMatrixViralTask}
            />
          </div>
        </div>
      )}


      {/* Link-mode edit modal */}
      {linkEditTask && (
        <LinkModeEditModal
          task={linkEditTask}
          scenario={scenarios.find(s => s.id === linkEditTask.scenario_id) || null}
          onCancel={closeLinkEdit}
          onSaved={async () => {
            closeLinkEdit();
            await refreshAll();
          }}
        />
      )}
    </div>
  );
};

// ─── Link-mode edit modal ────────────────────────────────────────────────
// Dedicated editor for tasks created via 🔗 指定链接 flow. Takes URL list
// + auto_upload toggle — deliberately does NOT ask for track / keywords /
// persona, which would be meaningless for link-mode tasks.

const LinkModeEditModal: React.FC<{
  task: Task;
  scenario: Scenario | null;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}> = ({ task, scenario, onCancel, onSaved }) => {
  const isZh = i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';
  const initialUrls: string[] = (task as any).urls || [];
  const [linksText, setLinksText] = useState(initialUrls.join('\n'));
  const [autoUpload, setAutoUpload] = useState<boolean>((task as any).auto_upload !== false);
  const [isBlueV, setIsBlueV] = useState<boolean>(!!(task as any).is_blue_v);
  const [submitting, setSubmitting] = useState(false);

  // v4.25.5: 平台感知。之前硬编码"小红书",x_link_rewrite / binance_from_x_link
  // 任务点编辑也走这个 modal,但显示文案 / URL 校验 / 上传去向都按 XHS 来 →
  // x.com URL 保存被 reject;且 Twitter 任务缺 is_blue_v 选项,AI 字数走默认。
  const platform: 'xhs' | 'x' | 'binance' = scenario?.platform === 'x' ? 'x'
    : scenario?.platform === 'binance' ? 'binance'
    : 'xhs';
  const isX = platform === 'x';
  const isBinance = platform === 'binance';
  // 部分 binance 链接搬运任务粘的也是 x.com 链接(从推特搬到币安),所以
  // binance + x 都接受 x.com / twitter.com。
  const acceptsTwitterUrl = isX || isBinance;
  const platformLabel = isX ? (isZh ? '推特' : 'X (Twitter)')
    : isBinance ? (isZh ? '币安广场' : 'Binance Square')
    : (isZh ? '小红书' : 'XHS');
  // v6.x: XHS/抖音/TikTok 视频无水印下载任务都带 urls[] → openWizardEdit 把它们路
  //   由到这个 link 编辑 modal,但它们不是"指定链接 AI 仿写":文案/去向都不同(纯下
  //   载,无 AI、无上传)。三个平台共用同一个分支,只在 label + 域名校验上分流。
  const isVideoDownload = scenario?.id === 'xhs_video_download'
    || scenario?.id === 'douyin_video_download'
    || scenario?.id === 'tiktok_video_download'
    || scenario?.id === 'kuaishou_video_download'
    || scenario?.id === 'bilibili_video_download';
  const vdPlatform: 'xhs' | 'douyin' | 'tiktok' | 'kuaishou' | 'bilibili' = scenario?.id === 'douyin_video_download'
    ? 'douyin'
    : scenario?.id === 'tiktok_video_download'
    ? 'tiktok'
    : scenario?.id === 'kuaishou_video_download'
    ? 'kuaishou'
    : scenario?.id === 'bilibili_video_download'
    ? 'bilibili'
    : 'xhs';
  const vdLabel = vdPlatform === 'douyin'
    ? (isZh ? '抖音' : 'Douyin')
    : vdPlatform === 'tiktok'
    ? 'TikTok'
    : vdPlatform === 'kuaishou'
    ? (isZh ? '快手' : 'Kuaishou')
    : vdPlatform === 'bilibili'
    ? (isZh ? '哔哩哔哩' : 'Bilibili')
    : (isZh ? '小红书' : 'XHS');
  // v4.28.x: sourceLabel 之前用在描述文案里("粘贴 1-3 个 ${sourceLabel} 原文链接"),
  // 现在描述按 acceptsTwitterUrl 直接走两个固定文案,不再需要 sourceLabel 占位 ——
  // TS strict 模式抛 unused 编译错(打包失败),直接移除。

  const validate = (text: string): { ok: string[]; err: string | null } => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 1) return { ok: [], err: i18nService.t('svErrPasteAtLeast1') };
    // v4.28.x: 跟 ConfigWizard 创建流程对齐 —— 创建那边一直是 1-5,这里编辑 modal
    // 之前卡在 1-3,导致用户在编辑里加第 4 个 URL 直接被拒。统一为 1-5。
    // v6.x: 上限从 5 提到 20。用户反馈"一次想批 10-20 条爆款链路",5 个太紧。
    if (lines.length > 20) return { ok: [], err: i18nService.t('svErrMax20') };
    for (const l of lines) {
      if (isVideoDownload) {
        // 按视频下载场景分平台校验:抖音(含短链 v.douyin.com / iesdouyin)、
        // TikTok(含 vt/vm.tiktok.com 短链)、小红书(含 xhslink 短链)。
        if (vdPlatform === 'douyin') {
          if (!/^https?:\/\/([\w-]+\.)?(douyin|iesdouyin)\.com\//i.test(l)) {
            return { ok: [], err: i18nService.t('svErrNotDouyinLink') + l.slice(0, 80) };
          }
        } else if (vdPlatform === 'tiktok') {
          if (!/^https?:\/\/([\w-]+\.)?tiktok\.com\//i.test(l)) {
            return { ok: [], err: i18nService.t('svErrNotTiktokLink') + l.slice(0, 80) };
          }
        } else if (vdPlatform === 'kuaishou') {
          if (!/^https?:\/\/([\w-]+\.)?(kuaishou|chenzhongtech)\.com\//i.test(l)) {
            return { ok: [], err: i18nService.t('svErrNotKuaishouLink') + l.slice(0, 80) };
          }
        } else if (vdPlatform === 'bilibili') {
          if (!/^https?:\/\/([\w-]+\.)?(bilibili\.com|b23\.tv)\//i.test(l)) {
            return { ok: [], err: i18nService.t('svErrNotBilibiliLink') + l.slice(0, 80) };
          }
        } else {
          if (!/^https?:\/\/(www\.)?xiaohongshu\.com\//i.test(l) && !/^https?:\/\/xhslink\.com\//i.test(l)) {
            return { ok: [], err: i18nService.t('svErrNotXhsLink') + l.slice(0, 80) };
          }
        }
      } else if (acceptsTwitterUrl) {
        if (!/^https?:\/\/(www\.)?(twitter|x)\.com\/.+\/status\/\d+/i.test(l)) {
          return { ok: [], err: i18nService.t('svErrNotValidTweetLink') + l.slice(0, 80) };
        }
      } else {
        if (!/^https?:\/\/(www\.)?xiaohongshu\.com\//i.test(l) && !/^https?:\/\/xhslink\.com\//i.test(l)) {
          return { ok: [], err: i18nService.t('svErrNotXhsLink') + l.slice(0, 80) };
        }
      }
    }
    return { ok: lines, err: null };
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const { ok, err } = validate(linksText);
    if (err) { alert(err); return; }
    setSubmitting(true);
    try {
      const patch: any = {
        urls: ok,
        daily_count: ok.length,
        auto_upload: autoUpload,
        active: true,
        enabled: true,
      };
      if (isX) patch.is_blue_v = isBlueV;
      await scenarioService.updateTask(task.id, patch);
      await onSaved();
    } catch (e) {
      alert(i18nService.t('svSaveFailed') + String(e).slice(0, 120));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6"
      >
        <h3 className="text-lg font-bold dark:text-white mb-2">
          {isVideoDownload
            ? '⬇️ ' + i18nService.t('svVideoLinksHeading').replace('{platform}', vdLabel)
            : '🔗 ' + i18nService.t('svEditLinkTask')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
          {isVideoDownload
            ? i18nService.t('svDescVideoDownload').replace('{platform}', vdLabel)
            : acceptsTwitterUrl
            ? i18nService.t('svDescTweetRewrite')
            : i18nService.t('svDescXhsRewrite')}
        </p>
        <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
          {isVideoDownload ? i18nService.t('svVideoLinks') : i18nService.t('svSourceUrls')}
        </label>
        <textarea
          value={linksText}
          onChange={e => setLinksText(e.target.value)}
          rows={8}
          className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-mono dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 resize-y min-h-[200px] break-all"
          disabled={submitting}
        />

        {/* v4.25.5: 推特账号类型(蓝V) — 仅 X link rewrite 显示。决定 AI 生成
            上限(普通号 ≤140 字硬限,蓝V 自由短/中/长)。 */}
        {isX && (
          <div className="mt-4">
            <label className="text-sm font-medium dark:text-gray-200 mb-2 block">
              {i18nService.t('svTwitterAccountType')}
            </label>
            <div
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                isBlueV ? 'border-blue-500 bg-blue-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-blue-500/50'
              }`}
              onClick={() => setIsBlueV(!isBlueV)}
            >
              <input
                type="checkbox"
                checked={isBlueV}
                onChange={e => setIsBlueV(e.target.checked)}
                onClick={e => e.stopPropagation()}
                className="mt-0.5 h-4 w-4 accent-blue-500 cursor-pointer"
                disabled={submitting}
              />
              <div className="flex-1 text-sm">
                <div className="font-medium dark:text-white">
                  {i18nService.t('svIsBlueV')}
                </div>
                <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed">
                  <>
                        <strong className="text-blue-500">{i18nService.t('svBlueVCheckedLabel')}</strong>{i18nService.t('svBlueVCheckedDesc')}<br/>
                        <strong className="text-gray-500">{i18nService.t('svBlueVUncheckedLabel')}</strong>{i18nService.t('svBlueVUncheckedDesc1')}<strong>{i18nService.t('svBlueVUncheckedDesc2')}</strong>
                      </>
                </div>
              </div>
            </div>
          </div>
        )}

        {!isVideoDownload && (<>
        <label className="text-sm font-medium dark:text-gray-200 mt-4 mb-2 block">
          {i18nService.t('svAfterGeneration')}
        </label>
        <div className="space-y-2">
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${autoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
            <input type="radio" name="link_edit_auto_upload" checked={autoUpload} onChange={() => setAutoUpload(true)} className="mt-0.5" disabled={submitting} />
            <div className="flex-1 text-xs leading-relaxed">
              <div className="font-semibold dark:text-white mb-0.5">
                {i18nService.t('svAutoPublishTo').replace('{platform}', platformLabel)}
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                {i18nService.t('svAutoPublishDesc')}
              </div>
            </div>
          </label>
          <label className={`flex items-start gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${!autoUpload ? 'border-purple-500 bg-purple-500/5' : 'border-gray-300 dark:border-gray-700'}`}>
            <input type="radio" name="link_edit_auto_upload" checked={!autoUpload} onChange={() => setAutoUpload(false)} className="mt-0.5" disabled={submitting} />
            <div className="flex-1 text-xs leading-relaxed">
              <div className="font-semibold dark:text-white mb-0.5">
                {i18nService.t('svGenerateOnly')}
              </div>
              <div className="text-gray-500 dark:text-gray-400">
                {i18nService.t('svGenerateOnlyDesc')}
              </div>
            </div>
          </label>
        </div>
        </>)}

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={() => !submitting && onCancel()}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            {i18nService.t('svCancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50"
          >
            {submitting
              ? i18nService.t('svSaving')
              : i18nService.t('svSave')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScenarioView;
