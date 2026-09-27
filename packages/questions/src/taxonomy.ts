import type { OptionCriteria } from './builders.js';

/**
 * The v1 topic taxonomy (spec 05 §3.2), seeded into `topics`. Level-1 ids are plain, level-2 ids are
 * `<l1>.<l2>`. Every topic has `name_en`, `name_sk` and a one-line English description; the level-1
 * descriptions are the `topic_l1` criteria of `enrich-v1`, so changing any level-1 text or the
 * level-2 English names means a new enrich set version (§3.2). Old facets stay readable because
 * features are keyed by id.
 */

export interface TaxonomyL2 {
  /** `<l1>.<l2>`. */
  readonly id: string;
  readonly nameEn: string;
  readonly nameSk: string;
  readonly description: string;
}

export interface TaxonomyL1 {
  readonly id: string;
  readonly nameEn: string;
  readonly nameSk: string;
  readonly description: string;
  readonly children: readonly TaxonomyL2[];
}

/** The level-1 topic that means "none of the above"; it has no children and no L2 question. */
export const OTHER_TOPIC_ID = 'other';

type L2Spec = readonly [short: string, nameEn: string, nameSk: string, description: string];

function l1(
  id: string,
  nameEn: string,
  nameSk: string,
  description: string,
  children: readonly L2Spec[],
): TaxonomyL1 {
  return {
    id,
    nameEn,
    nameSk,
    description,
    children: children.map(([short, en, sk, desc]) => ({
      id: `${id}.${short}`,
      nameEn: en,
      nameSk: sk,
      description: desc,
    })),
  };
}

