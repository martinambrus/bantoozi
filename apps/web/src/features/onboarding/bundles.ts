export interface StarterBundle {
  id: string;
  names: { en: string; sk: string };
  /** Public https feed addresses, 3 to 8 per bundle; the first-run wizard adds them one by one. */
  urls: readonly string[];
}

/** Starter bundles of the first-run wizard (spec 09 §4 step 2). */
export const BUNDLES: readonly StarterBundle[] = [
  {
    id: 'slovak-news',
    names: { en: 'Slovak news', sk: 'Slovenské správy' },
    urls: [
      'https://dennikn.sk/feed/',
      'https://www.sme.sk/rss-title',
      'https://spravy.pravda.sk/rss/xml/',
      'https://www.aktuality.sk/rss/',
      'https://www.postoj.sk/feed',
    ],
  },
  {
    id: 'czech-news',
    names: { en: 'Czech news', sk: 'České správy' },
    urls: [
      'https://www.irozhlas.cz/rss/irozhlas',
      'https://ct24.ceskatelevize.cz/rss/hlavni-zpravy',
      'https://www.novinky.cz/rss',
      'https://servis.idnes.cz/rss.aspx?c=zpravodaj',
      'https://denikn.cz/feed/',
      'https://www.seznamzpravy.cz/rss',
    ],
  },
  {
    id: 'world-news',
    names: { en: 'World news', sk: 'Svetové správy' },
    urls: [
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://www.theguardian.com/world/rss',
      'https://www.aljazeera.com/xml/rss/all.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
      'https://feeds.npr.org/1004/rss.xml',
      'https://rss.dw.com/rdf/rss-en-all',
    ],
  },
  {
    id: 'tech',
    names: { en: 'Tech', sk: 'Technológie' },
    urls: [
      'https://feeds.arstechnica.com/arstechnica/index',
      'https://www.theverge.com/rss/index.xml',
      'https://techcrunch.com/feed/',
      'https://www.wired.com/feed/rss',
      'https://hnrss.org/frontpage',
      'https://www.technologyreview.com/feed/',
    ],
  },
  {
    id: 'programming',
    names: { en: 'Programming', sk: 'Programovanie' },
    urls: [
      'https://github.blog/feed/',
      'https://stackoverflow.blog/feed/',
      'https://blog.rust-lang.org/feed.xml',
      'https://go.dev/blog/feed.atom',
      'https://martinfowler.com/feed.atom',
      'https://hacks.mozilla.org/feed/',
    ],
  },
  {
    id: 'science',
    names: { en: 'Science', sk: 'Veda' },
    urls: [
      'https://www.nature.com/nature.rss',
      'https://www.sciencedaily.com/rss/all.xml',
      'https://www.quantamagazine.org/feed/',
      'https://www.newscientist.com/feed/home/',
      'https://www.sciencenews.org/feed',
      'https://phys.org/rss-feed/',
    ],
  },
  {
    id: 'space',
    names: { en: 'Space', sk: 'Vesmír' },
    urls: [
      'https://www.nasa.gov/feed/',
      'https://spacenews.com/feed/',
      'https://www.space.com/feeds/all',
      'https://www.universetoday.com/feed',
      'https://earthsky.org/feed/',
    ],
  },
  {
    id: 'business',
    names: { en: 'Business', sk: 'Ekonomika a biznis' },
    urls: [
      'https://feeds.bbci.co.uk/news/business/rss.xml',
      'https://www.theguardian.com/uk/business/rss',
      'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
      'https://feeds.npr.org/1006/rss.xml',
      'https://www.cnbc.com/id/10001147/device/rss/rss.html',
      'https://www.economist.com/finance-and-economics/rss.xml',
    ],
  },
  {
    id: 'health',
    names: { en: 'Health', sk: 'Zdravie a medicína' },
    urls: [
      'https://feeds.bbci.co.uk/news/health/rss.xml',
      'https://www.theguardian.com/society/health/rss',
      'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml',
      'https://feeds.npr.org/1128/rss.xml',
      'https://www.who.int/rss-feeds/news-english.xml',
    ],
  },
  {
    id: 'sport',
    names: { en: 'Sport', sk: 'Šport' },
    urls: [
      'https://feeds.bbci.co.uk/sport/rss.xml',
      'https://www.theguardian.com/uk/sport/rss',
      'https://www.espn.com/espn/rss/news',
      'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml',
      'https://www.skysports.com/rss/12040',
    ],
  },
];
