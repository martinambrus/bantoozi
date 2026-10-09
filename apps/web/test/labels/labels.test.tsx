import { CARD_LIMITS, type LabelDto } from '@bantoozi/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { accountKey } from '../../src/api/query-keys.js';
import { UUID_V4, failure, json, noContent } from '../api/fake-fetch.js';
import { READER_READS, createHarness } from '../auth/harness.js';
import { setDesktop } from '../reader/support.js';
import { USER_A_ID, makeMe } from '../session/fixtures.js';
import { bodyOf, type ApiRouteHandler } from '../support/app.js';
import { labelResult, labelsServer, makeLabel } from './support.js';

const { open } = createHarness();

const LABELS_KEY = accountKey(USER_A_ID, 'labels');

const readLater = makeLabel({
  count: 12,
  notFor: 'Breaking news',
  examplesYes: ['A long essay about ferries'],
  examplesNo: ['Weather alert'],
});
const recipes = makeLabel({
  id: '32',
  name: 'Recipes',
  color: '#16a34a',
  definition: 'Cooking ideas',
  count: 1,
});
const misc = makeLabel({
  id: '33',
  name: 'Misc',
  color: '#64748b',
  definition: 'Everything else',
  count: 0,
});

const FIELDS = {
  name: 'Name',
  definition: 'Definition',
  notFor: 'But not (optional)',
  color: 'Colour',
};

function openLabels(
  labels: LabelDto[] = [readLater, recipes, misc],
  routes: Record<string, ApiRouteHandler> = {},
) {
  return open({ path: '/labels', server: labelsServer(labels, routes) });
}

const rowOf = (name: string) => screen.findByRole('listitem', { name });

async function openCreate(routes: Record<string, ApiRouteHandler> = {}, labels: LabelDto[] = []) {
  const app = await openLabels(labels, routes);
  await app.user.click(await screen.findByRole('button', { name: 'New label' }));
  const dialog = screen.getByRole('dialog', { name: 'New label' });
  return { app, dialog, form: within(dialog) };
}

