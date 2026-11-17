// Offline language detection (eld, medium database: 60 languages, no network).
import { eld } from 'eld/medium';

// eld (ISO 639-1) -> NLLB-200 code. Covers every language eld/medium returns.
export const NLLB_CODES = {
  am: 'amh_Ethi', ar: 'arb_Arab', az: 'azj_Latn', be: 'bel_Cyrl', bg: 'bul_Cyrl',
  bn: 'ben_Beng', ca: 'cat_Latn', cs: 'ces_Latn', da: 'dan_Latn', de: 'deu_Latn',
  el: 'ell_Grek', en: 'eng_Latn', es: 'spa_Latn', et: 'est_Latn', eu: 'eus_Latn',
  fa: 'pes_Arab', fi: 'fin_Latn', fr: 'fra_Latn', gu: 'guj_Gujr', he: 'heb_Hebr',
  hi: 'hin_Deva', hr: 'hrv_Latn', hu: 'hun_Latn', hy: 'hye_Armn', is: 'isl_Latn',
  it: 'ita_Latn', ja: 'jpn_Jpan', ka: 'kat_Geor', kn: 'kan_Knda', ko: 'kor_Hang',
  ku: 'kmr_Latn', lo: 'lao_Laoo', lt: 'lit_Latn', lv: 'lvs_Latn', ml: 'mal_Mlym',
  mr: 'mar_Deva', ms: 'zsm_Latn', nl: 'nld_Latn', no: 'nob_Latn', or: 'ory_Orya',
  pa: 'pan_Guru', pl: 'pol_Latn', pt: 'por_Latn', ro: 'ron_Latn', ru: 'rus_Cyrl',
  sk: 'slk_Latn', sl: 'slv_Latn', sq: 'als_Latn', sr: 'srp_Cyrl', sv: 'swe_Latn',
  ta: 'tam_Taml', te: 'tel_Telu', th: 'tha_Thai', tl: 'tgl_Latn', tr: 'tur_Latn',
  uk: 'ukr_Cyrl', ur: 'urd_Arab', vi: 'vie_Latn', yo: 'yor_Latn', zh: 'zho_Hans',
};

// Default minimum number of Latin letters before detection is trusted ("ok", "hi" are unsure).
// Text with any non-Latin letter (Thai, CJK, ...) skips this check: its script alone is a strong
// signal, so short replies like "ใช่" or "你好" are still detected.
export const MIN_LETTERS = 3;

// Returns { kind: 'ok' | 'unsure' | 'unsupported', lang }.
// Mixed-language text uses eld's top-scoring (dominant) language.
export function detectLanguage(text, { mapping = NLLB_CODES, minLength = MIN_LETTERS } = {}) {
  const str = String(text ?? '');
  const nonLatin = /(?!\p{Script=Latin})\p{L}/u.test(str);
  const letters = str.match(/\p{L}/gu)?.length ?? 0;
  if (!nonLatin && letters < minLength) return { kind: 'unsure', lang: null };
  const code = eld.detect(str).language;
  if (!code) return { kind: 'unsure', lang: null };
  const lang = Object.hasOwn(mapping, code) ? mapping[code] : null;
  return lang ? { kind: 'ok', lang } : { kind: 'unsupported', lang: null };
}
