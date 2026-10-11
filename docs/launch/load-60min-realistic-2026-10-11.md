# Load sanity report (spec 11 §9, M8-T8)

Profile: realistic (gated: a failed criterion fails the command).

> **LOCAL run on a production-like Compose stack (project `bantoozi-load`), not the target box.** CPU and memory are only reported (spec 11 §9: CPU < 70 % applies on the target box). The gated criteria are p95 `GET /api/v1/articles` < 300 ms and no queue-backlog alert.

Host: 8 CPUs, 15 GiB. Duration 60 min over four phases; 20 users x 50 feeds x 10 cards; 1000 generated feeds at 5 items per hour; fake provider 300 ms. Pools: worker query 10, feed locks 14, API 10. Measured traffic per user: 0.02431 list/s, 0.03222 counts/s and 0.06594 open or rate/s.

| Phase | s | list req | p50 ms | p95 ms | 5xx | CPU avg / max % host | inference calls | distinct Qs | cache hits | reuse | backlog alert | arrivals/h | max queue depth |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all-off | 720 | 330 | 10.9 | 32.4 | 0 | 3.7 / 29.4 | 0 | 0 | 0 | 0 | no | 4060 | article.extract 323, feed.fetch 288, user.learn 20 |
| selected-training-slow | 1080 | 520 | 13 | 33.5 | 0 | 3.6 / 28.6 | 731 | 3450 | 1386 | 0.287 | no | 2763 | analysis.process 472, article.extract 236, feed.fetch 234 |
| active-feeds | 1080 | 553 | 26.3 | 45.4 | 0 | 3.9 / 35 | 507 | 2314 | 936 | 0.288 | no | 2850 | feed.fetch 194, article.extract 173, user.learn 18 |
| provider-failing | 720 | 347 | 29 | 73.7 | 0 | 4.2 / 28.5 | 72 | 0 | 0 | 0 | no | 3910 | feed.fetch 243, article.extract 211, article.enrich 120 |

## Memory high-water mark per service (MiB)

| Phase | api | load-sim | postgres | worker |
|---|---|---|---|---|
| all-off | 164 | 83 | 246 | 233 |
| selected-training-slow | 168 | 90 | 284 | 253 |
| active-feeds | 170 | 100 | 323 | 243 |
| provider-failing | 179 | 102 | 312 | 288 |

## Criteria

- p95 GET /articles < 300 ms in every phase: PASS
- no queue-backlog alert (real rule from apps/worker/src/alerts): PASS
- all-off makes zero inference calls: PASS
- reading stays available (no 5xx, p95 under limit) while the provider fails: PASS
- CPU: reported only (LOCAL run)

Articles in the database at the end: 5138. Distinct questions are article/card pairs that received an answer; cache hits are user x article x card combinations served without a new question (spec 05 shared cache).