async function openEdit(label = readLater, routes: Record<string, ApiRouteHandler> = {}) {
  const app = await openLabels([label], routes);
  await app.user.click(within(await rowOf(label.name)).getByRole('button', { name: 'Edit' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit label' });
  return { app, dialog, form: within(dialog) };
}

describe('the labels list', () => {
  it('shows each label with its name, colour, definition, "but not" and article count', async () => {
    await openLabels();

    const row = await rowOf('Read later');

    expect(within(row).getByText('Long reads to come back to')).toBeVisible();
    expect(within(row).getByText('But not: Breaking news')).toBeVisible();
    expect(within(row).getByText('12 articles')).toBeVisible();
    const swatch = within(row).getByRole('img', { name: 'Colour #2563eb' });
    expect(swatch).toHaveStyle({ backgroundColor: '#2563eb' });
    expect(within(await rowOf('Recipes')).getByText('1 article')).toBeVisible();
    expect(within(await rowOf('Misc')).getByText('0 articles')).toBeVisible();
    expect(within(await rowOf('Misc')).queryByText(/^But not/)).not.toBeInTheDocument();
  });

  it('counts articles in Slovak with the right plural form', async () => {
    await open({
      path: '/labels',
      language: 'sk',
      server: labelsServer(
        [
          makeLabel({ id: '41', name: 'Jeden', count: 1 }),
          makeLabel({ id: '42', name: 'Dva', count: 2 }),
          makeLabel({ id: '43', name: 'Dvanásť', count: 12 }),
        ],
        {},
        makeMe({ locale: 'sk' }),
      ),
    });

    expect(within(await rowOf('Jeden')).getByText('1 článok')).toBeVisible();
    expect(within(await rowOf('Dva')).getByText('2 články')).toBeVisible();
    expect(within(await rowOf('Dvanásť')).getByText('12 článkov')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Nový štítok' })).toBeVisible();
  });

  it('explains that labels organize and never mean like or dislike', async () => {
    await openLabels();

    expect(
      await screen.findByText(
        'Labels organize your articles. They never mean “like” or “dislike”: adding a label does not turn on classification or teach Bantoozi what you prefer.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Examples on a label only teach what the label means, and only for articles you have already chosen to analyze.',
      ),
    ).toBeVisible();
  });

  it('shows the examples of each side', async () => {
    await openLabels();

    const row = await rowOf('Read later');

    expect(
      within(within(row).getByRole('list', { name: 'More like this' })).getByText(
        'A long essay about ferries',
      ),
    ).toBeVisible();
    expect(
      within(within(row).getByRole('list', { name: 'Not like this' })).getByText('Weather alert'),
    ).toBeVisible();
    expect(within(await rowOf('Recipes')).queryByRole('list')).not.toBeInTheDocument();
  });

  it('invites to create the first label', async () => {
    await openLabels([]);

    expect(await screen.findByText('No labels yet')).toBeVisible();
    expect(screen.getByRole('button', { name: 'New label' })).toBeEnabled();
  });

  it('shows the error with a retry', async () => {
    let broken = true;
    const app = await openLabels([readLater], {
      'GET /labels': () => (broken ? failure(500, 'INTERNAL') : json(200, [readLater])),
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    broken = false;
    await app.user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await rowOf('Read later')).toBeVisible();
  });

  it('says it is offline when the server cannot be reached', async () => {
    await openLabels([readLater], {
      'GET /labels': () => {
        throw new TypeError('Failed to fetch');
      },
    });

    expect(await screen.findByText("You're offline")).toBeVisible();
  });
});

describe('creating a label', () => {
  const created = makeLabel({
    id: '51',
    name: 'Ferries',
    definition: 'Everything about ferries',
    notFor: 'Ferry tales',
    color: '#2563eb',
  });

  it('posts what was typed with the chosen colour, then closes and lists the label', async () => {
    const { app, form } = await openCreate({
      'POST /labels': () => json(201, labelResult(created)),
    });

    await app.user.type(form.getByLabelText(FIELDS.name), '  Ferries ');
    await app.user.type(form.getByLabelText(FIELDS.definition), 'Everything about ferries');
    await app.user.type(form.getByLabelText(FIELDS.notFor), 'Ferry tales');
    await app.user.clear(form.getByLabelText(FIELDS.color));
    await app.user.type(form.getByLabelText(FIELDS.color), '#2563EB');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('POST /labels')).toHaveLength(1));
    const request = app.calls('POST /labels')[0]!;
    expect(bodyOf(request)).toEqual({
      name: 'Ferries',
      definition: 'Everything about ferries',
      notFor: 'Ferry tales',
      color: '#2563eb',
    });
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    expect(request.headers.get('X-Bantoozi-Client')).toBe('web');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(await rowOf('Ferries')).getByText('0 articles')).toBeVisible();
  });

  it('starts with the default colour and leaves out an empty "but not"', async () => {
    const { app, form } = await openCreate({
      'POST /labels': () => json(201, labelResult(created)),
    });
    expect(form.getByLabelText(FIELDS.color)).toHaveValue('#64748b');

    await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');
    await app.user.type(form.getByLabelText(FIELDS.definition), 'Everything about ferries');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('POST /labels')).toHaveLength(1));
    expect(bodyOf(app.calls('POST /labels')[0]!)).toEqual({
      name: 'Ferries',
      definition: 'Everything about ferries',
      color: '#64748b',
    });
  });

  it('counts every field against its limit and stops typing at it', async () => {
    const { app, form } = await openCreate();
    const name = form.getByLabelText(FIELDS.name);
    const definition = form.getByLabelText(FIELDS.definition);
    const notFor = form.getByLabelText(FIELDS.notFor);
    expect(name).toHaveAccessibleDescription(`0 / ${CARD_LIMITS.titleMax}`);
    expect(definition).toHaveAccessibleDescription(`0 / ${CARD_LIMITS.interestMax}`);
    expect(notFor).toHaveAccessibleDescription(`0 / ${CARD_LIMITS.notForMax}`);

    await app.user.type(name, 'n'.repeat(CARD_LIMITS.titleMax + 10));
    await app.user.click(definition);
    await app.user.paste('d'.repeat(CARD_LIMITS.interestMax + 10));
    await app.user.click(notFor);
    await app.user.paste('o'.repeat(CARD_LIMITS.notForMax + 10));

    expect(name).toHaveValue('n'.repeat(CARD_LIMITS.titleMax));
    expect(definition).toHaveValue('d'.repeat(CARD_LIMITS.interestMax));
    expect(notFor).toHaveValue('o'.repeat(CARD_LIMITS.notForMax));
    expect(name).toHaveAccessibleDescription(`${CARD_LIMITS.titleMax} / ${CARD_LIMITS.titleMax}`);
  });

  it.each([
    ['name', FIELDS.name, CARD_LIMITS.titleMax],
    ['definition', FIELDS.definition, CARD_LIMITS.interestMax],
    ['"but not" text', FIELDS.notFor, CARD_LIMITS.notForMax],
  ])('refuses to save a %s past its limit and sends nothing', async (_field, label, max) => {
    const { app, form } = await openCreate();
    await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');
    await app.user.type(form.getByLabelText(FIELDS.definition), 'Everything about ferries');
    const field = form.getByLabelText(label);

    fireEvent.change(field, { target: { value: 'x'.repeat(max + 1) } });
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(app.calls('POST /labels')).toHaveLength(0);
    expect(field).toBeInvalid();
    expect(field).toHaveAccessibleDescription(
      `${max + 1} / ${max} Keep this to ${max} characters or fewer.`,
    );
    expect(field).toHaveFocus();
  });

  it('asks for a name, and for a definition of the minimum length, before saving', async () => {
    const { app, form } = await openCreate();

    await app.user.click(form.getByRole('button', { name: 'Save' }));
    expect(form.getByLabelText(FIELDS.name)).toBeInvalid();
    expect(form.getByLabelText(FIELDS.name)).toHaveAccessibleDescription(
      `0 / ${CARD_LIMITS.titleMax} Enter a name for the label.`,
    );
    expect(form.getByLabelText(FIELDS.definition)).toHaveAccessibleDescription(
      `0 / ${CARD_LIMITS.interestMax} Describe what belongs under this label.`,
    );

    await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');
    await app.user.type(form.getByLabelText(FIELDS.definition), 'ab');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(form.getByLabelText(FIELDS.definition)).toHaveAccessibleDescription(
      `2 / ${CARD_LIMITS.interestMax} Describe it in at least ${CARD_LIMITS.interestMin} characters.`,
    );
    expect(app.calls('POST /labels')).toHaveLength(0);
  });

  describe('the colour', () => {
    it.each(['red', '#12345', '#1234567', '2563eb', '#gggggg', '#25 63eb'])(
      'rejects %j before anything is sent',
      async (value) => {
        const { app, form } = await openCreate();
        await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');
        await app.user.type(form.getByLabelText(FIELDS.definition), 'Everything about ferries');
        const color = form.getByLabelText(FIELDS.color);
        await app.user.clear(color);
        await app.user.type(color, value);

        await app.user.click(form.getByRole('button', { name: 'Save' }));

        expect(color).toBeInvalid();
        expect(color).toHaveAccessibleDescription(
          expect.stringContaining('Use a colour like #64748b: a # and six hexadecimal digits.'),
        );
        expect(color).toHaveFocus();
        expect(app.calls('POST /labels')).toHaveLength(0);
      },
    );

    it('shows what the colour looks like next to the field', async () => {
      const { app, form } = await openCreate();
      const color = form.getByLabelText(FIELDS.color);

      await app.user.clear(color);
      await app.user.type(color, '#ff0000');

      expect(form.getByRole('img', { name: 'Colour #ff0000' })).toHaveStyle({
        backgroundColor: '#ff0000',
      });
    });

    it('puts a 400 about the colour on its field', async () => {
      const { app, form } = await openCreate({
        'POST /labels': () =>
          failure(400, 'VALIDATION_FAILED', { field: 'color', reason: 'color' }),
      });
      await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');
      await app.user.type(form.getByLabelText(FIELDS.definition), 'Everything about ferries');

      await app.user.click(form.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(form.getByLabelText(FIELDS.color)).toBeInvalid());
      expect(form.getByLabelText(FIELDS.name)).not.toBeInvalid();
    });
  });

  it.each([
    ['name', FIELDS.name, 'characters', "This text contains characters that can't be used."],
    [
      'definition',
      FIELDS.definition,
      'too_long',
      `Keep this to ${CARD_LIMITS.interestMax} characters or fewer.`,
    ],
    [
      'notFor',
      FIELDS.notFor,
      'too_long',
      `Keep this to ${CARD_LIMITS.notForMax} characters or fewer.`,
    ],
  ])('puts a 400 about %s on its own field', async (field, label, reason, message) => {
    const { app, form } = await openCreate({
      'POST /labels': () => failure(400, 'VALIDATION_FAILED', { field, reason }),
    });
    await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');
    await app.user.type(form.getByLabelText(FIELDS.definition), 'Everything about ferries');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    const target = form.getByLabelText(label);
    await waitFor(() => expect(target).toBeInvalid());
    expect(target).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(form.getByLabelText(FIELDS.name)).toHaveValue('Ferries');
  });

  it('explains a full plan with what is used and the maximum', async () => {
    const { app, form } = await openCreate({
      'POST /labels': () =>
        failure(409, 'QUOTA_EXCEEDED', { limit: 'maxLabels', used: 20, max: 20 }),
    });
    await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');
    await app.user.type(form.getByLabelText(FIELDS.definition), 'Everything about ferries');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      "You've reached your plan's limit for labels: 20 of 20.",
    );
    expect(form.getByLabelText(FIELDS.name)).toHaveValue('Ferries');
  });

  it.each([
    [
      'already_held',
      'You already have a label with this name and definition. Find it in your list to change it.',
    ],
    ['card_contention', 'This label changed while you were saving it. Try saving again.'],
  ])('explains the 409 %s', async (reason, message) => {
    const { app, form } = await openCreate({
      'POST /labels': () => failure(409, 'CONFLICT', { reason, labelId: '31' }),
    });
    await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');
    await app.user.type(form.getByLabelText(FIELDS.definition), 'Everything about ferries');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(message);
  });

  it('closes without a request on Cancel and on Escape', async () => {
    const { app, form } = await openCreate();
    await app.user.type(form.getByLabelText(FIELDS.name), 'Ferries');

    await app.user.click(form.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await app.user.click(screen.getByRole('button', { name: 'New label' }));
    expect(screen.getByLabelText(FIELDS.name)).toHaveValue('');
    await app.user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.calls('POST /labels')).toHaveLength(0);
  });
});

