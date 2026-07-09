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

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { kernelEval, kernelExec, kernelKeypress, kernelClick, kernelWheel, kernelNavigate, kernelInsertText, kernelSetFileInput, kernelScreenshot } from './kernelPool';

export async function matrixCmd(
  accountId: string,
  command: string,
  params: any,
  timeoutMs?: number,
): Promise<any> {
  switch (command) {
    // ── 特权命令:原生 CDP(执行器在页面里做不了 / 需要 isTrusted)──

    // 任意求值(剧本收集 video_id / 读 DOM 等):CDP Runtime.evaluate 默认主世界,且不受
    // 页面 CSP 'unsafe-eval' 限制(不走 new Function)。
    case 'cdp_eval': {
      const value = await kernelEval(accountId, String(params?.expression || ''), timeoutMs);
      return { ok: true, value };
    }
    // 任意 JS:扩展版用 new Function(code) 会被严 CSP 站拦;这里包成 IIFE 直接 CDP 求值绕开。
    //   契约本是「传裸语句、用 return 取值」(如 binance 传 'return X;')。但很多剧本(FB/Reddit/
    //   tiktok/douyin/ins/youtube 的 evalJs/apiGet)直接传了【自调用 IIFE 表达式】—— 被二次包成
    //   (function(){ (iife)() })() 后外层没 return → 恒返回 undefined(FB 只滚不评、Reddit 取不到
    //   modhash 的真凶,2026-07-05 实测)。判定:code 以 '(' 开头 = 表达式/IIFE(含 async),补 return
    //   取其值(await 由 kernelEval 的 awaitPromise 兜住);否则原样(自带 return / 多语句)。
    //   注:以 '(' 开头的 code 之前必返回 undefined(本就坏的),补 return 只会修复、不会回归。
    case 'javascript': {
      const code = String(params?.code || '');
      const body = code.trim().charAt(0) === '(' ? 'return (' + code + '\n)' : code;
      const value = await kernelEval(accountId, '(function(){' + body + '\n})()', timeoutMs);
      return { ok: true, result: value, value };
    }
    // 可信按键(CDP Input.dispatchKeyEvent,isTrusted=true):搜索框 Enter 提交等。
    case 'keypress': {
      try { await kernelKeypress(accountId, String(params?.key || 'Enter')); return { ok: true }; }
      catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }
    // 可信文本插入(CDP Input.insertText):往【已聚焦】的富文本编辑器(B站 .brt-editor 等)真键盘插入文本。
    case 'cdp_insert_text': {
      try { await kernelInsertText(accountId, String(params?.text || '')); return { ok: true }; }
      catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }
    // 可信坐标点击(CDP Input.dispatchMouseEvent):快手/B站/小红书 reply 等查 isTrusted 的场景。
    case 'cdp_click': {
      const x = Number(params?.x), y = Number(params?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'cdp_click_needs_xy' };
      try { await kernelClick(accountId, x, y); return { ok: true }; }
      catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }
    // 可信滚轮(CDP):懒加载只认真实 wheel 的页面(小红书/快手创作中心)。
    case 'cdp_wheel': {
      const x = Number(params?.x) || 400, y = Number(params?.y) || 400;
      const dx = Number(params?.deltaX) || 0, dy = Number(params?.deltaY ?? params?.dy) || 0;
      try { await kernelWheel(accountId, x, y, dx, dy); return { ok: true }; }
      catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }
    // 主世界 fetch(CDP Runtime.evaluate 默认就在页面主世界跑):复用页面已劫持的 fetch
    // 自动签 msToken / X-Bogus,等同用户自己 fetch。取材 driver 调 aweme detail 拿 play_addr 用。
    // 返回 { ok, status, body }(body 为解析后的 JSON 或文本;responseType:'base64' 时为 base64)。
    case 'main_world_fetch_api': {
      const url = String(params?.url || '');
      if (!url) return { ok: false, error: 'url required' };
      const expr = `(async function(){try{`
        + `var r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(String(params?.method || 'GET'))},credentials:${JSON.stringify(params?.credentials || 'include')},headers:${JSON.stringify(params?.headers || {})},body:${params?.body != null ? JSON.stringify(String(params.body)) : 'null'}});`
        + `var st=r.status;`
        + `if(${JSON.stringify(String(params?.responseType || 'text'))}==='base64'){var ab=await r.arrayBuffer();var by=new Uint8Array(ab),bin='';for(var i=0;i<by.length;i++)bin+=String.fromCharCode(by[i]);return JSON.stringify({ok:true,status:st,body:btoa(bin),encoding:'base64',byteLength:by.length});}`
        + `var t=await r.text();var b;try{b=JSON.parse(t);}catch(e){b=t;}return JSON.stringify({ok:true,status:st,body:b});`
        + `}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)});}})()`;
      try { const raw = await kernelEval(accountId, expr, timeoutMs); return JSON.parse(String(raw || '{}')); }
      catch (e: any) { return { ok: false, error: 'main_world_fetch_failed:' + String(e?.message || e).slice(0, 80) }; }
    }
    // 区域截图(CDP Page.captureScreenshot):文档绝对坐标裁块 → base64 PNG(scale=2 出 2x)。
    // 爆帖成片 reddit_search driver 截帖子/评论卡用。返回 { ok, base64 }。
    case 'cdp_screenshot': {
      try {
        const clip = (Number.isFinite(Number(params?.x)) && Number.isFinite(Number(params?.width)))
          ? { x: Number(params.x), y: Number(params.y) || 0, width: Number(params.width), height: Number(params.height) || 100, scale: Number(params?.scale) || 1 }
          : undefined;
        const base64 = await kernelScreenshot(accountId, clip);
        return base64 ? { ok: true, base64 } : { ok: false, error: 'empty_screenshot' };
      } catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }
    // 整页导航(CDP Page.navigate):取材 driver 搜索/进详情页要用;执行器在页面里做不了真导航。
    case 'navigate': {
      const url = String(params?.url || '');
      if (!url) return { ok: false, error: 'navigate_needs_url' };
      try { await kernelNavigate(accountId, url); return { ok: true }; }
      catch (e: any) { return { ok: false, error: String(e?.message || e).slice(0, 80) }; }
    }
    // 当前页 URL(轻量,直接 eval,不依赖执行器在位)。
    case 'get_url': {
      const url = await kernelEval(accountId, 'location.href');
      return { ok: true, url: String(url || ''), value: url };
    }

    // 下载图片为 base64(图文创作网络图模式用)。⚠️ 必须走【主进程 Node fetch】而非内核页面 fetch:
    //   页面里跨域抓 douyinpic/xhscdn CDN 图会被 CORS 拦死(读不了跨域响应体,报 "Failed to fetch")—
    //   旧单账号版靠扩展 background fetch 绕 CORS,矩阵这边用 Node fetch(无 CORS)+ Referer 防盗链等效。
    // 返回 { base64, mimeType } 或 { error }(orchestrator 读 rRes.result||rRes 再取 .base64/.mimeType/.error)。
    case 'fetch_image': {
      const url = String(params?.url || '');
      if (!url || !/^https?:\/\//i.test(url)) return { error: 'invalid_url' };
      const referrer = String(params?.referrer || 'https://www.douyin.com/');
      const maxBytes = Number(params?.maxBytes) || 8 * 1024 * 1024;
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: referrer,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      };
      const finalize = (buf: Buffer, ct: string) => {
        if (!buf.length) return { error: 'empty_body' };
        if (buf.length > maxBytes) return { error: 'too_large' };
        return { base64: buf.toString('base64'), mimeType: (ct.split(';')[0] || '').trim() };
      };
      // 兜底:Node 内置 https/http.get(undici 在挑剔网络下会直接抛 "fetch failed",
      // 内置 get 更宽容、能拿原始字节;手动跟最多 3 跳重定向 — CDN 常 302 到真图)。同 tiktok 下载。
      const nodeGet = (target: string, redirectsLeft: number): Promise<{ buf: Buffer; ct: string } | { error: string }> =>
        new Promise((resolve) => {
          (async () => {
            try {
              // 用【静态导入】的 https/http —— 打包后的 sidecar 不支持动态 import()
              //   (抛 "A dynamic import callback was not specified"),原来 await import() 致兜底必失败。
              const mod: any = target.toLowerCase().startsWith('https') ? https : http;
              const req = mod.get(target, { headers, timeout: 30000 }, (res: any) => {
                const sc = res.statusCode || 0;
                if (sc >= 300 && sc < 400 && res.headers.location && redirectsLeft > 0) {
                  res.resume();
                  const next = new URL(res.headers.location, target).toString();
                  nodeGet(next, redirectsLeft - 1).then(resolve);
                  return;
                }
                if (sc !== 200) { res.resume(); resolve({ error: 'http_' + sc }); return; }
                const chunks: Buffer[] = [];
                let total = 0;
                let aborted = false;
                res.on('data', (c: Buffer) => {
                  total += c.length;
                  if (total > maxBytes) { aborted = true; req.destroy(); resolve({ error: 'too_large' }); return; }
                  chunks.push(c);
                });
                res.on('end', () => { if (!aborted) resolve({ buf: Buffer.concat(chunks), ct: String(res.headers['content-type'] || '') }); });
                res.on('error', (e: any) => resolve({ error: 'node_get:' + String(e?.message || e).slice(0, 50) }));
              });
              req.on('error', (e: any) => resolve({ error: 'node_get:' + String(e?.message || e).slice(0, 50) }));
              req.on('timeout', () => { req.destroy(); resolve({ error: 'node_get:timeout' }); });
            } catch (e: any) { resolve({ error: 'node_get:' + String(e?.message || e).slice(0, 50) }); }
          })();
        });

      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      try {
        const resp = await fetch(url, { headers, signal: ctrl.signal });
        // HTTP 层错误(403/404 等)再 node.get 也是同样被拒,直接返回,不浪费一轮。
        if (!resp.ok) return { error: 'http_' + resp.status };
        const ct = resp.headers.get('content-type') || '';
        const buf = Buffer.from(await resp.arrayBuffer());
        return finalize(buf, ct);
      } catch (e: any) {
        // undici 抛错(典型 "fetch failed" / abort / TLS)→ 回退 Node 内置 get。
        clearTimeout(to);
        const r = await nodeGet(url, 3);
        if ('buf' in r) return finalize(r.buf, r.ct);
        return { error: 'fetch_image_failed:' + String(e?.message || e).slice(0, 50) + '|fallback:' + (r.error || '') };
      } finally { clearTimeout(to); }
    }

    // 图片上传(图文创作发布用)。扩展版收 base64,矩阵走 CDP DOM.setFileInputFiles(只认磁盘路径),
    // 故把每张 base64 先落临时文件,再 setFileInputFiles。返回 { message } / { error }。
    // 兼容两种签名:多文件 { files:[{fileData,fileName,mimeType}] }(抖音一次塞多张)和
    //   单文件 { fileData, fileName, mimeType }(小红书逐张上传)。
    // ⚠️ 临时文件不能立刻删:setFileInputFiles 后浏览器是【异步】读盘上传的,删早了会传空 → 延迟清理。
    case 'upload_file': {
      const files = (Array.isArray(params?.files) && params.files.length)
        ? params.files
        : (params?.fileData ? [{ fileData: params.fileData, fileName: params.fileName, mimeType: params.mimeType }] : []);
      if (!files.length) return { error: 'no_files' };
      const tmpPaths: string[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const b64 = String(files[i]?.fileData || '');
          if (!b64) continue;
          const mime = String(files[i]?.mimeType || 'image/jpeg');
          const ext = mime.indexOf('png') >= 0 ? 'png' : (mime.indexOf('webp') >= 0 ? 'webp' : 'jpg');
          const p = path.join(os.tmpdir(), `nbmx_img_${Date.now()}_${i}_${Math.floor(Math.random() * 1e6)}.${ext}`);
          fs.writeFileSync(p, Buffer.from(b64, 'base64'));
          tmpPaths.push(p);
        }
        if (!tmpPaths.length) return { error: 'empty_files' };
        // single:true —— 图文上传只灌【一个】image input(对齐扩展 uploadFileFromUrl 的 querySelector 单设);
        //   否则"全设"会把图也灌进图文页「添加文件」附件 input,帖子冒出多余 nbmx_img.jpg 文件(图片本身正常)。
        const r: any = await kernelSetFileInput(accountId, String(params?.selector || ''), tmpPaths, { deep: true, single: true });
        // 5 分钟后清理临时文件(此时上传早已完成),避免 tmp 堆积。
        setTimeout(() => { for (const p of tmpPaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } } }, 5 * 60 * 1000);
        return r && r.ok ? { ok: true, message: `set ${tmpPaths.length} files` } : { error: (r && r.reason) || 'set_file_input_failed' };
      } catch (e: any) {
        for (const p of tmpPaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
        return { error: 'upload_file_failed:' + String(e?.message || e).slice(0, 80) };
      }
    }

    // ── 页面类命令:走服务端下发的执行器(复用扩展实现)──
    //   query_selector / type / fill / set_input_value / main_world_click /
    //   editor_insert_text / editor_paste_text / click_with_text / scroll /
    //   scroll_to / get_text / get_value / hover / wait_for / click …
    default:
      return await kernelExec(accountId, command, params || {}, timeoutMs);
  }
}
