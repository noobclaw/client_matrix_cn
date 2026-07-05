/**
 * SourcePickerModal — 币安搬运任务的"选源"前置 modal。
 *
 * v6.x 新增:币安搬运从单一源(X / 推特)扩展到 4 个源(X / XHS / 抖音 / TikTok)。
 * 用户在 BinanceWorkflowsPage 点"批量搬运"卡 → 弹本 modal 选源 → 选完后:
 *   - 'x'       → 沿用现有 binance_from_x_repost 流程(LoginRequiredModal + ConfigWizard)
 *   - 'xhs'     → binance_from_xhs_viral 新流程
 *   - 'douyin'  → binance_from_douyin_viral 新流程
 *   - 'tiktok'  → binance_from_tiktok_viral 新流程(只视频)
 *
 * UI:简单 4 卡片网格,点一下就 onPick(source)。Cancel 关掉。
 */

import React from 'react';
import { i18nService } from '../../services/i18n';

export type RepostSource = 'x' | 'xhs' | 'douyin' | 'tiktok';

interface Props {
  onPick: (source: RepostSource) => void;
  onCancel: () => void;
}

interface SourceCard {
  source: RepostSource;
  emoji: string;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
  /** Color accent — 跟各平台 brand 颜色挂钩,viz 区分 */
  color: string;
}

const SOURCES: SourceCard[] = [
  {
    source: 'x',
    emoji: '🐦',
    titleZh: '推特 (X)',
    titleEn: 'Twitter (X)',
    descZh: '从你的 X feed 挑爆款帖(图文/视频),AI 改写到币安风格,带原图视频搬运。',
    descEn: 'Pull viral tweets (image/video) from your X feed, AI rewrite in Binance style, repost with original media.',
    color: '#1DA1F2',
  },
  {
    source: 'xhs',
    emoji: '📕',
    titleZh: '小红书',
    titleEn: 'Xiaohongshu',
    descZh: '按你的关键词检索小红书一周(数据不够延半年)爆文,AI 改写,图文/视频带原素材搬到币安。',
    descEn: 'Search Xiaohongshu by keywords (1-week, fallback 6-month), AI rewrite, repost image/video to Binance.',
    color: '#FF2442',
  },
  {
    source: 'douyin',
    emoji: '🎵',
    titleZh: '抖音',
    titleEn: 'Douyin',
    descZh: '按关键词搜抖音(优先一周),AI 改写文案,视频去水印 + 图文一并搬到币安。',
    descEn: 'Search Douyin by keywords (prefer last week), AI rewrite, watermark-removed video + image-text repost to Binance.',
    color: '#FE2C55',
  },
  {
    source: 'tiktok',
    emoji: '🎬',
    titleZh: 'TikTok',
    titleEn: 'TikTok',
    descZh: '按英文关键词搜 TikTok,AI 改写文案(中/英可选),视频去水印搬到币安。仅视频。',
    descEn: 'Search TikTok by EN keywords, AI rewrite (zh/en optional), watermark-removed video repost to Binance. Video only.',
    color: '#25F4EE',
  },
];

export const SourcePickerModal: React.FC<Props> = ({ onPick, onCancel }) => {
  const isZh = i18nService.currentLanguage === 'zh';
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-4">
          <h3 className="text-lg font-bold dark:text-white mb-1">
            {isZh ? '📦 选择搬运源' : '📦 Pick a Source'}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {isZh
              ? '从哪个平台搬运到币安广场?选完后会进入对应的运行检查 + 配置流程。'
              : 'Which platform to pull from? You\'ll then go through the matching login check + config flow.'}
          </p>
        </div>

        <div className="px-6 pb-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SOURCES.map((s) => (
            <button
              key={s.source}
              type="button"
              onClick={() => onPick(s.source)}
              className="text-left p-4 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-all group"
              style={{ borderLeftWidth: 4, borderLeftColor: s.color }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-2xl" aria-hidden>{s.emoji}</span>
                <span className="text-sm font-bold dark:text-white">
                  {isZh ? s.titleZh : s.titleEn}
                </span>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">
                {isZh ? s.descZh : s.descEn}
              </p>
            </button>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex justify-end gap-2 bg-gray-50 dark:bg-gray-900/50">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-xs font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
          >
            {isZh ? '取消' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SourcePickerModal;
