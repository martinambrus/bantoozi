import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { expect, it } from 'vitest';

import allowed from './support/strict-setting-writes.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const settings = ts.createSourceFile(
  'settings.ts',
  read('packages/shared/src/settings.ts'),
  ts.ScriptTarget.Latest,
  true,
);
const schemas = new Set([
  'RankerThresholdsSchema',
  'MetricsSnapshotSchema',
  'KeyringReportSchema',
  'HostHealthDetailSchema',
  'HOUSE_PROGRESS_CURSORS',
]);
for (const statement of settings.statements) {
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(settings);
      if (name.endsWith('Schema')) schemas.add(name);
    }
  }
}

/** Every strict parse site must be reviewed as a write; new stored readers must use derived readers. */
function strictCalls(source: string, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements)
        aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
    }
  }
  const nameOf = (node: ts.Expression) =>
    ts.isIdentifier(node) ? (aliases.get(node.text) ?? node.text) : '';
  const schemaAliases = new Set<string>();
  const strictSchema = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node))
      return (
        schemas.has(nameOf(node)) || schemaAliases.has(node.text) || nameOf(node) === 'SETTINGS'
      );
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      return strictSchema(node.expression);
    if (ts.isCallExpression(node)) {
      if (nameOf(node.expression) === 'settingSchema') return true;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        [
          'pick',
          'omit',
          'partial',
          'required',
          'extend',
          'safeExtend',
          'strict',
          'passthrough',
          'strip',
          'optional',
          'nullable',
          'default',
          'catch',
          'readonly',
          'array',
        ].includes(node.expression.name.text)
      )
        return strictSchema(node.expression.expression);
    }
    return false;
  };
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) schemaAliases.add(name.text);
    else
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) bind(element.name);
      }
  };
  const declarations = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && strictSchema(node.initializer))
      bind(node.name);
    ts.forEachChild(node, declarations);
  };
  declarations(ast);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const direct = ['parseSetting', 'validateRuntimeSetting'].includes(nameOf(callee));
      const method =
        ts.isPropertyAccessExpression(callee) &&
        [
          'parse',
          'safeParse',
          'parseAsync',
          'safeParseAsync',
          'decode',
          'decodeAsync',
          'safeDecode',
          'safeDecodeAsync',
        ].includes(callee.name.text) &&
        strictSchema(callee.expression);
      const coreParse =
        ts.isPropertyAccessExpression(callee) &&
        [
          'parse',
          'safeParse',
          'parseAsync',
          'safeParseAsync',
          'decode',
          'decodeAsync',
          'safeDecode',
          'safeDecodeAsync',
        ].includes(callee.name.text) &&
        node.arguments[0] !== undefined &&
        strictSchema(node.arguments[0]);
      if (direct || method || coreParse)
        found.push(`${file}: ${node.getText(ast).replace(/\s+/g, ' ')}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

it('has no unreviewed strict parses that can become stored-setting readers', () => {
  const calls: string[] = [];
  for (const tree of ['apps', 'packages']) {
    for (const packageName of readdirSync(`${root}${tree}`)) {
      const dir = `${root}${tree}/${packageName}/src`;
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
        const path = `${entry.parentPath}/${entry.name}`;
        const file = relative(root, path);
        calls.push(...strictCalls(readFileSync(path, 'utf8'), file));
      }
    }
  }
  expect(calls.sort()).toEqual(allowed.map((site) => site.call).sort());
});

it('catches strict readers even when their imports are aliased', () => {
  expect(
    strictCalls(
      "import { EngineModelPinSchema as Pin, parseSetting as parse } from '@bantoozi/shared'; Pin.safeParse(stored); parse('engine.model_pin', stored);",
      'new-reader.ts',
    ),
  ).toHaveLength(2);
});

it('catches derived strict schemas, registry aliases and core parse calls', () => {
  expect(
    strictCalls(
      "import { EngineModelPinSchema as Pin, SETTINGS } from '@bantoozi/shared'; const schema = SETTINGS['engine.model_pin'].schema; schema.parse(stored); Pin.pick({model:true}).parse(stored); z.safeParse(Pin, stored);",
      'new-reader.ts',
    ),
  ).toHaveLength(3);
});

it('catches destructured registry schemas and async or decode reader APIs', () => {
  expect(
    strictCalls(
      `
    import { SETTINGS } from '@bantoozi/shared';
    const { schema } = SETTINGS[k];
    const { schema: renamed } = SETTINGS[k];
    schema.parseAsync(stored);
    renamed.safeParseAsync(stored);
    schema.decode(stored);
    z.decode(renamed, stored);
    z.safeParseAsync(schema, stored);
  `,
      'new-reader.ts',
    ),
  ).toHaveLength(5);
});

it('records a specific review reason for every strict write site', () => {
  expect(new Set(allowed.map((site) => site.reason)).size).toBe(allowed.length);
});

it('keeps stored ranker values stripped before the strict merge validator', () => {
  const argumentAllowed = (argument: string) =>
    argument.startsWith('parseStoredSetting(') ||
    argument === '{}' ||
    argument === 'config.rankerThresholds' ||
    argument === 'await deployedRankerThresholds(db)';
  // A raw stored value must fail this control even if its variable was renamed.
  expect(argumentAllowed('stored')).toBe(false);
  expect(argumentAllowed('thresholds')).toBe(false);
  for (const file of [
    'packages/ranker/src/settings.ts',
    'packages/db/src/api/article-actions.ts',
    'packages/db/src/house/purge-articles.ts',
    'apps/eval/src/experiments/runner.ts',
  ]) {
    const source = read(file);
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    let merges = 0;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'mergeRankerConfig'
      ) {
        merges++;
        expect(argumentAllowed(node.arguments[0]!.getText(ast)), file).toBe(true);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(merges, file).toBeGreaterThan(0);
  }
  // The only permitted stored-value intermediary must itself strip the deployed thresholds.
  expect(read('apps/eval/src/experiments/runner.ts')).toMatch(
    /return parseStoredSetting\('ranker.thresholds', stored \?\? \{\}\)/,
  );
});
