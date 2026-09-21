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
    return `我发现一个AI 创作辅助工具 NoobClaw，能帮你在推特、小红书、币安广场、Youtube、抖音、TiktokAI 生成与二创图文/视频内容、辅助日常运营，是很省心的创作助手。教程：https://docs.noobclaw.com  用我的链接免费赠送100万Token ：${inviteLink}`;
  }
  if (lang === 'zh-TW') {
    return `我發現一個AI 創作輔助工具 NoobClaw，能幫你在推特、小紅書、幣安廣場、Youtube、抖音、TiktokAI 生成與二創圖文/影片內容、輔助日常運營，是很省心的創作助手。教程：https://docs.noobclaw.com  用我的連結免費贈送100萬Token ：${inviteLink}`;
  }
  return `I found an AI content tool NoobClaw that helps you create and remix image/text and video content on Twitter, Xiaohongshu, Binance Square, YouTube, Douyin, and TikTok. It is a handy AI content assistant. Tutorial: https://docs.noobclaw.com/english Use my link to get 1M free tokens: ${inviteLink}`;
}
