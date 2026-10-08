import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SafeHtml } from '../../src/components/safe-html.js';

function renderHtml(html: string, imagesAllowed = false) {
  return render(<SafeHtml html={html} imagesAllowed={imagesAllowed} />);
}

function attributeNames(root: Element): string[] {
  return [root, ...root.querySelectorAll('*')].flatMap((element) => element.getAttributeNames());
}

describe('SafeHtml markup', () => {
  it('keeps the display allow-list of the server', () => {
    const { container } = renderHtml(
      '<h2>Heading</h2><h3>Sub</h3><h4>Subsub</h4>' +
        '<p>Some <b>bold</b>, <strong>strong</strong>, <i>italic</i>, <em>em</em> and <u>underlined</u> text<br>after a break.</p>' +
        '<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>quoted</blockquote>' +
        '<pre><code>code()</code></pre><figure><figcaption>caption</figcaption></figure>',
    );
    for (const tag of [
      'h2',
      'h3',
      'h4',
      'p',
      'b',
      'strong',
      'i',
      'em',
      'u',
      'br',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'figure',
      'figcaption',
    ]) {
      expect(container.querySelector(tag), tag).not.toBeNull();
    }
    expect(container).toHaveTextContent('Some bold, strong, italic, em and underlined text');
  });

  it('keeps text that merely looks like markup as text', () => {
    const { container } = renderHtml('<p>1 &lt; 2 &amp;&amp; &lt;b&gt;x&lt;/b&gt;</p>');
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('1 < 2 && <b>x</b>');
  });

  it('renders nothing for an empty fragment', () => {
    const { container } = renderHtml('');
    expect(container.textContent).toBe('');
    expect(container.querySelector('img, a, p')).toBeNull();
  });

  it('puts the class name on its wrapper', () => {
    const { container } = render(
      <SafeHtml html="<p>x</p>" imagesAllowed={false} className="body" />,
    );
    expect(container.firstElementChild).toHaveClass('body');
  });
});

