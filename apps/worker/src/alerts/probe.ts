const PROBE_TIMEOUT_MS = 5_000;

/**
 * A LibreTranslate reachability probe for `house.alerts` (spec 11 §6.1 "Service health"): `GET
 * /languages` within a short timeout; any transport error or non-2xx answer is "unreachable".
 */
export function createLibreTranslateProbe(
  baseUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): () => Promise<boolean> {
  const doFetch = options.fetch ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}/languages`;
  return async () => {
    try {
      const response = await doFetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };
}
