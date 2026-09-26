import { describe, expect, it } from 'vitest';

import { EVAL_COMMANDS, NotImplementedError, buildCli } from '../src/cli.js';

function run(args: string[]) {
  const out: string[] = [];
  const program = buildCli()
    .exitOverride()
    .configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => out.push(s) });
  for (const command of program.commands) {
    command
      .exitOverride()
      .configureOutput({ writeOut: (s) => out.push(s), writeErr: (s) => out.push(s) });
  }
  return { program, out, parse: () => program.parseAsync(['node', 'cli', ...args]) };
}

describe('eval CLI (commander)', () => {
  it('prints help listing every command', async () => {
    const cli = run(['--help']);
    await expect(cli.parse()).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });
    const help = cli.out.join('');
    expect(help).toContain('Usage: bantoozi-eval [options] [command]');
    for (const [name] of EVAL_COMMANDS) expect(help).toContain(name);
  });

  it('refuses commands of later milestones without doing anything', async () => {
    const cli = run(['run', '--experiment', 'B0']);
    await expect(cli.parse()).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('rejects unknown commands', async () => {
    const cli = run(['frobnicate']);
    await expect(cli.parse()).rejects.toMatchObject({ code: 'commander.unknownCommand' });
  });
});