describe('editing a label', () => {
  const saved = (changes: Partial<LabelDto> = {}) =>
    json(200, labelResult({ ...readLater, ...changes }));

  it('opens with the label filled in', async () => {
    const { form } = await openEdit();

    expect(form.getByLabelText(FIELDS.name)).toHaveValue('Read later');
    expect(form.getByLabelText(FIELDS.definition)).toHaveValue('Long reads to come back to');
    expect(form.getByLabelText(FIELDS.notFor)).toHaveValue('Breaking news');
    expect(form.getByLabelText(FIELDS.color)).toHaveValue('#2563eb');
    expect(form.getByText('A long essay about ferries')).toBeVisible();
  });

  it('sends only what changed', async () => {
    const { app, form } = await openEdit(readLater, {
      'PATCH /labels/:id': () => saved({ name: 'Later' }),
    });
    const name = form.getByLabelText(FIELDS.name);

    await app.user.clear(name);
    await app.user.type(name, ' Later ');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('PATCH /labels/:id')).toHaveLength(1));
    const request = app.calls('PATCH /labels/:id')[0]!;
    expect(request.pathname).toBe('/api/v1/labels/31');
    expect(bodyOf(request)).toEqual({ name: 'Later' });
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await rowOf('Later')).toBeVisible();
  });

  it('changes the colour in place and clears the "but not" text with null', async () => {
    const { app, form } = await openEdit(readLater, {
      'PATCH /labels/:id': () => saved({ color: '#16a34a', notFor: null }),
    });
    const color = form.getByLabelText(FIELDS.color);

    await app.user.clear(color);
    await app.user.type(color, '#16A34A');
    await app.user.clear(form.getByLabelText(FIELDS.notFor));
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(app.calls('PATCH /labels/:id')).toHaveLength(1));
    expect(bodyOf(app.calls('PATCH /labels/:id')[0]!)).toEqual({ color: '#16a34a', notFor: null });
    expect(
      await within(await rowOf('Read later')).findByRole('img', { name: 'Colour #16a34a' }),
    ).toBeVisible();
  });

  it('makes no request, and closes, when nothing changed', async () => {
    const { app, form } = await openEdit();

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.calls('PATCH /labels/:id')).toHaveLength(0);
  });

  it('explains a 409 target_held: the new text already belongs to another label', async () => {
    const { app, form } = await openEdit(readLater, {
      'PATCH /labels/:id': () => failure(409, 'CONFLICT', { reason: 'target_held', labelId: '32' }),
    });
    await app.user.type(form.getByLabelText(FIELDS.definition), ' again');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent(
      'You already have a label with this name and definition. Edit that label instead.',
    );
  });

  it('swaps the label id in the list and refreshes the articles when the label gets a new id', async () => {
    const { app, form } = await openEdit(readLater, {
      'PATCH /labels/:id': () =>
        json(
          200,
          labelResult(
            { ...readLater, id: '71', definition: 'Long reads' },
            { from: '31', to: '71' },
          ),
        ),
      'DELETE /labels/:id': () => noContent(),
    });
    const articles = accountKey(USER_A_ID, 'articles', 'list');
    app.queryClient.setQueryData(articles, { pages: [], pageParams: [] });
    const definition = form.getByLabelText(FIELDS.definition);

    await app.user.clear(definition);
    await app.user.type(definition, 'Long reads');
    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(
        app.queryClient.getQueryData<LabelDto[]>(LABELS_KEY)?.map((label) => label.id),
      ).toEqual(['71']),
    );
    expect(app.queryClient.getQueryState(articles)?.isInvalidated).toBe(true);
    expect(await screen.findByText('Long reads')).toBeVisible();

    await app.user.click(within(await rowOf('Read later')).getByRole('button', { name: 'Delete' }));
    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this label?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(app.calls('DELETE /labels/:id')).toHaveLength(1));
    expect(app.calls('DELETE /labels/:id')[0]!.pathname).toBe('/api/v1/labels/71');
  });

  it('puts a 400 on its field when editing too', async () => {
    const { app, form } = await openEdit(readLater, {
      'PATCH /labels/:id': () =>
        failure(400, 'VALIDATION_FAILED', { field: 'name', reason: 'too_long' }),
    });
    await app.user.type(form.getByLabelText(FIELDS.name), ' again');

    await app.user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(form.getByLabelText(FIELDS.name)).toBeInvalid());
  });
});

