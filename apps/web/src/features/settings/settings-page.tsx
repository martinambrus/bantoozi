import { useTranslation } from 'react-i18next';

import { OfflineSection } from '../offline/offline-section.js';
import { DeleteAccountSection } from './delete-account-section.js';
import { ExportSection } from './export-section.js';
import { InvitesSection } from './invites-section.js';
import { PreferencesSection } from './preferences-section.js';
import { ProfileSection } from './profile-section.js';
import { SessionsSection } from './sessions-section.js';

export function SettingsPage() {
  const { t } = useTranslation('settings');
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <ProfileSection />
      <PreferencesSection />
      <OfflineSection />
      <SessionsSection />
      <InvitesSection />
      <ExportSection />
      <DeleteAccountSection />
    </div>
  );
}
