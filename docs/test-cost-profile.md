# Web test cost profile

Read-only baseline captured on 2026-10-02 from three completed successful
`main` CI heads. This is a hotspot comparison, not a controlled optimization
experiment. All three ran 119 browser E2Es, 198 PostgreSQL files / 1,016 tests,
477 node files / 5,069 tests, and 242 UI files / 1,859 tests.

| CI run / head                                                                                                              | Elapsed to Web checks | Worker build | Browser test execution, shards 1 / 2 | PostgreSQL execution, shards 1 / 2 / 3 |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------ | ------------------------------------ | -------------------------------------- |
| [37021056927](https://github.com/nickysemenza/cubby/actions/runs/37021056927) / `73371e8e3650b2c91d0a8976ba3a6666788d47b6` | 8:34                  | 101s         | 329 / 289s                           | 78 / 75 / 97s                          |
| [36967550794](https://github.com/nickysemenza/cubby/actions/runs/36967550794) / `7ac681cd0a8f16b4dbb6e38f121e5d152c3d5f26` | 8:16                  | 99s          | 216 / 293s                           | 109 / 85 / 67s                         |
| [36961413841](https://github.com/nickysemenza/cubby/actions/runs/36961413841) / `af4cf79ab530e9ba6c6db56481a303b65b32860c` | 8:18                  | 97s          | 322 / 215s                           | 84 / 105 / 92s                         |

Durations above come from GitHub job/step timestamps. Suite logs report node
durations of 66.32 / 45.41 / 68.56s and UI durations of 38.56 / 43.35 / 53.66s.
The browser jobs determine the critical path in all three runs.

Navigation reporting records 167 page loads per run, consuming 42–46% of
cumulative test time (parallel test time is not job wall time). Median observed
hydration takes 1.76–3.35s; HTML completes in 71–114ms. Investigate navigation
before increasing runner count or changing PostgreSQL sharding.

Median slow PostgreSQL files: import-order convergence 43.19s, Problems 19.50s,
financial repo 19.04s, and financial booking/category 19.03s. The convergence
suite deliberately covers all 24 server arrival orders while browser tests
cover four orders. Preserve both boundary contracts. The socket-lifecycle E2E
takes 53.7–56.6s because it waits for real socket expiry; its delay is evidence,
not a UI readiness sleep.

Potential consolidation must retain named regressions and be measured with the
same coverage: reduce repeated generic-detail fixture/page setup (10.09s median
file time), move pure generic-list resolver/roster assertions to a node seam
(8.67s median file time), and batch the CSV-first convergence scenario's thirteen
earlier-finding fixtures through real writers. No speed gain is claimed yet.

Implemented follow-up: the 28 pure list-view selection cases now run in the
node project (`resolve-list-view.unit.test.ts`), including default/unknown view
handling and the retired Projects gallery URL. The extracted resolver imports
only manifest metadata, Zod and types. Slot-fill registration and off-roster
source hooks still run with UI coverage because their boundary includes hooks
and components. The replacement passed locally in 409ms; the browser cases
were removed afterward. A hosted before/after speed gain is not yet measured.
