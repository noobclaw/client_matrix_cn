/**
 * publisherUtils — 9 个平台 driver 共享的底层工具。
 *
 * 抽出来避免每个 driver 重复实现:
 *   · uploadFileToInput  —— 把本地 mp4 通过 sidecar 本地 HTTP + chrome-extension 的
 *     upload_file_from_url 注入到 file input(抄 phaseRunner.uploadVideoFromDisk)
 *   · bridgeOptsFor      —— 给 sendBrowserCommand 拼路由 envelope(tabPattern + tabGroup),
 *     让 chrome-extension 把命令送到正确的平台 tab(phaseRunner 的 getBridgeOpts 简化版,
 *     去掉 scenario phase 的动态 secondary 切换 —— video publisher 一次只发一个平台)
 *   · waitForSelector / clickWithText / insertEditorText —— 各 driver 都要用的
 *     轮询/点击/插入文本通用脚本
 *
 * 跟 chrome-extension 的关系:只调 sendBrowserCommand,不动 extension 本体。
 */

import path from 'path';
import fs from 'fs';
import { sendBrowserCommand } from '../../browserBridge';
import {
  type LoginPlatform,
  PLATFORM_TAB_GROUPS,
} from '../../scenario/platformLoginDriver';
import type { VideoPlatform } from './types';

/** video platform id → scenario LoginPlatform(命名完全一致,直接转型即可)。 */
function asLoginPlatform(p: VideoPlatform): LoginPlatform {
  return p as unknown as LoginPlatform;
}

/** 每个平台的【创作者中心 tab url pattern】—— 跟 platformLoginDriver.TAB_PATTERNS 不同,
 *  这里的 pattern 指向创作者后台(不是主站),发布命令要送到这里去。 */
const PUBLISHER_TAB_PATTERN: Record<VideoPlatform, string> = {
  // 抖音创作者中心
  douyin:    'creator\\.douyin\\.com',
  // 小红书创作中心
  xhs:       'creator\\.xiaohongshu\\.com',
  // TikTok studio(也覆盖老的 tiktok.com/upload)
  tiktok:    'tiktok\\.com\\/(upload|studio|creator)',
  // 币安广场 —— 发布是在主站 square 路径上(不是独立创作中心)
  binance:   'binance\\.com\\/[a-z-]+\\/square',
  // 推特/X —— 同样是在主站发推
  x:         '\\b(?:twitter|x)\\.com\\b',
  // B 站创作者中心(member.bilibili.com)
  bilibili:  'member\\.bilibili\\.com',
  // 快手创作者服务平台
  kuaishou:  'cp\\.kuaishou\\.com',
  // 视频号助手后台
  shipinhao: 'channels\\.weixin\\.qq\\.com',
  // 头条号后台
  toutiao:   'mp\\.toutiao\\.com',
};

/** 创作者中心的 anchor URL —— driver 发现 tab 不在时 sendBrowserCommand('tab_create') 打开它。 */
export const PUBLISHER_ANCHOR_URL: Record<VideoPlatform, string> = {
  // 2026-06-12 CDP 实测:?default-tab=3 落在【发布图文】tab(只有 image input,视频
  // driver 必失败);裸 /content/upload 默认就是【发布视频】tab(input accept=video/*)。
  douyin:    'https://creator.douyin.com/creator-micro/content/upload',
  xhs:       'https://creator.xiaohongshu.com/publish/publish?source=official',
  tiktok:    'https://www.tiktok.com/tiktokstudio/upload',
  binance:   'https://www.binance.com/en/square',
  x:         'https://x.com/home',
  bilibili:  'https://member.bilibili.com/platform/upload/video/frame',
  kuaishou:  'https://cp.kuaishou.com/article/publish/video',
  shipinhao: 'https://channels.weixin.qq.com/platform/post/create',
  toutiao:   'https://mp.toutiao.com/profile_v4/xigua/upload-video',
  youtube:   'https://www.youtube.com/upload',
};

/**
 * sendBrowserCommand 的 envelope:让 extension 把命令路由到目标平台 tab。
 * video publisher 一次只针对一个平台,所以静态返回即可(不像 scenario 要切换 primary/secondary)。
 */
