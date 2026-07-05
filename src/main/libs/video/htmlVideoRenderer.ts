/**
 * htmlVideoRenderer — 「模板速生」HF 派的画面引擎。
 *
 * 抄 HyperFrames:把【自包含动效 HTML(带 paused seek 协议)】用无头浏览器逐帧 seek +
 * 截图,帧二进制直接 pipe 到 ffmpeg stdin 编码 mp4 —— **不落盘 PNG**,无需中转目录,
 * 无需第二次读盘。
 *
 * 跟 v2 的差异:
 *   · v2:Runtime.evaluate("renderFrame(t)") + Page.captureScreenshot → 写 PNG 到 framesDir
 *     → ffmpeg 二阶段读 PNG 序列编码
 *   · v3:Runtime.evaluate("__nbc.seek(t)") + Page.captureScreenshot → 帧 buffer 直接 pipe 给
 *     ffmpeg → ffmpeg 单一阶段完成编码。省一次磁盘 I/O,且过程中可同时混音轨/字幕轨。
 *
 * HF 原版用 HeadlessExperimental.beginFrame —— 那个 CDP 域在很多 Chromium 分支上不稳,
 * 我们走 Page.captureScreenshot(更普适)+ stdin pipe 也能拿到同样的「不落盘」收益。
 *
 * HTML 契约(由 templateLibrary 产、本模块消费):
 *   · 画布固定 1080×1920
 *   · 全局 `window.__nbc.seek(t)` —— 把页面 seek 到时间 t(秒),纯函数无壁钟
 *   · 全局常量 `window.DURATION`(秒),可选 `window.FPS`
 *   · `window.__nbc.ready === true` 表示协议就绪
 */

import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getFfmpegPath } from './ffmpegRuntime';

export interface RenderHtmlToVideoOptions {
  html: string;
  width?: number;          // 默认 1080
  height?: number;         // 默认 1920
  fps?: number;            // 默认 30
  durationSec: number;     // 总时长(秒)
  outPath: string;         // 成片 mp4 路径
  /** 可选:背景音乐(本地路径)。空 = 不加。 */
  bgmPath?: string;
  bgmVolume?: number;      // 默认 0.18
  /** 可选:配音音频(本地路径)。空 = 无配音(纯视觉)。 */
  narrationPath?: string;
  narrationVolume?: number; // 默认 1.0
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  timeoutMsPerFrame?: number; // 单帧超时,默认 8000
}

export interface RenderHtmlResult {
  outPath: string;
  frameCount: number;
  fps: number;
  width: number;
  height: number;
}

export interface ProbeHtmlResult {
  ok: boolean;
  reason?: string;
  durationSec?: number;
  fps?: number;
}

export interface AuditHtmlResult {
  /** true = 没发现布局问题(可直接出片);false = issues 里有要修的。 */
  ok: boolean;
  /** 结构化问题清单(中文,可直接喂回 AI 让它改)。 */
  issues: string[];
  /** 致命:契约都不成立(没 __nbc.seek / DURATION),issues 也会带一条。 */
  fatal?: string;
}

export interface HeadlessBrowser {
  path: string;
  kind: 'chrome' | 'edge' | 'chromium';
}

// ── 无头浏览器检测 ────────────────────────────────────────────────────────

