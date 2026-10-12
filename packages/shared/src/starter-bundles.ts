/** Language of a starter feed's articles (declared by us; `bundles:check --live` verifies it). */
export type StarterFeedLang = 'en' | 'sk' | 'cs';

export interface StarterFeed {
  url: string;
  lang: StarterFeedLang;
}

export interface StarterBundle {
  id: string;
  names: { en: string; sk: string };
  /** Public https feeds, 3 to 8 per bundle; the first-run wizard adds them one by one. */
  feeds: readonly StarterFeed[];
  /** The feed addresses alone, in the same order as `feeds`. */
  urls: readonly string[];
}

type BundleDefinition = Omit<StarterBundle, 'urls'>;

const DEFINITIONS: readonly BundleDefinition[] = [
  {
    id: 'slovak-news',
    names: { en: 'Slovak news', sk: 'Slovenské správy' },
    feeds: [
      { url: 'https://dennikn.sk/feed/', lang: 'sk' },
      { url: 'https://www.sme.sk/rss-title', lang: 'sk' },
      { url: 'https://spravy.pravda.sk/rss/xml/', lang: 'sk' },
      { url: 'https://www.aktuality.sk/rss/', lang: 'sk' },
      { url: 'https://www.postoj.sk/rss', lang: 'sk' },
    ],
  },
  {
    id: 'czech-news',
    names: { en: 'Czech news', sk: 'České správy' },
    feeds: [
      { url: 'https://www.irozhlas.cz/rss/irozhlas', lang: 'cs' },
      { url: 'https://ct24.ceskatelevize.cz/rss/hlavni-zpravy', lang: 'cs' },
      { url: 'https://www.novinky.cz/rss', lang: 'cs' },
      { url: 'https://servis.idnes.cz/rss.aspx?c=zpravodaj', lang: 'cs' },
      { url: 'https://denikn.cz/feed/', lang: 'cs' },
      { url: 'https://www.seznamzpravy.cz/rss', lang: 'cs' },
    ],
  },
  {
    id: 'world-news',
    names: { en: 'World news', sk: 'Svetové správy' },
    feeds: [
      { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', lang: 'en' },
      { url: 'https://www.theguardian.com/world/rss', lang: 'en' },
      { url: 'https://www.aljazeera.com/xml/rss/all.xml', lang: 'en' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', lang: 'en' },
      { url: 'https://feeds.npr.org/1004/rss.xml', lang: 'en' },
      { url: 'https://rss.dw.com/rdf/rss-en-all', lang: 'en' },
    ],
  },
  {
    id: 'tech',
    names: { en: 'Tech', sk: 'Technológie' },
    feeds: [
      { url: 'https://feeds.arstechnica.com/arstechnica/index', lang: 'en' },
      { url: 'https://www.theverge.com/rss/index.xml', lang: 'en' },
      { url: 'https://techcrunch.com/feed/', lang: 'en' },
      { url: 'https://www.wired.com/feed/rss', lang: 'en' },
      { url: 'https://hnrss.org/frontpage', lang: 'en' },
      { url: 'https://www.technologyreview.com/feed/', lang: 'en' },
    ],
  },
  {
    id: 'programming',
    names: { en: 'Programming', sk: 'Programovanie' },
    feeds: [
      { url: 'https://github.blog/feed/', lang: 'en' },
      { url: 'https://stackoverflow.blog/feed/', lang: 'en' },
      { url: 'https://blog.rust-lang.org/feed.xml', lang: 'en' },
      { url: 'https://go.dev/blog/feed.atom', lang: 'en' },
      { url: 'https://martinfowler.com/feed.atom', lang: 'en' },
      { url: 'https://hacks.mozilla.org/feed/', lang: 'en' },
    ],
  },
  {
    id: 'science',
    names: { en: 'Science', sk: 'Veda' },
    feeds: [
      { url: 'https://www.nature.com/nature.rss', lang: 'en' },
      { url: 'https://www.sciencedaily.com/rss/all.xml', lang: 'en' },
      { url: 'https://www.quantamagazine.org/feed/', lang: 'en' },
      { url: 'https://www.newscientist.com/feed/home/', lang: 'en' },
      { url: 'https://www.sciencenews.org/feed', lang: 'en' },
      { url: 'https://phys.org/rss-feed/', lang: 'en' },
    ],
  },
  {
    id: 'space',
    names: { en: 'Space', sk: 'Vesmír' },
    feeds: [
      { url: 'https://www.nasa.gov/feed/', lang: 'en' },
      { url: 'https://spacenews.com/feed/', lang: 'en' },
      { url: 'https://www.space.com/feeds/all', lang: 'en' },
      { url: 'https://www.universetoday.com/feed', lang: 'en' },
      { url: 'https://earthsky.org/feed/', lang: 'en' },
    ],
  },
  {
    id: 'business',
    names: { en: 'Business', sk: 'Ekonomika a biznis' },
    feeds: [
      { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', lang: 'en' },
      { url: 'https://www.theguardian.com/uk/business/rss', lang: 'en' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', lang: 'en' },
      { url: 'https://feeds.npr.org/1006/rss.xml', lang: 'en' },
      { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', lang: 'en' },
      { url: 'https://www.economist.com/finance-and-economics/rss.xml', lang: 'en' },
    ],
  },
  {
    id: 'health',
    names: { en: 'Health', sk: 'Zdravie a medicína' },
    feeds: [
      { url: 'https://feeds.bbci.co.uk/news/health/rss.xml', lang: 'en' },
      { url: 'https://www.theguardian.com/society/health/rss', lang: 'en' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Health.xml', lang: 'en' },
      { url: 'https://feeds.npr.org/1128/rss.xml', lang: 'en' },
      { url: 'https://www.who.int/rss-feeds/news-english.xml', lang: 'en' },
    ],
  },
  {
    id: 'sport',
    names: { en: 'Sport', sk: 'Šport' },
    feeds: [
      { url: 'https://feeds.bbci.co.uk/sport/rss.xml', lang: 'en' },
      { url: 'https://www.theguardian.com/uk/sport/rss', lang: 'en' },
      { url: 'https://www.espn.com/espn/rss/news', lang: 'en' },
      { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Sports.xml', lang: 'en' },
      { url: 'https://www.skysports.com/rss/12040', lang: 'en' },
    ],
  },
];

/** Starter bundles of the first-run wizard (spec 09 §4 step 2). */
export const STARTER_BUNDLES: readonly StarterBundle[] = DEFINITIONS.map((bundle) => ({
  ...bundle,
  urls: bundle.feeds.map((feed) => feed.url),
}));
