import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useTopics, type Topic } from './queries.js';

export interface TopicGroup {
  parent: Topic;
  /** The parent's name in the interface language. */
  name: string;
  children: { topic: Topic; name: string }[];
}

export interface TopicIndex {
  /** The name of a topic in the interface language; undefined for an id the taxonomy lacks. */
  name: (id: string) => string | undefined;
  /** The level-1 topics in display order, each with its level-2 topics. */
  groups: TopicGroup[];
}

function languageOf(language: string): 'en' | 'sk' {
  return language.toLowerCase().startsWith('sk') ? 'sk' : 'en';
}

export function buildTopicIndex(topics: readonly Topic[], language: string): TopicIndex {
  const lang = languageOf(language);
  const names = new Map(topics.map((topic) => [topic.id, topic.names[lang]]));
  const groups = topics
    .filter((topic) => topic.level === 1)
    .map((parent) => ({
      parent,
      name: parent.names[lang],
      children: topics
        .filter((topic) => topic.parent === parent.id)
        .map((topic) => ({ topic, name: topic.names[lang] })),
    }));
  return { name: (id) => names.get(id), groups };
}

/** The taxonomy of `GET /topics` in the interface language; `index` is null until it has loaded. */
export function useTopicIndex() {
  const topics = useTopics();
  const { i18n } = useTranslation();
  const index = useMemo(
    () => (topics.data === undefined ? null : buildTopicIndex(topics.data, i18n.language)),
    [topics.data, i18n.language],
  );
  return { topics, index };
}
