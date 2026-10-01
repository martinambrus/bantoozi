import {
  addLabelExample,
  createUserLabel,
  deleteUserLabel,
  getUserLabel,
  listUserLabels,
  removeLabelExample,
  updateUserLabel,
  type HeldLabel,
  type LabelMutation,
} from '@bantoozi/db';
import {
  AddExampleBodySchema,
  CardIdParamsSchema,
  CreateLabelBodySchema,
  LabelListSchema,
  LabelMutationResponseSchema,
  RemoveExampleBodySchema,
  UpdateLabelBodySchema,
  type LabelDto,
  type LabelMutationResponse,
} from '@bantoozi/shared';
import { normCardText } from '@bantoozi/shared/server';
import type { CardTextStatus } from '@bantoozi/translate';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { CARD_WRITE_LIMIT, prepareCardText, textFields, type CardTextPlan } from './cards.js';

/**
 * Labels (spec 08 §7): neutral organization cards of kind `label`, managed through the label
 * lifecycle of `@bantoozi/db` (spec 05 §5.1) inside `request.mutate`. A new name or definition is a
 * new label card, re-pointed with `label_ids`/`label_suggestions` migrated in the same transaction;
 * a colour or a case/spacing-only rename changes in place. Assigning a label to an article is the
 * articles API (`POST /articles/:id/labels`) and never touches cards.
 */

const CARD_WRITE = { rateLimits: [CARD_WRITE_LIMIT] } as const;

function labelDto(label: HeldLabel): LabelDto {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    definition: label.definition,
    notFor: label.notFor,
    examplesYes: label.examplesYes,
    examplesNo: label.examplesNo,
    count: label.count,
  };
}

function labelMutationResponse(
  mutation: LabelMutation,
  translation: CardTextStatus | null,
): LabelMutationResponse {
  return { label: labelDto(mutation.label), idChange: mutation.idChange, translation };
}

const tags = ['labels'];
const NoContent = z.null();

export const labelRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '',
    { schema: { tags, summary: 'The user’s labels', response: { 200: LabelListSchema } } },
    async (request) => {
      const labels = await request.withTx((tx) => listUserLabels(tx));
      return labels.map(labelDto);
    },
  );

  app.post(
    '',
    {
      config: CARD_WRITE,
      schema: {
        tags,
        summary: 'Create or reuse a label',
        body: CreateLabelBodySchema,
        response: { 201: LabelMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const text = await prepareCardText(app, request, {
        interest: body.definition,
        notFor: body.notFor,
      });
      const outcome = await request.mutate(async (tx) => {
        const mutation = await createUserLabel(tx, {
          name: body.name,
          definition: body.definition,
          ...(body.notFor === undefined ? {} : { notFor: body.notFor }),
          ...(body.color === undefined ? {} : { color: body.color }),
          ...textFields(text),
        });
        return { status: 201, body: labelMutationResponse(mutation, text.status) };
      });
      await reply.code(201).send(outcome.body);
    },
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Recolour, rename or redefine a label (a semantic change returns a new id)',
        params: CardIdParamsSchema,
        body: UpdateLabelBodySchema,
        response: { 200: LabelMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      let text: CardTextPlan = { status: null };
      if (body.name !== undefined || body.definition !== undefined || body.notFor !== undefined) {
        // A semantic change inserts a new label card: prepare its text before the transaction.
        const current = await request.withTx((tx) => getUserLabel(tx, id));
        if (current !== null) {
          const next = {
            interest: body.definition ?? current.definition,
            notFor: body.notFor === undefined ? current.notFor : body.notFor,
          };
          const semantic =
            normCardText(body.name ?? current.cardTitle) !== normCardText(current.cardTitle) ||
            normCardText(next.interest) !== normCardText(current.definition) ||
            normCardText(next.notFor ?? '') !== normCardText(current.notFor ?? '');
          if (semantic) text = await prepareCardText(app, request, next);
        }
      }
      const outcome = await request.mutate(async (tx) => {
        const mutation = await updateUserLabel(tx, {
          labelId: id,
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.definition === undefined ? {} : { definition: body.definition }),
          ...(body.notFor === undefined ? {} : { notFor: body.notFor }),
          ...(body.color === undefined ? {} : { color: body.color }),
          ...textFields(text),
        });
        return { status: 200, body: labelMutationResponse(mutation, text.status) };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/examples',
    {
      config: CARD_WRITE,
      schema: {
        tags,
        summary: 'Add a label example (a private label fork, new id, ids migrated)',
        params: CardIdParamsSchema,
        body: AddExampleBodySchema,
        response: { 200: LabelMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const outcome = await request.mutate(async (tx) => {
        const mutation = await addLabelExample(tx, { labelId: id, ...request.body });
        return { status: 200, body: labelMutationResponse(mutation, null) };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.post(
    '/:id/examples/remove',
    {
      config: CARD_WRITE,
      schema: {
        tags,
        summary: 'Remove a label example (new id, ids migrated)',
        params: CardIdParamsSchema,
        body: RemoveExampleBodySchema,
        response: { 200: LabelMutationResponseSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const outcome = await request.mutate(async (tx) => {
        const mutation = await removeLabelExample(tx, { labelId: id, ...request.body });
        return { status: 200, body: labelMutationResponse(mutation, null) };
      });
      await reply.code(200).send(outcome.body);
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Delete a label and remove it from the user’s articles',
        params: CardIdParamsSchema,
        response: { 204: NoContent },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      await request.mutate(async (tx) => {
        await deleteUserLabel(tx, { labelId: id });
        return { status: 204, body: null };
      });
      await reply.code(204).send(null);
    },
  );
};
