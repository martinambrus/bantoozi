# Learning curve golden-v3 (2026-10-10)

Dataset golden-v3, run 28 (E1), sizes 10, 20, 30, 50, 100.
The personal model is trained on the first n development ratings of each rater in arrival order and
evaluated on the same untouched test ratings for every n; cards-only is the cards score of spec 06 §4.1.
Research mode marks a size below the production minimums.

No threshold change needed. At n = 50 the model did not beat cards-only for 0 of 1 raters.

| rater | n | train n | pos/neg | skipped | test n | test pos/neg | mode | activation | cards AUC | model AUC | ΔAUC | cards logloss | model logloss | own inputs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 10 | 10 | 8/2 | - | 141 | 61/80 | research | insufficient_explicit,insufficient_class | 0.709 | 0.654 | -0.055 | 1.078 | 1.024 | - |
| 3 | 20 | 20 | 12/8 | - | 141 | 61/80 | research | insufficient_explicit | 0.709 | 0.651 | -0.059 | 1.078 | 0.993 | - |
| 3 | 30 | 30 | 19/11 | - | 141 | 61/80 | production | - | 0.709 | 0.682 | -0.027 | 1.078 | 0.919 | - |
| 3 | 50 | 50 | 28/22 | - | 141 | 61/80 | production | low_auc,below_baseline_auc | 0.709 | 0.717 | +0.008 | 1.078 | 0.752 | - |
| 3 | 100 | 100 | 51/49 | - | 141 | 61/80 | production | below_baseline_auc | 0.709 | 0.720 | +0.011 | 1.078 | 0.671 | 177 |
