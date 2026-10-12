# Load sanity report (spec 11 §9, M8-T8)

Profile: stress (synthetic stress, 1 list/s and 1 open or rate/s per user; criteria are reported, not gated).

> **LOCAL run on a production-like Compose stack (project `bantoozi-load`), not the target box.** CPU and memory are only reported (spec 11 §9: CPU < 70 % applies on the target box). The gated criteria are p95 `GET /api/v1/articles` < 300 ms and no queue-backlog alert.

Host: 8 CPUs, 15 GiB. Duration 60 min over four phases; 20 users x 50 feeds x 10 cards; 1000 generated feeds at 5 items per hour; fake provider 300 ms. Pools: worker query 10, feed locks 14, API 10. Measured traffic per user: 1 list/s, 0 counts/s and 1 open or rate/s.

| Phase | s | list req | p50 ms | p95 ms | 5xx | CPU avg / max % host | inference calls | distinct Qs | cache hits | reuse | backlog alert | arrivals/h | max queue depth |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all-off | 720 | 14400 | 35.2 | 81.4 | 0 | 11.2 / 35.3 | 0 | 0 | 0 | 0 | no | 4145 | feed.fetch 265, article.extract 259, user.learn 20 |
| selected-training-slow | 1080 | 21600 | 46.4 | 126.8 | 0 | 13.7 / 46.8 | 665 | 3120 | 1242 | 0.285 | no | 2743 | analysis.process 427, feed.fetch 268, article.extract 213 |
| active-feeds | 1080 | 21600 | 105 | 184.2 | 0 | 21.3 / 50.7 | 528 | 2416 | 984 | 0.289 | no | 2920 | article.extract 342, feed.fetch 254, user.learn 20 |
| provider-failing | 720 | 14400 | 123.2 | 212.2 | 0 | 24.7 / 54.6 | 88 | 0 | 0 | 0 | no | 3655 | feed.fetch 204, article.extract 153, article.enrich 134 |

## Memory high-water mark per service (MiB)

| Phase | api | load-sim | postgres | worker |
|---|---|---|---|---|
| all-off | 175 | 92 | 345 | 262 |
| selected-training-slow | 181 | 92 | 427 | 283 |
| active-feeds | 172 | 93 | 488 | 262 |
| provider-failing | 182 | 85 | 537 | 279 |

## Criteria

- p95 GET /articles < 300 ms in every phase: PASS
- no queue-backlog alert (real rule from apps/worker/src/alerts): PASS
- all-off makes zero inference calls: PASS
- reading stays available (no 5xx, p95 under limit) while the provider fails: PASS
- CPU: reported only (LOCAL run)

Articles in the database at the end: 5119. Distinct questions are article/card pairs that received an answer; cache hits are user x article x card combinations served without a new question (spec 05 shared cache).
