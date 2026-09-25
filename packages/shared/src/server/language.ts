import { francAll } from 'franc-all';

/**
 * `detectLanguage(text, { hint?, minLength? = 40 })` — spec 03 §8.3. Pure. For articles the input is
 * `title + ' ' + excerpt + ' ' + body_lead.slice(0, 1000)` and the hint is `feeds.lang_hint`; for card
 * texts the hint is the user's locale with `minLength: 10` (spec 07 §5).
 *
 * `confidence` is the detector's relative separation score between its best two candidates, not a
 * calibrated probability of correctness.
 */
export interface DetectLanguageOptions {
  hint?: string | null | undefined;
  minLength?: number;
}

export interface DetectedLanguage {
  /** ISO 639-1 code, or `und`. */
  lang: string;
  confidence: number;
}

/** Restricted detector whitelist (ISO 639-3 → ISO 639-1). */
const DETECTOR_LANGUAGES = {
  eng: 'en',
  slk: 'sk',
  ces: 'cs',
  deu: 'de',
  pol: 'pl',
  hun: 'hu',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  ukr: 'uk',
  rus: 'ru',
} as const satisfies Record<string, string>;

type DetectorCode = keyof typeof DETECTOR_LANGUAGES;
const DETECTOR_CODES = Object.keys(DETECTOR_LANGUAGES) as DetectorCode[];
const DETECTOR_ISO1 = new Set<string>(Object.values(DETECTOR_LANGUAGES));

/** All ISO 639-1 codes: a publisher hint must be one of these to be used. */
const ISO_639_1 = new Set(
  (
    'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da ' +
    'de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ' +
    'ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln ' +
    'lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi ' +
    'pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti ' +
    'tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'
  ).split(' '),
);

const DEFAULT_MIN_LENGTH = 40;
const LOW_CONFIDENCE = 0.05;
const SK_CS_TIE = 0.15;

/**
 * Normalize a hint such as `sv-SE`, `cs_CZ` or `SK` to a valid ISO 639-1 base language, or
 * `undefined` when it is not one.
 */
export function normalizeLanguageHint(hint: string | null | undefined): string | undefined {
  if (hint === null || hint === undefined) return undefined;
  const base = hint.trim().toLowerCase().split(/[-_]/u)[0] ?? '';
  return ISO_639_1.has(base) ? base : undefined;
}

export function detectLanguage(
  text: string,
  options: DetectLanguageOptions = {},
): DetectedLanguage {
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  const hint = normalizeLanguageHint(options.hint);
  const value = text.trim();

  // 1. Too short: the hint or `und`, confidence 0.
  if ([...value].length < minLength) return { lang: hint ?? 'und', confidence: 0 };

  // 2. A valid publisher hint outside the whitelist is kept without running the detector: the
  //    restricted detector cannot return that language, so it never overrides the publisher.
  if (hint !== undefined && !DETECTOR_ISO1.has(hint)) return { lang: hint, confidence: 0 };

  // 3–4. Restricted detector; read the best two valid tuples explicitly.
  const scored = francAll(value, {
    only: DETECTOR_CODES,
    minLength: Math.min(20, minLength),
  }).filter((tuple): tuple is [DetectorCode, number] =>
    Object.hasOwn(DETECTOR_LANGUAGES, tuple[0]),
  );
  const top = scored[0];
  const second = scored[1];
  if (top === undefined) return { lang: hint ?? 'und', confidence: 0 };
  const confidence = second === undefined ? 0 : top[1] - second[1];

  // 5. Low separation with a hint: use the hint.
  if (confidence < LOW_CONFIDENCE && hint !== undefined) return { lang: hint, confidence };

  // 6. Slovak/Czech tie-break.
  if (
    second !== undefined &&
    new Set([top[0], second[0]]).size === 2 &&
    [top[0], second[0]].every((c) => c === 'slk' || c === 'ces') &&
    confidence < SK_CS_TIE &&
    (hint === 'sk' || hint === 'cs')
  ) {
    return { lang: hint, confidence };
  }

  // 7. Map ISO 639-3 to 639-1.
  return { lang: DETECTOR_LANGUAGES[top[0]], confidence };
}
