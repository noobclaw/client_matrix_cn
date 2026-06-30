import React, { useEffect, useState, useCallback } from 'react';
import { shortId } from '../../utils/shortId';
import MatrixTaskWizard from './MatrixTaskWizard';
import MatrixReplyFansWizard from './MatrixReplyFansWizard';
import { WalletBadge } from '../common/WalletBadge';
import { noobClawAuth } from '../../services/noobclawAuth';
import { getBackendApiUrl } from '../../services/endpoints';
import { openWallet } from '../../services/walletNav';

/**
 * 矩阵号主界面 —— 由左侧分组菜单驱动的 4 屏(screen prop):
 *   accounts 我的矩阵账号 / newTask 新建矩阵涨粉任务 / tasks 我的矩阵涨粉任务(含详情) / runs 运行记录
 * 全走 window.electron.matrix.*(sidecar IPC);进度走 matrix:progress SSE。
 * 设计参照老客户端 scenario(账号池→任务→调度→详情→运行记录),矩阵自成运行时(指纹内核池)。
 */

type AccountStatus = 'idle' | 'running' | 'login_required' | 'limited' | 'banned';
interface MatrixAccount {
  id: string; platform: string; displayName: string; group?: string; persona?: string; status: AccountStatus;
  proxy?: { protocol?: string; host: string; port: number; username?: string; password?: string; geo?: string; health?: string };
  keywords?: string[]; kernelVersion?: string; nickname?: string; displayId?: string; avatar?: string; boundUid?: string;
  loginScope?: 'main' | 'creator';   // 仅快手:主站 / 创作者中心
  egressIp?: string;                 // 无代理号的真实本机出口 IP(内核侧探到才有,后端 listAccounts 附上)
}
interface MatrixTask {
  id: string; platform: string; type: 'engage' | 'reply_fan'; name: string; enabled: boolean; accountIds: string[];
  quota: { daily_like_min?: number; daily_like_max?: number; daily_follow_min?: number; daily_follow_max?: number; daily_comment_min?: number; daily_comment_max?: number };
  funnel?: { funnel_phrase?: string; funnel_probability?: number };
  concurrency?: number; frequency: string; nextPlannedRunAt?: number; lastRunAt?: number; createdAt: number;
}
// reply_fan 任务进度里 comment 计数 = 回复条数(沿用 engage 的 counts.comment 通道)。
interface RunItem { accountId: string; displayName?: string; state: string; reason?: string; counts?: { like: number; follow: number; comment: number } }
interface RunRecord { id: string; taskId: string; taskName: string; platform: string; startedAt: number; finishedAt: number; success: number; failed: number; skipped: number; totals: { like: number; follow: number; comment: number }; items: RunItem[] }
interface ItemResult { accountId: string; state: 'success' | 'failed' | 'skipped'; reason?: string; counts?: { like: number; follow: number; comment: number } }

function parseKeywords(s: string): string[] { return s.split(/[\s,，、\n]+/).map((x) => x.trim()).filter(Boolean); }

// 对齐支持「互动涨粉」的平台(与新建页一致)。
const PLATFORMS = ['douyin', 'xhs', 'kuaishou', 'bilibili', 'shipinhao', 'toutiao', 'x', 'binance', 'youtube', 'tiktok'];
// 每个平台最多添加的账号数:客户端兜底 10,服务端 /api/matrix/config 的 maxAccountsPerPlatform 可覆盖(admin 调,不打包)。
const MAX_ACCOUNTS_PER_PLATFORM_FALLBACK = 10;
const PLATFORM_LABEL: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: '推特', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };
// 平台号的标签:平台名已以「号」结尾(视频号)就不再加「号」,否则拼「号」(抖音号/快手号…)。
const platformIdLabel = (p: string): string => { const l = PLATFORM_LABEL[p] || ''; return l.endsWith('号') ? l : l + '号'; };
const LOGIN_URL: Record<string, string> = {
  douyin: 'https://www.douyin.com/', xhs: 'https://www.xiaohongshu.com/', bilibili: 'https://passport.bilibili.com/login',
  kuaishou: 'https://www.kuaishou.com/', tiktok: 'https://www.tiktok.com/login', x: 'https://x.com/login',
  binance: 'https://www.binance.com/zh-CN/square', youtube: 'https://www.youtube.com/',
  shipinhao: 'https://channels.weixin.qq.com/', toutiao: 'https://mp.toutiao.com/',
};
// 登录/读身份导航 URL:快手按场景分流(创作端登 cp.kuaishou.com,主站登 www);其它平台用 LOGIN_URL。
const loginUrlFor = (platform: string, loginScope?: string): string => {
  if (platform === 'kuaishou') return loginScope === 'creator' ? 'https://cp.kuaishou.com/profile' : 'https://www.kuaishou.com/';
  return LOGIN_URL[platform] || '';
};
// 快手两类账号子 tab。
const KS_SCOPES: { key: 'main' | 'creator'; label: string }[] = [
  { key: 'creator', label: '创作者中心' },
  { key: 'main', label: '主站' },
];
const STATUS_DOT: Record<AccountStatus, string> = { idle: 'bg-green-500', running: 'bg-blue-500', login_required: 'bg-amber-500', limited: 'bg-gray-400', banned: 'bg-red-500' };
const STATUS_LABEL: Record<AccountStatus, string> = { idle: '已连接', running: '运行中', login_required: '尚未连接', limited: '限流冷却', banned: '已封' };
const FREQ_LABEL: Record<string, string> = { once: '不重复(手动)', '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', daily_random: '每日随机一次' };

