// 打开「我的充值」并指定落到哪个 tab。顶部条/各处的「订阅会员」「购买积分」按钮用。
// WalletView 挂载时读 getPendingWalletTab() 作为初始 tab;已挂载时通过 'noobclaw:show-wallet'
// 事件监听切 tab。放独立模块避免 WalletBadge ↔ WalletView 循环依赖。

export type WalletTab = 'subscription' | 'topup';

let _pendingTab: WalletTab = 'subscription';

export function getPendingWalletTab(): WalletTab {
  return _pendingTab;
}

/** 设定目标 tab 并派事件打开钱包页(App 监听 'noobclaw:show-wallet' 切到钱包)。 */
export function openWallet(tab: WalletTab = 'subscription'): void {
  _pendingTab = tab;
  window.dispatchEvent(new CustomEvent('noobclaw:show-wallet'));
}

/** 跳到「邀请与分销」页的每日签到卡(头部「签到送积分」链接、积分不足弹窗用)。App 监听 'noobclaw:show-checkin'。 */
export function openCheckin(): void {
  window.dispatchEvent(new CustomEvent('noobclaw:show-checkin'));
}
