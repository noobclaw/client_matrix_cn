/**
 * videoCreation service — 渲染端对 window.electron.video 的薄封装。
 *
 * 「多平台视频创作」功能的所有重活(拆句、TTS 配音、下载/裁剪素材、
 * Ken Burns 运镜、ffmpeg 合成)都在主进程做,本文件只暴露给 React 组件
 * 调用的异步方法 + 进度订阅。
 *
 * 一期(路线 A)只做本地出片:参考文案 → 配音 → 参考图/在线素材库画面 →
 * 字幕 → 合成 mp4 存本地。AI 仿写文案、Seedance 纯 AI 原创、自动上传到
 * 抖音/小红书/币安都是后续里程碑,这里先留接口。
 */

export type VideoAspect = '9:16' | '16:9' | '1:1';

export type VideoPublishTarget = 'local' | 'douyin' | 'xhs' | 'binance';

export type SubtitlePosition = 'top' | 'center' | 'lower' | 'bottom';

/** 模板速生版式(与主进程 templateHtmlWriter.TemplateStyle 对齐)。
 *  ai_freeform = 「AI 自由排版」:AI 写整页 HTML(走 freeformWriter + 体检迭代),不限固定版式。 */
export type VideoTemplateStyle = 'rank_list' | 'news_cards' | 'quote' | 'countdown' | 'stat_board' | 'ai_freeform';
/** 模板速生任务配置(IPC 传到主进程 template-pipeline;字段需与主进程 TemplateOptions 一致)。 */
export interface VideoTemplateOptions {
  style: VideoTemplateStyle;
  title?: string;
  dataText: string;
  durationSec?: number;
  fps?: number;
  brandColor?: string;
  accentColor?: string;
  // ── HF 派新增:可选配音 + 字幕(narration on 时生效)──
  /** 是否生成 AI 口播 + 字幕(默认 false=纯视觉)。 */
  narration?: boolean;
  /** edge-tts 音色(如 zh-CN-XiaoxiaoNeural),空 = 默认。 */
  voice?: string;
  /** 语速档(-50~+50,单位%),0/空 = 正常。 */
  voiceRate?: number;
  /** 用户自定义口播稿;空 = AI 按 dataText 生成。 */
  voiceScript?: string;
  /** 烧字幕开关(narration on 时才有意义)。默认 true。 */
  subtitleEnabled?: boolean;
  /** 右下角水印文案。空字符串 = 不显示;undefined = 默认 NoobClaw。 */
  watermark?: string;
  /** 「AI 自由排版」(ai_freeform)专用:用户对风格/重点的自由描述(如「赛博朋克风、突出第一名」)。
   *  直接拼进 freeformWriter 的 prompt;其它版式忽略。空 = AI 自行决定。 */
  brief?: string;
  /** 热榜数据源:用户选了某个热榜时存它的【榜名】(同 /api/web3/hot-search?sources= 参数)。
   *  非空 = 出片时主进程实时抓该榜前 N 条标题当内容(定时任务每次跑都是最新榜单);
   *  抓失败退回 dataText(向导选榜时存的快照)。空 = 用 dataText(粘贴模式)。 */
  hotlistSource?: string;
}

