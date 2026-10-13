import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataset, getRun, loadRunAnswers, loadSample } from '@bantoozi/db';
import { mergeRankerConfig } from '@bantoozi/ranker';
import type { Command } from 'commander';
import { z } from 'zod';

import { renderAgreementReport, renderAgreementSummary } from '../agreement-replay/render.js';
import { replayAgreement } from '../agreement-replay/replay.js';
import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { learningArticle } from '../learning-curve/samples.js';
import { parseG1, type G1File } from '../report/g1-schema.js';
import { DEFAULT_G1_PATH, isoDate, REPORTS_DIR, resolveRepoPath } from '../report/paths.js';
import { parseRunData } from '../report/run-data.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval agreement-replay [--g1 <path>] [--out <dir>]`: replays the stored ratings of the g1 run per
 * rater and feed and reports when the per-feed card agreement rule would first say ready and
 * whether the cards kept agreeing afterwards. It reads the database and writes one report file; it
 * calls no provider and changes no table.
 */
const OptionsSchema = z.object({
  g1: z.string().min(1).default(DEFAULT_G1_PATH),
  out: z.string().min(1).default(REPORTS_DIR),
});

async function readG1(file: string): Promise<G1File> {
  try {
    return parseG1(JSON.parse(await readFile(resolveRepoPath(file), 'utf8')));
  } catch (error) {
    throw new EvalCommandError(`cannot read ${file}: ${(error as Error).message}`);
  }
}

export function registerAgreementReplay(program: Command, ctx: CliContext): void {
  program
    .command('agreement-replay')
    .description(describeCommand('agreement-replay'))
    .option('--g1 <path>', 'the G1 decision file, relative to the repository root')
    .option('--out <dir>', 'report directory, relative to the repository root')
    .action(async (raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      const options = parsed.data;
      const g1 = await readG1(options.g1);
      const experiment = g1.card_text_mode === 'english' ? 'E2' : 'E1';
      const runId = g1.runs[experiment];
      if (runId === undefined) {
        throw new EvalCommandError(
          `g1.json has no ${experiment} run for card_text_mode ${g1.card_text_mode}`,
        );
      }
      await withRuntime(ctx, async (rt) => {
        const dataset = await getDataset(rt.db, g1.dataset.version);
        if (
          dataset === null ||
          dataset.snapshotSha !== g1.dataset.snapshotSha ||
          dataset.splitSha !== g1.dataset.splitSha
        ) {
          throw new EvalCommandError(
            `dataset ${g1.dataset.version} is missing or its hash differs from g1.json`,
          );
        }
        const row = await getRun(rt.db, runId);
        const config = (row?.config ?? {}) as { snapshotSha?: unknown; splitSha?: unknown };
        if (
          row === null ||
          row.experiment !== experiment ||
          row.datasetVersion !== g1.dataset.version ||
          config.snapshotSha !== g1.dataset.snapshotSha ||
          config.splitSha !== g1.dataset.splitSha
        ) {
          throw new EvalCommandError(`run ${runId} is missing or does not match g1.json (hash)`);
        }
        const run = parseRunData(row, await loadRunAnswers(rt.db, runId));
        const articles = new Map(
          (await loadSample(rt.db, g1.dataset.version)).map((sample) => [
            sample.articleId,
            learningArticle(sample),
          ]),
        );
        const replay = replayAgreement({
          run,
          articles,
          config: mergeRankerConfig(g1.ranker_thresholds),
          seedBase: `agreement-replay|${g1.dataset.version}`,
        });
        const date = isoDate(rt.now());
        const file = path.join(
          resolveRepoPath(options.out),
          `AGREEMENT-REPLAY-${g1.dataset.version}-${date}.md`,
        );
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(
          file,
          renderAgreementReport({
            datasetVersion: g1.dataset.version,
            runId,
            experiment,
            date,
            replay,
          }),
        );
        rt.out(`${renderAgreementSummary(replay)}\nreport: ${file}\n`);
      });
    });
}
