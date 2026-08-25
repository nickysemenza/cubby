# Historical pre-TanStack Start tRPC performance sweep

This is the historical review ledger for the tRPC performance sweep that
preceded the TanStack Start migration. Timing and byte figures are captured
review evidence, not CI budgets; deterministic request-shape regressions
belong in tests.

## Home baseline and review table

The baseline was a production Chrome/Cloudflare trace captured before the
sweep's change with browser cache disabled. The four filtered tRPC requests
were:

| Request | Transfer | Duration |
| --- | ---: | ---: |
| `problems.getCounts` | 0.9 kB | 3.03 s |
| summary/meal/expense batch | 5.2 kB | 1.83 s |
| `location.makeTree` | 50.7 kB | 703 ms |
| location/summary/activity/meal batch | 98.1 kB | 1.84 s |
| **Total** | **154.9 kB** | **3.03 s critical tail** |

| Review signal | Before | Recorded implementation result | Preview measurement |
| --- | --- | --- | --- |
| Home critical HTTP batches | 4 filtered requests | 1 streamed batch, enforced by Playwright | Not captured in a deployed-preview trace |
| Duplicate critical query keys | tree and summary work appeared in more than one request | each compact critical procedure appeared once, enforced by Playwright | Not captured in a deployed-preview trace |
| Critical procedures | full tree, full meal rows, eight-way expense analytics, live Problem detectors | compact independent summaries plus a KV Problem-count read | N/A |
| Critical tRPC transfer | 154.9 kB | structural payload reduction enforced by output schemas | Not captured; target was at most 77.5 kB |
| Critical-data ready time | 3.03 s | no longer waited for live Problem detectors | Not captured; target was at most 2.12 s |
| Hidden Home reads | activity and collapsed dashboard/tree data were warm-prefetched | activity mounted near viewport; collapsed counts and tree stayed dormant | Request absence was enforced by Playwright |

Do not compare local seeded-data bytes or timings to the production baseline.
The final byte/time cells were not captured from a deployed preview under the
same Chrome cache and throttling settings.

## Read-classification sweep

| Surface | Read classes | Loading rule recorded after sweep |
| --- | --- | --- |
| Home | `summary` | House, Meals, Pantry, Spend, and cached Problems were eager and independently streamable; Recent Activity was proximity-mounted. |
| Entity indexes | `page`, `options` | Rendered rows stayed server-paginated/virtualized. High-cardinality filters used dormant 25-row server search instead of 500-row entity lists. |
| Project indexes | `page`, visible-row hydration, `options` | Cover hydration was limited to loaded project IDs; the project filter roster was deferred. |
| Detail views | `detail`, tab-owned relations | Above-fold owning data stayed eager. Base UI tab panels unmounted inactive panels, and dialogs gated or mounted their query owners on open. |
| Location hierarchy surfaces | `tree` | `location.makeTree` remained on arrange, gallery, inventory-session, photo-pass, and pantry-tree views; Home used `valuationSummary`. |
| Calendar | `page`, `options`, dialog-owned detail | Range data was eager, high-cardinality filters were deferred, and calendar-feed detail was disabled while its dialog was closed. |
| Imports, exports, reports, remote fan-out | `export/stream` | Existing isolated/streamed transports remained separate from ordinary reads. |

At the time, the transport policy was `httpBatchStreamLink` with `maxItems: 50`.
Ordinary summaries, pages, details, and options batched normally; only the
explicit heavy Problems detector groups retained isolated Worker invocations.
