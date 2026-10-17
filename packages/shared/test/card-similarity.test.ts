import { describe, expect, it } from 'vitest';

import {
  SIMILAR_CARD_MIN,
  cardTextSimilarity,
  cardTopicWords,
  mostSimilarCard,
} from '../src/index.js';

const card = (title: string, interest: string) => ({ title, interest });

describe('card text similarity (D-265)', () => {
  it('reads topic words only: normalized, generic card wording left out', () => {
    expect([...cardTopicWords('Space Science', 'Articles focusing on orbital dynamics.')]).toEqual([
      'space',
      'science',
      'orbital',
      'dynamics',
    ]);
    expect([...cardTopicWords('Šport', 'Články o výsledkoch futbalových zápasov.')]).toEqual([
      'sport',
      'vysledkoch',
      'futbalovych',
      'zapasov',
    ]);
  });

  it('separates a restated card from cards sharing one broad word (owner calibration)', () => {
    const consumer = card(
      'Consumer Technology',
      'Articles about updates to digital platforms, consumer electronics, and software releases.',
    );
    const computing = card(
      'Computing and Technology',
      'Articles focusing on software development, artificial intelligence, and hardware innovations.',
    );
    const restated = card(
      'Consumer technology',
      'Updates to digital platforms, consumer electronics and software releases.',
    );
    expect(cardTextSimilarity(computing, consumer)).toBeLessThan(SIMILAR_CARD_MIN);
    expect(cardTextSimilarity(restated, consumer)).toBeGreaterThanOrEqual(SIMILAR_CARD_MIN);
    expect(cardTextSimilarity(consumer, consumer)).toBe(1);
    expect(cardTextSimilarity(card('', 'and the'), card('', 'about'))).toBe(0);
  });

  it('names the most similar held card above the bar, or none', () => {
    const held = [
      { id: '1', ...card('Garden birds', 'Which birds visit gardens in winter.') },
      { id: '2', ...card('Winter garden birds', 'Birds that visit gardens in winter and why.') },
    ];
    const proposal = card(
      'Garden birds in winter',
      'Which birds visit gardens in winter, and why.',
    );
    expect(mostSimilarCard(proposal, held)?.card.id).toBe('2');
    expect(mostSimilarCard(card('Rockets', 'Rocket launches.'), held)).toBeNull();
  });
});
