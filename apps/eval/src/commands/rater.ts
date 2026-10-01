import { randomUUID } from 'node:crypto';

import {
  createRater,
  getRater,
  groupByParticipant,
  listRaters,
  participantExists,
  reissueRaterToken,
  revokeRater,
} from '@bantoozi/db';
import type { Command } from 'commander';
import { z } from 'zod';

import { describeCommand, withRuntime, type CliContext } from '../cli.js';
import { DEFAULT_TOKEN_DAYS, issueToken, raterUrl } from '../rating-server/tokens.js';
import { EvalCommandError } from '../runtime.js';

/**
 * `eval rater add|token|revoke|list` (spec 10 §2.2, §2.4). A rater row is one reading context of
 * one human; `--participant <key>` adds another context for a human that already exists, so all
 * of that person's contexts count as one participant. The printed URL carries a fresh 256-bit link
 * token; only its hash is stored, so a lost link can only be replaced (`eval rater token`).
 */

const LangsSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l !== ''),
  )
  .pipe(z.array(z.string().regex(/^[a-z]{2}$/u, 'languages are ISO 639-1 codes')).min(1))
  .transform((langs) => [...new Set(langs)]);

const TokenDaysSchema = z.coerce.number().int().min(1).max(365);

const AddOptionsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  langs: LangsSchema,
  participant: z.string().uuid().optional(),
  context: z.string().trim().min(1).max(100).optional(),
  tokenDays: TokenDaysSchema.default(DEFAULT_TOKEN_DAYS),
});

const RaterIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/u, 'a rater id is a positive integer');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `--${issue.path.join('.')}: ` : '';
    throw new EvalCommandError(`${where}${issue?.message ?? 'invalid input'}`);
  }
  return result.data;
}

function linkLines(publicUrl: string, token: string, expiresAt: Date): string {
  return (
    `  rating URL:  ${raterUrl(publicUrl, token)}\n` +
    `  facets URL:  ${raterUrl(publicUrl, token, 'facets')}\n` +
    `  expires:     ${expiresAt.toISOString()}\n` +
    '  (the link is shown once; only its hash is stored)\n'
  );
}

export function registerRater(program: Command, ctx: CliContext): void {
  const rater = program.command('rater').description(describeCommand('rater'));

  rater
    .command('add')
    .description('Add a rater (one reading context of one participant) and print its private URL')
    .requiredOption('--name <name>', 'display name of the human')
    .requiredOption('--langs <langs>', 'comma-separated languages the rater reads, e.g. sk,en')
    .option('--participant <key>', 'participant key of an existing human (adds another context)')
    .option('--context <label>', 'topic / reading purpose of this context, e.g. "cooking"')
    .option('--token-days <n>', `link token lifetime in days (default ${DEFAULT_TOKEN_DAYS})`)
    .action(async (raw: Record<string, unknown>) => {
      const options = parse(AddOptionsSchema, raw);
      await withRuntime(ctx, async (rt) => {
        if (
          options.participant !== undefined &&
          !(await participantExists(rt.db, options.participant))
        ) {
          throw new EvalCommandError(
            `no rater has participant key ${options.participant}; omit --participant for a new human`,
          );
        }
        const now = rt.now();
        const issued = issueToken(now, options.tokenDays);
        const created = await createRater(rt.db, {
          name: options.name,
          participantKey: options.participant ?? randomUUID(),
          contextName: options.context ?? null,
          langs: options.langs,
          tokenHash: issued.tokenHash,
          tokenExpiresAt: issued.expiresAt,
        });
        rt.out(
          `rater ${created.id} added: ${created.name}` +
            `${created.contextName === null ? '' : ` (context: ${created.contextName})`}` +
            `, languages ${created.langs.join(',')}\n` +
            `  participant: ${created.participantKey}\n` +
            `  (pass --participant ${created.participantKey} to add another context of this human)\n` +
            linkLines(rt.config.evalPublicUrl, issued.token, issued.expiresAt),
        );
      });
    });

  rater
    .command('token')
    .description("Issue a new link token (ends the rater's sessions; ratings are kept)")
    .argument('<id>', 'rater id')
    .option('--token-days <n>', `link token lifetime in days (default ${DEFAULT_TOKEN_DAYS})`)
    .action(async (id: string, raw: Record<string, unknown>) => {
      const raterId = parse(RaterIdSchema, id);
      const days = parse(TokenDaysSchema.default(DEFAULT_TOKEN_DAYS), raw['tokenDays']);
      await withRuntime(ctx, async (rt) => {
        const issued = issueToken(rt.now(), days);
        const found = await rt.db.transaction((tx) =>
          reissueRaterToken(tx, raterId, {
            tokenHash: issued.tokenHash,
            tokenExpiresAt: issued.expiresAt,
          }),
        );
        if (!found) throw new EvalCommandError(`no rater ${raterId}`);
        rt.out(
          `rater ${raterId}: new token issued; earlier links and sessions no longer work\n` +
            linkLines(rt.config.evalPublicUrl, issued.token, issued.expiresAt),
        );
      });
    });

  rater
    .command('revoke')
    .description("Revoke a rater's link token and end its sessions (ratings are kept)")
    .argument('<id>', 'rater id')
    .action(async (id: string) => {
      const raterId = parse(RaterIdSchema, id);
      await withRuntime(ctx, async (rt) => {
        const found = await rt.db.transaction((tx) => revokeRater(tx, raterId, rt.now()));
        if (!found) throw new EvalCommandError(`no rater ${raterId}`);
        rt.out(`rater ${raterId}: token revoked and sessions ended\n`);
      });
    });

  rater
    .command('list')
    .description('List raters grouped by participant (one participant = one human)')
    .action(async () => {
      await withRuntime(ctx, async (rt) => {
        const raters = await listRaters(rt.db);
        if (raters.length === 0) {
          rt.out('no raters yet: eval rater add --name <n> --langs <l,…>\n');
          return;
        }
        const now = rt.now();
        const byId = new Map(raters.map((r) => [r.id, r]));
        for (const participant of groupByParticipant(raters)) {
          rt.out(`participant ${participant.participantKey}\n`);
          for (const id of participant.raterIds) {
            const row = byId.get(id);
            if (row === undefined) continue;
            const state =
              row.tokenRevokedAt !== null
                ? 'revoked'
                : row.tokenExpiresAt <= now
                  ? 'expired'
                  : `valid until ${row.tokenExpiresAt.toISOString()}`;
            rt.out(
              `  rater ${row.id}: ${row.name}${row.contextName === null ? '' : ` / ${row.contextName}`}` +
                ` [${row.langs.join(',')}] token ${state}\n`,
            );
          }
        }
      });
    });

  rater
    .command('show')
    .description('Show one rater as JSON (never its token)')
    .argument('<id>', 'rater id')
    .action(async (id: string) => {
      const raterId = parse(RaterIdSchema, id);
      await withRuntime(ctx, async (rt) => {
        const row = await getRater(rt.db, raterId);
        if (row === null) throw new EvalCommandError(`no rater ${raterId}`);
        rt.out(
          `${JSON.stringify(
            {
              id: row.id,
              name: row.name,
              participantKey: row.participantKey,
              contextName: row.contextName,
              langs: row.langs,
              tokenExpiresAt: row.tokenExpiresAt.toISOString(),
              tokenRevokedAt: row.tokenRevokedAt?.toISOString() ?? null,
            },
            null,
            2,
          )}\n`,
        );
      });
    });
}
