import { normCardText } from '@bantoozi/shared/server';
import { sql } from 'drizzle-orm';

import type { TenantTx } from '../tenant.js';
import {
  withAddedExample,
  examplesOf,
  hasExamples,
  withRemovedExample,
  sameCardText,
  type CardExamples,
} from './body.js';
import {
  activeFeedIds,
  applyEffects,
  articleExample,
  carriedExamples,
  checkQuota,
  conflict,
  countLabelHoldings,
  demandFeedIds,
  exampleTarget,
  forkSpec,
  loadSubscriptions,
  lockFeeds,
  lockLabelHolding,
  lockTenant,
  migrateLabelIds,
  noEffects,
  notFound,
  obtainCard,
  removeLabelIds,
  requireCard,
  requireLabelHolding,
  type CardRow,
  type LabelHolding,
  type Subscription,
  type Tenant,
} from './store.js';
import type { CardRemoval, HeldLabel, LabelMutation } from './types.js';
import {
  DEFAULT_LABEL_COLOR,
  invalidField,
  validateCardExample,
  validateCardInterest,
  validateCardLang,
  validateCardNotFor,
  validateCardTitle,
  validateCardTranslation,
  validateExampleSide,
  validateId,
  validateLabelColor,
  type CardTranslationPair,
  type ExampleSide,
} from './validation.js';
import { getUserLabel } from './views.js';

/**
 * The label lifecycle of spec 05 §5.1 (the API's `/labels`, spec 08 §7). A label is a card of kind
 * `label` whose hashed text includes its title, so a new name or definition is another card; its
 * examples live in private label forks (bounded by `maxLabels`, not `maxForks`). Every re-point moves
 * the user's `label_ids`/`label_suggestions` with `array_replace` in the same transaction. Labels
 * never train the interest model (`learn` is false); adding, removing or re-pointing one is a full
 * rank (spec 06 §7). Assigning a label to an article does not touch cards (spec 08 §5.3, M4).
 *
 * Conflicts (`409 CONFLICT`, `details.reason`): `already_held` — creating a label the user already
 * holds under another name or colour; `target_held` — the label card an edit leads to is already
 * held under another name or colour (the same name and colour coalesce the two).
 */

/** Fields of `POST /labels` plus the API's detected language and English pair. */
export interface CreateUserLabelInput {
  name: string;
  definition: string;
  notFor?: string | null | undefined;
  /** `#rrggbb`; the stored default applies when omitted. */
  color?: string | undefined;
  lang?: string | undefined;
  translation?: CardTranslationPair | null | undefined;
}

/** Fields of `PATCH /labels/:id`: `color` changes in place, name or definition re-point. */
export interface UpdateUserLabelInput {
  labelId: string;
  name?: string | undefined;
  definition?: string | undefined;
  notFor?: string | null | undefined;
  color?: string | undefined;
  lang?: string | undefined;
  translation?: CardTranslationPair | null | undefined;
}

async function requireHeldLabel(tx: TenantTx, labelId: string): Promise<HeldLabel> {
  const label = await getUserLabel(tx, labelId);
  if (label === null) throw notFound('label');
  return label;
}

/** Labels are unscoped: every active subscription materializes them (spec 02 §6). */
async function labelFeeds(tx: TenantTx, me: Tenant): Promise<Subscription[]> {
  const subscriptions = await loadSubscriptions(tx, me.userId);
  await lockFeeds(tx, activeFeedIds(subscriptions));
  return subscriptions;
}

/**
 * Move the user's label from `current` to `target` with `name`/`color`, migrating article label ids
 * and suggestions. When the user already holds `target` as a label: the same name and colour
 * coalesce the two, anything else is `target_held` with nothing changed.
 */
async function repointLabel(
  tx: TenantTx,
  me: Tenant,
  args: {
    current: CardRow;
    target: CardRow;
    name: string;
    color: string;
    subscriptions: readonly Subscription[];
  },
): Promise<LabelMutation> {
  const { current, target } = args;
  const change = { from: current.id, to: target.id };
  const other = await lockLabelHolding(tx, me.userId, target.id);
  let coalesced = false;
  if (other !== null) {
    if (other.name !== args.name || other.color !== args.color) {
      throw conflict('target_held', { labelId: target.id });
    }
    await tx.execute(sql`
      DELETE FROM user_labels WHERE user_id = ${me.userId}::uuid AND card_id = ${current.id}::bigint`);
    coalesced = true;
  } else {
    await tx.execute(sql`
      UPDATE user_labels SET card_id = ${target.id}::bigint, name = ${args.name}, color = ${args.color}
       WHERE user_id = ${me.userId}::uuid AND card_id = ${current.id}::bigint`);
  }
  await migrateLabelIds(tx, me.userId, change);
  const effects = await applyEffects(tx, me.userId, {
    refreshFeedIds: activeFeedIds(args.subscriptions),
    backfill: coalesced
      ? null
      : { cardIds: [target.id], feedIds: await demandFeedIds(tx, me.userId, args.subscriptions) },
    rankFull: true,
    learn: false,
    labelIdChange: change,
    reason: 'labels',
  });
  return {
    label: await requireHeldLabel(tx, target.id),
    idChange: change,
    created: false,
    effects,
  };
}

