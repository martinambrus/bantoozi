/** A readable plan cadence, using the locale's unit names and plural forms. */
export function formatInterval(seconds: number, locale: string): string {
  const [unit, scale] =
    seconds % 3600 === 0
      ? (['hour', 3600] as const)
      : seconds % 60 === 0
        ? (['minute', 60] as const)
        : (['second', 1] as const);
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(
    seconds / scale,
  );
}
