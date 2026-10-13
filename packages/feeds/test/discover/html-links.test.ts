import { describe, expect, it } from 'vitest';

import {
  ALTERNATE_FEED_TYPES,
  findAlternateFeeds,
  findAnchorFeeds,
} from '../../src/discover/index.js';

const PAGE = 'https://blog.example/posts/hello?x=1';

function page(head: string, body = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Blog</title>${head}</head><body>${body}</body></html>`;
}

describe('findAlternateFeeds', () => {
  it('finds the four feed types in document order and resolves hrefs against the page', () => {
    const html = page(`
      <link rel="stylesheet" href="/style.css">
      <link rel="alternate" type="application/rss+xml" title="Blog » Feed" href="/feed/">
      <link rel="alternate" type="application/atom+xml" href="atom.xml">
      <link rel="alternate" type="application/feed+json" title="  JSON\n Feed " href="//cdn.example/feed.json">
      <link rel="alternate" type="application/json" href="https://blog.example/wp-json/wp/v2/posts/1">
      <link rel="alternate" hreflang="de" href="/de/">
      <link rel="alternate" type="application/json+oembed" href="/oembed?url=x">
      <link rel="alternate" type="text/html" href="/amp/">`);
    expect(findAlternateFeeds(html, PAGE)).toEqual([
      { url: 'https://blog.example/feed/', title: 'Blog » Feed', type: 'application/rss+xml' },
      { url: 'https://blog.example/posts/atom.xml', title: null, type: 'application/atom+xml' },
      { url: 'https://cdn.example/feed.json', title: 'JSON Feed', type: 'application/feed+json' },
      {
        url: 'https://blog.example/wp-json/wp/v2/posts/1',
        title: null,
        type: 'application/json',
      },
    ]);
  });

  it('matches rel tokens and types case-insensitively and ignores type parameters', () => {
    const html = page(`
      <link rel="Alternate Feed" type="Application/RSS+XML; charset=UTF-8" href="/a">
      <link rel="\talternate\n" type=" application/atom+xml " href="/b">
      <link rel="alternates" type="application/rss+xml" href="/not-a-token">
      <link rel="alternate-feed" type="application/rss+xml" href="/not-either">`);
    expect(findAlternateFeeds(html, PAGE).map((link) => link.url)).toEqual([
      'https://blog.example/a',
      'https://blog.example/b',
    ]);
  });

  it('also reads links outside <head>', () => {
    const html = page('', '<link rel="alternate" type="application/rss+xml" href="/body-feed">');
    expect(findAlternateFeeds(html, PAGE).map((link) => link.url)).toEqual([
      'https://blog.example/body-feed',
    ]);
  });

  it('skips links without a type, with an empty href or with an unresolvable href', () => {
    const html = page(`
      <link rel="alternate" href="/no-type">
      <link rel="alternate" type="application/rss+xml" href="   ">
      <link rel="alternate" type="application/rss+xml">
      <link rel="alternate" type="application/rss+xml" href="http://exa mple.com/feed">
      <link rel="alternate" type="application/rss+xml" href="/ok">`);
    expect(findAlternateFeeds(html, PAGE).map((link) => link.url)).toEqual([
      'https://blog.example/ok',
    ]);
  });

  it('keeps other schemes for the caller to reject', () => {
    const html = page(`
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
      <link rel="alternate" type="application/rss+xml" href="ftp://files.example/feed">`);
    expect(findAlternateFeeds(html, PAGE).map((link) => link.url)).toEqual([
      'javascript:alert(1)',
      'ftp://files.example/feed',
    ]);
  });

  it('resolves against the first <base href>', () => {
    const html = page(`
      <base href="/blog/">
      <base href="https://ignored.example/">
      <link rel="alternate" type="application/rss+xml" href="feed.xml">`);
    expect(findAlternateFeeds(html, PAGE).map((link) => link.url)).toEqual([
      'https://blog.example/blog/feed.xml',
    ]);
  });

  it.each([
    ['a non-http base', '<base href="javascript:void(0)">'],
    ['an empty base', '<base href="  ">'],
    ['an unparsable base', '<base href="http://exa mple.com/">'],
  ])('ignores %s', (_name, base) => {
    const html = page(`${base}<link rel="alternate" type="application/rss+xml" href="feed.xml">`);
    expect(findAlternateFeeds(html, PAGE).map((link) => link.url)).toEqual([
      'https://blog.example/posts/feed.xml',
    ]);
  });

  it('returns nothing for a page without links or for non-HTML text', () => {
    expect(findAlternateFeeds(page(''), PAGE)).toEqual([]);
    expect(findAlternateFeeds('{"not": "html"}', PAGE)).toEqual([]);
    expect(findAlternateFeeds('', PAGE)).toEqual([]);
  });

  it('declares the spec 03 §10 types', () => {
    expect(ALTERNATE_FEED_TYPES).toEqual([
      'application/rss+xml',
      'application/atom+xml',
      'application/feed+json',
      'application/json',
    ]);
  });
});

describe('findAnchorFeeds', () => {
  const AUTO = 'https://auto.bazos.sk/';

  it('finds a feed named only by an anchor, with its text as the title', () => {
    const html = page(
      '',
      '<p><a href="https://www.bazos.sk/rss.php?rub=au">RSS</a>, <form></form></p>',
    );
    expect(findAnchorFeeds(html, AUTO)).toEqual([
      { url: 'https://www.bazos.sk/rss.php?rub=au', title: 'RSS' },
    ]);
  });

  it('ranks the same host and feed extensions first, then document order', () => {
    const html = page(
      '',
      `<a href="https://other.example/feed/">other word</a>
       <a href="/news/feed/">local word</a>
       <a href="https://other.example/a.xml">other ext</a>
       <a href="/b.rss" title="Local ext">  </a>`,
    );
    expect(findAnchorFeeds(html, AUTO).map((link) => link.url)).toEqual([
      'https://auto.bazos.sk/b.rss',
      'https://auto.bazos.sk/news/feed/',
      'https://other.example/a.xml',
      'https://other.example/feed/',
    ]);
    expect(findAnchorFeeds(html, AUTO)[0]?.title).toBe('Local ext');
  });

  it('ignores whole-word look-alikes, fragments, non-http links, duplicates and the page itself', () => {
    const html = page(
      '',
      `<a href="/feedback">Feedback</a><a href="/atomic">Atomic</a><a href="/products">Products</a>
       <a href="#rss">jump</a><a href="mailto:rss@x.example">mail</a><a href="javascript:rss()">js</a>
       <a href="/rss/">Self</a><a href="/rss/#top">Self again</a><a href="/rss">RSS</a>`,
    );
    expect(findAnchorFeeds(html, 'https://blog.example/rss/').map((link) => link.url)).toEqual([
      'https://blog.example/rss',
    ]);
  });
});
