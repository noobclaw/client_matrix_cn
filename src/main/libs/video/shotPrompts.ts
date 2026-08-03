/**
 * shotPrompts — 一镜两套 prompt:给【图像模型】的首帧描述,给【视频模型】的运动描述。
 *
 * ## 为什么要拆
 * 老链路只有一个 `buildSeedancePrompt()`,它的输出【同时】被喂给两个模型:
 *   · Seedream 出故事板首帧(seedanceProvider.generateStoryboard 的 shots 参数)
 *   · Seedance 出视频片段(SeedanceSceneSpec.prompt)
 * 于是图像模型收到的是 "运镜:镜头缓慢推近(全程只用这一种,平稳不抖)…避免画面抖动、
 * 肢体扭曲、时间闪烁" 这种【视频专属指令】—— 它完全不知道要画什么。而真正该给它的
 * 画面描述反而没传。这是首帧画错的根因,首帧错了 i2v 再稳也只是忠实地让一张错图动起来。
 *
 * ## 方法论来源
 * 抄 OpenMontage 的 seedance skill(`.agents/skills/seedance-2-0/SKILL.md`)里的
 * Higgsfield 方法论 —— 它把「prompt 开头先声明镜头结构」列为【单个最大的质量杠杆】:
 *   1. 开头先声明镜头结构/格式(景别 + 拍摄方式),再写创作内容
 *   2. 用具体摄影术语(35mm / film grain / halation / 浅景深),不用「电影感」这类空词
 *   3. 显式否定你不要的(no 3D / no cartoon / no cuts / no zoom)—— 模型在意图模糊时会乱来
 *   4. 运动描述带时间轴标记(0-3s / 3-6s)
 *   5. i2v 的 prompt 只写运动,不复述首帧已有的画面(否则主体漂移)
 *
 * ## 契约
 * · buildFramePrompt() 的输出【只】给图像模型,绝不含运镜/视频否定项。
 * · buildMotionPrompt() 的输出【只】给视频模型,绝不复述画面内容。
 * 两者共享同一份 styleLock(摄影术语),保证图和视频的调性一致。
 */

import type { StoryShot, ShotType } from './storyboardScript';
import { shotAllowsText } from './storyboardScript';

/** 内容语言 → 人物/实景的本地化区域名。非 zh/ja/ko 返回空(走通用)。 */
const REGION: Record<string, string> = { zh: '中国', ja: '日本', ko: '韩国' };

function regionOf(lang?: string): string {
  return REGION[(lang || '').slice(0, 2).toLowerCase()] || '';
}

/**
 * 全片统一的摄影/画质术语(styleLock)。图和视频都带,保证调性一致。
 * 用具体术语而不是「电影感」——后者对模型是无效 token。
 */
export const DEFAULT_STYLE_LOCK =
  '35mm 胶片质感,浅景深,柔和高光滚降,轻微颗粒,自然肤色,真实材质,构图稳定';

/** type → 首帧的镜头结构声明(prompt 开头第一句,最大的质量杠杆)。 */
function frameOpener(type: ShotType, shotSize?: string): string {
  const size = (shotSize || '').trim();
  switch (type) {
    case 'chart':
      return `信息图表画面,正视角,画面平整清晰,${size || '中景'},数据可视化`;
    case 'textcard':
      return `标题版式画面,正视角,居中构图,${size || '中景'},排版规整`;
    case 'logo':
      return `产品/标识特写,正视角,干净背景,${size || '特写'}`;
    case 'person':
      return `写实人像摄影,${size || '中景'},眼平机位,主体清晰、背景虚化`;
    case 'transition':
      return `抽象过渡画面,${size || '全景'},简洁构图,低信息密度`;
    case 'scene':
    default:
      return `写实实景摄影,${size || '中景'},眼平机位,有前后景层次`;
  }
}

export interface FramePromptOptions {
  /** 内容语言,决定人物/实景的本地化。 */
  lang?: string;
  /** 全片统一摄影术语。不传用 DEFAULT_STYLE_LOCK。 */
  styleLock?: string;
  /** 景别(来自分镜表 shot_size,可空)。 */
  shotSize?: string;
  /** 画幅,写进 prompt 帮助模型出对构图。'9:16' | '16:9' | '1:1'。 */
  aspect?: string;
  /** 尾帧模式:描述的是镜头【结束时】的画面。 */
  isLastFrame?: boolean;
}

/**
 * 给【图像模型】的首帧(或尾帧)描述。
 * 只写画面:镜头结构 → 画面内容 → 光线/质感 → 本地化 → 否定项。
 */
