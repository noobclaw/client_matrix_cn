/**
 * TaskDetailPage — two-mode layout (idle vs running).
 *
 * State management is simple:
 * - On mount: ask sidecar "is anything running?" → set running state
 * - User clicks "直接运行": ask sidecar → if nothing running, start + set running=true
 * - Poll every 2s: fetch progress logs (for display only, NOT for running state)
 * - When IPC returns (task done): set running=false + show toast
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { scenarioService, type Task, type Draft, type Scenario } from '../../services/scenario';
import { LoginRequiredModal } from './LoginRequiredModal';
import { MATRIX_EDITION } from '../../matrixEdition';
import { noobClawAuth } from '../../services/noobclawAuth';
import { i18nService } from '../../services/i18n';
import { friendlyRunError } from '../../services/runErrorMessage';
import type { ScenarioRunProgress } from '../../types/scenario';
import LuckyBag from '../cowork/LuckyBag';
import { ErrorBoundary } from '../ErrorBoundary';
import { FALLBACK_IMAGE_STYLES } from '../../services/imageStyles';

// v4.28.x: 之前只放了 XHS tracks,Twitter / Binance 的 web3_* track 没法在
// detail 页面被翻译,会回落到原始 ID(如 'web3_alpha'),用户看到「人设: web3_alpha」。
// MyTasksPage 列表那边的 TRACK_ICONS 是全的所以没问题,这里补齐 web3 系列保持一致。
const TRACK_NAMES: Record<string, string> = {
  // Twitter / Binance (web3) tracks
  web3_alpha: '🎯 Web3 · Alpha 猎人',
  web3_defi: '🏛️ Web3 · DeFi 用户',
  web3_meme: '🎪 Web3 · Meme 文化',
  web3_builder: '🛠️ Web3 · 建设者',
  web3_zh_kol: '📢 Web3 · 通用 KOL',
  // XHS tracks
  career_side_hustle: '💼 副业 · 打工人赚钱',
  indie_dev: '👩‍💻 独立开发 · 程序员记录',
  personal_finance: '💰 理财 · 记账攻略',
  travel: '✈️ 旅行 · 攻略分享',
  food: '🍲 美食 · 探店做饭',
  outfit: '👗 穿搭 · 风格分享',
  beauty: '💄 美妆 · 产品测评',
  fitness: '💪 健身 · 减脂日记',
  reading: '📚 读书 · 书单笔记',
  parenting: '🧸 育儿 · 亲子日常',
  exam_prep: '🎓 考研 · 备考党',
  pets: '🐱 宠物 · 猫狗日常',
  home_decor: '🏠 家居 · 小屋布置',
  study_method: '🏆 学习 · 效率工具',
  career_growth: '🎯 职场 · 升级打怪',
  emotional_wellness: '🧘 情感 · 心理疗愈',
  photography: '📷 摄影 · 日常记录',
  crafts: '🎨 手工 · DIY',
};

function formatRelative(ts: number | null | undefined, isZh: boolean): string {
  if (!ts) return isZh ? '尚未运行' : 'Not run yet';
  const diff = Date.now() - ts;
  const mins = Math.round(Math.abs(diff) / 60_000);
  if (mins < 1) return isZh ? '刚刚' : 'Just now';
  if (mins < 60) return isZh ? `${mins} 分钟前` : `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return isZh ? `${hrs} 小时前` : `${hrs} hr ago`;
  return isZh ? `${Math.round(hrs / 24)} 天前` : `${Math.round(hrs / 24)} d ago`;
}

const STEP_LABELS_ZH = ['步骤一', '步骤二', '步骤三', '步骤四'];
const STEP_LABELS_EN = ['Step 1', 'Step 2', 'Step 3', 'Step 4'];

// CSS for typing blink animation
const typingStyle = document.createElement('style');
typingStyle.textContent = `
  .typing-animation {
    display: inline;
  }
  .typing-animation::after {
    content: '▌';
    animation: blink 1s step-end infinite;
    color: #22c55e;
    margin-left: 2px;
  }
  @keyframes blink {
    50% { opacity: 0; }
  }
`;
if (!document.getElementById('typing-anim-style')) {
  typingStyle.id = 'typing-anim-style';
  document.head.appendChild(typingStyle);
}

// Step-log container with smart auto-scroll. Auto-scrolls to bottom only
// while the user is already pinned at the bottom. The moment they drag the
// scrollbar up to read older messages we release the auto-scroll so new
// log lines don't yank them back down. Coming back to the bottom (scroll
// down past the threshold) re-engages auto-scroll.
const StepLogBox: React.FC<{
  logs: Array<{ time: string; status: string; message: string }>;
  isActive: boolean;
  renderLogMessage: (m: string) => React.ReactNode;
}> = ({ logs, isActive, renderLogMessage }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // stickToBottom: true means we should auto-scroll on new logs. Defaults to
  // true (initial render lands at the bottom — newest log visible) and only
  // flips to false once the user scrolls up past the threshold.
  const stickRef = useRef(true);
  const NEAR_BOTTOM_THRESHOLD = 24; // px slack so a 1-2px reflow jitter doesn't release sticky

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickRef.current && isActive) {
      el.scrollTop = el.scrollHeight;
    }
    // Note: we deliberately depend on logs.length (and message identity) so
    // typing-animation re-renders of the last running line don't trigger
    // an extra scroll — only new entries do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs.length, isActive]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD;
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="overflow-y-auto p-3 space-y-1"
      style={{ maxHeight: '160px' }}
    >
      {logs.map((log, li) => {
        const isLast = li === logs.length - 1 && isActive;
        return (
          <div key={li} className="text-xs flex items-start gap-2">
            <span className={`shrink-0 font-medium ${
              log.status === 'done' ? 'text-green-500' : log.status === 'error' ? 'text-red-500' : 'text-amber-500'
            }`}>
              {log.status === 'done' ? '✓' : log.status === 'error' ? '✗' : '›'}
            </span>
            <span className={`flex-1 ${log.status === 'done' ? 'text-gray-500 dark:text-gray-400' : 'dark:text-gray-300'}`}>
              {isLast && log.status === 'running' ? (
                <span className="typing-animation">{renderLogMessage(log.message)}</span>
              ) : (
                renderLogMessage(log.message)
              )}
            </span>
            <span className="text-gray-500 dark:text-gray-600 shrink-0 tabular-nums text-[10px]">{log.time}</span>
          </div>
        );
      })}
    </div>
  );
};

// Render log message — make file paths clickable
function renderLogMessage(message: string) {
  // Match paths like /Users/.../NoobClaw/... or C:\Users\...\NoobClaw\...
  const pathMatch = message.match(/(→\s*)([/\\].*NoobClaw[/\\][^\s]*|[A-Z]:[/\\].*NoobClaw[/\\][^\s]*)/);
  if (pathMatch) {
    const before = message.slice(0, message.indexOf(pathMatch[0]));
    const arrow = pathMatch[1];
    const filePath = pathMatch[2];
    // 去掉文件名 = 所在目录(保留原始分隔符:Windows \ / macOS·Linux /)
    const sep = filePath.includes('\\') ? '\\' : '/';
    const dirPath = filePath.slice(0, filePath.lastIndexOf(sep)) || filePath;
    const openDirLabel = i18nService.currentLanguage === 'zh' ? '打开目录' : 'Open folder';
    return (
      <>
        {before}{arrow}
        {/* 点文件路径 → openPath(文件) = 用默认应用打开/播放视频 */}
        <button
          type="button"
          className="text-blue-500 hover:underline cursor-pointer break-all"
          title={filePath}
          onClick={() => { try { window.electron?.shell?.openPath?.(filePath); } catch {} }}
        >
          📂 {filePath.split(/[/\\]/).slice(-3).join('/')}
        </button>
        {/* 点"打开目录" → openPath(去掉文件名的目录) = 用 Finder/Explorer 打开文件夹 */}
        <button
          type="button"
          className="ml-2 text-blue-500 hover:underline cursor-pointer shrink-0"
          title={dirPath}
          onClick={() => { try { window.electron?.shell?.openPath?.(dirPath); } catch {} }}
        >
          📁 {openDirLabel}
        </button>
      </>
    );
  }
  return message;
}
const STEP_NAMES_ZH = [
  '采集爆款文章。请勿切换浏览器标签页。',
  'AI 改写标题和内容，保存到本地',
  'AI 生成图片，保存到本地',
  '上传到小红书草稿箱。请勿切换浏览器标签页。',
];
const STEP_NAMES_EN = [
  'Scrape trending articles. Do not switch browser tabs.',
  'AI rewrites titles & content, saved locally',
  'AI generates images, saved locally',
  'Upload to Xiaohongshu drafts. Do not switch browser tabs.',
];
// XHS Auto-reply: 3 steps. Step 2 contains the entire per-article loop
// v2.4.89: 所有步骤标题用**用户视角**的大白话,不再暴露内部实现细节
// (selector / retry / model name / CSP / React state 这些全藏起来)
const STEP_NAMES_AUTOREPLY_ZH = [
  '挑选要回复的文章',
  '逐篇生成评论并发布',
  '保存本次报告到本地',
];
const STEP_NAMES_AUTOREPLY_EN = [
  'Pick articles to reply to',
  'Generate and post comments per article',
  'Save this run report to disk',
];
// XHS 回复粉丝评论 4 步 — 跟 orchestrator.js 里的 stepLog 阶段对齐:
//   STEP 1: 抓创作者中心笔记列表
//   STEP 2: 探测当前登录用户 uid (去重判定用)
//   STEP 3: 逐篇笔记进详情页 + AI 生成回复 + 发送
//   STEP 4: 汇总报告
const STEP_NAMES_XHS_REPLY_FANS_ZH = [
  '进入创作者中心，读取你的笔记列表',
  '打开笔记，自动回复粉丝评论',
  '保存本次报告',
];
const STEP_NAMES_XHS_REPLY_FANS_EN = [
  'Enter Creator Center, read your notes list',
  'Open notes and auto-reply fan comments',
  'Save run report',
];
const STEP_NAMES_DOUYIN_REPLY_FANS_ZH = [
  '进入抖音创作者中心评论管理，选择作品',
  '逐条回复粉丝评论（只回粉丝，绝不评论作品本身）',
  '保存本次报告',
];
const STEP_NAMES_DOUYIN_REPLY_FANS_EN = [
  'Enter Douyin Comment Management, pick a work',
  'Reply fan comments (fans only, never the video itself)',
  'Save run report',
];
const STEP_NAMES_X_AUTO_ENGAGE_ZH = [
  '准备本次动作清单',
  '逐个执行关注 / 回复 / 点赞',
  '保存本次报告到本地',
];
const STEP_NAMES_X_AUTO_ENGAGE_EN = [
  'Plan this run',
  'Execute follow / reply / like one by one',
  'Save this run report to disk',
];
const STEP_NAMES_X_POST_CREATOR_ZH = [
  '准备素材',
  '生成推文并发布',
  '保存本次报告到本地',
];
const STEP_NAMES_X_POST_CREATOR_EN = [
  'Prepare material',
  'Generate and post the tweet',
  'Save this run report to disk',
];
// v5.x+: 4 步,跟 binance_from_x_link 同款"按条端到端"结构 — 每条 URL 独立
// 走完读源/仿写/发推三步,UI 进度条逐步推进。报告步落到第 4 步。
const STEP_NAMES_X_LINK_REWRITE_ZH = [
  '打开链接读取原推',
  'AI 改写 + 准备配图/视频',
  '发布到推特',
  '保存本次报告到本地',
];
const STEP_NAMES_X_LINK_REWRITE_EN = [
  'Open URL & read source tweet',
  'AI rewrite + prep images/video',
  'Post to X',
  'Save this run report to disk',
];
const STEP_NAMES_BINANCE_AUTO_ENGAGE_ZH = [
  '准备本次动作清单',
  '逐个执行关注 / 回复 / 点赞',
  '保存本次报告到本地',
];
const STEP_NAMES_BINANCE_AUTO_ENGAGE_EN = [
  'Plan this run',
  'Execute follow / reply / like one by one',
  'Save this run report to disk',
];
const STEP_NAMES_BINANCE_POST_CREATOR_ZH = [
  '选题(token + 方向)',
  'AI 生成内容',
  '打开发帖框 + 写入内容',
  '发布',
];
const STEP_NAMES_BINANCE_POST_CREATOR_EN = [
  'Pick topic (token + angle)',
  'AI generates the post',
  'Open composer and write',
  'Publish',
];
const STEP_NAMES_BINANCE_FROM_X_REPOST_ZH = [
  '校验双平台 + 从推特挑爆款',
  'AI 改写 + 下载原图/视频',
  '写入币安编辑器 + 上传原图/视频',
  '发布到币安广场',
];
const STEP_NAMES_BINANCE_FROM_X_REPOST_EN = [
  'Verify both tabs + pick viral tweet',
  'AI rewrite + download images/video',
  'Write to Binance + upload images/video',
  'Publish to Binance Square',
];
// v6.x: 3 个 source-viral 搬运 — 流程跟 X repost 完全一致,只换"推特"→源平台
const STEP_NAMES_BINANCE_FROM_XHS_VIRAL_ZH = [
  '校验双平台 + 从小红书挑爆款',
  'AI 改写 + 下载原图/视频',
  '写入币安编辑器 + 上传原图/视频',
  '发布到币安广场',
];
const STEP_NAMES_BINANCE_FROM_XHS_VIRAL_EN = [
  'Verify both tabs + pick viral post from Xiaohongshu',
  'AI rewrite + download images/video',
  'Write to Binance + upload images/video',
  'Publish to Binance Square',
];
const STEP_NAMES_BINANCE_FROM_DOUYIN_VIRAL_ZH = [
  '校验双平台 + 从抖音挑爆款',
  'AI 改写 + 下载原图/视频',
  '写入币安编辑器 + 上传原图/视频',
  '发布到币安广场',
];
const STEP_NAMES_BINANCE_FROM_DOUYIN_VIRAL_EN = [
  'Verify both tabs + pick viral post from Douyin',
  'AI rewrite + download images/video',
  'Write to Binance + upload images/video',
  'Publish to Binance Square',
];
const STEP_NAMES_BINANCE_FROM_TIKTOK_VIRAL_ZH = [
  '校验双平台 + 从 TikTok 挑爆款',
  'AI 改写 + 下载原图/视频',
  '写入币安编辑器 + 上传原图/视频',
  '发布到币安广场',
];
const STEP_NAMES_BINANCE_FROM_TIKTOK_VIRAL_EN = [
  'Verify both tabs + pick viral post from TikTok',
  'AI rewrite + download images/video',
  'Write to Binance + upload images/video',
  'Publish to Binance Square',
];
const STEP_NAMES_YOUTUBE_AUTO_ENGAGE_ZH = [
  '打开 YouTube 首页 → 搜索关键词 → 采集候选视频',
  '逐个进视频执行点赞 / 订阅 / 评论',
  '保存本次报告到本地',
];
const STEP_NAMES_YOUTUBE_AUTO_ENGAGE_EN = [
  'Open YouTube home → search keyword → collect candidate videos',
  'Open each video, execute like / subscribe / comment',
  'Save this run report to disk',
];
const STEP_NAMES_TIKTOK_AUTO_ENGAGE_ZH = [
  '打开 TikTok 首页 → 搜索关键词 → 采集候选视频',
  '逐个进视频执行点赞 / 关注 / 评论',
  '保存本次报告到本地',
];
const STEP_NAMES_TIKTOK_AUTO_ENGAGE_EN = [
  'Open TikTok home → search keyword → collect candidate videos',
  'Open each video, execute like / follow / comment',
  'Save this run report to disk',
];
const STEP_NAMES_DOUYIN_AUTO_ENGAGE_ZH = [
  '打开抖音首页 → 搜索关键词 → 采集候选视频',
  '逐个进视频执行点赞 / 关注 / 评论',
  '保存本次报告到本地',
];
const STEP_NAMES_DOUYIN_AUTO_ENGAGE_EN = [
  'Open Douyin home → search keyword → collect candidate videos',
  'Open each video, execute like / follow / comment',
  'Save this run report to disk',
];
const STEP_NAMES_DOUYIN_IMAGE_TEXT_ZH = [
  'AI根据参考文案创作文章。请勿切换浏览器标签页。',
  'AI 改写为抖音图文笔记，保存到本地',
  'AI 生成封面图 + 内容图',
  '上传到抖音创作者中心并发布。请勿切换浏览器标签页。',
];
const STEP_NAMES_DOUYIN_IMAGE_TEXT_EN = [
  'AI composes article from reference text. Do not switch browser tabs.',
  'AI rewrite saved locally as Douyin image-text note',
  'AI generates cover + content images',
  'Upload to Douyin creator center & publish. Do not switch browser tabs.',
];
// 视频号图文 = 4 步,镜像抖音结构但落地视频号助手(channels.weixin.qq.com),
// 平台名独立、绝不串台「抖音/小红书」字样。
const STEP_NAMES_SHIPINHAO_IMAGE_TEXT_ZH = [
  'AI 根据灵感段创作视频号图文。请勿切换浏览器标签页。',
  'AI 改写为视频号图文，保存到本地',
  'AI 生成内容图，保存到本地',
  '发表到视频号助手（存草稿 / 发布）。请勿切换浏览器标签页。',
];
const STEP_NAMES_SHIPINHAO_IMAGE_TEXT_EN = [
  'AI composes WeChat Channels image-text from inspiration. Do not switch browser tabs.',
  'AI rewrite saved locally as WeChat Channels image-text',
  'AI generates content images, saved locally',
  'Publish to WeChat Channels assistant (draft / publish). Do not switch browser tabs.',
];
// 头条号「微头条」= 4 步(v1.1.0 起接了 AI 生图 + 上传):创作→改写→生图→发布 → mp.toutiao.com。
const STEP_NAMES_TOUTIAO_IMAGE_TEXT_ZH = [
  'AI 根据灵感段创作微头条。请勿切换浏览器标签页。',
  'AI 改写为微头条正文，保存到本地',
  'AI 生成内容图，保存到本地',
  '发布到头条号（微头条，上传图 + 正文，存草稿 / 发布）。请勿切换浏览器标签页。',
];
const STEP_NAMES_TOUTIAO_IMAGE_TEXT_EN = [
  'AI composes a Toutiao weitoutiao post from inspiration. Do not switch browser tabs.',
  'AI rewrite saved locally as Toutiao weitoutiao body',
  'AI generates content images, saved locally',
  'Publish to Toutiao (weitoutiao: upload images + body, draft / publish). Do not switch browser tabs.',
];
const STEP_NAMES_BINANCE_FROM_X_LINK_ZH = [
  '校验双平台 + 打开链接读取原推',
  'AI 改写为币安风格 + 下载原图/视频',
  '切到币安 · 写入正文 + 上传原图/视频',
  '发布到币安广场',
];
const STEP_NAMES_BINANCE_FROM_X_LINK_EN = [
  'Verify both tabs + open URL & read source tweet',
  'AI rewrite into Binance style + download images/video',
  'Switch to Binance · write content + upload images/video',
  'Publish to Binance Square',
];
// 视频无水印下载(小红书 / 抖音)—— 2 步,跟 orchestrator 的 stepStart(1/2) 对齐:
//   STEP 1: 打开主站 + 校验登录
//   STEP 2: 逐个链接解析 + 下载无水印视频到本地
const STEP_NAMES_XHS_VIDEO_DOWNLOAD_ZH = [
  '打开小红书并校验登录',
  '逐个解析并下载无水印视频到本地',
];
const STEP_NAMES_XHS_VIDEO_DOWNLOAD_EN = [
  'Open Xiaohongshu & verify login',
  'Resolve & download watermark-free videos locally, one by one',
];
const STEP_NAMES_DOUYIN_VIDEO_DOWNLOAD_ZH = [
  '打开抖音并校验登录',
  '逐个解析并下载无水印视频到本地',
];
const STEP_NAMES_DOUYIN_VIDEO_DOWNLOAD_EN = [
  'Open Douyin & verify login',
  'Resolve & download watermark-free videos locally, one by one',
];
const STEP_NAMES_TIKTOK_VIDEO_DOWNLOAD_ZH = [
  '打开 TikTok 并校验登录',
  '逐个解析并下载无水印视频到本地',
];
const STEP_NAMES_TIKTOK_VIDEO_DOWNLOAD_EN = [
  'Open TikTok & verify login',
  'Resolve & download watermark-free videos locally, one by one',
];

