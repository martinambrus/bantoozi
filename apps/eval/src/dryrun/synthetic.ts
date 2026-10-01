import type { CardStrength } from '@bantoozi/db';

import { seededRandom } from '../experiments/paired-auc.js';

/**
 * Synthetic data of `eval dry-run` (spec 10 §3 "Other commands", M3a-T8): English, Slovak and Czech
 * articles over eight topics in synthetic golden feeds, and four synthetic raters whose ratings
 * follow a hidden per-rater interest model (topic preferences plus seeded noise). Everything is a
 * pure function of the seed, so a dry run is reproducible.
 *
 * The texts are built for the in-process fakes (`@bantoozi/testing`): the fake TypeSafe answers a
 * card with p = 0.9 when a token of ≥ 4 characters of the card's interest occurs in the article's
 * title or excerpt. So each topic has a few language-neutral anchors (names such as SpaceX) and
 * English topic nouns, and its cards name both. Some Slovak and Czech articles carry no anchor:
 * their native text matches no card, while their translation (the fake LibreTranslate's exact
 * `translations` map) contains the English nouns, so the translation experiments have something to
 * measure. Filler text never shares a card token (a unit test checks this).
 */

export const DRYRUN_LANGS = ['en', 'sk', 'cs'] as const;
export type DryRunLang = (typeof DRYRUN_LANGS)[number];

export type TopicId =
  'space' | 'football' | 'ev' | 'ai' | 'crypto' | 'cooking' | 'politics' | 'gaming';

/** A phrase; `{A}` is replaced by one of the topic's anchors. `en` is the English translation. */
interface Phrase {
  text: string;
  en: string;
}

export interface TopicDefinition {
  id: TopicId;
  /** `topic_l1` of the taxonomy (spec 05 §3.2), used for the owner's facet labels. */
  taxonomy: string;
  anchors: readonly string[];
  /** The English card text that names this topic. */
  cardEn: string;
  /** Phrases per language; English phrases translate to themselves. */
  phrases: Record<DryRunLang, readonly Phrase[]>;
  /** Time-sensitive in the facet labels. */
  timeSensitive: boolean;
}

const en = (text: string): Phrase => ({ text, en: text });

