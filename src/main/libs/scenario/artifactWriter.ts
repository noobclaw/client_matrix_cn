/**
 * Artifact writer — saves scenario outputs to ~/Documents/NoobClaw/
 *
 * Directory structure:
 *   <Documents>/NoobClaw/<platform>/
 *     <taskId>_<taskName>/
 *       <YYYY-MM-DD>/
 *         <batch>/                  ← 批次 (1, 2, 3...)
 *           原文/
 *             文章1_标题.md
 *           改写/
 *             1-改写-新标题.md
 */

import fs from 'fs';
import path from 'path';
import { coworkLog } from '../coworkLogger';
import { isElectronMode } from '../platformAdapter';
import type { ScenarioTask, Draft, DiscoveredNote, ComposedVariant } from './types';

let appRef: any = null;
try {
  if (isElectronMode()) {
    appRef = require('electron').app;
  }
} catch {}

function getDocsRoot(): string {
  let base = appRef?.getPath?.('documents');
  if (!base) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    base = path.join(home, 'Documents');
  }
  return path.join(base, 'NoobClaw');
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sanitize(name: string): string {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim() || 'unnamed';
}

// NOTE: Don't add `binance: '币安广场'` here — earlier binance task runs
// landed in `<docs>/binance/...` (English fallback because the entry was
// missing), so adding the Chinese name now would split historical data
// across two folders. Keep the English fallback for binance to match what's
// already on disk.
const PLATFORM_NAMES: Record<string, string> = {
  xhs: '小红书',
  x: '推特',
  douyin: '抖音',
  kuaishou: '快手',
  bilibili: '哔哩哔哩',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  reddit: 'Reddit',
};

/**
 * Infer platform from task.scenario_id when caller didn't pass one.
 * Without this, callers that defaulted to 'xhs' would land twitter/binance
 * task artifacts under 小红书/, and the UI's "open output folder" button
 * would open the wrong directory.
 *
 * All scenario ids follow `<platform>_<rest>` (xhs_*, x_*, binance_*).
 */
function inferPlatformFromTask(task: ScenarioTask): string {
  const sid = (task && task.scenario_id) || '';
  if (sid.startsWith('xhs_')) return 'xhs';
  if (sid.startsWith('x_')) return 'x';
  if (sid.startsWith('binance_')) return 'binance';
  if (sid.startsWith('tiktok_')) return 'tiktok';
  if (sid.startsWith('youtube_')) return 'youtube';
  // ⚠️ 之前漏了 douyin_ 分支 — 所有抖音任务 fall through 到默认 'xhs',输出
  //   目录全跑去了 ~/Documents/NoobClaw/小红书/<douyin_task>/... 而不是 抖音/。
  //   用户反馈"抖音视频无水印下载的输出目录不对"才发现。PLATFORM_NAMES.douyin
  //   一直都有"抖音"映射,只是 inferPlatformFromTask 没把抖音 sid 喂进来。
  if (sid.startsWith('douyin_')) return 'douyin';
  if (sid.startsWith('kuaishou_')) return 'kuaishou';
  if (sid.startsWith('bilibili_')) return 'bilibili';
  if (sid.startsWith('instagram_')) return 'instagram';
  if (sid.startsWith('facebook_')) return 'facebook';
  if (sid.startsWith('reddit_')) return 'reddit';
  return 'xhs';
}

const TRACK_NAMES: Record<string, string> = {
  career_side_hustle: '副业赚钱',
  indie_dev: '独立开发',
  personal_finance: '理财攻略',
  travel: '旅行攻略',
  food: '美食探店',
  outfit: '穿搭分享',
  beauty: '美妆测评',
  fitness: '健身减脂',
  reading: '读书笔记',
  parenting: '育儿亲子',
  exam_prep: '考试备考',
  pets: '宠物日常',
  home_decor: '家居好物',
  study_method: '学习效率',
  career_growth: '职场成长',
  emotional_wellness: '情感心理',
  photography: '摄影分享',
  crafts: '手工DIY',
};

