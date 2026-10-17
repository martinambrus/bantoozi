import type { CardDraft } from '@bantoozi/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { useApi } from '../../api/context.js';
import { accountKey } from '../../api/query-keys.js';
import { routes } from '../../api/routes.js';
import { useAccountId } from '../../session/context.js';

/** How often a pending draft is read again. */
export const CARD_DRAFT_POLL_MS = 1_000;
/** After this long the editor stops waiting and keeps what it has. */
export const CARD_DRAFT_GIVE_UP_MS = 30_000;

/**
 * - `drafting`: asked, the worker has not answered yet
 * - `ready`: the proposal is in `draft`
 * - `unavailable`: no draft (the request failed, the worker failed or took too long)
 */
export type CardDraftState =
  { status: 'drafting' } | { status: 'ready'; draft: CardDraft } | { status: 'unavailable' };

/**
 * Asks once for a draft of a card describing `articleIds` (D-240) and follows it until it is
 * answered. Without articles nothing is asked and the state stays `unavailable`.
 */
export function useCardDraft(
  articleIds: readonly string[] | undefined,
  kind: 'interest' | 'never' = 'interest',
): CardDraftState {
  const api = useApi();
  const accountId = useAccountId();
  const [id, setId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(false);
  // One request per editor, kept across a StrictMode re-run of the effect: each run listens to it.
  const request = useRef<Promise<CardDraft> | null>(null);
  // The articles of one editor do not change while it is open: the first list is the one asked for.
  const ids = useRef(articleIds);
  // Asked once per editor: the kind it opened with (a Never hint asks for a Never card, D-265).
  const kindAsked = useRef(kind);
  const wanted = articleIds !== undefined && articleIds.length > 0;

  useEffect(() => {
    const first = ids.current;
    if (first === undefined || first.length === 0) return undefined;
    request.current ??= api.call(routes.cardDraftCreate, {
      body: { articleIds: [...first], kind: kindAsked.current },
    });
    let live = true;
    request.current.then(
      (draft) => {
        if (live) setId(draft.id);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    const timer = setTimeout(() => {
      if (live) setExpired(true);
    }, CARD_DRAFT_GIVE_UP_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api]);

  const query = useQuery({
    queryKey: accountKey(accountId, 'card-draft', id ?? ''),
    queryFn: ({ signal }) =>
      api.call(routes.cardDraftGet, { params: { id: id ?? '' } }, { signal }),
    enabled: id !== null && !expired,
    refetchInterval: (current) =>
      current.state.data?.status === 'pending' ? CARD_DRAFT_POLL_MS : false,
  });

  if (!wanted || failed) return { status: 'unavailable' };
  const draft = query.data;
  if (draft?.status === 'complete') return { status: 'ready', draft };
  if (draft?.status === 'failed' || query.isError || expired) return { status: 'unavailable' };
  return { status: 'drafting' };
}
