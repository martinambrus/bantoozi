import { waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bodiesOf, openSettings, section } from './support.js';

const NAME = 'Like articles you disliked';
const HINT =
  'Ranks articles lower that look like several articles you disliked for the same interest.';

const filters = () =>
  within(within(section('Reading preferences')).getByRole('group', { name: 'Quality filters' }));

describe('the "Like articles you disliked" filter', () => {
  it('S1 has a row with its hint and the Auto / On / Off control', async () => {
    await openSettings();

    const control = filters().getByRole('radiogroup', { name: NAME });
    expect(control).toHaveAccessibleDescription(expect.stringContaining(HINT));
    expect(
      within(control)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['Auto', 'On', 'Off']);
    expect(within(control).getByRole('radio', { name: 'Auto' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('S2 choosing Off saves demote.similar', async () => {
    const { user, calls } = await openSettings();

    await user.click(
      within(filters().getByRole('radiogroup', { name: NAME })).getByRole('radio', { name: 'Off' }),
    );

    await waitFor(() => expect(calls('PATCH /me')).toHaveLength(1));
    expect(bodiesOf(calls('PATCH /me'))).toEqual([{ preferences: { demote: { similar: 'off' } } }]);
  });
});