/** Find next batch number for today */
function getNextBatch(dayDir: string): number {
  try {
    if (!fs.existsSync(dayDir)) return 1;
    const entries = fs.readdirSync(dayDir);
    let max = 0;
    for (const e of entries) {
      const n = parseInt(e, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max + 1;
  } catch {
    return 1;
  }
}

// Cache batch number per day+task to keep consistent within ONE task run.
// Cleared by startNewBatch() at the start of each new run so that multiple
// manual runs on the same day get successive batch dirs (1, 2, 3, ...).
const batchCache = new Map<string, number>();

/** Get the output directory for a task run */
export function getTaskOutputDir(task: ScenarioTask, platform?: string): string {
  const p = platform || inferPlatformFromTask(task);
  const platformName = PLATFORM_NAMES[p] || p;
  const trackName = TRACK_NAMES[task.track] || task.track || 'unknown';
  const taskFolder = sanitize(task.id.slice(0, 8) + '_' + trackName);
  const dayDir = path.join(getDocsRoot(), platformName, taskFolder, todayStr());

  const cacheKey = task.id + '/' + todayStr();
  let batch = batchCache.get(cacheKey);
  if (!batch) {
    batch = getNextBatch(dayDir);
    batchCache.set(cacheKey, batch);
  }

  return path.join(dayDir, String(batch));
}

/**
 * Drop the cached batch number for this task so the NEXT call to
 * getTaskOutputDir() allocates a fresh batch dir (scanning the day dir
 * again). Call this at the START of each task run, not at the end —
 * otherwise concurrent saveDrafts within one run would split across dirs.
 */
export function startNewBatch(taskId: string): void {
  const key = taskId + '/' + todayStr();
  batchCache.delete(key);
}

// ── Markdown renderers ──

function renderOriginalMd(post: DiscoveredNote, index: number): string {
  const lines: string[] = [];
  lines.push(`# ${post.title || '(untitled)'}`);
  lines.push('');
  lines.push(`- **平台**: 小红书`);
  lines.push(`- **链接**: ${post.external_url}`);
  lines.push(`- **作者**: ${post.author_name || '未知'}`);
  lines.push(`- **点赞**: ${post.metrics?.likes ?? 0}`);
  lines.push(`- **采集时间**: ${new Date(post.metrics?.collected_at || Date.now()).toLocaleString()}`);
  lines.push('');
  lines.push('## 正文');
  lines.push('');
  lines.push((post.body || '').replace(/\r\n/g, '\n'));
  lines.push('');
  if (post.hashtags && post.hashtags.length > 0) {
    lines.push('## 标签');
    lines.push('');
    lines.push(post.hashtags.map(h => `#${h}`).join(' '));
    lines.push('');
  }
  if (post.images && post.images.length > 0) {
    lines.push('## 图片');
    lines.push('');
    for (const src of post.images) lines.push(`- ${src}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderRewriteMd(variant: ComposedVariant, sourceTitle: string): string {
  const lines: string[] = [];
  lines.push(`# ${variant.title || '(untitled)'}`);
  lines.push('');
  lines.push(`> 原文标题: ${sourceTitle}`);
  lines.push('');
  lines.push('## 正文');
  lines.push('');
  lines.push((variant.body || '').replace(/\r\n/g, '\n'));
  lines.push('');
  if (variant.hashtags && variant.hashtags.length > 0) {
    lines.push('## 标签');
    lines.push('');
    lines.push(variant.hashtags.map(h => `#${h}`).join(' '));
    lines.push('');
  }
  // 保存 LLM 生成的图 prompt，方便用户查看/调试/手动复用
  const coverPrompt = (variant as any).cover_image_prompt as string | undefined;
  const contentPrompt = (variant as any).content_image_prompt as string | undefined;
  if ((coverPrompt && coverPrompt.trim()) || (contentPrompt && contentPrompt.trim())) {
    lines.push('## 配图 Prompt（LLM 生成）');
    lines.push('');
    if (coverPrompt && coverPrompt.trim()) {
      lines.push('### 封面图');
      lines.push('');
      lines.push(coverPrompt.trim());
      lines.push('');
    }
    if (contentPrompt && contentPrompt.trim()) {
      lines.push('### 内容图');
      lines.push('');
      lines.push(contentPrompt.trim());
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ── Public API ──

export interface ArtifactWriteResult {
  dir: string;
  files: string[];
}

export async function writeTaskArtifacts(
  task: ScenarioTask,
  drafts: Draft[],
  platform?: string,
): Promise<ArtifactWriteResult> {
  const batchDir = getTaskOutputDir(task, platform);
  const originalsDir = path.join(batchDir, '原文');
  const rewritesDir = path.join(batchDir, '改写');
  const files: string[] = [];

  try { fs.mkdirSync(originalsDir, { recursive: true }); } catch {}
  try { fs.mkdirSync(rewritesDir, { recursive: true }); } catch {}

  // Group by source post
  const byPost = new Map<string, Draft[]>();
  for (const d of drafts) {
    const key = d.source_post.external_post_id;
    const arr = byPost.get(key) || [];
    arr.push(d);
    byPost.set(key, arr);
  }

  let articleIdx = 0;
  for (const [_postId, postDrafts] of byPost) {
    const first = postDrafts[0];
    if (!first) continue;
    const post = first.source_post;
    articleIdx++;

    // Write original: 原文/文章1_标题.md
    const origTitle = sanitize(post.title || 'untitled');
    const origFilename = `文章${articleIdx}_${origTitle}.md`;
    try {
      const origPath = path.join(originalsDir, origFilename);
      fs.writeFileSync(origPath, renderOriginalMd(post, articleIdx), 'utf8');
      files.push(origPath);
    } catch (err) {
      coworkLog('WARN', 'artifactWriter', 'write original failed', { err: String(err) });
    }

    // Write analysis.json if exists
    if (first.extraction) {
      try {
        const analysisPath = path.join(originalsDir, `文章${articleIdx}_分析.json`);
        fs.writeFileSync(analysisPath, JSON.stringify(first.extraction, null, 2), 'utf8');
        files.push(analysisPath);
      } catch {}
    }

    // Write rewrites: 改写/1-改写-新标题.md
    let variantIdx = 0;
    for (const d of postDrafts) {
      if (!d.variant) continue;
      variantIdx++;
      const rewriteTitle = sanitize(d.variant.title || 'untitled');
      const rewriteFilename = `${articleIdx}-改写-${rewriteTitle}.md`;
      try {
        const vPath = path.join(rewritesDir, rewriteFilename);
        fs.writeFileSync(vPath, renderRewriteMd(d.variant, post.title || ''), 'utf8');
        files.push(vPath);
      } catch (err) {
        coworkLog('WARN', 'artifactWriter', 'write rewrite failed', { err: String(err) });
      }

      // Save generated images (base64 → file)
      // 目录以改写标题命名，避免 3 篇文章被 orchestrator 分 3 次 saveDrafts 调用时
      // 都用 articleIdx=1 互相覆盖（之前只剩最后一篇的图片）
      const images = (d as any).images;
      if (Array.isArray(images) && images.length > 0) {
        const imgDir = path.join(rewritesDir, `配图-${rewriteTitle}`.slice(0, 80));
        try { fs.mkdirSync(imgDir, { recursive: true }); } catch {}
        for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
          const img = images[imgIdx];
          if (!img.base64) continue;
          const ext = (img.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
          const imgFilename = `${img.type || 'image'}_${imgIdx + 1}.${ext}`;
          try {
            const imgPath = path.join(imgDir, imgFilename);
            fs.writeFileSync(imgPath, Buffer.from(img.base64, 'base64'));
            files.push(imgPath);
          } catch (err) {
            coworkLog('WARN', 'artifactWriter', 'write image failed', { err: String(err) });
          }
        }
      }
    }
  }

  coworkLog('INFO', 'artifactWriter', `wrote ${files.length} files`, { dir: batchDir });
  return { dir: batchDir, files };
}

export function getArtifactsRootPath(): string {
  return getDocsRoot();
}

/** Create the task output directory immediately (called when task is created) */
export function ensureTaskOutputDir(task: ScenarioTask, platform?: string): string {
  const p = platform || inferPlatformFromTask(task);
  const platformName = PLATFORM_NAMES[p] || p;
  const trackName = TRACK_NAMES[task.track] || task.track || 'unknown';
  const taskFolder = sanitize(task.id.slice(0, 8) + '_' + trackName);
  const dir = path.join(getDocsRoot(), platformName, taskFolder);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/** Get the task-level output directory path (for UI display) */
export function getTaskDirPath(task: ScenarioTask, platform?: string): string {
  const p = platform || inferPlatformFromTask(task);
  const platformName = PLATFORM_NAMES[p] || p;
  const trackName = TRACK_NAMES[task.track] || task.track || 'unknown';
  const taskFolder = sanitize(task.id.slice(0, 8) + '_' + trackName);
  return path.join(getDocsRoot(), platformName, taskFolder);
}