/**
 * **Create a label**: as Create with `kind = 'label'` (the hash includes the name), then
 * `user_labels (card_id, name, color)`. Re-creating a held label with the same name (and colour, when
 * given) is an idempotent replay. Quota `maxLabels`.
 */
export async function createUserLabel(
  tx: TenantTx,
  input: CreateUserLabelInput,
): Promise<LabelMutation> {
  const name = validateCardTitle(input.name, 'name');
  const definition = validateCardInterest(input.definition, 'definition');
  const notFor = validateCardNotFor(input.notFor);
  const color = input.color === undefined ? null : validateLabelColor(input.color);
  const lang = validateCardLang(input.lang);
  const translation = validateCardTranslation(input.translation, notFor, lang);

  const me = await lockTenant(tx);
  const subscriptions = await labelFeeds(tx, me);
  const { card, unretired } = await obtainCard(tx, me.userId, {
    kind: 'label',
    title: name,
    interest: definition,
    notFor,
    examplesYes: [],
    examplesNo: [],
    private: false,
    parentCardId: null,
    lang,
    topicIds: [],
    i18n: {},
    translation,
  });
  const existing = await lockLabelHolding(tx, me.userId, card.id);
  if (existing !== null) {
    if (existing.name !== name || (color !== null && existing.color !== color)) {
      throw conflict('already_held', { labelId: card.id });
    }
    const effects = unretired
      ? await applyEffects(tx, me.userId, {
          refreshFeedIds: activeFeedIds(subscriptions),
          backfill: null,
          rankFull: false,
          learn: false,
          labelIdChange: null,
          reason: 'labels',
        })
      : noEffects();
    return { label: await requireHeldLabel(tx, card.id), idChange: null, created: false, effects };
  }

  const used = await countLabelHoldings(tx, me.userId);
  checkQuota('maxLabels', used, used + 1, me.limits.maxLabels);
  await tx.execute(sql`
    INSERT INTO user_labels (user_id, card_id, name, color)
    VALUES (${me.userId}::uuid, ${card.id}::bigint, ${name}, ${color ?? DEFAULT_LABEL_COLOR})`);
  const effects = await applyEffects(tx, me.userId, {
    refreshFeedIds: activeFeedIds(subscriptions),
    backfill: { cardIds: [card.id], feedIds: await demandFeedIds(tx, me.userId, subscriptions) },
    rankFull: true,
    learn: false,
    labelIdChange: null,
    reason: 'labels',
  });
  return { label: await requireHeldLabel(tx, card.id), idChange: null, created: true, effects };
}

async function changeLabelExamples(
  tx: TenantTx,
  labelId: string,
  edit: (userId: string, examples: CardExamples) => Promise<CardExamples | null>,
): Promise<LabelMutation> {
  const me = await lockTenant(tx);
  const holding = await requireLabelHolding(tx, me.userId, labelId);
  const current = await requireCard(tx, labelId, 'label');
  const subscriptions = await labelFeeds(tx, me);
  const examples = await edit(me.userId, examplesOf(current.body));
  if (examples === null) {
    return {
      label: await requireHeldLabel(tx, labelId),
      idChange: null,
      created: false,
      effects: noEffects(),
    };
  }
  const target = await exampleTarget(tx, me.userId, current, examples);
  return repointLabel(tx, me, {
    current,
    target,
    name: holding.name,
    color: holding.color,
    subscriptions,
  });
}

/**
 * **Add a label example** (`POST /labels/:id/examples {articleId, side}`): fork the label with the
 * article's title as the newest example, re-point `user_labels` and migrate `label_ids`.
 */
export async function addLabelExample(
  tx: TenantTx,
  input: { labelId: string; articleId: string; side: ExampleSide },
): Promise<LabelMutation> {
  const labelId = validateId(input.labelId, 'labelId');
  const articleId = validateId(input.articleId, 'articleId');
  const side = validateExampleSide(input.side);
  return changeLabelExamples(tx, labelId, async (userId, examples) =>
    withAddedExample(examples, side, await articleExample(tx, userId, articleId)),
  );
}

