/**
 * pipeline — 本地出片总编排(一期 路线 A:文案 → 配音 → 画面 → 字幕 → 合成 mp4)。
 *
 * 流程:
 *   1. 拆解参考文案为逐句分镜
 *   2. 每句 edge-tts 配音(拿到每镜真实时长)
 *   3. 凑画面:参考图优先 → Pexels/Pixabay 素材图补 → 都没有上纯色文字卡
 *   4. ffmpeg 逐镜 Ken Burns + 烧字幕,concat 成竖屏 mp4
 *   5. 输出到 ~/Documents/NoobClaw/视频创作/<任务ID前8位>_<任务名>/<日期>/<批次号>/
 *      (同一任务同一天每跑一次 +1:1/、2/、3/…;无任务上下文的老调用退回 视频创作/<日期>/<批次号>/)
 *
 * 全程 emit 进度(steps 数组)给渲染端 UI。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { getHomePath } from '../platformAdapter';
import { isFfmpegAvailable, setVideoAbortSignal, runFfmpeg, probeDuration } from './ffmpegRuntime';
import {
  synthesize, synthesizeWhole, getLastTtsError, getVoiceFallbacks,
  alignSentencesToCues, groupWordCues,
} from './tts';
import { getTtsVoice } from './config';
import { fetchStockImages, fetchStockVideosByTerms, type StockVideoAsset, type StockVideoByTerm, type StockOrientation } from './stockProvider';
import { pickHotspotTopic, fetchHotspotMaterial, type HotspotTopic } from './hotspotProvider';
import { getUsedHotspots, markHotspotUsed } from './usedHotspotStore';
import { fetchDouyinClips } from './hotspotDouyinSource';
import { fetchTiktokClips } from './hotspotTiktokSource';
import { composeVideo, type SceneSpec, type SubtitleStyle, type SubtitleCue } from './compose';
import { generateScript, generateSearchTerms, detectLang, type ContentLang } from './scriptWriter';
import { getVideoConfig, localeFor } from './videoConfig';
import { chargeMode1Video, chargeHotspotImages, refundMode1Video } from './billing';
import { resolveBgmPath } from './bgm';
import { generateSeedanceClips, generateStoryboard, type SeedanceClipResult, type SeedanceSceneSpec } from './seedanceProvider';
import type { TemplateOptions } from './templateHtmlWriter';
import { runTemplatePipeline } from './template-pipeline';
import { runThreadPipeline } from './thread-pipeline';
import { generateStoryboardAnchor } from './storyboardAnchor';
import { resolvePublishCaption } from './publishCaptionWriter';
import { setCurrentVideoTask, clearCurrentVideoTask, videoTypeLabel } from './videoRunWindow';

export type VideoAspect = '9:16' | '16:9' | '1:1';
export type VideoPublishTarget = 'local' | 'douyin' | 'xhs' | 'binance';
export type SubtitlePosition = 'top' | 'center' | 'lower' | 'bottom';

/** aspect → 成片宽高(短边 1080)。 */
function aspectToSize(aspect: VideoAspect): { width: number; height: number } {
  switch (aspect) {
    case '16:9': return { width: 1920, height: 1080 };
    case '1:1': return { width: 1080, height: 1080 };
    case '9:16':
    default: return { width: 1080, height: 1920 };
  }
}

/** aspect → 素材库搜索方向。 */
function aspectToOrientation(aspect: VideoAspect): StockOrientation {
  switch (aspect) {
    case '16:9': return 'landscape';
    case '1:1': return 'square';
    case '9:16':
    default: return 'portrait';
  }
}

/** aspect → Seedance ratio 字段。 */
function aspectToSeedanceRatio(aspect: VideoAspect): '9:16' | '16:9' | '1:1' {
  if (aspect === '16:9') return '16:9';
  if (aspect === '1:1') return '1:1';
  return '9:16';
}

/**
 * 给一句口播稿构造 Seedance 画面 prompt —— 套 Seedance 官方 6 步公式(主体/动作 → 环境/光
 * → 单一运镜 → 风格 → 本地化 → 负向约束),提质不加钱。要点(来自官方/社区最佳实践):
 *   · 只给一个运镜(多运镜会抖);逐镜轮换不同运镜避免全片雷同。
 *   · 物理光源 + 写实风格;ROI 最高。
 *   · 负向约束:无文字/水印 + 避免抖动/肢体扭曲/闪烁。
 *   · 图生视频(有参考图)时不复述图里已有内容,只描述运动/运镜(否则主体漂移)。
 *   · 本地化:中文/日韩内容,人物按亚洲/对应国家、实景按当代城市风格;通用物体保持中性。
 */
function buildSeedancePrompt(
  sentence: string,
  opts: { track?: string; persona?: string; lang?: string; isI2V?: boolean; shotIndex?: number },
): string {
  const REGION: Record<string, string> = { zh: '中国', ja: '日本', ko: '韩国' };
  const region = REGION[(opts.lang || '').slice(0, 2).toLowerCase()];
  const styleBits = [opts.track, opts.persona].filter(Boolean).join('、');
  const CAMS = ['镜头缓慢推近', '镜头缓慢左移跟随', '镜头缓慢上摇', '固定机位、主体自然轻微动作', '镜头缓慢环绕'];
  const cam = CAMS[(opts.shotIndex ?? 0) % CAMS.length];

  const parts: string[] = [];
  if (opts.isI2V) {
    parts.push(`保持参考图的主体、构图与配色不变,只为画面添加自然、轻微的运动。`);
  } else {
    parts.push(`电影感竖屏空镜,画面贴合这句旁白(具体、可拍,有明确主体与单一动作):「${sentence}」。`);
  }
  parts.push(`环境真实、自然光、有空间层次与景深。`);
  parts.push(`运镜:${cam}(全程只用这一种,平稳不抖)。`);
  parts.push(`风格:电影感、纪实写实、画质清晰${styleBits ? `,贴合「${styleBits}」` : ''}。`);
  if (region) {
    parts.push(`本地化:若出现人物,为亚洲/${region}人面孔与气质;若为街景/室内/餐厅/商店/交通等实景,呈现当代${region}城市的环境与风格;通用物体、纯自然风景保持中性。`);
  }
  parts.push(`不要任何文字、字幕、水印、logo;避免画面抖动、肢体扭曲、时间闪烁。`);
  return parts.join('');
}

/**
 * AI 大分镜:把逐句碎分镜合并成更长的段(每段旁白约 8–12s),减少切刀、更连贯,
 * 也减少 Seedance"单镜最短时长"带来的浪费。按字数估时长(CJK ~4.5 字/秒):
 * 累加到 ≥MIN 就出一段,超过 MAX 先把当前段收尾再起新段。Seedance(1.x/lite)单次
 * 上限 12s,所以 MAX 字数对应 ≤~12s。
 */
function mergeSentencesForAi(sents: string[]): string[] {
  const hasCJK = sents.some((s) => /[぀-ヿ㐀-鿿가-힯]/.test(s));
  const MIN = hasCJK ? 36 : 90;   // ≈8s
  const MAX = hasCJK ? 54 : 135;  // ≈12s(Seedance 单镜上限)
  const out: string[] = [];
  let buf = '';
  for (const s of sents) {
    if (buf && (buf.length + 1 + s.length) > MAX) { out.push(buf); buf = s; }
    else buf = buf ? `${buf} ${s}` : s;
    if (buf.length >= MIN) { out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  return out.length ? out : sents;
}

/** 失败镜降级:借最近(左右就近)一个成功生成的片段路径;都没有返回 null。 */
function findNearestClip(results: SeedanceClipResult[], i: number): string | null {
  for (let d = 1; d < results.length; d++) {
    const a = results[i - d];
    if (a && a.path) return a.path;
    const b = results[i + d];
    if (b && b.path) return b.path;
  }
  return null;
}

export interface VideoCreationInput {
  persona: string;
  track: string;
  keywords: string[];
  /**
   * 视频文案。语义随 scriptMode 变:
   *   · strict → 逐字朗读的成片文案(必填),视频长度由其字数决定。
   *   · ai     → 仅作 AI 写稿的参考方向(可空),最终文案由 DeepSeek 生成。
   */
  script: string;
  /**
   * 文案模式。'strict' = 严格按用户文案逐字出片;'ai' = AI 写稿(用户文案作参考)。
   * 缺省时按老逻辑兼容:有 script → strict,无 → ai。
   */
  scriptMode?: 'strict' | 'ai';
  /**
   * 画面引擎(成片方式):
   *   · 'stock'(默认) → AI 分镜 + 在线素材库空镜(+可选本地上传混拼)。
   *   · 'ai'           → Seedance AI 自动成片:逐镜用 Seedance 生成视频片段,
   *                      参考图(≤2)做风格/人设统一;失败镜降级到参考图静帧/邻镜。
   *                      走服务端代理(/api/video/seedance/*),逐片段计费 + 失败退款。
   */
  engine?: 'stock' | 'ai' | 'template' | 'hotspot' | 'thread';
  /** AI 引擎分辨率档(成本敏感):'480p'|'720p'(默认)|'1080p'。 */
  seedanceResolution?: '480p' | '720p' | '1080p';
  /** AI 引擎模型档位:'lite'(1.0 Lite) | 'pro'(1.0 Pro) | 'pro15'(1.5 Pro,默认) | 'v2'(2.0)。 */
  seedanceModel?: 'lite' | 'pro' | 'pro15' | 'v2';
  /** engine==='template'(模板速生)专属配置;其它 engine 忽略。 */
  template?: TemplateOptions;
  /** engine==='hotspot'(热搜成片)专属:用户勾选的热点源('hotsearch'|'web3'|'tech')。
   *  每次运行从这些源最新 20 条随机挑 1 条选题,服务端联网取材 → 写稿 → Serper 配图。 */
  hotspotSources?: string[];
  /** engine==='hotspot' 素材来源:'image'(默认,Serper 配图 Ken Burns)|
   *  'douyin'(按标题搜抖音、下无水印视频混剪 + 底部黑条盖原字幕 + 配音)。 */
  hotspotMaterialSource?: 'image' | 'douyin';
  /** engine==='thread'(爆帖成片)专属。内容源,v1 只有 'reddit'(字段留给以后加贴吧/虎扑等)。 */
  threadSource?: 'reddit';
  /** engine==='thread':勾选的 subreddit(如 ['AskReddit','tifu'])。 */
  threadSubreddits?: string[];
  /** engine==='thread':创作语言(卡片文字 + 口播都用它;'en' = 原声不翻译)。默认 zh。 */
  threadLang?: 'zh' | 'en' | 'ja' | 'ko';
  /** engine==='thread':游戏录屏背景来源。'douyin'(默认,国内可用)| 'youtube'(需 VPN)。 */
  threadBgSource?: 'douyin' | 'youtube';
  /** engine==='thread':背景选择('random' 或服务端清单里的背景/搜索词 id)。 */
  threadBgChoice?: string;
  /** engine==='thread'(矩阵):Reddit 取材账号 id(用该号指纹内核抓帖+截图;空 = 自动选/无头兜底)。 */
  threadMaterialAccountId?: string;
  referenceImages: string[];
  /**
   * 用户上传的本地视频素材绝对路径(画面来源 = 本地上传)。非空时直接拿这些
   * 片段循环拼成片,跳过在线素材库搜索(连 DeepSeek 搜索词也省了)。
   */
  localVideos?: string[];
  aspect: VideoAspect;
  /**
   * 老字段,保留兼容(数据库 / 老任务可能还有 publishTarget:'local')。
   * 新字段 publishPlatforms 才是【实际发哪几个平台】的来源 —— pipeline 出片完成后
   * iterator forEach 它,对每个平台 driver 调 upload(不在数组里的不发,数组空 = 仅存本地)。
   * 用户在向导里勾选 9 平台中的 N 个,持久化到这里(空数组等价于以前的 'local')。
   */
  /**
   * 老字段,已废弃,只为兼容老任务/数据库里残留的 publishTarget:'local'。
   * 实际发哪几个平台只看 publishPlatforms,不要再读这个字段。改可选,新建任务不写。
   */
  publishTarget?: VideoPublishTarget;
  publishPlatforms?: string[];
  /**
   * 矩阵号 edition:每个发布平台选定的矩阵账号 id(平台→accountId)。非空时发布走该号
   * 的指纹内核 CDP(runMatrixDriver),不走扩展。空 / 非矩阵 → 仍走旧 runPublishStep(扩展)。
   */
  publishAccounts?: Record<string, string>;
  /**
   * 平台发布文案(用户向导可选填,覆盖 AI 自动生成)。这三个是【配在视频下方钩人点击】
   * 的文案,跟口播稿 / 视频标题是不同产物 —— 详见 publishCaptionWriter.ts。
   * 都留空 → 出片时 AI 自动生成(generatePublishCaption);用户填了 → 用用户的。
   */
  publishTitle?: string;     // 钩人标题(B站/头条号标题 + 小红书标题 + 抖音 caption 开头)
  publishCaption?: string;   // 正文(简介 + 引导互动)
  hashtags?: string[];       // 话题标签(driver 按平台加 #)
  /** 可选背景音乐本地路径。空 = 不加 BGM。 */
  bgmPath?: string;
  /** BGM 音量(0~1),默认 0.18。 */
  bgmVolume?: number;
  /** 目标视频时长(秒),仅在自动生成文案时用于控制长度。默认 45。 */
  targetSeconds?: number;
  /**
   * 是否用在线素材【视频】(优先于图片)。默认 true。视频效果远好过图片
   * Ken Burns(抄 MoneyPrinterTurbo)。下载失败/无匹配时自动降级到图片/文字卡。
   */
  useStockVideo?: boolean;
  /** 口播稿语言(创作语言,ContentLang 码,如 'zh'/'zh-TW'/'en'/'ja'/'vi'…)。
   *  空/'auto' = 维持原行为:按 文案→关键词→热点标题 自动探测。向导里与配音音色语种联动。 */
  scriptLang?: string;
  /** edge-tts 音色,空 = 用配置默认(zh-CN-XiaoxiaoNeural)。 */
  voice?: string;
  /** 语速档(-50~+50,单位%),0/空 = 正常语速。 */
  voiceRate?: number;
  /**
   * 是否生成口播旁白 + 字幕。默认 true。
   * 仅在 engine==='ai'(Seedance)下可设 false = 纯画面片:跳过 TTS、不烧字幕,
   * 镜头时长按分镜稿字数估算,音频只用 BGM(没选则静音)。其它模式忽略此字段。
   */
  narrationEnabled?: boolean;
  /** 是否烧字幕。默认 true。 */
  subtitleEnabled?: boolean;
  /** 字幕字号(成片原始分辨率下像素)。默认 52。 */
  subtitleFontSize?: number;
  /** 字幕位置。默认 bottom。 */
  subtitlePosition?: SubtitlePosition;
  /** 字幕文字颜色(#RRGGBB)。空 = 白色。 */
  subtitleColor?: string;
  /** 字幕描边颜色(#RRGGBB)。空 = 不描边(用半透明黑底盒)。 */
  subtitleStrokeColor?: string;
  /** 字幕字体文件名(resources/fonts/ 下,如 SmileySans-Oblique.ttf)。空 = 默认思源黑体。 */
  subtitleFont?: string;
  /** 每段素材最长秒数(换镜节奏)。默认 4,越小换镜越快。 */
  maxClipSeconds?: number;
  /**
   * 一次出片数量(1~5)。抄 MoneyPrinterTurbo:复用同一份脚本 + 配音,
   * 只对每条做不同的素材片段组合,平台费按条数 ×N。默认 1。
   */
  videoCount?: number;
  /** 热搜成片专属:每次运行出片条数随机区间 [min,max](主进程在区间内取 N 跑外层循环,
   *  每条独立选题+写稿+按条计费)。缺省 = 1。详见 renderer VideoCreationInput 同名字段。 */
  videoCountMin?: number;
  videoCountMax?: number;
  /**
   * v6.x: 所属视频任务 id。传入时,成片输出到【按任务】的文件夹
   * (视频创作/<id前8位>_<任务名>/<日期>/<批次号>/),详情页顶部「输出目录」稳定指向
   * 任务总目录(视频创作/<id前8位>_<任务名>/),每次运行在其下按 日期/批次号 分桶
   * (对齐涨粉任务 getTaskDirPath/getNextBatch 的按任务+批次分目录)。
   * 缺省(无任务上下文的老调用)退回按日期+批次分桶。
   */
  taskId?: string;
  /** v6.x: 任务标题,派生输出文件夹名用(配合 taskId)。 */
  taskTitle?: string;
}

export interface ProgressStep {
  key: string;
  label: string;
  status: 'waiting' | 'running' | 'done' | 'error';
}

export interface VideoCreationProgress {
  jobId: string;
  status: 'running' | 'done' | 'error';
  steps: ProgressStep[];
  message?: string;
  outputPath?: string;
  error?: string;
  /** 本次出片累计消耗的 DeepSeek token(写稿 + 搜索词);TTS/ffmpeg 免费不计。 */
  tokensUsed?: number;
  /** 本次出片累计 USD 成本(服务端权威 _noobclaw.costUsd 之和);老后端时为 0。 */
  costUsd?: number;
  /** 成片输出目录(开跑即确定,供详情页顶部展示)。 */
  outputDir?: string;
  /** 本次实际产出的成片条数(批量出片时>1,随终态 done 事件带回供渲染端计数)。 */
  videoCount?: number;
}

export interface VideoCreationResult {
  ok: boolean;
  /** 首条成片路径(兼容老调用 / 单条场景)。 */
  outputPath?: string;
  /** 批量出片时的全部成片路径(videoCount>1 时长度>1)。 */
  outputPaths?: string[];
  error?: string;
  /** 用户主动停止(非失败):渲染端据此显示「已停止」而非红色报错。 */
  aborted?: boolean;
}

export type ProgressEmitter = (p: VideoCreationProgress) => void;

// v2: 「拆解文案分镜」原是独立一步,但它只是本地纯文本 splitScript()(无 AI、无
// 耗时),单列一步徒增噪音 → 合并进「脚本」步(脚本生成完顺手拆句,同一步内完成)。
const STEP_DEFS: { key: string; label: string }[] = [
  { key: 'script', label: '生成脚本 · 拆解分镜' },
  { key: 'tts', label: '生成 AI 配音' },
  { key: 'visuals', label: '准备画面素材' },
  { key: 'compose', label: '合成视频' },
  // 5: publish —— 出片完成后,遍历用户勾选的平台调对应 driver(未登录跳过,不杀任务)。
  //   即使 publishPlatforms 为空也保留这一步:tracker.finish 会自动把所有未完成步骤标 done,
  //   日志里推「📂 未选发布平台 · 仅存本地」让用户看清楚。
  { key: 'publish', label: '发布到各大平台' },
];

export class ProgressTracker {
  private steps: ProgressStep[];
  // 累计 token + USD 成本 + 输出目录随每次 emit 带回,渲染端无需自己算。
  private tokensUsed = 0;
  private costUsd = 0;
  private outputDir?: string;
  // 运行记录落盘:每行 message 同步追加到本地 markdown 文件(跟其他任务的本地记录一致,跟成片放一起)。
  private logFile?: string;
  // stepDefs 可定制:stock/ai 用默认 4 步;template 速生传自己的步骤集。
  constructor(private jobId: string, private emit?: ProgressEmitter, stepDefs: { key: string; label: string }[] = STEP_DEFS) {
    this.steps = stepDefs.map((s) => ({ ...s, status: 'waiting' as const }));
  }
  /** 设运行记录 markdown 文件(写 markdown 表头)。runVideoPipeline 在拿到 runDir 后调一次;失败不影响主流程。 */
  setLogFile(p: string) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, `# 🎬 视频运行记录\n\n- **开始时间**: ${new Date().toLocaleString('zh-CN', { hour12: false })}\n- **任务**: ${this.jobId}\n\n## 进度日志\n\n`);
      this.logFile = p;
    } catch { /* 落盘失败不影响任务 */ }
  }
  private send(status: 'running' | 'done' | 'error', message?: string, extra?: Partial<VideoCreationProgress>) {
    if (message && this.logFile) {
      // 每行做成 markdown 列表项:`- `[时:分:秒]` message`(跟其他任务的本地记录一样是 .md)。
      try { fs.appendFileSync(this.logFile, `- \`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]\` ${String(message).replace(/\n/g, ' ')}\n`); } catch { /* 忽略落盘错误 */ }
    }
    this.emit?.({
      jobId: this.jobId,
      status,
      steps: this.steps.map((s) => ({ ...s })),
      message,
      tokensUsed: this.tokensUsed,
      costUsd: this.costUsd,
      outputDir: this.outputDir,
      ...extra,
    });
  }
  /** 累加本步 token + USD 成本,并随下次 emit 把最新累计值带回去。 */
  addTokens(n: number, costUsd = 0) {
    this.tokensUsed += Math.max(0, Number(n) || 0);
    this.costUsd += Math.max(0, Number(costUsd) || 0);
  }
  /** 出片目录开跑即确定,设一次即可,后续每次 emit 都会带上。 */
  setOutputDir(dir: string) {
    this.outputDir = dir;
  }
  start(key: string, message?: string) {
    const s = this.steps.find((x) => x.key === key);
    if (s) s.status = 'running';
    this.send('running', message);
  }
  done(key: string, message?: string) {
    const s = this.steps.find((x) => x.key === key);
    if (s) s.status = 'done';
    this.send('running', message);
  }
  progress(message: string) {
    this.send('running', message);
  }
  fail(key: string | null, error: string) {
    if (key) {
      const s = this.steps.find((x) => x.key === key);
      if (s) s.status = 'error';
    }
    this.send('error', undefined, { error });
  }
  finish(outputPath: string, videoCount = 1) {
    this.steps.forEach((s) => { if (s.status !== 'done') s.status = 'done'; });
    this.send('done', undefined, { outputPath, videoCount });
  }
}