export function bridgeOptsFor(platform: VideoPlatform): {
  tabPattern: string;
  tabGroup?: { title: string; color: string };
  anchor_url: string;
} {
  return {
    tabPattern: PUBLISHER_TAB_PATTERN[platform],
    tabGroup: PLATFORM_TAB_GROUPS[asLoginPlatform(platform)],
    anchor_url: PUBLISHER_ANCHOR_URL[platform],
  };
}

/**
 * 把 tabId 塞进命令 params —— v6.13 单 tab 复用的核心。
 * extension 见到 params.tabId 就 chrome.tabs.get(tabId) 直接寻址,绕过 tabPattern。
 * tabId 缺省(null/undefined)时原样返回 params,走 bridgeOptsFor 的 tabPattern 路由(向后兼容)。
 */
function withTabId(params: any, tabId?: number): any {
  return typeof tabId === 'number' ? { ...params, tabId } : params;
}

/**
 * 统一的 driver → extension 命令入口。所有 driver 内部的 sendBrowserCommand 都改走这里:
 *   · 有 tabId → 命令钉到那个固定 tab(单 tab 复用,9 平台共用一个 video_publish tab)
 *   · 无 tabId → 退回 bridgeOptsFor(platform) 的 tabPattern 路由(行为同改动前)
 * envelope 始终带 bridgeOptsFor(tabGroup/anchor_url 等元信息),extension 在有 tabId 时优先 tabId。
 */
export function pubCmd(
  platform: VideoPlatform,
  command: string,
  params: any,
  timeout: number,
  tabId?: number,
): Promise<any> {
  return sendBrowserCommand(command, withTabId(params, tabId), timeout, bridgeOptsFor(platform));
}

/**
 * 上传本地 mp4 到指定 file input —— 抄 phaseRunner.uploadVideoFromDisk:
 *   1. 通过 localFileServer.registerFile() 在 sidecar 注册一个临时 HTTP URL
 *   2. sendBrowserCommand('upload_file_from_url', { selector, fileUrl, ... })
 *      → chrome-extension fetch URL 拿 blob,构造 File 注入 input
 *   3. 成功后 unregister 释放 token
 *
 * 大文件(几十 MB)走 sidecar 本地 HTTP,绕开 native messaging 的 IPC 大小限制。
 */
export async function uploadFileToInput(opts: {
  platform: VideoPlatform;
  filePath: string;
  targetSelector: string;
  mimeType?: string;
  /** 单次上传超时(ms),默认 5 分钟。 */
  ttlMs?: number;
  /** v6.13 单 tab 复用:固定发布 tab id;给了就钉到该 tab,不走 tabPattern。 */
  tabId?: number;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!fs.existsSync(opts.filePath)) return { ok: false, reason: 'file_not_found' };
  const { registerFile, buildUrl, unregister } = require('../../localFileServer');
  const fileName = path.basename(opts.filePath);
  const ttl = opts.ttlMs || 5 * 60 * 1000;
  const token = registerFile(opts.filePath, {
    mimeType: opts.mimeType || 'video/mp4',
    fileName,
    ttlMs: ttl,
  });
  const port = parseInt(process.env.NOOBCLAW_SIDECAR_PORT || '18801', 10);
  const fileUrl = buildUrl(token, port);
  try {
    const r: any = await sendBrowserCommand(
      'upload_file_from_url',
      withTabId({
        selector: opts.targetSelector,
        fileUrl,
        fileName,
        mimeType: opts.mimeType || 'video/mp4',
      }, opts.tabId),
      ttl,
      bridgeOptsFor(opts.platform),
    );
    if (!r || r.ok === false) return { ok: false, reason: (r && (r.reason || r.error)) || 'upload_failed' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'upload_threw:' + String(e?.message || e).slice(0, 100) };
  } finally {
    try { unregister(token); } catch { /* ignore */ }
  }
}

