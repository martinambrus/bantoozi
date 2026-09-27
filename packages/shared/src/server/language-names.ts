import { normalizeLanguageHint } from './language.js';

/**
 * English names of the ISO 639-1 languages, e.g. `sk` → `Slovak`, `cs` → `Czech`. The tier-2
 * system prompt names the source language (spec 07 §3) and the article state names the language
 * too (spec 05 §3.1, `language: "Slovak"`), so the names are pinned here instead of read from the
 * runtime's ICU data: a Node upgrade must not change a prompt or a state hash.
 *
 * Every code that `normalizeLanguageHint` accepts has a name. The names follow ISO 639-1's English
 * names in their common short form.
 */
const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map(
  (
    'aa Afar|ab Abkhazian|ae Avestan|af Afrikaans|ak Akan|am Amharic|an Aragonese|ar Arabic|' +
    'as Assamese|av Avaric|ay Aymara|az Azerbaijani|ba Bashkir|be Belarusian|bg Bulgarian|' +
    'bh Bihari|bi Bislama|bm Bambara|bn Bengali|bo Tibetan|br Breton|bs Bosnian|ca Catalan|' +
    'ce Chechen|ch Chamorro|co Corsican|cr Cree|cs Czech|cu Church Slavic|cv Chuvash|cy Welsh|' +
    'da Danish|de German|dv Divehi|dz Dzongkha|ee Ewe|el Greek|en English|eo Esperanto|' +
    'es Spanish|et Estonian|eu Basque|fa Persian|ff Fula|fi Finnish|fj Fijian|fo Faroese|' +
    'fr French|fy Western Frisian|ga Irish|gd Scottish Gaelic|gl Galician|gn Guarani|' +
    'gu Gujarati|gv Manx|ha Hausa|he Hebrew|hi Hindi|ho Hiri Motu|hr Croatian|ht Haitian Creole|' +
    'hu Hungarian|hy Armenian|hz Herero|ia Interlingua|id Indonesian|ie Interlingue|ig Igbo|' +
    'ii Sichuan Yi|ik Inupiaq|io Ido|is Icelandic|it Italian|iu Inuktitut|ja Japanese|' +
    'jv Javanese|ka Georgian|kg Kongo|ki Kikuyu|kj Kuanyama|kk Kazakh|kl Kalaallisut|km Khmer|' +
    'kn Kannada|ko Korean|kr Kanuri|ks Kashmiri|ku Kurdish|kv Komi|kw Cornish|ky Kyrgyz|' +
    'la Latin|lb Luxembourgish|lg Ganda|li Limburgish|ln Lingala|lo Lao|lt Lithuanian|' +
    'lu Luba-Katanga|lv Latvian|mg Malagasy|mh Marshallese|mi Maori|mk Macedonian|' +
    'ml Malayalam|mn Mongolian|mr Marathi|ms Malay|mt Maltese|my Burmese|na Nauru|' +
    'nb Norwegian Bokmål|nd North Ndebele|ne Nepali|ng Ndonga|nl Dutch|nn Norwegian Nynorsk|' +
    'no Norwegian|nr South Ndebele|nv Navajo|ny Nyanja|oc Occitan|oj Ojibwa|om Oromo|or Odia|' +
    'os Ossetian|pa Punjabi|pi Pali|pl Polish|ps Pashto|pt Portuguese|qu Quechua|rm Romansh|' +
    'rn Rundi|ro Romanian|ru Russian|rw Kinyarwanda|sa Sanskrit|sc Sardinian|sd Sindhi|' +
    'se Northern Sami|sg Sango|si Sinhala|sk Slovak|sl Slovenian|sm Samoan|sn Shona|so Somali|' +
    'sq Albanian|sr Serbian|ss Swati|st Southern Sotho|su Sundanese|sv Swedish|sw Swahili|' +
    'ta Tamil|te Telugu|tg Tajik|th Thai|ti Tigrinya|tk Turkmen|tl Tagalog|tn Tswana|to Tongan|' +
    'tr Turkish|ts Tsonga|tt Tatar|tw Twi|ty Tahitian|ug Uyghur|uk Ukrainian|ur Urdu|uz Uzbek|' +
    've Venda|vi Vietnamese|vo Volapük|wa Walloon|wo Wolof|xh Xhosa|yi Yiddish|yo Yoruba|' +
    'za Zhuang|zh Chinese|zu Zulu'
  )
    .split('|')
    .map((entry): [string, string] => {
      const space = entry.indexOf(' ');
      return [entry.slice(0, space), entry.slice(space + 1)];
    }),
);

/**
 * The English name of an ISO 639-1 language (a BCP 47 tag such as `sk-SK` is reduced to its base
 * language first), or `undefined` for `und` and anything that is not an ISO 639-1 code.
 */
export function languageName(code: string | null | undefined): string | undefined {
  const base = normalizeLanguageHint(code);
  return base === undefined ? undefined : LANGUAGE_NAMES.get(base);
}
