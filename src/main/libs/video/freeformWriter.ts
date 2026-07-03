/**
 * freeformWriter — 「AI 自由排版」(ai_freeform)的画面生成层。
 *
 * 跟 5 套固定模板的根本区别:这里【AI 写整个画面的 HTML + CSS(+ 可选 GSAP 时间线)】,
 * 不再只填数据。这是「无限接近 HyperFrames」的核心 —— 表现力不再被锁死在固定版式里。
 *
 * 但 DeepSeek 看不了图,所以配套一个【确定性体检闭环】(htmlVideoRenderer.auditHtml +
 * 本文件的 fix 重写):渲染 → 无头浏览器自查溢出/重叠/空白/动画没接上 → 把问题喂回来
 * 重写,2~3 轮。等于把 HyperFrames「人看预览」换成「机器 linter」。
 *
 * 产物契约(严格 JSON):{ css, bodyHtml, setupScript }
 *   · bodyHtml 注入 <div id="stage">(已是 1080×1920 暗底+网格+辉光)
 *   · 动画两条路:① data-* 声明式(templateAnim 协议,首选,稳)② GSAP paused 时间线
 *     (setupScript 里建,存 window.__timelines,我们逐帧 totalTime(t))
 *   · 全程禁壁钟(Date/Math.random/setInterval/raf/CSS animation/transition)—— 否则
 *     逐帧 seek 渲染会糊
 *
 * 计费:复用 templateHtmlWriter.callNoobclawChat(同 DeepSeek 代理口径)。
 */

import { callNoobclawChat } from './templateHtmlWriter';
import { composeSceneFromAI } from './sceneComposer';
import type { ContentLang } from './scriptWriter';

export interface FreeformFixHint {
  prevCss: string;
  prevBodyHtml: string;
  prevSetupScript?: string;
  issues: string[];
}

export interface FreeformInput {
  dataText: string;
  title?: string;
  lang: ContentLang;
  brandColor: string;
  accentColor?: string;
  durationSec: number;
  /**
   * 是否开了配音。开了 = 整段时长都在朗读内容 → 画面必须跟着口播逐步推进(顺序条目沿
   * 整段时长铺开揭示/高亮),不能前几秒一次铺完后段空转。关了 = 纯视觉短片,错峰登场到位即可。
   */
  narrationOn: boolean;
  /** 字幕是否开(开了要给底部留安全区,别让画面元素压到字幕)。 */
  captionsOn: boolean;
  /** GSAP 是否可用(随包文件存在)。false 时禁止 AI 用 gsap,只能 data-*。 */
  gsapAvailable: boolean;
  /** 用户对风格/重点的自由描述(如「赛博朋克风、突出第一名、多用大数字」)。空 = AI 自行决定。 */
  brief?: string;
  /** 用户显式选的设计主题 id(themes.ts);'auto'/空 = 自动挑。 */
  themeId?: string;
  /** 体检不通过时的修复上下文:带上一版 + 问题清单,让 AI 改而不是重起炉灶。 */
  fixHint?: FreeformFixHint;
}

export interface FreeformResult {
  css: string;
  bodyHtml: string;
  setupScript?: string;
  source: 'ai' | 'fallback';
  /** 实际产出用的模型(诊断用):'noobclawai-reasoner'(Pro)/'noobclawai-chat'(flash 降级)。 */
  model?: 'noobclawai-reasoner' | 'noobclawai-chat';
  /** source==='fallback' 时,AI 失败的原因(诊断用,产物里看不到为什么掉兜底就靠它)。 */
  failReason?: string;
  tokens: number;
  costUsd: number;
}

