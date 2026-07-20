/**
 * threadProvider — 爆帖成片的内容源(v1: Reddit)。
 *
 * 职责(全部跑在【联网版无头 Chrome】里,不走主进程 undici):
 *   · pickRedditPost      选帖:r/<sub>/hot.json 前 25 条过滤后按赞数加权随机 1 条
 *   · fetchRedditComments 拉高赞评论:comments/<id>.json?sort=top 过滤后返回
 *   · captureThreadCards  真截图:开帖子页,原地替换 DOM 文字(翻译),对帖子/评论
 *                         元素逐个 CDP 截图出 PNG
 *
 * 为什么必须走无头 Chrome:
 *   1. 主进程 undici 不吃规则型 VPN(memory 实证),而 Reddit 必须翻墙;Chrome 吃系统代理。
 *   2. .json 接口在页面上下文里 fetch(先导航到 reddit.com 再 same-origin fetch,绕 CORS),
 *      与截图共用同一会话/cookie,行为最像真用户。
 *
 * 过滤链像素级对齐 RedditVideoMakerBot(utils/subreddit.py get_subreddit_undone +
 * reddit/subreddit.py 评论过滤):NSFW/置顶/评论数下限/屏蔽词/已做去重;评论去
 * [removed]/[deleted]、长度 10~500、剥链接。
 *
 * ⚠️ 截图 selector 是 Reddit 现行 shreddit UI(web component,大部分在 light DOM),
 * 每处都带多级 fallback + 结构化 diag;真机联调时按 diag 调 selector。
 */

import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveHeadlessBrowser } from './htmlVideoRenderer';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

export interface RedditPost {
  id: string;            // 不带 t3_ 前缀
  subreddit: string;
  title: string;
  selftext: string;
  author: string;
  score: number;
  numComments: number;
  permalink: string;     // /r/xxx/comments/id/slug/
  over18: boolean;
}

export interface RedditComment {
  id: string;            // 不带 t1_ 前缀
  author: string;
  body: string;
  score: number;
}

// ── 联网版无头会话(copy 自 htmlVideoRenderer.HeadlessSession 原地改:放开网络、
//    覆写 UA、加导航/绝对坐标截图;两边刻意不抽公用件,互不牵连)──────────────

export class ThreadSession {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private port = 0;
  private profileDir = '';
  private _id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  async launch(width = 1080, height = 1920): Promise<void> {
    const browser = resolveHeadlessBrowser();
    if (!browser) throw new Error('未检测到 Chrome/Edge,爆帖成片需要其一(Windows 自带 Edge 即可)');
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-thread-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--hide-scrollbars', '--mute-audio',
      '--disable-extensions',
      `--window-size=${width},${height}`,
      '--lang=en-US',
      'about:blank',
    ];
    this.proc = spawn(browser.path, args, { stdio: 'ignore', windowsHide: true });
    this.proc.on('error', () => { /* surfaced via launch timeout below */ });

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
    // headless=new 的 UA 带 HeadlessChrome,Reddit 会区别对待 → 覆写成正常桌面 Chrome
    try {
      await this.cmd('Network.enable');
      await this.cmd('Network.setUserAgentOverride', {
        userAgent: DESKTOP_UA,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: 'Win32',
      });
    } catch { /* UA 覆写失败不阻塞,只是被识别为 headless 的风险高些 */ }
    // 深色模式:shreddit 跟随 prefers-color-scheme(未登录态),深色卡在游戏背景上更好看
    try {
      await this.cmd('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: 'dark' }],
      });
    } catch { /* 拿到浅色卡也能用 */ }
    await this.cmd('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile: false });
  }

  cmd(method: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<any> {
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

  /** 导航并等 readyState=complete(+ settle)。shreddit 是重前端,多给点时间。 */
  async goto(url: string, settleMs = 2500, timeoutMs = 45000): Promise<void> {
    await this.cmd('Page.navigate', { url }, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await this.cmd('Runtime.evaluate', {
          expression: 'document.readyState === "complete"',
          returnByValue: true,
        });
        if (r?.result?.value === true) break;
      } catch { /* keep polling */ }
      await sleep(250);
    }
    await sleep(settleMs);
  }

  /** 页面上下文里执行表达式取 JSON 值(支持 async 表达式)。 */
  async evalJson<T = any>(expression: string, timeoutMs = 30000): Promise<T> {
    const r = await this.cmd('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs);
    if (r?.exceptionDetails) {
      throw new Error(`页面执行失败: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown'}`);
    }
    return r?.result?.value as T;
  }

  /** 按【文档绝对坐标】截一块存 PNG(captureBeyondViewport 免滚动拼接)。 */
  async shotClipToFile(clip: { x: number; y: number; width: number; height: number }, outPath: string): Promise<void> {
    const r = await this.cmd('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
    }, 30000);
    fs.writeFileSync(outPath, Buffer.from(r.data, 'base64'));
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
    if (dir) {
      for (let i = 0; i < 3; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; }
        catch { await sleep(300); }
      }
    }
  }
}