// 快手 / 哔哩哔哩 与抖音流程同构,仅平台名 / 动作集不同。早期为省事直接复用抖音的步骤名
// 常量,把「抖音」字样串台到快手/B站的任务详情页(用户实拍)。改用工厂按各自平台名生成纯
// 展示步骤名(scenario.id 仍各自独立)。
const engageStepNames = (isZh: boolean, homeZh: string, homeEn: string, actsZh: string, actsEn: string): string[] =>
  isZh
    ? [`打开${homeZh}首页 → 搜索关键词 → 采集候选视频`, `逐个进视频执行${actsZh}`, '保存本次报告到本地']
    : [`Open ${homeEn} home → search keyword → collect candidate videos`, `Open each video, execute ${actsEn}`, 'Save this run report to disk'];
const replyStepNames = (isZh: boolean, centerZh: string, centerEn: string): string[] =>
  isZh
    ? [`进入${centerZh}评论管理，选择作品`, '逐条回复粉丝评论（只回粉丝，绝不评论作品本身）', '保存本次报告']
    : [`Enter ${centerEn} comment management, pick a work`, 'Reply fan comments (fans only, never the video itself)', 'Save run report'];
const videoDownloadStepNames = (isZh: boolean, nameZh: string, nameEn: string): string[] =>
  isZh
    ? [`打开${nameZh}并校验登录`, '逐个解析并下载无水印视频到本地']
    : [`Open ${nameEn} & verify login`, 'Resolve & download watermark-free videos locally, one by one'];

interface Props {
  task: Task;
  scenario: Scenario | null;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void | Promise<void>;
  /** Navigate to the Run History page filtered to this task's id.
   *  Wired up by ScenarioView. Optional so the renderer can no-op if
   *  history isn't available in the current view context. */
  onOpenHistory?: () => void;
}

