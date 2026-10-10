import type { CurveRow, LearningCurve, RaterCurve, ThresholdRule } from './curve.js';

const HEADERS = [
  'rater',
  'n',
  'train n',
  'pos/neg',
  'skipped',
  'test n',
  'test pos/neg',
  'mode',
  'activation',
  'cards AUC',
  'model AUC',
  'ΔAUC',
  'cards logloss',
  'model logloss',
  'own inputs',
] as const;

function num(value: number | null, signed = false): string {
  if (value === null) return '-';
  const text = value.toFixed(3);
  return signed && value > 0 ? `+${text}` : text;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '-' : items.join(',');
}

function cells(rater: RaterCurve, row: CurveRow): string[] {
  const skipped = Object.entries(row.skipped).map(([reason, count]) => `${reason}×${count}`);
  return [
    rater.raterId,
    String(row.n),
    String(row.trainN),
    `${row.pos}/${row.neg}`,
    list(skipped),
    String(row.testN),
    `${row.testPos}/${row.testNeg}`,
    row.mode,
    list(row.activation),
    num(row.cardsAuc),
    num(row.modelAuc),
    num(row.deltaAuc, true),
    num(row.cardsLogloss),
    num(row.modelLogloss),
    list(row.ownInputs),
  ];
}

function tableRows(curve: LearningCurve): string[][] {
  return curve.raters.flatMap((rater) => rater.rows.map((row) => cells(rater, row)));
}

/** The curve as an aligned text table, one line per rater and training size. */
export function renderCurveTable(curve: LearningCurve): string {
  const body = tableRows(curve);
  const widths = HEADERS.map((header, i) =>
    Math.max([...header].length, ...body.map((row) => [...(row[i] ?? '')].length)),
  );
  const line = (row: readonly string[]): string =>
    row
      .map((cell, i) => cell + ' '.repeat((widths[i] ?? 0) - [...cell].length))
      .join('  ')
      .trimEnd();
  return (
    [line(HEADERS), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n') + '\n'
  );
}

/** The proposal line of the PLAN rule, or the reason it was not evaluated. */
export function renderRuleLine(rule: ThresholdRule | null): string {
  if (rule === null) return 'Threshold rule not evaluated: n = 50 is not among the sizes.';
  const summary = `At n = ${rule.n} the model did not beat cards-only for ${rule.notBeating} of ${rule.raters} raters.`;
  return rule.proposalNeeded
    ? `THRESHOLD CHANGE PROPOSAL NEEDED\n${summary}`
    : `No threshold change needed. ${summary}`;
}

/** The markdown decision report of one learning-curve run. */
export function renderCurveReport(input: {
  datasetVersion: string;
  runId: string;
  experiment: string;
  date: string;
  curve: LearningCurve;
  rule: ThresholdRule | null;
}): string {
  const { curve, rule } = input;
  const rows = tableRows(curve);
  const md = (row: readonly string[]): string => `| ${row.join(' | ')} |`;
  return [
    `# Learning curve ${input.datasetVersion} (${input.date})`,
    '',
    `Dataset ${input.datasetVersion}, run ${input.runId} (${input.experiment}), sizes ${curve.sizes.join(', ')}.`,
    'The personal model is trained on the first n development ratings of each rater in arrival order and',
    'evaluated on the same untouched test ratings for every n; cards-only is the cards score of spec 06 §4.1.',
    'Research mode marks a size below the production minimums.',
    '',
    renderRuleLine(rule),
    '',
    md(HEADERS),
    md(HEADERS.map(() => '---')),
    ...rows.map(md),
    '',
  ].join('\n');
}