// ── 选帖 ─────────────────────────────────────────────────────────────────

/**
 * 等 Reddit 真正就绪:goto 后页面可能还停在 JS challenge(「Please wait for verification」,
 * 自动提交后才跳真页)。轮询到 25s:标题不再是挑战页 + shreddit 应用挂载 = 就绪。
 * 不就绪也不抛(返回 false),让后续抓取带着诊断继续 —— 用户日志能看出卡在哪一环。
 */
export async function waitForRedditReady(session: ThreadSession, onLog?: (m: string) => void): Promise<boolean> {
  const deadline = Date.now() + 25_000;
  let lastTitle = '';
  while (Date.now() < deadline) {
    try {
      const st = await session.evalJson<{ title: string; app: boolean }>(
        `({ title: String(document.title || ''), app: !!document.querySelector('shreddit-app, faceplate-app, [id^="AppRouter"]') })`);
      lastTitle = st?.title || '';
      const challenged = /verification|just a moment|attention required|access denied|blocked/i.test(lastTitle);
      if (!challenged && (st?.app || /reddit/i.test(lastTitle))) {
        onLog?.(`🌐 Reddit 已连上(${lastTitle.slice(0, 40)})`);
        return true;
      }
    } catch { /* 页面导航中 eval 会瞬时失败,继续等 */ }
    await sleep(1000);
  }
  onLog?.(`⚠️ Reddit 页面 25s 未就绪(当前标题:「${lastTitle.slice(0, 60) || '空白'}」)。大概率是 VPN/代理没接管无头浏览器 —— 请确认 VPN 开启且为全局/TUN 或系统代理模式,然后重跑。`);
  return false;
}

/** 页面上下文 fetch 某 subreddit 的 hot.json(须先 goto reddit.com 使 same-origin)。失败带原因返回。 */
async function fetchSubredditHot(session: ThreadSession, subreddit: string): Promise<{ posts: RedditPost[]; err?: string }> {
  const expr = `fetch('https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot.json?limit=25&raw_json=1', {credentials:'omit'})
    .then(r => r.ok ? r.json() : Promise.reject(new Error('http '+r.status)))
    .then(j => (j && j.data && Array.isArray(j.data.children) ? j.data.children : [])
      .filter(c => c && c.kind === 't3' && c.data)
      .map(c => ({
        id: String(c.data.id||''), subreddit: String(c.data.subreddit||''),
        title: String(c.data.title||''), selftext: String(c.data.selftext||'').slice(0, 4000),
        author: String(c.data.author||''), score: Number(c.data.score)||0,
        numComments: Number(c.data.num_comments)||0, permalink: String(c.data.permalink||''),
        over18: !!c.data.over_18,
      })))`;
  try {
    const posts = await session.evalJson<RedditPost[]>(expr);
    return { posts: Array.isArray(posts) ? posts : [] };
  } catch (e) {
    return { posts: [], err: String((e as Error)?.message || e) };
  }
}

