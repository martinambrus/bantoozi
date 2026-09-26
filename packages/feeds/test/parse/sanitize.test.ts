import { describe, expect, it } from 'vitest';

import {
  SANITIZED_LINK_REL,
  htmlToText,
  isTrackingPixel,
  sanitizeHtml,
  sourceCoveredByText,
  truncateHtml,
} from '../../src/parse/index.js';
import { sanitizeContent, textToHtml } from '../../src/parse/sanitize.js';

const BASE = 'https://news.example.com/articles/2026/story.html';
const LINK_ATTRS = `rel="${SANITIZED_LINK_REL}" target="_blank"`;

describe('sanitizeHtml (spec 03 §6.3)', () => {
  it('keeps the allow-listed tags and nothing else', () => {
    const html =
      '<h2>Heading</h2><p><b>b</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u> <code>c</code></p>' +
      '<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>q</blockquote><pre>p</pre>' +
      '<h3>h3</h3><h4>h4</h4><span class="x">span</span> <font color="red">font</font>';
    expect(sanitizeHtml(html, BASE)).toBe(
      '<h2>Heading</h2><p><b>b</b> <strong>s</strong> <i>i</i> <em>e</em> <u>u</u> <code>c</code></p>' +
        '<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>q</blockquote><pre>p</pre>' +
        '<h3>h3</h3><h4>h4</h4>span font',
    );
  });

  it('strips scripts, styles, frames, objects, forms and SVG with their content', () => {
    const html =
      '<p>before</p><script>alert(1)</script><style>p{color:red}</style>' +
      '<iframe src="https://evil.example/"><p>frame</p></iframe><object data="x.swf">obj</object>' +
      '<embed src="x.swf"><form action="/x"><input name="a"><button>Go</button></form>' +
      '<svg><title>svg title</title><script>alert(2)</script></svg><noscript>enable js</noscript>' +
      '<template><p>tpl</p></template><p>after</p>';
    expect(sanitizeHtml(html, BASE)).toBe('<p>before</p><p>after</p>');
  });

  it('strips event handlers, inline styles, classes and ids', () => {
    expect(
      sanitizeHtml(
        '<p style="color:red" class="lead" id="x" onclick="steal()" onload="x()">Hi</p>',
        BASE,
      ),
    ).toBe('<p>Hi</p>');
  });

  it('rewrites links to absolute http(s) URLs with rel and target', () => {
    expect(
      sanitizeHtml(
        '<p><a href="../other.html#top" target="_self" rel="opener" title="t">rel</a> ' +
          '<a href="//cdn.example.com/x">proto</a> <a href="HTTPS://Example.com/A">abs</a></p>',
        BASE,
      ),
    ).toBe(
      `<p><a href="https://news.example.com/articles/other.html#top" ${LINK_ATTRS}>rel</a> ` +
        `<a href="https://cdn.example.com/x" ${LINK_ATTRS}>proto</a> ` +
        `<a href="https://example.com/A" ${LINK_ATTRS}>abs</a></p>`,
    );
  });

  it('drops javascript:, data:, mailto: and missing hrefs but keeps the link text', () => {
    const html =
      '<p><a href="javascript:alert(1)">js</a> <a href=" JaVaScRiPt:alert(2)">js2</a> ' +
      '<a href="data:text/html,x">data</a> <a href="mailto:a@example.com">mail</a> ' +
      '<a name="anchor">named</a> <a href="vbscript:x">vb</a></p><p>next</p>';
    expect(sanitizeHtml(html, BASE)).toBe('<p>js js2 data mail named vb</p><p>next</p>');
  });

  it('removes every embedded image for the beta, and elements that only wrapped one', () => {
    const html =
      '<p>Text <img src="/a.jpg" alt="A"></p><figure><img src="/b.jpg"><figcaption>Caption</figcaption></figure>' +
      '<p><a href="/c"><img src="/c.jpg"></a></p><figure><img src="/d.jpg"></figure>';
    expect(sanitizeHtml(html, BASE)).toBe(
      '<p>Text </p><figure><figcaption>Caption</figcaption></figure>',
    );
  });

  it('keeps safe images when asked, removing pixels and resolving src', () => {
    const html =
      '<p><img src="/a.jpg" alt="A" srcset="/a-2x.jpg 2x" width="600" style="border:0" onerror="x()">' +
      '<img src="https://t.example/p.gif" width="1" height="1">' +
      '<img src="https://t.example/q.gif" style="width:0px;height:0px">' +
      '<img src="https://t.example/r.gif" height="2">' +
      '<img src="javascript:alert(1)"><img src="data:image/png;base64,AAAA"><img alt="no src"></p>';
    expect(sanitizeHtml(html, BASE, { keepImages: true })).toBe(
      '<p><img src="https://news.example.com/a.jpg" alt="A" /></p>',
    );
  });

  it('maps headings and turns other blocks into line breaks', () => {
    expect(
      sanitizeHtml(
        '<h1>Top</h1><h5>Low</h5><h6>Lower</h6><div>A</div><div>B</div><div></div>',
        BASE,
      ),
    ).toBe('<h2>Top</h2><h4>Low</h4><h4>Lower</h4><br />A<br />B');
    expect(sanitizeHtml('<table><tr><td>x</td><td>y</td></tr></table>', BASE)).toBe('x<br />y');
  });

  it('escapes text and keeps entities decoded once', () => {
    expect(sanitizeHtml('<p>5 &lt; 7 &amp; AT&T &eacute; &nbsp;x</p>', BASE)).toBe(
      '<p>5 &lt; 7 &amp; AT&amp;T é \u00a0x</p>',
    );
  });

  it('never lets markup through a textarea, xmp or plaintext element', () => {
    expect(
      sanitizeHtml(
        '<p>a</p><textarea><img src=x onerror=alert(1)></textarea><xmp><b>x</b></xmp>',
        BASE,
      ),
    ).toBe('<p>a</p>');
    expect(sanitizeHtml('<p>a</p><plaintext><script>alert(1)</script>', BASE)).toBe('<p>a</p>');
  });

  it('removes control characters and returns an empty string for empty input', () => {
    expect(sanitizeHtml('<p>a\u0000b\u0007c</p>', BASE)).toBe('<p>abc</p>');
    expect(sanitizeHtml('', BASE)).toBe('');
    expect(sanitizeHtml('<p> </p><div><br></div>', BASE)).toBe('');
  });

  it('limits nesting depth', () => {
    const deep = '<b>'.repeat(100) + 'deep' + '</b>'.repeat(100);
    const output = sanitizeHtml(deep, BASE);
    expect(output.match(/<b>/g)).toHaveLength(64);
    expect(output).toContain('deep');
  });
});

