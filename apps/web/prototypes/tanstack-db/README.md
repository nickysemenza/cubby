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

## Bounded loading diagnosed

The original fallback was caused by locale-sensitive string ordering. In the
pinned SDK, a string cursor must use `stringSort: "lexical"` to express a safe
server predicate. The server comparator must match that order. With lexical
ordering, the no-limit follow-up is an exact-ID boundary read, which is bounded;
the original guard incorrectly treated every no-limit read as unsafe.

`bounded-observations.json` records actual SDK reads from `on-demand.mjs`:

| Configuration                     | Loaded Tasks out of 50 | Returned rows across reads | Result                                                            |
| --------------------------------- | ---------------------: | -------------------------: | ----------------------------------------------------------------- |
| Lexical first page                |                      2 |                          3 | Two-row page plus duplicate boundary row                          |
| Locale first page                 |                      — |                          2 | Unbounded fallback refused                                        |
| Offset 40, limit 2                |                     42 |                         43 | SDK loads ordered prefix, unsuitable for constant-size deep pages |
| Cursor after row 39               |                      2 |                          3 | Bounded keyset predicate                                          |
| Same cursor with direct left join |                      2 |                          3 | Bounded Task load with Project relationship                       |

These are simulated query-function calls, not HTTP performance measurements.
Run `node on-demand.mjs --locale` to reproduce the refusal; `--offset=40`,
`--after=TSK-SYNTHETIC-39`, and `--join` expose the other configurations.
The guard refuses no-limit requests unless they contain an exact-ID predicate.
The richer model also preloads list, selected detail, and direct left-joined
Project views with `createPrototype(() => {}, { onDemand: true })`: two loaded
Tasks, three bounded requests. It uses direct-root left joins because nested
sources and inner joins can require full-source acquisition in this SDK.

The interactive page retains its bounded eager server-page projection to isolate
optimistic behavior. Neither experiment justifies replacing Cubby's locale,
relevance, null ordering, or server filtering with lexical ID ordering. A real
migration must preserve those contracts and avoid prefix-loading deep pages.

## App-wide direction

The worthwhile migration seam is the generic entity runtime, not separate Task
and Project implementations. One request-scoped set of loaded record projections
could serve generic tables, detail views and relationship labels. Existing Query
operations continue to own membership, count/sum/facet envelopes, progressive
base/enrichment reads and freshness. Collections could own shared optimistic
record values and canonical receipt reconciliation.

This is a candidate design, not an approved implementation. It must avoid keeping
two competing record stores or building a bespoke sync framework to connect them.
The SDK must replace more coordination than the adapter introduces.

The concrete pilot would connect one existing Task table and detail preview to a
schema-derived record adapter, retaining the existing progressive-read session.
It would route rename/delete through the existing generic entity command exactly
once, reconcile bounded receipts, and retain invalidation for derived fields and
unloaded data. Project assignment comes later because effective inheritance makes
it a poor first scalar example.

The first deletion target is the generic delete hook's cancel/snapshot/splice/
restore branch and accepted-value duplication in inline editors. Whole helper
files become removable only when all their callers migrate. Progressive readiness,
page membership and dependent refresh remain. Compare this against receipt-aware
Query patching before accepting the added collection lifecycle and projection
coordination. The source audit found no defensible app-wide net saving yet.

`schema-audit.mjs` reads actual Cubby Task schemas: list and detail share all detail
fields; only the list adds `displayImages`. That makes Task a plausible pilot,
but progressive base responses remain partial. Missing fields must not erase
loaded detail fields, and inherited/resolved projections remain server-owned.
Public detail also carries media, attachment and redirect metadata beyond raw
`taskOut`. Matching field names alone do not establish merge or freshness semantics.

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

The loading fallback is diagnosed; generic integration is the remaining question.
Compare one Task/Project workflow through actual schema-derived projections and
entity commands against a Query-only alternative. Establish canonical receipt,
partial/enriched projection and read/write ordering contracts before production
adoption. Measure deleted helpers against new adapters; verify compiled Start
hydration and native/background freshness. No production saving follows from the
synthetic model. Financial writes, offline queues, new sync services and database
changes remain outside the experiment.

Primary API references:

- <https://tanstack.com/db/latest/docs/collections/query-collection>
- <https://tanstack.com/db/latest/docs/guides/live-queries>
- <https://tanstack.com/db/latest/docs/guides/mutations>
