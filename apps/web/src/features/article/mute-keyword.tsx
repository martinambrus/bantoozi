import type { ArticleListItem } from '@bantoozi/shared';
import { normalizeText } from '@bantoozi/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiMutation } from '../../api/mutation.js';
import { routes } from '../../api/routes.js';
import { Button } from '../../components/button.js';
import { errorMessage } from '../../components/error-message.js';
import { ChevronDownIcon, EyeOffIcon } from '../../components/icons.js';
import { Menu, MenuItem } from '../../components/menu.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useRefreshAfterRuleChange, useRules } from '../rules/use-rules.js';
import { useSession } from '../../session/context.js';
import { titleWords } from '../why/title-words.js';
import { useRuleRemoval } from '../why/use-rule-removal.js';

/** The title's words that no live keyword rule mutes yet, compared the way a keyword mute matches. */
function useOfferableWords(title: string): { words: string[]; ready: boolean; loading: boolean } {
  const rules = useRules();
  const words = useMemo(() => {
    const muted = new Set(
      (rules.data ?? [])
        .filter(
          (rule) =>
            rule.kind === 'mute_keyword' &&
            (rule.expiresAt === null || Date.parse(rule.expiresAt) > Date.now()),
        )
        .map((rule) => normalizeText(rule.value)),
    );
    return titleWords(title).filter((word) => !muted.has(normalizeText(word)));
  }, [rules.data, title]);
  // Rules that are not known are not "no rules": no word is offered as mutable until they are.
  return { words, ready: rules.data !== undefined, loading: rules.isPending };
}

/** One word of the title, chosen from a menu, becomes a muted keyword (spec 09 §3.5). */
export function MuteKeyword({
  item,
  variant = 'secondary',
}: {
  item: ArticleListItem;
  variant?: 'secondary' | 'ghost';
}) {
  const { t } = useTranslation('why');
  const { t: tArticle } = useTranslation('article');
  const toast = useToast();
  const session = useSession();
  const removal = useRuleRemoval();
  const refresh = useRefreshAfterRuleChange();
  const { words, ready, loading } = useOfferableWords(item.title);

  const create = useApiMutation(routes.ruleCreate, {
    // Each mute is confirmed here: a callback of one `mutate` call is dropped when a second mute
    // starts before the first is answered, and when the drawer closes. What is answered after the
    // sign-in that asked has ended shows nothing, and its toast takes nothing back then: the next
    // account cannot see the rule.
    onMutate: () => session.currentSignIn(),
    onSuccess: ({ rule }, variables, signIn) => {
      if (session.currentSignIn() !== signIn) return;
      refresh();
      toast.show({
        message: tArticle('reason.rule.mute_keyword', { keyword: variables.body.value }),
        tone: 'success',
        action: {
          label: t('common:actions.undo'),
          onAction: () => {
            if (session.currentSignIn() === signIn) removal.remove(rule.id, refresh);
          },
        },
      });
    },
    onError: (error, _variables, signIn) => {
      if (session.currentSignIn() !== signIn) return;
      toast.show({ message: errorMessage(t, error), tone: 'error' });
    },
  });

  if (ready && words.length === 0) return null;

  return (
    <Menu
      trigger={(props) => (
        <Button
          {...props}
          variant={variant}
          loading={create.isPending || loading}
          disabled={!ready}
        >
          <EyeOffIcon className="size-4" />
          {t('actions.muteKeyword')}
          <ChevronDownIcon className="size-4" />
        </Button>
      )}
    >
      {words.map((word) => (
        <MenuItem
          key={word}
          onSelect={() => create.mutate({ body: { kind: 'mute_keyword', value: word } })}
        >
          {word}
        </MenuItem>
      ))}
    </Menu>
  );
}