const SYSTEM_PROMPT = [
  '你是资深动态图形(motion graphics)工程师。把用户内容做成【一条 1080×1920 竖屏短视频画面】,用 HTML+CSS(+可选 GSAP)实现,动画必须【确定性、可逐帧 seek】。',
  '只输出严格 JSON(json),不要任何解释、不要 markdown 围栏:',
  '{"css":"<style 内的纯 CSS>","bodyHtml":"<注入 #stage 的 HTML>","setupScript":"<可选:建 GSAP 时间线的 JS,没有就给空串>"}',
  '',
  '【画布】',
  '- #stage 已是 1080(宽)×1920(高),已有暗色渐变底 + 网格 + 辉光,你可叠自己的背景层。',
  '- 四周留 ≥60px 安全边。所有可见元素的【底边不得超过 {{CONTENT_BOTTOM}}px】(下方留给字幕/安全区),不许溢出 1080×1920;文字给足行高/换行,别被容器裁掉。',
  '- 内容多到一屏放不下时【绝不往下堆到屏外、也绝不压到 {{CONTENT_BOTTOM}}px 以下】:要么减量精炼到一屏,要么用时间轴分段轮播(见下方编排)。',
  '- 【禁止空占位】没有图片源(离线、禁外链),不要画空图片框 / 空圆 / 灰色占位块 / 头像位 —— 一律用文字、图形、渐变、emoji 图标填,别留空洞。',
  '',
  '【时长 & 编排(关键:别让画面僵住、也别让画面跑在口播前面!)】',
  '- 整片精确 {{DURATION}} 秒。进场动画 data-start ≥0 且 data-start+data-duration ≤ {{DURATION}}。',
  '- 【全程必须有变化】,严禁「开头 1 秒动一下、之后一直定格不动」。',
  '{{NARRATION}}',
  '- 一屏放不下时 → 【分段轮播】:第 1 段进场→停留→退场(用 data-exit-start/data-exit-duration),第 2 段在它退场后再进场……每段占一段时间、平分 {{DURATION}};保证【任意时刻屏上只有放得下的那一段】,且画面随时间推进不断切换。',
  '- 不论哪种,都叠【持续环境动效】让画面一直在呼吸:背景 .fx-blob 配 data-loop=float 漂浮、标题 .fx-sheen 配 data-loop=sweep 扫光、关键数字 count-up 滚动(这些 loop 全程循环);但环境动效【只是点缀,不能替代「内容随时间推进」】。',
  '- 结尾最后 0.5s 可收稳,但不要整个后半段都静止不动。',
  '',
  '【动画 —— 只能用这两套机制,二选一或混用;严禁 CSS @keyframes / animation / transition / setInterval / setTimeout / requestAnimationFrame / Date / Math.random(全是壁钟,会让逐帧渲染糊)】',
  '① 首选 data-* 声明式(写在任意元素上,稳、好懂):',
  '   data-start(秒) data-duration(秒,默认0.6) data-anim(取值:fade/fade-up/fade-down/fade-left/fade-right/slide-in-left/slide-in-right/scale-in/pop/rise/wipe-right/wipe-left)',
  '   data-ease(可选:cubic/expo/back/elastic/bounce/quad/linear) 退场(可选:data-exit-start data-exit-duration)',
  '   循环环境动画:data-loop(float/pulse/sweep/spin/glitch)+ data-loop-period data-loop-amp data-loop-phase',
  '   数字滚动:data-anim 任意 + data-count-from data-count-to data-count-decimals data-count-prefix data-count-suffix(元素文本会被滚动数值覆盖)',
  '② 进阶 GSAP 时间线(做形变/路径/复杂 stagger 等 data-* 做不到的英雄动效),写在 setupScript:',
  '   window.__timelines = window.__timelines || {};',
  "   var tl = gsap.timeline({paused:true}); tl.from('.hero',{opacity:0,y:60,duration:0.8,ease:'power3.out'},0);",
  '   window.__timelines.main = tl;',
  '   规则:时间线【必须 paused:true】(我们靠 totalTime(t) 逐帧驱动,你绝不能 .play());时间线总时长 ≤ {{DURATION}};',
  '   被 GSAP 控制的元素【不要】再带 data-anim(避免两套机制打架);只能引用你在 bodyHtml 里写的 class/id。',
  '{{GSAP_AVAIL}}',
  '',
  '【视觉质量】要专业、广播级、高对比。主色 {{BRAND}}、强调色 {{ACCENT}}。大号粗体标题、清晰信息层级。',
  '可用渐变/阴影/模糊,以及已注入的 fx 工具类:.fx-grain(颗粒) .fx-vignette(暗角) .fx-scanlines(扫描线) .fx-blob(极光球,配 data-loop=float) .fx-sheen(光泽扫过,配 data-loop=sweep)。',
  '只用系统字体(已全局设好,中日韩+Latin 都覆盖)—— 严禁 @font-face / web font / @import / 任何外链(http/https 图片、CDN 一律禁止,离线渲染会失败)。',
  '',
  '【酷炫视觉手法(抄 HyperFrames 做法,认真用 —— 这是「好看」与「平庸」的分水岭)】',
  '- 英雄动效优先 GSAP 时间线:形变/位移/路径 + 错峰 stagger;缓动用 power3.out / back.out(回弹) / expo,绝不用线性。',
  '- 景深视差:分背景层(大 .fx-blob 配 data-loop=float、振幅大、慢漂)/ 中景 / 前景(小元素、快入场),不同速度造空间感,别全平铺贴一层。',
  '- 动力学排版(kinetic typography):大标题逐字/逐词错峰入场(每字 +0.03~0.05s,配 fade-up 或 pop),像被「打」出来。',
  '- 段间转场:换段/换页用 .fx-flash + data-anim=flash 白闪,或 wipe-left/right 擦除,别硬切。',
  '- 数据感:关键数字用 count-up 从 0 滚到目标(data-count-from/to/...),比静态数字抓眼。',
  '- 氛围层(克制别糊):.fx-grain 颗粒 + .fx-vignette 暗角 + 标题 .fx-sheen 扫光,薄薄叠一层提质感。',
  '',
  '【设计系统纪律(别瞎排,排版决定档次)】',
  '- 字号阶梯拉开层级:主标题 84~110px/900 粗;副标题 40~52px;正文 34~44px;说明/出处 26~30px。',
  '- 配色克制:只用 主色 {{BRAND}} + 强调色 {{ACCENT}} + 黑白灰三档,别五颜六色;重点用强调色点睛。',
  '- 留白与对齐:模块间距 ≥40px;统一左对齐或居中(别混);卡片圆角 ≥20px + 柔和阴影 + 半透明描边,别挤成一团。',
  '',
  '【硬布局纪律(抄 html-video / HyperFrames 的固定模板做法 —— 这是「不塌」的关键,必须逐条照做)】',
  '- 每个文字/内容元素必须 position:absolute + 明确的 top/left(或 bottom/left)+ max-width(≤920px);绝不用 flex 自由流、绝不用百分比宽度、绝不用 vw/vh 做字号(字号一律 px)。这样元素位置锁死,永不漂移。',
  '- 标题区与副标题区是【上下两个互不重叠的固定纵向带】,之间硬留 ≥40px 间距;副标题【绝不】叠在标题背后、也绝不跟标题同一 top 做「虚影/水印字」——任意两个文字元素的盒子严禁重叠(重叠=叠字废片)。',
  '- 每个文字盒子按其字号预留足够高度:标题 84~110px 时,给它的带 ≥ 行高×行数 的高度;内容太长【缩字号】(如标题超一行就降到 72px)而不是换行溢出、更不许压到下一个元素。',
  '- 【必用 data-fit 自适应兜底】:每个承载文字的盒子都加属性 data-fit,并给它 data-fit-maxh="<该盒子最大高度px>"(=你为它预留的带高)、可选 data-fit-min="<最小字号px>"。渲染引擎会在出片前测量,内容一旦超出这个高度就【自动逐档降字号】直到落进盒子 —— 这是你算错高度时的最后一道防线,保证【永不溢出、永不叠到下一个元素】。例:标题 <div ... data-fit data-fit-maxh="200" data-fit-min="48">。注意 maxh 要设成「到下一个元素之间的净空高度」,别设太大否则等于没兜底。',
  '- 画面里【只呈现用户给的内容本身】。任何口播句 / slogan / CTA / 引导语 / 过渡句(如「别等有空了先…」「快来关注」)都是配音,【绝不烧进可见文字】。列表每行 = 一条用户数据项,严禁把口播/过渡句当成列表项。',
  '- 一屏放不下就减量或分段轮播(见上),绝不靠缩到重叠来硬塞。',
  '',
  '【内容】忠实呈现下方用户内容,按内容类型自选最合适的版式(榜单/卡片/金句/数据看板/头条快讯…);绝不编造用户没给的数据。保持用户内容语言。',
  '【字幕】{{CAPTIONS}}',
  '',
  '再次强调:输出纯 JSON,bodyHtml 里【不许有 <script>】(JS 只能放 setupScript),不许 on 事件属性,不许外链。',
].join('\n');

