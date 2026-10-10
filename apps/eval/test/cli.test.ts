import { describe, expect, it } from 'vitest';

import { EVAL_COMMANDS, buildCli } from '../src/cli.js';

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

  it('implements learning-curve with its options', () => {
    const command = run([]).program.commands.find((c) => c.name() === 'learning-curve');
    expect(command).toBeDefined();
    expect(command?.options.map((o) => o.long)).toEqual(['--g1', '--out', '--sizes']);
  });

  it('rejects unknown commands', async () => {
    const cli = run(['frobnicate']);
    await expect(cli.parse()).rejects.toMatchObject({ code: 'commander.unknownCommand' });
  });
});
