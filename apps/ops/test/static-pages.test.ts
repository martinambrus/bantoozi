import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = resolve(import.meta.dirname, '../../web/public');

const read = (file: string) => readFileSync(resolve(PUBLIC_DIR, file), 'utf8');

const TOPICS: Record<string, Record<'en' | 'sk', RegExp[]>> = {
  privacy: {
    en: [
      /TypeSafe/i,
      /Jev/,
      /Ollama/,
      /LibreTranslate/,
      /7[- ]day/i,
      /export/i,
      /backup/i,
      /invite/i,
      /waitlist/i,
      /images/i,
      /cookie/i,
    ],
    sk: [
      /TypeSafe/i,
      /Jev/,
      /Ollama/,
      /LibreTranslate/,
      /7 dní|7-dňov/i,
      /export/i,
      /záloh/i,
      /pozván/i,
      /poradovník/i,
      /obrázk/i,
      /cookie/i,
    ],
  },
  bot: {
    en: [/BantooziBot/, /robots\.txt/],
    sk: [/BantooziBot/, /robots\.txt/],
  },
};

const PAGES = (['privacy', 'bot'] as const).flatMap((name) =>
  (['en', 'sk'] as const).map((lang) => ({
    name,
    lang,
    file: lang === 'en' ? `${name}/index.html` : `${name}/sk/index.html`,
  })),
);

describe('static pages (spec 11 §3, §7, §9)', () => {
  for (const { name, lang, file } of PAGES) {
    describe(`/${name} in ${lang}`, () => {
      it('exists and declares its language', () => {
        const html = read(file);
        expect(html).toMatch(/^<!doctype html>/i);
        expect(html).toContain(`<html lang="${lang}"`);
      });

      it('covers the required topics', () => {
        const text = read(file);
        for (const topic of TOPICS[name]![lang]) expect(text, String(topic)).toMatch(topic);
      });

      it('has no script, inline style or third-party resource', () => {
        const html = read(file);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<style/i);
        expect(html).not.toMatch(/\sstyle=/i);
        expect(html).not.toMatch(/\son[a-z]+=/i);
        // Only <a href> may name an absolute address.
        const tags = html.match(/<[a-z][^>]*>/gi) ?? [];
        for (const tag of tags) {
          if (/^<a[\s>]/i.test(tag)) continue;
          expect(tag, tag).not.toMatch(/(src|href|action|srcset|data)=["']?(https?:)?\/\//i);
        }
        expect(html).not.toMatch(/url\(\s*["']?https?:/i);
      });

      it('links to the other language and to the stylesheet', () => {
        const html = read(file);
        const other = lang === 'en' ? `/${name}/sk/` : `/${name}/`;
        expect(html).toContain(`href="${other}"`);
        expect(html).toContain('href="/static-pages.css"');
      });
    });
  }

  it('the privacy pages mark the support contact placeholder in one place', () => {
    for (const file of ['privacy/index.html', 'privacy/sk/index.html']) {
      expect(read(file).match(/id="support-contact"/g)).toHaveLength(1);
    }
  });

  it('the stylesheet exists', () => {
    expect(read('static-pages.css').length).toBeGreaterThan(100);
  });
});
