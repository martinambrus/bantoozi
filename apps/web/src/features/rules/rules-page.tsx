import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { AddRuleForm } from './add-rule-form.js';
import { RuleList } from './rule-list.js';

export function RulesPage() {
  const { t } = useTranslation('rules');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusTitle = useCallback(() => titleRef.current?.focus(), []);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6">
      <header className="flex flex-col gap-2">
        <h1 ref={titleRef} tabIndex={-1} className="text-2xl font-bold">
          {t('title')}
        </h1>
        <p className="text-slate-600 dark:text-slate-300">{t('intro')}</p>
      </header>
      <RuleList onRemoved={focusTitle} />
      <AddRuleForm />
    </div>
  );
}
