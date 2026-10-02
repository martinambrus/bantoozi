import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { drawSample, formatSampleOutcome, SampleError } from '../collection/sample.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval sample [--version golden-v1] [--seed <s>] [--per-lang 500] [--langs en,sk,cs]
 * [--feed-cap 0.1] [--exclude-version golden-v1]` (spec 10 §2.1, M3a-T2; D-145): draw (or fill up) a golden dataset version in
 * `eval.sample`. Unset options keep the version's stored values; see `collection/sample.ts`.
 */

const VersionSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'lower-case version name');

const OptionsSchema = z.object({
  version: VersionSchema.optional(),
  seed: z.string().min(1).max(200).optional(),
  perLang: z.coerce.number().int().min(1).max(10_000).optional(),
  langs: z
    .string()
    .transform((s) => s.split(',').map((l) => l.trim()))
    .pipe(z.array(z.string().regex(/^[a-z]{2,3}$/)).min(1))
    .optional(),
  feedCap: z.coerce.number().gt(0).max(1).optional(),
  excludeVersion: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()))
    .pipe(z.array(VersionSchema).min(1))
    .optional(),
});

export function registerSample(program: Command, ctx: CliContext): void {
  program
    .command('sample')
    .description(describeCommand('sample'))
    .option('--version <name>', 'dataset version (default: the open head, or the next one)')
    .option('--seed <seed>', 'sampling seed (default: the version name)')
    .option('--per-lang <n>', 'articles per language (default 500)')
    .option('--langs <list>', 'languages, comma-separated (default en,sk,cs)')
    .option('--feed-cap <share>', 'largest share of a language sample one feed may hold (0.1)')
    .option(
      '--exclude-version <list>',
      'leave out every article and story group these versions sampled (a held-out successor)',
    )
    .action(async (raw: unknown) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new EvalCommandError(`invalid options: ${z.prettifyError(parsed.error)}`);
      }
      const o = parsed.data;
      await withRuntime(ctx, async (rt) => {
        try {
          const outcome = await drawSample(
            rt.db,
            {
              ...(o.version === undefined ? {} : { version: o.version }),
              ...(o.seed === undefined ? {} : { seed: o.seed }),
              ...(o.perLang === undefined ? {} : { perLang: o.perLang }),
              ...(o.langs === undefined ? {} : { langs: o.langs }),
              ...(o.feedCap === undefined ? {} : { feedCapShare: o.feedCap }),
              ...(o.excludeVersion === undefined ? {} : { excludeVersions: o.excludeVersion }),
            },
            rt.now(),
          );
          rt.out(formatSampleOutcome(outcome));
        } catch (error) {
          if (error instanceof SampleError) throw new EvalCommandError(error.message);
          throw error;
        }
      });
    });
}
