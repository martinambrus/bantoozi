import { describe, expect, it } from 'vitest';

import {
  LIBRARY_FILE_L1S,
  isLocalLibraryCard,
  libraryCardTextHash,
  libraryEntryProblems,
  libraryProblems,
  loadLibraryCards,
  readLibraryFiles,
  topicL1,
  type LibraryCardEntry,
} from '../src/index.js';

/** The ten example rows of spec 05 §8, which the seed must include exactly. */
const SPEC_EXAMPLES = [
  {
    slug: 'ev-batteries',
    title: 'EV battery tech',
    interest:
      'New battery chemistry and manufacturing for electric vehicles (solid-state, sodium-ion, LFP)',
    not_for: 'Stock-price moves; car launch PR without battery detail',
    topic_ids: ['transport.ev', 'science.physics_chemistry'],
  },
  {
    slug: 'rust-lang',
    title: 'Rust programming',
    interest: 'The Rust programming language: releases, libraries, tooling and real-world use',
    not_for: 'Rust the video game; corrosion',
    topic_ids: ['technology.software_dev'],
  },
  {
    slug: 'llm-research',
    title: 'LLM research',
    interest: 'Research results and technical deep-dives about large language models',
    not_for: 'Consumer product announcements without technical content',
    topic_ids: ['technology.ai_ml', 'science.research_academia'],
  },
  {
    slug: 'sk-politics',
    title: 'Slovak politics',
    interest: 'Slovak domestic politics: government, parliament, parties and coalition disputes',
    not_for: 'Foreign politics mentioning Slovakia in passing',
    topic_ids: ['local.slovakia', 'politics.domestic'],
  },
  {
    slug: 'cz-tech-scene',
    title: 'Czech tech scene',
    interest: 'Czech tech startups, funding rounds and technology companies',
    not_for: 'Global tech news without a Czech angle',
    topic_ids: ['local.czechia', 'business.startups'],
  },
  {
    slug: 'tatras-hiking',
    title: 'Hiking in the Tatras',
    interest: 'Hiking routes, trail conditions and mountain safety in the High and Low Tatras',
    not_for: 'General travel deals',
    topic_ids: ['lifestyle.travel', 'local.slovakia'],
  },
  {
    slug: 'nhl-slovaks',
    title: 'Slovaks in the NHL',
    interest: 'Slovak and Czech players in the NHL: games, trades and stats',
    not_for: 'Other leagues',
    topic_ids: ['sports.ice_hockey'],
  },
  {
    slug: 'home-assistant',
    title: 'Smart home DIY',
    interest: 'Home Assistant, self-hosted home automation and smart-home hardware hacking',
    not_for: 'Commercial smart-speaker ads',
    topic_ids: ['diy.electronics_diy', 'technology.hardware_gadgets'],
  },
  {
    slug: 'space-launches',
    title: 'Space launches',
    interest: 'Rocket launches, spacecraft missions and launch-industry news',
    not_for: 'Astrology; sci-fi films',
    topic_ids: ['science.space'],
  },
  {
    slug: 'personal-finance-eu',
    title: 'Personal finance (EU)',
    interest:
      'Saving, investing and pensions for individuals in the EU, especially Slovakia and Czechia',
    not_for: 'Corporate earnings',
    topic_ids: ['business.personal_finance'],
  },
];

const VALID: LibraryCardEntry = {
  slug: 'student-laptops',
  title: 'Student laptops',
  title_sk: 'Notebooky pre študentov',
  interest: 'Laptops and notebooks for students: reviews, comparisons and buying advice',
  interest_sk: 'Notebooky pre študentov: recenzie, porovnania a rady pri kúpe',
  not_for: 'Paper notebooks and stationery',
  topic_ids: ['shopping.buying_guides', 'technology.hardware_gadgets'],
  examples_yes: ['The best laptops for students this year'],
  examples_no: ['Notebook and pen sets for school'],
};

const problemsOf = (entry: unknown, l1 = 'shopping') =>
  libraryEntryProblems(entry, l1).map((problem) => problem.replace(/^[^:]+: /, ''));

