/** The colour of a label; decorative, because the label's name always comes with it. */
export function LabelDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}
