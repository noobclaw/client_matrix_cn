// shareMessage — 邀请链接复制时附带的营销文案。用户点击"复制"按钮拿到剪贴板的
// 不是裸链接,而是「营销介绍 + 教程地址 + 邀请链接」拼好的整段,粘到微信/X/Telegram
// 直接是一条可读的分享文。
//
// 跟官网保持同一份文案 — 官网 index.html 内有等价函数,改这边记得同步那边。
// 文案由产品/运营定义,不要在客户端单方面改;改了请告知 PM 并跟官网两边一起改。
//
// 语种:
//   - zh / zh-TW → 简/繁体中文(目前都用简体文案;繁体单独有一份避免简繁混排)
//   - 其它 → 英文,涵盖 en / ko / ja / ru / fr / de 等小语种
//     (产品只想维护两份;小语种 fallback 到英文胜过半翻译机翻)

export function buildInviteShareMessage(inviteLink: string, lang: string): string {
  if (lang === 'zh') {
    return `我发现一个AI自动化神器NoobClaw，完全AI模拟真人操作浏览器(0风控)，可以帮你在推特、小红书、币安广场、Youtube、抖音、Tiktok自动点赞，评论，批量原创/深度二创优质图文内容，200篇优质文章二创+1000次互动点赞+500次关注+300次评论成本<$1，是您的增粉神器，用AI自动赚钱！教程：https://docs.noobclaw.com  用我的链接免费赠送100万Token ：${inviteLink}`;
  }
  if (lang === 'zh-TW') {
    return `我發現一個AI自動化神器NoobClaw，完全AI模擬真人操作瀏覽器(0風控)，可以幫你在推特、小紅書、幣安廣場、Youtube、抖音、Tiktok自動點讚，評論，批量原創/深度二創優質圖文內容，200篇優質文章二創+1000次互動點讚+500次關注+300次評論成本<$1，是您的增粉神器，用AI自動賺錢！教程：https://docs.noobclaw.com  用我的連結免費贈送100萬Token ：${inviteLink}`;
  }
  return `I found an AI automation tool NoobClaw that mimics real human browsing with zero risk. It can auto-like, comment, follow, and remix content on Twitter, Xiaohongshu, Binance Square, YouTube, Douyin, and TikTok. For less than $1, you get 200 remixed posts + 1,000 likes + 500 follows + 300 comments. This is your ultimate follower-growth hack — let AI make money for you! Tutorial: https://docs.noobclaw.com/english Use my link to get 1M free tokens: ${inviteLink}`;
}