describe('sanitizeContent image selection', () => {
  it('reports the first non-pixel http(s) <img src>, resolved', () => {
    const html =
      '<img src="https://t.example/pixel.gif" width="1"><img src="data:image/gif;base64,R0lG">' +
      '<img src="/hidden.png" style="display: none"><img src="/lazy.png" style="visibility:hidden">' +
      '<noscript><img src="../real.jpg"></noscript><img src="/later.jpg">';
    expect(sanitizeContent(html, BASE)).toEqual({
      html: '',
      firstImageUrl: 'https://news.example.com/articles/real.jpg',
    });
  });

  it('reports null when there is no usable image', () => {
    expect(sanitizeContent('<p>no images</p>', BASE).firstImageUrl).toBeNull();
    expect(sanitizeContent('<img alt="no src">', BASE).firstImageUrl).toBeNull();
  });
});

describe('isTrackingPixel', () => {
  it.each([
    [{ width: '1', height: '1' }, true],
    [{ width: '2' }, true],
    [{ height: '0px' }, true],
    [{ width: '1.5' }, true],
    [{ style: 'width:1px; height:1px' }, true],
    [{ style: 'max-height: 2px !important' }, true],
    [{ style: 'display:none' }, true],
    [{ style: 'visibility: hidden' }, true],
    [{ width: '3', height: '3' }, false],
    [{ width: '100%' }, false],
    [{ width: 'auto', style: 'border: 0; width: 640px' }, false],
    [{ style: 'color' }, false],
    [{}, false],
  ])('%j → %s', (attribs, expected) => {
    expect(isTrackingPixel(attribs)).toBe(expected);
  });
});

describe('htmlToText', () => {
  it('decodes entities, drops markup and non-text elements, keeps block boundaries', () => {
    expect(
      htmlToText(
        '<h1>Title</h1><p>First &amp; <b>bold</b>&nbsp;text.<br>Next line</p>' +
          '<script>x()</script><style>p{}</style><ul><li>one</li><li>two</li></ul>' +
          '<table><tr><td>a</td><td>b</td></tr></table><p>5 &lt; 7 &quot;q&quot; &#233;&#x1F600;</p>',
      ),
    ).toBe('Title\n\nFirst & bold text.\nNext line\n\none\ntwo\n\na b\n\n5 < 7 "q" é😀');
  });

  it('collapses whitespace and removes control characters', () => {
    // Source line breaks are whitespace in HTML; only markup creates lines.
    expect(htmlToText('  a \t\u0000 b \r\n\r\n\r\n c  ')).toBe('a b c');
    expect(htmlToText('<p>wrapped\nsource line</p>\n\n\n<p>b</p>')).toBe(
      'wrapped source line\n\nb',
    );
    expect(htmlToText('')).toBe('');
  });

  it('keeps the whitespace of preformatted text', () => {
    expect(htmlToText('<p>Code:</p><pre>\nif (a) {\n  b();\n}</pre><p>Done</p>')).toBe(
      'Code:\n\nif (a) {\n  b();\n}\n\nDone',
    );
  });
});

