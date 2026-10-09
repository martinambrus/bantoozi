import type { APIRequestContext } from '@playwright/test';

import { call, callJson } from '../support/api.js';

interface SessionView {
  id: string;
  current: boolean;
}

function otherSessions(device: APIRequestContext): Promise<SessionView[]> {
  return callJson<SessionView[]>(device, 'GET', '/api/v1/auth/sessions').then((sessions) =>
    sessions.filter((session) => !session.current),
  );
}

/** How many sessions the account has besides the one `device` is signed in with. */
export async function otherSessionCount(device: APIRequestContext): Promise<number> {
  return (await otherSessions(device)).length;
}

/**
 * Settings → Sessions from another device: ends every session of the account but the one `device`
 * is signed in with (spec 08 §2). Returns how many it ended.
 */
export async function endOtherSessions(device: APIRequestContext): Promise<number> {
  const others = await otherSessions(device);
  for (const { id } of others) {
    const response = await call(device, 'DELETE', `/api/v1/auth/sessions/${id}`);
    if (response.status() !== 204) {
      throw new Error(
        `ending session ${id} answered ${response.status()}: ${await response.text()}`,
      );
    }
  }
  return others.length;
}
