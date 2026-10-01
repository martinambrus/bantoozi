import type { BootstrapInterval } from '../metrics/index.js';

/** Markdown helpers for the reports: tables, number formats and escaping. */

export function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '_no rows_\n';
  const head = `| ${headers.map(escapeCell).join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`);
  return `${[head, sep, ...body].join('\n')}\n`;
}

/** A number with `digits` decimals, or `—` for an unmeasured (null) value. */
export function num(value: number | null | undefined, digits = 3): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toFixed(digits);
}

export function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `${(100 * value).toFixed(digits)}%`;
}

export function usd(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `$${value.toFixed(4)}`;
}

export function ci(interval: BootstrapInterval | null | undefined): string {
  if (interval === null || interval === undefined || interval.lo === null || interval.hi === null) {
    return '—';
  }
  return `[${interval.lo.toFixed(3)}, ${interval.hi.toFixed(3)}]`;
}

export function signed(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function shortId(value: string, length = 12): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