export interface VideoCreationInput {
  /** 人设 —— 影响 AI 文案口吻(一期文案靠粘贴,这里先收着备用)。 */
  persona: string;
  /** 赛道 / 细分领域。 */
  track: string;
  /** 关键词 —— 决定在线素材库搜什么空镜。 */
  keywords: string[];
  /** 视频文案。语义随 scriptMode 而变:strict=逐字朗读;ai=作 AI 写稿的参考。 */
  script: string;
  /**
   * 文案模式:
   *   - 'strict' 严格按我的视频文案:script 逐字朗读,直接决定视频长度(必填,≥200字)。
   *   - 'ai' AI 参考我的文案:AI 写稿,script 仅作参考(可空),长度按 targetSeconds。
   * 缺省兼容老任务:有 script → strict,无 → ai(主进程同款回退)。
   */
  scriptMode?: 'strict' | 'ai';
  /**
   * 画面引擎:'stock'(默认,AI 分镜 + 在线素材库) | 'ai'(Seedance AI 自动成片,
   * 逐镜生成视频片段,参考图统一风格,走服务端代理逐片段计费)。
   */
  engine?: 'stock' | 'ai' | 'template' | 'hotspot';
  /** engine==='template'(模板速生)专属配置;其它 engine 忽略。 */
  template?: VideoTemplateOptions;
  /** engine==='hotspot'(热搜成片)专属:用户勾选的热点源('hotsearch'|'web3'|'tech')。
   *  每次运行从这些源最新 20 条随机挑 1 条选题,服务端联网(Serper /news)取材 → 客户端写稿
   *  → Serper /images 配图 → 合成 → 发布。其它 engine 忽略此字段。 */
  hotspotSources?: string[];
  /** engine==='hotspot' 素材来源:'image'(默认,Serper 配图 Ken Burns)|
   *  'douyin'(按标题搜抖音、下无水印视频混剪 + 底部黑条盖原字幕 + 配音)。 */
  hotspotMaterialSource?: 'image' | 'douyin';
  /** 画面素材来源平台(矩阵号):'douyin' | 'tiktok' —— 用哪个平台做全网取材。 */
  hotspotMaterialPlatform?: 'douyin' | 'tiktok';
  /** 取材账号 id(矩阵号):用该账号的指纹内核做全网搜索 + 下载素材(不发帖)。 */
  hotspotMaterialAccountId?: string;
  /** AI 引擎分辨率档:'480p' | '720p'(默认) | '1080p'(越高越清越贵)。 */
  seedanceResolution?: '480p' | '720p' | '1080p';
  /** AI 引擎模型档位:'lite'(1.0 Lite) | 'pro'(1.0 Pro) | 'pro15'(1.5 Pro,默认) | 'v2'(2.0)。 */
  seedanceModel?: 'lite' | 'pro' | 'pro15' | 'v2';
  /** 用户上传的参考图本地绝对路径(AI 引擎用作风格/人设统一,≤2 张)。 */
  referenceImages: string[];
  /**
   * 用户上传的本地视频素材绝对路径(画面来源 = 本地上传 时用)。
   * 非空时直接用这些片段拼接成片,不再去在线素材库搜(也省 DeepSeek 搜索词)。
   */
  localVideos?: string[];
  /** 画幅,默认竖屏 9:16。 */
  aspect: VideoAspect;
  /** 老字段,已废弃,只为兼容老任务。实际发哪几个平台只看 publishPlatforms。改可选,新建不写。 */
  publishTarget?: VideoPublishTarget;
  /**
   * 出片完成后要发到哪几个平台(9 选 N):
   *   'douyin' | 'xhs' | 'tiktok' | 'binance' | 'x' | 'bilibili' | 'kuaishou' | 'shipinhao' | 'toutiao'
   * 空数组 / undefined = 仅存本地不发。pipeline iterator forEach 调对应 driver,未登录的会跳过。
   */
  publishPlatforms?: string[];
  /**
   * 矩阵号 edition 专用:每个发布平台选定的矩阵账号 id(平台→accountId)。
   * 发布时按此映射用对应账号的指纹内核 CDP 上传(runMatrixDriver),每平台最多 1 个号。
   * 非矩阵 edition 不写;矩阵 edition 走插件回退时也忽略。
   */
  publishAccounts?: Record<string, string>;
  /** 平台→账号【显示名】(矩阵号,保存时存一份),详情/记录页直接展示「上传到 抖音(账号1-涛涛)」,不必再查账号库。 */
  publishAccountNames?: Record<string, string>;
  /**
   * 平台发布文案(向导可选填,覆盖 AI 自动生成):钩人标题 + 引导互动正文 + 话题标签。
   * 跟口播稿 / 视频标题是不同产物。都留空 → 出片时 AI 自动生成;填了 → 用用户的。
   */
  publishTitle?: string;
  publishCaption?: string;
  hashtags?: string[];
  /** 可选背景音乐本地路径。空 = 不加 BGM。 */
  bgmPath?: string;
  /** BGM 音量(0~1),默认 0.18。 */
  bgmVolume?: number;
  /** 目标时长(秒),仅在自动生成文案时用于控制长度。默认 45。 */
  targetSeconds?: number;
  /** 是否优先用在线素材【视频】(否则只用图片)。默认 true。 */
  useStockVideo?: boolean;
  /** edge-tts 音色,空 = 用默认(zh-CN-XiaoxiaoNeural)。 */
  voice?: string;
  /** 语速档(-50~+50,单位%),0/空 = 正常语速。 */
  voiceRate?: number;
  /**
   * 是否生成口播旁白 + 字幕。默认 true。
   * 仅 pure_ai(Seedance)模式可设 false = 纯画面片:跳过 TTS、不烧字幕,
   * 镜头时长按分镜稿字数估算,音频只用 BGM(没选则静音)。
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
  /** 字幕描边颜色(#RRGGBB)。空 = 不描边(半透明黑底盒)。 */
  subtitleStrokeColor?: string;
  /** 字幕字体文件名(resources/fonts/ 下,如 SmileySans-Oblique.ttf)。空 = 默认思源黑体。 */
  subtitleFont?: string;
  /** 每段素材最长秒数(换镜节奏)。默认 4,越小换镜越快。 */
  maxClipSeconds?: number;
  /** 一次出片数量(1~5)。复用脚本/配音,每条不同画面组合。默认 1。 */
  videoCount?: number;
  /**
   * 热搜成片(engine==='hotspot')专属:每次运行出片条数的随机区间 [min,max](对齐币安
   * 发帖任务的「每次运行条数」)。每次定时/手动运行时主进程在 [min,max] 里随机取 N,
   * 外层循环跑 N 条【各自独立选题+写稿+按条计费】。缺省 / 未设 = 1 条。封顶 10。
   */
  videoCountMin?: number;
  videoCountMax?: number;
  /** v6.x: 所属视频任务 id —— 主进程据此把成片输出到「按任务」的文件夹
   *  (视频创作/<id前8位>_<任务名>),而非按日期的共享桶。 */
  taskId?: string;
  /** v6.x: 任务标题,派生输出文件夹名用(配合 taskId)。 */
  taskTitle?: string;
}