export function buildFramePrompt(shot: StoryShot, opts: FramePromptOptions = {}): string {
  const visual = (opts.isLastFrame ? shot.visualLast : shot.visualFirst) || shot.visualFirst || '';
  const region = regionOf(opts.lang);
  const allowText = shotAllowsText(shot.type);
  const aspectLine = opts.aspect === '16:9' ? '横屏 16:9'
    : opts.aspect === '1:1' ? '方形 1:1'
    : opts.aspect === '9:16' ? '竖屏 9:16'
    : '竖屏';

  // 结构对齐图文出图那套【分节编号】的写法(backend/src/routes/imageGen.ts buildImagePrompt)——
  // 同一个 Seedream,那套是产品里跑了很久验证过好用的;原来这里是一行逗号串,信息全挤在一起。
  return `请生成一张【视频故事板】画面(单帧,不是拼图、不是九宫格、不是分屏)。

镜头类型：${frameOpener(shot.type, opts.shotSize)}${opts.isLastFrame ? '（这是镜头结束时刻的画面）' : ''}

画面内容：
${visual || '（未指定,按镜头类型给一张贴题的写实画面）'}
${allowText && shot.onScreenText ? `
画面中要出现的文字：「${shot.onScreenText}」` : ''}

设计要求：

1. 摄影风格
   - 写实摄影,不是插画、不是 3D 渲染
   - ${opts.styleLock || DEFAULT_STYLE_LOCK}
   - 光线来源明确,明暗有层次,不要平光糊成一片

2. 画面构成
   - 主体在画面中的位置、朝向、动作严格按上面的画面内容
   - 有前景/中景/背景的空间层次,不要贴片感
   - 构图干净,主体清晰,次要元素不要抢视线

3. 文字
${allowText
  ? `   - 画面中的文字必须清晰、字形正确、排版工整,不要错字乱码
   - 文字与画面融为一体(是画面里真实存在的标题/图表标注/标识),不是后期贴上去的字幕
   - 不要水印、不要台标、不要平台 logo 角标`
  : `   - 画面里不要出现任何文字、字幕、标签
   - 不要水印、不要台标、不要 logo 角标`}
${region && (shot.type === 'person' || shot.type === 'scene') ? `
4. 地域观感
   - 若出现人物,为亚洲/${region}人的面孔与气质
   - 若为街景、室内、商业空间等实景,呈现当代${region}的环境风格
   - 通用物体与自然风景保持中性
` : ''}
${region && (shot.type === 'person' || shot.type === 'scene') ? '5' : '4'}. 技术规格
   - ${aspectLine}构图,主体不要被裁切
   - 高清画质,细节扎实
   - 不要 3D 渲染感、不要卡通、不要插画风、不要塑料质感
   - 不要多余的边框、不要分割线、不要把多个画面拼在一张图里`;
}

/** 运镜词表 —— 逐镜轮换,避免全片同一种推近。分镜表给了 motion 时优先用它。 */
const CAM_ROTATION = [
  '镜头极缓慢推近',
  '镜头极缓慢左移',
  '镜头极缓慢上摇',
  '固定机位,只有主体自然轻微动作',
  '镜头极缓慢拉远',
];

export interface MotionPromptOptions {
  /** 第几镜(用于运镜轮换)。 */
  shotIndex?: number;
  /** 该镜时长(秒),用于写时间轴标记。 */
  durationSec?: number;
  /** 是否有首帧参考图(i2v)。有 → 强调不改变画面,只加运动。 */
  hasKeyframe?: boolean;
  /** 是否首尾帧模式(两张参考图)。 */
  hasLastFrame?: boolean;
  /** 全片统一摄影术语(与首帧共享,保证调性一致)。 */
  styleLock?: string;
  /** 内容语言。 */
  lang?: string;
  /**
   * 原生音频模式:让 Seedance 自己出人声/口型/环境音,本地不再配音。
   *
   * ⚠️ 打开后【必须把台词写进 prompt】—— 不写它只会出环境音,分镜稿的口播直接丢了。
   *   同时否定项里的「不要出现文字、字幕」要保留(我们不要它烧字幕),
   *   但「不要人声」这类否定绝不能出现。
   */
  nativeAudio?: boolean;
  /** 该镜台词(nativeAudio 时交给 Seedance 念)。 */
  dialogue?: string;
  /** 谁在说(多角色时用;空则按画面主体)。 */
  speaker?: string;
}

/**
 * 给【视频模型】的运动描述。
 * 只写运动:结构声明 → 运镜 → 主体动作 → 时间轴 → 否定项。
 * 有首帧参考图时【绝不复述画面内容】(复述会导致主体漂移 —— Seedance 官方与社区共识)。
 */
