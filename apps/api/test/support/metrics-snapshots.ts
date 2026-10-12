import type { ApiHarness } from './harness.js';

type Owner = ApiHarness['owner'];

/** One stored `metrics.daily.<day>` value, as `house.metrics` (M8-T4) writes it. */
export interface StoredSnapshot {
  day: string;
  lanes: Record<string, { likeRate: number | null; rated: number }>;
  regret: { numerator: number; denominator: number };
}

export async function storeSnapshot(owner: Owner, snapshot: StoredSnapshot): Promise<void> {
  // Fields the overview must not forward (the 7 and 30 day windows) ride along.
  const value = {
    lanes: snapshot.lanes,
    regret: snapshot.regret,
    windows: {
      d7: { lanes: snapshot.lanes, regret: snapshot.regret },
      d30: { lanes: snapshot.lanes, regret: snapshot.regret },
    },
  };
  await owner.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [`metrics.daily.${snapshot.day}`, JSON.stringify(value)],
  );
}

export async function clearSnapshots(owner: Owner): Promise<void> {
  await owner.query("DELETE FROM settings WHERE key LIKE 'metrics.daily.%'");
}