export function resolveHeadlessBrowser(): HeadlessBrowser | null {
  const env = process.env.NOOBCLAW_CHROME_PATH;
  if (env && fs.existsSync(env)) {
    const k = /edge/i.test(env) ? 'edge' : /chromium/i.test(env) ? 'chromium' : 'chrome';
    return { path: env, kind: k };
  }
  const cands: HeadlessBrowser[] = [];
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pfx86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || '';
    cands.push(
      { path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' },
      { path: path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' },
      { path: path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' },
      // Windows 几乎必有 Edge(Chromium 内核,--headless=new + CDP 完全一致)→ 兜底
      { path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'edge' },
      { path: path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'edge' },
    );
  } else if (process.platform === 'darwin') {
    cands.push(
      { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
      { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chromium' },
      { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'edge' },
    );
  } else {
    cands.push(
      { path: '/usr/bin/google-chrome', kind: 'chrome' },
      { path: '/usr/bin/google-chrome-stable', kind: 'chrome' },
      { path: '/usr/bin/chromium-browser', kind: 'chromium' },
      { path: '/usr/bin/chromium', kind: 'chromium' },
    );
  }
  for (const c of cands) if (fs.existsSync(c.path)) return c;
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 独立无头会话(自管 ws + 进程 + 临时 profile,与 cdpBrowser 全局单例隔离)──

class HeadlessSession {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private port = 0;
  private profileDir = '';
  private _id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  async launch(width: number, height: number): Promise<void> {
    const browser = resolveHeadlessBrowser();
    if (!browser) throw new Error('未检测到 Chrome/Edge,模板速生需要其一(Windows 自带 Edge 即可)');
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-htmlrender-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',          // 系统分配,绝不复用 cowork 的 9222
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--hide-scrollbars', '--mute-audio',
      '--disable-extensions', '--disable-background-networking',
      `--window-size=${width},${height}`, '--force-device-scale-factor=1',
      'about:blank',
    ];
    this.proc = spawn(browser.path, args, { stdio: 'ignore', windowsHide: true });
    this.proc.on('error', () => { /* surfaced via launch timeout below */ });

    // 读 DevToolsActivePort(Chrome 启动后写入 profile 目录,首行 = 真实端口)
    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    for (let i = 0; i < 60 && !this.port; i++) {
      await sleep(200);
      try {
        const txt = fs.readFileSync(portFile, 'utf8').trim();
        const p = parseInt(txt.split('\n')[0], 10);
        if (p > 0) this.port = p;
      } catch { /* not ready */ }
    }
    if (!this.port) { await this.close(); throw new Error('无头浏览器调试端口未就绪'); }

    // 连一个 page target
    let pageWsUrl = '';
    for (let i = 0; i < 30 && !pageWsUrl; i++) {
      try {
        const list: any[] = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) pageWsUrl = page.webSocketDebuggerUrl;
      } catch { /* retry */ }
      if (!pageWsUrl) await sleep(200);
    }
    if (!pageWsUrl) { await this.close(); throw new Error('无头浏览器页面目标未就绪'); }

    this.ws = new WebSocket(pageWsUrl);
    await new Promise<void>((res, rej) => {
      this.ws!.once('open', () => res());
      this.ws!.once('error', (e) => rej(e));
    });
    this.ws.on('message', (data) => {
      let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const h = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(h.timer);
        if (msg.error) h.reject(new Error(msg.error.message || 'CDP error'));
        else h.resolve(msg.result);
      }
    });

    await this.cmd('Page.enable');
    await this.cmd('Runtime.enable');
    // 禁网:渲染的是 AI 生成的 HTML,二次兜底封死任何外链外泄/卡死
    try {
      await this.cmd('Network.enable');
      await this.cmd('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });
    } catch { /* Network 域不可用也不阻塞,file:// 本就离线 */ }
    await this.cmd('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false });
  }

  cmd(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
    if (!this.ws) return Promise.reject(new Error('CDP 未连接'));
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigateHtml(html: string): Promise<string> {
    const htmlFile = path.join(this.profileDir, 'scene.html');
    fs.writeFileSync(htmlFile, html, 'utf8');
    const url = 'file:///' + htmlFile.replace(/\\/g, '/');
    await this.cmd('Page.navigate', { url });
    return htmlFile;
  }

  /** 等页面 + 字体 + __nbc 协议就绪。 */
  async waitReady(): Promise<void> {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const r = await this.cmd('Runtime.evaluate', {
          expression: 'document.readyState === "complete" && window.__nbc && window.__nbc.ready === true',
          returnByValue: true,
        });
        if (r?.result?.value === true) break;
      } catch { /* keep polling */ }
      await sleep(150);
    }
    // 字体就绪(promise);失败不阻塞
    try { await this.cmd('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }); } catch { /* ignore */ }
    await sleep(120);
  }

  /** Seek 页面到时间 t(秒)。这是 HF 派核心 —— 一次调用整张画面到目标时间点。 */
  async seekAt(t: number): Promise<void> {
    await this.cmd('Runtime.evaluate', { expression: `window.__nbc.seek(${t})` });
  }

  /** 读 window.DURATION / window.FPS / __nbc.seek 是否合法。 */
  async readContract(): Promise<{ ok: boolean; durationSec?: number; fps?: number; reason?: string }> {
    try {
      const r = await this.cmd('Runtime.evaluate', {
        expression:
          '(function(){try{if(!window.__nbc||typeof window.__nbc.seek!=="function")return{ok:false,reason:"no __nbc.seek"};'
          + 'if(typeof window.DURATION!=="number"||!(window.DURATION>0))return{ok:false,reason:"no DURATION"};'
          + 'window.__nbc.seek(0);return{ok:true,durationSec:window.DURATION,fps:(typeof window.FPS==="number"&&window.FPS>0)?window.FPS:0};}'
          + 'catch(e){return{ok:false,reason:String(e&&e.message||e)};}})()',
        returnByValue: true,
      });
      return r?.result?.value || { ok: false, reason: 'eval failed' };
    } catch (e) {
      return { ok: false, reason: String((e as Error)?.message || e) };
    }
  }

  async shot(width: number, height: number, timeoutMs: number): Promise<Buffer> {
    // JPEG quality 85:1080×1920 PNG 通常 1-3MB,JPEG 缩到 100-300KB,base64 传输 +
    //   Buffer.from 解码 + ffmpeg stdin 写都跟着变快 5-10x。视频帧最终走 H264 二次编码,
    //   JPEG 85 的损失肉眼不可见。probeHtml 那两帧 t=0 vs t=DUR/2 对比仍 work —— 同 t 两次
    //   JPEG 字节一致(chromium JPEG encoder 是确定性的),不同 t 画面有差异自然字节不同。
    const r = await this.cmd('Page.captureScreenshot',
      { format: 'jpeg', quality: 85, clip: { x: 0, y: 0, width, height, scale: 1 } }, timeoutMs);
    return Buffer.from(r.data, 'base64');
  }

  async close(): Promise<void> {
    for (const h of this.pending.values()) { clearTimeout(h.timer); }
    this.pending.clear();
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
    this.proc = null;
    const dir = this.profileDir;
    this.profileDir = '';
    // Windows:chrome 退出后文件锁释放有延迟,删太快会 EPERM → 延迟 + 重试 3 次。
    if (dir) {
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; }
        catch { await sleep(300); }
      }
    }
  }
}

// ── ffmpeg pipe 编码器 ──────────────────────────────────────────────────

/**
 * 构造 ffmpeg 参数:图片序列从 stdin pipe(`-f image2pipe`),
 * 加 0~1 条配音 + 0~1 条 BGM,混音输出 mp4。
 *
 * 关键 ffmpeg 用法:
 *   · `-f image2pipe -framerate <fps> -i -`:从 stdin 读图片序列(每帧一张)。
 *     image2pipe demuxer 按 magic bytes 自动探测格式 —— 当前实际传 JPEG(见
 *     HeadlessSession.shot,2026-06 起 PNG → JPEG/85 为加速换的);PNG 也兼容。
 *   · BGM 用 `-stream_loop -1` 循环铺底
 *   · 音轨混音 = filter_complex 的 amix(narration:1.0, bgm:0.18)+ shortest
 */
function buildPipeEncodeArgs(opts: {
  fps: number;
  outPath: string;
  narrationPath?: string;
  narrationVolume: number;
  bgmPath?: string;
  bgmVolume: number;
  durationSec: number;
}): string[] {
  const args: string[] = ['-y'];
  // 0:v ← stdin PNG 序列
  args.push('-f', 'image2pipe', '-framerate', String(opts.fps), '-i', '-');
  // 1:a ← narration(可选)
  if (opts.narrationPath) {
    args.push('-i', opts.narrationPath);
  }
  // 2:a / 1:a ← bgm(可选,带 stream_loop)
  if (opts.bgmPath) {
    args.push('-stream_loop', '-1', '-i', opts.bgmPath);
  }

  const audioInputs: string[] = [];
  let nextIdx = 1;
  if (opts.narrationPath) {
    audioInputs.push(`[${nextIdx}:a]volume=${opts.narrationVolume.toFixed(2)}[an]`);
    nextIdx++;
  }
  if (opts.bgmPath) {
    audioInputs.push(`[${nextIdx}:a]volume=${opts.bgmVolume.toFixed(2)}[ab]`);
  }

  // 混音 filter_complex
  if (opts.narrationPath && opts.bgmPath) {
    const fc = `${audioInputs.join(';')};[an][ab]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    args.push('-filter_complex', fc);
    args.push('-map', '0:v', '-map', '[aout]');
  } else if (opts.narrationPath) {
    args.push('-filter_complex', audioInputs[0].replace('[an]', '[aout]'));
    args.push('-map', '0:v', '-map', '[aout]');
  } else if (opts.bgmPath) {
    args.push('-filter_complex', audioInputs[0].replace('[ab]', '[aout]'));
    args.push('-map', '0:v', '-map', '[aout]');
  } else {
    args.push('-map', '0:v');
  }

  // 视频编码
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-movflags', '+faststart');
  // 音频编码(只在有音轨时设)
  if (opts.narrationPath || opts.bgmPath) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  }
  // 总时长 = HTML 动画时长(避免 BGM 循环没尽头)
  args.push('-t', opts.durationSec.toFixed(3));
  args.push(opts.outPath);
  return args;
}

/** ffmpeg 进程包装:暴露 stdin 给逐帧 pipe,close 时等退出。 */
class FfmpegPipeEncoder {
  private proc: ChildProcess | null = null;
  private stderr = '';
  private exitPromise: Promise<{ ok: boolean; code: number | null; stderr: string }> = Promise.resolve({ ok: false, code: null, stderr: '' });

  start(args: string[], onStderrLine?: (line: string) => void): void {
    const bin = getFfmpegPath();
    this.proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.proc.stderr?.on('data', (b: Buffer) => {
      const text = b.toString();
      this.stderr += text;
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-100_000);
      if (onStderrLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onStderrLine(line);
        }
      }
    });
    this.exitPromise = new Promise((resolve) => {
      this.proc!.on('close', (code) => resolve({ ok: code === 0, code, stderr: this.stderr }));
      this.proc!.on('error', (e) => resolve({ ok: false, code: null, stderr: this.stderr + '\n[spawn error] ' + String(e) }));
    });
  }

  /** 写一帧 PNG 到 ffmpeg stdin。stdin 写满时等 drain,避免内存爆。 */
  writeFrame(buf: Buffer): Promise<void> {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return Promise.reject(new Error('ffmpeg stdin 已关闭'));
    return new Promise((resolve, reject) => {
      const stdin = this.proc!.stdin!;
      const ok = stdin.write(buf, (err) => err ? reject(err) : resolve());
      if (!ok) stdin.once('drain', () => { /* drain 触发就行,resolve 已经在 write 回调里 */ });
    });
  }

  endStdin(): void {
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
  }

  kill(): void {
    try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
  }

  waitExit(): Promise<{ ok: boolean; code: number | null; stderr: string }> {
    return this.exitPromise;
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────────

/**
 * 渲染 HTML 动画 → mp4(直接出成片,不落盘 PNG)。
 *
 * 流程:
 *   1. 启无头浏览器,导航到 file://(HTML 写到临时 profile 目录)
 *   2. 等 `__nbc.ready === true` + 字体就绪
 *   3. 启 ffmpeg,stdin pipe;同步把 narration/bgm 当 -i 输入混音
 *   4. 逐帧:seek(t) → captureScreenshot → 写 ffmpeg stdin
 *   5. 关 stdin,等 ffmpeg 退出
 */
export async function renderHtmlToVideo(opts: RenderHtmlToVideoOptions): Promise<RenderHtmlResult> {
  const width = opts.width || 1080;
  const height = opts.height || 1920;
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 30;
  const dur = Math.max(0.5, opts.durationSec);
  const total = Math.max(1, Math.round(fps * dur));
  const perFrameTimeout = opts.timeoutMsPerFrame || 8000;

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });

  const session = new HeadlessSession();
  const encoder = new FfmpegPipeEncoder();
  let started = false;

  try {
    await session.launch(width, height);
    await session.navigateHtml(opts.html);
    await session.waitReady();

    // 拉起 ffmpeg(只在 HTML 就绪后启,避免空跑/超时窗口)
    const ffArgs = buildPipeEncodeArgs({
      fps, outPath: opts.outPath,
      narrationPath: opts.narrationPath,
      narrationVolume: typeof opts.narrationVolume === 'number' && opts.narrationVolume >= 0 ? opts.narrationVolume : 1.0,
      bgmPath: opts.bgmPath,
      bgmVolume: typeof opts.bgmVolume === 'number' && opts.bgmVolume >= 0 ? opts.bgmVolume : 0.18,
      durationSec: dur,
    });
    encoder.start(ffArgs);
    started = true;

    // 流水线优化:同帧 seek→shot 必须串行(否则会拍到错时间画面),但 shot(N) 之后
    //   到下一轮 shot(N+1) 之前的窗口里,seek(N+1) 跟 writeFrame(N) 完全可以并发 ——
    //   ffmpeg stdin 反压时 chromium 不再干等。原先三步串行单核走完,改后单核两路并行,
    //   理论上限 ~1.5x 提速,叠加 PNG→JPEG 的 2-3x,合计 3-5x。
    //
    //   异步 seek 的拒绝处理:不立即 throw(没人 await 会变 unhandled rejection),记到
    //   seekErr,在下一轮 await nextSeekPromise 后检查。
    let seekErr: unknown = null;
    let nextSeekPromise: Promise<void> = session.seekAt(0).catch((e) => { seekErr = e; });
    for (let f = 0; f < total; f++) {
      if (opts.signal?.aborted) throw new Error('aborted');
      await nextSeekPromise;
      if (seekErr) throw seekErr;
      const png = await session.shot(width, height, perFrameTimeout);
      // 排下一帧 seek(不等);自己同时 await 当前帧 writeFrame。
      nextSeekPromise = f + 1 < total
        ? session.seekAt((f + 1) / fps).catch((e) => { seekErr = e; })
        : Promise.resolve();
      await encoder.writeFrame(png);
      opts.onProgress?.(f + 1, total);
    }

    encoder.endStdin();
    const r = await encoder.waitExit();
    if (!r.ok) {
      const tail = (r.stderr || '').replace(/\s+/g, ' ').trim().slice(-400);
      throw new Error(`ffmpeg 编码失败:${tail || '(无 stderr)'}`);
    }
    return { outPath: opts.outPath, frameCount: total, fps, width, height };
  } catch (err) {
    if (started) encoder.kill();
    throw err;
  } finally {
    await session.close();
  }
}

// ── 布局体检 JS(在页面里跑,返回中文问题清单)──────────────────────────────
// 这是「AI 自由排版」没有视觉模型时的【眼睛】:纯 getBoundingClientRect/getComputedStyle,
// 确定性、免费。抓的都是「效果差」的元凶:溢出、文字被裁、元素重叠、出场动画没接上。
const AUDIT_JS = `(function(){
  var W=1080,H=1920,issues=[];
  var stage=document.getElementById('stage')||document.body;
  var capTrack=document.getElementById('caption-track');
  var capBand=H-240; // 有字幕时,底部 240px 是字幕专属区,内容不许进入
  function cs(el){return getComputedStyle(el);}
  function vis(el){var s=cs(el);if(s.display==='none'||s.visibility==='hidden')return false;if(parseFloat(s.opacity||'1')<0.05)return false;var r=el.getBoundingClientRect();return r.width>=2&&r.height>=2;}
  function ownText(el){var t='';for(var i=0;i<el.childNodes.length;i++){if(el.childNodes[i].nodeType===3)t+=el.childNodes[i].textContent;}return t.trim();}
  function isFx(el){var c=' '+(el.className&&el.className.baseVal!==undefined?el.className.baseVal:(''+el.className))+' ';return /\\b(bg-grid|bg-glow|fx-|caption-track|watermark)\\b/.test(c)||el.id==='caption-track'||el.id==='watermark';}
  var all=stage.querySelectorAll('*'),texts=[];
  for(var i=0;i<all.length;i++){
    var el=all[i];if(isFx(el)||!vis(el))continue;
    if(capTrack&&capTrack.contains(el))continue; // 字幕轨自身不算内容
    var r=el.getBoundingClientRect(),ot=ownText(el);
    // 1) 带文字的元素超出画布
    if(ot&&(r.left<-10||r.top<-10||r.right>W+10||r.bottom>H+10)){
      issues.push('元素超出画布: "'+ot.slice(0,16)+'" 位置['+Math.round(r.left)+','+Math.round(r.top)+'→'+Math.round(r.right)+','+Math.round(r.bottom)+'] 超出 1080x1920');
    }
    // 2) 文字被容器裁切(overflow hidden 把内容切了)
    //    纵向容差必须与 data-fit 的 over() 一致(0.3×字号):line-height:1 的大数字/大标题,
    //    其 line-box(含幽灵升降部)比可见字形高 ~20%,scrollHeight 天然比 clientHeight 高一截 ——
    //    这是 data-fit 【故意容忍】的假溢出(数字无降部、字形居中,并未真被裁)。若这里只给 +4px,
    //    就会把每个大数字/大标题误报「被裁切」(严重项),反而把不塌的结构化版打成废片。真裁切=多出
    //    整行 ≈ 1.0×字号,远超 0.3× 容差,照样能抓到。横向仍收紧到 +4(粗体溢出个位像素)。
    var ov=cs(el);var ovs=(ov.overflow||'')+(ov.overflowX||'')+(ov.overflowY||'');
    if(/hidden|clip/.test(ovs)&&ot){
      var _fs=parseFloat(ov.fontSize)||40; var _vtol=Math.max(8,_fs*0.34);
      if(el.scrollWidth>el.clientWidth+4||el.scrollHeight>el.clientHeight+_vtol){
        issues.push('文字被裁切: "'+ot.slice(0,16)+'" 内容'+el.scrollWidth+'x'+el.scrollHeight+'>容器'+el.clientWidth+'x'+el.clientHeight+'(放大容器或缩小字号/换行)');
      }
    }
    // 3) 出场动画没接上:带 data-anim 且无退场,settled 时却几乎不可见 → 时序写错
    if(el.hasAttribute('data-anim')&&!el.hasAttribute('data-exit-start')&&ot){
      if(parseFloat(ov.opacity||'1')<0.3){
        issues.push('出场动画没接上(settled 时仍透明): "'+ot.slice(0,16)+'" — 检查 data-start/data-duration 是否落在 [0,DURATION]');
      }
    }
    if(ot)texts.push({r:r,t:ot,el:el});
  }
  // 4) 文字元素两两显著重叠(取叶子文字,父链包含关系跳过)
  for(var a=0;a<texts.length;a++)for(var b=a+1;b<texts.length;b++){
    var A=texts[a],B=texts[b];
    if(A.el.contains(B.el)||B.el.contains(A.el))continue;
    var ix=Math.max(0,Math.min(A.r.right,B.r.right)-Math.max(A.r.left,B.r.left));
    var iy=Math.max(0,Math.min(A.r.bottom,B.r.bottom)-Math.max(A.r.top,B.r.top));
    var inter=ix*iy;if(inter<=0)continue;
    var small=Math.min(A.r.width*A.r.height,B.r.width*B.r.height);
    if(small>0&&inter/small>0.4){
      issues.push('文字重叠: "'+A.t.slice(0,12)+'" 与 "'+B.t.slice(0,12)+'" 重叠'+Math.round(inter/small*100)+'%');
    }
  }
  // 5) 画面太空(可见文字元素 < 1 条)
  if(texts.length<1)issues.push('画面几乎空白(settled 时没有可见文字内容)— 检查动画时序/元素是否被裁没');
  // 6) 字幕区入侵:有字幕轨时,内容底边进入底部 240px → 会被烧字幕盖住
  if(capTrack){
    for(var z=0;z<texts.length;z++){
      if(texts[z].r.bottom>capBand){ issues.push('内容进入字幕区(会被字幕盖住): "'+texts[z].t.slice(0,16)+'" 底边'+Math.round(texts[z].r.bottom)+'>'+capBand+' — 所有内容控制在 y≤'+capBand); }
    }
  }
  // 去重 + 截断
  var seen={},out=[];for(var k=0;k<issues.length;k++){if(!seen[issues[k]]){seen[issues[k]]=1;out.push(issues[k]);}if(out.length>=12)break;}
  return out;
})()`;

// ── 内容推进体检 JS:返回 {last, n} ────────────────────────────────────────
// last = 最后一次「内容活动」的结束时刻(秒)= 所有 data-start/data-exit 入退场结束 + GSAP
//        时间线总时长 取最大;n = 带 data-start 的条目数。
// 用途:有配音时,若 n 个条目在全片前 60% 就全部入场/动完(last 太小),说明内容没跟着
//      口播逐条推进、后段只剩环境动效空转(像素级 freeze 检测会被环境动效骗过去,这里靠
//      声明式时序硬判)。环境动效 data-loop 不计入 last(它是循环点缀、不推进内容)。
const ACTIVITY_JS = `(function(){
  var stage=document.getElementById('stage')||document.body;
  var els=stage.querySelectorAll('[data-start]');
  var last=0,n=0;
  for(var i=0;i<els.length;i++){
    var el=els[i];
    var s=parseFloat(el.getAttribute('data-start'))||0;
    var d=parseFloat(el.getAttribute('data-duration'));
    if(isNaN(d))d=0.6;
    last=Math.max(last,s+d);n++;
    var es=parseFloat(el.getAttribute('data-exit-start'));
    if(!isNaN(es)){var ed=parseFloat(el.getAttribute('data-exit-duration'));if(isNaN(ed))ed=0.6;last=Math.max(last,es+ed);}
  }
  try{var tls=window.__timelines||{};for(var k in tls){var tl=tls[k];if(tl&&typeof tl.duration==='function'){var td=tl.duration();if(typeof td==='number'&&isFinite(td))last=Math.max(last,td);}}}catch(e){}
  return {last:last,n:n};
})()`;

/**
 * 布局体检:启短命无头实例,seek 到 settled 时刻(DURATION*0.92,进场已完成、尾段稳定),
 * 跑 AUDIT_JS 查溢出/裁切/重叠/动画没接上;再做【确定性自检】(同一帧渲两次像素必须一致,
 * 抓 AI 偷用 random/时钟)。给 freeform 迭代闭环当「眼睛」。绝不抛(异常 → ok:false + 原因)。
 * opts.narrationOn=true 时额外查【内容推进】:有配音却把条目挤在前段铺完(后段无新内容跟口播)。
 */
export async function auditHtml(html: string, opts?: { narrationOn?: boolean }): Promise<AuditHtmlResult> {
  const width = 1080, height = 1920;
  const session = new HeadlessSession();
  try {
    await session.launch(width, height);
    await session.navigateHtml(html);
    await session.waitReady();
    const contract = await session.readContract();
    if (!contract.ok) {
      return { ok: false, fatal: contract.reason, issues: [`渲染契约不成立(${contract.reason || '无 __nbc.seek/DURATION'})— 必须保证 window.__nbc.seek(t) 与 window.DURATION 可用`] };
    }
    const dur = contract.durationSec || 5;
    const settled = Math.max(0.2, dur * 0.92);
    const mid = Math.max(0.1, dur * 0.5);
    const issues: string[] = [];
    const eq = (a: Buffer, b: Buffer) => a.length === b.length && a.equals(b);
    // 取 t=0 / 中段 / settled 三帧,判「有没有动画」「后半段是否定格」「确定性」
    await session.seekAt(0);
    const f0 = await session.shot(width, height, 8000);
    await session.seekAt(mid);
    const fMid = await session.shot(width, height, 8000);
    await session.seekAt(settled);
    const f1 = await session.shot(width, height, 8000);
    await session.seekAt(settled);
    const f2 = await session.shot(width, height, 8000); // 确定性:settled 渲两次必须一致
    if (eq(f0, f1)) {
      issues.push('画面没有动画(t=0 与结尾完全一样)— 给元素加 data-* 进场动画或 GSAP 时间线');
    } else if (eq(fMid, f1)) {
      // 进场后就定格(中段=结尾),正是「画面停住没变化」 —— 要持续动效或分段轮播
      issues.push('后半段画面静止(进场后就定格不动)— 加 data-loop 环境动效(背景 float / 标题 sweep / 数字 count-up)让画面持续变化,或内容分段轮播(data-exit-start)随时间切换');
    }
    if (!eq(f1, f2)) {
      issues.push('动画非确定性(同一时间点渲两次画面不一致)— 禁止 Date/Math.random/setInterval/requestAnimationFrame,只能用 data-* 或 paused GSAP 时间线');
    }
    // 内容推进体检(仅有配音 + 全片≥8s):条目(≥4)若在前 60% 就全部入场/动完,说明画面没跟着
    // 口播逐条推进、后段空转 —— 像素 freeze 检测会被环境动效骗过,这里靠声明式时序硬判。
    if (opts?.narrationOn && dur >= 8) {
      try {
        const act = await session.cmd('Runtime.evaluate', { expression: ACTIVITY_JS, returnByValue: true });
        const v = act?.result?.value as { last?: number; n?: number } | undefined;
        if (v && typeof v.last === 'number' && typeof v.n === 'number' && v.n >= 4 && v.last < dur * 0.6) {
          issues.push(`配音模式内容推进太靠前:${v.n} 个条目在 ${v.last.toFixed(1)}s 前就全部入场/动完(全片 ${dur.toFixed(1)}s),后段没有新内容跟着口播推进(用户会觉得「口播念到后面、画面没变」)— 把各条目入场(data-start)沿整段时长铺开:第 k 条≈(k-1)/N×${dur.toFixed(1)}s、最后一条接近结尾;或让当前被念到的条目高亮、或分段轮播(data-exit-start)`);
        }
      } catch { /* 取时序失败不阻塞体检 */ }
    }
    // 布局体检(在 settled 帧上)
    const r = await session.cmd('Runtime.evaluate', { expression: AUDIT_JS, returnByValue: true });
    const layoutIssues: string[] = Array.isArray(r?.result?.value) ? r.result.value : [];
    for (const x of layoutIssues) if (typeof x === 'string') issues.push(x);
    return { ok: issues.length === 0, issues: issues.slice(0, 12) };
  } catch (e) {
    return { ok: false, issues: [`体检异常:${String((e as Error)?.message || e)}`] };
  } finally {
    await session.close();
  }
}

/**
 * 动态预检:启短命无头实例,验证 HTML 契约 + t=0 与 t=DUR/2 两帧像素必须不同
 * (否则 = 动画没接 t,等于静态图,判不合格)。给 templateHtmlWriter 做重试/降级判定。
 */
export async function probeHtml(html: string): Promise<ProbeHtmlResult> {
  const width = 1080, height = 1920;
  const session = new HeadlessSession();
  try {
    await session.launch(width, height);
    await session.navigateHtml(html);
    await session.waitReady();
    const contract = await session.readContract();
    if (!contract.ok) return { ok: false, reason: contract.reason || 'contract invalid' };
    const dur = contract.durationSec || 5;
    // 两帧差异:t=0 vs t=DUR/2
    await session.seekAt(0);
    const a = await session.shot(width, height, 8000);
    await session.seekAt(dur / 2);
    const b = await session.shot(width, height, 8000);
    if (a.length === b.length && a.equals(b)) {
      return { ok: false, reason: '动画无变化(seek 未按 t 改变画面)' };
    }
    return { ok: true, durationSec: dur, fps: contract.fps || 30 };
  } catch (e) {
    return { ok: false, reason: String((e as Error)?.message || e) };
  } finally {
    await session.close();
  }
}
