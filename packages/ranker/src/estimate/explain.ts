import { tokenize } from '../bm25/tokenize.js';
import { applyPlatt } from '../learn/platt.js';
import { similarityWords, stemToken } from '../similar-dislikes.js';

import { estimateFeatures } from './features.js';
import { ESTIMATE_EXCERPT_TOKENS, ESTIMATE_SPEC } from './spec.js';
import type { EstimateArticle, EstimateModel } from './types.js';

/** One word of an estimate's explanation: the model's key, the article's own word, the weight. */
export interface EstimateWord {
  feature: string;
  label: string;
  contribution: number;
}

export interface ExplainedEstimate {
  logit: number;
  p: number;
  /** At most `perSign` words that raise P (most positive first), then at most `perSign` that lower it. */
  top: EstimateWord[];
}

const LABEL_MAX = 200;

function labelsOf(article: EstimateArticle): Map<string, string> {
  const labels = new Map<string, string>();
  const set = (feature: string, label: string): void => {
    if (!labels.has(feature)) labels.set(feature, label);
  };
  const words = similarityWords(article.title);
  const stems = words.map(stemToken);
  stems.forEach((stem, i) => {
    set(`t:${stem}`, words[i] as string);
    if (i + 1 < stems.length) set(`b:${stem}_${stems[i + 1]}`, `${words[i]} ${words[i + 1]}`);
  });
  if (article.excerpt !== null) {
    for (const word of tokenize(article.excerpt).slice(0, ESTIMATE_EXCERPT_TOKENS)) {
      set(`e:${stemToken(word)}`, word);
    }
  }
  return labels;
}

function byName(a: EstimateWord, b: EstimateWord): number {
  return a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0;
}

/**
 * The estimate of one article with the words that moved it most (visible-learning §4.4); null for a
 * model whose `spec` is not the current `ESTIMATE_SPEC`. `logit` and `p` equal `scoreEstimate`'s.
 */
export function explainEstimate(
  model: EstimateModel,
  article: EstimateArticle,
  perSign = 5,
): ExplainedEstimate | null {
  if (model.spec !== ESTIMATE_SPEC) return null;
  const features = estimateFeatures(article);
  let logit = model.intercept;
  const present: { feature: string; weight: number }[] = [];
  for (const feature of features) {
    if (!Object.hasOwn(model.weights, feature)) continue;
    const weight = model.weights[feature] as number;
    logit += weight;
    if (weight !== 0 && !feature.startsWith('f:')) present.push({ feature, weight });
  }
  const p = applyPlatt(model.platt, logit);

  const labels = labelsOf(article);
  const merged = new Map<string, EstimateWord>();
  for (const { feature, weight } of present) {
    const label = labels.get(feature) ?? feature.slice(2).replaceAll('_', ' ');
    const word = merged.get(label);
    if (word === undefined) merged.set(label, { feature, label, contribution: weight });
    else word.contribution += weight;
  }
  const words = [...merged.values()].filter((word) => word.contribution !== 0);
  const positive = words
    .filter((word) => word.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution || byName(a, b))
    .slice(0, perSign);
  const negative = words
    .filter((word) => word.contribution < 0)
    .sort((a, b) => a.contribution - b.contribution || byName(a, b))
    .slice(0, perSign);
  const top = [...positive, ...negative].map((word) => ({
    feature: word.feature.slice(0, LABEL_MAX),
    label: word.label.slice(0, LABEL_MAX),
    contribution: word.contribution,
  }));
  return { logit, p, top };
}
