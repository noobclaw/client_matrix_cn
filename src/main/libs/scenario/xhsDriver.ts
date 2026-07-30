/**
 * xhsDriver.ts — XHS-only draft upload helper.
 *
 * Used to also house the multi-platform login check (checkXhsLogin /
 * openXhsLogin) — those moved to platformLoginDriver.ts in v5.x because
 * they had grown to cover X / Binance / TikTok / YouTube and the xhs name
 * was misleading. This file is now strictly the XHS draft-upload flow:
 * navigates to the publish page, uploads images, fills title + body +
 * hashtags, scrolls to the "save draft" button (left for the user to
 * confirm). No other platform calls into this file.
 */

import { coworkLog } from '../coworkLogger';
import { sendBrowserCommand } from '../browserBridge';
import type { ScenarioManifest, ComposedVariant } from './types';

// Re-export login helpers from their new home so any caller still importing
// from xhsDriver keeps compiling. New code should import from
// platformLoginDriver directly.
export {
  checkPlatformLogin,
  openPlatformLogin,
  checkXhsLogin,
  openXhsLogin,
  type LoginPlatform,
  type PlatformLoginStatus,
  type XhsLoginStatus,
} from './platformLoginDriver';

// ── Utilities ──

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Draft upload (XHS only) ──

export interface DraftUploadInput {
  manifest: ScenarioManifest;
  variant: ComposedVariant;
  images: string[];
}

export async function uploadXhsDraft(input: DraftUploadInput): Promise<
  { status: 'ready_for_user' } | { status: 'failed'; error: string }
> {
  const { manifest, variant, images } = input;
  const publishUrl = manifest.creator_urls?.publish;
  if (!publishUrl) return { status: 'failed', error: 'no_creator_url' };

  try {
    await sendBrowserCommand('navigate', { url: publishUrl }, 30000);
    await sleep(randInt(2000, 4000));

    const pageUrl = await sendBrowserCommand('get_url', {}, 5000);
    if (typeof pageUrl?.url === 'string' && pageUrl.url.includes('login')) {
      return { status: 'failed', error: 'not_logged_in' };
    }

    await sendBrowserCommand(
      'click',
      { selector: '.publish-tab-item:nth-of-type(2), [class*="tab"]:has-text("图文")' },
      5000
    ).catch(() => {});
    await sleep(randInt(1000, 2000));

    for (const imagePath of images) {
      try {
        const fs = require('fs');
        const buf = fs.readFileSync(imagePath);
        const base64 = buf.toString('base64');
        const fileName = imagePath.split(/[\\/]/).pop() || 'image.jpg';
        const mimeType = fileName.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        await sendBrowserCommand(
          'upload_file',
          { selector: 'input[type="file"][accept*="image"], input[type="file"]', fileData: base64, fileName, mimeType },
          30000
        );
        await sleep(randInt(1500, 3000));
      } catch (err) {
        coworkLog('WARN', 'xhsDriver', 'image upload failed', { imagePath, err: String(err) });
      }
    }

    await sleep(randInt(2000, 3500));

    await sendBrowserCommand(
      'fill',
      { selector: '.title-input input, input[placeholder*="标题"]', value: variant.title },
      5000
    );
    await sleep(randInt(500, 1500));

    const paragraphs = (variant.body || '').split('\n');
    await sendBrowserCommand(
      'click',
      { selector: '.content-input [contenteditable="true"], [contenteditable="true"]' },
      5000
    ).catch(() => {});
    await sleep(randInt(300, 700));

    for (let i = 0; i < paragraphs.length; i++) {
      const p = paragraphs[i];
      if (p) await sendBrowserCommand('type', { text: p }, 10000);
      // keypress 跟 phaseRunner 的 scroll/click 同款理由:扩展 background 偶发走
      // content-script 慢路径(MV3 SW 冷启动 + 注入),3s 预算偏紧导致 multi-paragraph
      // 笔记中间 Enter 撞穿、后续段落漏掉。提到 10s 留余量;sleep 200-600 节奏不变。
      if (i < paragraphs.length - 1) await sendBrowserCommand('keypress', { key: 'Enter' }, 10000);
      await sleep(randInt(200, 600));
    }

    for (const raw of variant.hashtags) {
      const tag = raw.replace(/^#/, '');
      if (!tag) continue;
      await sendBrowserCommand('type', { text: '#' + tag }, 5000);
      await sendBrowserCommand('wait_for', { selector: '.topic-suggest-item, .hashtag-suggestion', timeout: 3000 }, 5000).catch(() => {});
      // hashtag dropdown 第 1 项 click:同 phaseRunner 顶层 ctx.click 理由,SW 冷启动
      // 3s 偶发撞穿导致 hashtag 漏插。.catch 已兜底 silent fail,提到 10s 不会拖响应,
      // 反而把"用户改完肉眼看不到 hashtag"的偶发降到 0。
      await sendBrowserCommand('click', { selector: '.topic-suggest-item, .hashtag-suggestion' }, 10000).catch(() => {});
      await sleep(randInt(600, 1200));
    }

    await sendBrowserCommand('scroll_to', { selector: 'button.ant-btn-default, button:has-text("草稿"), .save-draft-btn' }, 5000).catch(() => {});
    await sendBrowserCommand('screenshot', {}, 5000).catch(() => {});

    return { status: 'ready_for_user' };
  } catch (err) {
    return { status: 'failed', error: String(err) };
  }
}
