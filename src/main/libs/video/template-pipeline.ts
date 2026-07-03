/**
 * template-pipeline — 「模板速生」HF 派出片流水线(engine==='template')。
 *
 * v3 改动(抄 HyperFrames 核心 insight):
 *   1. **TTS 先出,HTML 跟着音频时长走**(不做 ffmpeg 拉伸对齐)
 *   2. **渲染+编码合一**(htmlVideoRenderer.renderHtmlToVideo 一步出 mp4,不落盘 PNG)
 *   3. **字幕走 HTML 内渲染**(声明式 data-caption-start/end,跟动画同引擎无对齐误差)
 *
 * 步骤:
 *   ① AI 解析 dataText → {title,subtitle,items[,voiceScript]}(narration 时同时产口播稿)
 *   ② [narration 时] edge-tts 出 wav,拿真实 durationSec + 词级 cues(短语)
 *   ③ 用真实时长 + cues 构造 TemplateSpec,渲染 HTML(含字幕轨)
 *   ④ renderHtmlToVideo:逐帧 seek + 截图 → ffmpeg stdin → 同时混 narration + BGM → 出 mp4
 *
 * 全程不落盘中间 PNG,音画对齐误差 = 0(字幕跟动画同 seek 协议)。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isFfmpegAvailable } from './ffmpegRuntime';
import { resolveBgmPath } from './bgm';
import {
  ProgressTracker, resolveOutputDirs, outputFileName, throwIfAborted,
  type VideoCreationInput, type VideoCreationResult, type ProgressEmitter,
} from './pipeline';
import { generateTemplateData, detectTemplateLang, type ContentLang } from './templateHtmlWriter';
import { getVideoConfig } from './videoConfig';
import { renderTemplate, pageSizeFor, calcPageCount, calcPageRanges, type TemplateSpec } from './templateLibrary';
import { renderHtmlToVideo, resolveHeadlessBrowser, auditHtml } from './htmlVideoRenderer';
import { generateFreeformScene, type FreeformResult } from './freeformWriter';
import { wrapTemplateHtml } from './templateAnim';
import { loadGsapSource } from './gsapAsset';
import { synthesize, getLastTtsError, getVoiceFallbacks } from './tts';
import { getTtsVoice } from './config';
import { chargeMode1Video, refundMode1Video } from './billing';
import type { CaptionCue } from './templateAnim';

const TEMPLATE_STEPS = [
  { key: 'data', label: '生成动效数据' },
  { key: 'voice', label: '生成 AI 配音' },     // narration off 时仍存在,但秒过
  { key: 'render', label: '渲染 + 编码合成' },
  // 跟 stock/ai pipeline 对齐:publish 步骤 —— 出片完成后发到用户勾选的平台。
  //   publishPlatforms 为空时秒过,日志推「📂 未选发布平台 · 仅存本地」。
  { key: 'publish', label: '发布到各大平台' },
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** 没给时长时按数据行数估个合理时长(标题 2s + 每行约 0.9s),clamp[4,14]。 */
function autoDuration(dataText: string): number {
  const rows = (dataText || '').split(/\r?\n/).filter((s) => s.trim()).length;
  return clamp(Math.round(2 + rows * 0.9), 4, 14);
}

/** edge-tts 的 cue(相对本句起点) → templateAnim 的 CaptionCue(秒,相对成片起点)。 */
function ttsCuesToCaption(cues: { text: string; start: number; end: number }[] | undefined): CaptionCue[] | undefined {
  if (!cues || cues.length === 0) return undefined;
  return cues.map((c) => ({
    text: c.text,
    startSec: Math.max(0, c.start),
    endSec: Math.max(c.start + 0.05, c.end),
  }));
}

