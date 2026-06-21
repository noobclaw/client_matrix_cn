/**
 * 命令适配层(薄路由)—— 把剧本(orchestrator)的浏览器命令路由到指纹内核。
 *
 * 架构(2026-06-21 重构):命令实现不再在 client 手写,而是【复用扩展的 DOM 命令实现】,
 * 由后端下发的命令执行器 window.__nbExec 在内核页面里执行(见 kernelPool.kernelExec +
 * backend/matrix/drivers/command_executor.js)。本层只做路由:
 *   · 页面类命令(click/type/query_selector/scroll/editor_* …)→ kernelExec → __nbExec
 *   · 特权命令(cdp_eval / javascript / 可信按键 keypress / 可信坐标点击 cdp_click)→ 原生 CDP
 *
 * 收益:① 不逐命令手写(吃扩展久经实战的实现 + 历史修复);② 改命令行为只改后端 + 重启,
 * 不打包 client;③ 22 个剧本一行不改。
 */

import { kernelEval, kernelExec, kernelKeypress, kernelClick } from './kernelPool';

export async function matrixCmd(
  accountId: string,
  command: string,
  params: any,
  _timeoutMs?: number,
): Promise<any> {
  switch (command) {
    // ── 特权命令:原生 CDP(执行器在页面里做不了 / 需要 isTrusted)──

    // 任意求值(剧本收集 video_id / 读 DOM 等):CDP Runtime.evaluate 默认主世界,且不受
    // 页面 CSP 'unsafe-eval' 限制(不走 new Function)。
    case 'cdp_eval': {
      const value = await kernelEval(accountId, String(params?.expression || ''));
      return { ok: true, value };
    }
    // 任意 JS:扩展版用 new Function(code) 会被严 CSP 站拦;这里包成 IIFE 直接 CDP 求值绕开。
    case 'javascript': {
      const code = String(params?.code || '');
      const value = await kernelEval(accountId, '(function(){' + code + '\n})()');
      return { ok: true, result: value, value };
    }
    // 可信按键(CDP Input.dispatchKeyEvent,isTrusted=true):搜索框 Enter 提交等。
    case 'keypress': {
      try { await kernelKeypress(accountId, String(params?.key || 'Enter')); return { ok: true }; }
      catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }
    // 可信坐标点击(CDP Input.dispatchMouseEvent):快手/B站/小红书 reply 等查 isTrusted 的场景。
    case 'cdp_click': {
      const x = Number(params?.x), y = Number(params?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'cdp_click_needs_xy' };
      try { await kernelClick(accountId, x, y); return { ok: true }; }
      catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }
    // 当前页 URL(轻量,直接 eval,不依赖执行器在位)。
    case 'get_url': {
      const url = await kernelEval(accountId, 'location.href');
      return { ok: true, url: String(url || ''), value: url };
    }

    // ── 页面类命令:走服务端下发的执行器(复用扩展实现)──
    //   query_selector / type / fill / set_input_value / main_world_click /
    //   editor_insert_text / editor_paste_text / click_with_text / scroll /
    //   scroll_to / get_text / get_value / hover / wait_for / click …
    default:
      return await kernelExec(accountId, command, params || {});
  }
}
