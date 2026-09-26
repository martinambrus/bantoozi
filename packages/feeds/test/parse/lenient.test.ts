import { describe, expect, it } from 'vitest';

import { lenientXmlCleanup } from '../../src/parse/index.js';
import { LENIENT_JUNK_WINDOW, stripLeadingJunk } from '../../src/parse/lenient.js';

describe('lenientXmlCleanup (spec 03 §6)', () => {
  it('escapes bare ampersands in text and attribute values', () => {
    expect(lenientXmlCleanup('<rss><t a="?x=1&y=2">Tom & Jerry&co</t></rss>')).toBe(
      '<rss><t a="?x=1&amp;y=2">Tom &amp; Jerry&amp;co</t></rss>',
    );
  });

  it('keeps existing valid entity and character references', () => {
    const text =
      '<rss><t>&amp; &lt; &gt; &quot; &apos; &nbsp; &eacute; &AMP; &#233; &#xE9; &#x1F600; &mdash;</t></rss>';
    expect(lenientXmlCleanup(text)).toBe(text);
  });

  it('escapes references the parser cannot resolve', () => {
    expect(
      lenientXmlCleanup('<rss><t>&bogus; &#0; &#x110000; &#99999999; &#xZZ; &#; &</t></rss>'),
    ).toBe(
      '<rss><t>&amp;bogus; &amp;#0; &amp;#x110000; &amp;#99999999; &amp;#xZZ; &amp;#; &amp;</t></rss>',
    );
  });

  it('leaves CDATA sections, comments and processing instructions untouched', () => {
    const text =
      '<?xml version="1.0"?><?pi a&b?><rss><!-- a & b --><t><![CDATA[AT&T & co]]></t><u>&</u></rss>';
    expect(lenientXmlCleanup(text)).toBe(
      '<?xml version="1.0"?><?pi a&b?><rss><!-- a & b --><t><![CDATA[AT&T & co]]></t><u>&amp;</u></rss>',
    );
  });

  it('handles unterminated CDATA sections and comments without touching them', () => {
    expect(lenientXmlCleanup('<rss><t><![CDATA[a & b</t></rss>')).toBe(
      '<rss><t><![CDATA[a & b</t></rss>',
    );
    expect(lenientXmlCleanup('<rss><!-- a & b')).toBe('<rss><!-- a & b');
  });

  it('strips XML-forbidden control characters and lone surrogates, keeping TAB, LF and CR', () => {
    expect(
      lenientXmlCleanup('<rss>\u0000a\u0001\u0008\u000B\u000C\u001F\uFFFE\uFFFF\t\n\r😀b</rss>'),
    ).toBe('<rss>a\t\n\r😀b</rss>');
    expect(lenientXmlCleanup('<rss>a\uD800b\uDC00c</rss>')).toBe('<rss>abc</rss>');
  });

  it('never removes markup and never changes the XML declaration', () => {
    const text = '<?xml version="1.0" encoding="windows-1250"?><rss><channel><a>unclosed</rss>';
    expect(lenientXmlCleanup(text)).toBe(text);
  });
});

describe('stripLeadingJunk', () => {
  it('removes a byte order mark and leading whitespace', () => {
    expect(stripLeadingJunk('\uFEFF\n  <rss/>')).toBe('<rss/>');
  });

  it('removes bounded junk before the XML declaration or a feed root', () => {
    const warning =
      '<br />\n<b>Warning</b>: something in <b>/var/www/x.php</b> on line <b>3</b><br />\n';
    expect(stripLeadingJunk(`${warning}<?xml version="1.0"?>\n<rss/>`)).toBe(
      '<?xml version="1.0"?>\n<rss/>',
    );
    expect(stripLeadingJunk(`${warning}\uFEFF<feed xmlns="x"/>`)).toBe('<feed xmlns="x"/>');
    expect(stripLeadingJunk('Notice: x\n<rdf:RDF>')).toBe('<rdf:RDF>');
  });

  it('keeps junk beyond the window and non-feed documents', () => {
    const far = `${'x'.repeat(LENIENT_JUNK_WINDOW)}<rss/>`;
    expect(stripLeadingJunk(far)).toBe(far);
    expect(stripLeadingJunk('<html><body><?xml nope?></body></html>')).toBe(
      '<html><body><?xml nope?></body></html>',
    );
    expect(stripLeadingJunk('junk <?xml version="1.0"?><html/>')).toBe(
      'junk <?xml version="1.0"?><html/>',
    );
  });
});
