/**
 * freeformWriter — 「AI 自由排版」(ai_freeform)的画面生成层(【薄封装】)。
 *
 * 【设计定案:绝不让 AI 写整页 HTML/CSS 像素坐标】。老路径(AI 直接吐 {css,bodyHtml,setupScript})
 * 让 AI 自己算像素,一算不准就叠字/溢出/塌 —— 是「模板速生老是重叠」的根源,已彻底删除。
 *
 * 现在只有两条确定性路径(见 generateFreeformScene):
 *   ① 主路径 = sceneComposer:AI 只出【场景 JSON】(选 block 类型 + 填内容),版式由我们铺
 *      (互不重叠的纵向带 + data-fit 自适应字号,物理上不可能重叠/溢出)。
 *   ② 兜底 = deterministicFallbackScene:纯代码标题+列表,composer 产不出场景时用,同样不重叠。
 *
 * 配套【确定性体检闭环】(htmlVideoRenderer.auditHtml):渲染 → 无头浏览器自查溢出/裁切/重叠/
 * 动画/内容推进 → 有问题把体检结论喂回 composer 重排更稳的版式(pipeline 的 produceFreeformHtml 驱动)。
 *
 * 产物契约:{ css, bodyHtml }(结构化版全走 data-* 声明式动画,不产 GSAP setupScript)。
 * bodyHtml 注入 <div id="stage">(已是 1080×1920 暗底+网格+辉光)。计费在 sceneComposer 内部走。
 */

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
  /** 用户显式选的生成语言名(如 'Japanese'):画面文字强制该语言(AI 翻译)。undefined = 跟内容语言。 */
  forceLangName?: string;
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
  /**
   * true = 确定性【结构化安全排版】(sceneComposer)或纯代码兜底 —— 版式由我们铺,永不重叠/溢出。
   * false/缺省 = 原始 AI 整页 HTML(AI 自己写像素坐标,可能重叠,是「老是重叠」的元凶)。
   * pipeline 靠这个标记:结构化版可放心采用,原始整页版有严重问题时绝不交付。
   */
  structured?: boolean;
  /** 实际产出用的模型(诊断用):'noobclawai-reasoner'(Pro)/'noobclawai-chat'(flash 降级)。 */
  model?: 'noobclawai-reasoner' | 'noobclawai-chat';
  /** source==='fallback' 时,AI 失败的原因(诊断用,产物里看不到为什么掉兜底就靠它)。 */
  failReason?: string;
  tokens: number;
  costUsd: number;
}

/**
 * 纯代码兜底:AI 全挂时产一个朴素但能看的标题+列表画面(data-* 错峰登场)。
 * 确定性、绝对居中、绝不重叠 —— 也是 pipeline 末端的最后一道安全网(导出给 template-pipeline)。
 */
export function deterministicFallbackScene(input: FreeformInput): FreeformResult {
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
  return { css, bodyHtml, source: 'fallback', structured: true, tokens: 0, costUsd: 0 };
}

/**
 * 自由排版画面生成 —— 【只用确定性排版,绝不让 AI 写整页 HTML/CSS 像素坐标】。
 *   ① 主路径:结构化安全排版(sceneComposer)—— AI 只出【场景 JSON】(选 block 类型 + 填内容),
 *      我们把它铺进不塌的安全版式(每 block 一条互不重叠的纵向带 + data-fit 自适应字号,
 *      物理上不可能重叠/溢出)。每一轮(含修订轮)都走它,带上上一版体检问题让它重排更稳的版式
 *      (精简条目 / 换更合适的原语)。
 *   ② 兜底:composer 连场景 JSON 都产不出(AI 挂 / 解析失败)→ 纯代码确定性排版(标题+列表,同样不重叠)。
 *
 * 【已彻底移除「让 AI 写整页 HTML/CSS(+GSAP)」的老路径】—— 那条路让 AI 自己算像素坐标,一算不准
 *   就叠字/溢出/塌,是「模板速生老是重叠」的根源(sceneComposer 本就是为取代它而生)。宁可版式朴素一点、
 *   也绝不交付重叠废片。鉴权/余额错误由 composeSceneFromAI 内部上抛(让 pipeline 显式失败)。
 */
export async function generateFreeformScene(
  input: FreeformInput,
  onProgress?: (msg: string) => void,
): Promise<FreeformResult> {
  const scene = await composeSceneFromAI({
    dataText: input.dataText, title: input.title, brief: input.brief, lang: input.lang, forceLangName: input.forceLangName, themeId: input.themeId,
    brandColor: input.brandColor, accentColor: input.accentColor || '#0ecb81',
    durationSec: input.durationSec, narrationOn: input.narrationOn, captionsOn: input.captionsOn,
    issues: input.fixHint?.issues,
  }, onProgress);
  if (scene) {
    // 结构化版全走 data-* 声明式动画,不产 GSAP setupScript;structured=true 标记「安全、可放心采用」。
    return { css: scene.css, bodyHtml: scene.bodyHtml, source: 'ai', model: 'noobclawai-chat', structured: true, tokens: scene.tokens, costUsd: scene.costUsd };
  }
  onProgress?.('⚠️ 结构化排版未产出场景,采用确定性兜底排版(标题+列表,不重叠)');
  return { ...deterministicFallbackScene(input), failReason: 'composeSceneFromAI 未产出有效场景' };
}