/**
 * Seedance 提示词硬上限 2000 字符(社区实测,中文一字算一个、标点也算)。
 * 留 100 字余量,和 seedance2.0-prompt-skill 的建议一致。
 */
const PROMPT_MAX_CHARS = 1900;

/**
 * 超长时按优先级砍段,**台词绝不砍**。
 *
 * ⚠️ 为什么必须做:后端是 `prompt.slice(0, 2000)` —— 超了从尾巴直接切,不报错不提示。
 *   而台词拼在 prompt 中后段,一旦超长被切掉,那一镜就变成哑巴,日志上什么都看不出来。
 *   所以超长时从【最次要的段】开始丢:质感 → 时间轴 → 否定项 → 环境音/BGM。
 *   丢到还超,就只能截了 —— 但那时台词已经排在前面,截的是尾部的修饰。
 *
 * @param parts     按原顺序的段落
 * @param dropOrder 可丢弃段的下标,按【先丢谁】排序
 * @param shrinkIdx 最后手段:该段可以被截短(台词段)。见下面为什么不能整体截尾。
 */
function capPromptLength(parts: string[], dropOrder: number[], shrinkIdx = -1): string {
  const join = (ps: string[]) => ps.filter(Boolean).join('。');
  const cur = parts.slice();
  if (join(cur).length <= PROMPT_MAX_CHARS) return join(cur);
  for (const idx of dropOrder) {
    if (idx < 0 || idx >= cur.length) continue;
    cur[idx] = '';
    if (join(cur).length <= PROMPT_MAX_CHARS) return join(cur);
  }
  // ⚠️ 丢完还超 = 台词本身比整个预算还长(分镜表该按 4.2 字/秒 拦住,这里只是兜底)。
  //   此时【不能整体截尾】—— 「禁止:任何文字、字幕、LOGO或水印」排在最后,一截就没了,
  //   而它没了画面就会冒出乱码文字,比台词短一截严重得多(测试实测到这条)。
  //   所以改成把台词段自己截短,结构条款全部保住。
  if (shrinkIdx >= 0 && shrinkIdx < cur.length && cur[shrinkIdx]) {
    const others = cur.slice();
    others[shrinkIdx] = '';
    const room = PROMPT_MAX_CHARS - join(others).length - 2; // 2 = 分隔符余量
    cur[shrinkIdx] = room > 8 ? cur[shrinkIdx].slice(0, room) : '';
    if (join(cur).length <= PROMPT_MAX_CHARS) return join(cur);
  }
  return join(cur).slice(0, PROMPT_MAX_CHARS);
}

