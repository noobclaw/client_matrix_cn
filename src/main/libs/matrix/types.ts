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
  // 互动配置:赛道关键词(自动点赞/评论/关注时按这些词搜内容)+ 赛道 id(engageHistory 去重维度)
  keywords?: string[];
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

export type MatrixTaskType = 'engage';   // 互动(点赞/评论/关注)。后续可扩展别的类型。
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
  quota: EngageQuota;
  concurrency?: number;            // 同时开窗数
  frequency: MatrixTaskFrequency;  // 运行频率
  nextPlannedRunAt?: number;       // 下次计划运行(epoch ms;调度器预排,UI 展示)
  lastRunAt?: number;              // 上次运行(调度判断 + 展示)
  createdAt: number;
}
