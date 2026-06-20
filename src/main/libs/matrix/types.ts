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
}