export const TOPICS: readonly TopicDefinition[] = [
  {
    id: 'space',
    taxonomy: 'science',
    anchors: ['SpaceX', 'NASA'],
    cardEn: 'SpaceX and NASA rockets, astronomy and telescopes',
    timeSensitive: false,
    phrases: {
      en: [
        en('{A} prepares the next launch window'),
        en('Astronomy: telescopes reveal a distant galaxy'),
        en('{A} test flight ends early'),
        en('Rockets and budgets: what {A} plans next'),
      ],
      sk: [
        { text: '{A} pripravuje ďalší štart', en: '{A} prepares the next launch' },
        { text: 'Hvezdári objavili vzdialenú galaxiu', en: 'Astronomy: a distant galaxy found' },
        { text: 'Skúšobný let {A} sa skončil skôr', en: '{A} test flight ended early' },
        { text: 'Nové ďalekohľady mieria do vesmíru', en: 'New telescopes aim at deep space' },
      ],
      cs: [
        { text: '{A} chystá další start', en: '{A} prepares the next launch' },
        { text: 'Hvězdáři zahlédli vzdálenou galaxii', en: 'Astronomy: a distant galaxy seen' },
        { text: 'Zkušební let {A} skončil dříve', en: '{A} test flight ended early' },
        { text: 'Nové dalekohledy míří do vesmíru', en: 'New telescopes aim at deep space' },
      ],
    },
  },
  {
    id: 'football',
    taxonomy: 'sports',
    anchors: ['Liverpool', 'Barcelona'],
    cardEn: 'Football transfers, Liverpool and Barcelona',
    timeSensitive: true,
    phrases: {
      en: [
        en('{A} wins the derby after extra time'),
        en('Football transfers: {A} signs a young striker'),
        en('{A} coach under pressure before the final'),
        en('Football: the league table after round twelve'),
      ],
      sk: [
        { text: '{A} vyhral derby po predĺžení', en: '{A} won the derby after extra time' },
        { text: 'Prestupy: {A} podpísal mladého útočníka', en: 'Transfers: {A} signs a striker' },
        { text: 'Tréner {A} pod tlakom pred finále', en: '{A} coach under pressure' },
        { text: 'Tabuľka ligy po dvanástom kole', en: 'Football league table after round twelve' },
      ],
      cs: [
        { text: '{A} vyhrál derby po prodloužení', en: '{A} won the derby after extra time' },
        { text: 'Přestupy: {A} podepsal mladého útočníka', en: 'Transfers: {A} signs a striker' },
        { text: 'Trenér {A} pod tlakem před finále', en: '{A} coach under pressure' },
        { text: 'Tabulka ligy po dvanáctém kole', en: 'Football league table after round twelve' },
      ],
    },
  },
  {
    id: 'ev',
    taxonomy: 'transport',
    anchors: ['Tesla', 'Škoda'],
    cardEn: 'Electric cars, Tesla and Škoda, batteries and charging',
    timeSensitive: false,
    phrases: {
      en: [
        en('{A} cuts the price of its electric model'),
        en('Charging stations double along the motorway'),
        en('{A} unveils a cheaper battery pack'),
        en('Batteries: how long do they really last'),
      ],
      sk: [
        { text: '{A} zlacňuje svoj elektromobil', en: '{A} cuts the price of its electric car' },
        { text: 'Nabíjačiek pri diaľnici pribúda', en: 'Charging points multiply along roads' },
        { text: '{A} predstavila lacnejšiu batériu', en: '{A} unveils a cheaper battery' },
        { text: 'Ako dlho naozaj vydrží akumulátor', en: 'Batteries: how long do they last' },
      ],
      cs: [
        { text: '{A} zlevňuje svůj elektromobil', en: '{A} cuts the price of its electric car' },
        { text: 'Nabíječek u dálnice přibývá', en: 'Charging points multiply along roads' },
        { text: '{A} představila levnější baterii', en: '{A} unveils a cheaper battery' },
        { text: 'Jak dlouho opravdu vydrží akumulátor', en: 'Batteries: how long do they last' },
      ],
    },
  },
  {
    id: 'ai',
    taxonomy: 'technology',
    anchors: ['OpenAI', 'ChatGPT'],
    cardEn: 'OpenAI, ChatGPT, chatbots and machine learning',
    timeSensitive: false,
    phrases: {
      en: [
        en('{A} releases a faster model'),
        en('Chatbots enter the classroom'),
        en('{A} faces questions over training data'),
        en('Machine learning spots defects on the assembly line'),
      ],
      sk: [
        { text: '{A} vydal rýchlejší model', en: '{A} releases a faster model' },
        { text: 'Konverzační roboti vstupujú do škôl', en: 'Chatbots enter schools' },
        { text: '{A} čelí otázkam o trénovacích dátach', en: '{A} faces questions on its data' },
        {
          text: 'Strojové učenie odhalí chyby výroby',
          en: 'Machine learning spots factory defects',
        },
      ],
      cs: [
        { text: '{A} vydal rychlejší model', en: '{A} releases a faster model' },
        { text: 'Konverzační roboti vstupují do škol', en: 'Chatbots enter schools' },
        { text: '{A} čelí otázkám o trénovacích datech', en: '{A} faces questions on its data' },
        { text: 'Strojové učení odhalí vady výroby', en: 'Machine learning spots factory defects' },
      ],
    },
  },
  {
    id: 'crypto',
    taxonomy: 'economy',
    anchors: ['Bitcoin', 'Ethereum'],
    cardEn: 'Bitcoin, Ethereum, cryptocurrency and blockchain',
    timeSensitive: true,
    phrases: {
      en: [
        en('{A} jumps after an exchange listing'),
        en('Blockchain payments reach small shops'),
        en('{A} miners move north for cheap power'),
        en('Cryptocurrency rules tighten across the union'),
      ],
      sk: [
        { text: '{A} vyskočil po zalistovaní na burze', en: '{A} jumps after an exchange listing' },
        { text: 'Platby cez reťazec blokov v obchodoch', en: 'Blockchain payments in shops' },
        { text: 'Ťažiari {A} sa sťahujú na sever', en: '{A} miners move north' },
        { text: 'Pravidlá pre kryptomeny sa sprísňujú', en: 'Cryptocurrency rules tighten' },
      ],
      cs: [
        { text: '{A} vyskočil po zalistování na burze', en: '{A} jumps after an exchange listing' },
        { text: 'Platby přes řetězec bloků v obchodech', en: 'Blockchain payments in shops' },
        { text: 'Těžaři {A} se stěhují na sever', en: '{A} miners move north' },
        { text: 'Pravidla pro kryptoměny se zpřísňují', en: 'Cryptocurrency rules tighten' },
      ],
    },
  },
  {
    id: 'cooking',
    taxonomy: 'lifestyle',
    anchors: ['Michelin', 'Ramsay'],
    cardEn: 'Cooking, recipes and baking, Michelin and Ramsay restaurants',
    timeSensitive: false,
    phrases: {
      en: [
        en('{A} guide adds two bistros'),
        en('Five autumn recipes with pumpkin'),
        en('{A} opens a tasting kitchen'),
        en('Baking sourdough at home without stress'),
      ],
      sk: [
        { text: 'Sprievodca {A} pridal dve bistrá', en: '{A} guide adds two bistros' },
        { text: 'Päť jesenných receptov s tekvicou', en: 'Five autumn recipes with pumpkin' },
        { text: '{A} otvára degustačnú kuchyňu', en: '{A} opens a tasting kitchen' },
        { text: 'Pečenie kvásku doma bez stresu', en: 'Baking sourdough at home' },
      ],
      cs: [
        { text: 'Průvodce {A} přidal dvě bistra', en: '{A} guide adds two bistros' },
        { text: 'Pět podzimních receptů s dýní', en: 'Five autumn recipes with pumpkin' },
        { text: '{A} otevírá degustační kuchyni', en: '{A} opens a tasting kitchen' },
        { text: 'Pečení kvásku doma bez stresu', en: 'Baking sourdough at home' },
      ],
    },
  },
  {
    id: 'politics',
    taxonomy: 'politics',
    anchors: ['Brussels', 'NATO'],
    cardEn: 'Elections, parliament and coalition politics, Brussels and NATO',
    timeSensitive: true,
    phrases: {
      en: [
        en('{A} summit ends without a deal'),
        en('Coalition talks stall over the budget'),
        en('{A} envoy visits the capital'),
        en('Parliament votes on the new elections law'),
      ],
      sk: [
        { text: 'Samit v {A} sa skončil bez dohody', en: '{A} summit ends without a deal' },
        { text: 'Koaličné rokovania uviazli na rozpočte', en: 'Coalition talks stall' },
        { text: 'Vyslanec {A} navštívil hlavné mesto', en: '{A} envoy visits the capital' },
        { text: 'Snem hlasuje o novom volebnom zákone', en: 'Parliament votes on elections law' },
      ],
      cs: [
        { text: 'Summit {A} skončil bez dohody', en: '{A} summit ends without a deal' },
        { text: 'Koaliční jednání uvázla na rozpočtu', en: 'Coalition talks stall' },
        { text: 'Vyslanec {A} navštívil hlavní město', en: '{A} envoy visits the capital' },
        {
          text: 'Sněmovna hlasuje o novém volebním zákoně',
          en: 'Parliament votes on elections law',
        },
      ],
    },
  },
  {
    id: 'gaming',
    taxonomy: 'gaming',
    anchors: ['Nintendo', 'PlayStation'],
    cardEn: 'Video games and consoles, Nintendo and PlayStation',
    timeSensitive: false,
    phrases: {
      en: [
        en('{A} announces a handheld successor'),
        en('Consoles get pricier before the holidays'),
        en('{A} exclusive tops the charts'),
        en('Video games studio lays off staff'),
      ],
      sk: [
        {
          text: '{A} ohlásil nástupcu prenosnej konzoly',
          en: '{A} announces a handheld successor',
        },
        { text: 'Herné konzoly pred sviatkami zdražejú', en: 'Consoles get pricier' },
        { text: 'Exkluzivita {A} vedie rebríčky', en: '{A} exclusive tops the charts' },
        { text: 'Herné štúdio prepúšťa zamestnancov', en: 'Video games studio lays off staff' },
      ],
      cs: [
        { text: '{A} ohlásil nástupce přenosné konzole', en: '{A} announces a handheld successor' },
        { text: 'Herní konzole před svátky zdraží', en: 'Consoles get pricier' },
        { text: 'Exkluzivita {A} vede žebříčky', en: '{A} exclusive tops the charts' },
        { text: 'Herní studio propouští zaměstnance', en: 'Video games studio lays off staff' },
      ],
    },
  },
];

