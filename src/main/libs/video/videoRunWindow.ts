/**
 * videoRunWindow —— 视频类任务【运行窗口】(取材 + 发布共用一个窗口)。
 *
 * 背景:热搜成片取材(抖音搜索)以前走 pubCmd 的 tabPattern 路由 → 命中【任意】抖音 tab,
 * 跟 scenario 的抖音任务、甚至另一条视频 pipeline 抢同一个 tab → 串台(口播 A 配画面 B)。
 *
 * 这里复用发布侧已有的【专用 video_publish 窗口】(见 runPublish.openPublishTab,windowKey
 * 幂等 → 同一个窗口):取材也开/复用它、把驱动命令【按 tabId 钉到这个窗口的固定 tab】,
 * 于是抖音搜索在视频自己的窗口里跑,物理隔离 scenario,也不跟别的视频 pipeline 抢
 * (视频侧另有单飞闸 + 串行锁兜着)。一个窗口、一个 tab、navigate 串行复用,不爆炸。
 *
 * 窗口 title 标【当前任务 id + 类型】(用户要求):generateVideoBatch 开跑前 setCurrentVideoTask,
 * 收尾 clearCurrentVideoTask;开/复用窗口时用 videoWindowTitle() 重新 stamp 标题。复用时传
 * url='about:blank' —— 扩展 task_open_tab 对 about:blank 不重导航、只更新 group title,所以
 * 重 stamp 标题不会打断正在跑的搜索/上传。
 *
 * 拿不到 tabId(旧扩展无 window_registry_v6 / 开窗失败)→ 返回 undefined,调用方回退原
 * tabPattern 路由(行为同改动前,不阻断取材)。
 */

import { sendBrowserCommand, connectionHasCapability } from '../browserBridge';
import { getStandardBounds } from '../scenario/subPlatformRegistry';

/** 跟发布共用同一个窗口(见 subPlatformRegistry.video_publish / runPublish.PUBLISH_WINDOW_KEY)。 */
const RUN_SUB_PLATFORM = 'video_publish';
const RUN_WINDOW_KEY = `${RUN_SUB_PLATFORM}::default`;

let _runTabId: number | undefined;

/** 当前正在跑的视频任务。单飞闸(generateVideoBatch)保证同时只一条 → 模块级单值安全。 */
let _curTask: { taskId: string; typeLabel: string } | null = null;

/** generateVideoBatch 开跑前设当前任务(taskId + 类型如「热搜成片」),供窗口 title 标注。 */
export function setCurrentVideoTask(taskId: string | undefined, typeLabel: string): void {
  _curTask = taskId ? { taskId, typeLabel: typeLabel || '视频创作' } : null;
}
/** generateVideoBatch 收尾清当前任务。 */
export function clearCurrentVideoTask(): void {
  _curTask = null;
}

/** engine → 中文类型标签(窗口 title 用)。 */
export function videoTypeLabel(engine: string | undefined): string {
  switch (engine) {
    case 'hotspot': return '热搜成片';
    case 'stock': return '在线素材';
    case 'ai': return 'AI 成片';
    case 'template': return '模板速生';
    case 'thread': return '爆帖成片';
    default: return '视频创作';
  }
}

/** 视频窗口的 tab-group 标题:有当前任务 → 「🤖 {id前4} {类型}」;否则空闲。 */
export function videoWindowTitle(idleLabel = '视频运行'): string {
  if (_curTask) {
    const id = String(_curTask.taskId);
    const short = (id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4) || id.slice(0, 4) || '????');
    return `🤖 ${short} ${_curTask.typeLabel}`;
  }
  return `🤖 ${idleLabel}`;
}

/**
 * 开/复用视频运行窗口的固定 tab,返回 tabId。
 *   · 每次都发 task_open_tab(windowKey 幂等):首次开新窗、之后复用同一窗口;
 *     url 固定 about:blank → 扩展对 about:blank 不重导航(只在首次创建时落地),
 *     驱动跑起来会自己 navigate 到目标平台,复用调用只更新 group 标题(标当前任务)。
 *   · 跟 runPublish 用同一个 windowKey → 取材 + 发布共用一个窗口。
 * 拿不到 → undefined(调用方回退 tabPattern)。
 */
export async function ensureVideoRunTab(onLog?: (m: string) => void): Promise<number | undefined> {
  if (!connectionHasCapability(undefined, 'window_registry_v6')) {
    try { onLog?.('ℹ️ 扩展无 v6 窗口注册表,取材回退共享 tab 模式'); } catch { /* ignore */ }
    return undefined;
  }
  try {
    const bounds = getStandardBounds(RUN_SUB_PLATFORM, 'default');
    const res: any = await sendBrowserCommand(
      'task_open_tab',
      {
        windowKey: RUN_WINDOW_KEY,
        groupTitle: videoWindowTitle(),     // 标当前任务 id+类型;复用时 about:blank 不重导航、只换标题
        role: 'main',
        url: 'about:blank',
        bounds,
        // taskId omitted —— 视频任务不进 scenario 的 taskTabRegistry。
      },
      12000,
    );
    const tabId = res?.tabId ?? res?.data?.tabId;
    if (typeof tabId === 'number') { _runTabId = tabId; return tabId; }
  } catch { /* 开窗失败 → 回退 */ }
  return _runTabId; // 偶发开窗失败:用上次缓存的 tabId 兜底(可能为 undefined)
}

/** 视频运行窗口的 tab 可能被关 / 失效时调用,下次重开。 */
export function resetVideoRunTab(): void {
  _runTabId = undefined;
}
