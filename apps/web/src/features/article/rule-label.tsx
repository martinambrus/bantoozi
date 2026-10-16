const MARK = '\u0000';

/**
 * The label of a block/boost action with what it acts on, e.g. "Block author (Jane Doe)". `text`
 * translates the label with the target as `{{target}}`; a long target is cut with an ellipsis and
 * shown in full on hover, while the accessible name keeps all of it.
 */
export function RuleLabel({
  text,
  target,
}: {
  text: (values: { target: string }) => string;
  target: string;
}) {
  const [before = '', after = ''] = text({ target: MARK }).split(MARK);
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline whitespace-pre">
      {before}
      <span className="min-w-0 max-w-[24ch] truncate" title={target}>
        {target}
      </span>
      {after}
    </span>
  );
}
