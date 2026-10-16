import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/badge.js';
import { formatInterval } from '../../i18n/duration.js';
import { useMe } from '../../session/context.js';
import { SettingsSection } from './section.js';

export function PlanBadge() {
  const { t, i18n } = useTranslation('settings');
  const me = useMe();
  const plan = me.planInfo;
  if (plan === undefined) return null;
  const label = i18n.language.startsWith('sk') ? (plan.labelSk ?? plan.label) : plan.label;
  return <Badge>{t('plan.badge', { label })}</Badge>;
}

export function PlanSection() {
  const { t, i18n } = useTranslation('settings');
  const me = useMe();
  const plan = me.planInfo;
  if (plan === undefined) return null;
  return (
    <SettingsSection title={t('plan.title')} description={t('plan.description')}>
      <div>
        <PlanBadge />
      </div>
      <p>
        {plan.releaseIntervalS == null || plan.releaseIntervalS === 0
          ? t('plan.immediate')
          : t('plan.every', { interval: formatInterval(plan.releaseIntervalS, i18n.language) })}
      </p>
      {plan.nextUpdateAt === null ? null : (
        <p>
          <time dateTime={plan.nextUpdateAt}>
            {t('plan.next', {
              time: new Intl.DateTimeFormat(i18n.language, {
                timeZone: me.timezone,
                hour: '2-digit',
                minute: '2-digit',
              }).format(new Date(plan.nextUpdateAt)),
            })}
          </time>
        </p>
      )}
    </SettingsSection>
  );
}
