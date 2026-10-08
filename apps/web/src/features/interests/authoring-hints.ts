/**
 * The authoring rules of spec 05 §8 that can be checked while typing. They only advise, so a
 * false alarm costs a glance: a negation, a digit, or several topics in one description.
 */
export interface AuthoringFlags {
  /** More than one topic, joined by "and", "a" or a comma. */
  severalTopics: boolean;
  /** A negation in the main text, where "but not" belongs. */
  negation: boolean;
  /** A digit, which usually means a date or a number limit. */
  number: boolean;
}

// Whole words only: "notebooks" and "nobel" contain a negation without being one.
const NEGATION = /(?<![\p{L}\p{N}\p{M}_-])(?:not|no|without|nie|bez)(?![\p{L}\p{N}\p{M}_-])/iu;
const DIGIT = /\p{Nd}/u;
const TOPIC_SEPARATOR = /\s*,\s*|\s+(?:and|a)\s+/iu;

export function checkAuthoring(interest: string): AuthoringFlags {
  const topics = interest.split(TOPIC_SEPARATOR).filter((part) => part.trim() !== '');
  return {
    severalTopics: topics.length > 1,
    negation: NEGATION.test(interest),
    number: DIGIT.test(interest),
  };
}
