import { Command } from 'commander';

/** `pnpm --filter @bantoozi/ops cli <command>`: operations tools of spec 11 (M8). */
export const program = new Command('bantoozi-ops').description('Bantoozi operations tools');

if (import.meta.url === `file://${process.argv[1]}`) {
  await program.parseAsync(process.argv);
}
