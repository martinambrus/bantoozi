import { useTranslation } from 'react-i18next';

import { useTopicIndex } from '../interests/topics.js';

const STRENGTH = /^(known\.)?best\.(must|love|like|never)$/;
const CARD = /^(known\.)?card\./;
const FEED_GROUP = /^feed\.h\d+$/;
const AUTHOR_GROUP = /^author\.h\d+$/;

/** Returns a function that words a personal-model feature key in the interface language, or gives back the server's label when the key is not known. */
export function useFeatureLabel(): (feature: string, label: string) => string {
  const { t, i18n } = useTranslation('why');
  const { index } = useTopicIndex();
  const has = (key: string) => i18n.exists(`why:${key}`);

  return (feature, label) => {
    if (CARD.test(feature)) return label;
    const strength = STRENGTH.exec(feature);
    if (strength !== null) {
      return t(strength[1] === undefined ? 'model.feature.group' : 'model.feature.knownGroup', {
        strength: t(`interests:strength.${strength[2]}`),
      });
    }
    if (FEED_GROUP.test(feature)) return t('model.feature.feed_group');
    if (AUTHOR_GROUP.test(feature)) return t('model.feature.author_group');
    if (feature.startsWith('ct.')) {
      const key = `about.contentTypes.${feature.slice(3)}`;
      return has(key) ? t('model.feature.type', { type: t(key) }) : label;
    }
    if (feature.startsWith('t1.')) {
      const topic = index?.name(feature.slice(3));
      return topic === undefined ? label : t('model.feature.topic', { topic });
    }
    const key = `model.feature.${feature.replace('.', '-')}`;
    return has(key) ? t(key) : label;
  };
}