describe('removing an example', () => {
  it('removes an example from either side by its text', async () => {
    const app = await openLabels([readLater], {
      'POST /labels/:id/examples/remove': (request) => {
        const { side } = bodyOf(request) as { side: 'yes' | 'no' };
        return json(
          200,
          labelResult({
            ...readLater,
            examplesYes: side === 'yes' ? [] : readLater.examplesYes,
            examplesNo: side === 'no' ? [] : readLater.examplesNo,
          }),
        );
      },
    });
    const row = await rowOf('Read later');

    await app.user.click(
      within(row).getByRole('button', { name: 'Remove example: A long essay about ferries' }),
    );
    await waitFor(() => expect(app.calls('POST /labels/:id/examples/remove')).toHaveLength(1));
    const request = app.calls('POST /labels/:id/examples/remove')[0]!;
    expect(request.pathname).toBe('/api/v1/labels/31/examples/remove');
    expect(bodyOf(request)).toEqual({ side: 'yes', text: 'A long essay about ferries' });
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() =>
      expect(within(row).queryByText('A long essay about ferries')).not.toBeInTheDocument(),
    );

    await app.user.click(
      within(row).getByRole('button', { name: 'Remove example: Weather alert' }),
    );
    await waitFor(() => expect(app.calls('POST /labels/:id/examples/remove')).toHaveLength(2));
    expect(bodyOf(app.calls('POST /labels/:id/examples/remove')[1]!)).toEqual({
      side: 'no',
      text: 'Weather alert',
    });
  });

  it('removes one example at a time, so the next removal is sent for the label the first one made', async () => {
    let answer!: () => void;
    const app = await openLabels([readLater], {
      'POST /labels/:id/examples/remove': async (request) => {
        const { side } = bodyOf(request) as { side: 'yes' | 'no' };
        if (side === 'no')
          return json(
            200,
            labelResult(
              { ...readLater, id: '73', examplesYes: [], examplesNo: [] },
              { from: '72', to: '73' },
            ),
          );
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return json(
          200,
          labelResult({ ...readLater, id: '72', examplesYes: [] }, { from: '31', to: '72' }),
        );
      },
    });
    const removeButton = async (text: string) =>
      within(await rowOf('Read later')).getByRole('button', { name: `Remove example: ${text}` });

    await app.user.click(await removeButton('A long essay about ferries'));
    await waitFor(() => expect(app.calls('POST /labels/:id/examples/remove')).toHaveLength(1));
    expect(await removeButton('Weather alert')).toBeDisabled();
    await app.user.click(await removeButton('Weather alert'));
    expect(app.calls('POST /labels/:id/examples/remove')).toHaveLength(1);

    answer();
    await waitFor(async () => expect(await removeButton('Weather alert')).toBeEnabled());
    await app.user.click(await removeButton('Weather alert'));

    await waitFor(() => expect(app.calls('POST /labels/:id/examples/remove')).toHaveLength(2));
    expect(app.calls('POST /labels/:id/examples/remove')[1]!.pathname).toBe(
      '/api/v1/labels/72/examples/remove',
    );
  });

  it('starts no edit or deletion while an example is being removed', async () => {
    let answer!: () => void;
    const app = await openLabels([readLater], {
      'POST /labels/:id/examples/remove': async () => {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return json(
          200,
          labelResult({ ...readLater, id: '72', examplesYes: [] }, { from: '31', to: '72' }),
        );
      },
    });
    const row = await rowOf('Read later');

    await app.user.click(
      within(row).getByRole('button', { name: 'Remove example: A long essay about ferries' }),
    );
    await waitFor(() => expect(app.calls('POST /labels/:id/examples/remove')).toHaveLength(1));

    expect(within(row).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Delete' })).toBeDisabled();

    answer();
    const moved = await rowOf('Read later');
    await waitFor(() => expect(within(moved).getByRole('button', { name: 'Edit' })).toBeEnabled());
  });

  it('swaps the id in the list when removing an example gives the label a new id', async () => {
    const app = await openLabels([readLater, recipes], {
      'POST /labels/:id/examples/remove': () =>
        json(
          200,
          labelResult({ ...readLater, id: '72', examplesYes: [] }, { from: '31', to: '72' }),
        ),
    });
    const articles = accountKey(USER_A_ID, 'articles', 'list');
    app.queryClient.setQueryData(articles, { pages: [], pageParams: [] });

    await app.user.click(
      within(await rowOf('Read later')).getByRole('button', {
        name: 'Remove example: A long essay about ferries',
      }),
    );

    await waitFor(() =>
      expect(
        app.queryClient.getQueryData<LabelDto[]>(LABELS_KEY)?.map((label) => label.id),
      ).toEqual(['72', '32']),
    );
    expect(app.queryClient.getQueryState(articles)?.isInvalidated).toBe(true);
  });

  it('keeps the example and says why when removing it fails', async () => {
    const app = await openLabels([readLater], {
      'POST /labels/:id/examples/remove': () => failure(404, 'NOT_FOUND', { resource: 'example' }),
    });
    const row = await rowOf('Read later');

    await app.user.click(
      within(row).getByRole('button', { name: 'Remove example: Weather alert' }),
    );

    expect(await screen.findByText("We couldn't find that.")).toBeVisible();
    expect(within(row).getByText('Weather alert')).toBeVisible();
  });
});

