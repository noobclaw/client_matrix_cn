/**
 * 短 id 展示 —— 矩阵 id 形如 `平台_类型_时间_随机`(任务,见 taskStore)或 `run_时间_随机`(运行记录,见 runStore)。
 * 前缀段(平台/类型/run)对【区分同类条目】没有信息量,真正唯一的是【时间_随机】尾巴。
 * 旧的 `id.slice(0, 8)` 在任务 id 上恰好把前 8 位全切给了平台前缀(如 "binance_"),所有同平台任务显示成一样的 `#binance_`。
 * 这里统一取【末两段】作短码;无下划线分段(异常/旧 uuid)才回退前 8 位。
 */
export function shortId(id: string): string {
  const s = String(id || '');
  const segs = s.split('_').filter(Boolean);
  return segs.length >= 2 ? segs.slice(-2).join('_') : s.slice(0, 8);
}
