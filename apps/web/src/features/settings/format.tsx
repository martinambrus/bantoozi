export { Time, useMoment } from '../../components/time.js';

/** A size in bytes in the unit that reads best: 512 byte, 1.5 kB, 2.5 MB. */
export function formatBytes(bytes: number, language: string): string {
  const [value, unit] =
    bytes < 1_000
      ? ([bytes, 'byte'] as const)
      : bytes < 1_000_000
        ? ([bytes / 1_000, 'kilobyte'] as const)
        : ([bytes / 1_000_000, 'megabyte'] as const);
  return new Intl.NumberFormat(language, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: unit === 'byte' ? 0 : 1,
  }).format(value);
}