/** 把参考文案拆成逐句分镜。 */
export function splitScript(script: string): string[] {
  const raw = (script || '').replace(/\r\n/g, '\n');
  // 语言自适应:CJK 文本字符密度高(中文约 4.5 字/秒),拉丁文本同样秒数字符多得多。
  // 阈值/合并按是否含 CJK 切换,避免英文/日文被按中文阈值切得过碎、撞到 40 镜上限被截断。
  const hasCJK = /[぀-ヿ㐀-鿿가-힯]/.test(raw);
  const longLimit = hasCJK ? 36 : 110;   // 单镜过长再按逗号细切的阈值
  const shortLimit = hasCJK ? 4 : 12;    // 过短碎句并入上一镜的阈值
  const sep = hasCJK ? '，' : ', ';       // 细切后回拼用的分隔符

  // 先按换行 + 句末标点切(英文句号 `. ` / 句末句号也算一刀)
  const rough = raw
    .split(/[\n。！？!?；;]+|\.(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  const scenes: string[] = [];
  for (const piece of rough) {
    // 过长的句子再按逗号切,单镜别太挤(中英文逗号 + 顿号都算)
    if (piece.length > longLimit) {
      const sub = piece.split(/[,，、]+/).map((s) => s.trim()).filter(Boolean);
      let buf = '';
      for (const part of sub) {
        if ((buf + part).length > longLimit && buf) {
          scenes.push(buf);
          buf = part;
        } else {
          buf = buf ? `${buf}${sep}${part}` : part;
        }
      }
      if (buf) scenes.push(buf);
    } else {
      scenes.push(piece);
    }
  }

  // 合并过短碎句到上一镜
  const merged: string[] = [];
  for (const s of scenes) {
    if (s.length < shortLimit && merged.length > 0) {
      merged[merged.length - 1] += `${sep}${s}`;
    } else {
      merged.push(s);
    }
  }

  return merged.slice(0, 40); // 安全上限
}

/** 文件夹名清洗:剔除路径非法字符 + 折叠空白,限长(中文标题照样可用)。 */
function sanitizeFolderName(s: string): string {
  return (s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** 本地日期串 年-月-日(对齐 scenario artifactWriter.todayStr)。 */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 当天目录里下一个运行批次号(扫已有数字子目录取 max+1)。同一任务同一天每跑一次 +1。
 * 算法照搬 scenario artifactWriter.getNextBatch,让视频与涨粉任务的批次目录规范一致。
 */
function getNextBatch(dayDir: string): number {
  try {
    if (!fs.existsSync(dayDir)) return 1;
    let max = 0;
    for (const e of fs.readdirSync(dayDir)) {
      const n = parseInt(e, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max + 1;
  } catch {
    return 1;
  }
}

/**
 * 成片目录,对齐 scenario 的「任务总目录 + 日期 + 批次号」规范:
 *   · taskDir(详情页顶部「输出目录」指向它,稳定不随运行变):
 *       - 有 taskId → 视频创作/<id前8位>_<任务名>/
 *       - 无 taskId(老调用)→ 视频创作/<年-月-日>/(日期桶充当任务根)
 *   · runDir(本次运行实际写成片的目录)= taskDir/<年-月-日>/<批次号>/
 *       同一任务同一天每手动跑一次新建 1/、2/、3/…(无 taskId 时任务根已是日期,不再套一层)。
 *   一次批量出片(videoCount>1)只调一次 → N 条成片同落一个 <批次号>/,靠文件名 _N 后缀区分。
 */
export function resolveOutputDirs(input?: { taskId?: string; taskTitle?: string }): { taskDir: string; runDir: string } {
  let docs: string;
  try {
    docs = require('electron').app.getPath('documents');
  } catch {
    docs = path.join(getHomePath(), 'Documents');
  }
  const root = path.join(docs, 'NoobClaw', '视频创作');
  let taskDir: string;
  let dayDir: string;
  if (input?.taskId) {
    const folder = sanitizeFolderName(`${input.taskId.slice(0, 8)}_${input.taskTitle || ''}`) || input.taskId.slice(0, 8);
    taskDir = path.join(root, folder);
    dayDir = path.join(taskDir, todayStr());
  } else {
    // 无任务上下文:日期桶既当任务根(UI 显示)又当当天目录,批次号直接挂其下,避免 日期/日期 套娃。
    taskDir = path.join(root, todayStr());
    dayDir = taskDir;
  }
  const runDir = path.join(dayDir, String(getNextBatch(dayDir)));
  fs.mkdirSync(runDir, { recursive: true });
  return { taskDir, runDir };
}

export function outputFileName(index = 0): string {
  const t = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  // 批量出片在同一秒内循环写多条 → 时间戳会撞;index>0 时加序号后缀避免覆盖。
  const suffix = index > 0 ? `_${index + 1}` : '';
  return `video_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}${suffix}.mp4`;
}

/** 主入口:跑完整流水线,返回成片结果。 */
/**
 * 出片总入口。在内部实现 runVideoPipeline 外包一层,出片结束(成功/失败)后
 * 异步 fire-and-forget 上报到后端 user_task_runs(admin 巡检视频创作任务)。
 *
 * ⚠️ 上报绝不 await、绝不 throw、绝不阻塞出片(用户硬约束)。这里截一份 emit
 * 来记录最后一次累计 token / 成本(VideoCreationResult 本身不带),仅用于上报,
 * 不改变任何对渲染端的行为。
 */
/** 用户点「停止」时,signal 被 abort → 在步骤边界抛出,让 pipeline 干净退出。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('VIDEO_ABORTED:已停止');
}

/**
 * 批量编排:决定一次任务出几条,外层逐条独立跑 generateVideo,聚合成【唯一一次】终态。
 *   · stock      → N = videoCount(1~100)
 *   · hotspot    → N = 随机 [videoCountMin, videoCountMax](每条独立选题,pipeline 内部恒 1 条)
 *   · ai/template→ 1 条(Seedance 逐帧烧钱 / 模板单次)
 * ⚠️ 必须是【所有 video:generate 入口】的统一编排:main.ts 的 IPC handler 和 sidecar-server 的
 *    video:generate(scenario 定时/后台任务走这条!)都要调本函数 —— 否则走 sidecar 的任务拿不到
 *    batch,hotspot/stock 永远只出 1 条(用户实测:设 2 条却只出 1 条就结束)。
 *    每条都【完整跑完】(本地保存 + 按需发布)才进下一条,中途不提前结束。
 */
let _videoBatchBusy = false; // ③ 进程级单飞闸:同一进程同时只跑一条视频流水线

export async function generateVideoBatch(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  // ③ 已有视频流水线在跑 → 跳过本次(匹配 videoQueue「占用即跳过、不排队」),防两条视频任务并发
  //    抢同一个 video_publish 窗口 / 抖音 tab 串台(用户实测:要 2 条却出 3 条 + 画面串台)。
  //    无论从哪条入口(main IPC / sidecar / createAndRun / 调度)进来,都在此唯一汇合点拦住。
  if (_videoBatchBusy) {
    emit?.({
      jobId: (input as any).taskId, status: 'error', steps: [],
      message: '已有视频任务在运行,本次跳过(同时只跑一条,避免抢占视频窗口)',
      error: 'video_pipeline_busy',
    } as any);
    return { ok: false, error: '已有视频任务在运行,本次跳过' } as VideoCreationResult;
  }
  _videoBatchBusy = true;
  // 运行窗 title 标【当前任务 id + 类型】(req 2);收尾在 finally 清。
  setCurrentVideoTask((input as any).taskId, videoTypeLabel((input as any).engine));
  try {
  const inp = input as VideoCreationInput & { videoCountMin?: number; videoCountMax?: number };
  const clampCount = (n: unknown, hi: number) => Math.max(1, Math.min(hi, Math.round(Number(n) || 1)));
  let batch = 1;
  if (inp.engine === 'stock') {
    batch = clampCount(inp.videoCount, 100);
  } else if (inp.engine === 'hotspot' || inp.engine === 'thread') {
    // 兜底 videoCount:老任务(早期向导只存 videoCount、没存 min/max)也要正确出 N 条 ——
    //   否则 videoCountMin=undefined → clampCount=1 → batch=1,出现「卡片显示 N 条、实际只跑 1 条」。
    //   UI 标签(hotspotCountLabel)用 `videoCountMin ?? videoCount` 兜底,执行侧必须对齐同一口径。
    //   爆帖成片(thread)同口径:每条独立选帖,batch 由 [min,max] 随机。
    const lo = clampCount(inp.videoCountMin ?? inp.videoCount, 100);
    const hi = Math.max(lo, clampCount(inp.videoCountMax ?? inp.videoCount, 100));
    batch = lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  // 单条:hotspot 恒 videoCount=1(条数完全由 batch 控制);其余原样。generateVideo 自己发终态。
  if (batch <= 1) {
    const single = inp.engine === 'hotspot' ? ({ ...inp, videoCount: 1 } as VideoCreationInput) : input;
    return await generateVideo(single, emit, signal);
  }

  // 批量:逐条独立 generateVideo(videoCount=1),拦截单条终态转「第 X/N 条」批次进度,最后发唯一终态。
  // 「本次消耗」要【跨条累计】(否则第 2 条起单条 pipeline 从 0 重新报 → 显示被清空,用户困惑):
  //   cumTokens/cumCost = 已跑完条的成本之和;每条进度里加上当前条的实时值一起报 → 单调递增不回退。
  const outputPaths: string[] = [];
  let success = 0, failed = 0, stopped = false;
  let cumTokens = 0, cumCost = 0;
  for (let i = 0; i < batch; i++) {
    if (signal?.aborted) { stopped = true; break; }
    let curTokens = 0, curCost = 0;
    const subEmit: ProgressEmitter = (p: any) => {
      try {
        if (typeof p?.tokensUsed === 'number') curTokens = p.tokensUsed;
        if (typeof p?.costUsd === 'number') curCost = p.costUsd;
        const merged = { ...(p as object), tokensUsed: cumTokens + curTokens, costUsd: cumCost + curCost };
        if (p && (p.status === 'done' || p.status === 'error')) {
          emit?.({ ...merged, status: 'running', batchIndex: i + 1, batchTotal: batch,
            message: `第 ${i + 1}/${batch} 条${p.status === 'done' ? '已完成 ✅' : '失败,跳过 ⏭️'}` } as any);
        } else {
          emit?.({ ...merged, batchIndex: i + 1, batchTotal: batch } as any);
        }
      } catch { try { emit?.(p); } catch { /* ignore */ } }
    };
    let r: VideoCreationResult | undefined;
    try {
      r = await generateVideo({ ...inp, videoCount: 1 } as VideoCreationInput, subEmit, signal);
    } catch {
      failed++; cumTokens += curTokens; cumCost += curCost; continue; // 单条异常 → 跳过(已扣的钱仍计入累计)
    }
    cumTokens += curTokens; cumCost += curCost; // 把本条成本沉淀进累计,下一条在此基础上继续加
    if ((r as any)?.stopped) { stopped = true; break; }
    if (r?.ok) {
      success++;
      if (r.outputPath && !outputPaths.includes(r.outputPath)) outputPaths.push(r.outputPath);
      const rp = (r as any).outputPaths;
      if (Array.isArray(rp)) for (const p of rp) if (p && !outputPaths.includes(p)) outputPaths.push(p);
    } else {
      failed++;
    }
  }
  const summary = `批量完成:成功 ${success}/${batch} 条`
    + (failed ? ` · 跳过 ${failed} 条` : '')
    + (stopped ? ' · 已停止' : '');
  emit?.({
    jobId: (inp as any).taskId, status: success > 0 ? 'done' : 'error', steps: [],
    message: summary, outputPath: outputPaths[0], videoCount: success,
    tokensUsed: cumTokens, costUsd: cumCost, // 终态带【全批累计】成本,别让最后一刻被清
    ...(success > 0 ? {} : { error: stopped ? '已停止' : '全部失败' }),
  } as any);
  return { ok: success > 0, outputPath: outputPaths[0], outputPaths, stopped } as unknown as VideoCreationResult;
  } finally { _videoBatchBusy = false; clearCurrentVideoTask(); }
}

export async function generateVideo(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  const runId = randomUUID();
  const startedAt = Date.now();
  let lastTokens = 0;
  let lastCost = 0;
  const wrappedEmit: ProgressEmitter | undefined = (p) => {
    if (typeof p?.tokensUsed === 'number') lastTokens = p.tokensUsed;
    if (typeof p?.costUsd === 'number') lastCost = p.costUsd;
    emit?.(p);
  };

  // 设当前任务中断信号 → 本次出片期间 ffmpegRuntime 所有 runFfmpeg(合成/探测)abort 时自动 SIGKILL。
  setVideoAbortSignal(signal);
  let result: VideoCreationResult;
  try {
    result = await runVideoPipeline(input, wrappedEmit, signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 用户主动停止 → 标准化为「已停止」结果(渲染端据此显示停止态,不当报错)。
    result = msg.startsWith('VIDEO_ABORTED')
      ? { ok: false, error: '已停止', aborted: true }
      : { ok: false, error: msg };
  } finally {
    setVideoAbortSignal(undefined);
  }

  try {
    const { scheduleVideoRunReport } = require('../scenario/taskRunReporter');
    scheduleVideoRunReport({
      runId,
      input: { track: input.track, keywords: input.keywords, publishPlatforms: input.publishPlatforms },
      result,
      startedAt,
      finishedAt: Date.now(),
      tokensUsed: lastTokens,
      costUsd: lastCost,
    });
  } catch { /* non-fatal */ }

  return result;
}

async function runVideoPipeline(
  input: VideoCreationInput,
  emit?: ProgressEmitter,
  signal?: AbortSignal,
): Promise<VideoCreationResult> {
  // engine==='template'(模板速生):AI 现编动效 HTML → 逐帧渲染 → 编码。完全独立的
  // 流水线(template-pipeline.ts),早分流出去,不与 stock/ai 共用下面的步骤。
  if (input.engine === 'template') return runTemplatePipeline(input, emit, signal);
  // engine==='thread'(爆帖成片):Reddit 神帖截图卡 + 游戏录屏背景。同样独立流水线早分流。
  if (input.engine === 'thread') return runThreadPipeline(input, emit, signal);

  const jobId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tracker = new ProgressTracker(jobId, emit);

  // 前置:ffmpeg 必须可用
  if (!isFfmpegAvailable()) {
    const err = 'ffmpeg 不可用(开发机请确保 PATH 上有 ffmpeg;打包版需内置 ffmpeg 资源)';
    tracker.fail('script', err);
    return { ok: false, error: err };
  }

  // 计费:模式一(AI 分镜 + 在线素材)预扣平台基础费(随机 $0.09~$0.18)。
  // 为什么预扣而不是成片后扣:并发任务可能在本任务跑的过程里把余额扣光,等成片做完
  // 再扣就成了「视频做出来了、钱却扣不到」= 我们亏。预扣 = 原子锁住这笔费用;成片失败
  // 再按 chargeId 幂等退回(refundMode1Video)。
  // 判定口径 = 是否用到在线素材(useStockVideo!==false):只要走在线素材库就收平台费,
  // 哪怕用户同时上传了自己的本地视频混拼也照收(在线搜索/下载 + AI 搜索词都是真实成本);
  // 仅当纯本地素材(useStockVideo===false,老任务路径)才不收平台费,只耗已实时扣过的 AI token。
  // 批量出片(videoCount>1):脚本/配音/素材池复用一次,N 条画面并发合成。计费随条数走
  // (服务端 /charge 按 videoCount + aiCostUsd 算):平台费向上限靠拢 + AI 费按条数线性叠加,
  // 在下面 compose 阶段开跑前【一次性】预扣这笔(含全部条数)总费。chargeId/refundOnExit
  // 跟踪这笔在途预扣,供「全部条目失败 / 异常」时 finally 兜底整笔退回。
  // engine==='ai'(Seedance 自动成片)的钱在服务端【逐片段】扣(/seedance/create,
  // 含 markup),且失败自动退款 —— 不再走这里的"平台基础费"预扣,避免重复收费。
  // 热搜成片(engine==='hotspot')虽然 useStockVideo=false(纯图 Ken Burns),但要【按条计费】:
  // 主进程外层循环把它拆成 N 条单独 pipeline(各 videoCount=1),每条在这里预扣一份平台基础费
  // (≈$0.09~0.18),失败那条幂等退回 —— 故 hotspot 也算 mode1。
  const isMode1 = input.engine !== 'ai' && (input.useStockVideo !== false || input.engine === 'hotspot');
  let chargeId: string | undefined;
  let refundOnExit = false;

  // 临时素材目录(配音 + 下载的素材图)
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noobclaw-vid-assets-'));

  // 出片目录开跑即确定,emit 一次让详情页顶部立刻能显示「输出目录」。
  // taskDir = 任务总目录(详情页顶部稳定指向它);destDir = 本次运行 <日期>/<批次号>/(实际写成片)。
  const { taskDir, runDir } = resolveOutputDirs(input);
  let destDir = runDir; // 热搜成片选题后会给批次目录加「_标题」后缀(见下),所以用 let
  tracker.setOutputDir(taskDir);
  // 运行记录落本地一份 markdown(跟本次成片同目录、跟其他任务的本地记录一致);之后每行 tracker 日志自动追加。
  tracker.setLogFile(path.join(runDir, '运行记录.md'));

  try {
    // 0. 文案:strict = 逐字用用户文案;ai = DeepSeek 写稿(用户文案作参考)。
    //    缺省兼容老任务:有 script → strict,无 → ai。
    throwIfAborted(signal);
    tracker.start('script', `输出目录:${taskDir}`);
    // 拉服务端可调配置(prompt 模板 + 各阈值)。拉不到 / 没登录 → 用内置默认,出片照常。
    const vcfg = await getVideoConfig();
    // ── 热搜成片(engine==='hotspot'):写稿前先选题 + 联网取材 ──────────────
    //   从用户勾选的热点源最新 20 条随机 1 条 → Serper /news 取这条热点的最新资料。
    //   选题失败(源里没条目)→ 直接判错;取材失败(没配 serper key / 无网)→ 仅按标题写,
    //   不报错。后续完全复用 stock 图片模式的写稿/配图/合成/发布。
    let hotspotTopic: HotspotTopic | null = null;
    let hotspotMaterial = '';
    // 取材平台(抖音/TikTok):用户在向导里选的【最优先】,老任务无此字段才按选中热点标题语言兜底
    //   (中文→抖音,其他→TikTok)。取材(prefetch)+ 铺镜(visuals)两处统一用它路由,
    //   不能再各自 detectLang(标题) —— 否则用户选了 TikTok 但热点是中文标题时会被判回抖音。
    const resolveMaterialPlatform = (): 'douyin' | 'tiktok' => {
      const sel = (input as any).hotspotMaterialPlatform;
      if (sel === 'douyin' || sel === 'tiktok') return sel;
      return String(detectLang(hotspotTopic?.title || '')).toLowerCase().startsWith('zh') ? 'douyin' : 'tiktok';
    };
    // 新流程:中文热搜【先上抖音搜】下视频/图文 + 抓真实帖子标题 —— 标题给 AI 写口播稿(替掉 Serper),
    //   视频/图同时留着后面铺镜(buildDouyinPool / buildDouyinImagePool 直接复用,不再二次下载)。
    let douyinPrefetch: { mode: 'video' | 'image'; paths: string[]; titles: string[] } | null = null;
    // 同上,英文/小语种热搜【先上 TikTok 搜】(对称抖音 prefetch,buildTiktokPool/buildTiktokImagePool 复用)。
    let tiktokPrefetch: { mode: 'video' | 'image'; paths: string[]; titles: string[] } | null = null;
    if (input.engine === 'hotspot') {
      const sources = (input.hotspotSources || []).filter(Boolean);
      if (sources.length === 0) {
        const err = '热搜成片:未勾选任何热点源';
        tracker.fail('script', err);
        return { ok: false, error: err };
      }
      throwIfAborted(signal);
      // 进度里明确列出勾选了哪些榜单平台(对齐用户「想看到选中了哪个平台的热点」诉求)。
      const HOTSPOT_SRC_LABEL: Record<string, string> = {
        weibo: '微博热搜', douyin: '抖音热搜', zhihu: '知乎热榜', baidu: '百度热搜',
        bilibili: 'B站热搜', xueqiu: '雪球热门股', web3: 'Web3 资讯', tech: '科技/AI',
      };
      const srcNames = sources.map((s) => HOTSPOT_SRC_LABEL[s] || s).join('、');
      tracker.progress(`🔥 已勾选热点源:${srcNames} —— 正在从这些榜单最新条目里随机选题…`);
      // 按任务读出已用过的热点 id 传给后端排除:一次跑 N 条(主进程外层循环逐条调本 pipeline)
      //   每条都排掉前面已选的 → 各不相同;跨次运行也不会重复同一热点。
      //   ⚠️ 不在这里 markHotspotUsed —— 改到【发布后、≥1 平台成功(或仅存本地已出片)】才记一笔
      //   (用户要求:只有上传成功才算用过;发布全失败的选题下次还能重试)。见下方 publish 段。
      const usedIds = getUsedHotspots(input.taskId || '');
      hotspotTopic = await pickHotspotTopic(sources, usedIds);
      if (!hotspotTopic) {
        const err = '热搜成片:所选热点源暂无可用条目(稍后热榜刷新再试)';
        tracker.fail('script', err);
        return { ok: false, error: err };
      }
      const pickedSrc = HOTSPOT_SRC_LABEL[hotspotTopic.source] || hotspotTopic.source || '未知来源';
      tracker.progress(`📌 本次选中【${pickedSrc}】的热点:「${hotspotTopic.title}」`);
      // 批次目录加「_热搜标题」后缀,方便区分(1_众星悼念… / 2_…)。此刻还没往 destDir 写任何文件 →
      //   改名安全;getNextBatch 用 parseInt 取前导数字,带后缀也能正确续号、不重号。失败则照用原目录。
      try {
        const titleSuffix = sanitizeFolderName(hotspotTopic.title).slice(0, 40);
        if (titleSuffix) {
          const newDir = path.join(path.dirname(destDir), `${path.basename(destDir)}_${titleSuffix}`);
          if (newDir !== destDir && !fs.existsSync(newDir)) {
            fs.renameSync(destDir, newDir);
            destDir = newDir;
          }
        }
      } catch { /* 改名失败不影响出片 */ }
      throwIfAborted(signal);
      // 【新流程,不再 Serper 联网取材】中文热搜直接上抖音搜:下视频/图文 + 抓真实帖子标题,
      //   拿这些抖音标题 + 热搜标题给 AI 写口播稿(很真实、贴热点);素材同时留着后面铺镜。
      //   非中文(TikTok 路,WIP)/ 抖音没结果 → 没标题 → AI 仅按热搜标题写,绝不回 Serper。
      // 走抖音还是 TikTok 取材,按【用户在向导选的取材平台】,不再按标题语言(见 resolveMaterialPlatform)。
      if (resolveMaterialPlatform() === 'douyin') {
        const dyMode: 'video' | 'image' = input.hotspotMaterialSource === 'douyin' ? 'video' : 'image';
        const want = dyMode === 'video'
          ? Math.max(6, Math.min(15, Math.ceil((input.targetSeconds ?? 60) / 6)))
          : Math.max(10, Math.min(30, Math.ceil((input.targetSeconds ?? 60) / 3)));
        tracker.progress(`🎬 上抖音搜「${hotspotTopic.title}」,下${dyMode === 'video' ? '视频' : '图文'} + 抓标题…`);
        const dy = await fetchDouyinClips([hotspotTopic.title], want, assetDir, (m) => tracker.progress(m), signal, dyMode, (input as any).hotspotMaterialAccountId);
        douyinPrefetch = { mode: dyMode, paths: dy.paths, titles: dy.titles };
        if (dy.titles.length > 0) {
          hotspotMaterial = `抖音上关于「${hotspotTopic.title}」的热门帖子标题(供你了解大家在聊什么、按真实角度写,别照抄、别张冠李戴):\n`
            + dy.titles.slice(0, 12).map((t, i) => `${i + 1}. ${t}`).join('\n');
          tracker.progress(`📝 拿到 ${dy.titles.length} 个抖音标题 + ${dy.paths.length} 个素材,AI 据此 + 热搜标题写口播`);
        } else {
          tracker.progress('⚠️ 抖音没抓到标题(没登录/没结果),AI 仅按热搜标题写');
        }
      } else {
        // 非中文热搜:上 TikTok 搜(对称抖音)——下视频/图集 + 抓真实帖子标题,标题给 AI 写口播稿。
        const tkMode: 'video' | 'image' = input.hotspotMaterialSource === 'douyin' ? 'video' : 'image';
        const want = tkMode === 'video'
          ? Math.max(6, Math.min(15, Math.ceil((input.targetSeconds ?? 60) / 6)))
          : Math.max(10, Math.min(30, Math.ceil((input.targetSeconds ?? 60) / 3)));
        tracker.progress(`🎬 上 TikTok 搜「${hotspotTopic.title}」,下${tkMode === 'video' ? '视频' : '图集'} + 抓标题…`);
        const tk = await fetchTiktokClips([hotspotTopic.title], want, assetDir, (m) => tracker.progress(m), signal, tkMode, (input as any).hotspotMaterialAccountId);
        tiktokPrefetch = { mode: tkMode, paths: tk.paths, titles: tk.titles };
        if (tk.titles.length > 0) {
          hotspotMaterial = `TikTok 上关于「${hotspotTopic.title}」的热门帖子标题(供你了解大家在聊什么、按真实角度写,别照抄、别张冠李戴):\n`
            + tk.titles.slice(0, 12).map((t, i) => `${i + 1}. ${t}`).join('\n');
          tracker.progress(`📝 拿到 ${tk.titles.length} 个 TikTok 标题 + ${tk.paths.length} 个素材,AI 据此 + 热搜标题写口播`);
        } else {
          tracker.progress('⚠️ TikTok 没抓到标题(没登录/没结果/未开 VPN),AI 仅按热搜标题写');
        }
      }
    }

    const userText = (input.script || '').trim();
    // 热搜成片恒为 AI 写稿(用户不填稿)。
    const scriptMode: 'strict' | 'ai' = input.engine === 'hotspot'
      ? 'ai'
      : (input.scriptMode || (userText ? 'strict' : 'ai'));
    // 内容语言:口播稿 + 素材搜索词都用它。用户在向导显式选了创作语言(scriptLang)且由 AI
    // 写稿时用它;strict 逐字朗读模式下稿子就是用户原文,语言探测原文才对(选了语言也不生效,
    // 避免「英文语言 + 中文原稿」错配)。无显式选择维持自动:有视频文案就按文案语言走,再按
    // 关键词语言,热搜成片按选中热点标题的语言。空白时退化为中文。
    const scriptLangSel = String(input.scriptLang || '').trim();
    const contentLang: ContentLang = (scriptLangSel && scriptLangSel !== 'auto' && scriptMode === 'ai')
      ? (scriptLangSel as ContentLang)
      : detectLang(userText || (input.keywords || []).join(' ') || (hotspotTopic?.title || ''));
    // 本任务【写稿 + 搜索词】已扣的权威 USD 之和(含 reasoner ×3),供下面平台费预扣时
    // 按 videoCount 让服务端补收剩余 (count-1) 份 AI 费。AI 只调一次,各步累加进来。
    let aiCostUsd = 0;
    // 热搜成片计费诊断量:由抖音视频/图文池(buildDouyinPool / buildDouyinImagePool)填,charge 时读。
    let hotspotImageCount = 0;
    const hotspotUsedCloud = false; // 配图已不走 Serper 云端代下(抖音/图文直连下载)→ 恒 false
    // 抖音混剪模式:画面是抖音视频(底部要盖黑条遮原字幕)。由下面素材分配那步置位,composeOne 读。
    let hotspotDouyinMode = false;
    let script = userText;
    if (scriptMode === 'ai') {
      const isHotspot = input.engine === 'hotspot';
      const topic = isHotspot && hotspotTopic
        ? hotspotTopic.title
        : ((input.keywords || []).filter(Boolean).join('、') || input.track || '生活方式');
      tracker.progress(isHotspot
        ? `AI 正在紧贴热点资料撰写口播（目标约 ${input.targetSeconds ?? 45}s）…`
        : (userText
          ? `AI 正在参考你的文案撰写旁白（目标约 ${input.targetSeconds ?? 45}s）…`
          : `AI 正在撰写旁白脚本（目标约 ${input.targetSeconds ?? 45}s）…`));
      try {
        const r = await generateScript({
          topic,
          persona: input.persona,
          // 热搜成片不绑赛道/关键词(题材由热点资料决定);其它模式照常传。
          track: isHotspot ? undefined : input.track,
          keywords: isHotspot ? undefined : input.keywords,
          targetSeconds: input.targetSeconds ?? 45,
          referenceScript: userText || undefined,
          material: isHotspot ? (hotspotMaterial || undefined) : undefined,
          lang: contentLang,
        }, vcfg.scriptSystemTemplate);
        script = r.script;
        aiCostUsd += r.costUsd;
        tracker.addTokens(r.tokens, r.costUsd);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        tracker.fail('script', `AI 写脚本失败:${err.slice(0, 200)}`);
        return { ok: false, error: err.slice(0, 300) };
      }
      // 把 AI 写的完整口播文案打到日志里(用户点详情页能看到 AI 到底写了啥)。
      // 注意:不在这里 done('script') —— 拆句已并入本步,拆完再 done。
      tracker.progress(`📝 口播文案(约 ${script.length} 字):${script}`);
    } else {
      // strict:严格逐字用用户文案。空文案直接判错(理论上客户端已挡)。
      if (!script) {
        const err = '严格模式下视频文案不能为空';
        tracker.fail('script', err);
        return { ok: false, error: err };
      }
      tracker.progress(`📝 视频文案(约 ${script.length} 字 ≈ ${Math.round(script.length / 4.5)}s):${script}`);
    }

    // 拆句(并入「脚本」步:本地纯文本切分,无 AI、瞬时完成)。
    let sentences = splitScript(script);
    if (sentences.length === 0) {
      const err = '文案为空或无法拆出有效分镜';
      tracker.fail('script', err);
      return { ok: false, error: err };
    }
    // AI 自动成片(Seedance):把碎句合并成更长的「大分镜」(每段 ~8–12s 旁白)再 TTS,
    // 这样每段配一个 8–12s 的连续片段 → 切刀少、更流畅,且少踩 Seedance 单镜最短时长的浪费。
    // 在 TTS 之前合并,音频/字幕(词边界 cue)自然按合并后的段走,不破坏。
    if (input.engine === 'ai') {
      sentences = mergeSentencesForAi(sentences);
      // 硬上限 45s:targetSeconds 只是给 AI 的提示,AI 可能写超 → 这里按字数估时长(CJK ~4.5
      // 字/秒、拉丁 ~2.2)累加截断,保证纯 AI 成片【实际】不超 45s,杜绝写超长稿烧钱。
      const AI_MAX_SEC = 45;
      const cps = /[぀-ヿ㐀-鿿가-힯]/.test(sentences.join('')) ? 4.5 : 2.2;
      const maxChars = Math.round(AI_MAX_SEC * cps);
      let acc = 0;
      const capped: string[] = [];
      for (const s of sentences) { if (acc >= maxChars) break; capped.push(s); acc += s.length; }
      if (capped.length > 0 && capped.length < sentences.length) {
        tracker.progress(`✂️ 纯 AI 成片时长上限 ${AI_MAX_SEC}s:超出部分已截断(保留 ${capped.length} 段)`);
        sentences = capped;
      }
      tracker.progress(`🎬 AI 大分镜:合并为 ${sentences.length} 段(每段约 8–12 秒,更连贯)`);
    }

    // 文案本地留一份(txt):全文 + 分镜,放成片输出目录,方便用户复用/二改/存档。
    try {
      const txt = [
        `# ${input.taskTitle || '视频文案'}`,
        `生成时间: ${new Date().toLocaleString()}`,
        ...(hotspotTopic ? [`热搜标题: ${hotspotTopic.title}`] : []),
        '',
        // 写稿参考的真实抖音帖子标题(新流程:替掉 Serper)—— 留档方便核对 AI 是不是贴着热点写。
        ...(douyinPrefetch && douyinPrefetch.titles.length > 0 ? [
          `【写稿参考的抖音标题 ${douyinPrefetch.titles.length} 条】`,
          ...douyinPrefetch.titles.map((t, i) => `${i + 1}. ${t}`),
          '',
        ] : []),
        // 英文/小语种:写稿参考的真实 TikTok 帖子标题(对称抖音)。
        ...(tiktokPrefetch && tiktokPrefetch.titles.length > 0 ? [
          `【写稿参考的 TikTok 标题 ${tiktokPrefetch.titles.length} 条】`,
          ...tiktokPrefetch.titles.map((t, i) => `${i + 1}. ${t}`),
          '',
        ] : []),
        '【完整口播文案】',
        script,
        '',
        `【分镜 ${sentences.length} 句】`,
        ...sentences.map((s, i) => `${i + 1}. ${s}`),
      ].join('\n');
      fs.writeFileSync(path.join(destDir, '文案.txt'), txt, 'utf8');
    } catch { /* 写文案 txt 失败不影响出片 */ }
    tracker.done('script', `脚本约 ${script.length} 字,拆出 ${sentences.length} 个分镜`);

    // 2. 逐句配音。同时收集 edge-tts 词边界字幕 cue,按各句在总时间轴上的累计起点
    //    偏移后合并成全局 cue(离线、精确,抄 MoneyPrinterTurbo);拿不到就让 compose 估算。
    // v6.x: 纯画面模式(仅 Seedance 可开)— 跳过 TTS、不烧字幕,镜头时长按分镜稿
    //   字数估算(5~10s,对 Seedance 片段硬限 [4,12] 友好)。其它模式恒为有旁白。
    const wantNarration = !(input.engine === 'ai' && input.narrationEnabled === false);
    // 每镜时长来源:有旁白 → 各句真实配音时长;纯画面 → 分镜稿字数估算。下游(Seedance
    //   生成 / 本地拼接 / compose)统一读 sceneDurations,不再直接摸 audios[i].durationSec。
    const sceneDurations: number[] = [];
    throwIfAborted(signal);
    tracker.start('tts');
    const audios: { audioPath: string; durationSec: number }[] = [];
    const subtitleCues: SubtitleCue[] = [];
    if (wantNarration) {
      // Voice fallback —— 句级 sticky:edge-tts 2026-04 起上游【按 voice 间歇性拒发音频】
      //   (rany2/edge-tts#473,单次请求随机失败)。每句独立配,某句 5 次重试仍败 → 【只对这句】
      //   顺着同语种同性别 voiceChain 换备用音色重配,成功的句子全部保留;换成功后【粘住】该音色,
      //   后续句优先沿用 → 整片音色基本统一,只在被迫切换的那一两句有同性别同语种的细微差异。
      //   仅当某一句把链上所有 voice 都试败,才整体失败退费。fallback 表见 tts.ts getVoiceFallbacks。
      //
      //   ⚠️ 为何不再「整片重做」(7118575 旧逻辑):那版任意一句失败就丢弃已成功句、切 voice 从
      //   第 0 句重配全部。句子越多,「整片至少一句撞上间歇性拒发」概率越高 → 22 句长文案几乎
      //   必然触发整片重来 → 三个 voice 轮完耗尽彻底失败。句级 fallback 把失败隔离到单句,救场率高。
      const primary = input.voice || getTtsVoice();
      const voiceChain = getVoiceFallbacks(primary);

      // ── 「一口气」优先路径:整段只发 1 次 edge-tts 请求,再按 cue 时间戳切回每句 ──
      //   请求数 N→1,从根上躲过 edge-tts「按 voice 间歇拒发」(N 句里中任一即失败 vs 单次)。
      //   整段合成也带 voice fallback(失败换音色重合,仍 1 次/音色)。切句对齐见 ttsAlign.ts:
      //   按【去标点字符流】把每句锚到 cue 真实时间戳,不累积误差;对不齐 → 回退下面的逐句路径。
      //   字幕直接用整段 cue(全局时间轴,比逐句拼接更准)。下游 audios/sceneDurations/subtitleCues
      //   形状与逐句路径完全一致 —— 分镜/compose 无感知。
      let wholeDone = false;
      try {
        const masterMp3 = path.join(assetDir, 'narr_master.mp3');
        let whole: Awaited<ReturnType<typeof synthesizeWhole>> | null = null;
        let usedWholeVoice = voiceChain[0];
        for (let vi = 0; vi < voiceChain.length; vi++) {
          const v = voiceChain[vi];
          throwIfAborted(signal);
          // ⚠️ 这段原来全程无日志:synthesizeWhole 内部 60s×5 重试 × 多个备用音色 → 连不上微软 TTS 时
          //   会静默 grind 十几分钟,UI 看着像「卡死无报错」。这里每个音色尝试前后都打日志 + 抛出 TTS 错因。
          tracker.progress(`配音合成中(音色 ${v}${voiceChain.length > 1 ? ` · ${vi + 1}/${voiceChain.length}` : ''})… 连微软 TTS,网络慢会重试,请稍候`);
          const w = await synthesizeWhole(sentences.join('\n'), masterMp3, v, input.voiceRate);
          if (w.ok) { whole = w; usedWholeVoice = v; break; }
          const reason = getLastTtsError();
          tracker.progress(`音色 ${v} 整段合成未成功${reason ? `(${reason.slice(0, 110)})` : ''}${vi < voiceChain.length - 1 ? ',换下一个音色…' : ''}`);
        }
        if (whole) {
          const spans = alignSentencesToCues(sentences, whole.rawCues, whole.durationSec);
          if (spans && spans.length === sentences.length) {
            const cutAudios: { audioPath: string; durationSec: number }[] = [];
            let cutOk = true;
            for (let i = 0; i < spans.length; i++) {
              throwIfAborted(signal);
              const outMp3 = path.join(assetDir, `narr_${String(i).padStart(3, '0')}.mp3`);
              const r = await runFfmpeg([
                '-y', '-i', masterMp3,
                '-ss', spans[i].start.toFixed(3), '-to', spans[i].end.toFixed(3),
                '-c:a', 'libmp3lame', '-q:a', '4', outMp3,
              ], { timeoutMs: 30_000, signal });
              if (!r.ok || !fs.existsSync(outMp3)) { cutOk = false; break; }
              cutAudios.push({ audioPath: outMp3, durationSec: Math.max(0.3, spans[i].end - spans[i].start) });
            }
            if (cutOk) {
              for (const a of cutAudios) { audios.push(a); sceneDurations.push(a.durationSec); }
              // 整段 cue 本就是全局时间轴,group 成短语后直接用(无逐句累计误差)。
              for (const c of groupWordCues(whole.rawCues)) {
                subtitleCues.push({ text: c.text, start: c.start, end: c.end });
              }
              wholeDone = true;
              const vTag = usedWholeVoice !== voiceChain[0] ? `,备用音色 ${usedWholeVoice}` : '';
              tracker.done('tts', `配音完成(整段 1 次合成 + 切 ${sentences.length} 段,省 ${sentences.length - 1} 次请求${vTag})`);
            }
          }
        }
        if (!wholeDone) tracker.progress('整段配音不可用(合成失败/切句对不齐),回退逐句合成…');
      } catch (e) {
        if (signal?.aborted) throw e;
        tracker.progress('整段配音异常,回退逐句合成…');
      }

      // ── 逐句 sticky fallback(整段路径不可用时;成功句保留、被拒就地换音色) ──
      if (!wholeDone) {
      let stickyVoice = voiceChain[0];
      let timelineOffset = 0;
      let synthCount = 0;
      let failIdx = -1;
      let lastReason = '';

      for (let i = 0; i < sentences.length; i++) {
        throwIfAborted(signal);
        const outMp3 = path.join(assetDir, `narr_${String(i).padStart(3, '0')}.mp3`);
        // 先试粘住的音色,再按 chain 顺序试其余(去重)。同性别同语种,切换不突兀。
        const tryOrder = [stickyVoice, ...voiceChain.filter((v) => v !== stickyVoice)];
        let got: Awaited<ReturnType<typeof synthesize>> | null = null;
        let usedVoice = stickyVoice;
        for (const v of tryOrder) {
          const r = await synthesize(sentences[i], outMp3, v, input.voiceRate);
          if (r.synthesized) { got = r; usedVoice = v; break; }
          lastReason = getLastTtsError() || lastReason;
        }
        if (!got) { failIdx = i; break; }
        if (usedVoice !== stickyVoice) {
          stickyVoice = usedVoice; // 粘住:后续句先试它,音色保持连续
          tracker.progress(`第 ${i + 1} 句主音色被拒,已切备用音色 ${usedVoice} 继续(已配好的句保留)`);
        }
        audios.push({ audioPath: got.audioPath, durationSec: got.durationSec });
        sceneDurations.push(got.durationSec);
        if (got.cues && got.cues.length > 0) {
          for (const c of got.cues) {
            subtitleCues.push({ text: c.text, start: c.start + timelineOffset, end: c.end + timelineOffset });
          }
        }
        timelineOffset += got.durationSec;
        synthCount++;
        const altTag = stickyVoice !== voiceChain[0] ? ` · 备用音色 ${stickyVoice}` : '';
        tracker.progress(`配音 ${i + 1}/${sentences.length}${altTag}`);
      }

      if (failIdx >= 0) {
        // 硬约束:必须有真人配音。某句把所有 voice 都试败 → 终止出片,平台基础费由 finally 退回。
        const triedMsg = voiceChain.length > 1
          ? ` · 已对该句尝试全部 ${voiceChain.length} 个备用音色,均合成失败`
          : '';
        const err = `配音失败:第 ${failIdx + 1}/${sentences.length} 句无法合成语音${triedMsg}`
          + (lastReason ? `(${lastReason.slice(0, 160)})` : '')
          + '。已终止出片,不会生成无配音的视频;平台基础费将自动退回。'
          + '常见原因:网络无法访问微软在线 TTS 接口,或当前为微软上游限流期(2026-04 起已知问题),请检查网络/代理后重试。';
        tracker.fail('tts', err);
        return { ok: false, error: err };
      }
      tracker.done('tts', `配音完成(${synthCount} 句全部真人语音${stickyVoice !== voiceChain[0] ? `,含备用音色 ${stickyVoice}` : ''})`);
      } // end if (!wholeDone) — 逐句 fallback
    } else {
      // 纯画面:每镜时长 = clamp(字数 / 4.5, 5, 10) 秒,跟着分镜稿内容走。
      for (let i = 0; i < sentences.length; i++) {
        sceneDurations.push(Math.max(5, Math.min(10, Math.ceil((sentences[i] || '').length / 4.5))));
      }
      tracker.done('tts', `纯画面模式 · 跳过配音,按分镜稿定时长(${sentences.length} 镜)`);
    }

    // 3. 画面:在线素材库(可叠加用户本地素材混拼);纯本地(老任务)走循环拼接。
    throwIfAborted(signal);
    tracker.start('visuals');

    // 用户上传的本地视频素材(已在 UI 限制格式 + 大小,这里再 existsSync 兜底)。
    const localVideos = (input.localVideos || []).filter((p) => p && fs.existsSync(p));
    // 是否用在线素材库:在线模式(useStockVideo!==false)即走在线 + 本地混拼;
    // 仅当明确关闭在线(纯本地,老任务路径)才完全离线循环拼本地素材。
    const usesStock = input.useStockVideo !== false;
    const maxClip = input.maxClipSeconds && input.maxClipSeconds > 0 ? input.maxClipSeconds : 4;
    // 一次出片条数(1~5)。抄 MPT:脚本/配音/素材池只做一次,每条只换片段组合。
    // AI 自动成片(Seedance)逐片段真金白银生成,批量没意义且翻倍烧钱 → 强制单条。
    // 热搜成片(含抖音混剪):每条必须是【不同热点】(主进程外层循环逐条独立选题),所以单个
    //   pipeline 恒出 1 条 —— 绝不在这里用 composeOne 复用同一热点的脚本/素材多出几条。
    const videoCount = (input.engine === 'ai' || input.engine === 'hotspot')
      ? 1
      : Math.max(1, Math.min(5, Math.round(input.videoCount ?? 1)));

    // Fisher–Yates 洗牌(不改原数组),用于批量出片时让每条的片段组合各不相同。
    const shuffled = <T,>(arr: T[]): T[] => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    // 画面分配器:给定第几条视频(0-based),产出该条的 { sceneClips, imagePool }。
    // 第 0 条按原顺序;后续条把素材池打乱再分配 → 同脚本/配音、不同画面。
    let assignVisuals: (videoIdx: number) => { sceneClips: string[][]; imagePool: string[]; imageByScene?: Map<number, string> };
  let douyinClips: string[] = []; // 抖音混剪模式下载到本地的视频路径(空 = 没取到,落回图片配图)
  let douyinImages: string[] = []; // 抖音图文模式下载到本地的图片路径(空 = 没取到,落回 Serper 配图)
  // 抖音【分段铺镜】池(buildDouyinPool):每镜中文词→逐词搜→按段铺,画面跟每镜内容走。null=没取到。
  let douyinPool: { assign: (videoIdx: number) => string[][]; imageByScene: Map<number, string> } | null = null;
  let douyinImgPool: { imageBySceneFor: (videoIdx: number) => Map<number, string>; imagePool: string[] } | null = null; // 抖音分段图文池
  // TikTok 池(英文/小语种话题,对称抖音):buildTiktokPool 视频混剪 / buildTiktokImagePool 图集图。null=没取到。
  let tiktokPool: { assign: (videoIdx: number) => string[][]; imageByScene: Map<number, string> } | null = null;
  let tiktokImgPool: { imageBySceneFor: (videoIdx: number) => Map<number, string>; imagePool: string[] } | null = null;

    if (input.engine === 'ai') {
      // ── AI 自动成片(Seedance):逐镜生成视频片段,参考图(≤2)统一风格 ──
      // 服务端逐片段计费(时长×分辨率)+ 失败自动退款。失败镜降级:就近复用成功片段,
      // 再不行用参考图静帧;一条都没成则整任务失败(钱已被服务端退回)。
      const refImagesAi = (input.referenceImages || []).filter((p) => p && fs.existsSync(p)).slice(0, 2);
      // 档位/分辨率不在客户端定:透传(可能 undefined)→ 服务端 seedance create 端点决定。
      const resolution = input.seedanceResolution;
      const aiScenes = sentences.map((s, i) => ({
        prompt: buildSeedancePrompt(s, {
          // 有参考文案时不把赛道当画面风格(避免给跨领域参考文案的画面带原赛道倾向);
          // 画面内容本就贴合口播句子(=参考文案内容),这里只去掉"风格贴合美食"的干扰。
          track: userText ? undefined : input.track, persona: input.persona,
          lang: contentLang, isI2V: refImagesAi.length > 0, shotIndex: i,
        }),
        // Seedance 单镜上限 12s(1.x/lite),大分镜合并后某段可能超过 → clamp 到 [4,12]。
        durationSec: Math.max(4, Math.min(12, Math.ceil(sceneDurations[i]))),
      }));
      // ── 故事板模式:先用 Seedream 组图出每镜【首帧】(同角色/画风),再图生视频(i2v,更稳)──
      //   首帧也存一份到本次输出目录的「故事板」文件夹(用户要的本地存档)。
      //   故事板失败/未配置 → 退化为纯文生视频(不挂首帧),不阻塞。
      try {
        // 视觉锚生成(纯 AI 模式专用,有参考图时跳过 —— 用户参考图本身就是最强锚)。
        //   把 character 字段从「persona · track」两词拼接(导致 Seedream 出套路图,如「亚洲女性看
        //   手机」)升级为【LLM 5 字段结构化视觉描述】(shot_type / subject / environment /
        //   lighting / style)。这是抄市面 image2 主流做法(Higgsfield 6 要素 + MoneyPrinterTurbo
        //   verbatim prompt 思路),让第 1 帧锚的方向具体到「东京涩谷木质装潢咖啡馆,午后暖琥珀
        //   侧光,35mm Kodak Portra 400」,后续每镜跟着这个 anchor 走质量就稳。
        //   失败兜底:返回 null 时降级到老的 persona+track 拼接(绝不阻塞出片)。
        let anchorCharacter = [input.persona, input.track].filter(Boolean).join(' · ');
        if (refImagesAi.length === 0) {
          tracker.progress('🎯 生成视觉锚(LLM 5 字段结构化描述,锁电影感)…');
          const anchor = await generateStoryboardAnchor({
            script, persona: input.persona, track: input.track, lang: contentLang,
          });
          if (anchor) {
            anchorCharacter = anchor.character;
            tracker.addTokens(anchor.tokens, anchor.costUsd);
            tracker.progress(`✅ 视觉锚就绪 · ${anchor.fields.shot_type} · ${anchor.fields.style.slice(0, 30)}…`);
          } else {
            tracker.progress('⚠️ 视觉锚生成失败,降级到 persona+track');
          }
        }

        tracker.progress(`🎨 生成故事板首帧(逐张出 ${aiScenes.length} 张,保持角色一致)…`);
        // 逐张生成:每张独立短请求(绕开 Cloudflare 100s/HTTP524),并逐张回进度。
        const storyboard = await generateStoryboard(
          {
            shots: aiScenes.map((sc) => sc.prompt),
            character: anchorCharacter,
            count: aiScenes.length,
          },
          (done, total) => { if (done < total) tracker.progress(`🎨 故事板生成中… ${done + 1}/${total} 张`); },
        );
        const keyframes = storyboard.images; // 按 shot 索引对齐,失败位为 ''
        const okFrames = keyframes.filter((s) => s).length;
        // 故事板首帧也是真金白银(Seedream 按张扣)—— 计入「本次消耗」,
        // 否则进度里图扣了费、总额却只剩 DeepSeek 写稿那几百,严重对不上。
        if (storyboard.chargedTokens > 0) {
          tracker.addTokens(storyboard.chargedTokens, storyboard.chargedTokens / 1_000_000);
        }
        if (okFrames > 0) {
          const sbDir = path.join(destDir, '故事板');
          try { fs.mkdirSync(sbDir, { recursive: true }); } catch { /* ignore */ }
          keyframes.forEach((dataUrl, i) => {
            if (!dataUrl) return; // 该镜没出图 → 不挂首帧,下游自动退化为文生视频
            if (i < aiScenes.length) (aiScenes[i] as SeedanceSceneSpec).keyframeDataUrl = dataUrl;
            try {
              const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
              if (m) {
                const ext = m[1] === 'image/png' ? 'png' : m[1] === 'image/webp' ? 'webp' : 'jpg';
                fs.writeFileSync(path.join(sbDir, `镜${i + 1}.${ext}`), Buffer.from(m[2], 'base64'));
              }
            } catch { /* 单张存盘失败不影响 */ }
          });
          tracker.progress(`🎨 故事板已生成 ${okFrames}/${aiScenes.length} 张首帧(已存「故事板」文件夹),转图生视频…`);
        } else {
          // 把服务端真实失败原因显示出来(否则只剩通用「未生成」,没法排查 Seedream 端报错)。
          tracker.progress(`🎨 故事板未生成${storyboard.error ? `(${storyboard.error})` : ''},退化为文生视频…`);
        }
      } catch (e) { tracker.progress(`🎨 故事板异常(${String((e as any)?.message || e).slice(0, 120)}),退化为文生视频…`); }
      tracker.progress(`🎬 AI 自动成片:逐镜生成 ${aiScenes.length} 个片段${resolution ? `(${resolution})` : ''}${refImagesAi.length ? ` · ${refImagesAi.length} 张参考图统一风格` : ''}…`);
      const clipResults = await generateSeedanceClips({
        scenes: aiScenes,
        referenceImages: refImagesAi,
        resolution,
        tier: input.seedanceModel,
        ratio: aspectToSeedanceRatio(input.aspect),
        destDir: assetDir,
        // 每镜【真成功落盘】时 seedanceProvider 会带 chargedTokens 调回来 → 立即累加进
        //   「上次消耗」,UI 实时跟进度日志同步涨。失败镜不带 charged,所以语义还是
        //   「只计成功镜」(原 generateSeedanceClips 返回后再 reduce 累加的做法跟用户
        //   逐镜「已扣 X 积分」日志严重对不上 —— 任务跑完前顶部一直是 0)。
        //   costUsd 按 1 USDT=1M tokens 折算(= 积分/1e6)供 $ 展示。
        onProgress: (m, charged) => {
          if (charged && charged > 0) tracker.addTokens(charged, charged / 1_000_000);
          tracker.progress(m);
        },
        signal,
      });
      const okCount = clipResults.filter((r) => r.path).length;
      if (okCount === 0) {
        // 原始 sample(如 "fetch failed")只打到 console 供排查,不展示给用户;
        // 用户面只给通用文案(退费由服务端按计费政策处理:有 token 输出不退、0 输出才退,不在文案里承诺)。
        const sample = clipResults.find((r) => r.error)?.error || '';
        if (sample) { try { console.error('[seedance] all shots failed, sample error:', sample); } catch { /* ignore */ } }
        const err = 'AI 自动成片暂时没出片,请稍后重试。';
        tracker.fail('visuals', err);
        return { ok: false, error: err };
      }
      assignVisuals = () => {
        const sceneClips = clipResults.map((r, i) => {
          if (r.path) return [r.path];
          const near = findNearestClip(clipResults, i);
          return near ? [near] : [];
        });
        // 既无本镜片段又借不到邻镜的(极端)→ 用参考图静帧兜底。
        const imageByScene = new Map<number, string>();
        if (refImagesAi.length > 0) {
          clipResults.forEach((r, i) => {
            if (!r.path && !findNearestClip(clipResults, i)) imageByScene.set(i, refImagesAi[i % refImagesAi.length]);
          });
        }
        return { sceneClips, imagePool: refImagesAi, imageByScene };
      };
      // AI 生成的片段本地留一份:assetDir 是临时目录(结尾会清掉),拷到成片输出目录的
      // 「素材」子文件夹,供用户复用/二剪/排查(对齐"成片+文案+素材"一起留档)。
      try {
        const matDir = path.join(destDir, '素材');
        fs.mkdirSync(matDir, { recursive: true });
        let saved = 0;
        clipResults.forEach((r, i) => {
          if (r.path && fs.existsSync(r.path)) {
            try { fs.copyFileSync(r.path, path.join(matDir, `第${i + 1}镜_${path.basename(r.path)}`)); saved++; } catch { /* 单个拷贝失败忽略 */ }
          }
        });
        if (saved > 0) tracker.progress(`📁 已在「素材」子目录留存 ${saved} 个 AI 片段(可复用/二剪)`);
      } catch { /* 留存失败不影响出片 */ }
      // 不向用户暴露「X/Y 镜 + 其余就近降级」(失败镜回退是内部兜底,用户不需要知道)。
      tracker.done('visuals', `🎬 AI 画面就绪(${aiScenes.length} 镜)`);
    } else if (!usesStock && localVideos.length > 0) {
      // 纯本地素材:不搜在线、不花 DeepSeek 搜索词钱,按换镜节奏循环拼接,素材少就复用。
      tracker.progress(`使用本地视频素材 ${localVideos.length} 个,按换镜节奏循环拼接…`);
      assignVisuals = (videoIdx: number) => {
        // 每条错开起始游标 → 同样的本地素材排出不同组合。
        let localCursor = videoIdx;
        const sceneClips = sentences.map((_, i) => {
          const dur = Math.max(1.2, sceneDurations[i]);
          const want = Math.max(1, Math.min(8, Math.ceil(dur / maxClip)));
          const clips: string[] = [];
          for (let k = 0; k < want; k++) clips.push(localVideos[localCursor++ % localVideos.length]);
          return clips;
        });
        return { sceneClips, imagePool: [] };
      };
      tracker.done('visuals', `画面就绪(本地素材 ${localVideos.length} 个${videoCount > 1 ? ` · ${videoCount} 条各不同组合` : ''})`);
    } else if (input.engine === 'hotspot' && input.hotspotMaterialSource === 'douyin'
               && resolveMaterialPlatform() === 'douyin'
               && (douyinPool = await buildDouyinPool())) {
      // 中文话题 + 选「视频混剪」:抖音混剪 —— 只按热搜标题搜、切片铺镜(见 buildDouyinPool,用户要求不 AI
      //   拆词)。取不到 → 短路落下面抖音图文 / 文字卡。非中文话题应走 TikTok(待做)。
      hotspotDouyinMode = true;
      assignVisuals = (videoIdx: number) => ({ sceneClips: douyinPool!.assign(videoIdx), imagePool: [] });
      tracker.done('visuals', '🎬 抖音混剪就绪(按热搜标题搜 · 底部黑条盖原字幕)');
    } else if (input.engine === 'hotspot'
               && resolveMaterialPlatform() === 'douyin'
               && (douyinImgPool = await buildDouyinImagePool())) {
      // 中文话题:选了图片配图、或选了视频混剪但视频没取到 → 抖音图文(只按热搜标题搜,见
      //   buildDouyinImagePool)。复用 hotspotDouyinMode=true:字幕走中下 lower;图镜
      //   hasVideo=false 不触发模糊盖条(图不需盖原字幕)。
      hotspotDouyinMode = true;
      assignVisuals = (videoIdx: number) => ({
        sceneClips: sentences.map(() => [] as string[]),
        imagePool: douyinImgPool!.imagePool,
        imageByScene: douyinImgPool!.imageBySceneFor(videoIdx),
      });
      tracker.done('visuals', '🖼️ 抖音图文就绪(按热搜标题搜 · 图片缓慢运镜)');
    } else if (input.engine === 'hotspot' && input.hotspotMaterialSource === 'douyin'
               && resolveMaterialPlatform() === 'tiktok'
               && (tiktokPool = await buildTiktokPool())) {
      // 英文/小语种话题 + 选「视频混剪」:TikTok 混剪 —— 只按热搜标题搜、切片铺镜(对称抖音 buildDouyinPool)。
      //   取不到 → 短路落下面 TikTok 图集 / 文字卡。中文话题应走上面抖音。
      hotspotDouyinMode = true; // 复用「平台混剪模式」:视频底部黑条盖原字幕 + 字幕走中下 lower
      assignVisuals = (videoIdx: number) => ({ sceneClips: tiktokPool!.assign(videoIdx), imagePool: [] });
      tracker.done('visuals', '🎬 TikTok 混剪就绪(按热搜标题搜 · 底部黑条盖原字幕)');
    } else if (input.engine === 'hotspot'
               && resolveMaterialPlatform() === 'tiktok'
               && (tiktokImgPool = await buildTiktokImagePool())) {
      // 英文/小语种话题:选了图片配图、或选了视频混剪但视频没取到 → TikTok 图集图(Ken Burns,对称抖音图文)。
      hotspotDouyinMode = true;
      assignVisuals = (videoIdx: number) => ({
        sceneClips: sentences.map(() => [] as string[]),
        imagePool: tiktokImgPool!.imagePool,
        imageByScene: tiktokImgPool!.imageBySceneFor(videoIdx),
      });
      tracker.done('visuals', '🖼️ TikTok 图集就绪(按热搜标题搜 · 图片缓慢运镜)');
    } else if (input.engine === 'hotspot') {
      // 热搜成片【不再用 Serper 配图】(用户决策 2026-06:中文→抖音,英文/小语种→TikTok)。
      //   走到这 = 中文话题抖音视频+图文都没取到,或英文/小语种话题 TikTok 视频+图集也没取到(没登录/没源/未开 VPN)。
      //   暂无素材 → assignVisuals 返回空 → compose 落「纯色文字卡」兜底(绝不再下 Serper 谷歌杂图)。
      tracker.progress('⚠️ 未取到平台素材(中文走抖音 / 英文走 TikTok)→ 本条用文字卡兜底');
      assignVisuals = () => ({ sceneClips: sentences.map(() => [] as string[]), imagePool: [] });
    } else {
      // 在线素材库(若有本地上传则混拼:本地片段优先露出 + 在线空镜补满)→ Pexels 素材库。
      // 素材池只建一次,assign(shuffle) 供每条按需取片段。
      const pool = await buildStockPool();
      assignVisuals = (videoIdx: number) => ({
        sceneClips: pool.assign(videoIdx > 0),
        imagePool: pool.imagePool,
        imageByScene: pool.imageBySceneFor ? pool.imageBySceneFor(videoIdx) : pool.imageByScene,
      });
    }

    // 在线素材库分支:AI 搜索词 → 逐词拉视频 → 图片补位 → 返回 { assign, imagePool }。
    // 抽成闭包是为了让本地上传时整段跳过(省时间 + 省 DeepSeek token);
    // assign(shuffle) 可被批量出片重复调用,每次用 fresh usedVideo 集分配。
    async function buildStockPool(): Promise<{ assign: (shuffle: boolean) => string[][]; imagePool: string[]; imageByScene: Map<number, string>; imageBySceneFor?: (videoIdx: number) => Map<number, string> }> {
    // 3a. 让 DeepSeek 给每个分镜配 1-3 个英文搜索词(画面跟着内容走)
    tracker.progress('AI 规划每镜画面关键词…');
    // A:把整条视频的主题/赛道/人设/关键词当语境喂给映射模型,让每镜的词锁定选题。
    //   但【有参考文案时】:口播已按参考文案写(可能跟原赛道不同领域,如美食赛道+spacex 文案),
    //   搜索词语境也不能再用原赛道/关键词,否则画面跟着美食走、跟实际口播打架 —— 改成纯按
    //   实际口播句子(sentences)配词。
    const usingReference = !!userText;
    const termsTopic = usingReference ? '' : ((input.keywords || []).filter(Boolean).join('、') || input.track || '');
    const termsResult = await generateSearchTerms(sentences, usingReference ? [] : (input.keywords || []), vcfg.termsSystemPrompt, {
      topic: termsTopic,
      persona: input.persona,
      track: usingReference ? undefined : input.track,
      keywords: usingReference ? undefined : input.keywords,
      lang: contentLang,  // 让人物镜头按内容语言加地区人种倾向(中文→asian),免得搜出全是老外
    });
    const perSceneTerms = termsResult.terms.map((arr) => (arr || []).map((s) => s.toLowerCase()));
    aiCostUsd += termsResult.costUsd;
    tracker.addTokens(termsResult.tokens, termsResult.costUsd);

    // 要去搜的词集:每镜首词优先(保证每个分镜的主画面词一定被搜到),再补其余词。
    const primaryTerms = Array.from(new Set(perSceneTerms.map((t) => t[0]).filter(Boolean)));
    const extraTerms = Array.from(new Set(perSceneTerms.flat().filter(Boolean)))
      .filter((t) => !primaryTerms.includes(t));
    // C:有效上限至少容得下【所有去重首词】(否则首词被砍的镜只能借全局 → 跑题),
    // 再封个硬顶 24 防极端长稿逐词搜请求过多;config 的 maxSearchTerms 作下限基线。
    const HARD_TERM_CAP = 24;
    const effectiveTermCap = Math.max(vcfg.maxSearchTerms, Math.min(primaryTerms.length, HARD_TERM_CAP));
    let searchTerms = [...primaryTerms, ...extraTerms].slice(0, effectiveTermCap);
    // 有参考文案时不退回原赛道关键词(否则又跑回美食);搜索词空就靠图片补位/全局兜底。
    if (searchTerms.length === 0 && !usingReference) {
      searchTerms = (input.keywords || []).map((s) => s.toLowerCase()).filter(Boolean);
    }
    if (searchTerms.length > 0) {
      tracker.progress(`🔍 画面搜索词:${searchTerms.join(', ')}`);
    }

    const refImages = (input.referenceImages || []).filter((p) => p && fs.existsSync(p));
    const wantVideo = input.useStockVideo !== false;
    const orientation = aspectToOrientation(input.aspect);

    // 3b. 逐词拉视频,保留「词 → 素材」归属(进度逐词回报,不再"没动静")
    // 每词下载几段【随出片条数缩放】:单条只需 ~1 段/词,多条才需多备(N 条不重复靠
    // 同词下的不同段轮流分配)。videoCount=1→2 段/词(够覆盖且最快),videoCount=5→封顶
    // vcfg.perTermCount(=6)。这是搜索耗时的主因——以前不论出几条都按 6 段/词下载,
    // 单条视频会白下 3 倍素材;按需缩放后单条下载量直接砍半。
    // C:每词至少备 3 段(原 2)。本镜词够用就不必借全局,关联更稳;多条出片再按需上探。
    const perTermCount = Math.max(3, Math.min(vcfg.perTermCount, videoCount + 2));
    let videoByTerm: StockVideoByTerm[] = [];
    if (wantVideo && searchTerms.length > 0) {
      tracker.progress(`搜索在线视频素材(共 ${searchTerms.length} 组关键词)…`);
      videoByTerm = await fetchStockVideosByTerms({
        terms: searchTerms,
        perTermCount,
        destDir: assetDir,
        orientation,
        // 英文词 + 内容语言 locale 兜底;size 让 Pexels 源头按档过滤(默认 small=HD≥720),省下白下白删。
        locale: localeFor(vcfg, contentLang),
        videoSize: vcfg.stockVideoSize,
        minVideoEdge: vcfg.minVideoEdge,
        minVideoSec: vcfg.minVideoSec,
        onProgress: ({ phase, done, total, term, totalGot, clip }) =>
          tracker.progress(phase === 'search'
            // 搜索阶段(并发):done=已搜完词数。
            ? `搜索关键词 ${done}/${total}「${term}」…`
            : clip
              // 下载阶段段级心跳:done=已完成词数,当前是第 done+1 个词下载中,段 index/count。
              ? `下载视频素材 词 ${done + 1}/${total}「${term}」· 段 ${clip.index}/${clip.count}(累计 ${totalGot} 段)`
              : `下载视频素材 ${done}/${total}:「${term}」(累计 ${totalGot} 段)`),
      });
    }

    // 建「词 → 该词的视频队列」(持久池)+ 全局视频列表;分配时各镜按自己的词取,用尽再借全局。
    const poolByTerm = new Map<string, StockVideoAsset[]>();
    for (const g of videoByTerm) poolByTerm.set(g.term.toLowerCase(), [...g.assets]);
    const allVideos: StockVideoAsset[] = videoByTerm.flatMap((g) => g.assets);

    // 用户本地素材混拼:把本地片段【均匀铺】到各分镜(每段大致出现一次),作为该镜
    // 的首选片段,其余位置再用在线空镜补满 → 本地 + 在线混着拼。无本地素材时此 map 为空,
    // 行为与纯在线完全一致。本地片段数 > 分镜数时,多出的会落到同一镜(成为该镜的额外段)。
    const localForScene = new Map<number, string[]>();
    if (localVideos.length > 0 && sentences.length > 0) {
      localVideos.forEach((clip, j) => {
        const idx = Math.min(sentences.length - 1, Math.round((j * sentences.length) / localVideos.length));
        const arr = localForScene.get(idx) || [];
        arr.push(clip);
        localForScene.set(idx, arr);
      });
      tracker.progress(`混入本地视频素材 ${localVideos.length} 个(优先露出,在线空镜补满)`);
    }

    // 单条视频的片段分配:每次用 fresh usedVideo 集 + (批量时)打乱后的素材队列,
    // 让批量出片的每条画面组合都不同。同一份持久池,各条互不影响。
    const assignOnce = (shuffle: boolean): string[][] => {
      const usedVideo = new Set<string>();
      const workByTerm = new Map<string, StockVideoAsset[]>();
      for (const [k, v] of poolByTerm) workByTerm.set(k, shuffle ? shuffled(v) : [...v]);
      const workAll = shuffle ? shuffled(allVideos) : [...allVideos];

      // 取一段【本条还没用过】的素材:先本镜搜索词命中,再借全局。新鲜素材都分完才返 undefined。
      const takeFreshClip = (i: number): string | undefined => {
        for (const term of perSceneTerms[i] || []) {
          const q = workByTerm.get(term);
          if (q) {
            const v = q.find((a) => !usedVideo.has(a.path));
            if (v) { usedVideo.add(v.path); return v.path; }
          }
        }
        const any = workAll.find((a) => !usedVideo.has(a.path));
        if (any) { usedVideo.add(any.path); return any.path; }
        return undefined;
      };

      // 新鲜素材分完后的循环兜底:只要下到了视频,就【绝不退在线图片】(用户要求:宁可复用视频也别补图)。
      // 用游标轮转整池,让复用尽量错开、不老是同一段;池子真空(一段没下到)才返 undefined → 上层退图/文字卡。
      let reuseCursor = 0;
      const reuseClip = (): string | undefined => {
        if (workAll.length === 0) return undefined;
        const p = workAll[reuseCursor % workAll.length].path;
        reuseCursor++;
        return p;
      };

      // want = ceil(时长/maxClip):该镜基础段数;cap = floor(时长/最短单段):该镜【最多】能放几段。
      // 多下来的新鲜素材后面按 cap 分摊进各镜 —— 既把下载的素材尽量用满(不浪费),画面也更丰富。
      // 用户反馈「下了几十段很多没用上、想画面再丰富点」→ 把最短单段 1.6→1.2s、每镜封顶 8→12 段:
      //   切得更勤、剩余下载素材尽量铺进去,少浪费(1.2s 仍不至于碎到跳帧)。
      const MIN_SEG_SEC = 1.2;
      const wantOf = (i: number) => Math.max(1, Math.min(8, Math.ceil(Math.max(1.2, audios[i].durationSec) / maxClip)));
      const capOf = (i: number) => Math.max(wantOf(i), Math.min(12, Math.floor(Math.max(1.2, audios[i].durationSec) / MIN_SEG_SEC)));

      const clipsByScene: string[][] = sentences.map((): string[] => []);
      // 1) 用户本地素材优先露出(封顶到本镜 want)。
      sentences.forEach((_, i) => {
        for (const lc of localForScene.get(i) || []) {
          if (clipsByScene[i].length >= wantOf(i)) break;
          clipsByScene[i].push(lc);
        }
      });
      // 2) 各镜先用新鲜在线素材补到 want。
      sentences.forEach((_, i) => {
        while (clipsByScene[i].length < wantOf(i)) {
          const fresh = takeFreshClip(i);
          if (fresh) clipsByScene[i].push(fresh);
          else break;
        }
      });
      // 3) 还有没用上的新鲜素材 → 轮流多塞给各镜(到该镜 cap 为止),把下载的素材尽量用满、画面更丰富。
      for (let guard = 0; guard < 4096 && workAll.some((a) => !usedVideo.has(a.path)); guard++) {
        let progressed = false;
        for (let i = 0; i < sentences.length; i++) {
          if (clipsByScene[i].length >= capOf(i)) continue;
          const fresh = takeFreshClip(i);
          if (fresh) { clipsByScene[i].push(fresh); progressed = true; }
        }
        if (!progressed) break;
      }
      // 4) 仍空的镜(池子非空但本镜词没命中且新鲜素材已分完)→ 循环复用,绝不退图片。
      sentences.forEach((_, i) => {
        if (clipsByScene[i].length === 0) {
          const r = reuseClip();
          if (r) clipsByScene[i].push(r);
        }
      });
      return clipsByScene;
    };

    // 用第一条(不打乱)的分配统计覆盖率 + 决定补位图片数量(各条覆盖率相近,算一次即可)。
    const probe = assignOnce(false);
    const scenesWithoutVideo = probe.filter((c) => c.length === 0).length;
    const totalClipsUsed = probe.reduce((n, c) => n + c.length, 0);
    const localUsed = localVideos.length > 0
      ? probe.reduce((n, c) => n + c.filter((p) => localVideos.includes(p)).length, 0)
      : 0;

    // 3c. 视频没覆盖到的分镜补图。D:按【该镜自己的搜索词】分组搜图,让补位图也贴该镜内容,
    //     而不是从全局词汤里随便挑一张。建 imageByScene(镜号→图)精确回填;另留扁平
    //     imagePool 兜底(批量出片打乱后,某条里没覆盖的镜可能不在 map 内,用它顶上)。
    const uncoveredIdx = probe.map((c, i) => (c.length === 0 ? i : -1)).filter((i) => i >= 0);
    const imageByScene = new Map<number, string>();
    const flatImages: string[] = [];
    if (uncoveredIdx.length > 0 && (searchTerms.length > 0 || refImages.length > 0)) {
      tracker.progress('补充在线图片素材(按各镜内容)…');
      // 先把用户参考图按顺序铺给最前面没覆盖的镜(参考图本就是用户想露出的画面)。
      let ri = 0;
      for (const idx of uncoveredIdx) {
        if (ri >= refImages.length) break;
        imageByScene.set(idx, refImages[ri++]);
      }
      // 其余没覆盖的镜:按各自首词(空则退全局首词/keywords)分组,逐词搜图后回填。
      const byTerm = new Map<string, number[]>();
      for (const idx of uncoveredIdx) {
        if (imageByScene.has(idx)) continue;
        const term = (perSceneTerms[idx] && perSceneTerms[idx][0])
          || searchTerms[0] || (input.keywords || []).map((s) => s.toLowerCase())[0] || '';
        if (!term) continue;
        const arr = byTerm.get(term) || [];
        arr.push(idx);
        byTerm.set(term, arr);
      }
      // 逐词搜图,总量封顶 20(避免长稿请求过多)。每词要够覆盖该词下的所有镜。
      let budget = 20;
      for (const [term, idxs] of byTerm) {
        if (budget <= 0) break;
        const want = Math.min(idxs.length, budget);
        const imgs = await fetchStockImages({
          keywords: [term],
          count: want,
          destDir: assetDir,
          orientation,
          minImageEdge: vcfg.minImageEdge,
        });
        budget -= imgs.length;
        imgs.forEach((p, k) => { if (idxs[k] !== undefined) imageByScene.set(idxs[k], p); });
        flatImages.push(...imgs);
      }
    }
    const imagePool = [...flatImages, ...refImages];

    tracker.done('visuals',
      (totalClipsUsed > 0 || imageByScene.size > 0 || imagePool.length > 0)
        ? `画面就绪(视频 ${totalClipsUsed} 段${localUsed > 0 ? `（含本地 ${localUsed} 段）` : ''} → 覆盖 ${sentences.length - scenesWithoutVideo}/${sentences.length} 镜,图片 ${imageByScene.size} 张按镜补位${videoCount > 1 ? ` · ${videoCount} 条各不同组合` : ''})`
        : '无可用素材,使用文字卡');

    // 在线素材原文件本地留一份(对齐 AI 分支):assetDir 是临时目录、结尾会清掉,把下载的
    // 在线视频/图片拷到成片输出目录的「素材」子文件夹,供用户复用 / 二剪 / 排查。
    // 只存下载的在线素材(allVideos + flatImages),不含用户自己的本地上传/参考图。
    try {
      const stockFiles = [...allVideos.map((v) => v.path), ...flatImages]
        .filter((p) => p && fs.existsSync(p));
      if (stockFiles.length > 0) {
        const matDir = path.join(destDir, '素材');
        fs.mkdirSync(matDir, { recursive: true });
        let saved = 0;
        const seen = new Set<string>();
        stockFiles.forEach((src, i) => {
          if (seen.has(src)) return;
          seen.add(src);
          try { fs.copyFileSync(src, path.join(matDir, `${String(i + 1).padStart(3, '0')}_${path.basename(src)}`)); saved++; } catch { /* 单个拷贝失败忽略 */ }
        });
        if (saved > 0) tracker.progress(`📁 已在「素材」子目录留存 ${saved} 个在线素材(可复用 / 二剪)`);
      }
    } catch { /* 留档失败不影响出片 */ }

    return { assign: assignOnce, imagePool, imageByScene };
    } // end buildStockPool

    /**
     * 抖音视频池:【只按热搜标题搜】(用户要求,不 AI 拆分镜词 —— 拆词会让画面偏离热点太远)→ 搜抖音/下视频/
     *   切片成片段池 → assign 时每镜从池里取、used 去重(切片够多 → 铺镜不重复)。取不到 → null,上层落
     *   抖音图文/文字卡。保留 perSceneTerms/poolByTerm 结构只为复用切片+去重逻辑,实际只有标题一个词。
     */
    async function buildDouyinPool(): Promise<{ assign: (videoIdx: number) => string[][]; imageByScene: Map<number, string> } | null> {
      // 【只按热搜标题搜】(用户要求):AI 拆分镜词会让画面偏离热点太远(如「沈泉锐第一次当摇子有点生疏」
      //   被拆成「机械 齐舞 舞台」搜出无关 cut),热搜成片永远只用热搜原标题搜,不额外出关键词。
      const title = (hotspotTopic?.title || '').trim();
      if (!title) return null;
      const searchTerms = [title];
      const perSceneTerms = sentences.map(() => [title]); // 每镜共用标题词,take 走全局池 + used 去重(不重复铺)
      // 3) 搜+切片,建 poolByTerm(词→片段)。【关键:切够铺一整条不重复的量】——
      //   本条要铺多少段 = 各镜段数之和(跟下面 assign 的 want 同口径),据此倒推要切多少片、下几个源。
      //   严禁复用切片(用户要求):池子按需求 ×1.3 切够;真不够就【多下几个源 / 每个源多切几段不一样的】,
      //   各段起点均匀错开(最小间隔 0.6s 视为不同片),绝不重复用同一时间段。
      const segLen = Math.max(2, maxClip);
      const wantOfScene = (i: number) => Math.max(1, Math.min(4, Math.ceil(Math.max(1.2, sceneDurations[i]) / maxClip)));
      const totalDemand = sentences.reduce((s, _s, i) => s + wantOfScene(i), 0);
      const poolTarget = Math.min(80, Math.ceil(totalDemand * 1.3) + 2); // 1.3× 缓冲(给 take 挑选余地),硬顶 80 段防极端长稿
      // 源视频数:按 poolTarget 估(每源平均能切 ~4 段),夹 [6,20];源越多画面越不雷同。
      const wantClips = Math.max(6, Math.min(20, Math.ceil(poolTarget / 4) + 1));
      tracker.progress(`🎬 抖音取材:只按热搜标题搜「${title}」(本条需 ${totalDemand} 段 → 目标切 ${poolTarget} 段、下 ${wantClips} 个源)`);
      const poolByTerm = new Map<string, string[]>();
      let si = 0;
      for (const term of searchTerms) {
        if (signal?.aborted) break;
        let dy: { paths: string[]; titles: string[] };
        if (douyinPrefetch && douyinPrefetch.mode === 'video') {
          // 写稿前已经搜过抖音视频了:直接复用(【空也复用】→ 不重复搜、不重复等 3 分钟登录;空则上层落文字卡)。
          if (douyinPrefetch.paths.length > 0) tracker.progress(`   ♻️ 复用写稿前已下好的 ${douyinPrefetch.paths.length} 个抖音视频(不重复下载)`);
          dy = { paths: douyinPrefetch.paths, titles: douyinPrefetch.titles };
        } else {
          dy = await fetchDouyinClips([term], wantClips, assetDir, (m) => tracker.progress(`   ${m}`), signal, 'video', (input as any).hotspotMaterialAccountId);
        }
        if (dy.paths.length === 0) { tracker.progress(`   ⚠️「${term}」没取到视频`); continue; }
        // 下载的源视频留档到输出目录「素材」子目录(assetDir 是临时目录、结尾会清掉,不留档就丢了)。
        //   跟 stock / 旧 collectDouyinClips 一致 —— 用户要能在成片旁边看到/复用原素材。
        try {
          const matDir = path.join(destDir, '素材');
          fs.mkdirSync(matDir, { recursive: true });
          dy.paths.forEach((src, i) => {
            try { fs.copyFileSync(src, path.join(matDir, `素材${String(i + 1).padStart(2, '0')}_${path.basename(src)}`)); } catch { /* 单个失败忽略 */ }
          });
        } catch { /* 留档失败不影响出片 */ }
        // 先探每个源时长 → 算「每个源最多能切几段【不重叠】」(cap,起点间隔 ≥ segLen);再把 poolTarget
        //   按各源 cap【按比例】分配 → 长视频多切、短视频少切,起点在整段上均匀铺开,段间互不重叠。
        // ⚠️【2026-06-17 用户实测"画面重复"根因】旧 cap 用 0.6s 间隔 → 同一源能切出几十段【85% 重叠的近重复片】
        //   (是不同文件、used 去重抓不到,但画面几乎一样)→ 用户看到重复。改成间隔 ≥ segLen(段长)→ 段间【真不
        //   重叠】,每段是真正不同的画面;短视频自然少切(切不出那么多不同画面就认了,不靠近重复片凑数)。
        const srcs: { v: string; dur: number; cap: number }[] = [];
        for (const v of dy.paths) {
          if (signal?.aborted) break;
          const dur = await probeDuration(v).catch(() => 0);
          if (dur <= segLen + 0.3) continue; // 太短切不出一整段,跳过
          const cap = Math.max(1, Math.floor((dur - segLen) / segLen) + 1); // 间隔≥segLen 的【不重叠】段数
          srcs.push({ v, dur, cap });
        }
        if (srcs.length === 0) { tracker.progress(`   ⚠️ 源视频都太短,切不出片`); continue; }
        const totalCap = srcs.reduce((n, s) => n + s.cap, 0);
        const targetSegs = Math.min(poolTarget, totalCap); // 只有总容量 < 目标时才少切(真不够);绝不靠复用补齐
        // 派每源段数:抖音搜索按相关度排序,【第 1 个源最贴近热点】→ 给它约 35%(用户要求:第一个多给点),
        //   其余 ~65% 在后面的源里平均分。两头都受各源 cap 限制(短视频切不出那么多就认了),凑不满的从前
        //   往后轮转补。历史教训:纯 rankW 前倾会堆成 17/4/1…(太偏);纯平均又把最相关的摊薄(太平)→ 取中。
        const nSrc = srcs.length;
        const firstQuota = Math.min(srcs[0].cap, Math.max(1, Math.round(targetSegs * 0.35)));
        const restTarget = Math.max(0, targetSegs - firstQuota);
        const restN = nSrc - 1;
        const restBase = restN > 0 ? Math.floor(restTarget / restN) : 0;
        const restRem = restN > 0 ? restTarget - restBase * restN : 0;
        const quota = srcs.map((s, i) => (i === 0)
          ? Math.min(s.cap, firstQuota)
          : Math.min(s.cap, restBase + ((i - 1) < restRem ? 1 : 0)));
        let qsum = quota.reduce((a, b) => a + b, 0);
        for (let guard = 0; guard < 2000 && qsum < targetSegs; guard++) {
          let added = false;
          for (let i = 0; i < nSrc && qsum < targetSegs; i++) if (quota[i] < srcs[i].cap) { quota[i]++; qsum++; added = true; }
          if (!added) break; // 所有源都到 cap 了,凑不满也只能这样
        }
        // 切片是逐段 ffmpeg 重编码(慢,几十秒~分钟级),逐个源报进度,别让用户对着空白卡很久。
        tracker.progress(`✂️ 下载完成,开始切片(${srcs.length} 个源 → 目标 ${targetSegs} 段、起点均匀错开不重复)…`);
        const segs: string[] = [];
        for (let vi = 0; vi < srcs.length; vi++) {
          if (signal?.aborted) break;
          const { v, dur } = srcs[vi];
          const n = quota[vi];
          const step = n > 1 ? (dur - segLen) / (n - 1) : 0; // 起点铺满 [0, dur-segLen],n 段互不重叠
          tracker.progress(`✂️ 切片中:第 ${vi + 1}/${srcs.length} 个源 → 切 ${n} 段(累计 ${segs.length}/${targetSegs} 段)…`);
          for (let k = 0; k < n; k++) {
            if (signal?.aborted) break;
            const ss = Math.max(0, k * step);
            const out = path.join(assetDir, `seg_${String(si).padStart(3, '0')}.mp4`);
            const r = await runFfmpeg(
              ['-y', '-ss', ss.toFixed(2), '-i', v, '-t', String(segLen), '-an',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', out],
              { timeoutMs: 120_000 },
            );
            if (r.ok && fs.existsSync(out)) { segs.push(out); si++; }
          }
        }
        if (segs.length) poolByTerm.set(term, segs);
      }
      if (poolByTerm.size === 0) return null;
      const allSegs = Array.from(poolByTerm.values()).flat();
      hotspotImageCount = allSegs.length; // 仅诊断用(后端 hotspot 已改【按条】计费,不再读 imageCount)
      if (allSegs.length < totalDemand) {
        tracker.progress(`⚠️ 抖音源有限,仅切出 ${allSegs.length} 段(本条需 ${totalDemand} 段)→ 个别镜可能复用,已尽量多切不同片`);
      }
      tracker.progress(`✂️ 抖音素材就绪:${allSegs.length} 片段(按热搜标题搜 · 切片铺镜不重复)`);
      // 4) assign:每镜先本镜词、不够借全局、used 去重;每条 videoIdx 打乱错开
      const assign = (videoIdx: number): string[][] => {
        const used = new Set<string>();
        const shuffle = videoIdx > 0;
        const byTerm = new Map<string, string[]>();
        for (const [k, v] of poolByTerm) byTerm.set(k, shuffle ? shuffled(v) : [...v]);
        const all = shuffle ? shuffled(allSegs) : [...allSegs];
        const take = (i: number): string => {
          for (const term of perSceneTerms[i] || []) {
            const q = byTerm.get(term);
            if (q) { const v = q.find((p) => !used.has(p)); if (v) { used.add(v); return v; } }
          }
          const any = all.find((p) => !used.has(p));
          if (any) { used.add(any); return any; }
          return all[used.size % Math.max(1, all.length)]; // 全用过 → 循环兜底
        };
        return sentences.map((_, i) => {
          const dur = Math.max(1.2, sceneDurations[i]);
          const want = Math.max(1, Math.min(4, Math.ceil(dur / maxClip)));
          const clips: string[] = [];
          for (let k = 0; k < want; k++) clips.push(take(i));
          return clips;
        });
      };
      return { assign, imageByScene: new Map() };
    }

    /**
     * 抖音图文配图池:【只按热搜标题搜】(用户要求,同 buildDouyinPool 不 AI 拆词)→ 搜抖音图文笔记的图 →
     *   imageBySceneFor 每镜取一图、used 去重。取不到 → null,上层落文字卡。
     */
    async function buildDouyinImagePool(): Promise<{ imageBySceneFor: (videoIdx: number) => Map<number, string>; imagePool: string[] } | null> {
      // 【只按热搜标题搜】(用户要求):同 buildDouyinPool,图文配图也永远只用热搜原标题,不 AI 拆词偏移。
      const title = (hotspotTopic?.title || '').trim();
      if (!title) return null;
      const searchTerms = [title];
      const perSceneTerms = sentences.map(() => [title]);
      tracker.progress(`🖼️ 抖音图文取材:只按热搜标题搜「${title}」`);
      // 每镜一图,一次性多取:【保证 ≥ 分镜数】+ 缓冲,夹 [10,40](原上限 24 太低 → 长稿不够铺会复用)。
      const wantImgs = Math.max(10, Math.min(40, sentences.length + 6));
      const poolByTerm = new Map<string, string[]>();
      for (const term of searchTerms) {
        if (signal?.aborted) break;
        let dy: { paths: string[]; titles: string[] };
        if (douyinPrefetch && douyinPrefetch.mode === 'image') {
          // 写稿前已经搜过抖音图文了:直接复用(【空也复用】→ 不重复搜、不重复等登录;空则上层落文字卡)。
          if (douyinPrefetch.paths.length > 0) tracker.progress(`   ♻️ 复用写稿前已下好的 ${douyinPrefetch.paths.length} 张抖音图(不重复下载)`);
          dy = { paths: douyinPrefetch.paths, titles: douyinPrefetch.titles };
        } else {
          dy = await fetchDouyinClips([term], wantImgs, assetDir, (m) => tracker.progress(`   ${m}`), signal, 'image', (input as any).hotspotMaterialAccountId);
        }
        if (dy.paths.length) {
          poolByTerm.set(term, dy.paths);
          // 下载的图文图留档到输出目录「素材」子目录(assetDir 临时目录结尾会清,不留档就丢了)。
          try {
            const matDir = path.join(destDir, '素材');
            fs.mkdirSync(matDir, { recursive: true });
            dy.paths.forEach((src, i) => {
              try { fs.copyFileSync(src, path.join(matDir, `配图${String(i + 1).padStart(2, '0')}_${path.basename(src)}`)); } catch { /* 单个失败忽略 */ }
            });
          } catch { /* 留档失败不影响出片 */ }
        } else tracker.progress(`   ⚠️「${term}」没取到图文图`);
      }
      if (poolByTerm.size === 0) return null;
      const allImgs = Array.from(poolByTerm.values()).flat();
      hotspotImageCount = allImgs.length; // 计费按图片数(沿用 hotspot 口径)
      tracker.progress(`🖼️ 抖音图文就绪:${allImgs.length} 图(按热搜标题搜 · 图片缓慢运镜)`);
      // 每镜一图:先本镜词、不够借全局、used 去重;每条 videoIdx 打乱错开。
      const imageBySceneFor = (videoIdx: number): Map<number, string> => {
        const used = new Set<string>();
        const shuffle = videoIdx > 0;
        const byTerm = new Map<string, string[]>();
        for (const [k, v] of poolByTerm) byTerm.set(k, shuffle ? shuffled(v) : [...v]);
        const all = shuffle ? shuffled(allImgs) : [...allImgs];
        const m = new Map<number, string>();
        sentences.forEach((_, i) => {
          let pick: string | undefined;
          for (const term of perSceneTerms[i] || []) {
            const q = byTerm.get(term);
            if (q) { const v = q.find((p) => !used.has(p)); if (v) { pick = v; break; } }
          }
          if (!pick) pick = all.find((p) => !used.has(p));
          if (!pick) pick = all[i % Math.max(1, all.length)]; // 全用过 → 循环兜底
          used.add(pick); m.set(i, pick);
        });
        return m;
      };
      return { imageBySceneFor, imagePool: allImgs };
    }

    /**
     * TikTok 视频池(英文/小语种话题,对称抖音 buildDouyinPool):【只按热搜标题搜】→ 搜 TikTok/下无水印
     *   视频/切片成片段池 → assign 每镜从池里取、used 去重。取不到 → null,上层落 TikTok 图集/文字卡。
     *   切片/铺镜逻辑与 buildDouyinPool 完全一致(平台无关,只换 fetchTiktokClips + 文案)。
     */
    async function buildTiktokPool(): Promise<{ assign: (videoIdx: number) => string[][]; imageByScene: Map<number, string> } | null> {
      const title = (hotspotTopic?.title || '').trim();
      if (!title) return null;
      const searchTerms = [title];
      const perSceneTerms = sentences.map(() => [title]); // 每镜共用标题词,take 走全局池 + used 去重
      const segLen = Math.max(2, maxClip);
      const wantOfScene = (i: number) => Math.max(1, Math.min(4, Math.ceil(Math.max(1.2, sceneDurations[i]) / maxClip)));
      const totalDemand = sentences.reduce((s, _s, i) => s + wantOfScene(i), 0);
      const poolTarget = Math.min(80, Math.ceil(totalDemand * 1.3) + 2);
      const wantClips = Math.max(6, Math.min(20, Math.ceil(poolTarget / 4) + 1));
      tracker.progress(`🎬 TikTok 取材:只按热搜标题搜「${title}」(本条需 ${totalDemand} 段 → 目标切 ${poolTarget} 段、下 ${wantClips} 个源)`);
      const poolByTerm = new Map<string, string[]>();
      let si = 0;
      for (const term of searchTerms) {
        if (signal?.aborted) break;
        let tk: { paths: string[]; titles: string[] };
        if (tiktokPrefetch && tiktokPrefetch.mode === 'video') {
          // 写稿前已经搜过 TikTok 视频了:直接复用(【空也复用】→ 不重复搜、不重复等登录;空则上层落文字卡)。
          if (tiktokPrefetch.paths.length > 0) tracker.progress(`   ♻️ 复用写稿前已下好的 ${tiktokPrefetch.paths.length} 个 TikTok 视频(不重复下载)`);
          tk = { paths: tiktokPrefetch.paths, titles: tiktokPrefetch.titles };
        } else {
          tk = await fetchTiktokClips([term], wantClips, assetDir, (m) => tracker.progress(`   ${m}`), signal, 'video', (input as any).hotspotMaterialAccountId);
        }
        if (tk.paths.length === 0) { tracker.progress(`   ⚠️「${term}」没取到视频`); continue; }
        try {
          const matDir = path.join(destDir, '素材');
          fs.mkdirSync(matDir, { recursive: true });
          tk.paths.forEach((src, i) => {
            try { fs.copyFileSync(src, path.join(matDir, `素材${String(i + 1).padStart(2, '0')}_${path.basename(src)}`)); } catch { /* 单个失败忽略 */ }
          });
        } catch { /* 留档失败不影响出片 */ }
        const srcs: { v: string; dur: number; cap: number }[] = [];
        for (const v of tk.paths) {
          if (signal?.aborted) break;
          const dur = await probeDuration(v).catch(() => 0);
          if (dur <= segLen + 0.3) continue;
          const cap = Math.max(1, Math.floor((dur - segLen) / 0.6) + 1);
          srcs.push({ v, dur, cap });
        }
        if (srcs.length === 0) { tracker.progress(`   ⚠️ 源视频都太短,切不出片`); continue; }
        const totalCap = srcs.reduce((n, s) => n + s.cap, 0);
        const targetSegs = Math.min(poolTarget, totalCap);
        // 第 1 个源最贴近 → 给约 35%,其余 ~65% 在后面的源里平均分(同上,受各源 cap 限制 + 轮转补)。
        const nSrc = srcs.length;
        const firstQuota = Math.min(srcs[0].cap, Math.max(1, Math.round(targetSegs * 0.35)));
        const restTarget = Math.max(0, targetSegs - firstQuota);
        const restN = nSrc - 1;
        const restBase = restN > 0 ? Math.floor(restTarget / restN) : 0;
        const restRem = restN > 0 ? restTarget - restBase * restN : 0;
        const quota = srcs.map((s, i) => (i === 0)
          ? Math.min(s.cap, firstQuota)
          : Math.min(s.cap, restBase + ((i - 1) < restRem ? 1 : 0)));
        let qsum = quota.reduce((a, b) => a + b, 0);
        for (let guard = 0; guard < 2000 && qsum < targetSegs; guard++) {
          let added = false;
          for (let i = 0; i < nSrc && qsum < targetSegs; i++) if (quota[i] < srcs[i].cap) { quota[i]++; qsum++; added = true; }
          if (!added) break;
        }
        tracker.progress(`✂️ 下载完成,开始切片(${srcs.length} 个源 → 目标 ${targetSegs} 段、起点均匀错开不重复)…`);
        const segs: string[] = [];
        for (let vi = 0; vi < srcs.length; vi++) {
          if (signal?.aborted) break;
          const { v, dur } = srcs[vi];
          const n = quota[vi];
          const step = n > 1 ? (dur - segLen) / (n - 1) : 0;
          tracker.progress(`✂️ 切片中:第 ${vi + 1}/${srcs.length} 个源 → 切 ${n} 段(累计 ${segs.length}/${targetSegs} 段)…`);
          for (let k = 0; k < n; k++) {
            if (signal?.aborted) break;
            const ss = Math.max(0, k * step);
            const out = path.join(assetDir, `seg_${String(si).padStart(3, '0')}.mp4`);
            const r = await runFfmpeg(
              ['-y', '-ss', ss.toFixed(2), '-i', v, '-t', String(segLen), '-an',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', out],
              { timeoutMs: 120_000 },
            );
            if (r.ok && fs.existsSync(out)) { segs.push(out); si++; }
          }
        }
        if (segs.length) poolByTerm.set(term, segs);
      }
      if (poolByTerm.size === 0) return null;
      const allSegs = Array.from(poolByTerm.values()).flat();
      hotspotImageCount = allSegs.length; // 仅诊断用(后端 hotspot 已改【按条】计费)
      if (allSegs.length < totalDemand) {
        tracker.progress(`⚠️ TikTok 源有限,仅切出 ${allSegs.length} 段(本条需 ${totalDemand} 段)→ 个别镜可能复用,已尽量多切不同片`);
      }
      tracker.progress(`✂️ TikTok 素材就绪:${allSegs.length} 片段(按热搜标题搜 · 切片铺镜不重复)`);
      const assign = (videoIdx: number): string[][] => {
        const used = new Set<string>();
        const shuffle = videoIdx > 0;
        const byTerm = new Map<string, string[]>();
        for (const [k, v] of poolByTerm) byTerm.set(k, shuffle ? shuffled(v) : [...v]);
        const all = shuffle ? shuffled(allSegs) : [...allSegs];
        const take = (i: number): string => {
          for (const term of perSceneTerms[i] || []) {
            const q = byTerm.get(term);
            if (q) { const v = q.find((p) => !used.has(p)); if (v) { used.add(v); return v; } }
          }
          const any = all.find((p) => !used.has(p));
          if (any) { used.add(any); return any; }
          return all[used.size % Math.max(1, all.length)];
        };
        return sentences.map((_, i) => {
          const dur = Math.max(1.2, sceneDurations[i]);
          const want = Math.max(1, Math.min(4, Math.ceil(dur / maxClip)));
          const clips: string[] = [];
          for (let k = 0; k < want; k++) clips.push(take(i));
          return clips;
        });
      };
      return { assign, imageByScene: new Map() };
    }

    /**
     * TikTok 图集池(英文/小语种话题,对称抖音 buildDouyinImagePool):【只按热搜标题搜】→ 搜 TikTok 图集帖
     *   的图 → imageBySceneFor 每镜取一图、used 去重。取不到 → null,上层落文字卡。
     */
    async function buildTiktokImagePool(): Promise<{ imageBySceneFor: (videoIdx: number) => Map<number, string>; imagePool: string[] } | null> {
      const title = (hotspotTopic?.title || '').trim();
      if (!title) return null;
      const searchTerms = [title];
      const perSceneTerms = sentences.map(() => [title]);
      tracker.progress(`🖼️ TikTok 图集取材:只按热搜标题搜「${title}」`);
      const wantImgs = Math.max(10, Math.min(40, sentences.length + 6));
      const poolByTerm = new Map<string, string[]>();
      for (const term of searchTerms) {
        if (signal?.aborted) break;
        let tk: { paths: string[]; titles: string[] };
        if (tiktokPrefetch && tiktokPrefetch.mode === 'image') {
          // 写稿前已经搜过 TikTok 图集了:直接复用(【空也复用】→ 不重复搜、不重复等登录;空则上层落文字卡)。
          if (tiktokPrefetch.paths.length > 0) tracker.progress(`   ♻️ 复用写稿前已下好的 ${tiktokPrefetch.paths.length} 张 TikTok 图(不重复下载)`);
          tk = { paths: tiktokPrefetch.paths, titles: tiktokPrefetch.titles };
        } else {
          tk = await fetchTiktokClips([term], wantImgs, assetDir, (m) => tracker.progress(`   ${m}`), signal, 'image', (input as any).hotspotMaterialAccountId);
        }
        if (tk.paths.length) {
          poolByTerm.set(term, tk.paths);
          try {
            const matDir = path.join(destDir, '素材');
            fs.mkdirSync(matDir, { recursive: true });
            tk.paths.forEach((src, i) => {
              try { fs.copyFileSync(src, path.join(matDir, `配图${String(i + 1).padStart(2, '0')}_${path.basename(src)}`)); } catch { /* 单个失败忽略 */ }
            });
          } catch { /* 留档失败不影响出片 */ }
        } else tracker.progress(`   ⚠️「${term}」没取到图集图`);
      }
      if (poolByTerm.size === 0) return null;
      const allImgs = Array.from(poolByTerm.values()).flat();
      hotspotImageCount = allImgs.length; // 计费按图片数(沿用 hotspot 口径)
      tracker.progress(`🖼️ TikTok 图集就绪:${allImgs.length} 图(按热搜标题搜 · 图片缓慢运镜)`);
      const imageBySceneFor = (videoIdx: number): Map<number, string> => {
        const used = new Set<string>();
        const shuffle = videoIdx > 0;
        const byTerm = new Map<string, string[]>();
        for (const [k, v] of poolByTerm) byTerm.set(k, shuffle ? shuffled(v) : [...v]);
        const all = shuffle ? shuffled(allImgs) : [...allImgs];
        const m = new Map<number, string>();
        sentences.forEach((_, i) => {
          let pick: string | undefined;
          for (const term of perSceneTerms[i] || []) {
            const q = byTerm.get(term);
            if (q) { const v = q.find((p) => !used.has(p)); if (v) { pick = v; break; } }
          }
          if (!pick) pick = all.find((p) => !used.has(p));
          if (!pick) pick = all[i % Math.max(1, all.length)];
          used.add(pick); m.set(i, pick);
        });
        return m;
      };
      return { imageBySceneFor, imagePool: allImgs };
    }

    /**
     * 混剪取材:【只按热搜标题】搜视频、下到任务素材目录(最多 5 个,靠切片填满时长),留档一份到
     * 「素材」子目录(文件名不带平台名)。返回本地路径(空 = 没登录/没源,上层落回图片配图)。
     */
    async function collectDouyinClips(): Promise<string[]> {
      const title = hotspotTopic?.title || '';
      const keywords = title ? [title] : []; // 永远只按热搜标题查,不额外出关键词(用户要求)
      const wantClips = Math.max(2, Math.min(5, Math.ceil((input.targetSeconds ?? 60) / 15))); // 最多 5 个,靠切片填时长
      tracker.progress(`🎬 混剪取材:按标题搜视频(最多 ${wantClips} 个,切片填满时长)…`);
      const dy = await fetchDouyinClips(keywords, wantClips, assetDir, (m) => tracker.progress(m), signal, 'video', (input as any).hotspotMaterialAccountId);
      if (dy.paths.length === 0) {
        tracker.progress(`⚠️ 没取到混剪素材(${dy.diag.reason || '未知'}),退回图片配图`);
        return [];
      }
      try {
        const matDir = path.join(destDir, '素材');
        fs.mkdirSync(matDir, { recursive: true });
        dy.paths.forEach((src, i) => {
          try { fs.copyFileSync(src, path.join(matDir, `素材${String(i + 1).padStart(2, '0')}_${path.basename(src)}`)); } catch { /* 单个失败忽略 */ }
        });
      } catch { /* 留档失败不影响出片 */ }

      // 切【片段池】:每个视频按 maxClip 切成多段 → 后面打乱铺镜。去重关键 —— 否则同一个长视频被多镜
      //   复用时每次都从开头截,画面反复重复。视频少(≤5)就靠每个多切几段填满时长。
      tracker.progress('✂️ 切分素材为片段池…');
      const segLen = Math.max(2, maxClip);
      // 按【本条总需求片段数】把池子切够 + 冗余,让后面铺镜【绝不重复】(用户要求:素材不反复用,大不了多切)。
      //   want 口径必须跟 assignVisuals 一致;各视频均摊目标段数,段在视频内【均匀铺】(起点各不同)。
      const wantOf = (i: number) => Math.max(1, Math.min(4, Math.ceil(Math.max(1.2, sceneDurations[i]) / maxClip)));
      const totalWant = sentences.reduce((s, _, i) => s + wantOf(i), 0);
      const perVideoTarget = Math.max(1, Math.ceil((totalWant + 2) / Math.max(1, dy.paths.length))); // 均摊 + 2 冗余
      const segs: string[] = [];
      let si = 0;
      for (const v of dy.paths) {
        if (signal?.aborted) break;
        const dur = await probeDuration(v).catch(() => 0);
        if (dur <= 0) continue;
        // 物理上限:相邻段起点至少错开 ~1s(再密就是近重复帧,无意义)。在此上限内尽量切够 perVideoTarget。
        const maxSegs = Math.max(1, Math.floor((dur - segLen) / 1.0) + 1);
        const n = Math.max(1, Math.min(maxSegs, perVideoTarget));
        const step = n > 1 ? (dur - segLen) / (n - 1) : 0; // 均匀铺满整段视频,每段起点都不同
        for (let k = 0; k < n; k++) {
          const ss = Math.max(0, k * step);
          const out = path.join(assetDir, `seg_${String(si).padStart(3, '0')}.mp4`);
          const r = await runFfmpeg(
            ['-y', '-ss', ss.toFixed(2), '-i', v, '-t', String(segLen), '-an',
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', out],
            { timeoutMs: 120_000 },
          );
          if (r.ok && fs.existsSync(out)) { segs.push(out); si++; }
        }
      }
      if (segs.length > 0) {
        tracker.progress(`✂️ 切出 ${segs.length} 个片段(打乱铺镜去重)`);
        return segs;
      }
      return dy.paths; // 切失败兜底:用原视频(可能有重复,但有画面)
    }

    /**
     * 图文配图(中文话题的「智能配图」走这条):【只按热搜标题】搜图文笔记、下图到任务素材目录
     * (文件名不带平台名)。返回本地图片路径(空 = 没登录/没图文 → 上层落回 Serper 谷歌图)。
     */
    async function collectDouyinImages(): Promise<string[]> {
      const title = hotspotTopic?.title || '';
      const keywords = title ? [title] : []; // 永远只按热搜标题查,不额外出关键词(用户要求)
      const want = Math.max(8, Math.min(40, Math.ceil((input.targetSeconds ?? 60) / 4) + 2));
      tracker.progress(`🖼️ 图文配图:按标题搜图文笔记、下图(目标 ${want} 张)…`);
      const dy = await fetchDouyinClips(keywords, want, assetDir, (m) => tracker.progress(m), signal, 'image', (input as any).hotspotMaterialAccountId);
      if (dy.paths.length === 0) {
        tracker.progress(`⚠️ 没取到图文配图(${dy.diag.reason || '未知'}),退回联网配图`);
        return [];
      }
      try {
        const matDir = path.join(destDir, '素材');
        fs.mkdirSync(matDir, { recursive: true });
        dy.paths.forEach((src, i) => {
          try { fs.copyFileSync(src, path.join(matDir, `配图${String(i + 1).padStart(2, '0')}_${path.basename(src)}`)); } catch { /* 单个失败忽略 */ }
        });
      } catch { /* 留档失败不影响出片 */ }
      return dy.paths;
    }

    // 4. 组装分镜 + 合成。批量出片时并发跑 videoCount 条(封顶 2 条同时跑):同脚本/配音、每条不同画面组合。
    //    费用(平台费向上限靠拢 + AI 按条数叠加)开跑前【一次性】整笔预扣,全部失败才整笔退回。
    throwIfAborted(signal);
    tracker.start('compose');

    const { width, height } = aspectToSize(input.aspect);
    // 纯画面模式(无旁白)→ 无旁白文本时间轴,强制关字幕。
    const subtitleEnabled = wantNarration && input.subtitleEnabled !== false;
    const subtitle: SubtitleStyle = {
      enabled: subtitleEnabled,
      fontSize: input.subtitleFontSize && input.subtitleFontSize > 0 ? input.subtitleFontSize : 52,
      position: input.subtitlePosition || (hotspotDouyinMode ? 'lower' : 'bottom'),
      color: input.subtitleColor,
      strokeColor: input.subtitleStrokeColor,
      fontFile: input.subtitleFont,
    };

    // BGM 解析(全条共用,只解析一次):builtin:<id> → 随包路径;remote:<url> → 按需下载
    // 并缓存(命中缓存不重下);用户上传的绝对路径原样返回。再统一过 existsSync 兜底
    // (取不到 = 不加 BGM,不挡出片)。
    const resolvedBgm = await resolveBgmPath(input.bgmPath, (m) => tracker.progress(m));
    const bgmPath = resolvedBgm && fs.existsSync(resolvedBgm) ? resolvedBgm : undefined;
    if (input.bgmPath && !bgmPath) tracker.progress('⚠️ 背景音乐获取失败，本条将不加 BGM');
    if (subtitleEnabled) {
      tracker.progress(subtitleCues.length > 0
        ? `字幕时间轴就绪(edge-tts 词边界,共 ${subtitleCues.length} 段)`
        : '字幕按各镜时长估算(未取到词边界时间轴)');
    }

    // 费用预扣:开跑前【一次性】整笔预扣(在线模式),金额由服务端按 videoCount + aiCostUsd 算
    // (平台费向上限靠拢 + AI 费按条数叠加)。全部条目都失败时才在 finally 按 chargeId 整笔退回(幂等)。
    if (isMode1) {
      // 热搜成片按【实下图片数】计费(云端代下则 ×2,均由服务端算);其它在线模式按条数+AI 费。
      const charge = input.engine === 'hotspot'
        ? await chargeHotspotImages(hotspotImageCount, hotspotUsedCloud)
        : await chargeMode1Video(input.targetSeconds ?? 45, { videoCount, aiCostUsd });
      if (!charge.ok) {
        let err: string;
        if (charge.reason === 'insufficient') err = '余额不足,无法生成(模式一需先预扣平台基础费,请充值后重试)';
        else if (charge.reason === 'no_auth') err = '未登录 NoobClaw,无法生成';
        else err = '平台基础费预扣失败,请稍后重试';
        tracker.fail('compose', err);
        return { ok: false, error: err };
      }
      chargeId = charge.chargeId;
      refundOnExit = true;
      tracker.addTokens(charge.chargedTokens || 0, charge.feeUsd || 0);
      tracker.progress(videoCount > 1
        ? `💎 已预扣 ${charge.chargedTokens || 0} 积分（≈$${(charge.feeUsd || 0).toFixed(2)}，准备生成 ${videoCount} 条视频），失败将自动退回`
        : `💎 平台基础费已预扣 ${charge.chargedTokens || 0} 积分（≈$${(charge.feeUsd || 0).toFixed(2)}），失败将自动退回`);
    }

    // 单条合成:组装本条画面组合(第 0 条原序、之后打乱)→ composeVideo,成功返回成片路径,失败抛错。
    const composeOne = async (v: number): Promise<string> => {
      const label = videoCount > 1 ? `第 ${v + 1}/${videoCount} 条` : '';
      const { sceneClips, imagePool, imageByScene } = assignVisuals(v);
      let imgCursor = 0;
      const scenes: SceneSpec[] = sentences.map((sentence, i) => {
        const clips = sceneClips[i];
        const hasVideo = clips.length > 0;
        // D:无视频的镜优先用「按本镜内容搜来的图」(imageByScene);没有再退扁平池轮转。
        const image = hasVideo ? undefined
          : (imageByScene?.get(i)
            ?? (imagePool.length > 0 ? imagePool[imgCursor++ % imagePool.length] : undefined));
        return {
          clips: hasVideo ? clips : undefined,
          imagePath: image,
          audioPath: wantNarration ? audios[i].audioPath : undefined,
          durationSec: sceneDurations[i],
          subtitle: sentence,
          // 热搜成片:字幕模糊带统一开 —— 视频镜顺带盖原烧死字幕,图片镜纯做字幕底带,
          //   两种模式观感一致(用户要求统一)。文字卡(无视频无图)走纯色卡,compose 自动不应用。
          maskBottomBar: input.engine === 'hotspot',
        };
      });
      const outPath = path.join(destDir, outputFileName(v));
      await composeVideo({
        scenes,
        outputPath: outPath,
        width,
        height,
        maxClipSeconds: maxClip,
        subtitle,
        narration: wantNarration,
        bgmPath,
        bgmVolume: input.bgmVolume !== undefined && input.bgmVolume >= 0 ? input.bgmVolume : undefined,
        // edge-tts 词边界出的精确 cue;为空时 compose 内部退回按各镜时长估算。
        cues: subtitleEnabled && subtitleCues.length > 0 ? subtitleCues : undefined,
        onScene: (done, total) => tracker.progress(`${label ? label + ' · ' : ''}合成分镜 ${done}/${total}`),
      });
      if (videoCount > 1) tracker.progress(`✅ ${label} 合成完成`);
      return outPath;
    };

    // 并发出片但【封顶 2 条同时合成】:ffmpeg 是重 CPU/内存活,5 条全开会互相抢资源、
    // 反而整体更慢甚至 OOM。顺序保留 + allSettled 语义(个别失败不拖累其余):用固定
    // 2 个 worker 轮流领下一条,结果按下标回填,与原 Promise.allSettled 收集行为一致。
    const runWithLimit = async <T,>(
      count: number,
      limit: number,
      task: (i: number) => Promise<T>,
    ): Promise<PromiseSettledResult<T>[]> => {
      const results = new Array<PromiseSettledResult<T>>(count);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < count) {
          const i = next++;
          try {
            results[i] = { status: 'fulfilled', value: await task(i) };
          } catch (e) {
            results[i] = { status: 'rejected', reason: e };
          }
        }
      };
      const n = Math.max(1, Math.min(limit, count));
      await Promise.all(Array.from({ length: n }, () => worker()));
      return results;
    };

    // 跑全部条目(并发封顶 2),收集成功的成片路径。
    const settled = await runWithLimit(videoCount, 2, (v) => composeOne(v));
    const outputPaths: string[] = [];
    let failCount = 0;
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        outputPaths.push(r.value);
      } else {
        failCount++;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        tracker.progress(`⚠️ 有一条合成失败:${msg.slice(0, 160)}`);
      }
    }

    if (outputPaths.length === 0) {
      // 全部失败:保持 refundOnExit=true,finally 整笔退回预扣的费用(平台 + AI 叠加份)。
      const err = '所有视频合成失败,未生成任何成片';
      tracker.fail('compose', err);
      return { ok: false, error: err };
    }

    // 至少一条成功 → 整笔费用照收(已按 videoCount 预扣),不退回。
    refundOnExit = false;
    // 结尾把【本次实际写片的目录】打出来,方便用户直接点过去(destDir = 任务/日期/批次号)。
    tracker.progress(videoCount > 1 && failCount > 0
      ? `🎉 已生成 ${outputPaths.length}/${videoCount} 条（${failCount} 条失败,费用已按 ${videoCount} 条预扣） · 📂 输出目录:${destDir}`
      : `🎉 已生成 ${outputPaths.length} 条 · 📂 输出目录:${destDir}`);

    // 合成步收尾:标 compose=done(否则它一直 running,发布阶段的日志会被渲染端按「第一个 running 步」
    //   归到合成步里 —— 用户实测发布日志出现在「4.合成视频」就是这个原因)。
    tracker.done('compose');

    // ── Step 5: 发布到各大平台(用户硬约束:未登录跳过、不杀任务) ─────────────
    // 本地 mp4 已经在 outputPaths[0],可以放心调 publish step。哪怕全平台都失败,
    // 用户还有本地文件,任务终态仍是 done(本地任务核心交付物是 mp4)。
    // videoCount>1 时只取首条发(避免重复发同样内容触发平台限流);后续条用户自己挑发。
    tracker.start('publish');
    const wantPublish = Array.isArray(input.publishPlatforms) && input.publishPlatforms.length > 0;
    try {
      // 平台发布文案:钩人标题 + 引导互动正文 + 话题标签(跟口播稿/视频标题是不同产物)。
      //   优先级:用户向导填的 > AI 生成的 > 兜底(标题首句 + keywords)。
      //   只在【确实有平台要发】时才调 AI(省钱);AI 失败自动降级到兜底。
      const cap = await resolvePublishCaption({
        wantPublish,
        // AI 模式 script 是局部 AI 重写稿;严格模式是 input.script。这里用最终的 script
        //   变量(已是 AI 重写后的),不再用 input.script —— 修「文不对题」的根因。
        summary: script || input.script || '',
        // 标题参考也用 AI 重写后的 script 首句(不用 input.script —— 否则 AI 降级时兜底标题又文不对题)。
        title: script ? script.split(/[。！？\n]/).filter(Boolean)[0]?.slice(0, 40) : undefined,
        // 有参考文案时不传赛道关键词(否则话题标签/正文跟着美食走、跟 spacex 口播打架);
        // 发布文案纯按上面 summary(=实际口播内容)生成,跟口播/画面保持一致。
        keywords: userText ? undefined : input.keywords,
        track: userText ? undefined : input.track,
        lang: contentLang,
        // 热搜成片:发布标题默认用热搜原标题(userTitle 优先、AI 不覆盖);正文/标签仍 AI 生成。
        //   ⚠️ 但热搜原标题是中文,当创作语言选了外语(「中文热点讲给海外看」出海玩法)时,再用
        //   中文标题就自相矛盾 → 只有创作语言是中文(zh/zh-TW,含 auto 检测到中文热点)时才用原标题;
        //   选了外语则不塞 userTitle,让 AI 按目标语言生成钩人标题。用户在向导自填 publishTitle 最优先。
        userTitle: input.publishTitle
          || (input.engine === 'hotspot' && (contentLang === 'zh' || contentLang === 'zh-TW')
            ? hotspotTopic?.title
            : undefined),
        userCaption: input.publishCaption,
        userTags: input.hashtags,
        onLog: (m: string) => tracker.progress(m),
        onCost: (tk, usd) => tracker.addTokens(tk, usd),
      });
      // 矩阵号 edition:发布走指纹内核 CDP(按平台→选定账号上传),不走扩展;
      //   非矩阵 / 内核不可用时仍走旧 runPublishStep(扩展)。
      const { MATRIX_EDITION } = require('../../matrixEdition');
      let pubResult: { publishedCount: number; skippedCount: number; failedCount: number; details: any[] };
      if (MATRIX_EDITION && wantPublish) {
        const { runMatrixPublishStep } = require('./publishers/runMatrixPublish');
        pubResult = await runMatrixPublishStep({
          platforms: Array.isArray(input.publishPlatforms) ? input.publishPlatforms : [],
          accounts: (input as any).publishAccounts || {},
          videoPath: outputPaths[0],
          title: cap.title,
          description: cap.description,
          tags: cap.tags,
          onLog: (msg: string) => tracker.progress(msg),
          signal,
        });
      } else {
        const { runPublishStep } = require('./publishers/runPublish');
        pubResult = await runPublishStep({
          platforms: Array.isArray(input.publishPlatforms) ? input.publishPlatforms : [],
          videoPath: outputPaths[0],
          title: cap.title,
          description: cap.description,
          tags: cap.tags,
          onLog: (msg: string) => tracker.progress(msg),
          signal,
        });
      }
      // 热搜成片:把该选题记为【已用】(下次选题排除)——只在【至少一个平台发布成功】、或【仅存本地已出片】
      //   时才记;发布全失败 → 不记 → 下次还能重试同一热点。(用户要求:有一个平台上传成功才记录。)
      if (input.engine === 'hotspot' && hotspotTopic?.id) {
        const published = !wantPublish || ((pubResult && pubResult.publishedCount) || 0) > 0;
        if (published) {
          markHotspotUsed(input.taskId || '', hotspotTopic.id);
          tracker.progress(`🗂️ 已记录该热点为「已用」,下次选题不再重复:「${hotspotTopic.title}」`);
        } else {
          tracker.progress('↩️ 本条未发布成功,该热点不记为已用,下次可重试');
        }
      }
    } catch (e) {
      // runPublishStep 自身就吞所有错,这层 catch 只是兜底(import 失败等极端情况)
      tracker.progress(`⚠️ 发布步骤异常:${String((e as Error)?.message || e).slice(0, 120)}`);
    }
    tracker.finish(outputPaths[0], outputPaths.length);
    return { ok: true, outputPath: outputPaths[0], outputPaths };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    tracker.fail('compose', err.slice(0, 300));
    return { ok: false, error: err.slice(0, 300) };
  } finally {
    // 成片失败 → 退回开跑前预扣的平台基础费(幂等,按 chargeId;退不掉只记日志不影响清理)。
    if (refundOnExit && chargeId) {
      try {
        const refunded = await refundMode1Video(chargeId);
        tracker.progress(refunded
          ? '↩️ 成片失败，已退回预扣的平台基础费'
          : '⚠️ 成片失败，平台基础费退回请求未成功（稍后可联系客服核对）');
      } catch { /* 退款失败仅忽略,不影响清理 */ }
    }
    // 清理临时素材(成片已落到 Documents)
    try { fs.rmSync(assetDir, { recursive: true, force: true }); } catch {}
  }
}
