/** UTC+14 without daylight saving: far from the zone of any machine that runs the tests. */
export const FAR_ZONE = 'Pacific/Kiritimati';

/** A moment as the app prints it (medium date, short time) in `timeZone`, or in this device's zone. */
export function printed(iso: string, timeZone?: string, language = 'en'): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(iso));
}
