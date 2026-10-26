// 示例 / 自检用手机 driver(phone_probe)。客户端 phoneDriverCtx.ts 内置了同一份(BUILTIN_DRIVERS),
// 后端 /api/matrix/drivers 下发同名脚本时以后端为准;开发时复制到 ~/NoobClaw/matrix/emulator/drivers/ 可本地覆写。
//
// 作用:打开 ctx.input.pkg 指定的 App(缺省 TikTok 国际版),等首屏稳定,回报当前包名、屏幕尺寸,
// 以及画面上前 40 个有内容的节点,方便确认「控制链路通了 + 这个 App 的元素能读到」。
// 只读操作:不点击任何按钮、不发布、不互动。
const pkg = String(ctx.input.pkg || 'com.zhiliaoapp.musically');
if (!(await ctx.appInstalled(pkg))) return { ok: false, reason: 'app_not_installed:' + pkg };
ctx.log('打开 ' + pkg);
await ctx.appStart(pkg);
await ctx.sleep(6000);
const current = await ctx.appCurrent();
const screen = await ctx.screen();
const nodes = await ctx.dump();
const visible = nodes.filter((n) => n.visible && (n.text || n.desc || n.resourceId));
ctx.log('当前前台:' + current + ',节点 ' + nodes.length + ' 个,有内容 ' + visible.length + ' 个');
return {
  ok: current === pkg,
  reason: current === pkg ? undefined : 'foreground_is:' + current,
  current,
  screen,
  nodeCount: nodes.length,
  sample: visible.slice(0, 40).map((n) => ({ id: n.resourceId, text: n.text.slice(0, 30), desc: n.desc.slice(0, 30), cls: n.className.split('.').pop(), at: [n.cx, n.cy] })),
};