export interface VideoCreationProgressStep {
  key: string;
  label: string;
  status: 'waiting' | 'running' | 'done' | 'error';
}

export interface VideoCreationProgress {
  jobId: string;
  status: 'running' | 'done' | 'error';
  steps: VideoCreationProgressStep[];
  message?: string;
  /** 出片后的本地绝对路径。 */
  outputPath?: string;
  error?: string;
  /** 本次出片累计消耗的 DeepSeek token(写稿 + 搜索词);TTS/ffmpeg 免费不计。 */
  tokensUsed?: number;
  /** 本次出片累计 USD 成本(服务端权威 _noobclaw.costUsd 之和);老后端时为 0。 */
  costUsd?: number;
  /** 成片输出目录(开跑即确定,供详情页顶部展示)。 */
  outputDir?: string;
  /** 本次实际产出的成片条数(批量出片时>1,随终态 done 事件带回供计数)。 */
  videoCount?: number;
}

export interface VideoCreationResult {
  ok: boolean;
  outputPath?: string;
  error?: string;
  /** 本次实际产出的成片条数(批量出片时>1);缺省按 1 计。 */
  videoCount?: number;
}

type ProgressHandler = (p: VideoCreationProgress) => void;

class VideoCreationService {
  private get api(): any {
    return (window as any).electron?.video;
  }

  /** 主进程是否已挂上 video IPC(没挂时 UI 给出友好提示而不是崩)。 */
  get available(): boolean {
    return !!this.api;
  }

  /** 弹系统文件选择框选参考图,返回绝对路径数组(最多 max 张)。 */
  async pickReferenceImages(max = 3): Promise<string[]> {
    if (!this.api?.pickImages) return [];
    try {
      const paths = await this.api.pickImages(max);
      return Array.isArray(paths) ? paths.slice(0, max) : [];
    } catch {
      return [];
    }
  }

  /** 弹系统文件选择框选本地视频素材(可多选),返回绝对路径数组(最多 max 个)。 */
  async pickVideos(max = 8): Promise<string[]> {
    if (!this.api?.pickVideos) return [];
    try {
      const paths = await this.api.pickVideos(max);
      return Array.isArray(paths) ? paths.slice(0, max) : [];
    } catch {
      return [];
    }
  }

