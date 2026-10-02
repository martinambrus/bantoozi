import { OLLAMA_PRICE_TABLE, OLLAMA_PRICE_TABLE_VERSION } from '@bantoozi/engine';
import {
  OLLAMA_PRICES,
  OLLAMA_PRICE_TABLE_VERSION as TRANSLATE_PRICE_TABLE_VERSION,
} from '@bantoozi/translate';
import { describe, expect, it } from 'vitest';

/**
 * E4 translates with `OLLAMA_MODEL_FAST` through tier 2 (`OLLAMA_PRICES`) and the provider
 * validation probes it through the LLM fallback engine (`OLLAMA_PRICE_TABLE`): a model priced in
 * only one of them fails part-way (D-143).
 */
describe('Ollama price tables', () => {
  it('price the same models at the same rates, under the same table version', () => {
    expect(OLLAMA_PRICES).toEqual(OLLAMA_PRICE_TABLE);
    expect(TRANSLATE_PRICE_TABLE_VERSION).toBe(OLLAMA_PRICE_TABLE_VERSION);
  });

  it('price the Free-plan model the golden host uses for E4', () => {
    expect(OLLAMA_PRICE_TABLE['gemma4:31b']).toEqual({
      inputPerMTokUsd: 0.14,
      outputPerMTokUsd: 0.4,
    });
  });
});