/**
 * uploadVideoToInputDeep —— 把本地视频注入【wujie shadowRoot 里】的 file input(视频号专用)。
 *
 * 为什么单独一条:视频号发表页表单挂在 <wujie-app> 的 open shadowRoot 里,扩展的
 * upload_file_from_url 用 document.querySelector 找 input【不穿 shadowRoot】→ 在视频号
 * 必失败。这里改走 cdp_eval(isolated world,可能豁免页面 CSP):
 *   1. 复用 sidecar localFileServer 把视频注册成 http://localhost:<port>/<token>(大文件走 HTTP,
 *      不把 base64 inline 进 cdp_eval 表达式 —— 几十 MB 会撑爆 CDP 通道)。
 *   2. cdp_eval 里【三层深遍历(顶层 + 同源 iframe + open shadowRoot)】定位 video file input,
 *      在页面里 fetch 那个本地 URL 拿 blob → 构造 File → input.files → 派 change/input。
 *
 * ⚠️ fetch localhost 可能被页面 CSP(connect-src)拦;cdp_eval 跑 isolated world 有望豁免,
 *   但需真机验证。失败时 reason 会带 fetch_/inject_ 前缀便于定位。
 */
export async function uploadVideoToInputDeep(opts: {
  platform: VideoPlatform;
  filePath: string;
  /** 可选:进一步收窄到某个 file input;缺省取 accept 含 video 的、否则第一个。 */
  acceptHint?: string;
  mimeType?: string;
  ttlMs?: number;
  tabId?: number;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!fs.existsSync(opts.filePath)) return { ok: false, reason: 'file_not_found' };
  const { registerFile, buildUrl, unregister } = require('../../localFileServer');
  const fileName = path.basename(opts.filePath);
  const mime = opts.mimeType || 'video/mp4';
  const ttl = opts.ttlMs || 10 * 60 * 1000;
  const token = registerFile(opts.filePath, { mimeType: mime, fileName, ttlMs: ttl });
  const port = parseInt(process.env.NOOBCLAW_SIDECAR_PORT || '18801', 10);
  const fileUrl = buildUrl(token, port);
  // 三层深遍历底座(同生产 shipinhao_image_text 的 nbDeepAll)。
  const DEEP = 'function nbDeepAll(sel){var out=[];function walk(root,d){if(!root||d>6)return;'
    + 'try{var m=root.querySelectorAll(sel);for(var i=0;i<m.length;i++)out.push(m[i]);}catch(e){}'
    + 'var all=[];try{all=root.querySelectorAll("*");}catch(e){}'
    + 'for(var k=0;k<all.length;k++){var sr=null;try{sr=all[k].shadowRoot;}catch(e){}if(sr)walk(sr,d+1);}'
    + 'var fr=[];try{fr=root.querySelectorAll("iframe,frame");}catch(e){}'
    + 'for(var j=0;j<fr.length;j++){var idoc=null;try{idoc=fr[j].contentDocument;}catch(e){}if(idoc)walk(idoc,d+1);}}'
    + 'walk(document,0);return out;}';
  const expr = '(async function(){' + DEEP
    + 'var ins=nbDeepAll(\'input[type="file"]\');var input=null;'
    + 'for(var i=0;i<ins.length;i++){var ac=ins[i].getAttribute("accept")||"";if(ac.indexOf("video")>=0){input=ins[i];break;}}'
    + 'if(!input&&ins.length)input=ins[0];'
    + 'if(!input)return {ok:false,reason:"no_input(deep="+ins.length+")"};'
    + 'try{var resp=await fetch(' + JSON.stringify(fileUrl) + ');'
    + 'if(!resp||!resp.ok)return {ok:false,reason:"fetch_"+(resp&&resp.status)};'
    + 'var blob=await resp.blob();'
    + 'var win=(input.ownerDocument&&input.ownerDocument.defaultView)||window;'
    + 'var file=new win.File([blob],' + JSON.stringify(fileName) + ',{type:' + JSON.stringify(mime) + '});'
    + 'var dt=new win.DataTransfer();dt.items.add(file);input.files=dt.files;'
    + 'input.dispatchEvent(new win.Event("change",{bubbles:true}));'
    + 'input.dispatchEvent(new win.Event("input",{bubbles:true}));'
    + 'return {ok:true,bytes:blob.size};'
    + '}catch(e){return {ok:false,reason:"inject_"+String(e&&e.message||e).slice(0,80)};}})()';
  try {
    const r: any = await pubCmd(opts.platform, 'cdp_eval', { expression: expr, awaitPromise: true }, ttl, opts.tabId);
    // cdp_eval 返回 { ok:true, value:<上面 return 的对象> }(或裹 data 一层)。
    const outer = (r && r.value !== undefined) ? r : (r && r.data) ? r.data : r;
    if (!outer || outer.ok === false) return { ok: false, reason: 'cdp_eval_failed:' + ((outer && outer.error) || 'unknown') };
    const v = outer.value;
    if (!v || v.ok !== true) return { ok: false, reason: (v && v.reason) || 'inject_no_result' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'deep_upload_threw:' + String(e?.message || e).slice(0, 100) };
  } finally {
    try { unregister(token); } catch { /* ignore */ }
  }
}