/**
 * DOM 兜底:.json 被封/挑战没过时,直接开 r/<sub>/hot/ 页面读 <shreddit-post> 元素属性。
 * 页面能渲染就一定有这些属性(shreddit 列表页每帖一个 custom element,属性含
 * id/post-title/score/comment-count/permalink)。selftext 拿不到(过滤屏蔽词时只看标题)。
 */
async function fetchSubredditHotViaDom(session: ThreadSession, subreddit: string): Promise<{ posts: RedditPost[]; err?: string }> {
  try {
    await session.goto(`https://www.reddit.com/r/${encodeURIComponent(subreddit)}/hot/`, 3000);
    const posts = await session.evalJson<RedditPost[]>(`(function(){
      return Array.from(document.querySelectorAll('shreddit-post')).slice(0, 25).map(function(el){
        return {
          id: String(el.getAttribute('id') || '').replace(/^t3_/, ''),
          subreddit: ${JSON.stringify(subreddit)},
          title: String(el.getAttribute('post-title') || ''),
          selftext: '',
          author: String(el.getAttribute('author') || ''),
          score: Number(el.getAttribute('score')) || 0,
          numComments: Number(el.getAttribute('comment-count')) || 0,
          permalink: String(el.getAttribute('permalink') || ''),
          over18: el.hasAttribute('nsfw'),
        };
      }).filter(function(p){ return p.id && p.title && p.permalink; });
    })()`);
    return { posts: Array.isArray(posts) ? posts : [] };
  } catch (e) {
    return { posts: [], err: String((e as Error)?.message || e) };
  }
}

export interface PickPostOptions {
  subreddits: string[];
  /** 已做过的 post id(按任务持久化),选题排除。 */
  excludeIds?: string[];
  /** 屏蔽词(标题/正文命中即跳过)。 */
  blockedWords?: string[];
  minComments?: number;   // 默认 20,对齐 bot 的 min_comments
  onLog?: (m: string) => void;
}

/**
 * 选帖:各勾选 subreddit 的 hot 前 25 条合池 → 过滤 → 按赞数加权随机 1 条。
 * 返回 null = 所有 subreddit 都取不到可用帖(网络不通/全被过滤)。
 * 调用前 session 必须已 goto('https://www.reddit.com/')(same-origin fetch 前提)。
 */
