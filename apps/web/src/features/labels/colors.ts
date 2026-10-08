/** The colour a label gets when none is chosen (D-42). */
export const DEFAULT_COLOR = '#64748b';

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** A colour as it is stored: `#rrggbb` in lower case, or null for anything else. */
export function normalizeColor(value: string): string | null {
  const color = value.trim().toLowerCase();
  return HEX_COLOR.test(color) ? color : null;
}