describe('textToHtml', () => {
  it('escapes text into paragraphs with line breaks', () => {
    expect(textToHtml('One & <two>\nline two\n\n\n  Para 2  \r\n\r\nPara 3')).toBe(
      '<p>One &amp; &lt;two&gt;<br>line two</p><p>Para 2</p><p>Para 3</p>',
    );
    expect(textToHtml(' \n ')).toBe('');
  });
});

describe('truncateHtml', () => {
  it('returns short HTML unchanged', () => {
    expect(truncateHtml('<p>short</p>', 100)).toEqual({ html: '<p>short</p>', truncated: false });
  });

  it('never cuts through a tag and closes open elements within the limit', () => {
    const html = '<p>First paragraph.</p><p>Second <b>bold words here</b> and more text.</p>';
    for (let max = 20; max < html.length; max += 1) {
      const { html: cut, truncated } = truncateHtml(html, max);
      expect(truncated).toBe(true);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(cut.match(/<p>/g)?.length ?? 0).toBe(cut.match(/<\/p>/g)?.length ?? 0);
      expect(cut.match(/<b>/g)?.length ?? 0).toBe(cut.match(/<\/b>/g)?.length ?? 0);
      expect(cut).not.toMatch(/<[^>]*$/);
    }
    expect(truncateHtml(html, 50).html).toBe('<p>First paragraph.</p><p>Second <b>bold</b></p>');
    expect(truncateHtml(html, 40).html).toBe('<p>First paragraph.</p><p>Second</p>');
  });

  it('prefers a word boundary and never splits an entity or a surrogate pair', () => {
    expect(truncateHtml('<p>alpha beta gamma</p>', 17).html).toBe('<p>alpha beta</p>');
    expect(truncateHtml('<p>a&amp;b</p>', 9).html).toBe('<p>a</p>');
    expect(truncateHtml('<p>😀😀😀😀</p>', 10).html).toBe('<p>😀😀😀</p>');
  });

  it('measures UTF-8 bytes when asked', () => {
    const { html } = truncateHtml('<p>ééééé</p>', 13, 'utf8');
    expect(html).toBe('<p>ééé</p>');
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(13);
  });

  it('keeps void elements and drops empty trailing elements', () => {
    expect(truncateHtml('<p>a<br />b</p><p>ccccccccccccc</p>', 20).html).toBe('<p>a<br />b</p>');
    expect(truncateHtml('<p>a</p><ul><li>bbbbbbbbbbbbbbbbbbbbbbbbbbb</li></ul>', 18).html).toBe(
      '<p>a</p>',
    );
  });

  it('ignores stray closing tags', () => {
    expect(truncateHtml('</i><p>abc def ghi</p>', 14).html).toBe('<p>abc def</p>');
  });
});

describe('sourceCoveredByText (spec 03 §6.4)', () => {
  const source =
    `<p>${'a'.repeat(100)}</p><img src="/one.jpg">` +
    `<p>${'b'.repeat(100)}</p><img src="/two.jpg"><p>${'c'.repeat(100)}</p>`;
  const text = htmlToText(source);

  it('is the whole source while the stored text is the whole text', () => {
    expect(sourceCoveredByText(source, text, text, htmlToText)).toBe(source);
  });

  it('keeps only the images before the cut when the stored text was cut', () => {
    // The stored text ends in the middle of the second paragraph: the image after it is left out.
    const stored = text.slice(0, text.indexOf('b') + 60);
    const covered = sourceCoveredByText(source, text, stored, htmlToText);
    expect(covered).toContain('/one.jpg');
    expect(covered).not.toContain('/two.jpg');
    expect(text.startsWith(htmlToText(covered))).toBe(true);
  });

  it('finds the cut by the converted text, however much markup precedes an image', () => {
    // The first image's attributes alone are longer than the stored text.
    const alt = 'A long description of the photo. '.repeat(20);
    const marked = source.replace('<img src="/one.jpg">', `<img alt="${alt}" src="/one.jpg">`);
    const stored = text.slice(0, text.indexOf('b') + 60);
    const covered = sourceCoveredByText(marked, text, stored, htmlToText);
    expect(covered).toContain('/one.jpg');
    expect(covered).not.toContain('/two.jpg');
    // Every image stays when the cut falls after the last one.
    const late = text.slice(0, text.indexOf('c') + 10);
    expect(sourceCoveredByText(marked, text, late, htmlToText)).toBe(marked);
  });
});

describe('sanitizeHtml whitespace', () => {
  it('collapses gaps left by removed markup, except inside <pre>', () => {
    expect(
      sanitizeHtml(
        '<p>a</p>\n\n<script>x()</script>\n  \n<p>b\n\n  c</p><pre>keep\n\n  this</pre>',
        BASE,
      ),
    ).toBe('<p>a</p>\n<p>b\nc</p><pre>keep\n\n  this</pre>');
  });
});