// 赛道预设(下拉可选):选了自动填关键词 + 人设建议(用户仍可在下面微调)。
// 赛道预设库【服务端下发,内置兜底】。配账号时选赛道→自动带出人设+关键词(可改),任务跟号走。
// 运行时优先用 /api/matrix/config 下发的 trackPresets(admin 可加/改赛道、不打包客户端);
// 拉不到/未登录 → 用下面内置兜底(35 赛道)。x/tiktok/youtube 用 keywords_en。
// 加/改赛道:改 backend/matrix/track-presets.json(或 admin 的 matrix_track_presets),不必动这里。
export interface TrackPreset { id: string; name: string; persona: string; keywords_zh: string[]; keywords_en: string[]; }
const FALLBACK_TRACK_PRESETS: TrackPreset[] = [
  { id: "overseas_life", name: "🌏 海外生活 · 日常", persona: "在国外生活的普通人，记录真实的海外日常。租房、通勤、超市采购、节日见闻都自己拍，接地气、不滤镜、不贩卖焦虑",
    keywords_zh: ["海外生活", "国外日常", "租房", "超市采购", "异国文化", "海外Vlog", "留学生活", "省钱攻略", "海外打工", "文化差异", "落地生活", "海外租房"],
    keywords_en: ["expat life", "living abroad", "overseas daily", "expat vlog", "moving abroad", "grocery haul", "culture shock", "life in", "renting abroad", "study abroad life", "save money abroad", "day in my life abroad"] },
  { id: "pets", name: "🐾 萌宠 · 日常", persona: "养猫养狗的铲屎官,记录萌宠日常。轻松治愈、会讲细节,分享养宠经验和踩坑,真实不卖惨",
    keywords_zh: ["萌宠日常", "猫咪", "狗狗", "养宠攻略", "宠物好物", "治愈系", "铲屎官", "宠物搞笑", "宠物健康", "幼猫幼犬", "宠物训练", "异宠"],
    keywords_en: ["cute pets", "cat", "dog", "pet care", "puppy", "kitten", "funny pets", "pet tips", "pet products", "pet training", "rescue pet", "animal lover"] },
  { id: "food", name: "🍲 美食 · 探店做饭", persona: "爱折腾吃喝的上班族，每天给自己做饭，也爱探店。说话热情、会种草，重点讲性价比和踩雷避坑，不浮夸",
    keywords_zh: ["美食探店", "一人食", "家常菜", "减脂餐", "必吃榜", "本地美食", "空气炸锅", "探店打卡", "美食教程", "下饭菜", "夜宵", "快手菜"],
    keywords_en: ["food", "recipe", "cooking", "easy recipe", "home cooking", "food review", "restaurant", "meal prep", "street food", "what i eat", "air fryer", "foodie"] },
  { id: "tech", name: "💻 数码科技 · 测评", persona: "懂行的数码测评博主，自费买机、理性测评。技术名词直接说，优缺点都讲，绝不收钱吹，帮人避坑做选择",
    keywords_zh: ["数码测评", "手机评测", "笔记本", "智能硬件", "新品上手", "科技", "数码好物", "选购指南", "开箱", "性价比", "数码配件", "黑科技"],
    keywords_en: ["tech review", "smartphone", "laptop", "unboxing", "gadgets", "hands on", "best phone", "buying guide", "tech tips", "smart home", "accessories", "tech"] },
  { id: "ai_tools", name: "🤖 AI 工具 · 效率", persona: "天天用 AI 干活的效率党，把 ChatGPT / 各种 AI 工具用到飞起。讲人话、给可复制的实操，不空谈概念",
    keywords_zh: ["AI工具", "ChatGPT", "效率提升", "AI办公", "提示词", "自动化", "AI神器", "副业AI", "AI绘画", "AI写作", "AI视频", "工作流"],
    keywords_en: ["ai tools", "chatgpt", "productivity", "ai workflow", "prompt", "automation", "ai hacks", "midjourney", "ai art", "ai writing", "ai video", "work smarter"] },
  { id: "finance", name: "💰 财经 · 理财科普", persona: "通俗讲钱的财经科普博主，冷静中立。只做知识科普,不荐股、不喊单、不给个性化投资建议,帮人建立常识",
    keywords_zh: ["财经科普", "理财入门", "攒钱方法", "基金定投", "经济趋势", "记账", "工资理财", "钱生钱", "存钱挑战", "副业收入", "保险科普", "消费观"],
    keywords_en: ["personal finance", "money tips", "saving money", "investing", "budgeting", "financial freedom", "side income", "money mindset", "passive income", "stock market basics", "frugal living", "wealth building"] },
  { id: "crypto", name: "₿ 加密货币 · Web3", persona: "把区块链讲清楚的 Web3 科普博主，客观中立。只讲原理和行业动态,不喊单、不带单、不预测价格,提示风险",
    keywords_zh: ["加密货币", "区块链", "web3", "比特币", "以太坊", "行情解读", "链上数据", "钱包安全", "DeFi", "稳定币", "空投", "meme币"],
    keywords_en: ["crypto", "bitcoin", "ethereum", "blockchain", "web3", "defi", "altcoin", "crypto news", "on-chain", "wallet security", "airdrop", "memecoin"] },
  { id: "fitness", name: "💪 健身 · 减脂日记", persona: "边上班边坚持健身一年的过来人，167cm 从 130 减到 108 斤。正能量但不打鸡血，讲可执行的方法,反对极端节食",
    keywords_zh: ["居家健身", "减脂打卡", "增肌", "体态矫正", "减脂餐", "HIIT", "健身小白", "拉伸", "腹肌", "瑜伽", "跑步", "健身计划"],
    keywords_en: ["home workout", "fat loss", "gym", "build muscle", "hiit", "fitness", "weight loss", "abs workout", "stretching", "yoga", "running", "workout routine"] },
  { id: "travel", name: "✈️ 旅行 · 攻略分享", persona: "爱说走就走的旅行爱好者，一年出去 6-8 次。分享性价比攻略和小众目的地，治愈、令人向往，重实操路线",
    keywords_zh: ["旅行攻略", "周末去哪", "小众目的地", "citywalk", "自驾游", "机票便宜", "民宿推荐", "旅行vlog", "穷游", "出国旅游", "旅行清单", "打卡地"],
    keywords_en: ["travel", "travel guide", "travel vlog", "hidden gems", "things to do", "budget travel", "road trip", "solo travel", "travel tips", "bucket list", "itinerary", "where to go"] },
  { id: "outfit", name: "👗 穿搭 · 风格分享", persona: "小个子职场穿搭爱好者，155cm。分享通勤、约会、微胖显瘦的实穿搭配，精致但不端着，重点给平价替代",
    keywords_zh: ["小个子穿搭", "通勤穿搭", "OOTD", "微胖穿搭", "法式穿搭", "显瘦", "气质穿搭", "平价单品", "穿搭公式", "换季穿搭", "约会穿搭", "穿搭技巧"],
    keywords_en: ["outfit", "ootd", "outfit ideas", "style tips", "petite outfit", "capsule wardrobe", "fashion", "what to wear", "styling", "lookbook", "affordable fashion", "outfit inspo"] },
  { id: "beauty", name: "💄 美妆 · 护肤测评", persona: "敏感肌护肤爱好者，研究护肤 8 年、被坑过很多钱。成分党、只推真用过的，讲实测感受不夸大,帮新手避雷",
    keywords_zh: ["平价护肤", "敏感肌", "成分党", "粉底测评", "口红试色", "早C晚A", "防晒", "空瓶记", "化妆教程", "痘痘肌", "新手化妆", "护肤步骤"],
    keywords_en: ["skincare", "makeup tutorial", "skincare routine", "makeup", "foundation review", "sensitive skin", "sunscreen", "grwm", "beauty", "acne skin", "product review", "drugstore makeup"] },
  { id: "career", name: "📈 职场 · 成长干货", persona: "过来人式的职场博主，互联网公司中层。分享沟通、汇报、升职、跳槽的实操干货，实在不灌鸡汤,讲方法和案例",
    keywords_zh: ["职场成长", "沟通技巧", "升职加薪", "跳槽", "简历", "汇报", "副业", "效率工具", "职场关系", "面试", "时间管理", "职场避坑"],
    keywords_en: ["career advice", "career growth", "productivity", "job interview", "resume tips", "promotion", "workplace", "communication skills", "time management", "career change", "job search", "professional development"] },
  { id: "side_hustle", name: "💼 副业 · 打工人赚钱", persona: "下班搞副业一年的普通打工人，杭州互联网运营。真诚不装,只分享自己真做过的副业、真实收入和踩过的坑,不卖课",
    keywords_zh: ["副业推荐", "下班变现", "0基础副业", "AI副业", "在家赚钱", "自媒体", "兼职", "副业项目", "副业变现", "搞钱思路", "线上副业", "副业避坑"],
    keywords_en: ["side hustle", "make money online", "passive income", "side hustle ideas", "work from home", "online business", "earn extra money", "money making", "freelance", "side income", "ai side hustle", "make money"] },
  { id: "study_abroad", name: "🎓 留学 · 申请经验", persona: "过来人留学博主，自己申过、踩过坑。耐心细致地讲选校、文书、签证、落地生活，给可照做的清单,不贩卖焦虑",
    keywords_zh: ["留学申请", "选校", "文书", "签证", "语言考试", "留学生活", "落地攻略", "奖学金", "留学中介", "雅思托福", "留学党", "海外读研"],
    keywords_en: ["study abroad", "college application", "student visa", "ielts", "toefl", "grad school", "scholarship", "university", "study abroad tips", "international student", "personal statement", "admissions"] },
  { id: "parenting", name: "🧸 育儿 · 亲子日常", persona: "理性育儿不焦虑的妈妈，娃 3 岁。分享科学育儿、绘本、辅食、亲子游戏，温和实在,讲方法不制造焦虑",
    keywords_zh: ["科学育儿", "早教", "绘本推荐", "辅食", "亲子游戏", "母婴好物", "新手妈妈", "亲子阅读", "宝宝穿搭", "习惯养成", "幼儿园", "育儿知识"],
    keywords_en: ["parenting", "parenting tips", "toddler", "baby", "mom life", "kids activities", "early learning", "baby food", "new mom", "motherhood", "montessori", "parenting hacks"] },
  { id: "reading", name: "📚 读书 · 书单笔记", persona: "一年读 40-50 本书的普通读者，从事文化行业。分享书单、读后感、读书方法，安静走心,推荐真读过的书",
    keywords_zh: ["读书笔记", "年度书单", "好书推荐", "读书打卡", "小说推荐", "非虚构", "读书方法", "书评", "书单", "经典文学", "成长书单", "阅读习惯"],
    keywords_en: ["booktok", "book recommendations", "reading", "book review", "must read books", "book club", "reading list", "books to read", "what i read", "fiction", "self help books", "bookish"] },
  { id: "funny", name: "😂 搞笑 · 段子娱乐", persona: "专做搞笑短视频的博主，节奏快、有梗、会反转。贴近生活、不低俗，让人刷到忍不住笑出来",
    keywords_zh: ["搞笑视频", "沙雕日常", "神反转", "搞笑段子", "整活", "名场面", "爆笑", "解压", "搞笑配音", "搞笑剧情", "梗", "幽默"],
    keywords_en: ["funny", "comedy", "funny videos", "memes", "skit", "relatable", "humor", "funny moments", "prank", "lol", "comedy skit", "try not to laugh"] },
  { id: "emotion", name: "💗 情感 · 共鸣治愈", persona: "讲情感、聊人生的博主，真诚走心。说大白话、给共鸣和温暖,不灌鸡汤、不制造对立",
    keywords_zh: ["情感共鸣", "治愈文案", "人生感悟", "走心", "emo", "自我成长", "温暖", "深夜", "情感语录", "心理", "亲密关系", "自我疗愈"],
    keywords_en: ["self love", "healing", "motivation", "life lessons", "mindset", "mental health", "self growth", "positive vibes", "relationship advice", "inspiration", "quotes", "self care"] },
  { id: "rural", name: "🌾 三农 · 乡村生活", persona: "记录乡村生活的博主，种地、赶集、家常饭都自己拍。真实质朴、烟火气足，让城里人向往慢生活",
    keywords_zh: ["乡村生活", "三农", "农村日常", "田园", "种地", "赶大集", "农家饭", "慢生活", "回村", "院子", "丰收", "乡村美食"],
    keywords_en: ["farm life", "rural life", "country living", "homestead", "off grid", "village life", "farming", "slow living", "cottagecore", "harvest", "countryside", "self sufficient"] },
  { id: "games", name: "🎮 游戏 · 实况攻略", persona: "爱玩也懂玩的游戏博主，热门和独立游戏都碰。实况 + 攻略 + 解说,讲操作技巧也讲乐子,不剧透关键剧情",
    keywords_zh: ["游戏实况", "游戏攻略", "通关", "新游试玩", "游戏解说", "手游", "单机游戏", "电竞", "高光时刻", "开荒", "游戏推荐", "速通"],
    keywords_en: ["gaming", "gameplay", "walkthrough", "lets play", "game review", "speedrun", "gaming highlights", "tips and tricks", "new games", "esports", "game guide", "best games"] },
  { id: "movie", name: "🎬 影视 · 解说剪辑", persona: "爱看片的影视博主，做高能解说和混剪。节奏紧凑、观点鲜明,带人快速get到一部片的精华,不无脑剧透",
    keywords_zh: ["影视解说", "电影推荐", "电视剧", "高能剪辑", "烂片吐槽", "经典电影", "剧情解析", "追剧", "盘点", "结局解析", "冷门佳片", "影视混剪"],
    keywords_en: ["movie review", "film", "movie recap", "tv shows", "movie explained", "must watch", "best movies", "film analysis", "ending explained", "binge watch", "movie edit", "cinema"] },
  { id: "car", name: "🚗 汽车 · 评测用车", persona: "懂车的汽车博主,新能源和燃油都开过。聊评测、用车、购车决策,实测数据说话,优缺点都讲不收钱吹",
    keywords_zh: ["汽车评测", "新能源车", "买车攻略", "试驾", "用车体验", "电动车", "提车", "汽车知识", "性价比车型", "改装", "自驾", "汽车测评"],
    keywords_en: ["car review", "ev", "electric car", "test drive", "car buying", "new cars", "car tips", "auto", "best cars", "car comparison", "first drive", "car"] },
  { id: "anime", name: "🍥 二次元 · 动漫", persona: "资深二次元,追番也补番。聊新番、推番、角色和剧情,做混剪和解说,懂梗但不引战不剧透",
    keywords_zh: ["动漫", "新番推荐", "二次元", "番剧解说", "动漫混剪", "声优", "补番", "燃向", "国创", "动漫角色", "漫画", "动漫音乐"],
    keywords_en: ["anime", "anime recommendations", "anime edit", "manga", "new anime", "anime review", "amv", "otaku", "anime moments", "anime opening", "weeb", "best anime"] },
  { id: "home", name: "🏠 家居 · 收纳装修", persona: "热爱捣鼓家的家居博主,租房和自住都折腾过。分享收纳、改造、平价好物,实用不悬浮,重点给可抄作业",
    keywords_zh: ["家居好物", "收纳整理", "出租屋改造", "装修攻略", "小户型", "家居布置", "断舍离", "厨房收纳", "好物推荐", "软装", "极简家居", "爆改"],
    keywords_en: ["home decor", "organization", "home makeover", "small apartment", "interior design", "room transformation", "diy home", "declutter", "cleaning", "home tips", "apartment tour", "cozy home"] },
  { id: "photography", name: "📷 摄影 · 修图", persona: "热爱拍照的摄影博主,手机和相机都玩。分享构图、用光、修图和出片思路,讲人话给可照做的参数和技巧",
    keywords_zh: ["摄影教程", "手机摄影", "人像摄影", "修图", "构图", "调色", "出片技巧", "相机推荐", "风光摄影", "Lightroom", "拍照姿势", "摄影干货"],
    keywords_en: ["photography", "photography tips", "phone photography", "portrait", "photo editing", "lightroom", "composition", "camera", "how to take photos", "presets", "photography tutorial", "photo ideas"] },
  { id: "exam", name: "✍️ 考研考公 · 上岸", persona: "上岸过来人,踩过坑也总结了方法。分享备考规划、资料、心态和真实经验,讲可执行的步骤不贩卖焦虑",
    keywords_zh: ["考研", "考公", "备考规划", "上岸经验", "学习方法", "刷题", "笔记", "时间规划", "复习资料", "公务员", "考证", "自习"],
    keywords_en: ["study tips", "exam prep", "study with me", "how to study", "study motivation", "note taking", "study routine", "test prep", "study planner", "productivity student", "study hacks", "study"] },
  { id: "law", name: "⚖️ 法律 · 普法", persona: "讲法律的普法博主,用大白话讲清楚老百姓常遇到的法律问题。只做科普不做个案咨询,客观中立提示风险",
    keywords_zh: ["普法", "法律知识", "劳动法", "合同", "维权", "婚姻法", "消费维权", "法律科普", "案例普法", "民法典", "租房纠纷", "避坑"],
    keywords_en: ["legal tips", "know your rights", "law explained", "legal advice", "employment law", "tenant rights", "contract", "legal basics", "consumer rights", "law", "legal", "lawyer explains"] },
  { id: "health", name: "🩺 健康 · 养生科普", persona: "讲健康的养生科普博主,内容有依据。聊作息、饮食、常见小毛病和体检,只做科普不替代就医,不卖保健品",
    keywords_zh: ["健康科普", "养生", "作息", "饮食健康", "睡眠", "颈椎", "护眼", "体检", "中医养生", "亚健康", "营养", "健康习惯"],
    keywords_en: ["health tips", "wellness", "healthy habits", "sleep tips", "nutrition", "gut health", "self care", "healthy lifestyle", "stress relief", "wellness routine", "health", "longevity"] },
  { id: "music", name: "🎵 音乐 · 翻唱乐器", persona: "热爱音乐的创作者,会唱也会弹。分享翻唱、原创、乐器和编曲,真诚走心,带人发现好听的歌",
    keywords_zh: ["翻唱", "原创音乐", "乐器", "吉他", "钢琴", "唱歌技巧", "编曲", "歌单推荐", "音乐分享", "弹唱", "和声", "练歌"],
    keywords_en: ["cover song", "music", "singing", "guitar", "piano", "original song", "music cover", "songwriting", "vocals", "song recommendations", "music production", "how to sing"] },
  { id: "realestate", name: "🏡 房产 · 买房租房", persona: "聊房子的房产博主,买过也租过。讲看房、砍价、贷款、租房避坑的实操经验,客观中立不带销售目的",
    keywords_zh: ["买房攻略", "租房避坑", "看房", "房贷", "二手房", "新房", "购房知识", "公积金", "装修预算", "房产政策", "首付", "落户"],
    keywords_en: ["home buying", "real estate", "first time home buyer", "renting tips", "mortgage", "house tour", "real estate tips", "house hunting", "property", "home loan", "renting", "buying a house"] },
  { id: "handcraft", name: "✋ 手工 · DIY", persona: "热爱动手做点小东西的手作博主。分享手工、改造、DIY 教程,治愈解压,带人从零做出成品,讲清楚材料和步骤",
    keywords_zh: ["手工", "DIY", "手工教程", "手账", "编织", "黏土", "饰品制作", "旧物改造", "解压手工", "纸艺", "缝纫", "手作"],
    keywords_en: ["diy", "diy crafts", "handmade", "crafts", "diy tutorial", "craft ideas", "how to make", "art and craft", "diy projects", "crochet", "upcycle", "satisfying craft"] },
  { id: "outdoor", name: "🎣 钓鱼 · 户外", persona: "爱往野外跑的户外博主,钓鱼露营徒步都玩。分享装备、钓点、技巧和真实体验,接地气有烟火气,重实操",
    keywords_zh: ["钓鱼", "露营", "徒步", "户外装备", "野钓", "路亚", "登山", "户外探险", "野餐", "钓鱼技巧", "营地", "自然"],
    keywords_en: ["fishing", "camping", "hiking", "outdoors", "fishing tips", "bushcraft", "outdoor gear", "wild camping", "nature", "backpacking", "catch and cook", "adventure"] },
  { id: "gardening", name: "🪴 园艺 · 植物", persona: "在阳台和小院种花种菜的园艺博主。分享养护、种植、装饰和翻车经验,治愈实用,带新手把植物养活养好",
    keywords_zh: ["园艺", "养花", "多肉", "阳台种菜", "植物养护", "绿植", "扦插", "花卉", "庭院", "种植教程", "室内植物", "种菜"],
    keywords_en: ["gardening", "plants", "houseplants", "plant care", "succulents", "garden", "grow your own", "plant tips", "vegetable garden", "indoor plants", "gardening for beginners", "plant mom"] },
  { id: "astrology", name: "🔮 星座 · 玄学", persona: "聊星座和玄学的博主,轻松有梗。讲星座性格、运势、塔罗和小众玄学,娱乐向不绝对化,不制造焦虑不带货占卜",
    keywords_zh: ["星座", "运势", "塔罗", "占星", "星座性格", "玄学", "MBTI", "水逆", "星座配对", "灵性成长", "能量", "月相"],
    keywords_en: ["astrology", "zodiac signs", "horoscope", "tarot", "zodiac", "birth chart", "manifestation", "spiritual", "mbti", "zodiac facts", "tarot reading", "moon phases"] },
  { id: "kids", name: "🧒 萌娃 · 亲子", persona: "记录娃日常的宝爸宝妈,镜头跟着萌娃走。分享带娃名场面、亲子互动和成长瞬间,真实有爱,治愈又好笑",
    keywords_zh: ["萌娃", "萌娃日常", "亲子互动", "宝宝搞笑", "带娃日常", "成长记录", "萌娃穿搭", "亲子游戏", "宝宝表情", "遛娃", "母女日常", "父子日常"],
    keywords_en: ["cute baby", "funny kids", "toddler life", "family vlog", "kids of tiktok", "baby moments", "parenting life", "family", "kids funny", "daddy daughter", "mom and baby", "baby tiktok"] },
];
// 英文关键词平台:这些平台建号时带出英文词,其余带中文词。
const EN_KEYWORD_PLATFORMS = new Set(['x', 'tiktok', 'youtube']);
const trackKeywords = (p: TrackPreset, platform: string): string[] => {
  const en = EN_KEYWORD_PLATFORMS.has(platform);
  const primary = en ? p.keywords_en : p.keywords_zh;
  return (primary && primary.length) ? primary : ((en ? p.keywords_zh : p.keywords_en) || []);
};
const DEFAULT_TRACK = '🍲 美食 · 探店做饭'; // 默认选中(与视频默认 food 一致)

