# App-wide tRPC performance sweep

This is the review ledger for the performance sweep. Timing and byte figures
are review evidence, not CI budgets; deterministic request-shape regressions
belong in tests.

## Home baseline and review table

The baseline is the production Chrome/Cloudflare trace captured before this
change with browser cache disabled. The four filtered tRPC requests were:

| Request | Transfer | Duration |
| --- | ---: | ---: |
| `problems.getCounts` | 0.9 kB | 3.03 s |
| summary/meal/expense batch | 5.2 kB | 1.83 s |
| `location.makeTree` | 50.7 kB | 703 ms |
| location/summary/activity/meal batch | 98.1 kB | 1.84 s |
| **Total** | **154.9 kB** | **3.03 s critical tail** |

| Review signal | Before | After implementation | Preview measurement |
| --- | --- | --- | --- |
| Home critical HTTP batches | 4 filtered requests | 1 streamed batch, enforced by Playwright | Pending deployed-preview trace |
| Duplicate critical query keys | tree and summary work appeared in more than one request | each compact critical procedure appears once, enforced by Playwright | Pending deployed-preview trace |
| Critical procedures | full tree, full meal rows, eight-way expense analytics, live Problem detectors | compact independent summaries plus a KV Problem-count read | N/A |
| Critical tRPC transfer | 154.9 kB | structural payload reduction enforced by output schemas | Pending; target at most 77.5 kB |
| Critical-data ready time | 3.03 s | no longer waits for live Problem detectors | Pending; target at most 2.12 s |
| Hidden Home reads | activity and collapsed dashboard/tree data were warm-prefetched | activity mounts near viewport; collapsed counts and tree stay dormant | Request absence enforced by Playwright |

Do not compare local seeded-data bytes or timings to the production baseline.
Capture the final byte/time cells from the deployed preview under the same
Chrome cache and throttling settings.

## Read-classification sweep

| Surface | Read classes | Loading rule after sweep |
| --- | --- | --- |
| Home | `summary` | House, Meals, Pantry, Spend, and cached Problems are eager and independently streamable; Recent Activity is proximity-mounted. |
| Entity indexes | `page`, `options` | Rendered rows stay server-paginated/virtualized. High-cardinality filters use dormant 25-row server search instead of 500-row entity lists. |
| Project indexes | `page`, visible-row hydration, `options` | Cover hydration is limited to loaded project IDs; the project filter roster is deferred. |
| Detail views | `detail`, tab-owned relations | Above-fold owning data stays eager. Base UI tab panels unmount inactive panels, and dialogs gate or mount their query owners on open. |
| Location hierarchy surfaces | `tree` | `location.makeTree` remains on arrange, gallery, inventory-session, photo-pass, and pantry-tree views; Home uses `valuationSummary`. |
| Calendar | `page`, `options`, dialog-owned detail | Range data is eager, high-cardinality filters are deferred, and calendar-feed detail is disabled while its dialog is closed. |
| Imports, exports, reports, remote fan-out | `export/stream` | Existing isolated/streamed transports remain separate from ordinary reads. |

The transport policy remains `httpBatchStreamLink` with `maxItems: 50`.
Ordinary summaries, pages, details, and options batch normally; only the
explicit heavy Problems detector groups retain isolated Worker invocations.
