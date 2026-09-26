import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The web client may import only the isomorphic main entry (ESLint forbids `@bantoozi/shared/server*`
// there). This walks the main entry's static import graph and proves that no Node-only module —
// credential crypto, config, logger, mailer, hashing or language detection — can enter the bundle.
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const IMPORT = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g;

function graph(entry: string): { files: Set<string>; externals: Set<string> } {
  const files = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? '';
      if (spec.startsWith('.'))
        visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
      else externals.add(spec);
    }
  };
  visit(path.join(srcDir, entry));
  return { files, externals };
}

describe('@bantoozi/shared entry isolation (spec 01 §3 credential code boundary)', () => {
  it('keeps the main entry free of Node built-ins and server modules', () => {
    const { files, externals } = graph('index.ts');
    const relative = [...files].map((f) => path.relative(srcDir, f));
    expect(relative.filter((f) => f.startsWith('server'))).toEqual([]);
    expect([...externals].filter((e) => e.startsWith('node:'))).toEqual([]);
    expect([...externals].sort()).toEqual(['uuidv7', 'zod']);
  });

  it('keeps credential crypto out of the general server entry', () => {
    const { files } = graph(path.join('server', 'index.ts'));
    const relative = [...files].map((f) => path.relative(srcDir, f));
    expect(relative).not.toContain(path.join('server', 'credential-crypto.ts'));
  });
});
