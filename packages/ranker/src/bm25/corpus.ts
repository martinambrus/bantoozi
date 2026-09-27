import type { RankItem } from '../types.js';
import { tokenize } from './tokenize.js';

/** The article text BM25 reads (`RankItem` fields, spec 06 §1). */
export type Bm25Text = Pick<
  RankItem,
  'titleNorm' | 'excerptNorm' | 'translatedTitleNorm' | 'translatedExcerptNorm'
>;

/** Whether the article has a selected translation (always English, spec 07). */
export function hasTranslation(text: Bm25Text): boolean {
  return text.translatedTitleNorm !== undefined || text.translatedExcerptNorm !== undefined;
}

/**
 * The BM25 document (spec 06 §9): the title twice, then the excerpt. `original` is the article's
 * own text; `translated` is the translation's, or `null` without one. The §9 document is the
 * translated text when a translation exists, else the original.
 */
export interface Bm25DocumentTokens {
  original: readonly string[];
  translated: readonly string[] | null;
}

export function bm25DocumentTokens(text: Bm25Text): Bm25DocumentTokens {
  return {
    original: documentTokens(text.titleNorm, text.excerptNorm),
    translated: hasTranslation(text)
      ? documentTokens(text.translatedTitleNorm ?? '', text.translatedExcerptNorm ?? '')
      : null,
  };
}

function documentTokens(title: string, excerpt: string): string[] {
  const titleTokens = tokenize(title);
  return [...titleTokens, ...titleTokens, ...tokenize(excerpt)];
}

/** Corpus statistics of one document variant. */
export interface Bm25TermStats {
  /** N: the number of documents. */
  documents: number;
  /** The mean document length in tokens; 0 for an empty corpus. */
  avgLength: number;
  /** Document frequency per term: the number of documents containing it. */
  df: ReadonlyMap<string, number>;
}

/**
 * Corpus statistics over the user's whole rank window (spec 06 §9), computed once per rank run, so
 * a score never depends on which items happen to be dirty. `preferred` counts each article's §9
 * document (the translated text when a translation exists); `original` counts every article's own
 * text, for the fallback that scores an article's original text because the card has no English
 * query (see `bm25Pairing`). Without any translation both are the same object.
 */
export interface Bm25Corpus {
  preferred: Bm25TermStats;
  original: Bm25TermStats;
}

/**
 * Builds the corpus from every article in the window: the handler passes all inference-eligible
 * window articles (spec 06 §7 step 1), the evaluation the rater's assigned frozen articles. No
 * rating or other per-user signal enters it.
 */
export function buildBm25Corpus(texts: Iterable<Bm25Text>): Bm25Corpus {
  const preferred = new StatsBuilder();
  const original = new StatsBuilder();
  let anyTranslation = false;
  for (const text of texts) {
    const tokens = bm25DocumentTokens(text);
    original.add(tokens.original);
    preferred.add(tokens.translated ?? tokens.original);
    anyTranslation ||= tokens.translated !== null;
  }
  const originalStats = original.build();
  return { preferred: anyTranslation ? preferred.build() : originalStats, original: originalStats };
}

class StatsBuilder {
  private documents = 0;
  private totalLength = 0;
  private readonly df = new Map<string, number>();

  add(tokens: readonly string[]): void {
    this.documents += 1;
    this.totalLength += tokens.length;
    for (const term of new Set(tokens)) this.df.set(term, (this.df.get(term) ?? 0) + 1);
  }

  build(): Bm25TermStats {
    return {
      documents: this.documents,
      avgLength: this.documents === 0 ? 0 : this.totalLength / this.documents,
      df: this.df,
    };
  }
}