describe('deleting a label', () => {
  it('asks first, naming the articles that carry it, and sends nothing when cancelled', async () => {
    const app = await openLabels();

    await app.user.click(within(await rowOf('Read later')).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this label?' });
    expect(dialog).toHaveAccessibleDescription(
      '“Read later” will be removed from 12 articles. The articles stay in your reader.',
    );
    await app.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(app.calls('DELETE /labels/:id')).toHaveLength(0);
  });

  it('uses the singular for a label on one article', async () => {
    const app = await openLabels();

    await app.user.click(within(await rowOf('Recipes')).getByRole('button', { name: 'Delete' }));

    expect(screen.getByRole('dialog', { name: 'Delete this label?' })).toHaveAccessibleDescription(
      '“Recipes” will be removed from 1 article. The article stays in your reader.',
    );
  });

  it('deletes the label once confirmed, drops it from the list and refreshes the articles', async () => {
    const app = await openLabels(undefined, { 'DELETE /labels/:id': () => noContent() });
    const articles = accountKey(USER_A_ID, 'articles', 'list');
    app.queryClient.setQueryData(articles, { pages: [], pageParams: [] });

    await app.user.click(within(await rowOf('Read later')).getByRole('button', { name: 'Delete' }));
    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this label?' })).getByRole('button', {
        name: 'Delete',
      }),
    );

    await waitFor(() => expect(app.calls('DELETE /labels/:id')).toHaveLength(1));
    const request = app.calls('DELETE /labels/:id')[0]!;
    expect(request.pathname).toBe('/api/v1/labels/31');
    expect(request.headers.get('Idempotency-Key')).toMatch(UUID_V4);
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Read later' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('listitem', { name: 'Recipes' })).toBeVisible();
    expect(app.queryClient.getQueryState(articles)?.isInvalidated).toBe(true);
  });

  it('keeps the label, and says why inside the dialog, when deleting fails', async () => {
    const app = await openLabels([readLater], {
      'DELETE /labels/:id': () => failure(500, 'INTERNAL'),
    });

    await app.user.click(within(await rowOf('Read later')).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this label?' });
    await app.user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try again.',
    );
    expect(screen.getByRole('listitem', { name: 'Read later' })).toBeVisible();
  });
});