export const TOPIC_BY_ID: ReadonlyMap<TopicId, TopicDefinition> = new Map(
  TOPICS.map((t) => [t.id, t]),
);

/** Filler sentences of the excerpts (never sharing a card token). */
const EXCERPT_TAILS: Record<DryRunLang, readonly Phrase[]> = {
  en: [en('Details are in the full story.'), en('Our correspondent reports.')],
  sk: [
    { text: 'Podrobnosti nájdete v článku.', en: 'Details are in the full story.' },
    { text: 'Informuje náš spravodajca.', en: 'Our correspondent reports.' },
  ],
  cs: [
    { text: 'Podrobnosti najdete v článku.', en: 'Details are in the full story.' },
    { text: 'Informuje náš zpravodaj.', en: 'Our correspondent reports.' },
  ],
};

/** A clickbait prefix (the hidden model likes these less). */
const CLICKBAIT: Record<DryRunLang, Phrase> = {
  en: en('You will not guess:'),
  sk: { text: 'Neuveríte:', en: 'You will not guess:' },
  cs: { text: 'Neuvěříte:', en: 'You will not guess:' },
};

export interface SyntheticFeed {
  key: string;
  lang: DryRunLang;
  title: string;
  url: string;
}

export interface SyntheticArticle {
  key: string;
  feedKey: string;
  lang: DryRunLang;
  topic: TopicId;
  title: string;
  excerpt: string;
  /** The English text the fake LibreTranslate returns (equal to the text for English). */
  titleEn: string;
  excerptEn: string;
  /** Carries a language-neutral anchor (a card matches the native text). */
  anchored: boolean;
  clickbait: boolean;
  wordCount: number;
  publishedAt: Date;
  url: string;
}