const M = () => (window as any).electron?.matrix;
const fmtTime = (ts?: number) => { if (!ts || ts >= Number.MAX_SAFE_INTEGER) return '—'; const d = new Date(ts); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

interface Props { screen?: 'accounts' | 'newTask' | 'tasks' | 'runs'; initialPlatform?: string; onNavigate?: (s: string) => void; onPlatformChange?: (p: string) => void; isSidebarCollapsed?: boolean; onToggleSidebar?: () => void; onShowInvite?: () => void }

const MatrixView: React.FC<Props> = ({ screen = 'accounts', initialPlatform, onNavigate, onPlatformChange }) => {
  const [accounts, setAccounts] = useState<MatrixAccount[]>([]);
  // 每个平台账号上限:服务端 /api/matrix/config 下发(admin 可调),拉不到/未登录 → 兜底 10。
  const [maxAccountsPerPlatform, setMaxAccountsPerPlatform] = useState<number>(MAX_ACCOUNTS_PER_PLATFORM_FALLBACK);
  // 代理IP购买页:服务端 /api/matrix/config 下发(admin 配 matrix_proxy_purchase_url),空则不显示「前往购买」入口。
  const [proxyPurchaseUrl, setProxyPurchaseUrl] = useState<string>('');
  // 赛道预设库:服务端 /api/matrix/config 下发(admin 可加/改赛道、不打包),拉不到/未登录 → 内置兜底。
  const [trackPresets, setTrackPresets] = useState<TrackPreset[]>(FALLBACK_TRACK_PRESETS);
  // 赛道下拉是否展开(自绘两列面板,替代原生 select:赛道多,两列更矮)。
  const [trackOpen, setTrackOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${getBackendApiUrl()}/api/matrix/config`, { headers: noobClawAuth.getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const n = Number(data?.maxAccountsPerPlatform);
        if (alive && Number.isInteger(n) && n > 0) setMaxAccountsPerPlatform(n);
        if (alive && typeof data?.proxyPurchaseUrl === 'string') setProxyPurchaseUrl(data.proxyPurchaseUrl.trim());
        // 下发的赛道库:校验为非空数组且每条带 name 才采用,否则保留内置兜底。
        const tp = data?.trackPresets;
        if (alive && Array.isArray(tp) && tp.length > 0 && tp.every((t: any) => t && t.name)) setTrackPresets(tp as TrackPreset[]);
      } catch { /* 网络/未登录 → 用兜底 */ }
      // 号数墙以【订阅档位】为准:拉 /api/plan/config 取当前档的单平台上限,覆盖 matrix/config 的全局兜底。
      try {
        const pres = await fetch(`${getBackendApiUrl()}/api/plan/config`, { headers: noobClawAuth.getAuthHeaders() });
        if (pres.ok) {
          const pdata = await pres.json();
          const cur = pdata?.current?.planCode;
          const plan = (pdata?.plans || []).find((p: any) => p && p.code === cur);
          const lim = Number(plan?.max_accounts_per_platform);
          if (alive && Number.isInteger(lim) && lim > 0) setMaxAccountsPerPlatform(lim);
        }
      } catch { /* 拉不到 → 沿用 matrix/config 或兜底上限 */ }
    })();
    return () => { alive = false; };
  }, []);
  // 号数墙最终以 /api/ai/balance 返回的【当前生效上限】为准(后端已按订阅是否有效做 free 兜底,
  //   且与 sidecar 运行时截断同源)。9999 = 老后端没返该字段的哨兵值,此时不覆盖、沿用 plan/config。
  useEffect(() => {
    const sync = (s: { maxAccountsPerPlatform: number }) => {
      if (s.maxAccountsPerPlatform > 0 && s.maxAccountsPerPlatform !== 9999) setMaxAccountsPerPlatform(s.maxAccountsPerPlatform);
    };
    sync(noobClawAuth.getState());
    return noobClawAuth.subscribe(sync);
  }, []);
  const [tasks, setTasks] = useState<MatrixTask[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [platform, setPlatform] = useState<string>(initialPlatform || 'douyin');
  // 从向导「无账号」引导跳来时,落到来源平台 tab(initialPlatform 变化才覆盖,不打断手动切 tab)。
  useEffect(() => { if (initialPlatform) setPlatform(initialPlatform); }, [initialPlatform]);
  // 把当前选中平台上报给 App —— 让「新建涨粉任务」的互动向导默认落在这里选的平台(而非写死抖音)。
  useEffect(() => { onPlatformChange?.(platform); }, [platform, onPlatformChange]);
  // kernelPath:调试用的手动内核路径覆盖(UI 已移除输入框,留空即由后端自动解析已装版本)。
  const [kernelPath] = useState<string>(() => localStorage.getItem('matrix:kernelPath') || '');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // 快手专属:当前子 tab(创作者中心 / 主站)+ 新建时所选类型(建号后不可改)。
  const [ksScope, setKsScope] = useState<'main' | 'creator'>('creator');
  const [newScope, setNewScope] = useState<'main' | 'creator'>('creator');

  // 进度
  const [items, setItems] = useState<Record<string, ItemResult>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [doneReport, setDoneReport] = useState<any>(null);

  // 账号弹窗 + 通知
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  // 添加新号的步骤:平台已有号时,新号走 2 步(1 配账号 → 2 配代理 IP);首个号 / 编辑保持单步。
  const [addStep, setAddStep] = useState<1 | 2>(1);
  const [newName, setNewName] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [newPersona, setNewPersona] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [notice, setNotice] = useState('');
  // 顶部 toast 提示 5s 后自动消失(弹窗内的校验提示走 showAdd 常驻,不在这清)。
  useEffect(() => {
    if (!notice || showAdd) return;
    const t = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(t);
  }, [notice, showAdd]);

  // 应用内确认弹窗(替代被 ACL 拦的 window.confirm)
  const [confirmDlg, setConfirmDlg] = useState<{ title: string; body: string; okText?: string; danger?: boolean; onYes: () => void } | null>(null);

  // 代理弹窗
  const [proxyFor, setProxyFor] = useState<string | null>(null);
  const [proxyForm, setProxyForm] = useState({ protocol: 'socks5', host: '', port: '', username: '', password: '', geo: '' });
  // 配代理校验:状态行 + 校验中 + 「仍然保存」暂存动作(撞IP/不通时拦,点仍然保存才跳过)。
  const [proxyMsg, setProxyMsg] = useState<{ kind: 'checking' | 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [pendingProxySave, setPendingProxySave] = useState<(() => Promise<void>) | null>(null);

  // 任务编辑(用 MatrixTaskWizard,样式照搬老客户端 DouyinConfigWizard)
  const [taskEditId, setTaskEditId] = useState<string | null>(null);
  const [showTaskEditModal, setShowTaskEditModal] = useState(false);
  const [showNewWizard, setShowNewWizard] = useState(false); // 新建页:点「互动涨粉」卡片才弹向导
  const [showNewReplyWizard, setShowNewReplyWizard] = useState(false); // 新建页:点「自动回复粉丝」卡片才弹向导
  const [replyEditId, setReplyEditId] = useState<string | null>(null);
  const [showReplyEditModal, setShowReplyEditModal] = useState(false); // 详情页编辑「回复粉丝」任务

  // 指纹浏览器内核
  const [kernel, setKernel] = useState<{ installed?: boolean; installedVersion?: string; installedVersions?: string[]; configuredVersion?: string; needsUpdate?: boolean; selectedVersion?: string; available?: { version: string; label: string; recommended: boolean; installed: boolean; sizeMb: number; note: string }[] }>({});
  const [selectedVersion, setSelectedVersion] = useState<string>('');
  const [kernelMsg, setKernelMsg] = useState('');
  const [kernelBusy, setKernelBusy] = useState(false);
  const [kernelPct, setKernelPct] = useState(0);
  const [showKernelModal, setShowKernelModal] = useState(false);
  const [kernelMenuOpen, setKernelMenuOpen] = useState(false);

  const reload = useCallback(async () => { const r = await M()?.listAccounts(); if (r?.ok) setAccounts(r.accounts || []); }, []);
  const reloadTasks = useCallback(async () => { const r = await M()?.listTasks?.(); if (r?.ok) { setTasks(r.tasks || []); if (typeof r.running === 'boolean') setRunning(r.running); } }, []);
  const reloadRuns = useCallback(async () => { const r = await M()?.listRuns?.(); if (r?.ok) setRuns(r.runs || []); }, []);

  useEffect(() => { reload(); reloadTasks(); }, [reload, reloadTasks]);
  useEffect(() => { if (screen === 'runs') reloadRuns(); }, [screen, reloadRuns]);

  useEffect(() => {
    const off = M()?.onProgress?.((p: any) => {
      if (p?.type === 'taskStart') { setItems({}); setLogs([]); setDoneReport(null); setRunning(true); setRunningTaskId(p.taskId || null); }
      else if (p?.type === 'item') setItems((prev) => ({ ...prev, [p.accountId]: { accountId: p.accountId, state: p.state, reason: p.reason, counts: p.counts } }));
      else if (p?.type === 'log') setLogs((prev) => [`[${p.accountId}] ${p.msg}`, ...prev].slice(0, 200));
      else if (p?.type === 'done') { setRunning(false); setRunningTaskId(null); setDoneReport(p.report); reload(); reloadTasks(); reloadRuns(); }
      else if (p?.type === 'error') { setRunning(false); setRunningTaskId(null); setLogs((prev) => [`任务错误: ${p.error}`, ...prev]); reloadTasks(); }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [reload, reloadTasks, reloadRuns]);

  useEffect(() => { const off = M()?.onAccount?.(() => { reload(); }); return () => { if (typeof off === 'function') off(); }; }, [reload]);
  useEffect(() => { localStorage.setItem('matrix:kernelPath', kernelPath); }, [kernelPath]);
  useEffect(() => { const h = setInterval(() => { reloadTasks(); }, 30000); return () => clearInterval(h); }, [reloadTasks]);

  // 选中版本来源:已落盘的 selectedVersion 优先(后端唯一来源),其次配置的最新版。
  // 用 prev || 不覆盖用户本会话刚选的。
  const loadKernel = useCallback(() => {
    // ① 先读本地(毫秒级,不请求服务端):有已装内核就立刻判「就绪」,避免 fetchKernels 慢时
    //   徽章长时间「未就绪」。② 再拉完整状态(含服务端 available 版本列表),merge 补全不覆盖。
    M()?.kernelLocalStatus?.().then((r: any) => {
      if (r && (r.installedVersions?.length || r.installed)) {
        setKernel((prev) => ({ ...prev, ...r }));
        setSelectedVersion((prev) => prev || r.selectedVersion || '');
      }
    }).catch(() => {});
    M()?.kernelStatus?.().then((r: any) => {
      setKernel((prev) => ({ ...prev, ...(r || {}) }));
      setSelectedVersion((prev) => prev || r?.selectedVersion || r?.configuredVersion || '');
    }).catch(() => {});
  }, []);
  useEffect(() => {
    loadKernel();
    // 下载完成 → 自动选中刚下好的版本并落盘(让它成为后续任务用的版本)。
    const off = M()?.onKernel?.((p: any) => {
      if (typeof p?.pct === 'number') setKernelPct(p.pct);
      setKernelMsg(p?.msg || '');
      if (p?.done) {
        setKernelBusy(false);
        if (p?.path && p?.version) { setSelectedVersion(String(p.version)); M()?.setSelectedKernel?.({ version: String(p.version) }); }
        loadKernel();
      }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadKernel]);

  // 切换全局选中版本(已装的才可选);落盘成所有启动路径的唯一来源。
  const chooseVersion = useCallback(async (v: string) => {
    setSelectedVersion(v);
    await M()?.setSelectedKernel?.({ version: v });
    setKernelMenuOpen(false);
  }, []);
  // 下载指定版本(不传则下当前选中/最新版)。进度走 matrix:kernel SSE。
  const downloadKernel = async (version?: string) => {
    const v = version || selectedVersion || kernel.configuredVersion || '';
    // 不强制开弹窗:从下拉点「下载」就只在下拉里显示进度;从「未就绪」拦截弹窗点下载时
    // 弹窗本来就开着,进度显示在弹窗。避免下拉 + 弹窗两处重复显示同一条进度。
    setKernelBusy(true); setKernelPct(0); setKernelMsg('准备下载…');
    await M()?.ensureKernel({ version: v });
  };

  // 快手按子 tab 过滤(老号无 loginScope → 当主站);其它平台不分。
  const platformAccounts = accounts.filter((a) => a.platform === platform && (platform !== 'kuaishou' || (a.loginScope || 'main') === ksScope));
  // 会员号数墙:本平台按【绑定先后】(id 内嵌 base36 创建时间戳)排序,超出当前生效档位上限的号 = 暂停。
  //   与 sidecar 运行时截断(planLimit.allowedAccountIds)完全同一口径 → UI 置灰的号 == 实际被跳过的号。
  const suspendedIds: Set<string> = (() => {
    const allPlat = accounts.filter((a) => a.platform === platform);
    if (!(maxAccountsPerPlatform > 0) || allPlat.length <= maxAccountsPerPlatform) return new Set();
    const tsOf = (id: string) => { const n = parseInt(String(id).split('_')[1] || '', 36); return Number.isFinite(n) && n > 0 ? n : 0; };
    const sorted = [...allPlat].sort((a, b) => tsOf(a.id) - tsOf(b.id));
    return new Set(sorted.slice(maxAccountsPerPlatform).map((a) => a.id));
  })();
  const platformTasks = tasks.filter((t) => t.platform === platform);
  // 各平台「登录过期」账号数 —— 在平台 tab 右上角红圈角标展示。
  // 「登录过期」= login_required 但连过有身份(过期流程只翻状态不清身份),与卡片角标判定一致。
  const expiredCountByPlatform = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of accounts) {
      if (a.status === 'login_required' && !!(a.nickname || a.avatar || a.displayId)) m[a.platform] = (m[a.platform] || 0) + 1;
    }
    return m;
  }, [accounts]);
  // 就绪 = 选中的版本已下载到本地(或调试手填了路径)。否则任务/扫码一律拦下弹下载窗。
  const kernelReady = (!!selectedVersion && (kernel.installedVersions || []).includes(selectedVersion)) || !!kernelPath.trim();
  const requireKernel = (): boolean => { if (kernelReady) return true; setShowKernelModal(true); return false; };
  // 未登录则弹登录窗(NoobClaw 账号),拦在所有矩阵操作(建号/编辑/删除/建任务/运行等)前面。
  const requireLogin = (): boolean => { if (noobClawAuth.getState().isAuthenticated) return true; noobClawAuth.requireLoginUI(); return false; };

  // ── 账号 ──
  const openAdd = () => {
    if (!requireLogin()) return;
    if (!requireKernel()) return;
    // 每个平台账号数上限(快手两端按平台总数合并计):达上限不开弹窗,只提示。上限服务端可调。
    const platformTotal = accounts.filter((a) => a.platform === platform).length;
    // 达套餐上限:弹窗(带「去升级会员」按钮直达会员订阅)而非一次性 toast,引导用户升级。
    if (platformTotal >= maxAccountsPerPlatform) {
      setConfirmDlg({
        title: `${PLATFORM_LABEL[platform]}账号已达套餐上限`,
        body: `当前套餐每个平台最多可连接 ${maxAccountsPerPlatform} 个账号。升级会员可提升上限,或先移除部分账号再连接。`,
        okText: '去升级会员',
        onYes: () => { setConfirmDlg(null); openWallet('subscription'); },
      });
      return;
    }
    setEditId(null); setNewName(`账号${platformAccounts.length + 1}-`); setNewScope(ksScope);
    // 默认选中一个赛道并带出人设 + 关键词(可再改)。x/tiktok/youtube 带英文词。
    const def = trackPresets.find((t) => t.name === DEFAULT_TRACK) || trackPresets[0];
    if (def) { setNewGroup(def.name); setNewPersona(def.persona); setNewKeywords(trackKeywords(def, platform).join(' ')); }
    // 新号从第 1 步开始;代理表单清空(第 2 步填,不填则共用本机 IP)。
    setAddStep(1); setProxyForm({ protocol: 'socks5', host: '', port: '', username: '', password: '', geo: '' });
    setProxyMsg(null); setPendingProxySave(null); setProxyBusy(false);
    setTrackOpen(false); setNotice(''); setShowAdd(true);
  };
  // 选赛道 → 关键词 + 人设自动带出(可再改);选「自定义」(空)则保留当前内容让用户自己填。
  const pickTrack = (name: string) => {
    setNewGroup(name);
    const p = trackPresets.find((t) => t.name === name);
    if (p) { setNewKeywords(trackKeywords(p, platform).join(' ')); setNewPersona(p.persona); }
  };
  const openEdit = (a: MatrixAccount) => { if (!requireLogin()) return; setEditId(a.id); setNewName(a.displayName); setNewGroup(a.group || ''); setNewPersona(a.persona || ''); setNewKeywords((a.keywords || []).join(' ')); setNewScope((a.loginScope as 'main' | 'creator') || 'main'); setTrackOpen(false); setNotice(''); setShowAdd(true); };
  const confirmAdd = async (thenLogin: boolean) => {
    if (!requireLogin()) return;
    const m = M(); if (!m) { setNotice('matrix 接口未就绪'); return; }
    const keywords = parseKeywords(newKeywords); const group = newGroup.trim() || undefined; const persona = newPersona.trim();
    if (!persona) { setNotice('请填写人设(自动评论时按这个口吻写)'); return; } // 人设必填
    if (editId) { await m.updateAccountMeta({ id: editId, displayName: newName.trim() || undefined, group, persona, keywords }); setShowAdd(false); await reload(); setNotice('已更新'); return; }
    const name = newName.trim(); if (!name) { setNotice('请填账号备注名'); return; }
    // 建号 +(可选)绑代理,抽成闭包:代理校验通过/跳过后才真正执行。
    const doCreate = async (proxyOut: any | null): Promise<void> => {
      const r = await m.createAccount({ platform, displayName: name, group, persona, keywords, loginScope: platform === 'kuaishou' ? newScope : undefined });
      if (r?.ok && r.account && proxyOut) {
        try { await m.setAccountProxy({ id: r.account.id, proxy: proxyOut }); } catch { /* 代理存失败不挡建号 */ }
      }
      setShowAdd(false); setProxyMsg(null);
      if (r?.ok) { await reload(); setNotice(`已建号:${name}`); if (thenLogin && r.account) promptScanLogin(r.account.id, platform, name, platform === 'kuaishou' ? newScope : undefined); }
      else setNotice('创建失败:' + (r?.error || 'IPC 未响应'));
    };
    // 第 2 步配了代理 → 先校验(撞IP/连通),有问题给「仍然保存」;没配代理(走本机)直接建。
    const host = proxyForm.host.trim(); const port = Number(proxyForm.port);
    if (host) {
      if (!Number.isInteger(port) || port <= 0) { setProxyMsg({ kind: 'err', text: '请填写正确的代理 host 和 port' }); return; }
      const proxy = { protocol: proxyForm.protocol, host, port, username: proxyForm.username.trim() || undefined, password: proxyForm.password.trim() || undefined, geo: proxyForm.geo.trim() || undefined };
      await guardProxyThen(proxy, undefined, platform, platform === 'kuaishou' ? newScope : undefined, (p) => doCreate(p));
      return;
    }
    await doCreate(null);
  };
  // 扫码登录二次确认:点「好的,我已知晓」才真正打开指纹浏览器导航到平台登录页(避免「一点就开浏览器」的突兀)。
  const promptScanLogin = (accountId: string, plat: string, displayName: string, loginScope?: string) => {
    if (!requireLogin()) return;
    const platName = PLATFORM_LABEL[plat] || '该平台';
    const scopeName = plat === 'kuaishou' ? (loginScope === 'creator' ? '创作者中心(cp.kuaishou.com)' : '主站(www.kuaishou.com)') : '';
    setConfirmDlg({
      title: `扫码连接${platName}${scopeName ? ' · ' + scopeName : ''}`,
      body: `即将打开指纹浏览器访问${platName}${scopeName ? scopeName : ''},需要您在弹出的浏览器里扫码登录。扫码成功后状态会自动变「已连接」。`,
      okText: '打开浏览器登录',
      onYes: async () => {
        setConfirmDlg(null);
        if (!requireKernel()) return;
        setNotice(`正在为「${displayName}」打开指纹浏览器,扫码连接后状态自动刷新`);
        await M()?.openLogin({ accountId, kernelPath, loginUrl: loginUrlFor(plat, loginScope) });
      },
    });
  };
  // 刷新信息:对任意账号拉起内核读 昵称/平台号/头像(已登录但没读过身份的号用这个)。
  const refreshIdentity = async (a: MatrixAccount) => {
    if (!requireLogin()) return;
    if (!requireKernel()) return;
    setNotice(`正在读取「${a.displayName}」的账号信息…(会短暂弹出浏览器)`);
    const r = await M()?.refreshIdentity?.({ accountId: a.id, homeUrl: loginUrlFor(a.platform, a.loginScope), kernelPath });
    if (r?.ok) { await reload(); setNotice(r.loggedIn ? `已读取:${r.nickname || a.displayName}${r.displayId ? ' · ' + r.displayId : ''}` : `「${a.displayName}」未检测到登录,请扫码连接`); }
    else setNotice('读取失败:' + (r?.error || '未知'));
  };
  // 断开连接:清登录 cookie + 身份,但保留赛道/关键词/人设/代理/指纹配置,可随时重新扫码连接。
  // 用应用内确认弹窗(不能用 window.confirm —— Tauri dialog 插件被 ACL 拦)。
  const disconnectAccount = (a: MatrixAccount) => {
    if (!requireLogin()) return;
    setConfirmDlg({
      title: '断开连接',
      body: `断开「${a.nickname || a.displayName}」的连接?会登出该账号(清 cookie),但保留赛道 / 关键词 / 代理等配置,可随时重新扫码连接。`,
      okText: '断开连接',
      onYes: async () => {
        setConfirmDlg(null);
        setNotice(`正在断开「${a.displayName}」…`);
        const r = await M()?.disconnectAccount?.({ accountId: a.id, kernelPath });
        if (r?.ok) { await reload(); setNotice(`已断开「${a.displayName}」,需重新扫码连接`); }
        else setNotice('断开失败:' + (r?.error || '未知'));
      },
    });
  };
  // 移除:彻底移除账号配置 + profile,不可恢复。
  const deleteAccount = (a: MatrixAccount) => {
    if (!requireLogin()) return;
    setConfirmDlg({
      title: '移除账号',
      danger: true,
      body: `从列表中移除「${a.nickname || a.displayName}」?你可以下次通过连接账号再次添加。`,
      okText: '移除',
      onYes: async () => {
        setConfirmDlg(null);
        await M()?.removeAccount?.({ id: a.id });
        await reload();
        setNotice(`已移除「${a.displayName}」`);
      },
    });
  };
  const openProxy = (a: MatrixAccount) => { if (!requireLogin()) return; setProxyForm({ protocol: a.proxy?.protocol || 'socks5', host: a.proxy?.host || '', port: a.proxy?.port ? String(a.proxy.port) : '', username: a.proxy?.username || '', password: a.proxy?.password || '', geo: a.proxy?.geo || '' }); setProxyMsg(null); setPendingProxySave(null); setProxyBusy(false); setProxyFor(a.id); };

  // 从表单组装 proxy;host/port 不合法 → 设错误状态行,返回 null。
  const buildProxyFromForm = (): any | null => {
    const host = proxyForm.host.trim(); const port = Number(proxyForm.port);
    if (!host || !Number.isInteger(port) || port <= 0) { setProxyMsg({ kind: 'err', text: '请填写正确的代理 host 和 port' }); return null; }
    return { protocol: proxyForm.protocol, host, port, username: proxyForm.username.trim() || undefined, password: proxyForm.password.trim() || undefined, geo: proxyForm.geo.trim() || undefined };
  };

  // 配代理通用校验:① 连通性(probeProxy)② 同平台撞 IP。有问题 → 状态行 + 暂存「仍然保存」动作;通过 → 直接 save(带 health=ok)。
  const guardProxyThen = async (proxy: any, accountId: string | undefined, plat: string, scope: string | undefined, save: (proxyOut: any) => Promise<void>): Promise<void> => {
    setProxyBusy(true); setProxyMsg({ kind: 'checking', text: '⏳ 正在校验代理连通性…' }); setPendingProxySave(null);
    let r: any = null;
    try { r = await M()?.validateProxy({ accountId, platform: plat, loginScope: scope, proxy }); } catch { r = null; }
    setProxyBusy(false);
    const issues: string[] = [];
    if (r?.duplicateName) issues.push(`⚠️ 该代理IP已被本平台「${r.duplicateName}」使用,多号同 IP 有风控风险`);
    if (!r?.reachable) issues.push(`❌ 代理IP无法连接(${r?.error || '超时/不通'}),请检查协议/host/端口/账密,或代理是否可用`);
    if (issues.length) {
      setProxyMsg({ kind: 'warn', text: issues.join('\n') });
      setPendingProxySave(() => async () => { setPendingProxySave(null); setProxyMsg(null); await save(proxy); }); // 跳过校验保存(不带 health,待下次探测)
      return;
    }
    setProxyMsg({ kind: 'ok', text: '✅ 代理IP正常工作,即将保存…' });
    await new Promise((r) => setTimeout(r, 1500)); // 让用户看清「正常工作」再保存关窗(原来一闪而过看不清)
    await save({ ...proxy, health: 'ok' });
  };

  const saveProxy = async () => {
    const proxy = buildProxyFromForm(); if (!proxy) return;
    const acc = accounts.find((x) => x.id === proxyFor);
    await guardProxyThen(proxy, proxyFor || undefined, acc?.platform || '', acc?.loginScope, async (p) => {
      await M()?.setAccountProxy({ id: proxyFor, proxy: p });
      setProxyFor(null); setProxyMsg(null); await reload(); setNotice(`✅ 代理IP ${p.host} 正常工作,已绑定`);
    });
  };

  // ── 任务 ──
  // 向导(MatrixTaskWizard)保存:成功回 tasks 屏;失败抛出让向导显示红字。
  const saveTaskFromWizard = async (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; quota: any }) => {
    if (!requireLogin()) throw new Error('请先登录 NoobClaw 账号');
    const r = await M()?.saveTask({ id: taskEditId || undefined, platform, type: 'engage', name: input.name, accountIds: input.accountIds, quota: input.quota, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限', duplicate_type: '该平台已有同类型(互动)任务,直接编辑它即可', task_not_found: '任务不存在' } as any)[r?.error] || r?.error || '保存失败');
    await reloadTasks(); setNotice('任务已保存');
    setShowTaskEditModal(false); setTaskEditId(null);
    onNavigate?.('tasks');
  };
  // 「自动回复粉丝」向导保存:type='reply_fan' + funnel(无配额)。与 engage 同平台可并存(不同 type)。
  const saveTaskFromReplyWizard = async (input: { name: string; accountIds: string[]; concurrency: number; frequency: string; funnel: { funnel_phrase: string; funnel_probability: number } }) => {
    if (!requireLogin()) throw new Error('请先登录 NoobClaw 账号');
    const r = await M()?.saveTask({ id: replyEditId || undefined, platform, type: 'reply_fan', name: input.name, accountIds: input.accountIds, funnel: input.funnel, quota: {}, concurrency: input.concurrency, frequency: input.frequency, enabled: true });
    if (!r?.ok) throw new Error(({ platform_task_limit: '该平台任务已达 5 个上限', duplicate_type: '该平台已有同类型(回复粉丝)任务,直接编辑它即可', task_not_found: '任务不存在' } as any)[r?.error] || r?.error || '保存失败');
    await reloadTasks(); setNotice('任务已保存');
    setShowReplyEditModal(false); setReplyEditId(null);
    onNavigate?.('tasks');
  };
  const runTaskNow = async (t: MatrixTask) => {
    if (!requireLogin()) return;
    if (!requireKernel()) return;
    if (running) { setNotice('已有任务在跑,同时只能跑一个'); return; }
    setItems({}); setLogs([]); setDoneReport(null); setRunning(true); setSelectedTaskId(t.id);
    const r = await M()?.runTaskById({ taskId: t.id, kernelPath });
    if (!r?.ok) { setRunning(false); setNotice('启动失败:' + (r?.error === 'another_task_running' ? '已有任务在跑' : r?.error || '未知')); }
  };
  const stopTask = async () => { setNotice('已请求停止,正在关闭窗口…'); await M()?.stopTask?.(); };
  const deleteTask = async (t: MatrixTask) => { await M()?.removeTask({ id: t.id }); setSelectedTaskId(null); await reloadTasks(); };

  // ── 复用片段 ──
  // 进度卡里每号的计数:engage 显示 赞/关/评;reply_fan 只有回复数(走 counts.comment 通道)。
  const renderProgress = (isReply?: boolean) => (
    <div className="mt-4">
      {doneReport && <div className="mb-3 text-sm p-3 rounded-lg bg-black/5 dark:bg-white/10">完成:成功 {doneReport.success} · 失败 {doneReport.failed} · 跳过 {doneReport.skipped}</div>}
      <div className="grid grid-cols-2 gap-2 mb-3">
        {Object.values(items).map((it) => {
          const acc = accounts.find((a) => a.id === it.accountId);
          const color = it.state === 'success' ? 'text-green-500' : it.state === 'skipped' ? 'text-amber-500' : 'text-red-500';
          return (
            <div key={it.accountId} className="flex items-center gap-2 text-sm p-2 rounded border dark:border-white/10 border-black/10">
              <span className={color}>●</span><span className="flex-1 truncate">{acc?.displayName || it.accountId}</span>
              {it.counts && <span className="text-xs opacity-60">{isReply ? `回复${it.counts.comment}` : `赞${it.counts.like}/关${it.counts.follow}/评${it.counts.comment}`}</span>}
              <span className="text-xs opacity-60">{it.state}{it.reason ? `:${it.reason}` : ''}</span>
            </div>
          );
        })}
      </div>
      <div className="text-xs font-mono opacity-60 space-y-0.5 max-h-56 overflow-auto">{logs.map((l, i) => <div key={i}>{l}</div>)}</div>
    </div>
  );

  // 统计卡(照抄 TaskDetailPage 的 StatCard)
  const stat = (label: string, value: string, onClick?: () => void, actionLabel?: string) => {
    const Tag: any = onClick ? 'button' : 'div';
    return (
      <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={`text-left w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 ${onClick ? 'hover:border-green-500/50 transition-colors cursor-pointer' : ''}`}>
        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
        <div className="font-bold dark:text-white text-sm">{value}</div>
        {onClick && actionLabel && <div className="text-[10px] text-green-500 dark:text-green-400 mt-1 truncate">{actionLabel}</div>}
      </Tag>
    );
  };

  const selectedTask = tasks.find((t) => t.id === selectedTaskId) || null;
  const selectedIsReply = selectedTask?.type === 'reply_fan';
  const SCREEN_TITLE: Record<string, string> = { accounts: '我的矩阵账号', newTask: '新建矩阵涨粉任务', tasks: '我的矩阵涨粉任务', runs: '矩阵涨粉运行记录' };

  return (
    <div className="h-full flex flex-col dark:text-claude-darkText text-claude-text">
      <div className="flex items-center gap-2 px-5 py-3 border-b dark:border-white/10 border-black/10 flex-wrap">
        <h1 className="text-lg font-medium mr-3">{SCREEN_TITLE[screen] || '矩阵号'}</h1>
        {/* 钱包(BSC/地址/积分/充值)—— 与新建页一致 */}
        <WalletBadge />
        <div className="ml-auto flex items-center gap-2">
          {/* 指纹浏览器:全局版本选择器。服务端有几个版本就列几个,已装打勾、未装给下载按钮。
              选中已装版本即可开跑任务(选中版即所有号/任务用的内核)。 */}
          <div className="relative">
            <button type="button" onClick={() => setKernelMenuOpen((o) => !o)}
              className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border ${kernelReady ? 'bg-green-500/15 text-green-500 border-green-500/30' : 'bg-amber-500/15 text-amber-500 border-amber-500/30'}`}>
              🧬 指纹浏览器 {selectedVersion ? `v${selectedVersion}` : ''} {kernelReady ? '✓' : '⚠ 未就绪'}
              <span className="opacity-60">▾</span>
            </button>
            {kernelMenuOpen && (
              <>
                {/* 点击空白关闭 */}
                <div className="fixed inset-0 z-40" onClick={() => setKernelMenuOpen(false)} />
                <div className="absolute right-0 mt-1 z-50 w-64 rounded-xl py-1 shadow-xl dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
                  <div className="px-3 py-1.5 text-[11px] opacity-50">选择内核版本</div>
                  {(kernel.available && kernel.available.length) ? kernel.available.map((a) => {
                    const isSel = a.version === selectedVersion;
                    return (
                      <div key={a.version} className={`flex items-center justify-between gap-2 px-3 py-1.5 ${isSel ? 'bg-green-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
                        <button type="button" disabled={!a.installed} onClick={() => a.installed && chooseVersion(a.version)}
                          className={`flex-1 min-w-0 text-left flex items-center gap-1.5 ${a.installed ? 'cursor-pointer' : 'cursor-default opacity-70'}`}>
                          <span className="text-xs font-medium truncate">{a.label || `v${a.version}`}</span>
                          {a.sizeMb ? <span className="text-[10px] opacity-40 shrink-0">{a.sizeMb}MB</span> : null}
                          {a.recommended && <span className="text-[10px] px-1 rounded bg-violet-500/20 text-violet-500 shrink-0">推荐</span>}
                          {isSel && a.installed && <span className="text-[10px] text-green-500 shrink-0">使用中</span>}
                        </button>
                        {a.installed
                          ? <span className="text-green-500 text-sm shrink-0">✓</span>
                          : <button type="button" disabled={kernelBusy} onClick={() => downloadKernel(a.version)}
                              className="shrink-0 text-[11px] px-2 py-1 rounded-lg bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{kernelBusy ? '下载中…' : '下载'}</button>}
                      </div>
                    );
                  }) : (
                    <div className="px-3 py-3 text-xs opacity-60">{kernel.installed ? '已安装本地版本' : '正在获取版本列表…'}</div>
                  )}
                  {kernelBusy && (
                    <div className="px-3 pt-1.5 pb-1 border-t dark:border-white/10 border-black/10">
                      <div className="h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.max(2, kernelPct)}%` }} /></div>
                      <div className="text-[10px] opacity-60 mt-1 truncate">{kernelMsg} · {kernelPct}%</div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          {kernelBusy && !kernelMenuOpen && <span className="text-xs opacity-60 max-w-[160px] truncate">{kernelMsg} · {kernelPct}%</span>}
        </div>
      </div>

      {notice && (
        <div className="mx-5 mt-3 text-sm px-3 py-2 rounded-lg bg-claude-accent/10 text-claude-accent flex items-center justify-between">
          <span>{notice}</span><button onClick={() => setNotice('')} className="opacity-60 hover:opacity-100 ml-3">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5">
        {/* 我的矩阵账号 —— 账号池(卡片样式对齐老客户端) */}
        {screen === 'accounts' && (
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div className="flex items-center gap-2.5">
                <h2 className="text-lg font-bold dark:text-white">🧬 我的矩阵账号</h2>
                {/* 涨粉教程(从顶栏挪到标题后,贴着账号页) */}
                <button type="button" onClick={() => { try { (window as any).electron?.shell?.openExternal('https://docs.noobclaw.com'); } catch { /* ignore */ } }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-gradient-to-r from-amber-500/15 via-orange-500/15 to-rose-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:border-amber-500/60">📖 涨粉教程</button>
              </div>
              <div className="flex items-center gap-2.5">
                {/* 当前平台账号数 / 上限(上限服务端可调) */}
                <span className="text-xs text-gray-400 dark:text-gray-500">{accounts.filter((a) => a.platform === platform).length}/{maxAccountsPerPlatform}</span>
                <button onClick={openAdd} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95 transition-all">+ 连接{PLATFORM_LABEL[platform]}账号</button>
              </div>
            </div>
            {/* 平台 tab 切换(跟新建页一致),按平台分别管理账号 */}
            <div className="flex flex-wrap gap-2 mb-4">
              {PLATFORMS.map((p) => {
                const expiredCount = expiredCountByPlatform[p] || 0;
                return (
                <button key={p} onClick={() => setPlatform(p)} className={`relative px-3.5 py-1.5 rounded-full text-sm border transition-colors ${platform === p ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'}`}>
                  {PLATFORM_LABEL[p]}
                  {/* 该平台有登录过期账号 → 红圈计数角标(提醒去重新扫码连接) */}
                  {expiredCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">{expiredCount}</span>
                  )}
                </button>
                );
              })}
            </div>
            {/* 快手:创作者中心(发布)/ 主站(涨粉)两类账号分开管理(两端登录互不覆盖)。 */}
            {platform === 'kuaishou' && (
              <div className="flex items-center gap-2 mb-4 -mt-1">
                <span className="text-xs text-gray-400">快手分两类:</span>
                {KS_SCOPES.map((s) => (
                  <button key={s.key} onClick={() => setKsScope(s.key)} className={`px-3 py-1 rounded-lg text-xs border transition-colors ${ksScope === s.key ? 'border-orange-500 bg-orange-500/10 text-orange-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-orange-500/50'}`}>{s.label}</button>
                ))}
              </div>
            )}
            {platformAccounts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
                <div className="text-4xl mb-2">📭</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">该平台还没有账号</div>
                <button onClick={openAdd} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95">+ 连接{PLATFORM_LABEL[platform]}账号</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {platformAccounts.map((a, idx) => {
                  // 状态小标签(挪到名字后边,表示状态;不放右侧按钮区)。
                  // 「登录过期」= login_required 但【连过有身份】(过期流程只翻状态不清身份);login_required 且无身份 = 尚未连接(从没连过)。
                  const expired = a.status === 'login_required' && !!(a.nickname || a.avatar || a.displayId);
                  // 状态左上角实心角标配色:已连接绿、登录过期红(连过但失效·可重扫)、尚未连接黄、运行蓝、封红、其它灰,全白字。
                  const stSolid = a.status === 'idle' ? 'bg-green-500'
                    : expired ? 'bg-red-500'
                    : a.status === 'login_required' ? 'bg-amber-500'
                    : a.status === 'running' ? 'bg-blue-500'
                    : a.status === 'banned' ? 'bg-red-500'
                    : 'bg-gray-400';
                  const stLabel = expired ? '登录过期' : STATUS_LABEL[a.status];
                  const stDot = expired ? 'bg-red-500' : STATUS_DOT[a.status];
                  const isSuspended = suspendedIds.has(a.id);
                  return (
                  <div key={a.id} className={`relative h-full rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex flex-col gap-2 transition-colors bg-white dark:bg-gray-900 ${isSuspended ? 'opacity-60' : ''}`}>
                    {/* 左上角状态实心角标(更显眼:已连接绿底白字 / 尚未连接黄底白字) */}
                    <span className={`absolute -top-px -left-px px-2.5 py-0.5 text-[11px] font-semibold text-white rounded-tl-xl rounded-br-lg ${stSolid}`}>{stLabel}</span>
                    {/* 右上角移除 ✕ */}
                    <button onClick={() => deleteAccount(a)} title="移除该账号(彻底删除配置与 profile)" className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-red-500/90 transition-colors text-sm leading-none">✕</button>
                    <div className="flex items-center gap-2.5 min-w-0 pr-6 mt-3">
                      {/* 头像 + 状态点角标 */}
                      <div className="relative shrink-0">
                        {/* 首字母兜底永远在底层;头像加载成功盖在上面,失败(onError 隐藏)则露出首字母 —— 不会变空白。
                            B站等 CDN 返回 http:// 头像,在 webview(https/app://)是混合内容会被拦,统一升 https。 */}
                        <div className="w-9 h-9 rounded-full bg-violet-500/20 text-violet-500 flex items-center justify-center text-sm font-bold">{(a.nickname || a.displayName || '?').slice(0, 1)}</div>
                        {a.avatar && <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="absolute inset-0 w-9 h-9 rounded-full object-cover bg-gray-200 dark:bg-gray-700" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />}
                        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white dark:border-gray-900 ${stDot}`} />
                      </div>
                      {/* 昵称(真实)+ 平台号 + 备注 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-semibold dark:text-white truncate">{a.nickname || a.displayName}</span>
                          {isSuspended && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-gray-400/20 text-gray-500 dark:text-gray-400" title="会员到期/降级后超出当前可用号数,任务会自动跳过该号;续费或升级会员即可恢复,数据不会丢失。">⏸️ 超出会员额度·已暂停</span>}
                          <span className={`shrink-0 max-w-[16rem] truncate text-[10px] px-1.5 py-0.5 rounded-full ${a.proxy ? (a.proxy.health === 'ok' ? 'text-green-600 dark:text-green-400 bg-green-500/15' : a.proxy.health === 'dead' ? 'text-red-600 dark:text-red-400 bg-red-500/15' : 'text-blue-600 dark:text-blue-400 bg-blue-500/15') : (idx === 0 ? 'text-green-600 dark:text-green-400 bg-green-500/15' : 'text-amber-600 dark:text-amber-400 bg-amber-500/15')}`}>代理IP:{a.proxy ? ((a.proxy.geo || a.proxy.host) + (a.proxy.health === 'dead' ? ' ·不通' : '')) : (a.egressIp ? `本机 ${a.egressIp}` : (idx === 0 ? '本地IP(默认)' : '尚未配置'))}</span>
                        </div>
                        <div className="text-[11px] space-y-0.5" title={a.boundUid ? `uid: ${a.boundUid}` : undefined}>
                          {a.status === 'login_required'
                            ? (expired
                                ? (<>
                                    {a.displayId && <div className="text-gray-600 dark:text-gray-300 truncate">{platformIdLabel(a.platform)}:{a.displayId}</div>}
                                    <div className="text-gray-500 dark:text-gray-400 truncate">备注:{a.displayName}</div>
                                    <div className="text-red-500 truncate">⚠️ 登录过期,请点下方「扫码连接」重新登录</div>
                                  </>)
                                : <div className="text-amber-500 truncate">请点击下方扫码连接进行连接</div>)
                            : (<>
                                {a.displayId && <div className="text-gray-600 dark:text-gray-300 truncate">{platformIdLabel(a.platform)}:{a.displayId}</div>}
                                {/* 已连接但还没读到平台号/昵称(老建的号或读取失败)→ 明确提示去刷新,别让用户以为该功能没有 */}
                                {!a.displayId && !a.nickname && <div className="text-amber-500/90 truncate">ℹ️ 账号信息未读取,点「刷新信息」获取{platformIdLabel(a.platform)}/昵称/头像</div>}
                                <div className="text-gray-500 dark:text-gray-400 truncate">备注:{a.displayName}</div>
                              </>)}
                        </div>
                      </div>
                    </div>
                    {/* 赛道 / 人设 / 关键词,分三行 */}
                    <div className="text-xs space-y-0.5">
                      <div className="text-gray-500 dark:text-gray-400 truncate">🎯 赛道:{a.group ? <span className="text-gray-700 dark:text-gray-300">{a.group}</span> : <span className="text-amber-500">未设</span>}</div>
                      <div className="text-gray-500 dark:text-gray-400 truncate">🎭 人设:{a.persona ? <span className="text-gray-700 dark:text-gray-300">{a.persona}</span> : <span className="text-amber-500">未设</span>}</div>
                      <div className="text-gray-500 dark:text-gray-400 truncate">🏷️ 关键词:{a.keywords && a.keywords.length ? <span className="text-gray-700 dark:text-gray-300">{a.keywords.join(' · ')}</span> : <span className="text-amber-500">未配(互动需要)</span>}</div>
                    </div>
                    {/* 右侧可点击按钮:全色按钮 */}
                    <div className="flex items-center gap-2 flex-wrap pt-1 mt-auto">
                      {/* 未连接:配置IP/编辑/扫码连接 统一紫色;已连接:配置IP/编辑/刷新信息 统一绿色。 */}
                      <button onClick={() => openProxy(a)} className={`text-xs px-2.5 py-1 rounded-lg text-white ${a.status === 'login_required' ? 'bg-violet-500 hover:bg-violet-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}>配置IP</button>
                      <button onClick={() => openEdit(a)} className={`text-xs px-2.5 py-1 rounded-lg text-white ${a.status === 'login_required' ? 'bg-violet-500 hover:bg-violet-600' : 'bg-emerald-600 hover:bg-emerald-700'}`}>编辑</button>
                      {a.status === 'login_required'
                        ? (<>
                            {/* 尚未连接:只给「扫码连接」。它本身会开窗轮询登录态——若已在浏览器手动登录/扫码轮询超时,
                                点它会立刻检测到并翻成已连接(不必真重扫),所以无需单独的「刷新信息」(那是给已连接的号刷身份用的)。 */}
                            <button onClick={() => promptScanLogin(a.id, a.platform, a.displayName, a.loginScope)} className="text-xs px-2.5 py-1 rounded-lg bg-violet-500 text-white hover:bg-violet-600">扫码连接</button>
                          </>)
                        : (<>
                            {/* 已连接:读真实身份 / 断开(清登录,保留配置) */}
                            <button onClick={() => refreshIdentity(a)} className="text-xs px-2.5 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">刷新信息</button>
                            <button onClick={() => disconnectAccount(a)} className="text-xs px-2.5 py-1 rounded-lg bg-orange-500 text-white hover:bg-orange-600">断开连接</button>
                          </>)}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 新建矩阵涨粉任务 —— 平台 tab + 场景卡片入口(照抄 DouyinWorkflowsPage),点卡片弹向导 */}
        {screen === 'newTask' && (
          <div className="max-w-6xl mx-auto">
            <div className="flex flex-wrap gap-2 mb-6">
              {PLATFORMS.map((p) => (
                <button key={p} onClick={() => setPlatform(p)} className={`px-3.5 py-1.5 rounded-full text-sm border transition-colors ${platform === p ? 'border-violet-500 bg-violet-500/10 text-violet-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-violet-500/50'}`}>{PLATFORM_LABEL[p]}</button>
              ))}
            </div>
            {platform === 'douyin' ? (
              <>
                <section className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="relative rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-500/10 via-purple-500/5 to-transparent p-5 overflow-hidden flex flex-col">
                    <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-violet-500/10 blur-3xl pointer-events-none" />
                    <div className="relative flex flex-col flex-1">
                      <div className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-500 mb-2"><span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />互动涨粉</div>
                      <h3 className="text-base font-bold dark:text-white mb-1.5">🎶 抖音 · 互动涨粉(矩阵)</h3>
                      <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">同时控制多个账号,每个号在自己的指纹浏览器里、按【自己的赛道关键词】搜抖音视频,按你配的随机区间做点赞 / 关注 / 评论。评论由 AI 按视频文案 + 该号人设自动生成,行为间隔随机模拟真人。赛道/关键词/人设在「我的矩阵账号」给每个号设。</p>
                      <button onClick={() => { if (!requireLogin()) return; if (!requireKernel()) return; setShowNewWizard(true); }} className="w-full py-2.5 rounded-lg text-sm font-semibold text-white bg-violet-500 hover:bg-violet-600 shadow-lg shadow-violet-500/25">🎶 开始互动 →</button>
                    </div>
                  </div>
                  {/* 自动回复粉丝(矩阵多账号) */}
                  <div className="relative rounded-2xl border border-fuchsia-500/30 bg-gradient-to-br from-fuchsia-500/10 via-pink-500/5 to-transparent p-5 overflow-hidden flex flex-col">
                    <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full bg-fuchsia-500/10 blur-3xl pointer-events-none" />
                    <div className="relative flex flex-col flex-1">
                      <div className="inline-flex items-center gap-1.5 text-xs font-medium text-fuchsia-500 mb-2"><span className="inline-block w-1.5 h-1.5 rounded-full bg-fuchsia-500 animate-pulse" />粉丝维护</div>
                      <h3 className="text-base font-bold dark:text-white mb-1.5">💌 抖音 · 自动回复粉丝(矩阵)</h3>
                      <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed mb-3 flex-1">同时让多个账号在各自指纹浏览器的<strong>抖音创作者中心评论管理</strong>里,逐条回复自己作品下的粉丝评论。AI 按评论内容 + 该号人设写回应,可选按概率自然带上引流尾巴。已回复过的、自己留的评论自动跳过,只回粉丝、绝不评论作品本身。</p>
                      <button onClick={() => { if (!requireLogin()) return; if (!requireKernel()) return; setShowNewReplyWizard(true); }} className="w-full py-2.5 rounded-lg text-sm font-semibold text-white bg-fuchsia-500 hover:bg-fuchsia-600 shadow-lg shadow-fuchsia-500/25">💌 开始回复 →</button>
                    </div>
                  </div>
                </section>
                <section className="mb-6">
                  <div className="flex flex-wrap gap-2 justify-center">
                    {[['🛡️', '完全模拟人类行为不封号'], ['🚀', '多号并发 · 涨粉快'], ['💰', '成本超低'], ['🤖', '全智能控制']].map(([icon, t]) => (
                      <span key={t} className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border border-violet-500/20 bg-violet-500/5 text-gray-700 dark:text-gray-300">{icon} {t}</span>
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center text-sm text-gray-500 dark:text-gray-400">{PLATFORM_LABEL[platform]} 互动后续接入,目前先做抖音。</div>
            )}
            {showNewWizard && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto">
                <MatrixTaskWizard
                  platformLabel={PLATFORM_LABEL[platform]}
                  platform={platform}
                  accounts={platformAccounts as any}
                  initialTask={null}
                  onCancel={() => setShowNewWizard(false)}
                  onSave={async (input) => { await saveTaskFromWizard(input); setShowNewWizard(false); }}
                />
              </div>
            )}
            {showNewReplyWizard && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto">
                <MatrixReplyFansWizard
                  platformLabel={PLATFORM_LABEL[platform]}
                  platform={platform}
                  accounts={platformAccounts as any}
                  initialTask={null}
                  onCancel={() => setShowNewReplyWizard(false)}
                  onSave={async (input) => { await saveTaskFromReplyWizard(input); setShowNewReplyWizard(false); }}
                />
              </div>
            )}
          </div>
        )}

        {/* 我的矩阵涨粉任务(列表)—— 卡片样式对齐老客户端 MyTasksPage */}
        {screen === 'tasks' && !selectedTask && (
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <h2 className="text-lg font-bold dark:text-white">📋 我的{PLATFORM_LABEL[platform]}涨粉任务</h2>
              <div className="flex items-center gap-2">
                <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="text-sm px-2.5 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 dark:text-white">
                  {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
                </select>
                <button onClick={() => onNavigate?.('newTask')} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95 transition-all">🎶 新建任务</button>
              </div>
            </div>
            {platformTasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
                <div className="text-4xl mb-2">📭</div>
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-4">还没有{PLATFORM_LABEL[platform]}涨粉任务</div>
                <button onClick={() => onNavigate?.('newTask')} className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-semibold bg-violet-500 hover:bg-violet-600 shadow-sm shadow-violet-500/25 active:scale-95">🎶 新建{PLATFORM_LABEL[platform]}互动任务</button>
              </div>
            ) : (
              <div className="space-y-3">
                {platformTasks.map((t) => {
                  const isRunning = runningTaskId === t.id;
                  const isReply = t.type === 'reply_fan';
                  return (
                    <button key={t.id} type="button" onClick={() => setSelectedTaskId(t.id)}
                      className={`w-full text-left rounded-xl border p-4 transition-colors relative ${isRunning ? 'border-green-500 ring-2 ring-green-500/30 bg-white dark:bg-gray-900 noobclaw-running-glow' : 'border-gray-200 dark:border-gray-700 hover:border-violet-500/50 dark:hover:border-violet-500/50 bg-white dark:bg-gray-900'}`}>
                      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300">🎵 {PLATFORM_LABEL[t.platform]}</span>
                          {isReply
                            ? <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30">💌 回复粉丝</span>
                            : <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border text-violet-500 bg-violet-500/10 border-violet-500/30">🎶 互动涨粉</span>}
                          <span className="font-medium dark:text-white truncate">{t.name}</span>
                          <span className="text-[10px] text-gray-500 font-mono shrink-0">#{shortId(t.id)}</span>
                        </div>
                        <div className="shrink-0">
                          {isRunning ? (
                            <span className="text-xs px-2 py-1 rounded bg-green-500/10 text-green-500 border border-green-500/30 flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />运行中</span>
                          ) : t.frequency === 'once' ? (
                            <span className="text-xs px-2 py-1 rounded bg-purple-500/10 text-purple-500 border border-purple-500/30">✋ 手动运行</span>
                          ) : t.enabled ? (
                            <span className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-500 border border-blue-500/30">⏰ {fmtTime(t.nextPlannedRunAt)}</span>
                          ) : (
                            <span className="text-xs px-2 py-1 rounded bg-gray-500/10 text-gray-500 border border-gray-500/30">⏸ 已停用</span>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">👥 账号 {t.accountIds.length} 个 · {isReply ? '各自回复作品下的粉丝评论' : '各用自己的赛道关键词'}</div>
                      {isReply
                        ? <div className="text-xs text-gray-500 dark:text-gray-400">⏰ {FREQ_LABEL[t.frequency] || t.frequency} · 🎣 {t.funnel?.funnel_phrase ? `引流尾巴 ${t.funnel.funnel_probability || 0}%` : '纯 AI 回复'}</div>
                        : <div className="text-xs text-gray-500 dark:text-gray-400">⏰ {FREQ_LABEL[t.frequency] || t.frequency} · 👍 {t.quota.daily_like_min}-{t.quota.daily_like_max} · ➕ {t.quota.daily_follow_min}-{t.quota.daily_follow_max} · 💬 {t.quota.daily_comment_min}-{t.quota.daily_comment_max} / 次</div>}
                      <div className="text-[11px] text-gray-400 mt-1">{t.lastRunAt ? `上次运行 ${fmtTime(t.lastRunAt)}` : '尚未运行'}</div>
                      <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 flex items-center justify-end">
                        {isRunning
                          ? <span onClick={(e) => { e.stopPropagation(); stopTask(); }} className="text-xs px-3 py-1 rounded-lg font-semibold bg-red-500 text-white hover:bg-red-600">⏹ 停止</span>
                          : <span onClick={(e) => { e.stopPropagation(); runTaskNow(t); }} className={`text-xs px-3 py-1 rounded-lg font-semibold ${running ? 'bg-gray-300 text-gray-500 dark:bg-gray-700' : 'bg-violet-500 text-white hover:bg-violet-600'}`}>🎯 运行</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* 任务详情 —— 对齐老客户端 TaskDetailPage(摘要卡 + 运行中 glow + 运行历史) */}
        {screen === 'tasks' && selectedTask && (
          <div className="max-w-3xl mx-auto">
            <button onClick={() => setSelectedTaskId(null)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 mb-3">← 返回任务列表</button>
            <div className="flex items-center gap-2 mb-4 flex-wrap">
              <h2 className="text-lg font-bold dark:text-white">{selectedTask.name}</h2>
              {selectedIsReply
                ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30">💌 回复粉丝</span>
                : <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border text-violet-500 bg-violet-500/10 border-violet-500/30">🎶 互动涨粉</span>}
              <div className="ml-auto flex gap-2">
                {runningTaskId === selectedTask.id
                  ? <button onClick={stopTask} className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-500 text-white hover:bg-red-600">⏹ 停止</button>
                  : <button onClick={() => runTaskNow(selectedTask)} disabled={running} className={`px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 ${selectedIsReply ? 'bg-fuchsia-500 hover:bg-fuchsia-600' : 'bg-violet-500 hover:bg-violet-600'}`}>{running ? '运行中…' : '🎯 直接运行'}</button>}
                <button onClick={() => { if (!requireLogin()) return; if (selectedIsReply) { setReplyEditId(selectedTask.id); setShowReplyEditModal(true); } else { setTaskEditId(selectedTask.id); setShowTaskEditModal(true); } }} className="px-3 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">编辑</button>
                <button onClick={() => deleteTask(selectedTask)} className="px-3 py-2 rounded-lg text-sm font-medium border border-red-500/40 text-red-500 hover:bg-red-500/5">删除</button>
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5 mb-4">
              <div className="font-semibold dark:text-gray-200 mb-1">📋 任务摘要</div>
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">频率</span><span className="text-gray-800 dark:text-gray-200">{FREQ_LABEL[selectedTask.frequency] || selectedTask.frequency}{selectedTask.frequency !== 'once' && selectedTask.enabled ? ` · 下次 ${fmtTime(selectedTask.nextPlannedRunAt)}` : ''}</span></div>
              {selectedIsReply
                ? <>
                    <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">引流语</span><span className="text-gray-800 dark:text-gray-200 break-all">{selectedTask.funnel?.funnel_phrase ? `"${selectedTask.funnel.funnel_phrase.slice(0, 40)}${selectedTask.funnel.funnel_phrase.length > 40 ? '...' : ''}" · ${selectedTask.funnel.funnel_probability || 0}%` : '（未填,纯 AI 回复）'}</span></div>
                    <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">回复范围</span><span className="text-gray-800 dark:text-gray-200">逐条回复全部粉丝评论（最近 30 个作品）· 同时开窗 {selectedTask.concurrency || 3}</span></div>
                  </>
                : <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">配额/次</span><span className="text-gray-800 dark:text-gray-200">👍 {selectedTask.quota.daily_like_min}-{selectedTask.quota.daily_like_max} · ➕ {selectedTask.quota.daily_follow_min}-{selectedTask.quota.daily_follow_max} · 💬 {selectedTask.quota.daily_comment_min}-{selectedTask.quota.daily_comment_max} · 同时开窗 {selectedTask.concurrency || 3}</span></div>}
              <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 w-20 shrink-0">账号({selectedTask.accountIds.length})</span><span className="text-gray-800 dark:text-gray-200 break-all">{selectedTask.accountIds.map((id) => accounts.find((a) => a.id === id)?.displayName || id).join('、')}</span></div>
            </div>
            {(() => {
              const tr = runs.filter((r) => r.taskId === selectedTask.id);
              const cum = tr.reduce((a, r) => ({ like: a.like + (r.totals?.like || 0), follow: a.follow + (r.totals?.follow || 0), comment: a.comment + (r.totals?.comment || 0) }), { like: 0, follow: 0, comment: 0 });
              const last = tr[0];
              return (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                  {stat('累计完成', selectedIsReply ? `💬 回复 ${cum.comment} 条` : `👍 ${cum.like} · ➕ ${cum.follow} · 💬 ${cum.comment}`)}
                  {stat('累计运行', `${tr.length} 次`)}
                  {stat('上次完成', last ? (selectedIsReply ? `💬 回复 ${last.totals.comment} 条` : `👍 ${last.totals.like} · ➕ ${last.totals.follow} · 💬 ${last.totals.comment}`) : '—')}
                  {stat('上次结果', last ? `成功 ${last.success} · 失败 ${last.failed}` : '—')}
                  {stat('上次运行', last ? fmtTime(last.startedAt) : '尚未运行', () => onNavigate?.('runs'), '查看运行记录 →')}
                  {selectedTask.frequency !== 'once' ? stat('下次运行', selectedTask.enabled ? fmtTime(selectedTask.nextPlannedRunAt) : '已停用') : stat('运行方式', '手动触发')}
                </div>
              );
            })()}
            {(running || Object.keys(items).length > 0) && (
              <div className="rounded-xl border border-green-500/50 bg-green-500/5 p-4 mb-4 noobclaw-running-glow">
                <div className="text-sm font-semibold text-green-600 dark:text-green-400 mb-1">本次运行进度</div>
                {renderProgress(selectedIsReply)}
              </div>
            )}
            <h3 className="text-sm font-bold dark:text-white mb-2">🕑 运行历史</h3>
            <div className="space-y-2">
              {runs.filter((r) => r.taskId === selectedTask.id).slice(0, 20).map((r) => (
                <div key={r.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-xs flex items-center gap-3">
                  <span className="text-gray-500">{fmtTime(r.startedAt)}</span>
                  <span className="text-green-500">成功 {r.success}</span><span className="text-red-500">失败 {r.failed}</span><span className="text-amber-500">跳过 {r.skipped}</span>
                  <span className="ml-auto text-gray-600 dark:text-gray-300">{selectedIsReply ? `💬 回复 ${r.totals.comment} 条` : `👍${r.totals.like} ➕${r.totals.follow} 💬${r.totals.comment}`}</span>
                </div>
              ))}
              {runs.filter((r) => r.taskId === selectedTask.id).length === 0 && <div className="text-xs text-gray-400">还没有运行记录。</div>}
            </div>
          </div>
        )}

        {/* 矩阵涨粉运行记录 —— 对齐老客户端 RunHistoryPage */}
        {screen === 'runs' && (
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold dark:text-white">🕑 矩阵涨粉运行记录</h2>
              <button onClick={reloadRuns} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">刷新</button>
            </div>
            {runs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 p-10 text-center">
                <div className="text-4xl mb-2">📭</div>
                <div className="text-sm text-gray-500 dark:text-gray-400">还没有运行记录。去「我的矩阵涨粉任务」跑一个任务。</div>
              </div>
            ) : (
              <div className="space-y-3">
                {runs.map((r) => {
                  // 运行记录未存任务类型 → 反查当前任务;查不到(任务已删)按 engage 展示。
                  const runIsReply = tasks.find((t) => t.id === r.taskId)?.type === 'reply_fan';
                  return (
                  <div key={r.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300">🎵 {PLATFORM_LABEL[r.platform] || r.platform}</span>
                      {runIsReply && <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30">💌 回复粉丝</span>}
                      <span className="font-medium dark:text-white">{r.taskName}</span>
                      <span className="text-xs text-gray-500">{fmtTime(r.startedAt)}</span>
                      <span className="ml-auto text-xs"><span className="text-green-500">成功 {r.success}</span> · <span className="text-red-500">失败 {r.failed}</span> · <span className="text-amber-500">跳过 {r.skipped}</span></span>
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-300 mb-1">{runIsReply ? `合计 💬 回复 ${r.totals.comment} 条` : `合计 👍 ${r.totals.like} · ➕ ${r.totals.follow} · 💬 ${r.totals.comment}`}</div>
                    <div className="text-[11px] text-gray-400 truncate">{r.items.map((it) => `${it.displayName || it.accountId}(${it.state === 'success' ? '成功' : it.state === 'skipped' ? '跳过' : '失败'})`).join('、')}</div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 应用内确认弹窗(断开 / 移除)—— 不用 window.confirm(Tauri ACL 拦) */}
      {confirmDlg && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmDlg(null)}>
          <div className="w-[34rem] max-w-full rounded-2xl p-7 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg font-semibold mb-3 dark:text-white">{confirmDlg.title}</div>
            <div className="text-sm text-gray-600 dark:text-gray-300 mb-6 leading-relaxed">{confirmDlg.body}</div>
            <div className="flex justify-end gap-2.5">
              <button onClick={() => setConfirmDlg(null)} className="px-4 py-2 text-sm rounded-lg border dark:border-white/15 border-black/15">取消</button>
              <button onClick={() => confirmDlg.onYes()} className={`px-4 py-2 text-sm rounded-lg text-white ${confirmDlg.danger ? 'bg-red-500 hover:bg-red-600' : 'bg-orange-500 hover:bg-orange-600'}`}>{confirmDlg.okText || '确定'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 添加/编辑账号 */}
      {showAdd && (() => {
        // 平台已有号(无论是否关联)→ 新号走 2 步:第 1 步配账号、第 2 步配代理 IP。首个号 / 编辑保持单步。
        const twoStep = !editId && platformAccounts.length >= 1;
        const showAccount = !twoStep || addStep === 1;
        const showProxy = twoStep && addStep === 2;
        const validateStep1 = (): boolean => {
          if (!newName.trim()) { setNotice('请填账号备注名'); return false; }
          if (!newPersona.trim()) { setNotice('请填写人设(自动评论时按这个口吻写)'); return false; }
          return true;
        };
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-[40rem] max-w-full max-h-[88vh] overflow-y-auto rounded-2xl p-6 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10 shadow-xl">
            <div className="flex items-center gap-2 mb-4">
              <div className="text-base font-semibold">{editId ? '编辑账号' : `连接 ${PLATFORM_LABEL[platform]} 账号`}</div>
              {twoStep && <span className="text-xs px-2 py-0.5 rounded-full border border-violet-500/40 text-violet-500 bg-violet-500/5">第 {addStep} / 2 步 · {addStep === 1 ? '配账号' : '配代理 IP'}</span>}
              <button type="button" onClick={() => setShowAdd(false)} aria-label="关闭" title="关闭" className="ml-auto shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>

            {showAccount && (<>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">账号备注名</label>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如:账号1-美食号" className="w-full text-sm px-3 py-2.5 rounded-lg border dark:border-white/15 border-black/15 bg-transparent mb-3" />
              {/* 快手:选账号类型(两端登录互不覆盖,发布用创作者中心、涨粉用主站)。建号时定,编辑不可改。 */}
              {platform === 'kuaishou' && (
                <div className="mb-3">
                  <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">账号类型{editId && <span className="ml-2 font-normal text-gray-400">(建号后不可更改)</span>}</label>
                  <div className="flex gap-2">
                    {KS_SCOPES.map((s) => {
                      const active = editId ? false : newScope === s.key;   // 编辑态不高亮可选,只读展示
                      return (
                        <button key={s.key} disabled={!!editId} onClick={() => setNewScope(s.key)}
                          className={`flex-1 text-xs px-3 py-2 rounded-lg border transition-colors ${editId ? 'opacity-60 cursor-not-allowed border-gray-300 dark:border-gray-700' : active ? 'border-orange-500 bg-orange-500/10 text-orange-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-orange-500/50'}`}>
                          {s.label}{editId && (newScope === s.key ? ' ✓' : '')}
                        </button>
                      );
                    })}
                  </div>
                  {!editId && <div className="text-[11px] text-gray-400 mt-1">{newScope === 'creator' ? '将登录 cp.kuaishou.com,用于视频发布' : '将登录 www.kuaishou.com,用于涨粉互动'}</div>}
                </div>
              )}
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">赛道（必选）<span className="ml-2 font-normal text-gray-400">选完自动带出人设和关键词，可再改</span></label>
              {/* 赛道选择:自绘两列面板替代原生 select(赛道 30+ 项,单列太长,两列更矮)。
                  弹窗容器 overflow-y-auto 会裁绝对定位浮层,故面板用行内展开、随弹窗滚动。 */}
              {(() => { const isPreset = trackPresets.some((t) => t.name === newGroup); return (
              <div className="mb-3">
                <button type="button" onClick={() => setTrackOpen((v) => !v)}
                  className="relative w-full text-left text-sm pl-3 pr-9 py-2.5 rounded-lg border dark:border-white/15 border-black/15 bg-transparent dark:bg-gray-800 cursor-pointer">
                  {isPreset ? newGroup : '自定义 / 其他(自己填人设 + 关键词)'}
                  <svg className={`absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none transition-transform ${trackOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {trackOpen && (
                  <div className="mt-1 grid grid-cols-2 gap-1 p-1 rounded-lg border dark:border-white/15 border-black/15 dark:bg-gray-800 bg-white max-h-72 overflow-y-auto">
                    {trackPresets.map((t) => {
                      const active = t.name === newGroup;
                      return (
                        <button key={t.name} type="button" onClick={() => { pickTrack(t.name); setTrackOpen(false); }}
                          className={`text-left text-sm px-2.5 py-2 rounded-md truncate transition-colors ${active ? 'bg-claude-accent/15 text-claude-accent font-medium' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}>
                          {active ? '✓ ' : ''}{t.name}
                        </button>
                      );
                    })}
                    <button type="button" onClick={() => { pickTrack(''); setTrackOpen(false); }}
                      className={`col-span-2 text-left text-sm px-2.5 py-2 rounded-md transition-colors ${!isPreset ? 'bg-claude-accent/15 text-claude-accent font-medium' : 'hover:bg-black/5 dark:hover:bg-white/10'}`}>
                      {!isPreset ? '✓ ' : ''}自定义 / 其他(自己填人设 + 关键词)
                    </button>
                  </div>
                )}
              </div>
              ); })()}
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">人设<span className="ml-2 font-normal text-gray-400">你是谁、对谁说话、什么口吻</span></label>
              <textarea value={newPersona} onChange={(e) => setNewPersona(e.target.value)} placeholder="如:爱吃会做的美食博主,评论真诚接地气" rows={4} className="w-full text-sm px-3 py-2.5 rounded-lg border dark:border-white/15 border-black/15 bg-transparent mb-3" />
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">关键词<span className="ml-2 font-normal text-gray-400">空格分隔,互动时按这些搜</span></label>
              <textarea value={newKeywords} onChange={(e) => setNewKeywords(e.target.value)} placeholder="如:美食探店 一人食 家常菜" rows={4} className="w-full text-sm px-3 py-2.5 rounded-lg border dark:border-white/15 border-black/15 bg-transparent mb-4" />
            </>)}

            {showProxy && (<>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300 leading-relaxed mb-4">
                ⚠️ 本平台已有账号。建议给这个新号配一个<strong>独立代理 IP</strong>:不配的话,它会和本平台其它号<strong>共用同一个本机 IP</strong>,多个号同 IP 容易被平台判定关联、有<strong>被风控/封号</strong>的风险。确实没有代理也可<strong>留空直接保存</strong>。{proxyPurchaseUrl && (<> 没有代理?<button type="button" onClick={() => { try { (window as any).electron?.shell?.openExternal(proxyPurchaseUrl); } catch { /* ignore */ } }} className="underline font-semibold hover:opacity-80">前往购买 →</button></>)}
              </div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">代理 IP（可选）</label>
              <div className="flex gap-2 mb-2">
                <select value={proxyForm.protocol} onChange={(e) => setProxyForm((f) => ({ ...f, protocol: e.target.value }))} className="text-sm px-2 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent dark:bg-gray-800">
                  <option value="socks5">socks5</option>
                  <option value="socks5h">socks5h</option>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
                <input value={proxyForm.host} onChange={(e) => setProxyForm((f) => ({ ...f, host: e.target.value }))} placeholder="host(如 1.2.3.4)" className="flex-1 min-w-0 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
                <input value={proxyForm.port} onChange={(e) => setProxyForm((f) => ({ ...f, port: e.target.value.replace(/[^0-9]/g, '') }))} placeholder="port" className="w-20 text-sm px-2 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
              </div>
              <div className="flex gap-2 mb-2">
                <input value={proxyForm.username} onChange={(e) => setProxyForm((f) => ({ ...f, username: e.target.value }))} placeholder="用户名(可选)" className="flex-1 min-w-0 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
                <input value={proxyForm.password} onChange={(e) => setProxyForm((f) => ({ ...f, password: e.target.value }))} placeholder="密码(可选)" className="flex-1 min-w-0 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
              </div>
              <input value={proxyForm.geo} onChange={(e) => setProxyForm((f) => ({ ...f, geo: e.target.value }))} placeholder="归属地标注(可选,仅显示用)" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-4" />
            </>)}

            {proxyMsg && showProxy && (<div className={`text-xs whitespace-pre-line mb-2 ${proxyMsg.kind === 'ok' ? 'text-green-500' : proxyMsg.kind === 'checking' ? 'text-gray-400' : proxyMsg.kind === 'warn' ? 'text-amber-500' : 'text-red-500'}`}>{proxyMsg.text}</div>)}
            <div className="flex justify-end gap-2">
              {twoStep && addStep === 2
                ? <button onClick={() => setAddStep(1)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">← 上一步</button>
                : <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">取消</button>}
              {pendingProxySave && (<button onClick={() => pendingProxySave()} className="px-3 py-1.5 text-sm rounded-lg border border-red-500/60 text-red-500">仍然保存</button>)}
              {editId
                ? <button onClick={() => confirmAdd(false)} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">保存</button>
                : (twoStep && addStep === 1)
                  ? <button onClick={() => { if (validateStep1()) { setNotice(''); setAddStep(2); } }} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">下一步 →</button>
                  : (<><button onClick={() => confirmAdd(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">{showProxy ? '不配代理,仅保存' : '仅保存'}</button><button onClick={() => confirmAdd(true)} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white">保存并连接</button></>)}
            </div>
          </div>
        </div>
        );
      })()}

      {/* 编辑互动任务弹窗(详情页用)—— 同一个向导 */}
      {showTaskEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto">
          <MatrixTaskWizard
            platformLabel={PLATFORM_LABEL[platform]}
            platform={platform}
            accounts={platformAccounts as any}
            initialTask={tasks.find((t) => t.id === taskEditId) || null}
            onCancel={() => { setShowTaskEditModal(false); setTaskEditId(null); }}
            onSave={saveTaskFromWizard}
          />
        </div>
      )}
      {/* 编辑回复粉丝任务弹窗(详情页用) */}
      {showReplyEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 overflow-auto">
          <MatrixReplyFansWizard
            platformLabel={PLATFORM_LABEL[platform]}
            platform={platform}
            accounts={platformAccounts as any}
            initialTask={tasks.find((t) => t.id === replyEditId) || null}
            onCancel={() => { setShowReplyEditModal(false); setReplyEditId(null); }}
            onSave={saveTaskFromReplyWizard}
          />
        </div>
      )}

      {/* 内核下载 */}
      {showKernelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[26rem] rounded-xl p-5 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
            <div className="flex items-center mb-1">
              <div className="text-sm font-medium">指纹浏览器</div>
              <button type="button" onClick={() => setShowKernelModal(false)} aria-label="关闭" title="关闭" className="ml-auto shrink-0 -mr-1 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            {kernelReady && !kernelBusy ? (
              <div className="text-sm text-green-500 my-3">✓ 指纹浏览器已就绪{selectedVersion ? `(v${selectedVersion})` : ''},现在可以连接账号 / 扫码连接 / 跑任务了。</div>
            ) : (
              <>
                <div className="text-sm opacity-70 my-3">矩阵号需要专属指纹浏览器才能运行(独立指纹隔离,普通 Chrome 无法替代)。请下载并选中一个版本{selectedVersion ? `(将下载 v${selectedVersion})` : ''}。约 130MB,只需下载一次。</div>
                {(kernelBusy || kernelPct > 0) && (
                  <div className="mb-3"><div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div className="h-full bg-claude-accent transition-all duration-200" style={{ width: `${Math.max(2, kernelPct)}%` }} /></div><div className="text-xs opacity-60 mt-1">{kernelMsg || '准备中…'}{kernelBusy ? ` · ${kernelPct}%` : ''}</div></div>
                )}
                {!kernelBusy && kernelMsg && !kernelReady && <div className="text-xs text-red-500 mb-2">{kernelMsg}</div>}
              </>
            )}
            <div className="flex justify-end gap-2 mt-2">
              <button onClick={() => setShowKernelModal(false)} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">关闭</button>
              {!kernelReady && <button onClick={() => downloadKernel()} disabled={kernelBusy} className="px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white disabled:opacity-50">{kernelBusy ? '下载中…' : (kernelPct > 0 ? '重试下载' : '开始下载')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* 代理 */}
      {proxyFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[26rem] rounded-xl p-5 dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10">
            <div className="flex items-center mb-1">
              <div className="text-sm font-medium">绑定代理 IP</div>
              <button type="button" onClick={() => { setProxyFor(null); setProxyMsg(null); setPendingProxySave(null); }} aria-label="关闭" title="关闭" className="ml-auto shrink-0 -mr-1 w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="text-xs opacity-60 mb-3">多开同平台必须每号一个独立 IP,否则同 IP 会被风控。第一个号可留空走本地 IP。{proxyPurchaseUrl && (<> 没有代理?<button type="button" onClick={() => { try { (window as any).electron?.shell?.openExternal(proxyPurchaseUrl); } catch { /* ignore */ } }} className="text-claude-accent hover:underline font-medium">前往购买 →</button></>)}</div>
            <div className="flex gap-2 mb-2">
              <select value={proxyForm.protocol} onChange={(e) => setProxyForm((f) => ({ ...f, protocol: e.target.value }))} className="text-sm px-2 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent">
                <option value="socks5">socks5</option><option value="socks5h">socks5h</option><option value="http">http</option><option value="https">https</option>
              </select>
              <input value={proxyForm.host} onChange={(e) => setProxyForm((f) => ({ ...f, host: e.target.value }))} placeholder="host(如 1.2.3.4)" className="flex-1 min-w-0 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
              <input value={proxyForm.port} onChange={(e) => setProxyForm((f) => ({ ...f, port: e.target.value.replace(/[^0-9]/g, '') }))} placeholder="port" className="w-20 text-sm px-2 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
            </div>
            <div className="flex gap-2 mb-2">
              <input value={proxyForm.username} onChange={(e) => setProxyForm((f) => ({ ...f, username: e.target.value }))} placeholder="用户名(可选)" className="flex-1 min-w-0 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
              <input value={proxyForm.password} onChange={(e) => setProxyForm((f) => ({ ...f, password: e.target.value }))} placeholder="密码(可选)" className="flex-1 min-w-0 text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent" />
            </div>
            <input value={proxyForm.geo} onChange={(e) => setProxyForm((f) => ({ ...f, geo: e.target.value }))} placeholder="归属地标注(可选,仅显示用)" className="w-full text-sm px-3 py-2 rounded border dark:border-white/15 border-black/15 bg-transparent mb-3" />
            {proxyMsg && (<div className={`text-xs whitespace-pre-line mb-2 ${proxyMsg.kind === 'ok' ? 'text-green-500' : proxyMsg.kind === 'checking' ? 'text-gray-400' : proxyMsg.kind === 'warn' ? 'text-amber-500' : 'text-red-500'}`}>{proxyMsg.text}</div>)}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setProxyFor(null); setProxyMsg(null); setPendingProxySave(null); }} className="px-3 py-1.5 text-sm rounded-lg border dark:border-white/15 border-black/15">取消</button>
              {pendingProxySave && (<button onClick={() => pendingProxySave()} className="px-3 py-1.5 text-sm rounded-lg border border-red-500/60 text-red-500">仍然保存</button>)}
              <button onClick={saveProxy} disabled={proxyBusy} className={`px-3 py-1.5 text-sm rounded-lg bg-claude-accent text-white ${proxyBusy ? 'opacity-60 cursor-wait' : ''}`}>{proxyBusy ? '校验中…' : '校验并保存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MatrixView;
