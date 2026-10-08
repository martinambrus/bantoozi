import type { ArticleListItem, Explain } from '@bantoozi/shared';

import { QueryState } from '../../components/states/query-state.js';
import { AboutArticle } from './about-article.js';
import { Actions } from './actions.js';
import { InterestList } from './interest-list.js';
import { PersonalModel } from './personal-model.js';
import { RulesApplied } from './rules-applied.js';
import { useArticleDetail } from './use-article-detail.js';
import { NotAnalyzed, Verdict } from './verdict.js';

function Findings({ articleId, explain }: { articleId: string; explain: Explain | null }) {
  if (explain === null) return <NotAnalyzed />;
  return (
    <>
      <Verdict explain={explain} />
      <InterestList articleId={articleId} cards={explain.cards} />
      {explain.facets === undefined ? null : <AboutArticle facets={explain.facets} />}
      {explain.rules.length === 0 ? null : <RulesApplied explain={explain} />}
      {explain.model === undefined ? null : <PersonalModel model={explain.model} />}
    </>
  );
}

export interface ExplanationProps {
  item: ArticleListItem;
  sourceFeedId?: string | undefined;
  saved?: boolean | undefined;
}

/** The explanation the server stored for the article, and what the person can do about it. */
export function Explanation({ item, sourceFeedId, saved }: ExplanationProps) {
  const detail = useArticleDetail(item.id, { sourceFeedId, saved });
  return (
    <div className="flex flex-col gap-6">
      <QueryState query={detail}>
        {(loaded) => <Findings articleId={item.id} explain={loaded.explain} />}
      </QueryState>
      <Actions item={item} />
    </div>
  );
}
