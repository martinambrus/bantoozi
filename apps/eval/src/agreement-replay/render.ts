import type { AgreementReplay, FeedReplay } from './replay.js';

function num(value: number | null): string {
  return value === null ? '-' : value.toFixed(3);
}

function withLow(value: number | null, low: number | null): string {
  return value === null ? '-' : `${num(value)} [${num(low)}]`;
}

function row(feed: FeedReplay): string {
  const later =
    feed.later === null ? '-' : `${withLow(feed.later.auc, feed.later.aucLow)} (${feed.later.n})`;
  const alarm = feed.falseAlarm === null ? '-' : feed.falseAlarm ? 'yes' : 'no';
  return [
    feed.feedId,
    String(feed.ratings),
    `${feed.likes}/${feed.dislikes}`,
    feed.firstReadyAt === null ? '-' : String(feed.firstReadyAt),
    feed.finalStatus,
    withLow(feed.finalAuc, feed.finalAucLow),
    later,
    alarm,
  ].join(' | ');
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** One line over all raters: feeds ready, median ratings to ready, false alarms. */
export function renderAgreementSummary(replay: AgreementReplay): string {
  const feeds = replay.raters.flatMap((rater) => rater.feeds);
  const ready = feeds.filter((feed) => feed.firstReadyAt !== null);
  const med = median(ready.map((feed) => feed.firstReadyAt as number));
  const alarms = ready.filter((feed) => feed.falseAlarm === true).length;
  return `Feeds ready: ${ready.length} of ${feeds.length}; median ratings to ready: ${
    med === null ? '-' : String(med)
  }; false alarms: ${alarms}.`;
}

export function renderAgreementReport(input: {
  datasetVersion: string;
  runId: string;
  experiment: string;
  date: string;
  replay: AgreementReplay;
}): string {
  const { replay } = input;
  const lines = [
    `# Feed agreement replay ${input.datasetVersion} (${input.date})`,
    '',
    `Run ${input.runId} (${input.experiment}). Each rater's ratings are replayed per feed in rating order; ` +
      '"ready after N" is the feed rating count at which the rule first said ready, and the later ' +
      "columns score the cards on that feed's ratings after that point. A false alarm is a later AUC below the model threshold.",
    '',
    renderAgreementSummary(replay),
    '',
  ];
  for (const rater of replay.raters) {
    lines.push(`## Rater ${rater.raterId} (${rater.participantKey})`, '');
    if (rater.feeds.length === 0) {
      lines.push('No ratings.', '');
      continue;
    }
    lines.push(
      '| feed | ratings | likes/dislikes | ready after N | final status | final AUC [low] | later AUC [low] (n) | false alarm |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rater.feeds.map((feed) => `| ${row(feed)} |`),
      '',
    );
  }
  return lines.join('\n');
}
