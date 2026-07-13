/**
 * MVP 尖刀自测 —— 验证整套方案的命门。在有界面的机器上跑(服务器无 GUI 跑不了)。
 *
 * 验证三件事:
 *   1. 指纹内核能起 + CDP 连接池能连(launchKernel + kernelEval)。
 *   2. 反自动化:navigator.webdriver 是否被伪装、UA/硬件指纹是否生效。
 *   3. fakeShadowRoot:能否读到 closed shadow(成立则是抖音/视频号 closed-shadow
 *      发布按钮的降维大礼)。
 *
 * 用法(本机,先准备好 fingerprint-chromium 二进制):
 *   在 sidecar/主进程里 import { runKernelSelfTest } 调用,或临时挂一个 IPC/脚本:
 *     await runKernelSelfTest({ kernelPath: 'C:/path/to/fingerprint-chrome.exe' })
 *   不传 kernelPath 时用已下载的指纹内核;都没有则抛 NO_KERNEL(不再回落系统 Chrome)。
 */

import { launchKernel, kernelEval, kernelNavigate, closeKernel } from './kernelPool';

export interface SelfTestReport {
  launched: boolean;
  navigatorWebdriver: any;
  userAgent: string;
  hardwareConcurrency: any;
  closedShadowReadable: boolean | string;
  error?: string;
}

const FAKE_SHADOW_PROBE =
  '(function(){try{' +
  'var host=document.createElement("div");document.body.appendChild(host);' +
  'var sr=host.attachShadow({mode:"closed"});' +
  'sr.innerHTML=\'<span id="nbsecret">hidden</span>\';' +
  // 普通 Chrome:closed shadow 的 host.shadowRoot === null;能读到即 fakeShadowRoot 生效。
  'var via=host.shadowRoot;' +
  'var ok=!!(via&&via.getElementById&&via.getElementById("nbsecret"));' +
  'return ok;}catch(e){return "probe_error:"+String(e&&e.message||e);}})()';

export async function runKernelSelfTest(opts: {
  kernelPath?: string;
  testUrl?: string;
  headless?: boolean;
}): Promise<SelfTestReport> {
  const accountId = 'selftest';
  const report: SelfTestReport = {
    launched: false,
    navigatorWebdriver: undefined,
    userAgent: '',
    hardwareConcurrency: undefined,
    closedShadowReadable: false,
  };

  try {
    await launchKernel({
      accountId,
      kernelPath: opts.kernelPath,
      userDataDir: require('path').join(require('os').tmpdir(), 'matrix-selftest-profile'),
      fingerprint: { seed: 123456789, platformOs: 'windows', brand: 'Chrome', hardwareConcurrency: 8, lang: 'zh-CN', timezone: 'Asia/Shanghai' },
      headless: opts.headless,
    });
    report.launched = true;

    await kernelNavigate(accountId, opts.testUrl || 'about:blank');

    report.navigatorWebdriver = await kernelEval(accountId, 'navigator.webdriver');
    report.userAgent = String(await kernelEval(accountId, 'navigator.userAgent'));
    report.hardwareConcurrency = await kernelEval(accountId, 'navigator.hardwareConcurrency');
    report.closedShadowReadable = await kernelEval(accountId, FAKE_SHADOW_PROBE);
  } catch (e: any) {
    report.error = String(e?.message || e);
  } finally {
    // launch 失败时 kernelPool 已回退引用计数/使用锁,不能再 closeKernel(会错关/错放别的流程)。
    if (report.launched) { try { closeKernel(accountId); } catch { /* ignore */ } }
  }

  return report;
}