describe('SafeHtml active content', () => {
  it('removes scripts together with their text', () => {
    const { container } = renderHtml('<p>Hello</p><script>window.hacked = 1</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container).toHaveTextContent('Hello');
    expect(container).not.toHaveTextContent('hacked');
  });

  it('removes every inline event handler', () => {
    const { container } = renderHtml(
      '<p onclick="x()" onmouseover="x()" onfocus="x()">a</p>' +
        '<b onmouseenter="x()" onanimationstart="x()">b</b>' +
        '<a href="https://example.test/" onclick="x()" onauxclick="x()">c</a>' +
        '<img src="https://cdn.test/a.png" alt="d" onerror="x()" onload="x()">',
      true,
    );
    expect(attributeNames(container).filter((name) => name.startsWith('on'))).toEqual([]);
    expect(container).toHaveTextContent('abc');
  });

  it('removes style elements, style attributes, classes, ids and titles', () => {
    const { container } = renderHtml(
      '<style>p { display: none }</style>' +
        '<p style="position: fixed; inset: 0" class="overlay" id="login" title="tip">text</p>',
    );
    expect(container.querySelector('style')).toBeNull();
    expect(container).not.toHaveTextContent('display');
    expect(container.querySelector('p')?.getAttributeNames()).toEqual([]);
  });

  it('removes frames, objects and embeds', () => {
    const { container } = renderHtml(
      '<iframe src="https://evil.test/frame"></iframe><object data="https://evil.test/o"></object>' +
        '<embed src="https://evil.test/e"><frame src="https://evil.test/f"><p>kept</p>',
    );
    expect(container.querySelector('iframe, object, embed, frame, frameset')).toBeNull();
    expect(container).toHaveTextContent('kept');
    expect(container.innerHTML).not.toContain('evil.test');
  });

  it('removes forms and their controls together with their text', () => {
    const { container } = renderHtml(
      '<form action="https://evil.test/steal"><input name="pw" value="secret">' +
        '<button>Go now</button><textarea>typed words</textarea>' +
        '<select><option>pick me</option></select></form><p>kept</p>',
    );
    expect(container.querySelector('form, input, button, textarea, select, option')).toBeNull();
    expect(container.textContent).toBe('kept');
    expect(container.innerHTML).not.toContain('evil.test');
  });

  it('removes svg and math content', () => {
    const { container } = renderHtml(
      '<svg><script>alert(1)</script><a href="https://evil.test/s"><text>vector</text></a></svg>' +
        '<math><mi>formula</mi></math><p>kept</p>',
    );
    expect(container.querySelector('svg, math, script')).toBeNull();
    expect(container.textContent).toBe('kept');
  });

  it.each([
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<img src="https://cdn.test/a.png" alt="x"><svg><desc><![CDATA[</desc><script>alert(1)</script>]]></svg>',
  ])('survives the mutation vector %#', (vector) => {
    for (const imagesAllowed of [false, true]) {
      const { container, unmount } = renderHtml(vector, imagesAllowed);
      expect(attributeNames(container).filter((name) => name.startsWith('on'))).toEqual([]);
      expect(
        container.querySelector('script, style, svg, math, form, iframe, noscript'),
      ).toBeNull();
      unmount();
    }
  });
});

describe('SafeHtml links', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\nscript:alert(1)',
    '&#106;avascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'mailto:reader@example.test',
    'ftp://example.test/file',
    '//evil.test/path',
    '/relative/path',
    '#fragment',
  ])('drops the href %j but keeps the text', (href) => {
    const { container } = renderHtml(`<a href="${href}">link text</a>`);
    expect(container.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(container).toHaveTextContent('link text');
  });

  it('keeps http and https links and always opens them safely', () => {
    const { container } = renderHtml(
      '<a href="https://example.test/a?x=1&amp;y=2" rel="nofollow" target="_self">one</a> ' +
        '<a href="http://example.test/b" target="_top" rel="opener">two</a>',
    );
    const links = [...container.querySelectorAll('a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.test/a?x=1&y=2',
      'http://example.test/b',
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });
});

describe('SafeHtml images while they are blocked', () => {
  const MARKUP =
    '<p>Before</p><img src="https://cdn.test/a.png" alt="A cat" srcset="https://cdn.test/a2.png 2x" onerror="x()">' +
    '<picture><source srcset="https://cdn.test/p.webp"><img src="https://cdn.test/p.png" alt="A pic"></picture>' +
    '<img src="https://cdn.test/noalt.png"><img srcset="https://cdn.test/only.png 2x" alt="Only srcset">';

  it('gives no element a src or srcset, so nothing is fetched', () => {
    const { container } = renderHtml(MARKUP, false);
    expect(container.querySelector('img, picture, source')).toBeNull();
    expect(container.querySelectorAll('[src], [srcset]')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('cdn.test');
  });

  it('leaves an inert placeholder that shows the alt text', () => {
    const { container } = renderHtml(MARKUP, false);
    const placeholders = [...container.querySelectorAll('[data-blocked-image]')];
    expect(placeholders.map((placeholder) => placeholder.textContent)).toEqual([
      'A cat',
      'A pic',
      '',
      'Only srcset',
    ]);
    for (const placeholder of placeholders) {
      expect(placeholder.getAttributeNames()).toEqual(['data-blocked-image']);
    }
  });
});

describe('SafeHtml images while they are allowed', () => {
  it('keeps an http(s) image with the privacy attributes and nothing else', () => {
    const { container } = renderHtml(
      '<img src="https://cdn.test/a.png" alt="A cat" srcset="https://cdn.test/a2.png 2x" width="1" height="1" ' +
        'style="position: fixed" class="x" onerror="x()"><img src="http://cdn.test/b.png" alt="Plain http">',
      true,
    );
    const [first, second] = [...container.querySelectorAll('img')];
    expect(first?.getAttributeNames().sort()).toEqual(['alt', 'loading', 'referrerpolicy', 'src']);
    expect(first).toHaveAttribute('src', 'https://cdn.test/a.png');
    expect(first).toHaveAttribute('alt', 'A cat');
    expect(first).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(first).toHaveAttribute('loading', 'lazy');
    expect(second).toHaveAttribute('src', 'http://cdn.test/b.png');
    expect(second).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(second).toHaveAttribute('loading', 'lazy');
    expect(container.querySelectorAll('[srcset]')).toHaveLength(0);
  });

  it('gives an image without alt text an empty one', () => {
    const { container } = renderHtml('<img src="https://cdn.test/a.png">', true);
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });

  it.each([
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'blob:https://example.test/1',
    'ftp://cdn.test/a.png',
    '//cdn.test/a.png',
    '/relative.png',
  ])('replaces an image whose src is %s by a placeholder', (src) => {
    const { container } = renderHtml(`<img src="${src}" alt="Not loadable">`, true);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('[src]')).toHaveLength(0);
    expect(container.querySelector('[data-blocked-image]')).toHaveTextContent('Not loadable');
  });

  it('replaces an image without src by a placeholder', () => {
    const { container } = renderHtml('<img alt="No source">', true);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-blocked-image]')).toHaveTextContent('No source');
  });

  it('follows a change of the policy', () => {
    const markup = '<img src="https://cdn.test/a.png" alt="A cat">';
    const { container, rerender } = renderHtml(markup, false);
    expect(container.querySelector('img')).toBeNull();
    rerender(<SafeHtml html={markup} imagesAllowed />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://cdn.test/a.png');
    rerender(<SafeHtml html={markup} imagesAllowed={false} />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('the HTML sink', () => {
  const sources = import.meta.glob('../../src/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('is used by src/components/safe-html.tsx and nothing else', () => {
    const users = Object.entries(sources)
      .filter(([, text]) =>
        /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(
          String(text),
        ),
      )
      .map(([path]) => path);
    expect(users).toEqual(['../../src/components/safe-html.tsx']);
  });
});
