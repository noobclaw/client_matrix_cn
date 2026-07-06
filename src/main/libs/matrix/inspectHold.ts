// 关指纹浏览器前的「检查等待」时长(统一收口,7 个 per-account runner 的 finally 共用)。
//
// 普通完成:留 20s 让用户在可见的指纹窗口里看结果(发了什么/回了什么/下了什么)再关窗。
// 撞到【登录墙 / 验证墙】:留 60s(2026-07-06 用户要求),好让用户当场手动登录 / 过验证码
//   / 处理 challenge-checkpoint 后再关窗,别一撞墙就秒关看不清也来不及操作。
// 无论哪种,点「停止」(AbortSignal)都立即关、不等 —— 由各 runner 的 finally 自行处理 abort。
//
// 墙的判定源 = orchestrator/driver 返回的 reason 字符串。当前 orchestrator 收口出的墙原因:
//   login_wall(IG 的 /challenge、/checkpoint、/accounts/suspended 也归到此)、login_required、
//   not_logged_in、main_site_not_logged_in、captcha_required、captcha_timeout。
const WALL_REASON_RE = /login_wall|login_required|not_logged_in|main_site_not_logged_in|captcha_required|captcha_timeout|needs_captcha|checkpoint|challenge/i;

/** reason 是否为登录墙 / 验证墙。 */
export function isLoginOrVerifyWall(reason?: string | null): boolean {
  return !!reason && WALL_REASON_RE.test(String(reason));
}

/** 关窗前的检查等待毫秒数:撞登录/验证墙 60s,否则 20s。 */
export function inspectHoldMs(reason?: string | null): number {
  return isLoginOrVerifyWall(reason) ? 60_000 : 20_000;
}