// 有配音 vs 无配音的编排指令(含 {{DURATION}} token,故必须在 DURATION 全局替换【之前】先注入)。
const NARRATION_RULE_ON = '- ⚠️【本片有配音,画面必须跟着口播逐步推进 —— 这是本次最重要的要求】:配音会从头到尾把内容念完(约 {{DURATION}} 秒)。内容若是顺序多条目(榜单/盘点/多条列表),把每条的【入场或高亮】沿整段时长均匀铺开:第 k 条约在 (k-1)/N×{{DURATION}} 秒出现或点亮(N=条目数),最后一条要到接近结尾(≥{{DURATION}}×0.8)才登场。绝不允许把所有条目挤在前几秒一次性铺完、后半段只剩环境动效空转(那样口播念到后面、画面早没东西可变了 = 废片)。一屏放得下:让已出现的条目留在屏上、当前被念到的那条高亮(放大/变色/左侧高亮条变亮);一屏放不下:逐条进场+整列上滚,或用下面的分段轮播。';
const NARRATION_RULE_OFF = '- 本片无配音 → 元素错峰登场到位即可(不必把入场拖满全程),靠下面的环境动效持续呼吸防止僵住。';

function buildSystem(input: FreeformInput): string {
  return SYSTEM_PROMPT
    .replace('{{NARRATION}}', input.narrationOn ? NARRATION_RULE_ON : NARRATION_RULE_OFF)
    .replace(/\{\{DURATION\}\}/g, input.durationSec.toFixed(1))
    .replace(/\{\{BRAND\}\}/g, input.brandColor)
    .replace(/\{\{ACCENT\}\}/g, input.accentColor || '#0ecb81')
    .replace('{{GSAP_AVAIL}}', input.gsapAvailable
      ? '   GSAP 3 已就绪 = window.gsap,可直接用。'
      : '   ⚠️ 本次 GSAP 不可用 —— 只能用 ① data-* 机制,setupScript 给空串,绝不能引用 gsap。')
    .replace(/\{\{CONTENT_BOTTOM\}\}/g, input.captionsOn ? '1680' : '1860')
    .replace('{{CAPTIONS}}', input.captionsOn
      ? '本片底部会烧字幕。屏幕底部 1680–1920px 是【字幕专属区】,任何内容元素都不许进入(否则被字幕盖住);所有内容控制在 y≤1680。'
      : '本片无字幕,内容可用到 y≤1860(仍留 60px 安全边)。');
}

