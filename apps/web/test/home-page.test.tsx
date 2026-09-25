import { renderToString } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { HomePage } from '../src/features/home/home-page.js';
import { createI18n, type Language } from '../src/i18n/index.js';

function render(language: Language): string {
  return renderToString(
    <I18nextProvider i18n={createI18n(language)}>
      <HomePage />
    </I18nextProvider>,
  );
}

describe('the localized Bantoozi shell page', () => {
  it('renders in English', () => {
    const html = render('en');
    expect(html).toContain('Bantoozi');
    expect(html).toContain('Your feeds, ranked by what you actually care about.');
  });

  it('renders in Slovak', () => {
    const html = render('sk');
    expect(html).toContain('Bantoozi');
    expect(html).toContain('Tvoje zdroje zoradené podľa toho, čo ťa naozaj zaujíma.');
  });
});