  /** 把本地图片读成 data: URL,给参考图缩略图预览用(渲染端 CSP 下加载不了 file://)。 */
  async readImageDataUrl(path: string): Promise<string> {
    if (!this.api?.readImageDataUrl) return '';
    try {
      const url = await this.api.readImageDataUrl(path);
      return typeof url === 'string' ? url : '';
    } catch {
      return '';
    }
  }

  /** 弹系统文件选择框选一首背景音乐,返回绝对路径('' = 取消)。 */
  async pickBgm(): Promise<string> {
    if (!this.api?.pickAudio) return '';
    try {
      const p = await this.api.pickAudio();
      return typeof p === 'string' ? p : '';
    } catch {
      return '';
    }
  }

  /**
   * 「打开文件夹」用:返回该 BGM 所在【目录】(主进程 resolveBgmFolder;不下载、不要求
   * 文件已存在)。内置→随包 bgm 目录;云端→缓存目录;上传→文件目录。返回 ''=失败/未挂。
   */
  async resolveBgmPath(token: string): Promise<string> {
    if (!this.api?.resolveBgmPath) return '';
    try {
      const p = await this.api.resolveBgmPath(token);
      return typeof p === 'string' ? p : '';
    } catch {
      return '';
    }
  }

  /** 用系统默认播放器打开成片。 */
  async openFile(path: string): Promise<void> {
    try {
      await this.api?.openFile?.(path);
    } catch {}
  }

  /**
   * 启动一次本地出片。onProgress 会在拆句/配音/素材/合成各阶段回调。
   * 返回最终结果(成功带 outputPath)。
   */
  async generate(
    input: VideoCreationInput,
    onProgress?: ProgressHandler,
  ): Promise<VideoCreationResult> {
    if (!this.api?.generate) {
      return { ok: false, error: '视频生成模块尚未就绪(主进程未挂载 video IPC)' };
    }

    // 主进程的 video:generate 现在是 fire-and-forget(立即返回 {status:'started'}),
    // 因为整条流水线跑几分钟,await 会撞上 HTTP requestTimeout(5min)→ ipc_error。
    // 所以这里不靠 IPC 返回值拿最终结果,而是订阅 video:progress SSE,在收到
    // status==='done'/'error' 的终态事件时 resolve。
    return new Promise<VideoCreationResult>((resolve) => {
      let settled = false;
      let unsub: (() => void) | undefined;
      const finish = (r: VideoCreationResult) => {
        if (settled) return;
        settled = true;
        if (unsub) { try { unsub(); } catch {} }
        resolve(r);
      };

      if (this.api.onProgress) {
        unsub = this.api.onProgress((p: VideoCreationProgress) => {
          onProgress?.(p);
          if (p.status === 'done') finish({ ok: true, outputPath: p.outputPath, videoCount: p.videoCount });
          else if (p.status === 'error') finish({ ok: false, error: p.error || '生成失败' });
        });
      }

      // 启动。新协议返回 {ok:true,status:'started'} = 已开跑,等 SSE 终态;
      // 若立即返回失败(模块没起来 / ipc_error)则直接 resolve 失败。
      Promise.resolve(this.api.generate(input))
        .then((res: any) => {
          if (res && res.status === 'started') return;          // 等 SSE
          if (res && res.ok === false) finish({ ok: false, error: res.error || 'ipc_error' });
          else if (res && res.ok && res.outputPath) finish({ ok: true, outputPath: res.outputPath });
          // 其余情况(无终态字段)继续等 SSE
        })
        .catch((e: any) => finish({ ok: false, error: String(e).slice(0, 200) }));
    });
  }

  /** 停止某个正在出片的任务:abort 主进程 pipeline + SIGKILL ffmpeg/seedance/tts 子进程。 */
  async stop(taskId: string): Promise<void> {
    try { await (this.api as { stop?: (id: string) => Promise<unknown> })?.stop?.(taskId); } catch {}
  }
}

export const videoCreationService = new VideoCreationService();
