# Disposable TanStack DB prototype

Question: can Cubby replace cache snapshot/patch/restore coordination with shared
collections while preserving bounded server reads and canonical mutations?

**Verdict: promising optimistic state, but do not adopt app-wide yet.** This
prototype answers the collection-state part. It does not establish a production
migration or a net deletion. Captured for Cubby issue #2948 on a throwaway branch.

## Run

From the repository root:

```sh
pnpm --dir apps/web/prototypes/tanstack-db install --frozen-lockfile
pnpm --dir apps/web/prototypes/tanstack-db build
pnpm --dir apps/web/prototypes/tanstack-db probe
pnpm --dir apps/web/prototypes/tanstack-db on-demand
```

Open `public/index.html` directly. It is self-contained: the real, pinned SDK is
embedded, with no CDN or server dependency. Build-time esbuild bundles the actual
packages; the resulting demo itself needs no bundler or server. All persistence
is synthetic and in memory. Resetting this page discards only its own fixture
state. No household database, production dependencies, application routes, or
production operations are changed.

Pinned packages: `@tanstack/db` 0.15.2, `@tanstack/query-db-collection` 1.4.8,
`@tanstack/query-core` 5.90.15. These are pre-1.0 DB APIs.

## Observed behavior

- A rename appears in the loaded list, selected detail and Project relationship
  immediately. A canonical receipt trims the synthetic name and advances its
  fixture revision without another Task read.
- Rejecting a deletion after a different Task's successful edit restores the
  deleted Task and preserves the successful sibling value. No manual cache
  snapshots or rollback patches are used.
- A move updates the join over loaded rows immediately. The join is explicitly
  not complete Project membership or a Project-wide count.
- Overlapping same-Task writes converge after settlement. However, accepting the
  newer write while its predecessor remains pending temporarily reveals the
  older optimistic value. DB does not choose the desired UX ordering for us.
- The successful page experiment loads 2 of 50 synthetic Tasks in one simulated
  read (169 JSON payload bytes). These are fixture/query-function observations,
  not HTTP latency, SQL, React-render or production performance measurements.
- Accepted deletion leaves a one-row page. Explicit bounded refetch loads its
  replacement; automatic optimistic state does not establish page membership.
- A synthetic background write stays invisible until explicit refresh.
- JSON-round-tripping Query dehydration into a second request-local QueryClient
  restores the page with zero Task reads. An optimistic change in the first
  instance does not leak into the second. This is Query-cache hydration evidence,
  not compiled Start SSR/hydration verification.

## Bounded loading remains unresolved

`on-demand.mjs` is a separate minimal reproduction using the real SDK. A direct
ordered live query with `limit(2)` first requests two rows, then requests a subset
without a limit or predicate. The fake server refuses the latter. This was also
observed in the original richer collection composition. The reproduction uses
built-in Query key derivation and automatic B-tree indexes, so it does not depend
on the prototype's own query-key serialization.

This does not prove every bounded DB integration fails. It establishes that this
configuration does not meet Cubby's no-load-everything rule and needs diagnosis
before adoption. The interactive page uses an explicitly bounded server-page
projection in eager mode to explore optimistic behavior independently. A page
projection is not a proposal to normalize full detail records from partial rows,
create a collection for every filter, or replace server filtering with a local
query.

## Deletion ledger

Actual production deletion: **zero**. There is no parallel production path.

| Existing owner                                                  | Possible deletion after a real migration                                       | Must remain / limitation                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `src/entity/hooks/use-optimistic-delete.tsx`                    | Snapshot, cancel, splice and restore orchestration around `onMutate`/`onError` | Confirmation, impact preview, selection, bulk outcomes, diagnostics and command ownership |
| `src/entity/hooks/optimistic-list.ts` (169 lines at inspection) | List-envelope walking for migrated callers                                     | Other callers still need it; do not count the whole file for one Task flow                |
| `src/integrations/tanstack-query/operation-cache.ts` (76 lines) | Snapshot/restore calls for migrated optimistic rows                            | Tag invalidation and freshness still serve server-derived and external changes            |
| `src/entity/table/editable-cell.tsx`                            | Accepted optimistic display duplication for migrated fields                    | Drafts, focus, validation and retry state                                                 |

The prototype adds collection configuration, canonical receipt handlers, query
scope/index choices and a bounded loading adapter. Its synthetic persistence/UI
are experiment scaffolding, not production cost or savings. No defensible net
line reduction is established.

## Next decision

Resolve the minimal on-demand fallback first. Then, if it can stay bounded, port
one existing Task list/detail workflow through Cubby's actual generic entity
commands and schema-derived projections. Measure deleted helpers against new
adapters, preserve inherited/resolved fields and raw diagnostics, and verify
compiled Start hydration plus native/background freshness. Do not infer those
results from this synthetic four-field model. Financial writes, offline queues,
new sync services and database changes remain outside the experiment.

Primary API references:

- <https://tanstack.com/db/latest/docs/collections/query-collection>
- <https://tanstack.com/db/latest/docs/guides/live-queries>
- <https://tanstack.com/db/latest/docs/guides/mutations>