/** **Remove a label example** (`POST /labels/:id/examples/remove {side, text}`). */
export async function removeLabelExample(
  tx: TenantTx,
  input: { labelId: string; side: ExampleSide; text: string },
): Promise<LabelMutation> {
  const labelId = validateId(input.labelId, 'labelId');
  const side = validateExampleSide(input.side);
  const text = validateCardExample(input.text);
  return changeLabelExamples(tx, labelId, async (_userId, examples) => {
    const next = withRemovedExample(examples, side, text);
    if (next === null) throw notFound('example');
    return next;
  });
}

/**
 * **Rename or redefine a label** (`PATCH /labels/:id`): a new name (by `norm`) or definition is a new
 * label card by hash (a label with examples gets a fork carrying them), re-pointed with the same
 * `array_replace`. `color`, or a name differing only in case or spacing, changes `user_labels` in
 * place without effects.
 */
export async function updateUserLabel(
  tx: TenantTx,
  input: UpdateUserLabelInput,
): Promise<LabelMutation> {
  const labelId = validateId(input.labelId, 'labelId');
  const name = input.name === undefined ? undefined : validateCardTitle(input.name, 'name');
  const definition =
    input.definition === undefined
      ? undefined
      : validateCardInterest(input.definition, 'definition');
  const notFor = input.notFor === undefined ? undefined : validateCardNotFor(input.notFor);
  const color = input.color === undefined ? undefined : validateLabelColor(input.color);
  if (
    name === undefined &&
    definition === undefined &&
    notFor === undefined &&
    color === undefined
  ) {
    throw invalidField('body', 'empty');
  }

  const me = await lockTenant(tx);
  const holding: LabelHolding = await requireLabelHolding(tx, me.userId, labelId);
  const current = await requireCard(tx, labelId, 'label');
  const nextName = name ?? holding.name;
  const nextColor = color ?? holding.color;
  const nextTitle = name ?? current.title;
  const nextText = {
    interest: definition ?? current.body.interest,
    notFor: notFor === undefined ? current.body.notFor : notFor,
  };
  const semantic =
    !sameCardText(nextText, current.body) ||
    normCardText(nextTitle) !== normCardText(current.title);

  if (!semantic) {
    if (nextName !== holding.name || nextColor !== holding.color) {
      await tx.execute(sql`
        UPDATE user_labels SET name = ${nextName}, color = ${nextColor}
         WHERE user_id = ${me.userId}::uuid AND card_id = ${labelId}::bigint`);
    }
    return {
      label: await requireHeldLabel(tx, labelId),
      idChange: null,
      created: false,
      effects: noEffects(),
    };
  }

  const lang = validateCardLang(input.lang);
  const translation = validateCardTranslation(input.translation, nextText.notFor, lang);
  const subscriptions = await labelFeeds(tx, me);
  const shared = await obtainCard(tx, me.userId, {
    kind: 'label',
    title: nextTitle,
    interest: nextText.interest,
    notFor: nextText.notFor,
    examplesYes: [],
    examplesNo: [],
    private: false,
    parentCardId: null,
    lang,
    topicIds: [],
    i18n: {},
    translation,
  });
  const examples = carriedExamples(current);
  const target = hasExamples(examples)
    ? (await obtainCard(tx, me.userId, forkSpec(shared.card, examples))).card
    : shared.card;
  return repointLabel(tx, me, { current, target, name: nextName, color: nextColor, subscriptions });
}

/** **Set a label's colour** in place (no card change, no effects). */
export function setLabelColor(
  tx: TenantTx,
  input: { labelId: string; color: string },
): Promise<LabelMutation> {
  return updateUserLabel(tx, input);
}

/**
 * **Delete a label**: remove its id from the user's `label_ids`/`label_suggestions` and delete the
 * `user_labels` row in one transaction. Effects: refresh, rank full.
 */
export async function deleteUserLabel(
  tx: TenantTx,
  input: { labelId: string },
): Promise<CardRemoval> {
  const labelId = validateId(input.labelId, 'labelId');
  const me = await lockTenant(tx);
  await requireLabelHolding(tx, me.userId, labelId);
  const subscriptions = await labelFeeds(tx, me);
  await removeLabelIds(tx, me.userId, labelId);
  await tx.execute(sql`
    DELETE FROM user_labels WHERE user_id = ${me.userId}::uuid AND card_id = ${labelId}::bigint`);
  const effects = await applyEffects(tx, me.userId, {
    refreshFeedIds: activeFeedIds(subscriptions),
    backfill: null,
    rankFull: true,
    learn: false,
    labelIdChange: null,
    reason: 'labels',
  });
  return { effects };
}
