/**
 * 界面版本:简洁版 / 专业版(2026-10-28)。
 *
 *   专业版 = 现在的完整界面(什么都不砍)。
 *   简洁版 = 侧栏只留 首页 / 我的矩阵账号 / 我的任务 / 我的充值 / 邀请返佣 / 联系我们;
 *            首页 = 三步引导 + 教学视频 + 大号「创建任务」;创建任务 = 选平台 → 选账号 → 选任务类型;
 *            我的任务 = 全部平台的任务放一起,下拉框筛选。
 *
 * 只是【界面】的取舍:任务、账号、调度、计费一律不变,两版随时互切、数据完全共用。
 * 存本机 localStorage(纯显示偏好,丢了最多再弹一次选择框)。
 */
import { useEffect, useState } from 'react';

export type UiEdition = 'simple' | 'pro';
/** 上次弹过「选版本」时的安装指纹(见 App.tsx);和本次不同 = 刚装 / 重装 / 升级过 → 再问一次 */
export const INSTALL_STAMP_KEY = 'noobclaw_ui_install_stamp';
const KEY = 'noobclaw_ui_edition';
const EVT = 'noobclaw:ui-edition';

export function getUiEdition(): UiEdition | null {
  try { const v = localStorage.getItem(KEY); return v === 'simple' || v === 'pro' ? v : null; } catch { return null; }
}
export function setUiEdition(e: UiEdition): void {
  try { localStorage.setItem(KEY, e); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent(EVT, { detail: e })); } catch { /* ignore */ }
}
/** 当前版本(null = 还没选过)。任何地方 setUiEdition 都会同步过来。 */
export function useUiEdition(): UiEdition | null {
  const [v, setV] = useState<UiEdition | null>(() => getUiEdition());
  useEffect(() => {
    const on = () => setV(getUiEdition());
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return v;
}

// ── 简洁版「创建任务」:选好的账号带进任务向导(向导第一步直接勾好) ──
//   只在【新建】时用(编辑已有任务一律以任务自己的账号为准);离开新建页即清空。
let preset: { platform: string; ids: string[] } | null = null;
export function setPresetAccounts(platform: string, ids: string[]): void {
  preset = ids.length ? { platform, ids: Array.from(new Set(ids.map(String))) } : null;
}
export function clearPresetAccounts(): void { preset = null; }
/** 向导初始化用:有预选且平台对得上就返回(拷贝),否则空数组。 */
export function presetAccountIds(platform?: string): string[] {
  if (!preset) return [];
  if (platform && platform !== preset.platform) return [];
  return preset.ids.slice();
}
export function presetPlatform(): string | null { return preset ? preset.platform : null; }

/** 向导里用:这次是不是用了简洁版预选(只在挂载时判一次)。 */
export function usePresetUsed(initialTask: unknown, platform?: string): boolean {
  const [used] = useState<boolean>(() => !initialTask && presetAccountIds(platform).length > 0);
  return used;
}
/** 简洁版预选号:向导自己的账号列表加载完后,剔除不在列表里的号 —— 各向导的账号口径不同
 *  (如快手「回复粉丝」只列创作者中心号),不剔会把看不见、取消不了的号存进任务。只在用了预选时生效。 */
export function usePresetPrune(used: boolean, accounts: Array<{ id: string }>, loading: boolean | undefined, prune: (live: Set<string>) => void): void {
  useEffect(() => {
    if (!used || loading) return;
    prune(new Set(accounts.map((a) => a.id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [used, accounts, loading]);
}
