import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Time, useMoment } from '../../src/components/time.js';
import { renderReader } from '../article/harness.js';
import { makeMe } from '../session/fixtures.js';
import { FAR_ZONE, printed } from '../support/zones.js';

const AT = '2026-10-08T09:00:00.000Z';

function Moment({ iso }: { iso: string }) {
  const moment = useMoment();
  return <p>{moment(iso)}</p>;
}

describe('Time', () => {
  it('prints the moment in the time zone of the account and keeps the exact value on the element', () => {
    renderReader(<Time value={AT} />, { me: makeMe({ timezone: FAR_ZONE }) });

    const time = screen.getByText(printed(AT, FAR_ZONE));
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('datetime', AT);
  });

  it('prints it in the language of the reader', () => {
    renderReader(<Time value={AT} />, {
      me: makeMe({ timezone: 'Europe/Prague' }),
      language: 'sk',
    });

    expect(screen.getByText(printed(AT, 'Europe/Prague', 'sk'))).toHaveAttribute('datetime', AT);
  });

  it('prints it in the zone of the device when the browser does not know the zone of the account', () => {
    renderReader(<Time value={AT} />, { me: makeMe({ timezone: 'Mars/Olympus_Mons' }) });

    expect(screen.getByText(printed(AT))).toHaveAttribute('datetime', AT);
  });

  it('prints nothing for a moment that does not parse', () => {
    const { container } = renderReader(<Time value="soon" />, { me: makeMe() });

    expect(container.querySelector('time')).toBeEmptyDOMElement();
  });
});

describe('useMoment', () => {
  it('prints each moment in the time zone of the account', () => {
    const { container } = renderReader(<Moment iso={AT} />, {
      me: makeMe({ timezone: FAR_ZONE }),
    });

    expect(container.querySelector('p')?.textContent).toBe(printed(AT, FAR_ZONE));
  });
});