export interface CorpusOptions {
  seed: string;
  /** Articles generated per language (the sample then draws from them). */
  perLang: number;
  feedsPerLang: number;
  now: Date;
  /** Spread of publication times before `now`. */
  days: number;
}

export interface Corpus {
  feeds: SyntheticFeed[];
  articles: SyntheticArticle[];
  /** Exact source text → English, for the fake LibreTranslate. */
  translations: Record<string, string>;
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  const item = list[Math.floor(rng() * list.length)];
  if (item === undefined) throw new RangeError('empty list');
  return item;
}

export function generateCorpus(options: CorpusOptions): Corpus {
  const rng = seededRandom(`${options.seed}|corpus`);
  const feeds: SyntheticFeed[] = [];
  const articles: SyntheticArticle[] = [];
  const translations: Record<string, string> = {};
  for (const lang of DRYRUN_LANGS) {
    const langFeeds: SyntheticFeed[] = [];
    for (let i = 1; i <= options.feedsPerLang; i += 1) {
      const n = String(i).padStart(2, '0');
      const feed = {
        key: `${lang}-${n}`,
        lang,
        title: `Dry-run ${lang.toUpperCase()} ${n}`,
        url: `https://dryrun-${lang}-${n}.bantoozi.invalid/feed.xml`,
      };
      langFeeds.push(feed);
      feeds.push(feed);
    }
    for (let i = 0; i < options.perLang; i += 1) {
      const topic = TOPICS[i % TOPICS.length] as TopicDefinition;
      const phrase = pick(rng, topic.phrases[lang]);
      const anchor = pick(rng, topic.anchors);
      const anchored = phrase.text.includes('{A}');
      const clickbait = rng() < 0.1;
      const number = i + 1;
      const fill = (text: string) => text.replaceAll('{A}', anchor);
      const prefix = clickbait ? `${CLICKBAIT[lang].text} ` : '';
      const prefixEn = clickbait ? `${CLICKBAIT[lang].en} ` : '';
      const title = `${prefix}${fill(phrase.text)} (${number})`;
      const titleEn = `${prefixEn}${fill(phrase.en)} (${number})`;
      const tail = pick(rng, EXCERPT_TAILS[lang]);
      const excerpt = `${fill(phrase.text)}. ${tail.text}`;
      const excerptEn = `${fill(phrase.en)}. ${tail.en}`;
      if (lang !== 'en') {
        translations[title] = titleEn;
        translations[excerpt] = excerptEn;
      }
      const feed = langFeeds[i % langFeeds.length] as SyntheticFeed;
      const publishedAt = new Date(
        options.now.getTime() - Math.floor(rng() * options.days * 86_400_000) - 3_600_000,
      );
      articles.push({
        key: `${lang}-${number}`,
        feedKey: feed.key,
        lang,
        topic: topic.id,
        title,
        excerpt,
        titleEn,
        excerptEn,
        anchored,
        clickbait,
        wordCount: 150 + Math.floor(rng() * 1350),
        publishedAt,
        url: `https://dryrun-${lang}.bantoozi.invalid/articles/${number}`,
      });
    }
  }
  return { feeds, articles, translations };
}

// ── Raters ──────────────────────────────────────────────────────────────────────────────────────

