import type { ArticleListItem, CreateRuleBody, RuleExpiryDays } from '@bantoozi/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../api/context.js';
import { routes } from '../../api/routes.js';
import { errorMessage } from '../../components/error-message.js';
import { useToast } from '../../components/toast/toast-provider.js';
import { useAccountId } from '../../session/context.js';
import { httpUrl } from './http-url.js';
import { articleKeys } from './query-keys.js';

export interface RuleActions {
  muteStory(days: RuleExpiryDays): void;
  /** Null when the article has no feed, no usable address or no author to base the rule on. */
  blockFeed: (() => void) | null;
  blockDomain: (() => void) | null;
  blockAuthor: (() => void) | null;
  boostFeed: (() => void) | null;
}

/**
 * The "mute / block / boost" actions of an article (spec 09 §3.2, §3.5). Each creates a rule and
 * says so in a toast that takes it back with `DELETE /rules/:id`. A rule changes the ranking, so
 * the articles are reloaded after both.
 */
export function useRuleActions(item: ArticleListItem): RuleActions {
  const api = useApi();
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { i18n } = useTranslation('article');

  const reloadArticles = () => {
    void queryClient.invalidateQueries({ queryKey: articleKeys.all(accountId) });
  };
  const fail = (error: unknown) => {
    toast.show({ message: errorMessage(i18n.t, error), tone: 'error' });
  };

  async function remove(ruleId: string): Promise<void> {
    try {
      await api.call(routes.ruleDelete, { params: { id: ruleId } });
    } catch (error) {
      fail(error);
      return;
    }
    reloadArticles();
    toast.show({ message: i18n.t('article:rules.removed'), tone: 'info' });
  }

  function created(ruleId: string, message: string): void {
    reloadArticles();
    toast.show({
      message,
      tone: 'success',
      action: {
        label: i18n.t('common:actions.undo'),
        onAction: () => {
          void remove(ruleId);
        },
      },
    });
  }

  async function create(body: CreateRuleBody, message: string): Promise<void> {
    try {
      const { rule } = await api.call(routes.ruleCreate, { body });
      created(rule.id, message);
    } catch (error) {
      fail(error);
    }
  }

  async function muteStory(days: RuleExpiryDays): Promise<void> {
    try {
      const { rule } = await api.call(routes.articleMuteStory, {
        params: { id: item.id },
        body: { days },
      });
      created(rule.id, i18n.t('article:rules.mutedStory', { count: days }));
    } catch (error) {
      fail(error);
    }
  }

  const { feed } = item;
  const hostname = httpUrl(item.url)?.hostname ?? null;
  const author = item.author?.trim() ?? '';

  return {
    muteStory: (days) => void muteStory(days),
    blockFeed:
      feed === null
        ? null
        : () =>
            void create(
              { kind: 'block_feed', value: feed.id },
              i18n.t('article:rules.blockedFeed', { target: feed.title }),
            ),
    boostFeed:
      feed === null
        ? null
        : () =>
            void create(
              { kind: 'boost_feed', value: feed.id },
              i18n.t('article:rules.boostedFeed', { target: feed.title }),
            ),
    blockDomain:
      hostname === null
        ? null
        : () =>
            void create(
              { kind: 'block_domain', value: hostname },
              i18n.t('article:rules.blockedDomain', { target: hostname }),
            ),
    blockAuthor:
      author === ''
        ? null
        : () =>
            void create(
              { kind: 'block_author', value: author },
              i18n.t('article:rules.blockedAuthor', { target: author }),
            ),
  };
}