export function buildMotionPrompt(shot: StoryShot, opts: MotionPromptOptions = {}): string {
  const parts: string[] = [];
  // 可丢弃段的下标,按「先丢谁」排。台词那几段【不进这个表】= 永不丢弃。
  const dropOrder: number[] = [];
  // 最后手段可截短的段(台词)。-1 = 本镜没台词。
  let shrinkIdx = -1;
  const dur = Math.max(1, Math.round(opts.durationSec || shot.seconds || 5));

  // 1. 结构声明
  if (opts.hasLastFrame) {
    parts.push('单一连续镜头,无剪切,从首帧画面自然过渡到尾帧画面');
  } else if (opts.hasKeyframe) {
    parts.push('单一连续镜头,无剪切,严格保持参考图的主体、构图、配色与光线不变,只为画面添加自然、轻微的运动');
  } else {
    parts.push('单一连续镜头,无剪切,写实拍摄');
    // 没有首帧图时,视频模型是唯一知道画面的地方 —— 这时才把画面描述带上
    if (shot.visualFirst) parts.push(`画面:${shot.visualFirst}`);
  }

  // 2. 运镜(分镜表的 motion 优先;没有则按镜序轮换,避免全片同一种)
  const cam = shot.motion?.trim() || CAM_ROTATION[(opts.shotIndex ?? 0) % CAM_ROTATION.length];
  parts.push(`运动:${cam}(全程只用这一种运镜,平稳不抖)`);

  // 3. 时间轴标记(Higgsfield 方法论:模型对时间分段有明确响应)
  if (dur >= 6) {
    const mid = Math.round(dur / 2);
    parts.push(`0-${mid}s:运动缓慢起势;${mid}-${dur}s:延续同一方向,速度保持一致,结尾自然收住`);
  } else {
    parts.push(`0-${dur}s:匀速完成这一次运动,不要中途变向`);
  }
  const idxTimeline = parts.length - 1;

  // 4. 质感(与首帧共享,保证调性一致)
  parts.push(opts.styleLock || DEFAULT_STYLE_LOCK);
  const idxStyle = parts.length - 1;

  // 5. 原生音频:把台词交给 Seedance 念(它会自己对口型)。
  //    ⚠️ 不写这段的话模型只出环境音,分镜稿的口播就丢了 —— 这是「本地不配音」方案的命门。
  const line = (opts.dialogue || shot.narration || '').trim();
  if (opts.nativeAudio && line) {
    const who = opts.speaker?.trim();
    // ⚠️ 台词这两段【不进 dropOrder】—— 超长时宁可砍质感和否定项,也绝不能砍掉要念的话。
    //    极端超长(台词本身比预算还长)时才由 capPromptLength 把这一段截短,见 shrinkIdx。
    parts.push(`${who ? `${who}说` : '画面中的人物开口说'}:「${line}」`);
    shrinkIdx = parts.length - 1;
    parts.push('人物口型与这句台词严格同步,语气自然、贴合画面情绪');
    if (shot.sfx?.trim()) { parts.push(`环境音:${shot.sfx.trim()}`); dropOrder.push(parts.length - 1); }
    if (shot.bgmMood?.trim()) { parts.push(`背景音乐:${shot.bgmMood.trim()},音量压在人声之下`); dropOrder.push(parts.length - 1); }
  } else if (opts.nativeAudio) {
    // 这一镜没台词(纯空镜/转场)→ 明确只要环境音,别让它自己编台词。
    parts.push(`只有环境音${shot.sfx?.trim() ? `(${shot.sfx.trim()})` : ''},没有任何人说话`);
  }

  // 6. 否定项(视频专属)
  //    ⚠️ 原生音频模式下【不能】写「不要人声」之类 —— 台词全靠它念。
  //    「不要出现文字、字幕」保留:字幕不由画面生成,需要花字时另行本地叠加。
  parts.push('不要剪切、不要变焦跳变、不要镜头抖动;不要肢体扭曲或多余手指、不要画面闪烁或时间跳变');
  const idxNeg = parts.length - 1;
  // 丢弃优先级:质感 → 时间轴 → 画质否定项(环境音/BGM 上面已入表,排在最前先丢)。
  //   「禁止文字字幕」那条【不入表】—— 它丢了就会冒出乱码文字,比少一句质感严重得多。
  dropOrder.push(idxStyle, idxTimeline, idxNeg);
  // 措辞对齐社区通行写法:seedance2.0-prompt-skill 的标准模板、ArcReel 生成端自动追加的
  //   都是这一句。补上 LOGO —— 原来只写了「文字、字幕、水印、台标」,漏了它。
  //   字幕一律本地烧:生成模型画中文字必畸变(实测「几乎无法避免」),那两个项目也都禁掉。
  parts.push('禁止:任何文字、字幕、LOGO或水印');

  return capPromptLength(parts, dropOrder, shrinkIdx) + '。';
}

/**
 * 兼容旧链路的单 prompt(没有分镜表时用)。
 * 语义等价于老的 buildSeedancePrompt:把一句口播当画面依据丢给视频模型。
 * 【只在降级路径用】—— 正常链路应该走 buildFramePrompt + buildMotionPrompt。
 */
export function buildLegacyPrompt(
  sentence: string,
  opts: { track?: string; persona?: string; lang?: string; isI2V?: boolean; shotIndex?: number },
): string {
  const region = regionOf(opts.lang);
  const styleBits = [opts.track, opts.persona].filter(Boolean).join('、');
  const cam = CAM_ROTATION[(opts.shotIndex ?? 0) % CAM_ROTATION.length];
  const parts: string[] = [];
  if (opts.isI2V) {
    parts.push('保持参考图的主体、构图与配色不变,只为画面添加自然、轻微的运动');
  } else {
    parts.push(`写实竖屏空镜,画面贴合这句旁白(具体、可拍,有明确主体与单一动作):「${sentence}」`);
  }
  parts.push('环境真实、自然光、有空间层次与景深');
  parts.push(`运动:${cam}(全程只用这一种,平稳不抖)`);
  parts.push(`${DEFAULT_STYLE_LOCK}${styleBits ? `,贴合「${styleBits}」` : ''}`);
  if (region) {
    parts.push(`本地化:若出现人物,为亚洲/${region}人面孔与气质;若为街景/室内/餐厅/商店/交通等实景,呈现当代${region}城市的环境与风格;通用物体、纯自然风景保持中性`);
  }
  parts.push('不要任何文字、字幕、水印、logo;避免画面抖动、肢体扭曲、时间闪烁');
  return parts.join('。') + '。';
}
