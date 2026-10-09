import type { ArticleListItem } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { ChevronDownIcon, EyeOffIcon, PlusIcon } from '../../components/icons.js';
import { Menu, MenuItem } from '../../components/menu.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId } from '../../session/context.js';
import { articleKeys } from '../article/query-keys.js';
import { useRuleActions } from '../article/use-rule-actions.js';
import { CardEditor } from '../interests/card-editor.js';
import { Section } from './section.js';
import { titleWords } from './title-words.js';
import { useRuleRemoval } from './use-rule-removal.js';

/** One word of the title, chosen from a menu, becomes a muted keyword (spec 09 §3.5). */
function MuteKeyword({ words }: { words: string[] }) {
  const { t } = useTranslation('why');
  const { t: tArticle } = useTranslation('article');
  const toast = useToast();
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const removal = useRuleRemoval();

  const create = useApiMutation(routes.ruleCreate, {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
    },
    onError: (error) => {
      toast.show({ message: errorMessage(t, error), tone: 'error' });
    },
  });

  const mute = (keyword: string) => {
    create.mutate(
      { body: { kind: 'mute_keyword', value: keyword } },
      {
        onSuccess: ({ rule }) => {
          toast.show({
            message: tArticle('reason.rule.mute_keyword', { keyword }),
            tone: 'success',
            action: { label: t('common:actions.undo'), onAction: () => removal.remove(rule.id) },
          });
        },
      },
    );
  };

  return (
    <Menu
      trigger={(props) => (
        <Button {...props} variant="secondary">
          <EyeOffIcon className="size-4" />
          {t('actions.muteKeyword')}
          <ChevronDownIcon className="size-4" />
        </Button>
      )}
    >
      {words.map((word) => (
        <MenuItem key={word} onSelect={() => mute(word)}>
          {word}
        </MenuItem>
      ))}
    </Menu>
  );
}

/** What the person can do about the article from here: a card, a source, an author, a keyword. */
export function Actions({ item }: { item: ArticleListItem }) {
  const { t } = useTranslation('why');
  const { t: tArticle } = useTranslation('article');
  const rules = useRuleActions(item);
  const [makingCard, setMakingCard] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const words = titleWords(item.title);
  const sourceActions = [
    { label: tArticle('detail.boostFeed'), run: rules.boostFeed },
    { label: tArticle('detail.blockFeed'), run: rules.blockFeed },
    { label: tArticle('detail.blockAuthor'), run: rules.blockAuthor },
  ].flatMap(({ label, run }) => (run === null ? [] : [{ label, run }]));

  return (
    <Section title={t('actions.heading')}>
      <div ref={actionsRef} tabIndex={-1} className="flex flex-wrap gap-2 outline-none">
        <Button variant="secondary" onClick={() => setMakingCard(true)}>
          <PlusIcon className="size-4" />
          {t('actions.makeCard')}
        </Button>
        {sourceActions.map(({ label, run }) => (
          <Button key={label} variant="secondary" onClick={run}>
            {label}
          </Button>
        ))}
        {words.length === 0 ? null : <MuteKeyword words={words} />}
      </div>
      {makingCard ? (
        <CardEditor
          fromArticle={{ id: item.id, title: item.title }}
          returnFocus={() => actionsRef.current}
          onClose={() => setMakingCard(false)}
        />
      ) : null}
    </Section>
  );
}
