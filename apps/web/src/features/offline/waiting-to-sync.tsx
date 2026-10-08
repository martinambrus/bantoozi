import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/badge.js';

/** On an article with a change that is kept on the device and not sent yet (spec 09 §1). */
export function WaitingToSync({ id }: { id?: string | undefined }) {
  const { t } = useTranslation('offline');
  return (
    <Badge id={id} tone="warning">
      {t('waiting.badge')}
    </Badge>
  );
}