/** 轮询直到 selector 出现(或超时)。返回 true / false,不抛。 */
export async function waitForSelector(
  platform: VideoPlatform,
  selector: string,
  opts?: { timeoutMs?: number; intervalMs?: number; tabId?: number },
): Promise<boolean> {
  const deadline = Date.now() + (opts?.timeoutMs || 15000);
  const interval = opts?.intervalMs || 500;
  while (Date.now() < deadline) {
    try {
      const r: any = await pubCmd(platform, 'query_selector', {
        selector, limit: 1,
      }, 5000, opts?.tabId);
      const els = (r && r.elements) || (r && r.data && r.data.elements) || [];
      if (els.length > 0) return true;
    } catch { /* keep polling */ }
    await sleep(interval);
  }
  return false;
}

/** 文本匹配点击(按 modal 范围,fuzzy + 跳过 inactive)。返回 ok 字段。 */
export async function clickWithText(
  platform: VideoPlatform,
  opts: {
    containerSel?: string;
    acceptedTexts: string[];
    /** 失败重试次数(每次间隔 1.5s)。默认 6。 */
    retries?: number;
    /** v6.13 单 tab 复用:固定发布 tab id。 */
    tabId?: number;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const retries = opts.retries || 6;
  for (let i = 0; i < retries; i++) {
    if (i > 0) await sleep(1500);
    try {
      const r: any = await pubCmd(platform, 'click_with_text', {
        containerSel: opts.containerSel,
        acceptedTexts: opts.acceptedTexts,
        opts: { fuzzy: true, skipInactive: true, returnDebug: true },
      }, 8000, opts.tabId);
      if (r && r.ok) return { ok: true };
      if (r && r.error && !/inactive/i.test(String(r.error))) {
        return { ok: false, reason: String(r.error).slice(0, 100) };
      }
    } catch { /* retry */ }
  }
  return { ok: false, reason: 'click_with_text_no_match' };
}

/** 主世界 click(穿透 React 合成事件,适合 modal 触发按钮)。 */
export async function mainWorldClick(platform: VideoPlatform, selector: string, tabId?: number): Promise<boolean> {
  try {
    await pubCmd(platform, 'main_world_click', { selector }, 8000, tabId);
    return true;
  } catch { return false; }
}

/** 往富文本编辑器(ProseMirror / Slate / contentEditable)插入文字 —— 用 execCommand 路径。 */
export async function insertEditorText(
  platform: VideoPlatform,
  editorSel: string,
  text: string,
  tabId?: number,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    // 先点一下让 editor 获得焦点
    await pubCmd(platform, 'main_world_click', { selector: editorSel }, 5000, tabId);
    await sleep(400);
    const r: any = await pubCmd(platform, 'editor_insert_text', {
      selector: editorSel, text,
    }, 10000, tabId);
    if (!r || (r.ok === false && r.error)) {
      return { ok: false, reason: 'editor_insert_failed:' + (r?.error || 'unknown') };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: 'editor_failed:' + String(e?.message || e).slice(0, 80) };
  }
}

/** 普通 input value 设置(适合标题这种非富文本)。 */
export async function setInputValue(
  platform: VideoPlatform,
  selector: string,
  value: string,
  tabId?: number,
): Promise<boolean> {
  try {
    const r: any = await pubCmd(platform, 'set_input_value', {
      selector, value,
    }, 5000, tabId);
    return !!(r && r.ok !== false);
  } catch { return false; }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
