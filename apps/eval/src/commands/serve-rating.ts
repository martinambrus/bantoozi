import { deleteExpiredRaterSessions } from '@bantoozi/db';
import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { buildRatingServer, DEFAULT_RATING_PORT, RATING_HOST } from '../rating-server/server.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval serve-rating [--port 5180]` (spec 10 §2.4): serves the rating and facet-labelling pages on
 * loopback only, for an authenticated HTTPS tunnel to expose (docs/eval/TUNNEL.md). Runs until
 * SIGINT/SIGTERM. Raters open the URLs `eval rater add` printed (`EVAL_PUBLIC_URL`).
 */

const OptionsSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_RATING_PORT),
});

/** Resolves on the first SIGINT or SIGTERM. */
function untilSignal(): Promise<string> {
  return new Promise((resolve) => {
    const stop = (signal: string) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(signal);
    };
    const onInt = () => stop('SIGINT');
    const onTerm = () => stop('SIGTERM');
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
  });
}

export function registerServeRating(program: Command, ctx: CliContext): void {
  program
    .command('serve-rating')
    .description(describeCommand('serve-rating'))
    .option('--port <port>', `port on ${RATING_HOST} (default ${DEFAULT_RATING_PORT})`)
    .action(async (raw: Record<string, unknown>) => {
      const parsed = OptionsSchema.safeParse(raw);
      if (!parsed.success) throw new EvalCommandError('--port must be a TCP port number');
      await withRuntime(ctx, async (rt) => {
        const expired = await deleteExpiredRaterSessions(rt.db, rt.now());
        if (expired > 0) rt.logger.info({ expired }, 'deleted expired rating sessions');
        const app = await buildRatingServer({
          db: rt.db,
          publicUrl: rt.config.evalPublicUrl,
          now: rt.now,
          logger: {
            info: (obj, msg) => rt.logger.info(obj, msg),
            warn: (obj, msg) => rt.logger.warn(obj, msg),
            error: (obj, msg) => rt.logger.error(obj, msg),
          },
        });
        const address = await app.listen({ host: RATING_HOST, port: parsed.data.port });
        rt.out(
          `rating server on ${address} (loopback only); raters use ${rt.config.evalPublicUrl}\n` +
            'stop with Ctrl+C\n',
        );
        const signal = await untilSignal();
        rt.out(`${signal}: stopping the rating server\n`);
        await app.close();
      });
    });
}
