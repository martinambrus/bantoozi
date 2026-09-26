import { normalizeText } from '@bantoozi/shared';

/**
 * Small built-in stop-word lists for the BM25 tokenizer (spec 06 §9), about 150 words each. They are
 * written as spelled and compared after `normalizeText`, which strips diacritics, so the Slovak and
 * Czech lists overlap and one set serves every language. Words that normalize to a content word of
 * another supported language are left out (Czech/Slovak `most` "bridge", Slovak `byť` → `byt`
 * "flat", Czech `tým` "team", English `us` "US", Czech `těch` → `tech`, `více` → `vice`, …).
 * Single letters are not listed: the tokenizer drops every token shorter than two characters.
 */

// The last line holds the stems that splitting on the apostrophe leaves ("don't" → "don").
const EN = `
  about above after again against all also am among an and another any are as at be because been
  before being below between both but by can could did do does doing down during each every few for
  from further had has have having he her here hers herself him himself his how however if in into
  is it its itself just may me might more must my myself no nor not now of off on once only or other
  our ours ourselves out over own said same says she should since so some such than that the their
  theirs them themselves then there these they this those through to too under until up very was we
  were what when where which while who whom whose why will with within without would you your yours
  yourself yourselves
  don aren couldn didn doesn hadn hasn haven isn shouldn wasn weren wouldn ll re ve`;

const SK = `
  aby aj ak ako aká aké aký ale alebo ani áno asi až bez bol bola boli bolo bude budem budeme budete
  budú by cez čo či ďalší do ešte ho iba ich im ja je jeho jej jemu ju kam kde kedy keď kto ktorá
  ktoré ktorej ktorí ktorú ktorý ktorých ktorým ku každý kvôli lebo len ma má majú mal mala malo
  medzi mi mne mnou mohol moja moje môj môže môžu my na nad nám nás náš naše nech než nie niečo nič
  no od okrem on ona oni ono ony po počas pod podľa potom práve pre pred preto pretože prečo pri
  proti sa si sme so som ste sú svoj svoje ta tá tak takže tam teda tej ten tento tí tie tieto tiež
  to toho tom tomu toto tu tú tých už vám vás váš vaše veľmi viac vo však všetko všetky vy za zo že`;

const CS = `
  aby ale ani ano asi až během bez bude budeme budete budou budu by bych byl byla byli bylo byly co
  což či další díky do ho jak jako je jeho jej její jejich jen ještě ji jí jim jsem jsi jsme jsou
  jste kam kde kdo kdy když ke kromě která které kterou který kteří kterých kvůli má mají mám máme
  mé mezi mi mimo mne mně mnou můj může mohl mohla mohli mohou my na nad nám nás náš naše ne nebo
  něco nějaký není než nic od on ona oni ono ony pak po pod podle pokud pouze právě pro proč proti
  proto protože před přes při se si své svou svůj svých ta tady tak také takže tam té tedy ten tento
  této to toho tom tomu toto tu tuto ty tyto už vám vás váš vaše ve však všechno všechny vy za zda
  zde ze že`;

function words(list: string): readonly string[] {
  return Object.freeze(list.split(/\s+/u).filter((word) => word !== ''));
}

export const STOP_WORDS_EN = words(EN);
export const STOP_WORDS_SK = words(SK);
export const STOP_WORDS_CS = words(CS);

/** The union of the three lists, normalized like the tokens they filter. */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  [...STOP_WORDS_EN, ...STOP_WORDS_SK, ...STOP_WORDS_CS].map(normalizeText),
);
