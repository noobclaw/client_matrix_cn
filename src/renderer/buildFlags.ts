// 国内版(client_matrix_cn)构建开关。
//
// 这是 client_matrix_cn 仓库独有的文件,用于把面向海外/加密(web3)的入口在国内版里
// 「隐藏而不删除」——代码全部保留,只是不渲染对应的菜单项 / 平台 / 页内子块,
// 方便日后随时开回来,也方便和矩阵国际版 client_matrix 对比同步。
//
// HIDE_WEB3=true 时隐藏(矩阵版口径,只砍 web3/加密,海外社交平台保留):
//   - 「我的充值」页内 USDT/BNB 链上充值(保留 CNY 卡密)
//   - 「会员订阅」里 USDT/BNB 支付(保留 CNY 兑换码)
//   - 钱包头 NoobCoin、收到返佣(USDT);WalletBadge 的 BSC 链标识(地址作 UID 显示)
//   - 「邀请返佣」页内 USDT/NoobCoin 部分(保留 CNY 返佣)
//   - web3 赛道 / Web3 资讯热源
// 保留:抖音/小红书/快手/B站/视频号/头条/推特/TikTok/YouTube、全网热搜、
//       我的充值(CNY 卡密)、会员订阅(CNY 兑换码)、邀请返佣(仅人民币)。
export const HIDE_WEB3 = true;

// 交易所广场五家(币安/OKX/Bitget/Bybit/Gate)是不是也一起隐藏。
//
// ⚠️ 这件事【不能】再挂在 HIDE_WEB3 上。HIDE_WEB3 管的是钱包、返佣、NoobCoin、链上支付、
//    币价那一堆【资金侧】的东西,国内版必须继续砍;而交易所广场是【发帖平台】,产品决定
//    国内版要保留(账号能加、任务能建、只是菜单排在最后)。两件事共用一个开关的话,
//    想露出平台就会把钱包和返佣一起放出来。
//
// false = 保留这五个平台(当前口径)。顺序在 ScenarioView.MATRIX_TAB_ORDER 和
//   MatrixView.PLATFORMS 里已经排在末尾 —— 那是 CN 版刻意的差异,同步 global 时要保住。
export const HIDE_EXCHANGE_SQUARES = false;

// 国内版显示用固定汇率(实际计费仍按 USD/积分,后端不变;仅前端把 $ 显示成 ￥)。
export const USD_CNY_RATE = 7.2;
export function cnyFromUsd(usd: number, digits = 2): string {
  return (usd * USD_CNY_RATE).toFixed(digits);
}
