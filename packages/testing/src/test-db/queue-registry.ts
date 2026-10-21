import { QUEUES, canonicalJson } from '@bantoozi/shared';

/**
 * What the migrate job creates in `pgboss.queue` (packages/db migrate.ts): every queue of the
 * registry with its create options. A queue added without a migration changes no SQL file, so this
 * key joins the template hash: worktrees with different queue lists never share a template.
 */
export function queueRegistryKey(
  registry: Readonly<Record<string, { options: object }>> = QUEUES,
): string {
  return canonicalJson(
    Object.keys(registry)
      .sort()
      .map((name) => [name, registry[name]!.options]),
  );
}
