import type { IdChange, LabelDto, LabelMutationResponse } from '@bantoozi/shared';

import { json } from '../api/fake-fetch.js';
import { makeMe } from '../session/fixtures.js';
import type { ApiRouteHandler, FakeServer } from '../support/app.js';

export function makeLabel(overrides: Partial<LabelDto> = {}): LabelDto {
  return {
    id: '31',
    name: 'Read later',
    color: '#2563eb',
    definition: 'Long reads to come back to',
    notFor: null,
    examplesYes: [],
    examplesNo: [],
    count: 0,
    ...overrides,
  };
}

/** The answer of every label mutation that leaves the user holding a label. */
export function labelResult(
  label: LabelDto,
  idChange: IdChange | null = null,
  translation: LabelMutationResponse['translation'] = null,
): LabelMutationResponse {
  return { label, idChange, translation };
}

/** A fake API for the labels screen: `GET /labels` answers from `labels`; `routes` adds the rest. */
export function labelsServer(
  labels: LabelDto[],
  routes: Record<string, ApiRouteHandler> = {},
  me = makeMe(),
): FakeServer {
  return { me, routes: { 'GET /labels': () => json(200, labels), ...routes } };
}
