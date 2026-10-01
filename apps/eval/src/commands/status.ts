import {
  collectionLangCounts,
  evalUserId,
  facetLabelCounts,
  getDataset,
  headDataset,
  raterProgress,
  sampleLangCounts,
  type CollectionLangCount,
  type DatasetRow,
  type FacetLabelCount,
  type RaterProgress,
  type SampleLangCount,
} from '@bantoozi/db';
import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval status [--version <v>]` (spec 10 §2.1, M3a-T2): per-language sample counts (collected
 * candidates, sampled, development/test), then per rater the cards written, feeds picked, assigned,
 * rated and skipped articles, and the facet-label counts per language. Read-only.
 */

export interface StatusData {
  dataset: DatasetRow | null;
  collected: CollectionLangCount[] | null;
  sample: SampleLangCount[];
  raters: RaterProgress[];
  facets: FacetLabelCount[];
}

const pad = (value: string | number, width: number) => String(value).padStart(width);

export function formatStatus(data: StatusData): string {
  const lines: string[] = [];
  const ds = data.dataset;
  if (ds === null) {
    lines.push('dataset: none yet (run `eval sample`)');
  } else {
    lines.push(
      `dataset ${ds.version}` +
        (ds.parentVersion === null ? '' : ` (from ${ds.parentVersion})`) +
        `, seed "${ds.seed}", ` +
        (ds.frozenAt === null
          ? 'open (no model run yet)'
          : `frozen ${ds.frozenAt.toISOString()}, snapshot ${ds.snapshotSha?.slice(0, 12) ?? '?'}, ` +
            `split ${ds.splitSha?.slice(0, 12) ?? '?'}`),
    );
  }
  if (data.collected === null) {
    lines.push('collection: no evaluation user (run `eval ingest-sample`)');
  }

  lines.push('', 'Per language');
  lines.push('lang  collected  candidates  sampled    dev   test');
  const langs = [
    ...new Set([...(data.collected ?? []).map((c) => c.lang), ...data.sample.map((s) => s.lang)]),
  ].sort();
  let total = { collected: 0, eligible: 0, dev: 0, test: 0 };
  for (const lang of langs) {
    const c = data.collected?.find((x) => x.lang === lang);
    const s = data.sample.find((x) => x.lang === lang) ?? { dev: 0, test: 0 };
    total = {
      collected: total.collected + (c?.articles ?? 0),
      eligible: total.eligible + (c?.eligible ?? 0),
      dev: total.dev + s.dev,
      test: total.test + s.test,
    };
    lines.push(
      [
        lang.padEnd(4),
        pad(c?.articles ?? '-', 10),
        pad(c?.eligible ?? '-', 11),
        pad(s.dev + s.test, 8),
        pad(s.dev, 6),
        pad(s.test, 6),
      ].join(' '),
    );
  }
  lines.push(
    [
      'all ',
      pad(total.collected, 10),
      pad(total.eligible, 11),
      pad(total.dev + total.test, 8),
      pad(total.dev, 6),
      pad(total.test, 6),
    ].join(' '),
  );

  lines.push('', 'Per rater');
  if (data.raters.length === 0) {
    lines.push('(no raters yet: `eval rater add`)');
  } else {
    lines.push(
      'id    rater (context)                participant  langs     cards  never  feeds  assigned  rated  skipped  pending  likes  dislikes',
    );
    for (const r of data.raters) {
      const name = `${r.name}${r.contextName === null ? '' : ` (${r.contextName})`}${r.revoked ? ' [revoked]' : ''}`;
      lines.push(
        [
          r.raterId.padEnd(5),
          name.slice(0, 30).padEnd(30),
          r.participantKey.slice(0, 8).padEnd(11),
          r.langs.join(',').padEnd(8),
          pad(r.cards, 6),
          pad(r.neverCards, 6),
          pad(r.feeds, 6),
          pad(r.assigned, 9),
          pad(r.rated, 6),
          pad(r.skipped, 8),
          pad(r.pending, 8),
          pad(r.likes, 6),
          pad(r.dislikes, 9),
        ].join(' '),
      );
    }
    const participants = new Set(data.raters.map((r) => r.participantKey)).size;
    lines.push(`${data.raters.length} context(s) of ${participants} participant(s)`);
  }

  lines.push('', 'Facet labels per language');
  if (data.facets.length === 0) {
    lines.push('(none yet)');
  } else {
    lines.push('labeller              lang  articles  labels');
    for (const f of data.facets) {
      lines.push(
        [
          f.labeler.slice(0, 20).padEnd(20),
          f.lang.padEnd(5),
          pad(f.articles, 8),
          pad(f.labels, 7),
        ].join(' '),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

const OptionsSchema = z.object({
  version: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .optional(),
});

export function registerStatus(program: Command, ctx: CliContext): void {
  program
    .command('status')
    .description(describeCommand('status'))
    .option('--version <name>', 'dataset version (default: the head version)')
    .action(async (raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      await withRuntime(ctx, async (rt) => {
        const version = parsed.data.version;
        const dataset =
          version === undefined ? await headDataset(rt.db) : await getDataset(rt.db, version);
        if (version !== undefined && dataset === null) {
          throw new EvalCommandError(`dataset version ${version} does not exist`);
        }
        const userId = await evalUserId(rt.db);
        const data: StatusData = {
          dataset,
          collected: userId === null ? null : await collectionLangCounts(rt.db, userId),
          sample: dataset === null ? [] : await sampleLangCounts(rt.db, dataset.version),
          raters: await raterProgress(rt.db),
          facets: await facetLabelCounts(rt.db),
        };
        rt.out(formatStatus(data));
      });
    });
}