function buildUser(input: FreeformInput): string {
  const parts: string[] = [];
  if (input.title) parts.push(`标题倾向:${input.title}`);
  parts.push(`主色 ${input.brandColor} / 强调色 ${input.accentColor || '#0ecb81'} / 时长 ${input.durationSec.toFixed(1)}s`);
  // 用户的风格/重点描述 —— 这是「像 HyperFrames 那样用自然语言表达意图」的核心,优先级高,认真照做。
  if (input.brief && input.brief.trim()) {
    parts.push(`【用户的风格/重点要求(请认真照做)】${input.brief.trim().slice(0, 400)}`);
  }
  if (input.fixHint) {
    parts.push('');
    parts.push('【上一版有以下问题,请修复后重新输出完整 JSON(在上一版基础上改,别推倒重来)】');
    input.fixHint.issues.slice(0, 12).forEach((p, i) => parts.push(`${i + 1}. ${p}`));
    parts.push('');
    parts.push('上一版 css:');
    parts.push(input.fixHint.prevCss.slice(0, 6000));
    parts.push('上一版 bodyHtml:');
    parts.push(input.fixHint.prevBodyHtml.slice(0, 8000));
    if (input.fixHint.prevSetupScript) {
      parts.push('上一版 setupScript:');
      parts.push(input.fixHint.prevSetupScript.slice(0, 3000));
    }
  }
  parts.push('');
  parts.push('用户内容(json):');
  parts.push(input.dataText.slice(0, 2200));
  return parts.join('\n');
}