describe('card library (spec 05 §8)', () => {
  const cards = loadLibraryCards();
  const files = readLibraryFiles();

  it('is valid: structure, lengths, topics, unique slugs and texts', () => {
    expect(libraryProblems(files)).toEqual([]);
    expect(new Set(cards.map((card) => card.slug)).size).toBe(cards.length);
    expect(new Set(cards.map(libraryCardTextHash)).size).toBe(cards.length);
  });

  it('has ≥ 150 cards, ≥ 5 per level-1 topic except other and ≥ 15 for Slovakia/Czechia', () => {
    expect(cards.length).toBeGreaterThanOrEqual(150);
    expect([...files.keys()]).toEqual([...LIBRARY_FILE_L1S]);
    expect(LIBRARY_FILE_L1S).toHaveLength(19);
    expect(LIBRARY_FILE_L1S).not.toContain('other');
    for (const [l1, entries] of files) {
      expect(entries.length, l1).toBeGreaterThanOrEqual(5);
      for (const entry of entries as LibraryCardEntry[]) {
        expect(topicL1(entry.topic_ids[0] ?? ''), entry.slug).toBe(l1);
      }
    }
    expect(cards.filter(isLocalLibraryCard).length).toBeGreaterThanOrEqual(15);
  });

  it('includes the ten example rows of spec 05 §8 exactly', () => {
    for (const example of SPEC_EXAMPLES) {
      const card = cards.find((entry) => entry.slug === example.slug);
      expect(card, example.slug).toBeDefined();
      expect(card).toMatchObject(example);
      expect(card?.examples_yes).toBeUndefined();
      expect(card?.examples_no).toBeUndefined();
    }
  });

  it('carries a Slovak display title and interest for every card', () => {
    for (const card of cards) {
      expect(card.title_sk.trim(), card.slug).not.toBe('');
      expect(card.interest_sk?.trim(), card.slug).toBeTruthy();
    }
  });

  it('validates wording semantically, not with a substring ban on "not"', () => {
    expect(problemsOf(VALID)).toEqual([]);
    expect(
      problemsOf({ ...VALID, interest: 'Notable notebooks and nothing else but annotations' }),
    ).toEqual([]);
  });

  it('rejects invalid entries', () => {
    expect(problemsOf({ ...VALID, interest: 'x'.repeat(201) })).toEqual([
      'interest must have 3..200 characters (has 201)',
    ]);
    expect(problemsOf({ ...VALID, not_for: 'x'.repeat(201) })).toEqual([
      'not_for must have 1..200 characters (has 201)',
    ]);
    expect(problemsOf({ ...VALID, title: 'x'.repeat(61) })).toEqual([
      'title must have 1..60 characters (has 61)',
    ]);
    expect(problemsOf({ ...VALID, title_sk: undefined })).toEqual(['title_sk must be a string']);
    expect(problemsOf({ ...VALID, interest: ' padded' })).toEqual([
      'interest has leading or trailing whitespace',
    ]);
    expect(problemsOf({ ...VALID, slug: 'Bad Slug' })).toEqual([
      'slug must match [a-z0-9][a-z0-9-]{0,99}',
    ]);
    expect(problemsOf({ ...VALID, colour: 'red' })).toEqual(['unknown field colour']);
    expect(problemsOf({ ...VALID, topic_ids: [] })).toEqual([
      'topic_ids must be a non-empty array',
    ]);
    expect(problemsOf({ ...VALID, topic_ids: ['shopping.deals', 'technology.quantum'] })).toEqual([
      'unknown topic id technology.quantum',
    ]);
    expect(problemsOf({ ...VALID, topic_ids: ['shopping.deals', 'other'] })).toEqual([
      'unknown topic id other',
    ]);
    expect(problemsOf({ ...VALID, topic_ids: ['shopping.deals', 'shopping.deals'] })).toEqual([
      'topic_ids has duplicates',
    ]);
    expect(problemsOf(VALID, 'technology')).toEqual([
      'the first topic shopping.buying_guides is not under technology, the level-1 topic of its file',
    ]);
    expect(problemsOf({ ...VALID, examples_yes: ['a', 'b', 'c', 'd'] })).toEqual([
      'examples_yes has more than 3 entries',
    ]);
    expect(problemsOf({ ...VALID, examples_no: ['a', 'b', 'c'] })).toEqual([
      'examples_no has more than 2 entries',
    ]);
    expect(problemsOf({ ...VALID, examples_no: [] })).toEqual([
      'examples_no must be omitted rather than empty',
    ]);
    expect(problemsOf({ ...VALID, examples_yes: 'one' })).toEqual([
      'examples_yes must be an array',
    ]);
    expect(problemsOf({ ...VALID, examples_yes: ['x'.repeat(201)] })).toEqual([
      'examples_yes[0] must have 1..200 characters (has 201)',
    ]);
    expect(problemsOf('nope')).toEqual(['entry must be an object']);
    expect(libraryEntryProblems({ ...VALID, slug: 7 }, 'shopping')[0]).toMatch(
      /^shopping\/\?: slug/,
    );
  });

  it('checks the library as a whole', () => {
    const small = new Map<string, unknown[]>([
      ['shopping', [VALID, { ...VALID, title: 'Other title' }]],
      ['unknown', []],
    ]);
    const problems = libraryProblems(small);
    expect(problems).toContain('unexpected library file unknown');
    expect(problems).toContain('missing library file technology');
    expect(problems).toContain('shopping has 2 cards (at least 5)');
    expect(problems).toContain('duplicate slug student-laptops (shopping and shopping)');
    expect(problems).toContain('student-laptops has the same text as student-laptops');
    expect(problems).toContain('the library has 2 cards (at least 150)');
    expect(problems).toContain('0 cards are specific to Slovakia/Czechia (at least 15)');
    expect(libraryProblems(new Map([['shopping', ['bad']]]))).toContain(
      'shopping/?: entry must be an object',
    );
  });

  it('reads the files next to the module and fails loudly on a malformed file', () => {
    expect(() => readLibraryFiles(new URL('./fixtures/not-an-array/', import.meta.url))).toThrow(
      /must hold an array/,
    );
  });
});