/** 抠净文案给 TTS:去 emoji + 多余空白(不动中文标点;edge-tts 自己处理停顿)。 */
function cleanForTts(s: string): string {
  return (s || '')
    .replace(/[☀-➿\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 跑一次 TTS(带 voice fallback 链),返回 audio + 时长 + cues 或 null。 */
async function ttsWithFallback(
  text: string, primary: string, outPath: string, rate?: number,
): Promise<{ audioPath: string; durationSec: number; cues?: CaptionCue[]; voice: string } | null> {
  const chain = getVoiceFallbacks(primary);
  for (const v of chain) {
    const r = await synthesize(text, outPath, v, rate);
    if (r.ok && r.synthesized) {
      return {
        audioPath: r.audioPath,
        durationSec: r.durationSec,
        cues: ttsCuesToCaption(r.cues),
        voice: v,
      };
    }
  }
  return null;
}

/** 热榜数据源:出片时实时抓的条数(跟向导 TEMPLATE_HOTLIST_TOPN 对齐)。 */
const HOTLIST_TOPN = 12;

/**
 * 实时抓某个热榜前 N 条标题,拼成逐行文本当 dataText。走公开接口 /api/web3/hot-search
 * (无需鉴权,同 GlobalHotSearchPage)。失败/空 → null,调用方退回快照。绝不抛。
 */
async function fetchHotlistText(source: string): Promise<string | null> {
  try {
    const base = process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const resp = await fetch(`${base}/api/web3/hot-search?sources=${encodeURIComponent(source)}`, { signal: ctrl.signal });
      if (!resp.ok) return null;
      const json: any = await resp.json();
      const src = Array.isArray(json?.sources)
        ? (json.sources.find((s: any) => s?.source === source) || json.sources[0]) : null;
      const items: string[] = Array.isArray(src?.items)
        ? src.items.map((it: any) => String(it?.title || '').trim()).filter(Boolean).slice(0, HOTLIST_TOPN) : [];
      return items.length ? items.join('\n') : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

/** 自由排版「写 → 体检 → 修」迭代上限。每轮 = 1 次 AI 调用 + 1 次无头体检(~1-2s)。 */
const MAX_FREEFORM_ATTEMPTS = 3;

interface FreeformHtmlArgs {
  dataText: string;
  title?: string;
  lang: ContentLang;
  brandColor: string;
  accentColor?: string;
  durationSec: number;
  fps: number;
  /** 是否开了配音(决定 freeform 是否要把内容揭示沿整段时长铺开、跟口播逐条推进)。 */
  narrationOn: boolean;
  captionCues?: CaptionCue[];
  watermark?: string;
  brief?: string;
  themeId?: string;
}

/**
 * 「AI 自由排版」产 HTML 的迭代闭环:AI 写整页 → 无头浏览器体检(溢出/裁切/重叠/动画/确定性)
 * → 把问题喂回 AI 重写,最多 MAX_FREEFORM_ATTEMPTS 轮。体检通过即返回;轮次耗尽用最后一版。
 * AI 整个挂了(走纯代码兜底)就不再循环。永远返回可渲染 HTML。
 */
async function produceFreeformHtml(
  args: FreeformHtmlArgs,
  tracker: ProgressTracker,
  onCost: (tokens: number, usd: number) => void,
): Promise<string> {
  const gsapSource = loadGsapSource();
  const gsapAvailable = !!gsapSource;
  const captionsOn = !!(args.captionCues && args.captionCues.length);
  let prev: FreeformResult | null = null;
  let lastIssues: string[] = [];
  let lastHtml = '';
  for (let attempt = 1; attempt <= MAX_FREEFORM_ATTEMPTS; attempt++) {
    tracker.progress(attempt === 1
      ? `🎨 AI 自由排版生成中${gsapAvailable ? '(GSAP 可用)' : ''}…`
      : `🎨 自由排版修订第 ${attempt} 轮(修上轮 ${lastIssues.length} 个问题)…`);
    const scene = await generateFreeformScene({
      dataText: args.dataText,
      title: args.title,
      lang: args.lang,
      brandColor: args.brandColor,
      accentColor: args.accentColor,
      durationSec: args.durationSec,
      narrationOn: args.narrationOn,
      captionsOn,
      gsapAvailable,
      brief: args.brief,
      themeId: args.themeId,
      fixHint: prev
        ? { prevCss: prev.css, prevBodyHtml: prev.bodyHtml, prevSetupScript: prev.setupScript, issues: lastIssues }
        : undefined,
    }, (m) => tracker.progress(m)); // 把模型尝试/超时/降级的细分进度透出来,别让用户对着一句话干等
    onCost(scene.tokens, scene.costUsd);
    const useGsap = !!scene.setupScript && gsapAvailable;
    const html = wrapTemplateHtml({
      bodyHtml: scene.bodyHtml,
      css: scene.css,
      brandColor: args.brandColor,
      durationSec: args.durationSec,
      fps: args.fps,
      captionCues: args.captionCues,
      watermark: args.watermark,
      gsapSource: useGsap ? gsapSource! : undefined,
      setupScript: useGsap ? scene.setupScript : undefined,
    });
    lastHtml = html;
    tracker.progress('🔎 正在无头浏览器体检排版(抽帧检查溢出/重叠/动画/内容推进)…');
    const audit = await auditHtml(html, { narrationOn: args.narrationOn });
    const modelTag = scene.source === 'fallback' ? '兜底版' : (scene.model === 'noobclawai-chat' ? 'flash 降级' : 'Pro');
    if (audit.ok) {
      tracker.progress(`✅ 自由排版体检通过(第 ${attempt} 轮 · ${modelTag})${useGsap ? ' · GSAP' : ''}`);
      return html;
    }
    tracker.progress(`🔎 体检发现 ${audit.issues.length} 个问题:${audit.issues.slice(0, 3).join(' / ')}${audit.issues.length > 3 ? ' …' : ''}`);
    // AI 整个挂了(两个模型都失败 → 走了纯代码兜底)→ 再循环也没意义,直接用兜底版出片。
    // 把失败原因 log 出来(产物只看得到「又是绿条兜底」,看不到为什么 —— 靠这行定位是截断/解析/超时)。
    if (scene.source === 'fallback') {
      tracker.progress(`⚠️ AI 自由排版失败,采用纯代码兜底排版${scene.failReason ? ` · 原因:${scene.failReason}` : ''}`);
      return html;
    }
    prev = scene;
    lastIssues = audit.issues;
  }
  tracker.progress(`⚠️ 自由排版体检 ${MAX_FREEFORM_ATTEMPTS} 轮仍有小瑕疵,采用最后一版出片`);
  return lastHtml;
}

export async function runTemplatePipeline(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  const jobId = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracker = new ProgressTracker(jobId, emit, TEMPLATE_STEPS);

  if (!isFfmpegAvailable()) {
    const err = 'ffmpeg 不可用(开发机请确保 PATH 上有 ffmpeg;打包版需内置 ffmpeg 资源)';
    tracker.fail('data', err);
    return { ok: false, error: err };
  }
  if (!resolveHeadlessBrowser()) {
    const err = '未检测到 Chrome / Edge。模板速生需要其一来渲染画面(Windows 自带 Edge 即可,请确认未被卸载)。';
    tracker.fail('data', err);
    return { ok: false, error: err };
  }
  const tpl = input.template;
  // 有 hotlistSource(热榜数据源)时,内容出片时实时抓,这里允许 dataText 快照为空。
  if (!tpl || (!(tpl.dataText || '').trim() && !tpl.hotlistSource)) {
    const err = '请先填写榜单/要点内容(模板速生靠这些内容生成画面)。';
    tracker.fail('data', err);
    return { ok: false, error: err };
  }

  const { taskDir, runDir: destDir } = resolveOutputDirs(input);
  tracker.setOutputDir(taskDir);
  const tmpAudioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-tpl-audio-'));
  const narrationPath = path.join(tmpAudioDir, 'narration.mp3');

  // 平台基础费(预扣);失败时 refund。对齐 stock 模式定价口径,口径在 billing.chargeMode1Video。
  let chargeId: string | undefined;
  let refundOnExit = false;

  try {
    // ── STEP 1:AI 产数据 + 可选口播稿(分段以便音画同步)──────────────
    throwIfAborted(signal);
    tracker.start('data', `输出目录:${taskDir}`);
    // 热榜数据源:出片时实时抓该榜前 N 条标题当内容(定时任务每次跑都是最新榜单);
    // 抓失败 → 退回 tpl.dataText(向导选榜时存的快照)。粘贴模式 hotlistSource 为空,直接用 dataText。
    let dataText = tpl.dataText || '';
    if (tpl.hotlistSource) {
      const fresh = await fetchHotlistText(tpl.hotlistSource);
      if (fresh) {
        dataText = fresh;
        tracker.progress(`🔥 已抓「${tpl.hotlistSource}」实时榜单 ${fresh.split('\n').length} 条`);
      } else {
        tracker.progress(`⚠️ 实时榜单「${tpl.hotlistSource}」抓取失败,用已保存的快照`);
      }
    }
    const lang = detectTemplateLang(`${dataText} ${tpl.title || ''}`);
    const wantNarration = tpl.narration === true;
    // 「AI 自由排版」:AI 写整页 HTML(freeformWriter + 体检闭环),不走固定模板渲染、不分页。
    const isFreeform = tpl.style === 'ai_freeform';
    const vcfg = await getVideoConfig();
    // 估算 items 数量(就是 dataText 的非空行数,clamp 到模板上限 12),
    // 算 pageMeta 用 —— 让 AI 知道画面分几页、每页几条,据此分段输出 voiceSegments。
    const estItemCount = Math.min(12, Math.max(1,
      (dataText || '').split(/\r?\n/).filter((l) => l.trim()).length || 1));
    const pageSize = pageSizeFor(tpl.style);
    const estPageCount = calcPageCount(estItemCount, pageSize);
    const pageRanges = calcPageRanges(estItemCount, pageSize);
    let data: Awaited<ReturnType<typeof generateTemplateData>>;
    if (isFreeform && !wantNarration) {
      // 自由排版 + 无配音:不需要抽 items / 口播稿,AI 稍后直接读原文排版,省一次 AI 调用。
      data = { items: [], source: 'fallback', tokens: 0, costUsd: 0 } as Awaited<ReturnType<typeof generateTemplateData>>;
      tracker.done('data', '✅ 自由排版 · 跳过数据抽取(AI 将直接读原文)');
    } else {
      data = await generateTemplateData(
        {
          style: tpl.style,
          title: tpl.title,
          // 模板速生不再用 track —— 它对 AI 排版/口播稿都没指导意义(2026-06-12 删字段);
          // 编辑老任务时 input.track 可能还在,但生成不参考。
          dataText,
          lang,
          needVoiceScript: wantNarration,
          // 开了配音才传 pageMeta(让 AI 按页切分 voiceSegments);纯视觉/自由排版不需要
          pageMeta: (wantNarration && !isFreeform) ? { pageCount: estPageCount, pageRanges } : undefined,
        },
        // 服务端可调 prompt(只覆盖纯数据版;needVoiceScript 时仍用本地的强约束版,避免改坏)
        wantNarration ? undefined : vcfg.templateDataSystemPrompt,
      );
      tracker.addTokens(data.tokens, data.costUsd);
      tracker.done('data', data.source === 'ai'
        ? (isFreeform ? '✅ AI 已生成口播稿 · 自由排版' : '✅ AI 已整理数据 · 精品模板')
        : (isFreeform ? '✅ 口播稿已就绪 · 自由排版' : '✅ 数据已整理 · 精品模板'));
    }

    // ── STEP 2:配音(开了才跑;关了直接跳过)──────────────────────────
    throwIfAborted(signal);
    let realNarrationPath: string | undefined;
    let realDurationSec = 0;
    let captionCues: CaptionCue[] | undefined;
    if (wantNarration) {
      tracker.start('voice', '🎤 正在合成配音…');
      const script = cleanForTts(tpl.voiceScript || data.voiceScript || '');
      if (!script) {
        tracker.fail('voice', '配音稿为空(AI 产稿失败,且未填自定义口播稿)');
        return { ok: false, error: '配音稿为空,请关闭配音或填写自定义口播稿' };
      }
      const voice = tpl.voice || input.voice || getTtsVoice();
      const rate = typeof tpl.voiceRate === 'number' ? tpl.voiceRate
        : typeof input.voiceRate === 'number' ? input.voiceRate : 0;
      const r = await ttsWithFallback(script, voice, narrationPath, rate);
      if (!r) {
        const why = getLastTtsError() || '请稍后再试';
        tracker.fail('voice', `配音失败:${why}`);
        return { ok: false, error: `配音失败:${why}` };
      }
      realNarrationPath = r.audioPath;
      realDurationSec = r.durationSec;
      // 荒谬值护栏:>10 分钟判 TTS 异常(正常口播 800 字 AI 稿 ≈ 3 分钟;用户自定义长稿
      //   也到不了这)。重点是【显式失败】而不是默默截断 —— 任何"砍音频凑上限"都会交付
      //   念一半戛然而止的废片(2026-06-11 的 60s clamp 截断事故就是这么来的)。
      //   此时平台基础费还没预扣(charge 在渲染前才调),直接 return 即可,与配音失败同路径。
      if (realDurationSec > 600) {
        const err = `配音时长异常(${Math.round(realDurationSec)}s > 600s 上限),疑似 TTS 异常或口播稿过长。请缩短稿子后重试。`;
        tracker.fail('voice', err);
        return { ok: false, error: err };
      }
      // 字幕开关:默认 true,显式 false 时关
      if (tpl.subtitleEnabled !== false) captionCues = r.cues;
      // 把口播稿存一份到任务目录(对齐 stock pipeline 的「文案.txt」)。失败不阻塞出片 ——
      //   只是供用户事后查看 / 复用稿子。voiceSegments 有就一并列出,标明每段对应哪一页画面。
      try {
        const segs = data.voiceSegments;
        const lines: string[] = [
          `📝 模板速生口播稿(共 ${script.length} 字 / 配音时长 ${realDurationSec.toFixed(1)}s)`,
          '',
          script,
        ];
        if (Array.isArray(segs) && segs.length > 0) {
          lines.push('', `── 分页朗读分段(共 ${segs.length} 页) ──`);
          segs.forEach((s, i) => lines.push(`[第 ${i + 1} 页] ${s}`));
        }
        fs.writeFileSync(path.join(destDir, '文案.txt'), lines.join('\n'), 'utf8');
      } catch { /* 写文案 txt 失败不影响出片 */ }
      tracker.done('voice', `✅ 配音已生成 · ${realDurationSec.toFixed(1)}s${captionCues ? ` · ${captionCues.length} 句字幕` : ''}`);
    } else {
      // 跳过这一步(UI 上仍显示但直接 done)
      tracker.done('voice', '⏭ 已跳过(未开配音)');
    }

    // ── STEP 3:渲染 + 编码合成(一步到位)────────────────────────────
    throwIfAborted(signal);
    tracker.start('render', '🎞️ 渲染 + 编码…');

    // 时长决策:
    //   · 有配音 → 真实音频时长 + 0.4s 尾留白,**不设上限**。配音是真理源,视频必须跟完
    //     整段音频 —— 任何"砍到上限"都会交付念一半戛然而止的废片(60s clamp 时代
    //     2026-06-11 实测截断)。荒谬值(>600s)已在 STEP 2 TTS 之后显式 fail,
    //     走到这里的时长一定是合法的,只兜个 3s 下限防 0/负值。
    //   · 无配音 → 用户配置 / 自动估算(clamp[3, 20])
    const durationSec = wantNarration && realDurationSec > 0
      ? Math.max(3, realDurationSec + 0.4)
      : clamp(tpl.durationSec || autoDuration(dataText), 3, 20);
    const fps = tpl.fps && tpl.fps > 0 ? tpl.fps : 30;

    // 平台基础费预扣(对齐 stock 模式定价口径,单条约 $0.09~$0.18,服务端权威值)。
    // 在 AI 数据/配音已经实扣 token 之后、渲染【真起 ffmpeg】之前调:
    //   · 失败 → return + 不渲染(AI 部分已实扣无法退,与 stock 同行为)
    //   · 渲染失败 → catch 里 refundMode1Video 退回这笔(幂等)
    //   · videoCount=1(模板速生当前只出 1 条),aiCostUsd=本次 AI 已扣总额
    const charge = await chargeMode1Video(durationSec, { videoCount: 1, aiCostUsd: data.costUsd });
    if (!charge.ok) {
      let err: string;
      if (charge.reason === 'insufficient') err = '余额不足,无法生成(需先预扣平台基础费,请充值后重试)';
      else if (charge.reason === 'no_auth') err = '未登录 NoobClaw,无法生成';
      else err = '平台基础费预扣失败,请稍后重试';
      tracker.fail('render', err);
      return { ok: false, error: err };
    }
    chargeId = charge.chargeId;
    refundOnExit = true;
    tracker.addTokens(charge.chargedTokens || 0, charge.feeUsd || 0);
    tracker.progress(`💎 平台基础费已预扣 ${charge.chargedTokens || 0} 积分（≈$${(charge.feeUsd || 0).toFixed(2)}），失败将自动退回`);

    const brandColor = /^#[0-9a-f]{6}$/i.test(tpl.brandColor || '') ? tpl.brandColor! : '#f0b90b';
    let html: string;
    if (isFreeform) {
      // ── AI 自由排版:写 → 体检 → 修,迭代闭环(没有视觉模型,靠无头浏览器自查)──
      html = await produceFreeformHtml({
        dataText,
        title: data.title || tpl.title,
        lang,
        brandColor,
        accentColor: tpl.accentColor,
        durationSec,
        fps,
        narrationOn: wantNarration,
        captionCues,
        watermark: tpl.watermark,
        brief: tpl.brief,
        themeId: tpl.themeId,
      }, tracker, (tk, usd) => tracker.addTokens(tk, usd));
    } else {
      // ── 固定精品模板:音画同步(voiceSegments + 真实音频时长反算每页时间窗)+ 渲染 ──
      //
      // 原理:edge-tts 朗读速度恒定 → 段字符数比例 ≈ 段时间比例。我们把 AI 切好的
      // voiceSegments(每段对应一页画面)按字符长度比例分配真实音频时长,得到每页
      // 的 [startSec, durSec],传给 templateLibrary 替代均分,实现配音念到第 N 段
      // 时画面正好在第 N 页。
      //
      // 触发条件(任一不满足就 fallback 到均分):
      //   1) 开了配音,且 TTS 成功(realDurationSec > 0)
      //   2) AI 返回了 voiceSegments(且长度等于实际 items 分页后的页数)
      //   3) 实际 items 的分页页数 == AI 给的 segments 数量
      const actualPageSize = pageSizeFor(tpl.style);
      const actualPageCount = calcPageCount(data.items.length, actualPageSize);
      let pageTimings: Array<{ startSec: number; durSec: number }> | undefined;
      if (wantNarration && realDurationSec > 0 && data.voiceSegments && data.voiceSegments.length === actualPageCount) {
        const segs = data.voiceSegments;
        const totalChars = segs.reduce((s, x) => s + x.length, 0);
        if (totalChars > 0) {
          // 留 0.3s 入场 + 0.3s 尾留白(跟 paginate 兜底分支同口径)
          const usable = Math.max(2.0, realDurationSec - 0.6);
          let cursor = 0.3;
          pageTimings = segs.map((seg) => {
            const dur = (seg.length / totalChars) * usable;
            const startSec = cursor;
            cursor += dur;
            return { startSec, durSec: dur };
          });
          tracker.progress(`🎬 音画同步就绪 · ${actualPageCount} 页配上 ${segs.length} 段配音`);
        }
      } else if (wantNarration && actualPageCount > 1) {
        // 开了配音但 segments 没拿到/对不上 → 提示用户后会走均分,画面跟配音不严格对齐
        tracker.progress(`⚠️ AI 未按页切分配音,画面将按时长均分(${actualPageCount} 页 × ${(durationSec / actualPageCount).toFixed(1)}s)`);
      }

      const spec: TemplateSpec = {
        style: tpl.style,
        title: data.title || tpl.title,
        subtitle: data.subtitle,
        items: data.items,
        brandColor,
        accentColor: tpl.accentColor,
        durationSec,
        fps,
        captions: captionCues,
        pageTimings,
      };
      html = renderTemplate(spec);
    }
    try { fs.writeFileSync(path.join(destDir, '模板.html'), html, 'utf8'); } catch { /* non-fatal */ }

    // BGM 解析(本地 / 内置 / 云端;失败兜底为无 BGM,绝不阻塞出片)
    const bgm = await resolveBgmPath(input.bgmPath, (m) => tracker.progress(m)).catch(() => undefined);

    const outPath = path.join(destDir, outputFileName(0));
    // 渲染进度:每秒推一次,避免 ffmpeg 编码阶段假死
    let lastPush = 0;
    await renderHtmlToVideo({
      html,
      width: 1080, height: 1920,
      fps, durationSec,
      outPath,
      narrationPath: realNarrationPath,
      narrationVolume: 1.0,
      bgmPath: bgm,
      bgmVolume: typeof input.bgmVolume === 'number' ? input.bgmVolume : 0.18,
      signal,
      onProgress: (done, total) => {
        const now = Date.now();
        if (now - lastPush < 700 && done !== total) return;
        lastPush = now;
        tracker.progress(`🎞️ 渲染 ${done}/${total} 帧`);
      },
    });

    tracker.progress(`✅ 已生成 ${path.basename(outPath)}`);
    // 结尾把【本次实际写片的目录】绝对路径推一条 —— 渲染端 renderVideoLog 会自动把含 NoobClaw
    // 的路径转成可点击 button(点一下用 Finder/资源管理器打开),跟 stock 模式日志末尾的口径一致。
    tracker.progress(`📂 输出目录:${destDir}`);
    // 渲染编码成功 = 不再退款(用户拿到了成片,平台费名正言顺收下)
    refundOnExit = false;

    // ── Step 4: 发布到各大平台(同 stock/ai pipeline 口径) ──────────────────
    // 视觉/口播稿 都已经稳了,放心调 publisher。未登录的平台自动跳过,日志会说明。
    tracker.start('publish');
    const wantPublish = Array.isArray(input.publishPlatforms) && input.publishPlatforms.length > 0;
    try {
      const { resolvePublishCaption } = require('./publishCaptionWriter');
      const titleHint = tpl.title || (dataText || '').split(/\r?\n/).filter(Boolean)[0]?.slice(0, 40);
      // 平台发布文案:AI 据 voiceScript/dataText 写钩人文案(不再把口播稿/榜单原样当 caption)。
      const cap = await resolvePublishCaption({
        wantPublish,
        summary: tpl.voiceScript || dataText || titleHint || '',
        title: titleHint,
        keywords: [],
        track: input.track,
        lang,
        userTitle: input.publishTitle,
        userCaption: input.publishCaption,
        userTags: input.hashtags,
        onLog: (m: string) => tracker.progress(m),
        onCost: (tk: number, usd: number) => tracker.addTokens(tk, usd),
      });
      // 矩阵号 edition:发布走指纹内核 CDP(按平台→选定账号上传),不走扩展;非矩阵走旧 runPublishStep。
      const { MATRIX_EDITION } = require('../../matrixEdition');
      if (MATRIX_EDITION && wantPublish) {
        const { runMatrixPublishStep } = require('./publishers/runMatrixPublish');
        await runMatrixPublishStep({
          platforms: Array.isArray(input.publishPlatforms) ? input.publishPlatforms : [],
          accounts: (input as any).publishAccounts || {},
          videoPath: outPath,
          title: cap.title,
          description: cap.description,
          tags: cap.tags,
          onLog: (msg: string) => tracker.progress(msg),
          signal,
        });
      } else {
        const { runPublishStep } = require('./publishers/runPublish');
        await runPublishStep({
          platforms: Array.isArray(input.publishPlatforms) ? input.publishPlatforms : [],
          videoPath: outPath,
          title: cap.title,
          description: cap.description,
          tags: cap.tags,
          onLog: (msg: string) => tracker.progress(msg),
          signal,
        });
      }
    } catch (e) {
      tracker.progress(`⚠️ 发布步骤异常:${String((e as Error)?.message || e).slice(0, 120)}`);
    }
    tracker.finish(outPath, 1);
    return { ok: true, outputPath: outPath, outputPaths: [outPath] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('VIDEO_ABORTED') || msg === 'aborted') {
      return { ok: false, error: '已停止', aborted: true };
    }
    tracker.fail(null, msg);
    return { ok: false, error: msg };
  } finally {
    // 平台基础费失败退款(成片失败时;成功路径走完 refundOnExit=false 不退)。幂等,失败仅记日志。
    if (refundOnExit && chargeId) {
      try {
        const refunded = await refundMode1Video(chargeId);
        tracker.progress(refunded
          ? '↩️ 成片失败，已退回预扣的平台基础费'
          : '⚠️ 成片失败，平台基础费退回请求未成功（稍后可联系客服核对）');
      } catch { /* 退款失败不抛,仅日志 */ }
    }
    try { fs.rmSync(tmpAudioDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
