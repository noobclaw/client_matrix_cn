/**
 * scriptWriter — 用 DeepSeek 写视频旁白脚本 + 为每个分镜生成素材搜索词。
 *
 * 抄 MoneyPrinterTurbo 的两步 LLM 套路:
 *   1. generateScript(): 没给文案时,按【主题 + 人设 + 赛道 + 目标时长】生成一段
 *      连贯的中文口播旁白。时长靠字数控制(中文约 4.5 字/秒)。
 *   2. generateSearchTerms(): 把已拆好的逐句分镜,各自映射成 1-3 个英文搜索词
 *      (Pexels/Pixabay 是英文库),让画面跟着内容走,而不是所有镜头复用同一张图。
 *      映射时会把整条视频的【主题/赛道/人设/关键词】当语境一并喂进去(见 ctx 参数),
 *      避免模型孤立看单句憋出跑题泛词。
 *
 * 两步都走 NoobClaw 服务端的 DeepSeek 代理(/api/ai/chat/completions)。
 * 两步都用 noobclawai-reasoner(=deepseek-v4-pro,质量更好,服务端按 ~3x credits 计费):
 *   - generateScript() 写旁白是创作活,理所当然走 Pro。
 *   - generateSearchTerms() 映射也升 Pro —— 实测语义更准、词更贴内容;reasoner 不支持
 *     response_format=json_object,故 JSON 契约改靠 prompt 强约束 + extractJsonObject 兜底。
 * 鉴权用 NoobClaw JWT。
 *
 * 任何环节失败都【不抛】(脚本生成除外):搜索词失败 → 退回用全局 keywords,
 * 上层照常出片。脚本生成失败才抛,因为没文案没法继续。
 */

import { getNoobClawAuthToken } from '../claudeSettings';
import { DEFAULT_VIDEO_CONFIG, interpolate } from './videoConfig';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

interface ChatResult {
  content: string;
  /** 本次调用消耗的 token 总数(prompt + completion)。服务端按此计费。 */
  tokens: number;
  /** 服务端权威 USD 成本(_noobclaw.costUsd = billable_tokens × token_price_per_million,
   *  含 cache-hit 折扣)。老后端不回该字段时为 0。 */
  costUsd: number;
}

/**
 * 调 DeepSeek 代理。jsonMode=true 时传 response_format=json_object —— prompt
 * 必须含 "json" 字眼(DeepSeek 文档硬要求,否则会无限输出空白卡死)。
 * (export 给 thread-pipeline 的翻译改写复用;签名/行为不变。)
 */
