import type { LibraryCandidate } from '@bantoozi/shared';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { eligibilityKey } from './library-eligibility.js';
import { isStatus } from './use-admin.js';

export interface PromoteDialogProps {
  candidate: LibraryCandidate;
  onClose: () => void;
  /** The card was published. */
  onPromoted: () => void;
  /** The server refused because the eligibility moved: the screen reads the lists again. */
  onConflict: () => void;
}

/**
 * Spec 09 §8: the confirmation names the basis the administrator is acting on. Inactivity is
 * worded as the administrator's decision, never as the creator's approval.
 */
export function PromoteDialog({ candidate, onClose, onPromoted, onConflict }: PromoteDialogProps) {
  const { t } = useTranslation('admin');
  const toast = useToast();
  const promote = useApiMutation(routes.adminLibraryPromote);
  const { request } = candidate;
  const approved = eligibilityKey(candidate.promotionEligibility) === 'approved';

  async function confirm() {
    if (request === null) return;
    try {
      const result = await promote.mutateAsync({
        body: { requestId: request.id, expectedVersion: request.version },
      });
      toast.show({
        message: t('library.promote.done', {
          title: candidate.title,
          basis: t(`library.basis.${result.authorizationKind}`),
        }),
        tone: 'success',
      });
      onPromoted();
    } catch (error) {
      if (!isStatus(error, 409)) throw error;
      onConflict();
    }
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={confirm}
      title={t('library.promote.title', { title: candidate.title })}
      body={
        <div className="flex flex-col gap-2">
          <p className="font-medium text-slate-900 dark:text-slate-100">
            {t(
              approved
                ? 'library.eligibility.approved.label'
                : 'library.eligibility.inactive.label',
            )}
          </p>
          <p>{t(approved ? 'library.promote.bodyApproved' : 'library.promote.bodyInactive')}</p>
        </div>
      }
      confirmLabel={t(
        approved ? 'library.promote.confirmApproved' : 'library.promote.confirmInactive',
      )}
    />
  );
}
