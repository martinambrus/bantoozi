import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getDataset, getRun, loadRunAnswers, loadSample } from '@bantoozi/db';
import { mergeRankerConfig } from '@bantoozi/ranker';
import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { computeLearningCurve, thresholdRule } from '../learning-curve/curve.js';
import { renderCurveReport, renderCurveTable, renderRuleLine } from '../learning-curve/render.js';
import { learningArticle } from '../learning-curve/samples.js';
import { parseG1, type G1File } from '../report/g1-schema.js';
import { DEFAULT_G1_PATH, isoDate, REPORTS_DIR, resolveRepoPath } from '../report/paths.js';
import { parseRunData } from '../report/run-data.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval learning-curve [--g1 <path>] [--out <dir>] [--sizes 10,20,30,50,100]` (spec 10, spec 06
 * §8.3, M7-T7a): replays the stored ratings of the g1 run (E1 for as-written cards, E2 for English)
 * and prints and writes the learning curve of the personal model against cards-only. It reads the
 * database and writes one report file; it calls no provider and changes no table.
 */
const OptionsSchema = z.object({
  g1: z.string().min(1).default(DEFAULT_G1_PATH),
  out: z.string().min(1).default(REPORTS_DIR),
  sizes: z
    .string()
    .default('10,20,30,50,100')
    .transform((text) => text.split(',').map((part) => Number(part.trim())))
    .pipe(z.array(z.number().int().min(1).max(100_000)).min(1)),
});

async function readG1(file: string): Promise<G1File> {
  try {
    return parseG1(JSON.parse(await readFile(resolveRepoPath(file), 'utf8')));
  } catch (error) {
    throw new EvalCommandError(`cannot read ${file}: ${(error as Error).message}`);
  }
}

export function registerLearningCurve(program: Command, ctx: CliContext): void {
  program
    .command('learning-curve')
    .description(describeCommand('learning-curve'))
    .option('--g1 <path>', 'the G1 decision file, relative to the repository root')
    .option('--out <dir>', 'report directory, relative to the repository root')
    .option('--sizes <list>', 'training sizes, comma separated')
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
        const curve = computeLearningCurve({
          run,
          articles,
          config: mergeRankerConfig(g1.ranker_thresholds),
          sizes: options.sizes,
        });
        const rule = thresholdRule(curve, 50);
        const date = isoDate(rt.now());
        const report = renderCurveReport({
          datasetVersion: g1.dataset.version,
          runId,
          experiment,
          date,
          curve,
          rule,
        });
        const file = path.join(
          resolveRepoPath(options.out),
          `LEARNING-CURVE-${g1.dataset.version}-${date}-decision.md`,
        );
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, report);
        rt.out(`${renderCurveTable(curve)}\n${renderRuleLine(rule)}\nreport: ${file}\n`);
      });
    });
}
