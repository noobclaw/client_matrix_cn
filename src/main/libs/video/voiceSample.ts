/**
 * voiceSample — 配音试听用的样例句。
 *
 * 豆包音色走后端代理【按字符计费】,所以样例必须短:十来个字够听出音色、语速和情绪,
 * 又不会让用户点几下试听就烧掉可观的钱。Edge 音色免费,但为了口径一致也用同一批短句。
 *
 * 语种按【音色 id 前缀】判断优先于传入的 lang —— 用户可能选了英文音色却没改创作语言,
 * 拿中文样例喂英文音色会读成怪腔。
 */

/** 各语种的样例句(控制在 ~12 个字 / ~8 个词以内)。 */
const SAMPLES: Record<string, string> = {
  zh: '你好，这是配音试听效果。',
  'zh-TW': '你好，這是配音試聽效果。',
  en: 'Hi, this is a voice preview.',
  ja: 'こんにちは、音声のサンプルです。',
  ko: '안녕하세요, 음성 미리듣기입니다.',
  id: 'Halo, ini contoh suara.',
  vi: 'Xin chào, đây là giọng đọc mẫu.',
  es: 'Hola, esta es una voz de muestra.',
  pt: 'Olá, esta é uma voz de amostra.',
  fr: 'Bonjour, ceci est un aperçu vocal.',
};

/** 从音色 id 猜语种。edge 是 `zh-CN-XxxNeural` / `en-US-XxxNeural`;豆包是 `zh_female_xxx` / `en_male_xxx`。 */
function langOfVoice(voice: string): string {
  const v = (voice || '').trim();
  if (!v) return '';
  const m = /^([a-z]{2})[-_]([A-Za-z]{2,4})?/.exec(v);
  if (!m) return '';
  const base = m[1].toLowerCase();
  // zh-TW / zh-HK 用繁体样例
  if (base === 'zh' && /(-|_)(TW|HK)/i.test(v)) return 'zh-TW';
  return base;
}

/**
 * 取试听样例句。
 * @param lang  向导里选的创作语言(可能是 'auto' 或空)
 * @param voice 选中的音色 id —— 语种以它为准(用户常改音色不改语言)
 */
export function voiceSampleText(lang?: string, voice?: string): string {
  const fromVoice = langOfVoice(voice || '');
  const raw = (fromVoice || String(lang || '').trim()).toLowerCase();
  if (!raw || raw === 'auto') return SAMPLES.zh;
  if (SAMPLES[raw]) return SAMPLES[raw];
  // zh-TW 之类带地区的:先整串再取前两位
  const base = raw.split(/[-_]/)[0];
  return SAMPLES[base] || SAMPLES.zh;
}