export async function callDeepSeek(
  systemPrompt: string,
  userMessage: string,
  jsonMode: boolean,
  timeoutMs = 60_000,
  model: 'noobclawai-chat' | 'noobclawai-reasoner' = 'noobclawai-reasoner',
  /**
   * 取样温度。omit = DeepSeek 用模型默认值(reasoner 偏低,精确度优先)。
   * 创作类(写口播稿)显式传 1.0+ 提升输出多样性;搜索词那种确定性映射不传 = 用默认低温。
   */
  temperature?: number,
): Promise<ChatResult> {
  const token = getNoobClawAuthToken();
  if (!token) throw new Error('AI_NOT_CONFIGURED — 请先登录 NoobClaw 账号');

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    stream: false,
    max_tokens: 4000,
  };
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    body.temperature = temperature;
  }
  // response_format=json_object 这道「强制只能输出合法 JSON」的开关仅 chat(flash)支持;
  // reasoner(Pro 思考模型)不支持该开关(DeepSeek 官方限制),强行带上会被拒/失效。
  // 故 reasoner 不发此字段,改靠 prompt 约束 + 下游 extractJsonObject 宽松解析兜底。
  if (jsonMode && model === 'noobclawai-chat' && /json/i.test(systemPrompt + userMessage)) {
    body.response_format = { type: 'json_object' };
  }

  // 网络抖动重试:fetch 本身抛错(undici "fetch failed" / ECONNRESET / 超时 abort)或 5xx/429
  // 都是【没拿到有效响应、也没扣费】的瞬时故障 → 退避重试,别让一次抖动直接弄挂整条成片。
  // 401/402/4xx/空内容是确定性错误,不重试。
  const MAX_ATTEMPTS = 3;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${apiBase()}/api/ai/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        if (resp.status === 401) throw new Error('AI_AUTH_FAILED — NoobClaw 登录态失效，请重新登录');
        if (resp.status === 402) throw new Error('CREDITS_INSUFFICIENT — 积分余额不足，请前往钱包充值');
        const errText = await resp.text().catch(() => '');
        // 5xx / 429:服务端瞬时问题,可重试;其余 4xx 直接抛。
        if ((resp.status >= 500 || resp.status === 429) && attempt < MAX_ATTEMPTS) {
          lastErr = new Error(`AI API ${resp.status}`);
          await sleep(attempt * 2000);
          continue;
        }
        throw new Error(`AI API ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const json: any = await resp.json();
      const content = json?.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('AI_EMPTY_RESPONSE — AI 返回空内容');
      // 对外只用「实扣积分」口径,绝不外露 usage.total_tokens(上游真实消耗,
      // 暴露会让用户反推我们的成本/加价率 —— 真实 token 只给后端 / admin 看)。
      // _noobclaw.billableTokens = 含 cache 折扣 + Pro 倍率后实际扣的积分;
      // _noobclaw.costUsd = 按 token_price_per_million 算好的权威美元(同源 scenario)。
      const costUsd = Number(json?._noobclaw?.costUsd) || 0;
      const price = Number(json?._noobclaw?.priceUsdPerMillion) || 0;
      let tokens = Number(json?._noobclaw?.billableTokens) || 0;
      // 老后端没回 billableTokens 时,用权威 costUsd 反推积分(仍不碰 raw token)。
      if (!tokens && costUsd > 0 && price > 0) tokens = Math.round((costUsd / price) * 1_000_000);
      return { content, tokens, costUsd };
    } catch (e: any) {
      const msg = String(e?.message || e);
      // 确定性错误(登录/积分/4xx/空内容)立即抛,不重试。
      if (/AI_AUTH_FAILED|CREDITS_INSUFFICIENT|AI_EMPTY_RESPONSE|^AI API [4]/.test(msg)) throw e;
      // 瞬时网络/超时:undici 抛 "fetch failed"、ECONNRESET、socket hang up,或 abort 超时。
      const transient = e?.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|aborted/i.test(msg);
      if (transient && attempt < MAX_ATTEMPTS) { lastErr = e; await sleep(attempt * 2000); continue; }
      // 重试用尽 / 非瞬时错误:给网络类故障一个更清楚的提示(不是代码 bug,是连不上)。
      if (transient) throw new Error(`AI_NETWORK_FAILED — 调用 AI 网络失败（已重试 ${MAX_ATTEMPTS} 次），请检查网络/VPN 后重试`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('AI_NETWORK_FAILED — 调用 AI 失败');
}

/** 中文约 4.5 字/秒;由目标秒数反推目标字数。 */
function targetCharCount(seconds: number): number {
  return Math.round(Math.max(10, seconds) * 4.5);
}

/**
 * 随机抽一个叙事视角,塞进 generateScript 的 user message,强行打破「同主题/赛道 → 同结构」。
 *   reasoner 模型温度默认偏低,加视角注入比单纯加 temperature 更精准 —— 哪怕模型沿用同一
 *   套词汇,结构会从「场景→体验→性价比→复刻」这种探店模板里跳出来。
 *   8 种视角覆盖常见短视频文案套路,大多互斥(不会同时出现「自嘲」+「数据驱动」)。
 */
function pickNarrationAngle(lang: ContentLang): string {
  // 只备 zh/ja/ko/en 四套;其余语言码(zh-TW→zh,拉丁系→en)取近似池 —— 视角描述本身
  // 是给 LLM 的指令,不必与产出语言一致。
  const POOL: Partial<Record<ContentLang, string[]>> = {
    zh: [
      '反差对比视角(从一句反预期的事实切入,先抛悖论再揭原因)',
      '场景代入视角(用具体时间/地点/动作把观众拉进一个画面)',
      '清单/盘点视角(一句一个要点,信息密度高,不铺垫不抒情)',
      '故事化视角(像跟朋友聊一段亲身经历,有人物、有起伏)',
      '争议/反套路视角(先反驳一个流行说法或踩点常识,再给自己的版本)',
      '数据/事实驱动视角(用一个具体数字/时间/比例开头,后续都围绕这个数字展开)',
      '自嘲/翻车视角(承认踩过的坑或翻过的车,从教训反推真有用的建议)',
      '提问引导视角(以一个直接问读者的问题开头,正文逐步回答)',
    ],
    ja: [
      'コントラスト視点(予想を裏切る事実から入る)',
      '没入シーン視点(具体的な時間・場所・動作で読者を引き込む)',
      'リスト/まとめ視点(一文一要点、情報密度高め)',
      'ストーリー視点(友達に体験談を語る感じ)',
      '反論視点(よくある誤解を先に否定して自分の見解を提示)',
      'データ駆動視点(具体的な数字/時間から始めて全編それを軸に)',
      '失敗談視点(踩った地雷を素直に認めてから本物の助言)',
      '問いかけ視点(冒頭で読者に直接問いかけて本文で答える)',
    ],
    ko: [
      '대비 시점(예상을 뒤집는 사실로 시작)',
      '몰입 장면 시점(구체적 시간/장소/행동으로 끌어들이기)',
      '리스트/정리 시점(한 문장 한 요점, 정보 밀도 높게)',
      '스토리텔링 시점(친구에게 경험담을 들려주듯)',
      '반박 시점(흔한 통념을 먼저 깬 뒤 자기 견해)',
      '데이터 시점(구체적 숫자/시간으로 시작해 그것을 축으로)',
      '실패담 시점(겪은 실수를 솔직히 인정한 뒤 진짜 조언)',
      '질문 시점(독자에게 직접 묻는 문장으로 시작)',
    ],
    en: [
      'Contrast angle (open with a fact that subverts expectations)',
      'Scene-immersion angle (concrete time/place/action that drops the viewer in)',
      'List/round-up angle (one sentence per point, high information density)',
      'Story angle (recount a personal experience like talking to a friend)',
      'Contrarian angle (push back on a common belief, then give your version)',
      'Data-driven angle (open with a specific number/time/ratio, build around it)',
      'Self-deprecating angle (own a mistake first, then derive the real lesson)',
      'Direct-question angle (open with a question to the viewer, answer in the body)',
    ],
  };
  const list = POOL[lang] || (String(lang).startsWith('zh') ? POOL.zh! : POOL.en!);
  return list[Math.floor(Math.random() * list.length)];
}

/** 内容语言:决定口播稿 + 素材搜索词用哪种语言。
 *  detectLang 只探测 zh/ja/ko/en 四种;其余码(zh-TW/id/vi/es/pt/fr)只能由用户在向导里
 *  显式选择(input.scriptLang)传入 —— 选项与配音音色语种对齐(VOICE_GROUPS)。 */
export type ContentLang = 'zh' | 'zh-TW' | 'ja' | 'ko' | 'en' | 'id' | 'vi' | 'es' | 'pt' | 'fr';

/**
 * 轻量语言探测:按字符脚本判别。日文同时含汉字,故先查假名;韩文查谚文;
 * 再查汉字判中文;都没有 → 当英文/拉丁。够覆盖中/日/韩/英四种主用语言。
 */
export function detectLang(text: string): ContentLang {
  const t = text || '';
  if (/[぀-ゟ゠-ヿ]/.test(t)) return 'ja'; // 平假名/片假名
  if (/[가-힯]/.test(t)) return 'ko'; // 谚文
  if (/[㐀-鿿豈-﫿]/.test(t)) return 'zh'; // 汉字
  return 'en';
}

/** 语言代码 → 给 LLM 用的英文语言名(供模板速生等外部消费方复用同一套名称)。 */
export function contentLangName(l: ContentLang): string {
  return langName(l);
}

/** 语言代码 → 给 LLM 用的英文语言名。 */
function langName(l: ContentLang): string {
  const M: Record<string, string> = {
    zh: 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', ja: 'Japanese', ko: 'Korean',
    en: 'English', id: 'Indonesian', vi: 'Vietnamese', es: 'Spanish', pt: 'Portuguese (Brazilian)', fr: 'French',
  };
  return M[l] || 'English';
}

export interface GenerateScriptInput {
  /** 视频主题 / 选题(用户输入的关键词拼出来的也行)。 */
  topic: string;
  /** 账号人设(TRACK_PRESETS 里的 persona)。 */
  persona?: string;
  /** 赛道名。 */
  track?: string;
  /** 关键词(辅助 LLM 锁定方向)。 */
  keywords?: string[];
  /** 目标时长(秒)。默认 45s。 */
  targetSeconds?: number;
  /** 用户提供的参考文案(scriptMode='ai' 时):作为方向/素材参考,AI 据此再创作,
   *  不逐字照搬。空 / undefined 时按主题从零写。 */
  referenceScript?: string;
  /** 热搜成片:服务端联网(Serper /news)取到的该热点最新资料块(多条报道汇总)。存在时作为
   *  【内容主题】,要求 AI 综合资料、紧贴事实、按最新进展写(优先级高于 referenceScript,截断更宽)。 */
  material?: string;
  /** 口播稿语言。缺省 'zh'。由上层按【视频文案语言(有则优先)/ 关键词语言】探测后传入。 */
  lang?: ContentLang;
}

export interface GenerateScriptResult {
  /** 生成的口播旁白正文。 */
  script: string;
  /** 本步消耗 token(reasoner 档,服务端按 ~3x 计费)。 */
  tokens: number;
  /** 本步服务端权威 USD 成本(老后端不回时为 0)。 */
  costUsd: number;
}

/**
 * 生成一段口播旁白(纯文本,不带分镜标记/序号)。供 splitScript 再拆分镜。
 * 失败抛错(上层提示用户手填文案)。返回正文 + 本步 token 消耗。
 */
export async function generateScript(
  input: GenerateScriptInput,
  scriptSystemTemplate?: string,
): Promise<GenerateScriptResult> {
  const targetSec = input.targetSeconds ?? 45;
  const targetChars = targetCharCount(targetSec);
  const kw = (input.keywords || []).filter(Boolean).join('、');
  const lang = input.lang || 'zh';
  const ln = langName(lang);

  // 长度提示:中文按「字符数」最直观;其它语言用「朗读秒数」更准(字符≠时长)。
  const lengthLine = lang === 'zh'
    ? `1. 围绕主题写一段【连贯的口播旁白】,目标约 ${targetChars} 个中文字符(对应约 ${targetSec} 秒)。`
    : `1. Write one coherent voice-over narration of about ${targetSec} seconds when read aloud.`;

  // 参考文案:有它时【以它为内容主题】,赛道/关键词只决定口吻风格。
  //   2026-06 修(用户实测:选美食赛道 + 填 spacex 参考文案,AI 仍写美食)——根因是赛道
  //   是【强内容指令】,参考文案被降级成"仅供参考、别照搬",冲突时 AI 听赛道写了原赛道
  //   题材。反过来:有参考文案就以它为内容主导,赛道转成"用某类博主的口吻",不绑题材。
  // 热搜成片:material(联网新闻资料)作为内容主题,优先级高于普通参考文案,且放宽截断长度,
  //   prompt 强调"综合资料、紧贴事实、按最新写、不编造"——满足用户"全网查询紧贴给的内容按最新写"。
  const research = (input.material || '').trim();
  const ref = research || (input.referenceScript || '').trim();
  const refIsResearch = !!research;

  // system prompt 走模板(服务端可调措辞),只认 4 个占位符;空的人设/赛道行替换后被 filter 掉。
  const tpl = scriptSystemTemplate || DEFAULT_VIDEO_CONFIG.scriptSystemTemplate;
  const system = interpolate(tpl, {
    LANG_NAME: ln,
    PERSONA_LINE: input.persona ? `账号人设:${input.persona}。` : '',
    // 有参考文案时赛道只作口吻(不绑题材),避免跟参考文案的实际选题打架。
    TRACK_LINE: input.track
      ? (ref ? `讲述口吻可参考「${input.track}」类博主的风格(只影响语气,不决定题材)。` : `内容赛道:${input.track}。`)
      : '',
    LENGTH_LINE: lengthLine,
  }).split('\n').map((s) => s.trim()).filter(Boolean).join('\n');

  // 叙事视角池 — 每次随机选一个塞进 user message,强行打破「同主题=同结构」的套路。
  //   不放进 system template 是因为 system template 是服务端可调的,改这事跟模板措辞无关;
  //   而且视角是「每次创作变一次」的运行期行为,本该在每次调用处现 roll。
  const angle = pickNarrationAngle(lang);
  // 有参考文案/资料:它就是本视频的【内容主题】,据此创作口播;赛道/关键词不作内容,只在 system 作口吻。
  //   热搜成片(refIsResearch)用联网资料块,放宽到 4000 字符并强调"综合、紧贴事实、按最新、不编造"。
  const refBlock = refIsResearch
    ? (lang === 'zh'
        ? `【本视频的热点主题(唯一准绳,口播必须讲的就是这个):${input.topic}】\n【下面是联网搜来的相关报道汇总,供你了解最新事实。⚠️重要:搜索可能掺入与上面主题【无关】的报道——只采用与「${input.topic}」这个人物/事件【直接相关】的内容;凡是写的是【别的人 / 别的事】的段落,一律忽略,绝不能把口播写成资料里的别人。若整份资料都跟主题对不上,就只依据主题本身写(可写得概括些),宁可少写事实细节,也绝不张冠李戴。请围绕该主题的【最新进展】写一段口播:信息要准、不臆测、不编造】:\n${ref.slice(0, 4000)}`
        : `【Authoritative topic of this video (the ONLY thing the narration may be about): ${input.topic}】\nBelow is web research gathered for the latest facts. ⚠️IMPORTANT: the search may include reports UNRELATED to the topic above — use ONLY content directly about "${input.topic}"; ignore any passage about a DIFFERENT person or event, and never write the narration about someone else from the research. If the whole research mismatches the topic, write from the topic itself (being more general is fine) — never conflate it with someone else. Write the narration around the LATEST developments: accurate, no speculation, no fabrication:\n${ref.slice(0, 4000)}`)
    : (lang === 'zh'
        ? `【本视频内容主题 —— 就讲这篇,可精炼/重组织成更顺口的口播版,但题材必须忠于这篇,不要改成别的领域】:\n${ref.slice(0, 1500)}`
        : `【Video topic — base the narration on THIS content; you may tighten/restructure for speech, but keep the subject faithful to it, do NOT switch to another niche】:\n${ref.slice(0, 1500)}`);
  const user = (ref ? [
    refBlock,
  ] : [
    `主题:${input.topic}`,
    kw ? `关键词:${kw}` : '',
  ]).concat([
    angle ? (lang === 'zh' ? `本次创作请采用「${angle}」,跟该主题/赛道的常见写法明显错开。` : `Use the "${angle}" angle this time — deliberately avoid the most common framing for this topic.`) : '',
    lang === 'zh'
      ? `请直接输出约 ${targetChars} 字的口播旁白正文。`
      : `Now output ONLY the ${ln} narration body (about ${targetSec}s when read aloud).`,
  ]).filter(Boolean).join('\n');

  // 旁白创作走 Pro(reasoner),质量明显优于 flash;服务端按 ~3x 计费,故仅此一处用。
  // temperature=1.2:reasoner 默认偏低导致同 prompt 输出趋同,创作场景显式拉高让文案更
  //   多样;搜索词那步保持默认低温(要稳定一致)。
  const { content, tokens, costUsd } = await callDeepSeek(system, user, false, 90_000, 'noobclawai-reasoner', 1.2);
  // 去掉可能的包裹引号 / 多余空行
  const script = content.trim().replace(/^["'「『]+|["'」』]+$/g, '').trim();
  return { script, tokens, costUsd };
}

export interface GenerateSearchTermsResult {
  /** 与 scenes 等长的逐镜搜索词数组。 */
  terms: string[][];
  /** 本步消耗 token(reasoner 档,~3x);兜底时为 0。 */
  tokens: number;
  /** 本步服务端权威 USD 成本(兜底 / 老后端时为 0)。 */
  costUsd: number;
}

/** 搜索词映射的整体语境:让模型按【这条视频在讲什么】给每镜配词,而不是孤立看单句。 */
export interface SearchTermsContext {
  /** 视频主题/选题(关键词拼出来的也行)。 */
  topic?: string;
  /** 账号人设。 */
  persona?: string;
  /** 内容赛道。 */
  track?: string;
  /** 关键词。 */
  keywords?: string[];
  /** 内容语言(zh/ja/ko/en…)。用来给【人物】镜头注入地区人种倾向 —— 否则中文内容
   *  从 Pexels/Pixabay 搜出来的人物大多是西方面孔(库默认西方,locale 参数只管查询
   *  语言不筛人种)。仅对人物镜头加 "asian",非人物镜头不加。 */
  lang?: string;
}

/**
 * 从可能夹带思考文字 / markdown 围栏的模型输出里,抠出第一个 JSON 对象再交给 JSON.parse。
 * reasoner 不支持 response_format=json_object,可能把 JSON 包在 ```json``` 或推理段落里,
 * 这里先剥围栏、再截取首个 {...} 平衡块,保证 chat(本就纯 JSON)与 reasoner 都能解析。
 */
export function extractJsonObject(raw: string): string {
  let t = (raw || '').trim();
  // 剥 ```json ... ``` / ``` ... ``` 围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  // 截取第一个完整的 {...}(按花括号配平,容忍前后多余文字)
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

/**
 * 为每个分镜生成 1-3 个英文素材搜索词。返回与 scenes 等长的数组;某项失败用
 * 全局 keywords 兜底。绝不抛错。同时返回本步 token 消耗(兜底时为 0)。
 *
 * ctx:整条视频的主题/赛道/人设/关键词语境。映射时把它当上下文喂给模型,
 * 让每镜的词锁定到该选题(否则模型孤立看单句,常憋出跑题的泛词)。
 */
export async function generateSearchTerms(
  scenes: string[],
  fallbackKeywords: string[],
  termsSystemPrompt?: string,
  ctx?: SearchTermsContext,
  outputLang: 'en' | 'zh' = 'en',
): Promise<GenerateSearchTermsResult> {
  const fallback = (fallbackKeywords || []).filter(Boolean);
  const fallbackEach = scenes.map(() => fallback.slice(0, 3));
  if (scenes.length === 0) return { terms: [], tokens: 0, costUsd: 0 };

  // 搜索词默认英文(Pexels/Pixabay 库英文召回最全;stock 模式走这条,不传 outputLang)。
  // outputLang='zh':热搜成片配图走 serper 谷歌图,中文热点用【中文词】搜更贴、图源更干净
  //   (维基/新闻/机构),所以热点流中文客户端会要中文词 —— 换一套中文 system,保持 JSON 契约。
  // prompt 走服务端可调(默认见 videoConfig);务必保持 {"terms":[[...]]} 输出契约。
  const system = outputLang === 'zh'
    ? '你是配图搜索词助手。为下面每个分镜输出 1-3 个【简体中文】图片搜索关键词(用于谷歌图片搜索),要贴合该镜内容、是真实可搜的词。只输出 JSON 对象:{"terms":[["词1","词2"],...]},其中 terms 数组长度必须等于输入行数,逐行对应。不要解释、不要 markdown 代码块。'
    : (termsSystemPrompt || DEFAULT_VIDEO_CONFIG.termsSystemPrompt);

  // A:整体语境前置 —— 让模型据此消歧、把每镜的词钉在选题上(不再孤立看单句)。
  const ctxLines: string[] = [];
  if (ctx?.topic) ctxLines.push(`Overall video topic: ${ctx.topic}`);
  if (ctx?.track) ctxLines.push(`Content niche: ${ctx.track}`);
  if (ctx?.persona) ctxLines.push(`Creator persona: ${ctx.persona}`);
  const ctxKw = (ctx?.keywords || []).filter(Boolean);
  if (ctxKw.length) ctxLines.push(`Keywords: ${ctxKw.join(', ')}`);
  const ctxBlock = ctxLines.length
    ? `Context for the WHOLE video (use it to disambiguate each line and keep every term on-topic):\n${ctxLines.join('\n')}\n\n`
    : '';

  // 素材本地化:Pexels/Pixabay 默认西方内容,中文/日韩内容若不指定,人物全是老外、
  // 场景全是国外街景。按内容语言【优先找本地素材】,但每类带通用兜底词(放后面),
  // provider 按词序优先 → 有本地素材就用,搜不到自动回退通用,不会变纯色卡。
  // 通用物品/风景/抽象不加(咖啡杯就是咖啡杯)。English(en)不加,保持原行为。
  const REGION: Record<string, { label: string; country: string; city: string }> = {
    zh: { label: 'Chinese', country: 'chinese', city: 'shanghai' },
    ja: { label: 'Japanese', country: 'japanese', city: 'tokyo' },
    ko: { label: 'Korean', country: 'korean', city: 'seoul' },
  };
  // zh 输出:中文 system 已直接要中文词,不叠加英文 asian/地区指令(会冲突)。
  const r = outputLang === 'zh' ? undefined : REGION[String(ctx?.lang || '').slice(0, 2).toLowerCase()];
  const regionBlock = r
    ? `IMPORTANT — localize footage for a ${r.label} audience (spoken language is ${r.label}). Stock libraries default to Western faces/places, which mismatch this audience. Localize each line by TYPE:\n`
      + `• PEOPLE shots: the term MUST start with "asian" (e.g. "asian man talking", "asian woman cooking", "asian students"). You may add ONE generic fallback term after it.\n`
      + `• LOCATION / scene / cultural shots (street, city, office, school, restaurant, market, home, shopping, festival): put a ${r.label}-context term FIRST, then ONE generic fallback term so results never run dry — e.g. ["${r.country} street food","street food"], ["${r.city} city street","city street"], ["${r.country} office team","office team"].\n`
      + `• GENERIC shots (single objects, abstract, nature, sky, textures, close-up food, animals): keep NEUTRAL — no ethnicity/country word.\n`
      + `Always keep 1-3 terms per line, most-specific localized term FIRST.\n\n`
    : '';

  const numbered = scenes.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const user = `${ctxBlock}${regionBlock}Input lines (${scenes.length}):\n${numbered}\n\n`
    + 'Return ONLY the raw JSON object now (no markdown fences, no explanation, no reasoning).';

  try {
    // B:映射走 reasoner(Pro),语义更准 → 词更贴内容;服务端按 ~3x 计费。
    // reasoner 不吃 json_object 开关,故靠 prompt + extractJsonObject 兜住 JSON 契约。
    const { content, tokens, costUsd } = await callDeepSeek(system, user, true, 90_000, 'noobclawai-reasoner');
    const parsed = JSON.parse(extractJsonObject(content));
    const terms = parsed?.terms;
    if (!Array.isArray(terms)) return { terms: fallbackEach, tokens, costUsd };
    const mapped = scenes.map((_, i) => {
      const t = terms[i];
      if (Array.isArray(t)) {
        const cleaned = t
          .filter((x: any) => typeof x === 'string' && x.trim())
          .map((x: string) => x.trim())
          .slice(0, 3);
        if (cleaned.length > 0) return cleaned;
      }
      return fallbackEach[i];
    });
    return { terms: mapped, tokens, costUsd };
  } catch {
    return { terms: fallbackEach, tokens: 0, costUsd: 0 };
  }
}

/**
 * 热搜成片专用:从【热搜标题】抽配图搜索词(替代从整篇口播稿逐镜抽 —— 都是热榜,配图紧扣
 * 标题主体最准、词也更少)。返回标题里的核心实体(人名/明星/机构/地名/作品)+ 1-2 个概念词;
 * 调用方通常再把【标题原句】拼到最前,组成 [标题, 实体1, 实体2, …]。失败返空数组(不抛)。
 * 例:「花小龙带黄晓明自律的一天」→ ["花小龙","黄晓明","自律"](调用方再补标题原句到最前)。
 */
export async function generateHotspotKeywords(
  title: string,
  outputLang: 'zh' | 'en',
): Promise<{ terms: string[]; tokens: number; costUsd: number }> {
  const t = (title || '').trim();
  if (!t) return { terms: [], tokens: 0, costUsd: 0 };
  const system = outputLang === 'zh'
    ? '你从一条热搜标题里提取【图片搜索关键词】,用于谷歌图片搜索给视频配图。规则:提取标题中出现的具体实体(人名、明星、机构、品牌、地名、作品名)和 1-2 个核心概念词,共 3-5 个【简体中文】短词;每个必须是真实可搜、能搜到相关图片的词;不要整句、不要标点符号、不要话题号。只输出 JSON:{"terms":["词1","词2"]}。不要解释、不要 markdown。'
    : 'Extract image-search keywords from a trending news headline, to illustrate a video via Google Images. Pull the concrete entities (person/celebrity names, organizations, brands, places, work titles) plus 1-2 core concept words — 3-5 English keywords total. Each must be a real, searchable short term; no full sentences, no punctuation, no hashtags. Output ONLY JSON: {"terms":["term1","term2"]}. No explanation, no markdown.';
  const user = `Headline: ${t}\n\nReturn ONLY the raw JSON object now (no markdown fences, no explanation).`;
  try {
    // 标题抽词是简单确定性任务 → 走普通 chat(省钱),不上 reasoner。
    const { content, tokens, costUsd } = await callDeepSeek(system, user, true, 30_000);
    const parsed = JSON.parse(extractJsonObject(content));
    const terms = Array.isArray(parsed?.terms)
      ? parsed.terms.filter((x: any) => typeof x === 'string' && x.trim()).map((x: string) => x.trim()).slice(0, 5)
      : [];
    return { terms, tokens, costUsd };
  } catch {
    return { terms: [], tokens: 0, costUsd: 0 };
  }
}