export const TaskDetailPage: React.FC<Props> = ({ task, scenario, onBack, onEdit, onChanged, onOpenHistory }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  // 链接模式是一次性手动运行，没有"下次运行"的概念
  const isLinkModeForStats = task.track === 'link_mode'
    || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
  // Auto-reply tasks have a different step narrative and don't produce
  // local drafts (replies post directly), so the upload-mode badge and
  // the manual-upload step variant don't apply to them.
  // "Reply directly to platform" tasks: no local-draft mode, only run log to view.
  //   - auto_reply: like / comment / follow on already-published content
  //   - xhs_reply_fans_comment: AI-replies fan comments on user's own notes
  // Excludes creator scenarios (xhs_viral / douyin_image_text) which DO have
  // a draft / local-save mode.
  const isAutoReplyTask =
    (scenario?.workflow_type as any) === 'auto_reply' ||
    scenario?.id === 'xhs_reply_fans_comment' ||
    scenario?.id === 'douyin_reply_fans_comment';
  // 打开本任务输出目录(报告 / 草稿 / 图片)。头部链接 + 醒目按钮 + 运行明细大按钮共用。
  const openTaskDir = async () => {
    try {
      const res = await window.electron?.scenario?.getTaskDir?.(task.id);
      const dir = typeof res === 'string' ? res : res?.dir;
      if (dir) window.electron?.shell?.openPath?.(dir);
    } catch { /* ignore */ }
  };
  // Platform detection — used for badge / step copy on the task detail page.
  // For Twitter scenarios (x_auto_engage / x_post_creator / x_link_rewrite)
  // we can't reuse XHS-specific copy like "直接发布到小红书".
  const isXTask = scenario?.platform === 'x';
  const isBinanceTask = scenario?.platform === 'binance';
  const platformLabelForTask = isXTask
    ? 'Twitter'
    : isBinanceTask
      ? (isZh ? '币安广场' : 'Binance Square')
      : (scenario?.platform as any) === 'youtube'
        ? 'YouTube'
        : (scenario?.platform as any) === 'tiktok'
          ? 'TikTok'
          : (scenario?.platform as any) === 'douyin'
            ? (isZh ? '抖音' : 'Douyin')
            : (scenario?.platform as any) === 'kuaishou'
              ? (isZh ? '快手' : 'Kuaishou')
              : (scenario?.platform as any) === 'bilibili'
                ? (isZh ? '哔哩哔哩' : 'Bilibili')
                : (scenario?.platform as any) === 'shipinhao'
                  ? (isZh ? '视频号' : 'WeChat Channels')
                  : (scenario?.platform as any) === 'toutiao'
                    ? (isZh ? '头条号' : 'Toutiao')
                    : (scenario?.platform as any) === 'video'
                      ? (isZh ? '视频搬运·二创' : 'Video Remix')
                      : (isZh ? '小红书' : 'Xiaohongshu');
  const STEP_LABELS = isZh ? STEP_LABELS_ZH : STEP_LABELS_EN;
  // Pick step names by scenario id first (Twitter has 3 distinct flavors),
  // then fall back to the legacy isAutoReply branch for XHS.
  const STEP_NAMES = (() => {
    const sid = scenario?.id;
    if (sid === 'x_auto_engage') return isZh ? STEP_NAMES_X_AUTO_ENGAGE_ZH : STEP_NAMES_X_AUTO_ENGAGE_EN;
    if (sid === 'x_post_creator') return isZh ? STEP_NAMES_X_POST_CREATOR_ZH : STEP_NAMES_X_POST_CREATOR_EN;
    if (sid === 'x_link_rewrite') return isZh ? STEP_NAMES_X_LINK_REWRITE_ZH : STEP_NAMES_X_LINK_REWRITE_EN;
    if (sid === 'binance_square_auto_engage') return isZh ? STEP_NAMES_BINANCE_AUTO_ENGAGE_ZH : STEP_NAMES_BINANCE_AUTO_ENGAGE_EN;
    if (sid === 'binance_square_post_creator') return isZh ? STEP_NAMES_BINANCE_POST_CREATOR_ZH : STEP_NAMES_BINANCE_POST_CREATOR_EN;
    if (sid === 'binance_from_x_repost') return isZh ? STEP_NAMES_BINANCE_FROM_X_REPOST_ZH : STEP_NAMES_BINANCE_FROM_X_REPOST_EN;
    if (sid === 'binance_from_x_link') return isZh ? STEP_NAMES_BINANCE_FROM_X_LINK_ZH : STEP_NAMES_BINANCE_FROM_X_LINK_EN;
    if (sid === 'binance_from_xhs_viral') return isZh ? STEP_NAMES_BINANCE_FROM_XHS_VIRAL_ZH : STEP_NAMES_BINANCE_FROM_XHS_VIRAL_EN;
    if (sid === 'binance_from_douyin_viral') return isZh ? STEP_NAMES_BINANCE_FROM_DOUYIN_VIRAL_ZH : STEP_NAMES_BINANCE_FROM_DOUYIN_VIRAL_EN;
    if (sid === 'binance_from_tiktok_viral') return isZh ? STEP_NAMES_BINANCE_FROM_TIKTOK_VIRAL_ZH : STEP_NAMES_BINANCE_FROM_TIKTOK_VIRAL_EN;
    if (sid === 'youtube_auto_engage') return isZh ? STEP_NAMES_YOUTUBE_AUTO_ENGAGE_ZH : STEP_NAMES_YOUTUBE_AUTO_ENGAGE_EN;
    if (sid === 'tiktok_auto_engage') return isZh ? STEP_NAMES_TIKTOK_AUTO_ENGAGE_ZH : STEP_NAMES_TIKTOK_AUTO_ENGAGE_EN;
    if (sid === 'douyin_auto_engage') return isZh ? STEP_NAMES_DOUYIN_AUTO_ENGAGE_ZH : STEP_NAMES_DOUYIN_AUTO_ENGAGE_EN;
    if (sid === 'douyin_image_text') return isZh ? STEP_NAMES_DOUYIN_IMAGE_TEXT_ZH : STEP_NAMES_DOUYIN_IMAGE_TEXT_EN;
    if (sid === 'shipinhao_image_text') return isZh ? STEP_NAMES_SHIPINHAO_IMAGE_TEXT_ZH : STEP_NAMES_SHIPINHAO_IMAGE_TEXT_EN;
    if (sid === 'toutiao_image_text') return isZh ? STEP_NAMES_TOUTIAO_IMAGE_TEXT_ZH : STEP_NAMES_TOUTIAO_IMAGE_TEXT_EN;
    if (sid === 'xhs_reply_fans_comment') return isZh ? STEP_NAMES_XHS_REPLY_FANS_ZH : STEP_NAMES_XHS_REPLY_FANS_EN;
    if (sid === 'douyin_reply_fans_comment') return isZh ? STEP_NAMES_DOUYIN_REPLY_FANS_ZH : STEP_NAMES_DOUYIN_REPLY_FANS_EN;
    if (sid === 'xhs_video_download') return isZh ? STEP_NAMES_XHS_VIDEO_DOWNLOAD_ZH : STEP_NAMES_XHS_VIDEO_DOWNLOAD_EN;
    if (sid === 'douyin_video_download') return isZh ? STEP_NAMES_DOUYIN_VIDEO_DOWNLOAD_ZH : STEP_NAMES_DOUYIN_VIDEO_DOWNLOAD_EN;
    if (sid === 'tiktok_video_download') return isZh ? STEP_NAMES_TIKTOK_VIDEO_DOWNLOAD_ZH : STEP_NAMES_TIKTOK_VIDEO_DOWNLOAD_EN;
    // 快手 / 哔哩哔哩 流程镜像抖音,但步骤名按各自平台名生成(纯展示,scenario.id 独立),
    // 不再复用抖音常量,避免「抖音」字样串台到别的平台页。
    if (sid === 'kuaishou_auto_engage') return engageStepNames(isZh, '快手', 'Kuaishou', '点赞 / 关注 / 评论', 'like / follow / comment');
    if (sid === 'bilibili_auto_engage') return engageStepNames(isZh, '哔哩哔哩', 'Bilibili', '点赞 / 投币 / 关注 / 评论', 'like / coin / follow / comment');
    if (sid === 'kuaishou_reply_fans_comment') return replyStepNames(isZh, '快手创作者中心', 'Kuaishou Creator Center');
    if (sid === 'bilibili_reply_fans_comment') return replyStepNames(isZh, '哔哩哔哩创作中心', 'Bilibili Creator Center');
    if (sid === 'shipinhao_reply_fans_comment') return replyStepNames(isZh, '视频号助手', 'WeChat Channels Assistant');
    if (sid === 'toutiao_reply_fans_comment') return replyStepNames(isZh, '头条号创作者中心', 'Toutiao Creator Center');
    if (sid === 'kuaishou_video_download') return videoDownloadStepNames(isZh, '快手', 'Kuaishou');
    if (sid === 'bilibili_video_download') return videoDownloadStepNames(isZh, '哔哩哔哩', 'Bilibili');
    return isAutoReplyTask
      ? (isZh ? STEP_NAMES_AUTOREPLY_ZH : STEP_NAMES_AUTOREPLY_EN)
      : (isZh ? STEP_NAMES_ZH : STEP_NAMES_EN);
  })();
  // ── Core state ──
  const [running, setRunning] = useState(false);
  // Grace period anchor: timestamp of the most recent optimistic
  // setRunning(true) from the user clicking "直接运行". Used by the
  // progress-poll cross-check below to avoid spurious setRunning(false)
  // during the 0~few-second window where the click already lit the UI
  // but the sidecar hasn't called markResourcesBusy + initProgress yet
  // — without this guard, slow-starting platforms (Douyin / TikTok /
  // YouTube login-check + new-tab opens) produced a visible 亮→暗→亮
  // flicker on the running card.
  const justStartedAtRef = useRef(0);
  const [progress, setProgress] = useState<ScenarioRunProgress | null>(null);
  const [, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 矩阵号:选中查看哪个账号的单独明细(null = 只看聚合)。
  const [acctTab, setAcctTab] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // 矩阵号:加载本任务各账号详情(头像/昵称/平台号/赛道/人设/关键词),详情页 + 运行明细按账号展示。
  const [acctDetails, setAcctDetails] = useState<any[]>([]);
  useEffect(() => {
    const ids: string[] = Array.isArray((task as any)?.account_ids) ? (task as any).account_ids : [];
    if (!ids.length) { setAcctDetails([]); return; }
    let alive = true;
    (async () => {
      try {
        const r = await (window.electron as any)?.matrix?.listAccounts?.();
        if (alive && r?.ok) setAcctDetails(Array.isArray(r.accounts) ? r.accounts : []);
      } catch { /* 拉不到账号详情不影响详情页其余部分 */ }
    })();
    return () => { alive = false; };
  }, [(task as any)?.id]);

  const showToast = (kind: 'ok' | 'warn' | 'err', text: string) => {
    if (!mountedRef.current) return;
    setToast({ kind, text });
    setTimeout(() => { if (mountedRef.current) setToast(null); }, 5000);
  };

  // ── Load data on mount ──
  const refreshData = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        scenarioService.listDrafts(task.id).catch(() => []),
        scenarioService.getTaskStats(task.id).catch(() => null),
      ]);
      if (mountedRef.current) { setDrafts(Array.isArray(d) ? d : []); setStats(s); }
    } catch {}
  }, [task.id]);

  // v4.31.42: 撤回 v4.31.41 的 runRecord fallback —— 用户反馈"没运行的任务
  //   详情页显示上次进度容易误以为还在跑"。现在没运行就纯净空步骤,只内存
  //   progress 实时展示。事后想看历史日志走 RunHistoryPage。

  // ── Check running state on mount (ONE TIME) ──
  useEffect(() => {
    void refreshData();
    scenarioService.getRunProgress(task.id).then(prog => {
      if (!mountedRef.current) return;
      if (prog && prog.taskId === task.id) {
        setProgress(prog);
        if (prog.status === 'running') setRunning(true);
      }
    }).catch(() => {});
    scenarioService.getRunningTaskIds().then(ids => {
      if (!mountedRef.current) return;
      if (Array.isArray(ids) && ids.indexOf(task.id) >= 0) setRunning(true);
    }).catch(() => {});
  }, [refreshData, task.id]);

  // v2.4.67: ongoing sync — if list-side reports our task as running but
  // local state thinks otherwise, flip running=true so the step panel
  // starts polling progress. Stops when local running already true.
  useEffect(() => {
    if (running) return;
    let cancelled = false;
    const tick = async () => {
      const ids = await scenarioService.getRunningTaskIds().catch(() => [] as string[]);
      if (cancelled || !mountedRef.current) return;
      if (Array.isArray(ids) && ids.indexOf(task.id) >= 0) setRunning(true);
    };
    const h = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(h); };
  }, [running, task.id]);

  // ── Poll progress logs every 2s (display only, NOT for running state) ──
  //
  // v2.4.38: also fires an IMMEDIATE fetch right when `running` flips to
  // true, not just on the first setInterval tick 2s later. Without this,
  // users entering a task detail page mid-run saw "等待前一步" in the
  // step panel for ~2 seconds before the first poll landed — looked like
  // the progress wasn't loading at all. Retry-and-reenter was their
  // workaround. Now progress shows up within ~50ms of `running=true`.
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    // Defensive: if progress comes back null repeatedly while we think the
    // task is running, the in-memory progress entry was already cleaned up
    // (it's deleted 30s after the task finishes). Without this, the UI
    // would stay stuck on "正在启动…" / "等待前一步" placeholders forever
    // because nothing else flips running back to false.
    let nullStreak = 0;
    const NULL_STREAK_THRESHOLD = 3;  // 2s × 3 = 6s of consecutive nulls
    const doFetch = async () => {
      try {
        // Pass task.id so the main process returns THIS task's progress
        // even when another task (different platform) is also running.
        const prog = await scenarioService.getRunProgress(task.id).catch(() => null);
        if (cancelled || !mountedRef.current) return;
        if (!prog || prog.taskId !== task.id) {
          // Cross-check with the authoritative running list before downgrading
          // — getRunningTaskIds reads runningByResource which is updated
          // synchronously when the task finishes, so it's the safer signal.
          //
          // BUT: there are TWO situations where progress=null AND
          // runningByResource doesn't have us:
          //   (a) task genuinely finished (intended downgrade)
          //   (b) task just started — the sidecar is still inside the
          //       async warm-up before markResourcesBusy + initProgress
          //       fire (login check, tab open, etc.) which on slow
          //       platforms can stretch past the 6s nullStreak window.
          // Without a guard, (b) was being misread as (a) → setRunning(false)
          // → the "ongoing sync" tick 3s later sees the now-busy sidecar
          // → setRunning(true) → user-visible 亮→暗→亮 flicker.
          //
          // Grace period: if it's been < 15s since the user clicked
          // "直接运行" (justStartedAtRef), defer the downgrade. After
          // 15s the sidecar is reliably either inside the task (progress
          // non-null) or genuinely finished — both paths are correctly
          // handled outside this branch.
          nullStreak++;
          if (nullStreak >= NULL_STREAK_THRESHOLD) {
            const sinceStart = Date.now() - justStartedAtRef.current;
            if (justStartedAtRef.current > 0 && sinceStart < 15_000) {
              // Still in warm-up window — skip downgrade this tick.
              // Reset the streak so we don't immediately re-fire on the
              // next null; let the next 3 nulls accumulate so the
              // cross-check happens again after a fresh ~6s of nulls.
              nullStreak = 0;
              return;
            }
            const ids = await scenarioService.getRunningTaskIds().catch(() => [] as string[]);
            if (cancelled || !mountedRef.current) return;
            if (!Array.isArray(ids) || ids.indexOf(task.id) < 0) {
              setRunning(false);
              setStopping(false);
              void refreshData();
            }
            nullStreak = 0;
          }
          return;
        }
        nullStreak = 0;
        if (prog && prog.taskId === task.id) {
          setProgress(prog);
          // If progress says "done" or "error", task has finished
          if (prog.status === 'done') {
            setRunning(false);
            setStopping(false);
            // Count results from step logs
            const step3Logs = prog.steps[2]?.logs || [];
            const draftLog = step3Logs.find((l: any) => l.message?.includes('已保存'));
            showToast('ok', draftLog?.message || '运行完成');
            void refreshData();
            void onChanged();
          } else if (prog.status === 'error') {
            setRunning(false);
            setStopping(false);
            const err = prog.error || '';
            if (err === 'user_stopped') {
              // User explicitly hit stop — confirm it worked.
              showToast('ok', '已停止运行');
            } else {
              const lang = i18nService.currentLanguage === 'zh' ? 'zh' : 'en';
              showToast('err', `${lang === 'zh' ? '运行失败' : 'Run failed'}: ${friendlyRunError(err, lang, { platform: platformLabelForTask })}`);
            }
            void refreshData();
            void onChanged();
          }
        }
      } catch {}
    };
    // Immediate first fetch (don't wait 2s for setInterval to fire).
    void doFetch();
    const timer = setInterval(doFetch, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [running, task.id, refreshData]);

  // ── Actions ──
  const handleRunNow = async () => {
    if (running) return;

    // 1. Wallet check (sync — fast, no perceived lag).
    if (!noobClawAuth.getState().isAuthenticated) {
      noobClawAuth.requireLoginUI();
      return;
    }

    // 1b. Balance check — 余额 < 10000 时弹"积分不足"提示框,点击充值跳
    //     钱包页;否则继续启动任务。阈值见 noobClawAuth.hasEnoughBalanceForTask。
    if (!noobClawAuth.hasEnoughBalanceForTask()) return;

    // 矩阵 edition:互动涨粉走指纹内核 CDP 按号执行(无浏览器插件;账号在「我的矩阵账号」已扫码关联,
    //   跑时按号内核校验登录、未登录自动跳过)→ 不需要「装插件 + 平台登录」运行前检查,直接开跑。
    if (MATRIX_EDITION) { handleLoginConfirmed(); return; }

    // 2. Open the pre-run modal IMMEDIATELY so the user sees instant
    //    visual feedback. Pre-2.4.30 we awaited getRunningTaskIds +
    //    listTasks + listScenarios BEFORE setLoginModalOpen, which on a
    //    slow IPC round-trip felt like "click did nothing" — users
    //    learned they had to double-click. The modal is the right place
    //    to be while these async checks resolve, since the user has to
    //    read it + click confirm anyway (plenty of time).
    setLoginModalOpen(true);

    // 3. Per-platform concurrency check, in the background. If we find
    //    another task on the same platform is already running, close the
    //    modal and surface the toast. Otherwise the user proceeds
    //    normally — no extra wait.
    try {
      const runningIds: string[] = await scenarioService.getRunningTaskIds().catch(() => [] as string[]);
      const otherRunning = runningIds.filter((id: string) => id !== task.id);
      if (otherRunning.length === 0) return; // nothing else running
      const [allTasks, allScenarios] = await Promise.all([
        scenarioService.listTasks().catch(() => [] as Task[]),
        scenarioService.listScenarios().catch(() => [] as Scenario[]),
      ]);
      if (!mountedRef.current) return;
      const scenarioById = new Map(allScenarios.map(s => [s.id, s]));
      const myPlatform = scenario?.platform;
      const samePlatformBusy = otherRunning.some(rid => {
        const otherTask = allTasks.find(t => t.id === rid);
        if (!otherTask) return false;
        const otherPlatform = scenarioById.get(otherTask.scenario_id)?.platform;
        return otherPlatform === myPlatform;
      });
      if (samePlatformBusy) {
        const platformLabel = myPlatform === 'x' ? '推特'
          : myPlatform === 'xhs' ? '小红书'
          : myPlatform === 'binance' ? '币安广场'
          : myPlatform === 'youtube' ? 'YouTube'
          : myPlatform === 'tiktok' ? 'TikTok'
          : myPlatform === 'douyin' ? '抖音'
          : '该平台';
        // Close the just-opened modal — the user can't proceed anyway.
        setLoginModalOpen(false);
        showToast('warn', `${platformLabel}已有任务在运行，同平台同时只能跑一个。请先停掉另一个，或运行其它平台的任务。`);
      }
    } catch {}
  };

  const handleLoginConfirmed = () => {
    setLoginModalOpen(false);
    // 4. Start! Set running IMMEDIATELY — don't wait for IPC. Stamp the
    // grace-period anchor so the progress-poll cross-check (below)
    // doesn't undo this in the first ~15s while the sidecar is still
    // warming up the platform (login check, tab open, etc.) and
    // hasn't yet marked the task busy in runningByResource.
    setRunning(true);
    justStartedAtRef.current = Date.now();
    setProgress(null);

    // 5. Fire IPC — returns immediately with { status: 'started' }.
    //    The actual task runs in the sidecar background; we track it via
    //    getRunProgress polling (already running every 2s while running=true).
    //    When progress.status becomes 'done' or 'error', we stop running.
    scenarioService.runTaskNow(task.id).then(async (outcome) => {
      if (!mountedRef.current) return;
      if (outcome.status === 'started' || outcome.status === 'ok') {
        // Task launched (or finished instantly) — progress polling handles the rest
        return;
      } else if (outcome.status === 'skipped') {
        // v4.25.35: 资源被占用时拼一句人话给用户(平台名 + 占用任务名),
        // 而不是甩一坨 'resource_busy:tab:^https?://...' 的内部 key。
        const r = outcome.reason || '';
        if (r.startsWith('resource_busy:') && Array.isArray(outcome.busy_platforms) && outcome.busy_platforms.length) {
          const plats = outcome.busy_platforms.join(' + ');
          const holder = outcome.busy_task_name || '其他任务';
          showToast('warn', `该任务需要 ${plats} 都空闲。当前 "${holder}" 正在运行,请先停掉它再启动此任务。`);
        } else if (r === 'concurrency_limit_reached') {
          showToast('warn', '同时运行的任务已达上限,请先停掉一个再启动新任务。');
        } else {
          showToast('warn', `已跳过: ${r || '未知原因'}`);
        }
        setRunning(false);
      } else {
        // Centralized reason-code → friendly text mapping lives in
        // services/runErrorMessage.ts so adding a new orchestrator code
        // only requires editing that one file (instead of every UI site
        // that displays a reason). Falls back to "运行异常 (raw_code)"
        // for anything unmapped, preserving the raw code for support.
        const lang = i18nService.currentLanguage === 'zh' ? 'zh' : 'en';
        showToast('err', `${lang === 'zh' ? '运行失败' : 'Run failed'}: ${friendlyRunError(outcome.reason, lang)}`);
        setRunning(false);
      }
    }).catch(() => {
      if (mountedRef.current) { showToast('err', '运行异常'); setRunning(false); }
    });
  };

  const [stopping, setStopping] = useState(false);
  const handleStop = async () => {
    setStopping(true);
    try {
      // Pass task.id so we abort THIS task only — without it we'd kill
      // any other concurrent task (e.g. XHS) at the same time.
      await scenarioService.requestAbort(task.id);
      showToast('warn', '正在停止，请稍候...');
    } catch {
      showToast('err', '停止请求失败');
      setStopping(false);
    }
  };

  const handleDelete = async () => {
    // Check if THIS task is running. Use the plural getter — singleton
    // would miss us if a different concurrent task happens to iterate first.
    try {
      const ids: string[] = await scenarioService.getRunningTaskIds().catch(() => [] as string[]);
      if (ids.includes(task.id)) {
        showToast('warn', '该任务正在运行中，请先停止再删除');
        return;
      }
    } catch {}
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setTimeout(() => { if (mountedRef.current) setConfirmingDelete(false); }, 3000);
      return;
    }
    setConfirmingDelete(false);
    await scenarioService.deleteTask(task.id);
    onBack();
    await onChanged();
  };

  const trackName = TRACK_NAMES[task.track] || task.track || task.scenario_id;

  // ── Render ──

  // Reuse the same badge palette as MyTasksPage / XWorkflowsPage so the
  // task detail page visually matches what the user clicked from the list.
  const platformBadge = (() => {
    if (scenario?.platform === 'x') return { icon: '🐦', label: isZh ? '推特' : 'Twitter' };
    if (scenario?.platform === 'xhs') return { icon: '📕', label: isZh ? '小红书' : 'XHS' };
    if (scenario?.platform === 'binance') return { icon: '🔶', label: isZh ? '币安广场' : 'Binance Square' };
    if ((scenario?.platform as any) === 'youtube') return { icon: '📺', label: 'YouTube' };
    if ((scenario?.platform as any) === 'tiktok') return { icon: '🎵', label: 'TikTok' };
    if ((scenario?.platform as any) === 'douyin') return { icon: '🎵', label: isZh ? '抖音' : 'Douyin' };
    if ((scenario?.platform as any) === 'kuaishou') return { icon: '⚡', label: isZh ? '快手' : 'Kuaishou' };
    if ((scenario?.platform as any) === 'bilibili') return { icon: '📺', label: isZh ? '哔哩哔哩' : 'Bilibili' };
    if ((scenario?.platform as any) === 'shipinhao') return { icon: '📱', label: isZh ? '视频号' : 'WeChat Channels' };
    if ((scenario?.platform as any) === 'toutiao') return { icon: '📰', label: isZh ? '头条号' : 'Toutiao' };
    if ((scenario?.platform as any) === 'video') return { icon: '🎬', label: isZh ? '视频搬运·二创' : 'Video Remix' };
    return { icon: '🤖', label: scenario?.platform || '' };
  })();
  const isLinkModeForBadge = task.track === 'link_mode' || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
  // YouTube/TikTok/Douyin tasks should never fall into the XHS auto_reply or
  // XHS Batch Viral fallback branches below — they have nothing in common with
  // those flows. Compute platform guard once.
  const isYoutubeTask = (scenario?.platform as any) === 'youtube' || task.scenario_id?.startsWith('youtube_');
  const isTiktokTask = (scenario?.platform as any) === 'tiktok' || task.scenario_id?.startsWith('tiktok_');
  const isDouyinTask = (scenario?.platform as any) === 'douyin' || task.scenario_id?.startsWith('douyin_');
  const isKuaishouTask = (scenario?.platform as any) === 'kuaishou' || task.scenario_id?.startsWith('kuaishou_');
  const isBilibiliTask = (scenario?.platform as any) === 'bilibili' || task.scenario_id?.startsWith('bilibili_');
  const isShipinhaoTask = (scenario?.platform as any) === 'shipinhao' || task.scenario_id?.startsWith('shipinhao_');
  const isToutiaoTask = (scenario?.platform as any) === 'toutiao' || task.scenario_id?.startsWith('toutiao_');
  const typeBadge = (() => {
    const sid = task.scenario_id;
    if (sid === 'x_auto_engage')                  return { icon: '🐦', label: isZh ? '推特 · 互动涨粉' : 'Twitter Engage & Grow', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/30' };
    if (sid === 'x_post_creator')                 return { icon: '📝', label: isZh ? '推特 · 自动发推' : 'Twitter Auto Post', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    if (sid === 'x_link_rewrite')                 return { icon: '✍️', label: isZh ? '推特 · 指定链接仿写' : 'Tweet Rewrite (URL)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
    if (sid === 'binance_square_auto_engage')     return { icon: '🤝', label: isZh ? '币安广场 · 互动涨粉' : 'Binance Square Engage & Grow', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
    if (sid === 'binance_square_post_creator')    return { icon: '🔶', label: isZh ? '币安广场 · 自动发帖' : 'Binance Square Auto Post', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
    if (sid === 'binance_from_x_repost')          return { icon: '🔁', label: isZh ? '币安广场 · 推特批量搬运' : 'Binance · Repost from X (Batch)', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (sid === 'binance_from_x_link')          return { icon: '🔗', label: isZh ? '币安广场 · 推特链接仿写' : 'Binance · From X Link', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (sid === 'binance_from_xhs_viral')         return { icon: '📕', label: isZh ? '币安广场 · 小红书批量搬运' : 'Binance · Repost from Xiaohongshu (Batch)', color: 'text-rose-500 bg-rose-500/10 border-rose-500/30' };
    if (sid === 'binance_from_douyin_viral')      return { icon: '🎵', label: isZh ? '币安广场 · 抖音批量搬运' : 'Binance · Repost from Douyin (Batch)', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
    if (sid === 'binance_from_tiktok_viral')      return { icon: '🎬', label: isZh ? '币安广场 · TikTok 批量搬运' : 'Binance · Repost from TikTok (Batch)', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'youtube_auto_engage')            return { icon: '📺', label: isZh ? 'YouTube · 互动涨粉' : 'YouTube Engage & Grow', color: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/30' };
    if (sid === 'tiktok_auto_engage')             return { icon: '🎵', label: isZh ? 'TikTok · 互动涨粉' : 'TikTok Engage & Grow', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'douyin_auto_engage')             return { icon: '🎵', label: isZh ? '抖音 · 互动涨粉' : 'Douyin Engage & Grow', color: 'text-violet-500 bg-violet-500/10 border-violet-500/30' };
    if (sid === 'douyin_image_text')              return { icon: '📝', label: isZh ? '抖音 · 图文创作' : 'Douyin Image-Text', color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
    if (sid === 'douyin_reply_fans_comment')      return { icon: '💬', label: isZh ? '抖音 · 自动回复粉丝' : 'Douyin Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'xhs_image_text')                 return { icon: '📝', label: isZh ? '小红书 · 图文创作' : 'XHS Image-Text', color: 'text-rose-500 bg-rose-500/10 border-rose-500/30' };
    if (sid === 'xhs_reply_fans_comment')         return { icon: '💌', label: isZh ? '小红书 · 自动回复粉丝' : 'XHS Reply Fan Comments', color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
    if (sid === 'xhs_video_download')             return { icon: '⬇️', label: isZh ? '小红书 · 视频无水印下载' : 'XHS Video Download', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
    if (sid === 'douyin_video_download')          return { icon: '⬇️', label: isZh ? '抖音 · 视频无水印下载' : 'Douyin Video Download', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    if (sid === 'tiktok_video_download')          return { icon: '⬇️', label: isZh ? 'TikTok · 视频无水印下载' : 'TikTok Video Download', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'kuaishou_auto_engage')           return { icon: '⚡', label: isZh ? '快手 · 互动涨粉' : 'Kuaishou Engage & Grow', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (sid === 'kuaishou_video_download')        return { icon: '⬇️', label: isZh ? '快手 · 视频无水印下载' : 'Kuaishou Video Download', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
    if (sid === 'kuaishou_reply_fans_comment')    return { icon: '💬', label: isZh ? '快手 · 自动回复粉丝' : 'Kuaishou Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'bilibili_auto_engage')           return { icon: '📺', label: isZh ? '哔哩哔哩 · 互动涨粉' : 'Bilibili Engage & Grow', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
    if (sid === 'bilibili_video_download')        return { icon: '⬇️', label: isZh ? '哔哩哔哩 · 视频无水印下载' : 'Bilibili Video Download', color: 'text-blue-500 bg-blue-500/10 border-blue-500/30' };
    if (sid === 'bilibili_reply_fans_comment')    return { icon: '💬', label: isZh ? '哔哩哔哩 · 自动回复粉丝' : 'Bilibili Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'shipinhao_image_text')           return { icon: '📝', label: isZh ? '视频号 · 图文创作' : 'WeChat Channels Image-Text', color: 'text-fuchsia-500 bg-fuchsia-500/10 border-fuchsia-500/30' };
    if (sid === 'shipinhao_reply_fans_comment')   return { icon: '💬', label: isZh ? '视频号 · 自动回复粉丝' : 'WeChat Channels Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (sid === 'toutiao_image_text')             return { icon: '📝', label: isZh ? '头条号 · 图文创作' : 'Toutiao Image-Text', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
    if (sid === 'toutiao_reply_fans_comment')     return { icon: '💬', label: isZh ? '头条号 · 自动回复粉丝' : 'Toutiao Reply Fan Comments', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    if (isLinkModeForBadge && !isXTask && !isBinanceTask && !isYoutubeTask && !isTiktokTask && !isDouyinTask && !isKuaishouTask && !isBilibiliTask && !isShipinhaoTask && !isToutiaoTask) return { icon: '🔗', label: isZh ? '小红书 · 指定链接爆款仿写' : 'XHS Rewrite (URL)', color: 'text-purple-500 bg-purple-500/10 border-purple-500/30' };
    // workflow_type fallback — guard by platform so Binance / YouTube / TikTok
    // / Douyin auto_reply don't get mis-labeled as XHS auto_reply.
    if ((scenario?.workflow_type as any) === 'auto_reply') {
      if (isBinanceTask) return { icon: '💬', label: isZh ? '币安广场 · 互动涨粉' : 'Binance Square Engage & Grow', color: 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30' };
      if (isYoutubeTask) return { icon: '💬', label: isZh ? 'YouTube · 互动涨粉' : 'YouTube Engage & Grow', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
      if (isTiktokTask)  return { icon: '💬', label: isZh ? 'TikTok · 互动涨粉' : 'TikTok Engage & Grow', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
      if (isDouyinTask)  return { icon: '💬', label: isZh ? '抖音 · 互动涨粉' : 'Douyin Engage & Grow', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
      if (isKuaishouTask) return { icon: '💬', label: isZh ? '快手 · 互动涨粉' : 'Kuaishou Engage & Grow', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
      if (isBilibiliTask) return { icon: '💬', label: isZh ? '哔哩哔哩 · 互动涨粉' : 'Bilibili Engage & Grow', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
      return { icon: '💬', label: isZh ? '小红书 · 互动涨粉' : 'XHS Engage & Grow', color: 'text-cyan-500 bg-cyan-500/10 border-cyan-500/30' };
    }
    if (isBinanceTask) return { icon: '🔶', label: isZh ? '币安广场发帖' : 'Binance Square Post', color: 'text-amber-500 bg-amber-500/10 border-amber-500/30' };
    if (isXTask)       return { icon: '🐦', label: isZh ? '推特任务' : 'Twitter Task', color: 'text-sky-500 bg-sky-500/10 border-sky-500/30' };
    if (isYoutubeTask) return { icon: '📺', label: isZh ? 'YouTube 任务' : 'YouTube Task', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
    if (isTiktokTask)  return { icon: '🎵', label: isZh ? 'TikTok 任务' : 'TikTok Task', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
    if (isDouyinTask)  return { icon: '🎵', label: isZh ? '抖音创作' : 'Douyin Task', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
    if (isKuaishouTask) return { icon: '⚡', label: isZh ? '快手任务' : 'Kuaishou Task', color: 'text-orange-500 bg-orange-500/10 border-orange-500/30' };
    if (isBilibiliTask) return { icon: '📺', label: isZh ? '哔哩哔哩任务' : 'Bilibili Task', color: 'text-pink-500 bg-pink-500/10 border-pink-500/30' };
    if (isShipinhaoTask) return { icon: '📱', label: isZh ? '视频号任务' : 'WeChat Channels Task', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
    if (isToutiaoTask) return { icon: '📰', label: isZh ? '头条号任务' : 'Toutiao Task', color: 'text-red-500 bg-red-500/10 border-red-500/30' };
    return { icon: '🔥', label: isZh ? '小红书 · 爆款批量仿写' : 'XHS Batch Viral', color: 'text-green-500 bg-green-500/10 border-green-500/30' };
  })();

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* NoobCoin 福袋红包 — 任务跑/扣费时 backend 通过 SSE 触发,跟 chat 框那个同源 */}
      <ErrorBoundary name="LuckyBag">
        <LuckyBag />
      </ErrorBoundary>
      <button type="button" onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
        ← {isZh ? '返回' : 'Back'}
      </button>

      {/* Header: platform + scenario type badges so the page identifies
          itself the same way it did in the list. Language pill removed
          (2026-05): we no longer show a language picker for Twitter
          scenarios — every Twitter task follows the original tweet's
          language, so a "set language" pill would be misleading. */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200">
          {platformBadge.icon} {platformBadge.label}
        </span>
        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${typeBadge.color}`}>
          {typeBadge.icon} {typeBadge.label}
        </span>
        <span className="text-[10px] text-gray-500 dark:text-gray-500 font-mono">
          #{task.id.slice(0, 8)}
        </span>
      </div>

      {/* Config + actions */}
      {/* v4.31.42: 跟 list 页保持一致 — 运行中卡片绿框发亮(border-green-500 + ring + noobclaw-running-glow) */}
      <div className={`rounded-xl border bg-white dark:bg-gray-900 p-4 mb-4 ${
        running
          ? 'border-green-500 ring-2 ring-green-500/30 noobclaw-running-glow'
          : 'border-gray-200 dark:border-gray-700'
      }`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 text-xs text-gray-500 dark:text-gray-400 space-y-1">
            {(() => {
              const isLinkMode = task.track === 'link_mode' || (Array.isArray((task as any).urls) && (task as any).urls.length > 0);
              const taskUrls: string[] = (task as any).urls || [];
              // 图文创作场景(抖音 + 小红书):不展示 赛道 / 人设 / 关键词,
              // 只展示 3 段参考文案 + 配图配置(模式 / 风格 / 张数 / 关键词)。
              // 两个场景的 wizard schema 完全一致(source_segments / use_real_photos
              // / real_photo_count / real_photo_keywords / ai_image_style),
              // 详情页用同一段渲染逻辑覆盖。
              const isDouyinImageText = task.scenario_id === 'douyin_image_text';
              const isXhsImageText = task.scenario_id === 'xhs_image_text';
              const isImageTextTask = isDouyinImageText || isXhsImageText;
              // 自动回复粉丝(各平台 *_reply_fans_comment,track=reply_fan_comment):
              //   配置只有 引流语 + 引流概率,没有 赛道/人设/关键词 —— 详情页对齐 wizard,
              //   隐藏 赛道行 + 空关键词,改展示 引流语 / 概率。
              // 引流语只属于「回复粉丝评论」场景。原来用 workflow_type==='auto_reply' 判断过宽:
              // 互动涨粉(douyin_auto_engage / xhs_auto_reply_universal 等)也是 auto_reply 类型,
              // 会被误判成回复粉丝 → 错误显示引流语。改成只认真正的 *_reply_fans_comment 场景 + track 标记。
              const isReplyFan = task.track === 'reply_fan_comment'
                || /_reply_fans_comment$/.test(scenario?.id || '');
              // 矩阵号互动任务:赛道/关键词/人设在各账号上,task 不带 → 展示账号数而非「赛道: matrix」+ 空关键词。
              const matrixAccountIds: string[] = Array.isArray((task as any).account_ids) ? (task as any).account_ids : [];
              const isMatrix = task.track === 'matrix' || matrixAccountIds.length > 0;
              const sourceSegments: string[] = Array.isArray((task as any).source_segments) ? (task as any).source_segments : [];
              // v1.x: 配图配置 — 两个图文场景共用同一组字段,详情页统一渲染。
              const useRealPhotos = !!(task as any).use_real_photos;
              const realPhotoCount = (typeof (task as any).real_photo_count === 'number')
                ? (task as any).real_photo_count : null;
              const realPhotoKeywords = String((task as any).real_photo_keywords || '').trim();
              const aiImageStyleId = String((task as any).ai_image_style || '').trim();
              const aiImageStyle = aiImageStyleId
                ? FALLBACK_IMAGE_STYLES.find(s => s.id === aiImageStyleId)
                : null;
              // v6.x: 3 个币安"源平台 viral 搬运"(xhs/douyin/tiktok) — 人设是固定模板,
              // 用户看不到 wizard 里也改不了,展示在详情页纯噪音。改为只显示本次搬运的媒体类型
              // (task.media_filter: all=图文+视频 / image_only=仅图文 / video_only=仅视频)。
              const isBinanceSourceViral =
                task.scenario_id === 'binance_from_xhs_viral'
                || task.scenario_id === 'binance_from_douyin_viral'
                || task.scenario_id === 'binance_from_tiktok_viral';
              const mediaFilterVal = (task as any).media_filter || 'all';
              const mediaFilterLabel = ((): string => {
                if (mediaFilterVal === 'image_only') return isZh ? '🖼 仅图文' : '🖼 Image only';
                if (mediaFilterVal === 'video_only') return isZh ? '🎥 仅视频' : '🎥 Video only';
                return isZh ? '🖼🎥 全部(图文 + 视频)' : '🖼🎥 All (image + video)';
              })();
              return (
                <>
                  {/* 矩阵号:展示账号数(各账号自有赛道/关键词/人设),不显示「赛道: matrix」+ 空关键词 */}
                  {isMatrix && (() => {
                    // 每个账号自有赛道/人设/关键词 → 列出来(可滚动,30 个也放得下)。
                    const PL: Record<string, string> = { douyin: '抖音', xhs: '小红书', bilibili: 'B站', kuaishou: '快手', tiktok: 'TikTok', x: '推特', binance: '币安广场', youtube: 'YouTube', shipinhao: '视频号', toutiao: '头条' };
                    const EM: Record<string, string> = { douyin: '🎵', xhs: '📕', bilibili: '📺', kuaishou: '⚡', tiktok: '🎬', x: '🐦', binance: '🟡', youtube: '▶️', shipinhao: '🟢', toutiao: '🟠' };
                    const idLabel = (p: string) => { const l = PL[p] || ''; return l ? (l.endsWith('号') ? l : l + '号') : ''; };
                    const accMap = new Map<string, any>(acctDetails.map((a: any) => [a.id, a]));
                    const accs = matrixAccountIds.map((id) => accMap.get(id)).filter(Boolean);
                    return (
                      <div>
                        <div className="flex items-center gap-3 mb-1.5">
                          <span className="text-gray-400">{isZh ? '账号:' : 'Accounts:'}</span>
                          <span className="dark:text-white font-medium">{isZh ? `${matrixAccountIds.length} 个 · 各用自己的赛道/人设/关键词` : `${matrixAccountIds.length} accounts · each uses its own track/persona/keywords`}</span>
                          <span className="text-[10px] text-gray-500 font-mono">#{task.id.slice(0, 8)}</span>
                        </div>
                        {accs.length > 0 ? (
                          // 只纵向滚动 + 横向裁剪:关键词/人设是 truncate(nowrap),若允许横向滚动会把整卡撑宽、
                          // 顶掉右侧按钮。overflow-x-hidden 让 truncate 真正在卡片宽度处省略。30 个号靠纵向滚动放下。
                          <div className="max-h-72 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
                            {/* 第一行:emoji + 昵称 + 平台号 + 赛道(赛道恒在最右,位置不变)。
                                第二行:只显示前 4 个关键词 + 单行截断(配合 overflow-x-hidden 绝不顶出右框)。人设不展示。 */}
                            {accs.map((a: any) => (
                              <div key={a.id} className="px-3 py-1.5 text-xs min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="shrink-0">{EM[a.platform] || '•'}</span>
                                  <span className="font-medium dark:text-gray-200 truncate min-w-0">{a.nickname || a.displayName}</span>
                                  {a.displayId && <span className="text-gray-500 dark:text-gray-400 truncate shrink-0">· {idLabel(a.platform)}:{a.displayId}</span>}
                                  <span className="ml-auto shrink-0 text-gray-500 dark:text-gray-400">🎯 {a.group ? a.group : <span className="text-amber-500">赛道未设</span>}</span>
                                </div>
                                <div className="text-gray-500 dark:text-gray-400 truncate" title={a.keywords && a.keywords.length ? a.keywords.join(' · ') : undefined}>
                                  🏷️ {a.keywords && a.keywords.length
                                    ? a.keywords.slice(0, 4).join(' · ') + (a.keywords.length > 4 ? ' …' : '')
                                    : <span className="text-amber-500">未配关键词(互动需要)</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-[11px] text-gray-400 py-1">{isZh ? '账号详情加载中…(如长期不出,去「我的矩阵账号」确认账号仍在)' : 'Loading account details…'}</div>
                        )}
                      </div>
                    );
                  })()}
                  {/* v4.28.x: 链接仿写场景(XHS link mode / x_link_rewrite / binance_from_x_link)
                      隐藏「赛道/人设: 🔗 ...」整行 —— 上面已经有 type badge 标明任务类型,
                      这一行的 link-mode label 跟 badge 完全重复,#ID 也已在标题区显示;
                      用户根本没填 track / persona,展示出来纯属噪音。
                      v5.x+: douyin_image_text 同理 — 只有参考文案,没赛道没人设。
                      v6.x: binance 源平台 viral 搬运 — 人设是固定模板,这一行也跳过。 */}
                  {!isMatrix && !isLinkMode && !isImageTextTask && !isBinanceSourceViral && !isReplyFan && (
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400">
                        {(isXTask || /^binance/.test(task.scenario_id)) ? (isZh ? '人设:' : 'Persona:') : (isZh ? '赛道:' : 'Track:')}
                      </span>
                      <span className="dark:text-white font-medium">{trackName}</span>
                      <span className="text-[10px] text-gray-500 font-mono">#{task.id.slice(0, 8)}</span>
                    </div>
                  )}
                  {/* v6.x: 源平台 viral 搬运 — task id + 媒体类型展示在头部 */}
                  {isBinanceSourceViral && (
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400">{isZh ? '本次搬运:' : 'Repost mode:'}</span>
                      <span className="dark:text-white font-medium">{mediaFilterLabel}</span>
                      <span className="text-[10px] text-gray-500 font-mono">#{task.id.slice(0, 8)}</span>
                    </div>
                  )}
                  {isImageTextTask && (
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-gray-500 font-mono">#{task.id.slice(0, 8)}</span>
                    </div>
                  )}
                  {/* v4.28.x: 把 task.persona 文本展开显示在「人设: XXX」下面 ——
                      列表页(MyTasksPage)只截取首行 80 字,用户进到详情想看完整身份
                      描述只能去 wizard 编辑里翻,体验不好。这里展示完整 persona。
                      Link 模式 + 图文创作 + 源平台 viral 搬运 没人设概念跳过。 */}
                  {!isLinkMode && !isImageTextTask && !isBinanceSourceViral && (task.persona || '').trim() && (
                    <div className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap pl-1">
                      <span className="text-gray-500 font-medium">{isZh ? '人设:' : 'Persona:'}</span>{' '}
                      {(task.persona || '').trim()}
                    </div>
                  )}
                  {isImageTextTask && sourceSegments.length > 0 && (
                    <div className="space-y-1.5 pl-1">
                      {sourceSegments.map((s, i) => (
                        <div key={i} className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                          <span className="text-gray-500">{isZh ? '参考文案 ' : 'Reference '}{['①','②','③'][i] || (i+1)}:</span>{' '}
                          <span className="whitespace-pre-wrap">{s}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* v1.x: 图文创作场景 — 配图配置块。
                      模式(AI 生图 / 网络图片) + 张数 + 关键词(网络图) / 风格(AI 图)。
                      抖音 + 小红书共用同一段渲染,字段 schema 一致。 */}
                  {isImageTextTask && (
                    <div className="space-y-1 pl-1 pt-1 border-t border-gray-200 dark:border-gray-800 mt-1.5">
                      <div className="text-xs text-gray-600 dark:text-gray-300">
                        <span className="text-gray-500">{isZh ? '配图模式:' : 'Image source:'}</span>{' '}
                        {useRealPhotos
                          ? (isZh ? '📷 网络图' : '📷 Web images')
                          : (isZh ? '🎨 AI 生成图片' : '🎨 AI-generated images')}
                      </div>
                      {typeof realPhotoCount === 'number' && (
                        <div className="text-xs text-gray-600 dark:text-gray-300">
                          <span className="text-gray-500">{isZh ? '每篇配图:' : 'Images per post:'}</span>{' '}
                          {realPhotoCount} {isZh ? '张' : (realPhotoCount === 1 ? 'image' : 'images')}
                        </div>
                      )}
                      {useRealPhotos && realPhotoKeywords && (
                        <div className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
                          <span className="text-gray-500">{isZh ? '抓图关键词:' : 'Photo keywords:'}</span>{' '}
                          <span className="whitespace-pre-wrap">{realPhotoKeywords}</span>
                        </div>
                      )}
                      {!useRealPhotos && (
                        <div className="text-xs text-gray-600 dark:text-gray-300">
                          <span className="text-gray-500">{isZh ? 'AI 风格:' : 'AI style:'}</span>{' '}
                          {aiImageStyle
                            ? `${aiImageStyle.icon} ${isZh ? aiImageStyle.zh : aiImageStyle.en}`
                            : (aiImageStyleId || (isZh ? '默认' : 'Default'))}
                        </div>
                      )}
                    </div>
                  )}
                  {isLinkMode ? (
                    <>
                      <div>{isZh ? '原文链接' : 'Source URLs'}: {taskUrls.length} {isZh ? '个' : ''}</div>
                      {taskUrls.map((u, i) => (
                        <div key={i} className="flex items-start gap-2 pl-4 text-[11px]">
                          <span className="text-gray-500 shrink-0 pt-0.5">{i + 1}.</span>
                          {/* break-all so 长链接能换行展示而不是被截断 */}
                          <span className="text-gray-400 break-all flex-1 min-w-0">{u}</span>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(u);
                                showToast('ok', isZh ? '已复制链接' : 'Link copied');
                              } catch {
                                showToast('err', isZh ? '复制失败' : 'Copy failed');
                              }
                            }}
                            className="shrink-0 px-2 py-0.5 text-[10px] rounded border border-gray-300 dark:border-gray-700 text-gray-500 hover:text-purple-500 hover:border-purple-500/50 transition-colors"
                            title={isZh ? '复制链接' : 'Copy URL'}
                          >
                            📋 {isZh ? '复制' : 'Copy'}
                          </button>
                        </div>
                      ))}
                      <div>{isZh ? '运行模式' : 'Mode'}: ✋ {isZh ? '一次性手动运行' : 'Manual one-shot'}</div>
                    </>
                  ) : (
                    <>
                      {/* Keywords are XHS-only — Twitter scenarios don't search
                          by keyword (auto_engage uses KOL pool + Home feed,
                          post_creator uses topic_context, link_rewrite is
                          URL-driven). Hide on X to avoid showing a misleading
                          empty/default keyword list.
                          v5.x+: 图文创作(抖音 + 小红书)也跳过 — 只看参考文案,没关键词。
                          v6.x: 3 个 binance source-viral 搬运 — task.keywords 是搜源
                          关键词(不是 Token);Token 单独从 task.cashtags 取。 */}
                      {/* 自动回复粉丝:展示 引流语 + 引流概率(对齐 wizard),不显示关键词 */}
                      {isReplyFan && (() => {
                        const funnel = String((task as any).funnel_phrase || '').trim();
                        const prob = typeof (task as any).funnel_probability === 'number' ? (task as any).funnel_probability : 0;
                        return (
                          <>
                            <div>
                              {isZh ? '🎣 核心引流语' : '🎣 Funnel phrase'}: {funnel || (isZh ? '(未填,回复不带引流尾巴)' : '(empty — no funnel tail)')}
                            </div>
                            <div>
                              {isZh ? '🎲 引流尾巴出现概率' : '🎲 Funnel tail probability'}: {funnel ? `${prob}%` : (isZh ? '— (引流语未填,概率失效)' : '— (disabled, funnel empty)')}
                            </div>
                          </>
                        );
                      })()}
                      {!isMatrix && !isXTask && !isImageTextTask && !isReplyFan && (() => {
                        const sid = task.scenario_id;
                        const isSourceViral = sid === 'binance_from_xhs_viral'
                                            || sid === 'binance_from_douyin_viral'
                                            || sid === 'binance_from_tiktok_viral';
                        // Label 决定:source-viral → "搜索关键词" / 其他 binance → "Token tag" / 默认 → "关键词"
                        const kwLabel = isSourceViral
                          ? (isZh ? '搜索关键词' : 'Search keywords')
                          : /^binance/.test(sid)
                            ? (isZh ? 'Token tag' : 'Token tag')
                            : (isZh ? '关键词' : 'Keywords');
                        // source-viral 额外展示 task.cashtags(币安发帖前缀池,可选)
                        const cashtags = isSourceViral
                          ? ((task as any).cashtags as string[] | undefined)
                          : undefined;
                        return (
                          <>
                            <div>
                              {kwLabel}: {task.keywords.join(' · ')}
                            </div>
                            {isSourceViral && (
                              <div>
                                {isZh ? 'Token 标签' : 'Token tags'}:{' '}
                                {cashtags && cashtags.length > 0
                                  ? cashtags.map(c => '$' + c).join(' · ')
                                  : (isZh ? '(走内置 BTC/ETH/SOL 等 30+ 主流币)' : '(built-in 30+ majors)')}
                              </div>
                            )}
                          </>
                        );
                      })()}
                      {/* v4.31.27: binance_from_x_repost 显示媒体类型 */}
                      {task.scenario_id === 'binance_from_x_repost' && (() => {
                        const mf = (task as any).media_filter;
                        const lab = mf === 'image_only' ? (isZh ? '仅图文' : 'Images only')
                          : mf === 'video_only' ? (isZh ? '仅视频(严格)' : 'Videos only (strict)')
                          : (isZh ? '全部(图文 + 视频)' : 'All (images + videos)');
                        return <div>{isZh ? '搬运类型' : 'Media filter'}: 🎞 {lab}</div>;
                      })()}
                      <div>{isZh ? '频次' : 'Schedule'}: ⏰ {(() => {
                        // v6.x: 详情页频次显示加上随机时间信息 — 短间隔展示 jitter 范围,
                        //   daily_random 展示 schedule_window。跟 wizard step3 那行 hint 对齐,
                        //   用户跑起任务后还能看到自己设置的"反检测节奏"。
                        const schedWin = (task as any).schedule_window || '09:00-23:00';
                        const intervalMap: Record<string, string> = isZh
                          ? {
                              '30min': '每30分钟(+1-10 分钟随机延迟)',
                              '1h': '每小时(+1-10 分钟随机延迟)',
                              '3h': '每3小时(+1-45 分钟随机延迟)',
                              '6h': '每6小时(+1-45 分钟随机延迟)',
                              'daily': '每天 ' + (task.daily_time || '08:00'),
                              'daily_random': '每日随机时间一次(' + schedWin + ' 间)',
                              'once': '不重复（手动触发）',
                            }
                          : {
                              '30min': 'Every 30min (+1-10min jitter)',
                              '1h': 'Hourly (+1-10min jitter)',
                              '3h': 'Every 3h (+1-45min jitter)',
                              '6h': 'Every 6h (+1-45min jitter)',
                              'daily': 'Daily ' + (task.daily_time || '08:00'),
                              'daily_random': 'Once daily (random within ' + schedWin + ')',
                              'once': 'Once (manual)',
                            };
                        const intervalLabel = intervalMap[(task as any).run_interval || 'daily'] || (isZh ? '每天 ' : 'Daily ') + (task.daily_time || '08:00');
                        // v2.4.60: 频次显示真实用户配置(min/max),不再写死 daily_count
                        const sid = task.scenario_id;
                        const t = task as any;
                        const fMin = t.daily_follow_min, fMax = t.daily_follow_max;
                        const rMin = t.daily_reply_min, rMax = t.daily_reply_max;
                        const lMin = t.daily_like_min, lMax = t.daily_like_max;
                        const cMin = t.daily_count_min, cMax = t.daily_count_max;
                        const pMin = t.daily_post_min, pMax = t.daily_post_max;
                        if (sid === 'x_auto_engage' || sid === 'binance_square_auto_engage') {
                          const fStr = (typeof fMin === 'number' && typeof fMax === 'number')
                            ? `${fMin}-${fMax}` : `0-${task.daily_count || 3}`;
                          const rStr = (typeof rMin === 'number' && typeof rMax === 'number')
                            ? `${rMin}-${rMax}` : `${task.daily_count || 1}`;
                          // v2.4.83: 点赞 — 仅 binance auto_engage 有,如果 task 上有就显示
                          const lStr = (typeof lMin === 'number' && typeof lMax === 'number')
                            ? `${lMin}-${lMax}` : null;
                          var summary = `${intervalLabel} · ${isZh ? '关注' : 'Follow'} ${fStr} · ${isZh ? '评论' : 'Reply'} ${rStr}`;
                          if (lStr) summary += ` · ${isZh ? '点赞' : 'Like'} ${lStr}`;
                          return summary;
                        }
                        // youtube/tiktok/douyin 互动: 跟 X auto_engage 同款 — 各动作 min-max 区间
                        // YouTube 用 subscribe，TikTok/Douyin 用 follow，配额字段名同步
                        if (sid === 'youtube_auto_engage' || sid === 'tiktok_auto_engage' || sid === 'douyin_auto_engage' || sid === 'kuaishou_auto_engage' || sid === 'bilibili_auto_engage') {
                          const sMin = t.daily_subscribe_min, sMax = t.daily_subscribe_max;
                          const cmMin = t.daily_comment_min, cmMax = t.daily_comment_max;
                          const fmtRange = (mn: any, mx: any, fb: number): string => {
                            if (typeof mn === 'number' && typeof mx === 'number') return mn === mx ? String(mn) : `${mn}-${mx}`;
                            return String(fb);
                          };
                          const lStr = fmtRange(lMin, lMax, 3);
                          const cmStr = fmtRange(cmMin, cmMax, 1);
                          if (sid === 'youtube_auto_engage') {
                            const sStr = fmtRange(sMin, sMax, 1);
                            return `${intervalLabel} · ${isZh ? '点赞' : 'Like'} ${lStr} · ${isZh ? '订阅' : 'Subscribe'} ${sStr} · ${isZh ? '评论' : 'Comment'} ${cmStr}`;
                          }
                          // tiktok / douyin 用 follow
                          const fStr2 = fmtRange(fMin, fMax, 1);
                          return `${intervalLabel} · ${isZh ? '点赞' : 'Like'} ${lStr} · ${isZh ? '关注' : 'Follow'} ${fStr2} · ${isZh ? '评论' : 'Comment'} ${cmStr}`;
                        }
                        // v4.31.27: binance_from_x_repost 也走 daily_post_min/max(批量搬运同样按"每次 N 条")
                        // v4.31.30: 频次摘要文案对齐 wizard step3 — 之前只有数字+"条/次",
                        //   旧任务 daily_post_min/max 缺失时回落 daily_count(常为 1),
                        //   显示"每30分钟 · 1 条/次",和 wizard 实时摘要不一致引发用户困惑。
                        //   现按场景给出和 wizard step3 同款描述,且 min===max 时只显示单值。
                        // v6.x: 3 个 source-viral 搬运(xhs/douyin/tiktok)同 binance_from_x_repost 也走
                        //   daily_post_min/max。之前漏在这条分支里,fall through 默认 task.daily_count || 1,
                        //   wizard 存的是 daily_post_min/max → daily_count 永远 undefined → 永远显示"每次 1 条"。
                        const isSrcViral = sid === 'binance_from_xhs_viral'
                                       || sid === 'binance_from_douyin_viral'
                                       || sid === 'binance_from_tiktok_viral';
                        if (sid === 'binance_square_post_creator' || sid === 'x_post_creator' || sid === 'binance_from_x_repost' || isSrcViral) {
                          const hasRange = typeof pMin === 'number' && typeof pMax === 'number';
                          const pStr = hasRange
                            ? (pMin === pMax ? String(pMin) : `${pMin}-${pMax}`)
                            : String(task.daily_count || 1);
                          if (sid === 'x_post_creator') {
                            return isZh
                              ? `${intervalLabel} · 每次 ${pStr} 条推文（仿写 30% / 原创 30% / 引用 40% 随机）`
                              : `${intervalLabel} · ${pStr} tweets/run (30% rewrite / 30% original / 40% quote)`;
                          }
                          if (sid === 'binance_from_x_repost') {
                            return isZh
                              ? `${intervalLabel} · 每次 ${pStr} 条 · 推特爆款搬运到币安广场（原图/视频 + AI 改写）`
                              : `${intervalLabel} · ${pStr} repost(s)/run · X → Binance Square (original media + AI rewrite)`;
                          }
                          if (isSrcViral) {
                            const srcLabel = sid === 'binance_from_xhs_viral' ? '小红书'
                                          : sid === 'binance_from_douyin_viral' ? '抖音'
                                          : 'TikTok';
                            const srcLabelEn = sid === 'binance_from_xhs_viral' ? 'Xiaohongshu'
                                            : sid === 'binance_from_douyin_viral' ? 'Douyin'
                                            : 'TikTok';
                            return isZh
                              ? `${intervalLabel} · 每次 ${pStr} 条 · ${srcLabel}爆款搬运到币安广场（原图/视频 + AI 改写）`
                              : `${intervalLabel} · ${pStr} repost(s)/run · ${srcLabelEn} → Binance Square (original media + AI rewrite)`;
                          }
                          // binance_square_post_creator
                          return isZh
                            ? `${intervalLabel} · 每次 ${pStr} 条币安广场短评（100-300 字 + cashtag）`
                            : `${intervalLabel} · ${pStr} Binance Square notes/run (100-300 chars + cashtag)`;
                        }
                        // 回复粉丝评论:每次处理"最近 N 篇笔记/作品"的全部未回复评论
                        //   (N = max_notes/works_per_run,默认 30),不是"N 条/次"。
                        if (sid === 'xhs_reply_fans_comment') {
                          return isZh ? `${intervalLabel} · 最近 30 篇笔记/次` : `${intervalLabel} · latest 30 notes/run`;
                        }
                        if (sid === 'douyin_reply_fans_comment' || sid === 'kuaishou_reply_fans_comment' || sid === 'bilibili_reply_fans_comment') {
                          return isZh ? `${intervalLabel} · 最近 30 个作品/次` : `${intervalLabel} · latest 30 videos/run`;
                        }
                        if (typeof cMin === 'number' && typeof cMax === 'number') {
                          return `${intervalLabel} · ${cMin}-${cMax} ${isZh ? '篇/次' : 'articles/run'}`;
                        }
                        return `${intervalLabel} · ${task.daily_count || 1} ${isZh ? '条/次' : '/run'}`;
                      })()}</div>
                    </>
                  )}
                </>
              );
            })()}
            <div>{isZh ? '创建时间' : 'Created'}: {new Date(task.created_at).toLocaleString()}</div>
            {/* Output folder link — for auto_reply this contains the run-report
                Markdown; for viral_production this contains the rewrite drafts
                + images. Either way it's the place to look for what was produced. */}
            <div className="flex items-center gap-2 flex-wrap">
              <span>{isZh ? '输出目录:' : 'Output:'}</span>
              {/* 点文字也能打开(保留旧交互) */}
              <button type="button" onClick={openTaskDir} className="text-blue-500 hover:underline text-[11px]">
                {isZh
                  ? (isAutoReplyTask ? '📂 打开报告文件夹' : '📂 打开输出文件夹')
                  : '📂 Open folder'}
              </button>
              {/* 醒目按钮:跟视频任务一致,让用户一眼能点 */}
              <button
                type="button"
                onClick={openTaskDir}
                className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                📂 {isZh ? '打开' : 'Open'}
              </button>
            </div>
            {/* v1.x: 删了截短 persona preview — 跟上面完整 persona 块 (line ~814) 重复了 */}
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {running ? (
              <>
                <span className="flex items-center gap-1.5 text-sm font-semibold text-green-500">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  {stopping ? (isZh ? '正在停止...' : 'Stopping...') : (isZh ? '运行中' : 'Running')}
                </span>
                <button type="button" onClick={handleStop}
                  disabled={stopping}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    stopping
                      ? 'border-gray-300 dark:border-gray-700 text-gray-400 cursor-not-allowed'
                      : 'border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10'
                  }`}>
                  {stopping ? (
                    <span className="flex items-center gap-1.5">
                      <span className="h-3 w-3 rounded-full border-2 border-gray-400 border-t-transparent animate-spin" />
                      {isZh ? '停止中' : 'Stopping'}
                    </span>
                  ) : (isZh ? '停止' : 'Stop')}
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-gray-400">
                  {(() => {
                    const interval = (task as any).run_interval || 'daily';
                    // v2.4.62: 'once'(手动触发)就别说"自动运行"和"下次运行" — 没意义
                    if (interval === 'once' || isLinkModeForStats) {
                      return isZh ? '✋ 手动触发' : '✋ Manual trigger';
                    }
                    // v4.25.4: 不再依赖 task.active 判定 "待命" —— 现在所有
                    // enabled 任务都会自动跑(active 仅 UI 高亮用)。直接显示
                    // schedule label。
                    const map: Record<string, string> = isZh
                      ? { '30min': '每30分钟', '1h': '每小时', '3h': '每3小时', '6h': '每6小时', 'daily': '每天 ' + (task.daily_time || '08:00'), 'daily_random': '每日随机时间一次' }
                      : { '30min': 'Every 30min', '1h': 'Hourly', '3h': 'Every 3h', '6h': 'Every 6h', 'daily': 'Daily ' + (task.daily_time || '08:00'), 'daily_random': 'Once daily (random time)' };
                    return (map[interval] || (isZh ? '每天' : 'Daily')) + (isZh ? ' 自动运行' : ' Scheduled');
                  })()}
                </span>
                <button type="button" onClick={handleRunNow}
                  className="px-3 py-2 text-sm font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 transition-colors">
                  {isZh ? '直接运行' : 'Run Now'}
                </button>
                <button type="button" onClick={onEdit}
                  className="px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                  {isZh ? '编辑' : 'Edit'}
                </button>
                <button type="button" onClick={handleDelete}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    confirmingDelete ? 'border-red-500 bg-red-500 text-white' : 'border-red-300 dark:border-red-900/50 text-red-500 hover:bg-red-500/10'
                  }`}>
                  {confirmingDelete ? (isZh ? '确定删除？' : 'Confirm?') : (isZh ? '删除' : 'Delete')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* v1.x: 任务运行中醒目提示 — running 时 render,提醒不要打断 NoobClaw 占用的浏览器 */}
      {running && (
        <div className="rounded-xl border-2 border-amber-500/50 bg-gradient-to-r from-amber-500/15 via-orange-500/10 to-amber-500/15 px-4 py-3 mb-3 noobclaw-running-glow">
          <div className="flex items-start gap-3">
            <span className="text-xl shrink-0 animate-pulse">⚠️</span>
            <div className="flex-1 text-sm text-amber-700 dark:text-amber-300 leading-relaxed font-medium">
              {isZh ? (
                <>运行中<strong>请勿缩小/最小化/关闭浏览器或退出账号</strong>,以免干扰运行。如需使用浏览器,请<strong>新开一个独立窗口</strong>(切勿在原窗口新开标签页)。</>
              ) : (
                <>While running, <strong>do NOT resize/minimize/close the browser or log out</strong> — it'll interrupt the task. If you need to browse, <strong>open a separate browser window</strong> (not a new tab in the same window).</>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Running-only pair: 本次运行进度 + 本次消耗.
          Both cards appear ONLY when status='running' AND we have either
          action_progress entries OR a non-zero tokens_used reading.
          They share the same green border + pulse + noobclaw-running-glow
          as other in-flight surfaces (run history pending row, scenario
          card).
          v5.x+: outer gate REVERTED to the old pre-737e367 shape after
          user reported "left card appears a few seconds AFTER the right
          card on XHS viral runs". Root cause was that 737e367 had
          dropped the action_progress/tokens-required guard, so the
          right card popped in immediately on status='running' while
          the left card had to wait for the orchestrator's
          ctx.setActionTargets to land — making them feel desynced. With
          the backend orchestrators now all calling setActionTargets at
          file top (commits a1f2cc2 + ea1f830), action_progress arrives
          within ms of task start, so re-gating on it gives both cards a
          synchronized entrance with no visible "right card alone" gap. */}
      {progress?.status === 'running' && (
        ((progress.action_progress && Object.keys(progress.action_progress).length > 0) ||
         (progress.tokens_used || 0) > 0) && (
          <div className="mb-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* 本次运行进度 — live X/Y per action type. */}
            {progress.action_progress && Object.keys(progress.action_progress).length > 0 && (
              <div className="rounded-xl border-2 border-green-500/50 bg-green-500/5 dark:bg-green-500/10 noobclaw-running-glow px-4 py-3">
                <div className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2 flex items-center gap-1.5">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  {isZh ? '本次运行进度' : 'Current Run Progress'}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  {(() => {
                    const ICONS: Record<string, string> = { like: '👍', follow: '➕', subscribe: '📌', comment: '💬', reply: '💬', post: '📤', download: '⬇️' };
                    const ORDER = ['like', 'follow', 'subscribe', 'comment', 'reply', 'post', 'download'];
                    const labels = isZh
                      ? { like: '赞', follow: '关注', comment: '评论', reply: '回复', subscribe: '订阅', post: '发帖', download: '下载' }
                      : { like: 'likes', follow: 'follows', comment: 'comments', reply: 'replies', subscribe: 'subs', post: 'posts', download: 'downloads' };
                    const ap = progress.action_progress || {};
                    // v6.x: 回复粉丝评论(xhs/douyin)= 「已回复评论数」+「文章进度 当前/总」,
                    //   不是「N/target 评论」。评论纯累计(无 target),文章扫描后才知道总数
                    //   (扫描前 target=0 → 显示 "-")。精确 id 门控,不碰其他场景。
                    if (scenario?.id === 'xhs_reply_fans_comment' || scenario?.id === 'douyin_reply_fans_comment' || scenario?.id === 'kuaishou_reply_fans_comment' || scenario?.id === 'bilibili_reply_fans_comment') {
                      const commentDone = (ap as any).comment?.done ?? 0;
                      const noteDone = (ap as any).note?.done ?? 0;
                      const noteTarget = (ap as any).note?.target ?? 0;
                      const articleWord = scenario?.id === 'xhs_reply_fans_comment'
                        ? (isZh ? '笔记' : 'notes')
                        : (isZh ? '作品' : 'videos');
                      const articleStr = noteTarget > 0 ? `${noteDone}/${noteTarget}` : '-';
                      return (
                        <>
                          <span className="font-mono text-gray-700 dark:text-gray-200">
                            💬 <strong className="text-green-600 dark:text-green-400">{commentDone > 0 ? commentDone : '-'}</strong>{' '}
                            <span className="text-xs text-gray-500 dark:text-gray-400 font-sans">{isZh ? '评论' : 'comments'}</span>
                          </span>
                          <span className="font-mono text-gray-700 dark:text-gray-200">
                            📄 <strong className="text-green-600 dark:text-green-400">{articleStr}</strong>{' '}
                            <span className="text-xs text-gray-500 dark:text-gray-400 font-sans">{articleWord}</span>
                          </span>
                        </>
                      );
                    }
                    const keys = Object.keys(ap).filter(k => (ap[k]?.target || 0) > 0 || (ap[k]?.done || 0) > 0).sort((a, b) => {
                      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
                      if (ia === -1 && ib === -1) return a.localeCompare(b);
                      if (ia === -1) return 1;
                      if (ib === -1) return -1;
                      return ia - ib;
                    });
                    return keys.map(k => {
                      const { done, target } = ap[k];
                      return (
                        <span key={k} className="font-mono text-gray-700 dark:text-gray-200">
                          {(ICONS[k] || '·')} <strong className="text-green-600 dark:text-green-400">{done}</strong>
                          <span className="text-gray-400 dark:text-gray-500">/{target}</span>{' '}
                          <span className="text-xs text-gray-500 dark:text-gray-400 font-sans">{(labels as any)[k] || k}</span>
                        </span>
                      );
                    });
                  })()}
                </div>
              </div>
            )}
            {/* 本次消耗 — live credits + USD cost climbing as AI calls
                land. Always renders during running (starts at 💎 0 ≈
                $0.0000 before the first AI call so the user can watch
                it tick up). Format mirrors the run history line
                "💎 21,973 ≈ $0.0220" — same emoji, same ≈ separator,
                so the user has a consistent mental anchor between
                "what's running right now" and "what the last run cost". */}
            <div className="rounded-xl border-2 border-green-500/50 bg-green-500/5 dark:bg-green-500/10 noobclaw-running-glow px-4 py-3">
              <div className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                {isZh ? '本次消耗' : 'Current Run Cost'}
              </div>
              <div className="flex items-baseline gap-2 text-sm font-mono text-gray-700 dark:text-gray-200">
                <span>💎</span>
                <strong className="text-green-600 dark:text-green-400 text-base">
                  {compactNumber(progress.tokens_used || 0)}
                </strong>
                <span className="text-gray-400 dark:text-gray-600">≈</span>
                <strong className="text-green-600 dark:text-green-400 text-base">
                  ${(progress.cost_usd || 0).toFixed(4)}
                </strong>
              </div>
            </div>
          </div>
        )
      )}

      {/* 矩阵号:各账号独立进度已移到「当前运行明细」上方做成账号 tab(见下方),不再在此单独成块。 */}

      {/* Stats — link-mode tasks AND run_interval='once' tasks are one-shot
           so the "下次运行" stat is meaningless; show only the first five.
           v5.x+: 6-card case used to be `lg:grid-cols-5` which produced a
           lonely "下次运行" sitting in a half-empty second row. Switched
           to `lg:grid-cols-3` so 6 cards stack as a clean 2×3 grid and
           5 cards (one-shot) stack as 3+2 — both layouts have at most
           one column of asymmetry, much tidier than 5+1. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        {/* 累计完成 — action_counts summed across all recorded runs, formatted
            by scenario family (engage shows 👍/➕/💬, post-creator shows 📤). */}
        <StatCard
          label={isZh ? '累计完成' : 'Total Done'}
          value={formatActionBreakdown(stats?.cumulative_action_counts || {}, scenario, isZh)}
          small
        />
        {/* 累计消耗 — credits + USD. token_price_per_million is baked into the
            per-run cost_usd by scenarioManager, so we just sum here. */}
        <StatCard
          label={isZh ? '累计消耗' : 'Total Cost'}
          value={formatCreditsCost(stats?.cumulative_tokens_used || 0, stats?.cumulative_cost_usd || 0, isZh)}
          small
        />
        {/* 上次完成 — same shape as 累计完成 but only the most recent run. */}
        <StatCard
          label={isZh ? '上次完成' : 'Last Done'}
          value={formatActionBreakdown(stats?.last_run_action_counts || {}, scenario, isZh)}
          small
        />
        {/* 上次消耗 — credits + USD for the most recent run. */}
        <StatCard
          label={isZh ? '上次消耗' : 'Last Cost'}
          value={formatCreditsCost(stats?.last_run_tokens_used || 0, stats?.last_run_cost_usd || 0, isZh)}
          small
        />
        <StatCard
          label={isZh ? '上次运行' : 'Last Run'}
          value={formatRelative(stats?.last_run_at || null, isZh)}
          small
          // Click on the "上次运行" stat → jump to Run History filtered
          // to THIS task. Lets users review every previous run without
          // hunting through the global history page.
          onClick={onOpenHistory}
          actionLabel={isZh ? '查看历史运行记录 →' : 'View run history →'}
        />
        {!isLinkModeForStats && (task as any).run_interval !== 'once' && (
          <StatCard
            label={isZh ? '下次运行' : 'Next Run'}
            value={(() => {
              // v4.25.4: 不再因 active=false 显示 "待命" —— scheduler 现在
              // 会跑所有 enabled 任务,active 仅 UI 高亮。
              // Prefer the pre-picked timestamp from the scheduler (set
              // after each run + on the first scheduler tick). With
              // daily_random the random offset is already baked in, so
              // we can show the exact wall-clock time. Fallback to the
              // old "elapsed since last_run" estimate if missing
              // (older tasks pre-v2.4.25 might not have it yet).
              const planned = (task as any).next_planned_run_at as number | undefined;
              if (planned && planned > Date.now()) {
                const diff = planned - Date.now();
                const mins = Math.round(diff / 60000);
                let rel: string;
                if (mins < 60) rel = mins + (isZh ? ' 分钟后' : 'm');
                else if (mins < 24 * 60) rel = Math.round(mins / 60) + (isZh ? ' 小时后' : 'h');
                else rel = Math.round(mins / (60 * 24)) + (isZh ? ' 天后' : 'd');
                // Absolute time formatting:
                //   today    "今天 11:23"
                //   tomorrow "明天 11:23"
                //   else     "MM/DD 11:23"
                const d = new Date(planned);
                const sameDay = (a: Date, b: Date) =>
                  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
                const now = new Date();
                const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
                const hh = String(d.getHours()).padStart(2, '0');
                const mm = String(d.getMinutes()).padStart(2, '0');
                const datePart = sameDay(d, now)      ? (isZh ? '今天' : 'today')
                              : sameDay(d, tomorrow)  ? (isZh ? '明天' : 'tmrw')
                              : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
                return `${rel} · ${datePart} ${hh}:${mm}`;
              }
              // Fallback: old heuristic for tasks without next_planned_run_at yet
              const interval = (task as any).run_interval || 'daily';
              const lastRun = stats?.last_run_at;
              if (!lastRun) return isZh ? '即将（计算中）' : 'Soon (calc)';
              const intervals: Record<string, number> = { '30min': 30*60*1000, '1h': 60*60*1000, '3h': 3*60*60*1000, '6h': 6*60*60*1000, 'daily': 24*60*60*1000, 'daily_random': 24*60*60*1000 };
              const ms = intervals[interval] || 24*60*60*1000;
              const next = lastRun + ms;
              if (next <= Date.now()) return isZh ? '即将' : 'Soon';
              const diff = next - Date.now();
              const mins = Math.round(diff / 60000);
              if (mins < 60) return mins + (isZh ? ' 分钟后' : ' min');
              return Math.round(mins / 60) + (isZh ? ' 小时后' : ' hr');
            })()}
            small
          />
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`mb-4 rounded-xl px-4 py-3 text-sm ${
          toast.kind === 'ok' ? 'bg-green-500/10 border border-green-500/30 text-green-500'
            : toast.kind === 'warn' ? 'bg-amber-500/10 border border-amber-500/30 text-amber-500'
            : 'bg-red-500/10 border border-red-500/30 text-red-500'
        }`}>{toast.text}</div>
      )}

      {/* 当前运行明细 — labeled "current" because it shows ONLY this run's
          live step logs. Historical runs live on the dedicated Run History
          page (linked above via the "📊 查看历史运行记录" button). */}
      {(() => {
        const autoUploadMode = (task as any).auto_upload !== false;
        // v6.x: 视频无水印下载任务(xhs/douyin/tiktok)只下载到本地,没有"上传草稿箱
        // / 发布到平台"的概念。之前 auto_upload 没设 → autoUploadMode=true → 误显
        // "📤 自动上传到草稿箱"。这里单独出一个"⬇️ 下载到本地"徽章。
        const isVideoDownloadTask = scenario?.id === 'xhs_video_download'
          || scenario?.id === 'douyin_video_download'
          || scenario?.id === 'tiktok_video_download'
          || scenario?.id === 'kuaishou_video_download'
          || scenario?.id === 'bilibili_video_download';
        // 发布模式 badge:三个 creator 场景都有 auto_upload 切换(见 ConfigWizard)。
        // 只有 auto_reply 场景没有这个概念(回复永远直接发)。
        // ⚠️ 文案按平台区分 —— "草稿箱"只适用 XHS(XHS 独有的"上传到小红书草稿箱"模型);
        // 推特/币安是"直接发到平台"模型,label 要写"发布到 推特/币安广场"。
        const showUploadBadge = !isAutoReplyTask && !isVideoDownloadTask;
        const isXhsViral = scenario?.platform === 'xhs';
        const autoUploadLabel = isXhsViral
          ? (isZh ? '📤 自动上传到草稿箱' : '📤 Auto-upload to drafts')
          : (isZh ? `🚀 自动发布到${platformLabelForTask}` : `🚀 Auto-post to ${platformLabelForTask}`);
        // 矩阵号:各账号独立日志在 progress.accounts[].logs(步骤视图 progress.steps 对矩阵任务基本是空的)。
        // 在「当前运行明细」上方放一排账号 tab,点 tab 切换显示该账号的运行明细;默认选第一个账号。
        const matrixAccts = progress?.accounts || [];
        const hasAccts = matrixAccts.length > 0;
        // 矩阵号发布时若有账号登录过期(日志里点名过),尾巴上给个跳转「我的矩阵账号」的按钮去重扫;没有就不显示。
        const loginExpired = hasAccts && (progress?.steps || []).some((s: { logs?: Array<{ message?: string }> }) =>
          (s.logs || []).some((l) => typeof l.message === 'string' && l.message.includes('登录过期')));
        const selAcct = hasAccts
          ? (acctTab && matrixAccts.some(a => a.id === acctTab) ? acctTab : matrixAccts[0].id)
          : null;
        // 运行明细各账号 tab 上展示头像/昵称/平台号(从账号详情按 id join,方便辨别;运行进度本身只带 name=备注)。
        const detailById = new Map<string, any>(acctDetails.map((d: any) => [d.id, d]));
        const PLID: Record<string, string> = { douyin: '抖音号', xhs: '小红书号', bilibili: 'B站号', kuaishou: '快手号', tiktok: 'TikTok号', x: '推特号', binance: '币安号', youtube: 'YouTube号', shipinhao: '视频号', toutiao: '头条号' };
        const PLATFORM_EMOJI: Record<string, string> = { douyin: '🎵', xhs: '📕', bilibili: '📺', kuaishou: '⚡', tiktok: '🎬', x: '🐦', binance: '🟡', youtube: '▶️', shipinhao: '🟢', toutiao: '🟠' };
        return (
          <>
            <div className="flex items-center justify-between mb-4 gap-3">
              <h2 className="text-base font-bold dark:text-white">{isZh ? '当前运行明细' : 'Current Run Details'}</h2>
              {isVideoDownloadTask ? (
                <span className="text-xs px-2.5 py-1 rounded-full border bg-blue-500/10 text-blue-500 border-blue-500/30">
                  {isZh ? '⬇️ 自动下载到本地' : '⬇️ Auto-download to local'}
                </span>
              ) : showUploadBadge ? (
                <span className={`text-xs px-2.5 py-1 rounded-full border ${autoUploadMode ? 'bg-green-500/10 text-green-500 border-green-500/30' : 'bg-blue-500/10 text-blue-500 border-blue-500/30'}`}>
                  {autoUploadMode
                    ? autoUploadLabel
                    : (isZh ? '📁 仅生成保存本地' : '📁 Generate only')}
                </span>
              ) : (
                <span className="text-xs px-2.5 py-1 rounded-full border bg-cyan-500/10 text-cyan-500 border-cyan-500/30">
                  {isXTask
                    ? (isZh ? `🐦 直接发布到 ${platformLabelForTask}` : `🐦 Posts directly to ${platformLabelForTask}`)
                    : (isZh ? `💬 直接发布到 ${platformLabelForTask}` : `💬 Posts directly to ${platformLabelForTask}`)}
                </span>
              )}
            </div>
            {/* 矩阵号:本次有账号登录过期 → 提示 + 跳「我的矩阵账号」去重扫(复用全局事件,App 切到 matrix 页)。 */}
            {loginExpired && (
              <div className="mb-4 flex items-center flex-wrap gap-2 text-xs px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
                <span className="text-red-500 font-medium">⚠️ 本次有账号登录过期,需重新扫码登录</span>
                <button onClick={() => window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: {} }))} className="ml-auto px-2.5 py-1 rounded-lg bg-violet-500 hover:bg-violet-600 text-white">去我的矩阵账号处理 →</button>
              </div>
            )}
            {/* 矩阵号:账号 tab —— 点一个号切换显示它独立的运行明细(各号配额 + 完成数也在 tab 上)。 */}
            {hasAccts && (
              <div className="flex flex-wrap gap-2 mb-4">
                {matrixAccts.map(a => {
                  const ap = a.action_progress || {};
                  const active = selAcct === a.id;
                  const d = detailById.get(a.id) || {};
                  const title = d.nickname || a.name;          // 主标题:平台真实昵称(没有就退回备注名)
                  const note = a.name && a.name !== title ? a.name : '';  // 副标题:备注名(跟昵称不同才显示)
                  const dot = (a.status === 'success' || a.status === 'done') ? 'bg-green-500'
                    : (a.status === 'failed' || a.status === 'error') ? 'bg-red-500'
                    : a.status === 'skipped' ? 'bg-gray-400'
                    : 'bg-blue-500 animate-pulse';
                  return (
                    <button key={a.id} type="button" onClick={() => setAcctTab(a.id)}
                      className={`text-left rounded-lg border px-3 py-2 text-xs transition-colors max-w-[15rem] ${active ? 'border-green-500 bg-green-500/10' : 'border-gray-200 dark:border-gray-700 hover:border-green-500/50'}`}>
                      <div className="flex items-center gap-1.5 font-medium dark:text-gray-200">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                        {d.avatar
                          ? <img src={d.avatar} alt="" className="w-4 h-4 rounded-full shrink-0 object-cover" />
                          : <span className="text-xs shrink-0">{PLATFORM_EMOJI[d.platform] || '👤'}</span>}
                        <span className="truncate">{title}</span>
                        {d.displayId && <span className="text-gray-400 font-normal shrink-0">· {PLID[d.platform] || '账号'}:{d.displayId}</span>}
                      </div>
                      {note && <div className="mt-0.5 text-[10px] text-gray-400 truncate">备注 {note}</div>}
                      <div className="mt-1 font-mono text-gray-600 dark:text-gray-300">
                        👍 {ap.like?.done ?? 0}/{ap.like?.target ?? 0} · ➕ {ap.follow?.done ?? 0}/{ap.follow?.target ?? 0} · 💬 {ap.comment?.done ?? 0}/{ap.comment?.target ?? 0}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {hasAccts ? (
              // 选中账号的运行明细(矩阵任务真实日志在账号维度;步骤视图对矩阵基本为空)。
              (() => {
                const a = matrixAccts.find(x => x.id === selAcct);
                if (!a) return null;
                const acctDone = a.status === 'success' || a.status === 'done' || a.status === 'failed' || a.status === 'error' || a.status === 'skipped';
                return (
                  <div className="rounded-xl border border-gray-200 dark:border-gray-700 min-h-[60px]">
                    <StepLogBox logs={a.logs} isActive={progress?.status === 'running' && !acctDone} renderLogMessage={renderLogMessage} />
                  </div>
                );
              })()
            ) : (
            <>
            {/* v?.x: 运行明细顶部原有一条醒目「打开输出目录」大按钮,但头部「输出目录:」
                那行已经带了链接 + 按钮,这里重复 → 按用户反馈移除,避免一页两个同功能入口。 */}
            <div className="space-y-4">
              {STEP_NAMES.map((n, i) => ({ name: n, idx: i })).map(({ name, idx }) => {
          const stepNum = idx + 1;
          const sp = progress?.steps?.[idx];
          const status = sp?.status || 'waiting';
          const logs = sp?.logs || [];
          const isActive = status === 'running';
          const isDone = status === 'done';
          const isError = status === 'error';

          // 仅生成模式的 step 4：不跑上传，替换为"打开本地目录 + 手动上传指引"。
          // ⚠️ 只适用 XHS viral_production:它的 auto_upload=false 是"图文存盘→
          // 用户打开文件夹→手动上传到草稿箱"。其他场景:
          //   - 推特 post_creator: 只有 3 步,没 stepNum===4
          //   - 币安 post_creator: step 4 是"发布";auto_upload=false 时 orchestrator
          //     已经把正文写进了页面编辑器,用户手动点"发文"即可,不需要"打开文件夹" UI
          const isManualUploadStep = isXhsViral && stepNum === 4 && !autoUploadMode;
          const displayName = isManualUploadStep
            ? (isZh ? '请在本地手动上传到小红书草稿箱' : 'Manually upload from local folder')
            : name;
          return (
            <div key={idx}>
              <div className={`text-sm font-medium mb-2 ${
                isActive ? 'text-green-500' : isDone ? 'text-green-600 dark:text-green-400' : isError ? 'text-red-500' : 'dark:text-gray-300'
              }`}>
                {STEP_LABELS[idx]}. {displayName}
              </div>
              <div className={`rounded-xl border min-h-[60px] ${
                isManualUploadStep ? 'border-blue-500/30 bg-blue-500/5'
                  : isActive ? 'border-green-500/30 bg-green-500/5'
                  : isDone ? 'border-green-500/20 bg-green-500/5'
                  : isError ? 'border-red-500/20 bg-red-500/5'
                  : 'border-gray-200 dark:border-gray-700'
              }`}>
                {isManualUploadStep ? (
                  <div className="p-4 text-xs dark:text-gray-300 space-y-2">
                    <p>{isZh ? '已生成的标题、正文、配图都保存在本地。打开下方文件夹，自己挑选文章并手动上传到小红书草稿箱（每篇 ≤3 篇/天可降低封号风险）。' : 'Generated titles, bodies and images are saved locally. Open the folder below and manually upload to XHS drafts (≤3/day to reduce ban risk).'}</p>
                    <button
                      type="button"
                      onClick={openTaskDir}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                    >
                      📂 {isZh ? '打开本地文件夹' : 'Open folder'}
                    </button>
                  </div>
                ) : logs.length > 0 ? (
                  <StepLogBox logs={logs} isActive={isActive} renderLogMessage={renderLogMessage} />
                ) : (
                  <div className="text-xs text-gray-500 dark:text-gray-400 text-center py-4">
                    {running ? (
                      // v2.4.67: 任务正在跑但这一步还没拿到 log 事件 — 区分
                      // step 1 (尚未启动 / 正在初始化) 和 step >1 (等前一步)
                      stepNum === 1
                        ? (isZh ? '⏳ 正在启动…(后端流式日志稍候)' : '⏳ Starting…')
                        : (isZh ? '等待前一步' : 'Waiting for previous step')
                    ) : stepNum === 1 ? (() => {
                      const interval = (task as any).run_interval || 'daily';
                      // Calculate next run time
                      const lastRun = stats?.last_run_at;
                      const intervals: Record<string, number> = { '30min': 30*60*1000, '1h': 60*60*1000, '3h': 3*60*60*1000, '6h': 6*60*60*1000, 'daily': 24*60*60*1000, 'daily_random': 24*60*60*1000 };
                      const ms = intervals[interval] || 24*60*60*1000;
                      let nextRunStr = '';
                      if (lastRun) {
                        const next = lastRun + ms;
                        if (next <= Date.now()) {
                          nextRunStr = isZh ? '即将运行' : 'Running soon';
                        } else {
                          const diff = next - Date.now();
                          const mins = Math.round(diff / 60000);
                          nextRunStr = mins < 60
                            ? (isZh ? mins + ' 分钟后运行' : 'Run in ' + mins + ' min')
                            : (isZh ? Math.round(mins/60) + ' 小时后运行' : 'Run in ' + Math.round(mins/60) + 'h');
                        }
                      } else {
                        nextRunStr = isZh ? '点击"直接运行"开始' : 'Click "Run Now" to start';
                      }
                      return nextRunStr;
                    })() : (isZh ? '等待前一步' : 'Waiting for previous step')}
                  </div>
                )}
              </div>
            </div>
          );
        })}
            </div>
            </>
            )}
          </>
        );
      })()}


      {loginModalOpen && (() => {
        // v5.x+ fix: scenario 可能是 null(scenarios 列表还在后台拉)。这种
        // race 下原版三元表达式 fallthrough 到 'xhs',导致币安/抖音任务的
        // 运行前检查 modal 显示"小红书"字样。改成 scenario.platform 优先,
        // 缺失时按 task.scenario_id 前缀兜底推断。顺带把 'douyin' 补上。
        type LP = 'x' | 'xhs' | 'binance' | 'tiktok' | 'youtube' | 'douyin' | 'kuaishou' | 'bilibili' | 'shipinhao' | 'toutiao';
        const sid = String(task.scenario_id || '');
        const inferFromId: LP = sid.startsWith('binance_') ? 'binance'
          : sid.startsWith('x_') ? 'x'
          : sid.startsWith('youtube_') ? 'youtube'
          : sid.startsWith('tiktok_') ? 'tiktok'
          : sid.startsWith('douyin_') ? 'douyin'
          : sid.startsWith('kuaishou_') ? 'kuaishou'
          : sid.startsWith('bilibili_') ? 'bilibili'
          : sid.startsWith('shipinhao_') ? 'shipinhao'
          : sid.startsWith('toutiao_') ? 'toutiao'
          : 'xhs';
        const sp = scenario?.platform;
        // 视频 platform 的 scenario task(2026-06 翻译二创删除后暂无,保留分支
        // 以防后续再加 video 平台 scenario):登录检查认【源平台】(去那下载无水印源),
        // 不是 xhs。auto 模式取 source_platforms[0];手动贴链接兜底抖音(最常见源)。
        const LP_SET: LP[] = ['x', 'xhs', 'binance', 'tiktok', 'youtube', 'douyin', 'kuaishou', 'bilibili', 'shipinhao', 'toutiao'];
        const videoSrc = String(
          (Array.isArray((task as any).source_platforms) && (task as any).source_platforms[0])
          || (task as any).source_platform || '',
        );
        const platform: LP = sp === 'video'
          ? ((LP_SET as string[]).includes(videoSrc) ? (videoSrc as LP) : 'douyin')
          : ((sp === 'x' || sp === 'xhs' || sp === 'binance'
            || sp === 'tiktok' || sp === 'youtube' || sp === 'douyin'
            || sp === 'kuaishou' || sp === 'bilibili'
            || sp === 'shipinhao' || sp === 'toutiao')
            ? sp
            : inferFromId);
        return (
          <LoginRequiredModal
            mode="run"
            platform={platform}
            secondaryPlatform={
              (task.scenario_id === 'binance_from_x_repost' || task.scenario_id === 'binance_from_x_link') ? 'x' :
              task.scenario_id === 'binance_from_xhs_viral' ? 'xhs' :
              task.scenario_id === 'binance_from_douyin_viral' ? 'douyin' :
              task.scenario_id === 'binance_from_tiktok_viral' ? 'tiktok' :
              undefined
            }
            /* v6.x: 只有 publish-to-creator-center 类场景才检查 creator 子域登录。
               douyin_auto_engage / xhs_auto_reply_universal 只用主站交互,不要
               卡 creator 中心(否则用户每次 run 任务都得开 creator tab,体验差)。
               xhs_reply_fans_comment 从创作者中心抓自己的笔记列表,然后跳主站
               详情页发回复 — 两个站都要登录,所以也要 requireCreatorCenter。 */
            requireCreatorCenter={
              task.scenario_id === 'douyin_image_text'
              || task.scenario_id === 'xhs_image_text'
              || task.scenario_id === 'xhs_viral_production_career'
              || task.scenario_id === 'xhs_reply_fans_comment'
              || task.scenario_id === 'douyin_reply_fans_comment'
              || task.scenario_id === 'kuaishou_reply_fans_comment'
              || task.scenario_id === 'bilibili_reply_fans_comment'
            }
            /* douyin_reply_fans_comment 全程在创作者中心评论管理页操作,不碰
               www.douyin.com 主站 → 只校验创作者中心,跳过主站 tab 检查。
               快手创作者服务平台 / B站创作中心评论管理同理。 */
            creatorOnly={
              task.scenario_id === 'douyin_reply_fans_comment'
              || task.scenario_id === 'kuaishou_reply_fans_comment'
              || task.scenario_id === 'bilibili_reply_fans_comment'
            }
            onCancel={() => setLoginModalOpen(false)}
            onConfirmed={handleLoginConfirmed}
          />
        );
      })()}
    </div>
  );
};

/**
 * Format the per-run / cumulative `action_counts` map into a single-line
 * display string for the StatCard. Picks icons based on scenario family:
 *   auto_engage   → 👍 like / ➕ follow / 💬 comment (or 📌 subscribe)
 *   post_creator  → 📤 post (single counter)
 *
 * Returns "-" when the map is empty, so pre-rollout runs render cleanly
 * (those have no action_counts) instead of "0 0 0".
 */
function formatActionBreakdown(
  counts: Record<string, number> | undefined,
  scenario: any,
  isZh: boolean,
): string {
  // v5.x+: when counts is missing/empty, derive engage- or post-family
  // placeholder keys from the scenario id so brand-new engage tasks
  // render "累计完成: 👍 0 · 💬 0 · ➕ 0" (the full 3-pronged
  // breakdown the user expects to see for like/comment/follow tasks)
  // instead of a lone "-". Pre-rollout records hit this same path; we
  // accept "showing 0/0/0 on truly-empty rows" as the right trade-off
  // since the alternative ("-") makes the card look broken.
  const sid = String(scenario?.id || '');
  if (!counts || Object.keys(counts).length === 0) {
    const isPostScenario = (
      sid === 'binance_square_post_creator' ||
      sid === 'x_post_creator' ||
      sid === 'binance_from_x_repost' ||
      sid === 'binance_from_x_link' ||
      sid === 'x_link_rewrite' ||
      sid === 'douyin_image_text' ||
      sid === 'xhs_image_text' ||  // ← v6.x: 之前漏了, addActionCount('post') 写在 line 937
      sid === 'xhs_viral_production_career' ||
      // v6.x: 3 个新 source-viral 搬运也是 post-family,不加进来 fallthrough '-'
      sid === 'binance_from_xhs_viral' ||
      sid === 'binance_from_douyin_viral' ||
      sid === 'binance_from_tiktok_viral'
    );
    const isEngageScenario = !isPostScenario && (
      sid.endsWith('_auto_engage')
      || sid === 'xhs_auto_reply_universal'
      || sid === 'xhs_reply_fans_comment'
    );
    // v6.x: 视频无水印下载(xhs/douyin/tiktok)— 完成数按"下载条数"算,空时显示 ⬇️ 0 下载。
    const isDownloadScenario = (
      sid === 'xhs_video_download'
      || sid === 'douyin_video_download'
      || sid === 'tiktok_video_download'
      || sid === 'kuaishou_video_download'
      || sid === 'bilibili_video_download'
    );
    if (isDownloadScenario) {
      counts = { download: 0 };
    } else if (isPostScenario) {
      counts = { post: 0 };
    } else if (isEngageScenario) {
      // xhs_reply_fans_comment 只产生 'comment' 计数,不发 like/follow;
      // 其他 engage 场景三档都跑 — 这里用 sid 区分,避免显示 "👍 0 · ➕ 0" 误导用户
      // (回复粉丝评论不会涨赞数 / 不会关注新人)。
      counts = sid === 'xhs_reply_fans_comment' ? { comment: 0 } : { like: 0, comment: 0, follow: 0 };
    } else {
      return '-';
    }
  }
  // Engage-family icons. 'comment' covers replies too (xhs / x both map
  // their reply types to 'comment' to match Douyin's bucketing).
  const ICONS: Record<string, string> = {
    like: '👍',
    follow: '➕',
    comment: '💬',
    reply: '💬',
    subscribe: '📌',
    post: '📤',
    download: '⬇️',
  };
  const ORDER = ['like', 'follow', 'subscribe', 'comment', 'reply', 'post', 'download'];
  // v5.x+: keep 0-count keys when they're explicitly present in the map.
  // Pre-rollout records have no action_counts → empty map → the early
  // return on line above handles those. Newer runs that DID call
  // setActionTargets but stopped before any action completed will
  // arrive here with { like:0, follow:0, comment:0 } — we want to show
  // those as "👍 0 · ➕ 0 · 💬 0", not collapse them to "-". Sort by
  // ORDER first, then unknown keys alphabetically — keeps engage line
  // in 👍 ➕ 💬 order regardless of insertion order.
  const keys = Object.keys(counts)
    // 'note'(回复粉丝场景的文章进度内部计数)只在「本次运行进度」实时卡里展示;
    //   累计/上次完成里只看评论数,过滤掉,避免中文下出现未翻译的原始 "note"。
    .filter(k => typeof counts[k] === 'number' && k !== 'note')
    .sort((a, b) => {
      const ia = ORDER.indexOf(a);
      const ib = ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  if (keys.length === 0) return '-';
  const labels = isZh
    ? { like: '赞', follow: '关注', comment: '评论', reply: '回复', subscribe: '订阅', post: '发帖', download: '下载' }
    : { like: 'likes', follow: 'follows', comment: 'comments', reply: 'replies', subscribe: 'subs', post: 'posts', download: 'downloads' };
  return keys.map(k => {
    const icon = ICONS[k] || '·';
    const label = (labels as any)[k] || k;
    return `${icon} ${counts[k]} ${label}`;
  }).join(' · ');
}

/**
 * Compact number: 123 → '123', 9939 → '9.94K', 1234567 → '1.23M', 1.5e9 → '1.5B'.
 * Used for credits / tokens — full int gets bulky past 4-5 digits.
 */
function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000)     return (n / 1_000).toFixed(abs < 10_000 ? 2 : 1) + 'K';
  if (abs < 1_000_000_000) return (n / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1) + 'M';
  return (n / 1_000_000_000).toFixed(abs < 10_000_000_000 ? 2 : 1) + 'B';
}

/**
 * Format credits + USD cost for the 累计消耗 / 上次消耗 cards.
 * v1.x: compact K/M/B units (per user feedback — '9,939' too noisy).
 */
function formatCreditsCost(credits: number, costUsd: number, _isZh: boolean): string {
  if (!credits || credits <= 0) return '-';
  const c = Math.round(credits);
  const usd = (Number(costUsd) || 0).toFixed(4);
  return `💎 ${compactNumber(c)} ≈ $${usd}`;
}

const StatCard: React.FC<{
  label: string;
  value: string | number;
  small?: boolean;
  /** Optional click handler — turns the whole card into a button. Used
   *  for "上次运行" → opens the run history page filtered to this task. */
  onClick?: () => void;
  /** Tiny CTA shown at the bottom-right of the card when onClick is set,
   *  e.g. "查看历史运行记录 →". Helps the user know the card is clickable. */
  actionLabel?: string;
}> = ({ label, value, small, onClick, actionLabel }) => {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`text-left w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3 ${
        onClick ? 'hover:border-green-500/50 transition-colors cursor-pointer' : ''
      }`}
    >
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className={`font-bold dark:text-white ${small ? 'text-sm' : 'text-2xl'}`}>{value}</div>
      {onClick && actionLabel && (
        <div className="text-[10px] text-green-500 dark:text-green-400 mt-1 truncate">{actionLabel}</div>
      )}
    </Tag>
  );
};

export default TaskDetailPage;