describe('the reader after a change on this page', () => {
  it('stops offering a label deleted here at once, without asking for the labels again', async () => {
    let held = [readLater, recipes];
    setDesktop(true);
    const app = await open({
      path: '/read/for_you',
      server: {
        me: makeMe(),
        routes: {
          ...READER_READS,
          'GET /labels': () => json(200, held),
          'DELETE /labels/:id': () => {
            held = held.filter((label) => label.id !== readLater.id);
            return noContent();
          },
        },
      },
    });
    const readerLabels = () => within(screen.getByRole('list', { name: 'Labels' }));
    expect(await screen.findByRole('link', { name: 'Read later' })).toBeVisible();

    await act(async () => {
      await app.router.navigate({ to: '/labels' });
    });
    await app.user.click(within(await rowOf('Read later')).getByRole('button', { name: 'Delete' }));
    await app.user.click(
      within(screen.getByRole('dialog', { name: 'Delete this label?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Read later' })).not.toBeInTheDocument(),
    );
    const asked = app.calls('GET /labels').length;

    await act(async () => {
      await app.router.navigate({ to: '/read/$lane', params: { lane: 'for_you' } });
    });

    expect(await screen.findByRole('link', { name: 'Recipes' })).toBeVisible();
    expect(readerLabels().queryByRole('link', { name: 'Read later' })).toBeNull();
    expect(app.calls('GET /labels')).toHaveLength(asked);
  });
});