/** The 20 level-1 topics in table order (`other` last), each with its level-2 children. */
export const TAXONOMY: readonly TaxonomyL1[] = [
  l1(
    'technology',
    'Technology',
    'Technológie',
    'Software, hardware, the internet, AI and the tech industry',
    [
      [
        'software_dev',
        'Software development',
        'Vývoj softvéru',
        'Programming languages, tools, frameworks and software engineering practice',
      ],
      [
        'ai_ml',
        'AI and machine learning',
        'Umelá inteligencia',
        'Artificial intelligence, machine learning and their applications',
      ],
      [
        'hardware_gadgets',
        'Hardware and gadgets',
        'Hardvér a zariadenia',
        'Computers, phones, chips and consumer electronics',
      ],
      [
        'cybersecurity',
        'Cybersecurity',
        'Kybernetická bezpečnosť',
        'Security threats, breaches, vulnerabilities and privacy protection',
      ],
      [
        'internet_platforms',
        'Internet platforms and social media',
        'Internetové platformy a sociálne siete',
        'Social networks, search engines, apps and other online platforms',
      ],
      [
        'telecom',
        'Telecom and connectivity',
        'Telekomunikácie',
        'Mobile networks, broadband and telecom operators',
      ],
      [
        'open_source',
        'Open source',
        'Open source',
        'Open-source software, its communities and licensing',
      ],
      [
        'tech_industry',
        'Tech companies and industry',
        'Technologické firmy',
        'Tech companies, their business, deals and people',
      ],
    ],
  ),
  l1('science', 'Science', 'Veda', 'Scientific discoveries and research', [
    [
      'space',
      'Space and astronomy',
      'Vesmír a astronómia',
      'Space exploration, missions, astronomy and astrophysics',
    ],
    [
      'physics_chemistry',
      'Physics and chemistry',
      'Fyzika a chémia',
      'Research in physics, chemistry and materials',
    ],
    [
      'life_sciences',
      'Biology and life sciences',
      'Biológia',
      'Biology, genetics, evolution and the other life sciences',
    ],
    [
      'earth_science',
      'Earth and climate science',
      'Vedy o Zemi a klíme',
      'Geology, oceans, weather and climate research',
    ],
    [
      'research_academia',
      'Research and academia',
      'Výskum a akadémia',
      'How research is done, funded and published',
    ],
  ]),
  l1('health', 'Health', 'Zdravie', 'Medicine, fitness, nutrition and wellbeing', [
    [
      'medicine',
      'Medicine and healthcare',
      'Medicína a zdravotníctvo',
      'Diseases, treatments, drugs and healthcare systems',
    ],
    [
      'fitness_exercise',
      'Fitness and exercise',
      'Fitness a pohyb',
      'Exercise, training and physical fitness',
    ],
    ['nutrition', 'Nutrition and diet', 'Výživa', 'Food, diets and nutrition science'],
    [
      'mental_health',
      'Mental health',
      'Duševné zdravie',
      'Mental health, psychology and wellbeing',
    ],
    [
      'public_health',
      'Public health',
      'Verejné zdravie',
      'Epidemics, vaccination and population health policy',
    ],
  ]),
  l1('business', 'Business', 'Biznis', 'Companies, markets, money and work', [
    [
      'companies',
      'Companies and industry',
      'Firmy a priemysel',
      'Company news, results, strategy and industries',
    ],
    [
      'startups',
      'Startups and venture capital',
      'Startupy a rizikový kapitál',
      'Startups, founders and venture capital funding',
    ],
    [
      'markets_investing',
      'Markets and investing',
      'Trhy a investovanie',
      'Stock markets, funds and investing',
    ],
    [
      'personal_finance',
      'Personal finance',
      'Osobné financie',
      'Saving, budgeting, pensions and household money',
    ],
    ['real_estate', 'Real estate', 'Nehnuteľnosti', 'Property markets, housing and mortgages'],
    [
      'careers_work',
      'Careers and work',
      'Kariéra a práca',
      'Jobs, careers, workplaces and management',
    ],
    [
      'crypto',
      'Crypto and blockchain',
      'Kryptomeny a blockchain',
      'Cryptocurrencies, blockchain and digital assets',
    ],
  ]),
  l1('economy', 'Economy', 'Ekonomika', 'The economy as a whole and economic policy', [
    ['macro', 'Macroeconomy', 'Makroekonomika', 'Growth, recessions and economic indicators'],
    [
      'monetary_policy',
      'Central banks and inflation',
      'Centrálne banky a inflácia',
      'Central banks, interest rates and inflation',
    ],
    ['labor_market', 'Labour market', 'Trh práce', 'Employment, wages and the labour market'],
    [
      'trade',
      'Trade and tariffs',
      'Obchod a clá',
      'International trade, tariffs and supply chains',
    ],
    [
      'public_finance',
      'Taxes and public finance',
      'Dane a verejné financie',
      'Taxes, public budgets and public debt',
    ],
  ]),
  l1('politics', 'Politics', 'Politika', 'Government, elections, law and diplomacy', [
    [
      'domestic',
      'Domestic politics',
      'Domáca politika',
      'A country’s government, parliament and parties',
    ],
    ['elections', 'Elections', 'Voľby', 'Election campaigns, polls and results'],
    [
      'international_relations',
      'International relations',
      'Medzinárodné vzťahy',
      'Diplomacy, alliances and relations between countries',
    ],
    ['law_justice', 'Law and justice', 'Právo a justícia', 'Courts, laws and the justice system'],
    [
      'policy_regulation',
      'Government policy and regulation',
      'Vládna politika a regulácia',
      'Government policies, regulation and regulators',
    ],
  ]),
  l1('world', 'World news', 'Svet', 'Events in other regions of the world', [
    ['europe', 'Europe', 'Európa', 'News from European countries'],
    ['americas', 'The Americas', 'Amerika', 'News from North, Central and South America'],
    ['asia_pacific', 'Asia and the Pacific', 'Ázia a Tichomorie', 'News from Asia and the Pacific'],
    [
      'middle_east_africa',
      'Middle East and Africa',
      'Blízky východ a Afrika',
      'News from the Middle East and Africa',
    ],
    [
      'conflicts',
      'War and armed conflicts',
      'Vojny a konflikty',
      'Wars, armed conflicts and their consequences',
    ],
  ]),
  l1(
    'local',
    'Slovakia and Czechia',
    'Slovensko a Česko',
    'News specifically about Slovakia or Czechia',
    [
      ['slovakia', 'Slovakia', 'Slovensko', 'News about Slovakia'],
      ['czechia', 'Czechia', 'Česko', 'News about Czechia'],
      [
        'regional_city',
        'Regional and city news',
        'Regionálne a mestské správy',
        'News about Slovak or Czech regions, cities and towns',
      ],
    ],
  ),
  l1('environment', 'Environment', 'Životné prostredie', 'Climate, energy, nature and pollution', [
    [
      'climate_policy',
      'Climate policy',
      'Klimatická politika',
      'Climate change policy, targets and negotiations',
    ],
    [
      'energy',
      'Energy and the energy transition',
      'Energetika',
      'Energy production, prices and the energy transition',
    ],
    ['nature', 'Nature and wildlife', 'Príroda a zvieratá', 'Nature, wildlife and conservation'],
    [
      'pollution_waste',
      'Pollution and waste',
      'Znečistenie a odpad',
      'Pollution, waste and recycling',
    ],
  ]),
  l1(
    'transport',
    'Cars and transport',
    'Autá a doprava',
    'Vehicles, mobility and travel infrastructure',
    [
      ['cars', 'Cars', 'Autá', 'Cars, the car industry, roads and driving'],
      ['ev', 'Electric vehicles', 'Elektromobily', 'Electric vehicles, batteries and charging'],
      [
        'public_transport_rail',
        'Public transport and rail',
        'Verejná doprava a železnice',
        'Public transport and railways',
      ],
      ['aviation', 'Aviation', 'Letectvo', 'Airlines, airports and aircraft'],
      [
        'cycling_micromobility',
        'Cycling and micromobility',
        'Cyklistika a mikromobilita',
        'Everyday cycling, scooters and other micromobility',
      ],
    ],
  ),
  l1('culture', 'Culture and arts', 'Kultúra a umenie', 'Film, music, books and the arts', [
    ['film_tv', 'Film and TV', 'Film a televízia', 'Films, TV series and the screen industry'],
    ['music', 'Music', 'Hudba', 'Music, musicians and concerts'],
    ['books', 'Books and literature', 'Knihy a literatúra', 'Books, authors and literature'],
    [
      'visual_arts_design',
      'Visual arts and design',
      'Výtvarné umenie a dizajn',
      'Visual arts, exhibitions, architecture and design',
    ],
    [
      'performing_arts',
      'Theatre and performing arts',
      'Divadlo a scénické umenie',
      'Theatre, dance, opera and the other performing arts',
    ],
  ]),
  l1('entertainment', 'Entertainment', 'Zábava', 'Celebrities, streaming, humour and events', [
    ['celebrities', 'Celebrities', 'Celebrity', 'Celebrities and famous people'],
    [
      'streaming_video',
      'Streaming and online video',
      'Streaming a online video',
      'Streaming services, online video and creators',
    ],
    [
      'humor_viral',
      'Humour and viral content',
      'Humor a virálny obsah',
      'Humour, memes and viral content',
    ],
    [
      'events_festivals',
      'Events and festivals',
      'Podujatia a festivaly',
      'Events, festivals and things to do',
    ],
  ]),
  l1('gaming', 'Gaming', 'Hry', 'Video, board and competitive games', [
    ['video_games', 'Video games', 'Videohry', 'Video games, their releases and reviews'],
    [
      'tabletop',
      'Board and tabletop games',
      'Stolové hry',
      'Board games, card games and tabletop role-playing',
    ],
    ['esports', 'Esports', 'E-športy', 'Competitive gaming and esports'],
    [
      'game_industry',
      'Game industry',
      'Herný priemysel',
      'Game studios, publishers and the games business',
    ],
  ]),
  l1('sports', 'Sports', 'Šport', 'Competitive sport', [
    ['football', 'Football', 'Futbal', 'Football (soccer) leagues, clubs and players'],
    ['ice_hockey', 'Ice hockey', 'Hokej', 'Ice hockey leagues, clubs and players'],
    ['tennis', 'Tennis', 'Tenis', 'Tennis tournaments and players'],
    ['motorsport', 'Motorsport', 'Motoršport', 'Formula 1, rallying and other motorsport'],
    [
      'cycling_sport',
      'Cycling (sport)',
      'Cyklistika (šport)',
      'Road, track and mountain-bike racing',
    ],
    ['winter_sports', 'Winter sports', 'Zimné športy', 'Skiing, biathlon and other winter sports'],
    ['other_sports', 'Other sports', 'Ostatné športy', 'All other competitive sports'],
  ]),
  l1('lifestyle', 'Lifestyle', 'Životný štýl', 'Food, travel, home, fashion and family', [
    [
      'food_cooking',
      'Food and cooking',
      'Jedlo a varenie',
      'Recipes, cooking, drinks and restaurants',
    ],
    ['travel', 'Travel', 'Cestovanie', 'Travel destinations, trips and travel tips'],
    ['fashion_beauty', 'Fashion and beauty', 'Móda a krása', 'Fashion, clothing and beauty'],
    ['home_garden', 'Home and garden', 'Domov a záhrada', 'Home, interiors and gardening'],
    [
      'family_parenting',
      'Family and parenting',
      'Rodina a výchova',
      'Family life, children and parenting',
    ],
    ['relationships', 'Relationships', 'Vzťahy', 'Relationships, dating and friendship'],
  ]),
  l1('education', 'Education', 'Vzdelávanie', 'Schools, universities and learning', [
    ['schools', 'Schools', 'Školy', 'Primary and secondary schools'],
    [
      'higher_education',
      'Universities',
      'Vysoké školy',
      'Universities, students and academic life',
    ],
    [
      'learning_skills',
      'Learning and skills',
      'Učenie a zručnosti',
      'Learning, courses and skills for adults',
    ],
  ]),
  l1('society', 'Society', 'Spoločnosť', 'Social issues, religion, crime, history and media', [
    [
      'social_issues',
      'Social issues',
      'Spoločenské témy',
      'Inequality, migration, rights and other social issues',
    ],
    ['religion', 'Religion', 'Náboženstvo', 'Religion, churches and faith'],
    [
      'crime_safety',
      'Crime and public safety',
      'Kriminalita a bezpečnosť',
      'Crime, policing and public safety',
    ],
    ['history', 'History', 'História', 'History and historical events'],
    [
      'media_journalism',
      'Media and journalism',
      'Médiá a žurnalistika',
      'News media, journalism and press freedom',
    ],
  ]),
  l1(
    'shopping',
    'Shopping and deals',
    'Nákupy a zľavy',
    'Buying things: deals, classifieds and buying advice',
    [
      ['deals', 'Deals and discounts', 'Zľavy a akcie', 'Discounts, sales and special offers'],
      [
        'classifieds',
        'Classifieds and second-hand',
        'Inzeráty a bazár',
        'Classified ads and second-hand goods',
      ],
      [
        'buying_guides',
        'Product reviews and buying guides',
        'Recenzie a nákupné rady',
        'Product reviews, tests and buying advice',
      ],
    ],
  ),
  l1('diy', 'DIY and making', 'Urob si sám', 'Building, repairing and making things', [
    [
      'electronics_diy',
      'Electronics and maker projects',
      'Elektronika a maker projekty',
      'Electronics projects, microcontrollers and maker culture',
    ],
    [
      'printing_3d',
      '3D printing',
      '3D tlač',
      '3D printers, printable models and printing techniques',
    ],
    [
      'crafts_woodworking',
      'Crafts and woodworking',
      'Remeslá a drevo',
      'Crafts, woodworking and handmade things',
    ],
    [
      'home_improvement',
      'Home improvement',
      'Rekonštrukcie a opravy',
      'Renovation, repairs and home improvement',
    ],
  ]),
  l1(OTHER_TOPIC_ID, 'Other', 'Iné', 'None of the above', []),
];

