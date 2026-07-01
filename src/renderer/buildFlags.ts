// 国内版(client_matrix_cn)构建开关。
//
// 这是 client_matrix_cn 仓库独有的文件,用于把面向海外/加密(web3)的入口在国内版里
// 「隐藏而不删除」——代码全部保留,只是不渲染对应的菜单项 / 平台 / 页内子块,
// 方便日后随时开回来,也方便和矩阵国际版 client_matrix 对比同步。
//
// HIDE_WEB3=true 时隐藏(矩阵版口径,只砍 web3/加密,海外社交平台保留):
//   - 矩阵账号 / 发布平台里的「币安广场」(binance)
//   - 「我的充值」页内 USDT/BNB 链上充值(保留 CNY 卡密)
//   - 「会员订阅」里 USDT/BNB 支付(保留 CNY 兑换码)
//   - 钱包头 NoobCoin、收到返佣(USDT);WalletBadge 的 BSC 链标识(地址作 UID 显示)
//   - 「邀请返佣」页内 USDT/NoobCoin 部分(保留 CNY 返佣)
//   - web3 赛道 / Web3 资讯热源
// 保留:抖音/小红书/快手/B站/视频号/头条/推特/TikTok/YouTube、全网热搜、
//       我的充值(CNY 卡密)、会员订阅(CNY 兑换码)、邀请返佣(仅人民币)。
export const HIDE_WEB3 = true;

// 国内版显示用固定汇率(实际计费仍按 USD/积分,后端不变;仅前端把 $ 显示成 ￥)。
export const USD_CNY_RATE = 7.2;
export function cnyFromUsd(usd: number, digits = 2): string {
  return (usd * USD_CNY_RATE).toFixed(digits);
}
