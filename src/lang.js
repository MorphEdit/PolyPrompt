// Offline language detection (eld, medium database: 60 languages, no network).
import { eld } from 'eld/medium';

// ISO 639-1 code -> English name, for the eld/medium languages TranslateGemma supports.
export const LANGUAGES = {
  ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali', ca: 'Catalan', cs: 'Czech',
  da: 'Danish', de: 'German', el: 'Greek', en: 'English', es: 'Spanish',
  et: 'Estonian', fa: 'Persian', fi: 'Finnish', fr: 'French', gu: 'Gujarati',
  he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', is: 'Icelandic',
  it: 'Italian', ja: 'Japanese', kn: 'Kannada', ko: 'Korean', lt: 'Lithuanian',
  lv: 'Latvian', ml: 'Malayalam', mr: 'Marathi', nl: 'Dutch', no: 'Norwegian',
  pa: 'Punjabi', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian',
  sk: 'Slovak', sl: 'Slovenian', sr: 'Serbian', sv: 'Swedish', ta: 'Tamil',
  te: 'Telugu', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian', ur: 'Urdu',
  vi: 'Vietnamese', zh: 'Chinese',
};

// Detected by eld but not translated by TranslateGemma.
export const UNSUPPORTED = ['am', 'az', 'be', 'eu', 'hy', 'ka', 'ku', 'lo', 'ms', 'or', 'sq', 'tl', 'yo'];

export const languageName = (code) => (Object.hasOwn(LANGUAGES, code) ? LANGUAGES[code] : code);

// NLLB-200 code (saved by older versions) -> ISO 639-1, for reading old chats.
export const LEGACY_NLLB_CODES = {
  amh_Ethi: 'am', arb_Arab: 'ar', azj_Latn: 'az', bel_Cyrl: 'be', bul_Cyrl: 'bg',
  ben_Beng: 'bn', cat_Latn: 'ca', ces_Latn: 'cs', dan_Latn: 'da', deu_Latn: 'de',
  ell_Grek: 'el', eng_Latn: 'en', spa_Latn: 'es', est_Latn: 'et', eus_Latn: 'eu',
  pes_Arab: 'fa', fin_Latn: 'fi', fra_Latn: 'fr', guj_Gujr: 'gu', heb_Hebr: 'he',
  hin_Deva: 'hi', hrv_Latn: 'hr', hun_Latn: 'hu', hye_Armn: 'hy', isl_Latn: 'is',
  ita_Latn: 'it', jpn_Jpan: 'ja', kat_Geor: 'ka', kan_Knda: 'kn', kor_Hang: 'ko',
  kmr_Latn: 'ku', lao_Laoo: 'lo', lit_Latn: 'lt', lvs_Latn: 'lv', mal_Mlym: 'ml',
  mar_Deva: 'mr', zsm_Latn: 'ms', nld_Latn: 'nl', nob_Latn: 'no', ory_Orya: 'or',
  pan_Guru: 'pa', pol_Latn: 'pl', por_Latn: 'pt', ron_Latn: 'ro', rus_Cyrl: 'ru',
  slk_Latn: 'sk', slv_Latn: 'sl', als_Latn: 'sq', srp_Cyrl: 'sr', swe_Latn: 'sv',
  tam_Taml: 'ta', tel_Telu: 'te', tha_Thai: 'th', tgl_Latn: 'tl', tur_Latn: 'tr',
  ukr_Cyrl: 'uk', urd_Arab: 'ur', vie_Latn: 'vi', yor_Latn: 'yo', zho_Hans: 'zh',
};

// Maps an NLLB code from an old chat file to ISO 639-1; anything else is kept.
export const fromLegacyCode = (lang) =>
  typeof lang === 'string' && Object.hasOwn(LEGACY_NLLB_CODES, lang) ? LEGACY_NLLB_CODES[lang] : lang;

// Default minimum number of Latin letters before detection is trusted ("ok", "hi" are unsure).
// Text with any non-Latin letter (Thai, CJK, ...) skips this check: its script alone is a strong
// signal, so short replies like "ใช่" or "你好" are still detected.
export const MIN_LETTERS = 3;

// Returns { kind: 'ok' | 'unsure' | 'unsupported', lang } with lang an ISO 639-1 code.
// Mixed-language text uses eld's top-scoring (dominant) language.
export function detectLanguage(text, { languages = LANGUAGES, minLength = MIN_LETTERS, detect = (s) => eld.detect(s).language } = {}) {
  const str = String(text ?? '');
  const nonLatin = /(?!\p{Script=Latin})\p{L}/u.test(str);
  const letters = str.match(/\p{L}/gu)?.length ?? 0;
  if (!nonLatin && letters < minLength) return { kind: 'unsure', lang: null };
  const code = detect(str);
  if (!code) return { kind: 'unsure', lang: null };
  return Object.hasOwn(languages, code) ? { kind: 'ok', lang: code } : { kind: 'unsupported', lang: null };
}

// Translate mode translates answers back with Claude, which writes every
// language: all 60 eld/medium languages (LANGUAGES and UNSUPPORTED).
export const REPLY_LANGUAGES = {
  ...LANGUAGES,
  ...Object.fromEntries(UNSUPPORTED.map((code) => [code, new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code])),
};
