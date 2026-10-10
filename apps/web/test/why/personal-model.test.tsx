import type { Explain } from '@bantoozi/shared';
import { describe, expect, it } from 'vitest';

import type { Language } from '../../src/i18n/index.js';
import { checkUnhandled, describeDrawer, makeExplain, renderDrawer } from './support.js';

checkUnhandled();

type Top = NonNullable<Explain['model']>['top'];

async function modelLines(top: Top, language: Language) {
  const { dialog } = await renderDrawer({
    language,
    explain: makeExplain({
      source: 'model',
      p: 0.7,
      tier: 4,
      cards: [],
      model: { version: 2, top },
    }),
  });
  const lines = describeDrawer(dialog).split('\n');
  const start = lines.findIndex((line) => /^## (Your personal model|Váš osobný model)$/.test(line));
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

const feat = (feature: string, contribution: number, label = 'SERVER'): Top[number] => ({
  feature,
  label,
  contribution,
});

const FAMILIES: [string, number][] = [
  ['best.love', 0.9],
  ['known.best.must', 0.8],
  ['ct.opinion', 0.7],
  ['t1.technology', 0.6],
  ['depth', 0.5],
  ['len.long', 0.4],
  ['age.lt24h', 0.3],
  ['lang.sk', 0.2],
  ['img.heavy', 0.1],
];

describe('personal model contributions are worded from their feature keys', () => {
  it('English phrases for one key of each family', async () => {
    const lines = await modelLines(
      FAMILIES.slice(0, 3).map(([f, c]) => feat(f, c)),
      'en',
    );
    expect(lines).toEqual([
      '- your Love interests: raised the score',
      '- whether your Must interests could be checked: raised the score',
      '- Type: Opinion: raised the score',
      'These are associations the model has learned, not reasons.',
    ]);
  });

  it.each([
    ['t1.technology', 'Topic: Technology'],
    ['depth', 'Depth'],
    ['len.long', 'Long article'],
    ['age.lt24h', 'Published within a day'],
    ['lang.sk', 'Written in Slovak'],
    ['img.heavy', 'Many images'],
    ['feed.h3', 'articles from this source group'],
    ['author.h5', 'articles by this author group'],
    ['card.31', 'EV battery tech'],
    ['known.card.31', 'EV battery tech'],
  ])('English %s', async (feature, phrase) => {
    const lines = await modelLines([feat(feature, 0.5, 'EV battery tech')], 'en');
    expect(lines[0]).toBe(`- ${phrase}: raised the score`);
  });

  it.each([
    ['best.love', 'vaše záujmy „Milujem“'],
    ['known.best.must', 'či sa dali skontrolovať vaše záujmy „Určite“'],
    ['ct.opinion', 'Typ: Komentár'],
    ['t1.technology', 'Téma: Technológie'],
    ['depth', 'Hĺbka'],
    ['len.long', 'Dlhý článok'],
    ['age.lt24h', 'Zverejnený za posledný deň'],
    ['lang.sk', 'Napísaný po slovensky'],
    ['img.heavy', 'Veľa obrázkov'],
    ['feed.h3', 'články z tejto skupiny zdrojov'],
    ['author.h5', 'články od tejto skupiny autorov'],
    ['card.31', 'EV battery tech'],
  ])('Slovak %s', async (feature, phrase) => {
    const lines = await modelLines([feat(feature, 0.5, 'EV battery tech')], 'sk');
    expect(lines[0]).toBe(`- ${phrase}: zvýšilo skóre`);
  });

  it('says raised or lowered by the sign of the contribution', async () => {
    const en = await modelLines([feat('depth', 0.4), feat('len.long', -0.9)], 'en');
    expect(en.slice(0, 2)).toEqual([
      '- Long article: lowered the score',
      '- Depth: raised the score',
    ]);
    const sk = await modelLines([feat('depth', -0.4)], 'sk');
    expect(sk[0]).toBe('- Hĺbka: znížilo skóre');
  });

  it('falls back to the server label for an unknown key', async () => {
    const lines = await modelLines([feat('future.thing', 0.4, 'Something new')], 'en');
    expect(lines[0]).toBe('- Something new: raised the score');
  });

  it('notes that these are associations, not reasons', async () => {
    expect(await modelLines([feat('depth', 0.4)], 'en')).toContain(
      'These are associations the model has learned, not reasons.',
    );
    expect(await modelLines([feat('depth', 0.4)], 'sk')).toContain(
      'Ide o súvislosti, ktoré sa model naučil, nie o dôvody.',
    );
  });
});
