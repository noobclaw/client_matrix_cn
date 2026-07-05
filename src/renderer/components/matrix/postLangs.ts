/**
 * 矩阵发帖/图文的语言选项(统一)。auto/mixed=跟随账号(默认中文/英文),其余强制该语言。
 * 各发帖向导(FB/Reddit/币安/推特/图文)共用,避免各写一份。
 * 图片文字只中/英(小语种回落英文)—— 由 orchestrator 处理,这里只管文案语言。
 */
export interface PostLangOption { code: string; zh: string; en: string }

export const POST_LANGS: PostLangOption[] = [
  { code: 'mixed', zh: '自动(随账号)', en: 'Auto' },
  { code: 'zh', zh: '简体中文', en: 'Chinese' },
  { code: 'zh-TW', zh: '繁體中文', en: 'Traditional Chinese' },
  { code: 'en', zh: 'English', en: 'English' },
  { code: 'ja', zh: '日本語', en: 'Japanese' },
  { code: 'ko', zh: '한국어', en: 'Korean' },
  { code: 'ru', zh: 'Русский', en: 'Russian' },
  { code: 'fr', zh: 'Français', en: 'French' },
  { code: 'de', zh: 'Deutsch', en: 'German' },
  { code: 'vi', zh: 'Tiếng Việt', en: 'Vietnamese' },
];

export function postLangLabel(code: string, isZh: boolean): string {
  const o = POST_LANGS.find((l) => l.code === code);
  if (!o) return code;
  return isZh ? o.zh : o.en;
}
