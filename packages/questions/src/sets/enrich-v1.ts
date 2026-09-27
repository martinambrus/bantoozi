import { choice, noul, score } from '../builders.js';
import { taxonomyL1Criteria } from '../taxonomy.js';
import { staticQuestionSet } from './define.js';

/**
 * Question set `enrich-v1` (Call A, spec 05 §3.3), verbatim. Every question follows TypeSafe's
 * jaggedness notes: a high Noul probability always means "yes, the named thing", and there are no
 * negated instructions, no arithmetic and no dates. Changing any wording, option or the taxonomy
 * text means a new version (`enrich-v2`); the seed refuses a changed sha under the same version.
 */
export const ENRICH_V1 = staticQuestionSet({
  kind: 'enrich',
  version: 'enrich-v1',
  questions: {
    content_type: choice(
      {
        question: 'What kind of piece is `article`?',
        focus: 'Judge the form of the piece, not its topic.',
      },
      {
        news_report: {
          what: 'Reports a specific recent event, announcement, release, ruling or result',
          examples: ['Company X recalls 40,000 cars over brake fault'],
        },
        analysis: {
          what: 'Explains causes, context or implications of events, based on reporting or data',
        },
        opinion: { what: "Argues the author's personal view: column, editorial, commentary" },
        tutorial: { what: 'Teaches how to do something step by step' },
        review: { what: 'Evaluates one specific product, book, film, game, place or service' },
        listicle: { what: 'Organized as a numbered or bulleted list of items ("10 best …")' },
        press_release: {
          what: 'Written by the organization it is about, announcing something in its own voice',
        },
        deal_or_ad: {
          what: 'Sells something: discount, offer, classified ad, sponsored product placement',
        },
        job_or_event: { what: 'A job posting, event listing or call for participants' },
        media: { what: 'Mainly a podcast episode, video or photo gallery with little text' },
        interview: { what: 'Mostly questions and answers with one person' },
        other: null,
      },
    ),
    topic_l1: choice(
      {
        question: 'Which top-level topic is `article` primarily about?',
        focus: 'Pick the main subject, not every topic mentioned.',
      },
      // { <l1 id>: { what: description, includes: [L2 EN names] }, other: null }
      taxonomyL1Criteria(),
    ),
    depth: score('How much substance does `article` offer beyond its headline?', [
      'Headline only, or a one-paragraph rewrite of another source',
      'Short brief: the basic facts, little context',
      'Standard article: facts plus some context or quotes',
      'In-depth: detailed explanation, data, several sources or perspectives',
      'Deep dive or investigation: original research, extensive detail',
    ]),
    clickbait: noul(
      'Does the title of `article` withhold or exaggerate what the article actually delivers?',
      {
        true: {
          what: 'Curiosity gap, sensational framing, or a promise that the excerpt does not meet',
          examples: ["You won't believe what this app does", 'This one trick …'],
        },
        false: { what: 'The title plainly states what the article is about' },
      },
    ),
    promotional: noul(
      'Is `article` a press release, sponsored post, affiliate roundup or vendor marketing rather than independent content?',
    ),
    time_sensitive: noul(
      'Will `article` lose most of its value within a few days (breaking news, an expiring deal, an upcoming event)?',
    ),
    evergreen: noul('Would `article` still be useful to a reader six months from now?'),
    local_scope: choice('What geographic scope does `article` concern?', {
      global: 'Relevant regardless of country',
      national: 'Mainly about one country',
      regional_or_city: 'Mainly about a region, city or town',
      not_geographic: null,
    }),
    tone: score('What is the emotional tone of `article`?', [
      'Alarming or distressing',
      'Negative',
      'Neutral',
      'Positive',
      'Upbeat or celebratory',
    ]),
    paywall_teaser: noul(
      "Does `article`'s text read like a teaser for content behind a paywall or login?",
    ),
  },
});

/** The question keys of `enrich-v1`. */
export type EnrichV1Key = keyof typeof ENRICH_V1.questions;