/** 从夹带文字/围栏的输出里抠出第一个 JSON 对象。 */
function extractJsonObject(raw: string): string {
  let t = (raw || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
      }
    }
  }
  return t;
}

const BANNED_JS = /\b(setInterval|setTimeout|requestAnimationFrame|XMLHttpRequest|fetch|WebSocket|eval|Function|Date|Math\.random|while\s*\(|location|document\.cookie|localStorage)\b|import\s*\(/;

/** 体检前的纯代码消毒:剥掉外链 / <script> / on事件 / 非确定性 JS。绝不抛。 */
function sanitizeBody(html: string): string {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')        // body 里禁脚本(JS 只走 setupScript)
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')            // 行内事件
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/(src|href)\s*=\s*("|')\s*https?:\/\/[^"']*\2/gi, '$1=$2#$2') // 外链置空
    .replace(/url\(\s*https?:\/\/[^)]*\)/gi, 'none');   // CSS 内联外链背景
}
function sanitizeCss(css: string): string {
  return (css || '')
    .replace(/@import[^;]+;/gi, '')
    .replace(/url\(\s*['"]?https?:\/\/[^)]*\)/gi, 'none')
    .replace(/@font-face[\s\S]*?\}/gi, '');
}
/** setupScript 含任何壁钟/外链/危险调用 → 整段丢弃(降级为只用 data-*)。 */
function sanitizeSetup(js: string | undefined): string | undefined {
  const s = (js || '').trim();
  if (!s) return undefined;
  if (BANNED_JS.test(s)) return undefined;
  return s.slice(0, 8000);
}

/** 纯代码兜底:AI 全挂时产一个朴素但能看的标题+列表画面(data-* 错峰登场)。 */
function fallbackScene(input: FreeformInput): FreeformResult {
  const lines = (input.dataText || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const title = esc(input.title || (lines[0] || '热点速览').slice(0, 18));
  // 有配音:把各行入场沿整段时长均匀铺开(跟口播逐条推进,避免前几秒铺完后段静止);
  // 无配音:错峰登场(0.25s 间隔)即可。
  const n = lines.length || 1;
  const step = input.narrationOn && n > 1
    ? Math.max(0.25, (input.durationSec - 1.6) / n)
    : 0.25;
  const rows = lines.map((l, i) =>
    `<div class="ff-row" data-anim="fade-up" data-start="${(0.8 + i * step).toFixed(2)}" data-duration="0.5" data-ease="expo">${esc(l.slice(0, 50))}</div>`,
  ).join('');
  const css = `
#ff-title{position:absolute;top:220px;left:80px;right:80px;text-align:center;font-size:84px;font-weight:900;color:${input.brandColor};line-height:1.15}
#ff-list{position:absolute;top:480px;left:80px;right:80px;bottom:${input.captionsOn ? 280 : 120}px}
.ff-row{font-size:50px;font-weight:700;line-height:1.3;margin-bottom:34px;padding-left:28px;border-left:8px solid ${input.accentColor || '#0ecb81'}}`;
  const bodyHtml = `<div id="ff-title" data-anim="fade-up" data-start="0.1" data-duration="0.6" data-ease="expo">${title}</div><div id="ff-list">${rows}</div>`;
  return { css, bodyHtml, source: 'fallback', tokens: 0, costUsd: 0 };
}

/**
 * 让 AI 写一版自由排版画面。temperature 0.9 提升排版多样性(数据准确性由「忠实呈现/不编造」硬约束兜)。
 *
 * 模型策略(关键!之前「自由排版每次都掉同一个丑兜底」就栽在这):
 *   先试 Pro(reasoner,质量优先、对齐用户「视频都走 Pro」要求),但整页 HTML+CSS+GSAP 体量大,
 *   reasoner 偶发把 JSON 输出截断/带思考链 → JSON.parse 失败 → 以前直接掉纯代码兜底(永远同一个
 *   绿条列表)。现在:Pro 产物为空/解析失败 → 自动降级 flash(chat,支持 response_format=json_object、
 *   不吐思考链,产结构化 JSON 最稳)重试一次;两个模型都失败才用纯代码兜底。maxTokens 4096→8000 防截断。
 *   鉴权/余额错误立即上抛(不浪费第二次调用)。
 */
export async function generateFreeformScene(
  input: FreeformInput,
  onProgress?: (msg: string) => void,
): Promise<FreeformResult> {
  // ── P2 主路径:【结构化安全排版】(sceneComposer)——AI 只出场景 JSON,我们铺进不塌的
  //   安全版式(每 block 一条纵向带 + data-fit 自适应)。只在【首次尝试】走(有 fixHint =
  //   上一版体检没过,交给下面的整页 HTML 修复路径按具体问题改;结构化版没有「按问题改」的
  //   概念,重出一版意义不大)。任何失败(鉴权/余额除外,那个上抛)→ 落到老整页 HTML 路径。
  if (!input.fixHint) {
    const scene = await composeSceneFromAI({
      dataText: input.dataText, title: input.title, brief: input.brief, lang: input.lang, themeId: input.themeId,
      brandColor: input.brandColor, accentColor: input.accentColor || '#0ecb81',
      durationSec: input.durationSec, narrationOn: input.narrationOn, captionsOn: input.captionsOn,
    }, onProgress);
    if (scene) {
      // 结构化版全走 data-* 声明式动画,不产 GSAP setupScript。
      return { css: scene.css, bodyHtml: scene.bodyHtml, source: 'ai', model: 'noobclawai-chat', tokens: scene.tokens, costUsd: scene.costUsd };
    }
  }
  const models: Array<'noobclawai-reasoner' | 'noobclawai-chat'> = ['noobclawai-reasoner', 'noobclawai-chat'];
  const label: Record<string, string> = { 'noobclawai-reasoner': 'Pro 模型', 'noobclawai-chat': 'flash 模型' };
  let lastReason = 'AI 未产出可用 HTML';
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      onProgress?.(i === 0
        ? `🎨 ${label[model]}正在写整页 HTML(产物较大,通常 30–90s,请稍候)…`
        : `🔁 改用 ${label[model]}重试(产结构化 JSON 更稳,通常 10–30s)…`);
      const { content, tokens, costUsd } = await callNoobclawChat(
        buildSystem(input), buildUser(input), { temperature: 0.9, maxTokens: 8000, model, timeoutMs: 120_000 },
      );
      onProgress?.(`📝 ${label[model]}已返回 ${content.length} 字,正在解析…`);
      const parsed = JSON.parse(extractJsonObject(content));
      const bodyHtml = sanitizeBody(typeof parsed?.bodyHtml === 'string' ? parsed.bodyHtml : '');
      const css = sanitizeCss(typeof parsed?.css === 'string' ? parsed.css : '');
      if (bodyHtml.trim().length > 20) {
        const setupScript = input.gsapAvailable ? sanitizeSetup(parsed?.setupScript) : undefined;
        return { css, bodyHtml, setupScript, source: 'ai', model, tokens, costUsd };
      }
      lastReason = `${model} 产出的 bodyHtml 为空/过短(${bodyHtml.trim().length} 字)`;
      onProgress?.(`⚠️ ${label[model]}产物不可用(${lastReason})`);
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      // 鉴权/余额类错误向上抛(跟 templateHtmlWriter 同口径,让 pipeline 显式失败)
      if (/AI_AUTH_FAILED|CREDITS_INSUFFICIENT|AI_NOT_CONFIGURED/.test(msg)) throw e;
      const isTimeout = /abort/i.test(msg);
      lastReason = `${model} ${isTimeout ? '超时(>120s)' : '失败'}:${msg.slice(0, 120)}`;
      onProgress?.(`⚠️ ${label[model]}${isTimeout ? '超时' : '失败'},${i < models.length - 1 ? '准备降级重试' : '将用兜底排版'}…`);
      // 其它错误(截断/解析失败/超时)→ 继续换下一个模型重试
    }
  }
  return { ...fallbackScene(input), failReason: lastReason };
}