/** Level-1 ids in table order, `other` last. */
export const L1_IDS: readonly string[] = TAXONOMY.map((topic) => topic.id);

const L1_BY_ID: ReadonlyMap<string, TaxonomyL1> = new Map(
  TAXONOMY.map((topic) => [topic.id, topic]),
);
const TOPIC_IDS: ReadonlySet<string> = new Set(
  TAXONOMY.flatMap((topic) => [topic.id, ...topic.children.map((child) => child.id)]),
);

/** The level-1 topic with this id, if any. */
export function taxonomyL1(id: string): TaxonomyL1 | undefined {
  return L1_BY_ID.get(id);
}

/** Whether `id` is a level-1 or level-2 topic of the taxonomy. */
export function isTopicId(id: string): boolean {
  return TOPIC_IDS.has(id);
}

/** The level-1 part of a topic id (`transport.ev` → `transport`, `transport` → `transport`). */
export function topicL1(topicId: string): string {
  const dot = topicId.indexOf('.');
  return dot === -1 ? topicId : topicId.slice(0, dot);
}

/** One `topics` row (spec 02 §3.1) as the seed writes it. */
export interface TopicRow {
  id: string;
  parentId: string | null;
  level: 1 | 2;
  nameEn: string;
  nameSk: string;
  description: string;
  /** Display order: the table position of a level-1 topic, the position under its parent for level 2. */
  sort: number;
}

/** Every topic as a seed row: each level-1 topic followed by its children. */
export function taxonomyTopicRows(): TopicRow[] {
  return TAXONOMY.flatMap((topic, i): TopicRow[] => [
    {
      id: topic.id,
      parentId: null,
      level: 1,
      nameEn: topic.nameEn,
      nameSk: topic.nameSk,
      description: topic.description,
      sort: i + 1,
    },
    ...topic.children.map((child, j): TopicRow => ({
      id: child.id,
      parentId: topic.id,
      level: 2,
      nameEn: child.nameEn,
      nameSk: child.nameSk,
      description: child.description,
      sort: j + 1,
    })),
  ]);
}

/**
 * `topic_l1` criteria of `enrich-v1` (spec 05 §3.3): `{ <l1 id>: { what: description, includes:
 * [L2 EN names] }, other: null }` in taxonomy order.
 */
export function taxonomyL1Criteria(): Record<string, OptionCriteria> {
  const criteria: Record<string, OptionCriteria> = {};
  for (const topic of TAXONOMY) {
    criteria[topic.id] =
      topic.id === OTHER_TOPIC_ID
        ? null
        : { what: topic.description, includes: topic.children.map((child) => child.nameEn) };
  }
  return criteria;
}