export async function pickRedditPost(session: ThreadSession, opts: PickPostOptions): Promise<RedditPost | null> {
  const exclude = new Set((opts.excludeIds || []).map(String));
  const blocked = (opts.blockedWords || []).map((w) => w.trim().toLowerCase()).filter(Boolean);
  const minComments = opts.minComments ?? 20;

  const pool: RedditPost[] = [];
  for (const sub of opts.subreddits) {
    // 先 .json(快、字段全);拉不到 → 带原因日志 + DOM 兜底(页面能开就能读)。
    const viaJson = await fetchSubredditHot(session, sub);
    let posts = viaJson.posts;
    if (posts.length === 0) {
      opts.onLog?.(`📥 r/${sub} 接口拉到 0 条${viaJson.err ? `(原因:${viaJson.err.slice(0, 90)})` : ''},改从页面读取…`);
      const viaDom = await fetchSubredditHotViaDom(session, sub);
      posts = viaDom.posts;
      opts.onLog?.(`📥 r/${sub} 页面读取 ${posts.length} 条热帖${viaDom.err ? `(${viaDom.err.slice(0, 70)})` : ''}`);
    } else {
      opts.onLog?.(`📥 r/${sub} 拉到 ${posts.length} 条热帖`);
    }
    pool.push(...posts);
    await sleep(600); // 温和限速,别像爬虫
  }
  // 过滤链对齐 bot:NSFW / 置顶(hot.json 里置顶帖 stickied 不返回,双保险看 distinguished 无需)
  //   / 评论数下限 / 已做 / 屏蔽词 / 标题过短
  const candidates = pool.filter((p) => {
    if (!p.id || !p.title || p.title.length < 8) return false;
    if (p.over18) return false;
    if (p.numComments < minComments) return false;
    if (exclude.has(p.id)) return false;
    const hay = `${p.title} ${p.selftext}`.toLowerCase();
    if (blocked.some((w) => hay.includes(w))) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  // 按赞数加权随机(sqrt 压缩量级差,免得 10 万赞永远霸屏、小热帖没机会)
  const weights = candidates.map((p) => Math.sqrt(Math.max(1, p.score)));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// ── 拉评论 ───────────────────────────────────────────────────────────────

/**
 * 拉帖子的高赞评论(sort=top),过滤后返回前 want 条。
 * 过滤对齐 bot:剔 [removed]/[deleted]/无作者/置顶,正文 10~500 字、剥 URL。
 */
export async function fetchRedditComments(
  session: ThreadSession,
  post: RedditPost,
  want: number,
  onLog?: (m: string) => void,
): Promise<RedditComment[]> {
  const expr = `fetch('https://www.reddit.com${post.permalink.replace(/'/g, '')}.json?sort=top&limit=80&raw_json=1', {credentials:'omit'})
    .then(r => r.ok ? r.json() : Promise.reject(new Error('http '+r.status)))
    .then(j => {
      const listing = Array.isArray(j) && j[1] && j[1].data && Array.isArray(j[1].data.children) ? j[1].data.children : [];
      return listing
        .filter(c => c && c.kind === 't1' && c.data && !c.data.stickied)
        .map(c => ({
          id: String(c.data.id||''), author: String(c.data.author||''),
          body: String(c.data.body||''), score: Number(c.data.score)||0,
        }));
    })`;
  let raw: RedditComment[] = [];
  try {
    raw = await session.evalJson<RedditComment[]>(expr);
  } catch (e) {
    onLog?.(`📥 评论接口失败(${String((e as Error)?.message || e).slice(0, 80)}),改从帖子页读取…`);
    raw = await fetchRedditCommentsViaDom(session, post, onLog);
  }
  if (!Array.isArray(raw)) return [];
  return filterComments(raw, want);
}

/** 评论过滤(json/DOM 两条路共用):剔坏项、剥 URL、长度 10~500。 */
function filterComments(raw: RedditComment[], want: number): RedditComment[] {
  const out: RedditComment[] = [];
  for (const c of raw) {
    if (!c.id || !c.author || c.author === '[deleted]') continue;
    if (!c.body || c.body === '[removed]' || c.body === '[deleted]') continue;
    // 剥 URL(对齐 bot sanitize):链接读不出来,含长链接的评论直接不要
    const noUrl = c.body.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
    if (noUrl.length < 10 || noUrl.length > 500) continue;
    out.push({ ...c, body: noUrl });
    if (out.length >= want) break;
  }
  return out;
}

/** DOM 兜底:开帖子页读顶层 <shreddit-comment depth="0"> 的作者/赞数/正文。 */
async function fetchRedditCommentsViaDom(session: ThreadSession, post: RedditPost, onLog?: (m: string) => void): Promise<RedditComment[]> {
  try {
    await session.goto(`https://www.reddit.com${post.permalink}?sort=top`, 3500);
    const raw = await session.evalJson<RedditComment[]>(`(function(){
      return Array.from(document.querySelectorAll('shreddit-comment[depth="0"]')).slice(0, 40).map(function(el){
        const body = el.querySelector('div[slot="comment"]');
        return {
          id: String(el.getAttribute('thingid') || '').replace(/^t1_/, ''),
          author: String(el.getAttribute('author') || ''),
          body: body ? String(body.textContent || '').trim() : '',
          score: Number(el.getAttribute('score')) || 0,
        };
      }).filter(function(c){ return c.id && c.body; });
    })()`);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    onLog?.(`⚠️ 帖子页评论读取也失败(${String((e as Error)?.message || e).slice(0, 80)})`);
    return [];
  }
}

// ── 真截图 ───────────────────────────────────────────────────────────────

export interface CaptureCardsOptions {
  post: RedditPost;
  /** 要截的评论(顺序即出片顺序)。 */
  comments: RedditComment[];
  /** 翻译文本(创作语言≠en 时):标题 + 按 comment id 对应的正文。缺项 = 保留英文原文。 */
  translatedTitle?: string;
  translatedBodies?: Record<string, string>;
  outDir: string;
  onLog?: (m: string) => void;
  signal?: AbortSignal;
}

export interface CapturedCards {
  /** 标题卡 PNG 路径(截图失败为 null → 调用方决定兜底/报错)。 */
  titlePng: string | null;
  /** comment id → PNG 路径(截不到的评论不在 map 里)。 */
  commentPngs: Map<string, string>;
  /** 结构化诊断(真机联调看这里)。 */
  diag: string[];
}

/**
 * 开帖子页 → 替换文字(翻译)→ 帖子/评论元素逐个截图。
 * Reddit 现行 shreddit UI:帖子 <shreddit-post>,评论 <shreddit-comment thingid="t1_xxx">,
 * 均在 light DOM(正文 p 在 slot 内)。selector 全部多级 fallback,真机按 diag 调。
 */
export async function captureThreadCards(session: ThreadSession, opts: CaptureCardsOptions): Promise<CapturedCards> {
  const diag: string[] = [];
  const { post } = opts;
  fs.mkdirSync(opts.outDir, { recursive: true });

  // sort=top 让页面评论顺序跟我们拉的数据一致,减少懒加载滚动
  await session.goto(`https://www.reddit.com${post.permalink}?sort=top`, 3500);
  if (opts.signal?.aborted) throw new Error('aborted');

  // 关弹窗/横幅(cookie 条、"用 App 打开"、登录提示)。best-effort。
  try {
    await session.evalJson(`(function(){
      const kill = (sel) => document.querySelectorAll(sel).forEach(el => el.remove());
      kill('#credential_picker_container');
      kill('reddit-cookie-banner');
      kill('shreddit-async-loader[bundlename*="cookie"]');
      kill('shreddit-experience-tree');
      kill('[data-testid="bottom-sheet"]');
      // 字号放大 + 清卡片噪音(与内核 driver reddit_search.js 同款,保证两条路径卡片观感一致):
      // 2026-07-20 用户反馈「看不到字」再放大:标题 34px、评论 25px;.nc-tr-* 是翻译附加块
      // (原文保留 + 译文放下面,虚线分隔)。
      const st = document.createElement('style');
      st.textContent = 'shreddit-post-overflow-menu,shreddit-comment-action-row,award-button,'
        + '[data-testid="share-button"],[aria-label*="Share"],button[aria-label*="Join"],'
        + 'shreddit-comment shreddit-comment,shreddit-comment [slot="children"]'
        + '{display:none !important;}'
        + 'h1[slot="title"]{font-size:34px !important;line-height:1.3 !important;font-weight:800 !important;}'
        + 'shreddit-comment div[slot="comment"],shreddit-comment div[slot="comment"] p'
        + '{font-size:25px !important;line-height:1.5 !important;}'
        + '.nc-tr-title{font-size:34px !important;line-height:1.35;font-weight:800;margin:10px 0 4px;}'
        + '.nc-tr-body{font-size:25px !important;line-height:1.5;margin-top:8px;padding-top:8px;'
        + 'border-top:1px dashed rgba(128,128,128,.45);}';
      document.head.appendChild(st);
      return true;
    })()`);
  } catch (e) { diag.push(`关弹窗失败: ${String((e as Error)?.message || e)}`); }

  // 翻译呈现(2026-07-20 用户拍板):不再替换原文 —— 卡片保留 Reddit 英文原貌,
  // 译文作为附加块放在原文【下面】(.nc-tr-* 样式,虚线分隔),观众原文译文都看得到。
  if (opts.translatedTitle) {
    try {
      const ok = await session.evalJson<boolean>(`(function(){
        const t = ${JSON.stringify(opts.translatedTitle)};
        const el = document.querySelector('h1[slot="title"]')
          || document.querySelector('shreddit-post h1')
          || document.querySelector('h1');
        if (!el) return false;
        const d = document.createElement('div');
        d.className = 'nc-tr-title';
        d.textContent = t;
        el.insertAdjacentElement('afterend', d);
        return true;
      })()`);
      if (!ok) diag.push('标题元素没找到(h1[slot="title"] / shreddit-post h1 / h1 都空)');
    } catch (e) { diag.push(`标题译文附加失败: ${String((e as Error)?.message || e)}`); }
  }
  const bodies = opts.translatedBodies || {};
  for (const c of opts.comments) {
    const tl = bodies[c.id];
    if (!tl) continue;
    try {
      const ok = await session.evalJson<boolean>(`(function(){
        const t = ${JSON.stringify(tl)};
        const host = document.querySelector('shreddit-comment[thingid="t1_${c.id}"]');
        if (!host) return false;
        // 评论正文:优先 slot=comment 里的 md 容器,退化到 host 里第一个 p 的父容器
        const md = host.querySelector('div[slot="comment"] .md') || host.querySelector('div[slot="comment"]')
          || host.querySelector('.md') || (host.querySelector('p') ? host.querySelector('p').parentElement : null);
        if (!md) return false;
        const p = document.createElement('p');
        p.className = 'nc-tr-body';
        p.textContent = t;
        md.appendChild(p);
        return true;
      })()`);
      if (!ok) diag.push(`评论 ${c.id} 元素/正文容器没找到,译文未附加`);
    } catch (e) { diag.push(`评论 ${c.id} 译文附加失败: ${String((e as Error)?.message || e)}`); }
    if (opts.signal?.aborted) throw new Error('aborted');
  }
  await sleep(400); // 替换后让布局稳定

  // 元素绝对坐标(文档系):滚到元素 → rect + scrollY。逐个截。
  const rectOf = async (selectorExpr: string): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    try {
      return await session.evalJson(`(async function(){
        const el = ${selectorExpr};
        if (!el) return null;
        el.scrollIntoView({block:'center'});
        await new Promise(r => setTimeout(r, 250));
        const r0 = el.getBoundingClientRect();
        if (!r0 || r0.width < 40 || r0.height < 20) return null;
        return { x: Math.max(0, r0.x + window.scrollX - 8), y: Math.max(0, r0.y + window.scrollY - 2),
                 width: Math.min(r0.width + 16, document.documentElement.clientWidth),
                 height: r0.height + 8 };
      })()`);
    } catch { return null; }
  };

  // 标题卡 = shreddit-post 整体(含标题/作者/赞数,不含评论区)
  let titlePng: string | null = null;
  const titleRect = await rectOf(`document.querySelector('shreddit-post') || document.querySelector('[data-test-id="post-content"]') || document.querySelector('article')`);
  if (titleRect) {
    // 帖子卡可能带超长正文/大图,截高卡在 1400 CSS px 以内(9:16 画面里再高也放不下)
    titleRect.height = Math.min(titleRect.height, 1400);
    const p = path.join(opts.outDir, 'card-title.png');
    try { await session.shotClipToFile(titleRect, p); titlePng = p; }
    catch (e) { diag.push(`标题卡截图失败: ${String((e as Error)?.message || e)}`); }
  } else {
    diag.push('标题卡定位失败(shreddit-post / post-content / article 都没命中)');
  }

  // 评论卡:⚠️ 不能截整个 shreddit-comment —— 它的 bbox 含嵌套回复树,会把后面几条一起
  // 框进来(2026-07-07 真机实测)。裁到【host 顶 → 正文 div[slot=comment] 底 + 操作栏 40px】。
  const commentRectOf = async (id: string): Promise<{ x: number; y: number; width: number; height: number } | null> => {
    try {
      return await session.evalJson(`(async function(){
        const host = document.querySelector('shreddit-comment[thingid="t1_${id}"]');
        if (!host) return null;
        host.scrollIntoView({block:'center'});
        await new Promise(r => setTimeout(r, 250));
        const body = host.querySelector('div[slot="comment"]') || host.querySelector('.md');
        if (!body) return null;
        const hr = host.getBoundingClientRect(), br = body.getBoundingClientRect();
        if (hr.width < 40) return null;
        const top = hr.y + window.scrollY, bottom = br.y + br.height + window.scrollY + 40;
        return { x: Math.max(0, hr.x + window.scrollX - 8), y: Math.max(0, top - 4),
                 width: Math.min(hr.width + 16, document.documentElement.clientWidth),
                 height: Math.max(60, bottom - top) };
      })()`);
    } catch { return null; }
  };
  const commentPngs = new Map<string, string>();
  for (const c of opts.comments) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const rect = await commentRectOf(c.id);
    if (!rect) { diag.push(`评论 ${c.id} 定位失败(可能被折叠/懒加载没到)`); continue; }
    rect.height = Math.min(rect.height, 1200);
    const p = path.join(opts.outDir, `card-${c.id}.png`);
    try {
      await session.shotClipToFile(rect, p);
      commentPngs.set(c.id, p);
    } catch (e) { diag.push(`评论 ${c.id} 截图失败: ${String((e as Error)?.message || e)}`); }
  }

  opts.onLog?.(`📸 截图完成:标题卡 ${titlePng ? '✅' : '❌'} + 评论卡 ${commentPngs.size}/${opts.comments.length}`);
  if (diag.length) opts.onLog?.(`🩺 截图诊断: ${diag.slice(0, 5).join(' | ')}${diag.length > 5 ? ` …共${diag.length}条` : ''}`);
  return { titlePng, commentPngs, diag };
}

// ── 矩阵内核路径(生产主路)───────────────────────────────────────────────
// 选帖/评论/截图逻辑全在服务端下发的 reddit_search driver 里(热更新,Reddit 改版不打包);
// 这里只负责:选一个 Reddit 矩阵账号起指纹内核 → 跑 driver → 把截图 base64 落成 PNG。
// 没有 Reddit 账号 / driver 缺失时,调用方回落上面的无头 Chrome 路径。

/**
 * 起一个可用的 Reddit 矩阵账号内核,返回 accountId(失败返 ''')。
 * 与抖音取材不同:Reddit 公开帖不登录也能看,登录校验失败【不换号不拦截】,只记日志
 * (带 cookie 更抗风控,但没登录态照样能跑)。用完由调用方 closeKernel(force)。
 */
export async function acquireRedditKernel(
  preferredAccountId: string | undefined,
  onLog: (m: string) => void,
): Promise<string> {
  // 懒加载矩阵模块(避免顶层循环依赖;模块缺失时 require 抛错 → 返 '' 走无头路径)。
  let mods: any;
  try {
    mods = {
      ...require('../matrix/accountManager'),
      ...require('../matrix/kernelPool'),
    };
  } catch { return ''; }
  const { accountsByPlatform, accountBadgeLabel, launchKernel, kernelNavigate, checkKernelLogin } = mods;
  const usable = (accountsByPlatform('reddit') as any[]).filter((a) => a.status !== 'banned' && a.status !== 'limited');
  if (usable.length === 0) return '';
  let ordered = usable;
  if (preferredAccountId) {
    const pref = usable.find((a) => a.id === preferredAccountId);
    ordered = pref ? [pref, ...usable.filter((a) => a.id !== preferredAccountId)] : usable;
  }
  for (const cand of ordered) {
    try {
      await launchKernel({ accountId: cand.id, kernelVersion: cand.kernelVersion, userDataDir: cand.userDataDir, fingerprint: cand.fingerprint, proxy: cand.proxy, label: accountBadgeLabel(cand) });
    } catch { onLog(`   「${cand.displayName}」内核启动失败,换下一个…`); continue; }
    try { await kernelNavigate(cand.id, 'https://www.reddit.com/'); await sleep(2500); } catch { /* driver 里还会导航 */ }
    let loggedIn = false;
    try { loggedIn = await checkKernelLogin(cand.id, 'reddit'); } catch { /* 读失败不拦 */ }
    onLog(`🧬 用 Reddit 账号「${cand.displayName}」的指纹浏览器取材${loggedIn ? '' : '(未检出登录态,公开帖仍可抓)'}`);
    return cand.id;
  }
  return '';
}

/** 内核路径选帖+拉评论(driver mode=pick)。失败返回 null 并把 reason 打进日志。 */
export async function pickThreadViaKernel(
  accountId: string,
  opts: PickPostOptions & { wantComments?: number },
): Promise<{ post: RedditPost; comments: RedditComment[] } | null> {
  const { runMatrixRedditThread } = require('../matrix/driverCtx');
  const r = await runMatrixRedditThread(accountId, {
    mode: 'pick',
    subreddits: opts.subreddits,
    excludeIds: opts.excludeIds || [],
    minComments: opts.minComments ?? 20,
    wantComments: opts.wantComments ?? 24,
  }, (m: string) => opts.onLog?.(m));
  if (!r || r.ok !== true || !r.post || !Array.isArray(r.comments)) {
    opts.onLog?.(`⚠️ Reddit 取材脚本未选到帖子${r?.reason ? `(${String(r.reason).slice(0, 100)})` : ''}`);
    if (r?.diag?.errors?.length) opts.onLog?.(`🩺 脚本诊断:${(r.diag.errors as string[]).slice(0, 3).join(' | ')}`);
    return null;
  }
  return { post: r.post as RedditPost, comments: r.comments as RedditComment[] };
}

/** 内核路径截图(driver mode=capture):driver 返回 base64,这里落成 PNG,契约同 captureThreadCards。 */
export async function captureCardsViaKernel(
  accountId: string,
  opts: CaptureCardsOptions,
): Promise<CapturedCards> {
  const { runMatrixRedditThread } = require('../matrix/driverCtx');
  fs.mkdirSync(opts.outDir, { recursive: true });
  const r = await runMatrixRedditThread(accountId, {
    mode: 'capture',
    permalink: opts.post.permalink,
    translatedTitle: opts.translatedTitle,
    commentIds: opts.comments.map((c) => c.id),
    translatedBodies: opts.translatedBodies || {},
  }, (m: string) => opts.onLog?.(m));
  const diag: string[] = Array.isArray(r?.diag?.errors) ? (r.diag.errors as string[]) : [];
  if (r?.reason) diag.unshift(String(r.reason));
  let titlePng: string | null = null;
  if (typeof r?.titleB64 === 'string' && r.titleB64.length > 100) {
    titlePng = path.join(opts.outDir, 'card-title.png');
    fs.writeFileSync(titlePng, Buffer.from(r.titleB64, 'base64'));
  }
  const commentPngs = new Map<string, string>();
  if (r?.cards && typeof r.cards === 'object') {
    for (const [id, b64] of Object.entries(r.cards as Record<string, string>)) {
      if (typeof b64 !== 'string' || b64.length < 100) continue;
      const p = path.join(opts.outDir, `card-${id}.png`);
      fs.writeFileSync(p, Buffer.from(b64, 'base64'));
      commentPngs.set(id, p);
    }
  }
  if (diag.length) opts.onLog?.(`🩺 截图诊断: ${diag.slice(0, 4).join(' | ')}`);
  return { titlePng, commentPngs, diag };
}