export interface PersonaCard {
  topic: TopicId;
  strength: CardStrength;
  lang: string;
  interest: string;
  /**
   * The English text the fake LibreTranslate returns for a non-English card. Non-English card
   * texts are long enough for the unhinted language detector to read them as their language
   * (spec 07 §5), so English-card runs really translate them.
   */
  interestEn: string;
}

export interface Persona {
  key: string;
  name: string;
  langs: readonly DryRunLang[];
  /** Hidden interest model: topic → base probability of a like. */
  likes: Partial<Record<TopicId, number>>;
  /** Base like probability of every other topic. */
  otherLike: number;
  cards: readonly PersonaCard[];
}

const card = (topic: TopicId, strength: CardStrength): PersonaCard => {
  const text = TOPIC_BY_ID.get(topic)?.cardEn ?? topic;
  return { topic, strength, lang: 'en', interest: text, interestEn: text };
};

/**
 * The four synthetic raters: four distinct participants (one context each), so the gate runs as
 * `multi_person_beta`. Rater C writes Slovak cards (exercising E2's English card text).
 */
export const PERSONAS: readonly Persona[] = [
  {
    key: 'a',
    name: 'Dry-run Alena',
    langs: ['en', 'sk'],
    likes: { space: 0.9, ev: 0.75, football: 0.7, crypto: 0.02 },
    otherLike: 0.1,
    cards: [
      card('space', 'love'),
      card('ev', 'like'),
      card('football', 'like'),
      card('crypto', 'never'),
    ],
  },
  {
    key: 'b',
    name: 'Dry-run Boris',
    langs: ['en', 'cs'],
    likes: { ai: 0.9, gaming: 0.75, politics: 0.02 },
    otherLike: 0.12,
    cards: [card('ai', 'love'), card('gaming', 'like'), card('politics', 'never')],
  },
  {
    key: 'c',
    name: 'Dry-run Cyril',
    langs: ['sk', 'cs'],
    likes: { football: 0.9, cooking: 0.75, politics: 0.7 },
    otherLike: 0.1,
    cards: [
      {
        topic: 'football',
        strength: 'love',
        lang: 'sk',
        interest:
          'Futbalové prestupy a zápasy, najmä kluby Liverpool a Barcelona, ktoré ma zaujímajú',
        interestEn: 'Football transfers, Liverpool and Barcelona clubs',
      },
      {
        topic: 'cooking',
        strength: 'like',
        lang: 'sk',
        interest:
          'Varenie a pečenie doma, recepty na jedlá, ktoré ma zaujímajú, reštaurácie Michelin a Ramsay',
        interestEn: 'Cooking, recipes and baking, Michelin and Ramsay restaurants',
      },
      {
        topic: 'politics',
        strength: 'like',
        lang: 'sk',
        interest:
          'Voľby do parlamentu a koaličná politika vlády, ktorá ma zaujíma, Brussels a NATO',
        interestEn: 'Elections, parliament and coalition politics, Brussels and NATO',
      },
    ],
  },
  {
    key: 'd',
    name: 'Dry-run Dana',
    langs: ['en', 'sk', 'cs'],
    likes: { ev: 0.9, space: 0.7, cooking: 0.75, gaming: 0.03 },
    otherLike: 0.1,
    cards: [
      card('ev', 'love'),
      card('space', 'like'),
      card('cooking', 'like'),
      card('gaming', 'never'),
    ],
  },
];

/** Exact card text → English, for the fake LibreTranslate. */
export function cardTranslations(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const persona of PERSONAS) {
    for (const c of persona.cards) if (c.lang !== 'en') out[c.interest] = c.interestEn;
  }
  return out;
}

export interface SyntheticRating {
  rating: 1 | -1;
  reason: 'off_topic' | 'clickbait' | 'shallow' | null;
}

/**
 * The hidden model: P(like) is the rater's topic preference, lowered for clickbait, with seeded
 * noise per (rater, article). A dislike of an unpreferred topic is `off_topic`.
 */
export function rateSynthetic(
  seed: string,
  persona: Persona,
  article: Pick<SyntheticArticle, 'key' | 'topic' | 'clickbait'>,
): SyntheticRating {
  const rng = seededRandom(`${seed}|rate|${persona.key}|${article.key}`);
  const preferred = persona.likes[article.topic];
  let p = preferred ?? persona.otherLike;
  if (article.clickbait) p *= 0.6;
  if (rng() < p) return { rating: 1, reason: null };
  if (article.clickbait) return { rating: -1, reason: 'clickbait' };
  return {
    rating: -1,
    reason: preferred === undefined || preferred < 0.5 ? 'off_topic' : 'shallow',
  };
}
