# Web runtime rules

This file owns React hooks, queries and mutations, the operation transport,
SSR and hydration, code splitting, browser caching, change notifications and
list loading. [Web UI contracts](web-ui.md) own component choice and
[DESIGN.md](../DESIGN.md) owns appearance. Server read contracts live in
[entity list reads](../../../docs/entities.md#list-reads).

## React hooks: preventing infinite render loops

Keep semantically unchanged hook inputs referentially stable. A recreated
configuration object can rerun effects or rebuild cell renderers, losing an
open editor or causing a render loop.

- Never pass fresh inline objects, arrays or functions to a hook dependency
  contract. Use a module constant when the value carries no component state,
  otherwise `useMemo` with semantic dependencies or the established helper.
- Hook-result defaults use module-level constants. `const { data = [] } =
  useQuery(...)` allocates a new array on every render while the query is
  loading or disabled; any downstream effect that sets state then loops. The
  bug hides in tests where every query has data, because structural sharing
  keeps real results stable. Review defaults for `= []`, `= {}` and
  `= new X(...)`.

  ```typescript
  const NO_TAGS: string[] = [];
  const { data: tags = NO_TAGS } = useQuery(
    api.recipe.getAllTags.queryOptions(),
  );
  ```

- `useQueries` returns a new array on every render, so it always uses
  `combine`, which applies structural sharing. Deriving from the raw array,
  even in `useMemo`, is unstable.

  ```typescript
  const { data, isLoading } = useQueries({
    queries: queryOptions,
    combine: (results) => ({
      data: results.map((r) => r.data).filter((d) => d != null),
      isLoading: results.some((r) => r.isLoading),
    }),
  });
  ```

- Generated CRUD lists pass `deletable: true` to `useEntityList`. A custom
  delete transport uses `useDeletableConfig` with a stable mutation factory;
  calling `entityMutationOptionsFactory(...)` in render defeats its memoization.
  Roster delete configuration stays stable while enrichment arrives, preserving
  mounted cell editors and dialogs.
- Router subscriptions select the scalar or derived value a component consumes;
  only components that consume the whole dynamic search state subscribe to it.
  Do not enable global structural sharing just to narrow a subscription.
- Picker option rosters and Base UI label/equality functions stay stable across
  form rerenders; memoize a mounted control's scoped enum options and search
  projections.

## Queries and mutations

Prefer the existing mutation, query-key, clipboard, form-field, database, merge
and shortcode helpers over hand-rolled equivalents
([generic paths](../../../docs/agents/generic-paths.md) catalogs them). Do not
convert every raw mutation to `useActionMutation`: it has static invalidation
and toast semantics. A raw mutation is correct for shared multi-mutation
invalidation, conditional query keys, caller-owned error UI, or
variables-driven local state. `noUncheckedIndexedAccess` is on: guard a possibly
absent array, record or map entry instead of asserting it away.

**Cache ownership.** Entity list and detail cache profiles, and every mutation's
invalidation ripple including input-dependent ripples, are declared in
`integrations/tanstack-query/cache-tags.ts`. Catalog query options validate
input before `enabled` is evaluated; construct a child query only for roots its
identifier contract accepts. Read errors surface through the normal error
boundary; an ingredient mapping preview error is never an empty mapping graph.

**Passive reads.** Queries stay passive on ordinary remount, but invalidated
queries refetch when reactivated, and detail loaders fetch invalidated records
before returning them. A detail route loader keeps a query observer while it
awaits a shared record read, so closing an inspector cannot cancel the incoming
route's request.

**Mutation inputs.** A mutation function never reads changing selection state
from its closure: observer options can lag the render that enabled the action.
Pass the displayed selection as mutation variables at the action boundary.
Resolve table selection updaters at the event boundary against live rows, never
in a deferred React state replay after optimistic removal. A successful bulk
action clears only the row IDs it was given; a selection made while its write
or refetch is pending survives.

**Pending state.** Equivalent controls for one record share pending state
through the mutation cache, filtered by operation and validated record identity,
and check the live cache again at submission. Request pending state stays
separate from accepted background work and readiness polling; other records stay
usable and a failed request allows retry.

**Receipts.** Ordinary saves finish at the validated server receipt. The root
mutation cache retires older reads, publishes confirmed compatible scalar fields
into existing projections, evicts inactive baselines, then refreshes active
views independently. Do not await a broad refresh in an editor or duplicate
command invalidation in a presentation wrapper. A refresh failure preserves the
accepted write and offers read retry, never write retry. Create-from-picker
dialogs resolve the pending choice synchronously from the receipt's identity and
title; they never require a full detail schema from a mutation response.

**Workflow commands.** Ordinary workflow commands execute through the generated
operation catalog with its mutation metadata and optional scope. When a command
patches a saved snapshot, synchronous `onResult` receipt work runs before catalog
invalidation; asynchronous follow-up failures are reported separately from the
accepted command. Keep a serialization scope only on a transport-owning mutation
whose workflow requires it; a presentation wrapper awaiting that command must not
acquire the same scope. Ordinary entity commands share neither a global nor an
entity-wide scope. Review outcomes and completion callbacks belong to the
submitting view visit: capture its identity before dispatch and compare it on
completion, because a query key cannot distinguish leaving and returning.
Authorized writes still complete their cache invalidation.

## Operation transport

Browser, Apple, CLI and API-key clients call operations through
`POST /api/operations/{operationId}` with plain JSON. The browser reaches every
query, mutation and workflow stream; other clients reach only capability and
view operations, and MCP only capability operations. Use `view` for operations
Apple or the CLI call that should stay off MCP; `internal` operations are the
web UI's own and are absent from the generated Swift and CLI catalog. The
request envelope is `{operation, input?}`; a success is `{ok: true, data}`,
including `data: null` for a nullable output. Errors return the public
`ApiError` body with an HTTP status derived from its code; the browser
transport turns a non-2xx bare error into `{ok: false, error}`. Query batches
use `batch~` operation paths and stream one `{i, r}` result per item as NDJSON
with HTTP 200. URLs contain registered operation names, never input values.
Dates cross as ISO strings and each operation's schemas restore them; generic
entity reads parse through their entity's lazily loaded read schema. The
envelope is validated once per path, and a client-side schema rejection
surfaces as an `OperationError`.

`dispatchOperation` in
`apps/web/src/server/operation-runtime/operation-dispatch.server.ts` is the one
entry for the HTTP route, SSR (which calls the route in process) and MCP; the
Worker routes operation paths to it without loading the React server handler.
It resolves the id under the principal's channel: browser principals reach
internal operations and streams, MCP and system principals internal queries and
mutations, native and CLI principals only external ones. It measures
selected-handler loading in `start.dispatch.load.<operation>` before the
execution span; include that load and Worker startup when attributing cold
latency. The operation boundary chooses the read policy before invoking its
handler ([read consistency](#read-consistency)).

`authenticate(request, policy)` in `apps/web/src/server/http/authenticate.ts` is
the single authentication step. The operation route accepts API keys, bearer
tokens and session cookies. A cookie request with a `Cookie` header must be
same-origin for POST; bearer and API-key requests are exempt. A request with
`x-cubby-surface: browser` authenticates under the browser policy, so it audits
as `web` and accepts no API key; other requests audit as `api`. The runner owns
input/output validation and the Apple compatibility gate. An outdated
`cubby-apple` build can read, but its writes receive HTTP 426 with
`UPGRADE_REQUIRED` before operation input parsing; a changed read response can
still break an old build.

The MCP adapter remains at `/api/mcp` as an OAuth 2.1 resource server; its
generated tools come from capability operations ([MCP](../../../docs/agents/mcp.md)).
The doorbell at `/api/doorbell` has two topics: `household.changed` and
`imageProcessing.work`. A ring only signals that state may have changed;
clients read the source of truth through ordinary operations. The Worker edge
authenticates the WebSocket upgrade, while the Durable Object socket half owns
subscriber delivery without importing Auth or PostgreSQL. OAuth, Better-Auth
endpoints, webhooks, signed uploads and calendar feeds keep their
protocol-specific routes and payloads.

`pnpm generate` emits the operation registry and Apple models, operation
methods and catalog from capability and view members. Inputs and outputs use
the JSON projection in `apps/web/src/lib/operation-wire.ts`; unsupported wire
shapes fail generation unless the contract states an exclusion. E2E helpers in
`apps/web/tests/e2e/support/entity-api.ts` send the same operation envelope.

Workflow streams POST to the same endpoint and answer with NDJSON result lines
ending in a data-less success line that carries the read marker; a body without
it is treated as cut off. The owning screen opens the stream explicitly with an
`AbortSignal`, producers observe the request signal, and early iterator return
cancels the request. Shared result envelopes retain normalized diagnostics.
Cookbook import stays busy until its recipe stream and photo phase both finish,
handing recipe progress to photo progress atomically; a reattached EPUB must not
feed an unfinished automatic photo pass or bypass a failed photo's Retry.

Browser query requests share one admission budget across batches, header groups,
singleton reads and batch fallbacks, owned by
`integrations/tanstack-query/browser-operation-transport.ts`. Cancellation stops
queued requests. The transport does not retry a settled failure; an item a batch
could not answer (HTTP failure, broken or truncated stream) is resent alone and
answered siblings are not replayed. Keep passive mount/focus/reconnect defaults
separate from recovery of an active read. Reads partitioned to fit a Worker
invocation budget pass `{ batch: false }`, as does a route-primary list
preload's first page so first render cannot delay its batch flush; the preload
keeps the mounted list's canonical query key. Opted-out reads keep shared
admission and cancellation but gain no priority. The budget bounds HTTP requests,
not origin database connections: a server batch runs several operations on its
request-scoped pool.

## SSR and hydration

The server render dispatches operations in process through the same
`/api/operations` handler, never an HTTP request to itself, and decodes the
response as the browser does. Keep `~/server` imports behind the `.server()`
branch of an isomorphic function. `ssr: false` is a measured cost choice, not a
correctness workaround; a loader may await `ensureQueryData` when the latency is
warranted. Query dehydration uses Start's native serializer for Dates,
collections and shared references; do not add another JSON codec.

**Streaming first-screen reads.** TanStack Start's SSR query stream lands in the
client cache before React hydrates. First-screen protected reads inherit the
root route's server session guard and use `useSuspenseQuery` /
`useSuspenseInfiniteQuery` inside independent `QuerySection` boundaries. Home
starts its shared reads concurrently in its loader without awaiting the
dashboard. Needs you, What changed, Meals, the key-number strip, detail summary
cells and the first declared relation stream their real data; do not add
client-session or hydration gates to them. Later sections use `VisibleContent`
for one-shot viewport admission and stay mounted afterwards. Declared Work slots
and retained record suggestions mount with the record so review actions and deep
links work before scrolling. Handwritten generic list routes use the same
metadata admission and first-page loader as generated routes.

**Hydration geometry.** Summary disclosure follows declarations through the first
hydration render: non-field context after the first four slots starts folded.
Only after that boundary hydrates may cached report or connection results change
which cells fold, disappear or show an error. Adding or removing a Suspense
boundary from streamed data during the first render discards the server tree.

**Hydration gates.** Interaction-only authenticated reads can use
`useHydrated() && session`; passive loading branches use `useHydratedLoading` or
`useHydrated`. Interactive controls in streamed sections and lazy detail slots stay disabled until their own `useHydrated()` is true; shell
hydration does not prove their handlers are attached.

**Routing.** Protected routes are gated server-side at the root route
(`getGuardSession`) before protected markup ships; a client-only guard is
bypassable. `parseSearch` JSON-parses URL params, so a search field that must
stay a string uses `urlStringParam`. A child route under a detail route without
`<Outlet/>` renders invisibly; un-nest it with a trailing-underscore segment
(`$shortcode_.export`).

## Code splitting and lazy loading

Client chunking is Rolldown `codeSplitting.groups` in `vite.config.ts`. Never
group `@base-ui` or do a naive vendor split: it drags lazy-route code into first
paint. Keep schema modules on the default graph; entry-aware schema grouping
broke Product startup. A successful build does not prove client initialization,
so verify real authenticated navigation when changing chunk boundaries. Route
loaders split through TanStack Router's `defaultBehavior` alongside components.

- Detail and list slot fills stay `lazy` in `detail-slots.tsx` and
  `list-slots.ts`: every generic list route shares one closure, so one static
  slot import ships to every list. The generated route component imports only
  its own override; the generic list never imports an all-entity column
  registry. Shared cells live with their generic feature (the unit-mappings
  column in `features/units`), not in a specialist list module. Specialist list
  columns are declared as `route.listColumns` source references.
- List page factories (`list-page.tsx`) stay separate from detail factories
  (`detail-page.tsx`). Bind each factory result to a module-level constant in a
  splittable property of the route's literal options; loader helpers stay
  React-free in `detail-loader.ts`.
- Interaction-only registry dialogs stay lazy with a local Suspense boundary
  inside their open state; loading one must not suspend the action host or page.
  Feature installation stays synchronous and idempotent.
- The account menu and the default row inspector load from an effect behind
  their existing placeholder, reuse the loaded component on remount and rethrow
  import failures to the host error boundary. Do not put a new Suspense
  fallback in the shell or around the inspector's loading panel: React's retry
  throttle delays independent boundaries. Row intent warms the inspector code
  with the existing detail prefetch, and an open inspector owns its prefetched
  read so hover-out cannot cancel it. Custom inspectors and phone navigation do
  not preload it.
- The generic edit dialog owns the loading boundary for its heavy content;
  opening starts the content import and entity metadata together, and closed
  dialogs load nothing. The generic editor and date-cell inputs stay eager so
  opening is fast and typing-to-edit keeps every keystroke.
- The JSON viewer uses `browserOnlyLazy`; timeline renderers are lazy;
  exception notes load Markdown only when shown. `AuthUIProvider` wraps only the
  `/auth/*` views; ordinary session reads use `authClient.useSession()`.
- Resolve the page toolbar's header portal target in a layout effect before
  paint; moving the fallback later remounts it and discards a search draft.

**Preload lists.** Client dynamic-import preload lists omit JavaScript already in
every entry's static closure; HTML and CSS preloads stay. The filter policy is
part of chunk hashes, so changing it cannot reuse an immutable asset URL.
Deployment preload recovery schedules a bounded reload but leaves Vite's preload
error uncancelled; preventing that event makes the import resolve `undefined`.
Keep the original rejection, cooldown, offline guard and navigation
cancellation, and record the decision in a `preload.recovery` breadcrumb before
the error is captured. Denied session storage declines recovery without
breaking router setup.

## Entity metadata transport

Entity route `beforeLoad` awaits `ensureEntityMetadata(queryClient, entity)`
before list-filter compilation or rendering. The server returns the requested
entity slice and its directly declared relation/reference dependencies, each
validated and frozen, in one local loader read; dependencies are not traversed
transitively. A document's QueryClient owns the admitted bundles and accessors
take that explicit scope. There are no global installed models, caches or
proxies.

The app's wrapper around TanStack's SSR Query integration replaces metadata
query data with its admission identity in initial state, streamed batches and
pending promises. The browser rebuilds each bundle from lazy chunks of the same
generated slices (`entity/metadata-loader.ts`) and awaits that before passing
data to Query: the router hydrate hook awaits initial admission and the stream
transform awaits later admissions before TanStack hydrates each batch. Never use
async Query `deserializeData`; its data would be a Promise. TanStack keeps stream
consumption, errors, cancellation and cleanup. A failed metadata import errors
only its own Query.

The lean generated roster lists each entity's direct dependencies, so admission
starts the primary and dependency chunks together without loading the catalog.
Browser navigation and dynamic admissions use the same chunks with no metadata
RPC. Loading a module does not admit it: a dependency slice alone does not make
its own dependencies available, and synchronous reads consult only bundles
already admitted to the QueryClient.

- The shell uses only the generated names/icons/routes/capabilities roster.
  Key-only iteration uses `entityKeys` from `entity-roster`; importing
  `allEntities` from the full manifest retains the whole catalog.
- Filter descriptors compile once per admitted slice from frozen declaration
  data only, never session, actor or request state. `getEntityFilters` adapts
  `filterDescriptors` and never imports universal filter bindings or exact
  filter-schema maps. `viewsForEntity(queryClient, entity)` adapts one entity's
  saved views; Home uses the generated home-pin roster.
- Dynamic pickers, previews, graph nodes and dialogs admit their requested slice
  locally before rendering. Calendar loads its declared source slices.
- Rendering a derived-count link, a relation header label or an inventory cell
  must not admit the target's metadata: the source slice's compiled relation
  plan and the lightweight roster already own those facts, and the extra
  suspension escapes the table body's boundary.
- Import pure relationship helpers from `connected-view-definitions`, not the
  `connected-views` catalog, which loads every entity's manifest.
- Editors resolve their definition from the explicit QueryClient. Slices carry
  compiler-owned `createDefaults` and `structuredSchemas`; server validation
  applies the exact Zod contract asynchronously. Enum option rosters have no
  global cache.
- Suggestions, editor basis helpers and Why-this-value source fields read an
  admitted slice. Metadata-dependent suggestion identity and review policy stay
  server-owned in `field-suggestion-policy`.
- Browser list/detail contracts validate lightweight wire plans and import
  output types only; full entity schemas, aggregate schema catalogs and metadata
  catalogs stay out of the browser and hot Worker ingress. A dynamic import in
  source is not emitted-bundle evidence. Aggregate Problems declarations and
  technical schema surfaces stay server-owned behind local query boundaries.

## Confirmed edit state

Query owns server records across lists, detail and inspector views.
`receipt-reconciliation.ts` consumes complete mutation receipts before adapters
narrow their results. Only declared fields with matching stored/read
representations patch existing records. Inline reference and inherited edits
fetch one authoritative detail projection before releasing their editor,
following replacement reads if another write cancels the first; a read failure
is reported separately from the accepted write. Confirmed deletes and merged-away
identities retire centrally. Never seed full detail from a partial receipt or
keep a second committed value in a cell.

Editors show Saving… until acceptance. Offline writes reject without queuing;
overlapping writes to one record reject while other records stay usable. Draft
and failed-write retry state stay local. Collection and inherited-value editors
load an authoritative baseline on reopening when their cache was retired or
invalidated; field-scoped correction editors keep their reviewed projection. A
paused or offline read cannot satisfy a fresh-baseline gate. Settlement matching
starts each visit from a fresh candidate read with no retained selection or
draft. Receiving dialogs reuse the Product label already on the parent, but
stock, photo matches and allowed plans come from `receivingContext` on every
open with zero stale time.

Loaded views keep their data during same-scope reconciliation. Lists, inspectors
and detail pages show delayed Updating feedback in a reserved status line; the
shell keeps aggregate Syncing feedback; refresh failures and Retry stay inline.
Server reads own membership, ordering, counts and paging, so a saved row may
briefly keep its old position. Do not append offset pages while the list is
reconciling or its refresh failed.

Clipboard paste prepares every changed field before issuing one update per row.
Invalid rows write nothing, successful sibling rows stay saved, errors keep row
and field context, and retry targets only failed rows. Multi-field rows without
a shared atomic row writer reject before dispatch.

## Read consistency

Ordinary browser display operations use `HYPERDRIVE_CACHED`: at most 60 seconds
of cached data plus 15 seconds of stale-while-revalidate. Authentication and
identity resolution stay authoritative. Mutations, money entry, financial record
reads and reports, settlement/reconciliation previews and receiving decisions
always use `HYPERDRIVE` with caching disabled. Each query contract member
declares `readPolicy`, applied by the shared operation runner after input
validation. Generic entity and report contracts declare `financialEntity`, so a
read of a financial entity or report slot cannot downgrade money.

Read-your-writes belongs to the member's browser session. Attempted writes
return a signed `cubby.last_write` cookie carrying member, session and write
time; reads stay strong for 90 seconds, beyond the cache window. The marker uses
the current Better Auth secret and cookie helpers, `SameSite=Lax`, `Path=/`, and
`Secure` in production, and is script-readable so stream envelopes can renew it.
The transport sets a short-lived pending claim before a mutation or stream;
invalid claims fail closed. The marker grants no authentication authority:
tampered, mismatched, future or expired markers select strong reads. A browser
without a marker is cache-eligible; API-key, MCP and native callers stay strong
without a valid marker (`x-cubby-read-marker` can carry it, verifiable for one
day). Background and derived notifications never mint member markers, and reads
never call a freshness Durable Object.

Invalidated operation queries send `x-cubby-read-consistency: strong` on their
refetch, and invalidation state keeps that bypass for inactive baselines fetched
later, including infinite queries. Batching groups by headers, so a strong
refetch cannot fall into a cached batch.

## Change notifications

The authenticated shell subscribes to the `household.changed` topic
(`/api/doorbell`, owned by the notification Durable Object) over a same-origin
WebSocket. A ring carries `changes`, a map from cache category to public record
shortcodes or `null` for the whole category; writers that cannot name records,
or that touch more than 200, publish `null`. A ring without `changes` rereads
every loaded view. Writers enroll changes inside their transaction (savepoints
union ids, rollback discards them) and one best-effort hint broadcasts after the
outer commit. Notifications never advance a strong-read window.

**Who rings.** Every `recordChange` inside an HTTP request (browser, MCP or
native) rings. A queue, cron or Durable Object commit stays silent unless it
passes `ringFromBackground`, which only member-started Run transitions
(`isMemberStartedRun`), image processing completion and subject-lift claims, and
derived publications containing a member's own priority-0 edit pass. Everything
else in the background leaves open tabs quiet; totals and search may lag.

**What a ring invalidates.** Hints invalidate existing cache ripples and never
carry record values or replace receipt reconciliation. Within a record-scoped
category, `entity.detail` and record-scoped `entityReport.get`/`getMany`
invalidate only matching shortcodes, unless another category in the same hint is
`null`. Lists, `entityGraph.connectedRecords`, dashboard and nav counts keep
their full ripple. Declared reference and projection-path consumers add their
cache roots through generated read dependencies. Timestamp-only periodic
updates do not imply changed output. Notification invalidation keeps
inactive baselines because streamed sections may need them to hydrate.

**Pacing.** The first ring refreshes immediately; later rings coalesce into at
most one refresh every five seconds plus a trailing refresh, and a slow read
finishes before another starts. Own mutations keep their immediate invalidation.
A hidden tab keeps its socket, drops rings and resynchronizes on return.
Reconnect and resume resynchronize immediately, bypassing the throttle; initial
subscription reuses the SSR baseline. Background refetch feedback appears after
300ms in reserved space, so it never moves content or reads as a first load.
Native workspace routes have no shell indicator.

**Lease and recovery.** Logout unmounts the subscription; delivery requires
reauthentication after the five-minute lease, and the next ring after an idle
lease closes the socket, so the tab reconnects and rereads once. Delivery is
best-effort: a visible page catches up on the next pointer, keyboard or scroll
interaction once a minute has passed since its last full sync. An idle page
issues no recovery reads. These are client-cache synchronizations, not proof that
background computation finished. Notification failures never fail an accepted
save, and strong reads never wait for or trigger derived computation.

**Cache profiles and polling.** Operation queries use `browse` (default: five
minutes stale, 30 minutes retention, freshness from notifications) or
`live-status` (rereads on every mount). Do not add per-entity or per-input
profiles; a stale view is a missing ring or ripple, not a timer. Workflow
progress polling stays local to its active workflow and pauses in hidden tabs.
Do not poll what the socket rings: image-status reads do not poll while
processing. Idle shell, dashboard, list and detail views make no requests; the
one unconditional poll is AI funding on Settings, every 60 seconds.

## List loading and enrichment

Lists, filtering, sorting, totals and pagination belong on the server. A saved
view is visible manifest-backed URL state; `scopeFilters` is only a visible
contextual scope. Missing filters never widen a query, and renderer omissions are
server-enforced and disclosed. Verify server operation and SQL counts as well as
HTTP request counts when changing list loading; more concurrency is not a
substitute for shared work.

### One list read

Every entity page reads complete rows, counts with membership completeness,
full-filter totals and canonical `fields` envelopes in one `entity.list`
request. Loading and errors apply to the whole page; there is no client
field-readiness tracking, enrichment patching or separate summary request.

- **Demand.** Generic rosters request declared demand: visible columns, row
  consumers, row-action read fields and named renderers' `display.readFields`,
  shared by SSR preloads and mounted lists so the first page has one query
  identity. Columns hidden by default load nothing until revealed; row-action
  inputs load even when their columns are hidden. Specialist projections extend
  the same demand. An override never opts into a complete read.
- **Opening sort.** First-page compilation uses the entity's declared opening
  sort when neither URL nor caller overrides it; there is no shared fallback
  field and `useTableState` requires it. Lexical search omits the default sort so
  relevance wins.
- **Scaffold.** Canonical repository lists use `listScaffold.read` with
  schema-picked bindings in `list-projection.ts`; narrow pickers and internal
  target readers use `listScaffold.raw` with their own output contract. Both
  share filtering, sorting, pagination, exact counts, prepared context and
  selected-ID order. Unknown demand or conflicting writers fail before
  selection; count and empty pages load no bindings; a required field missing
  from its source fails before schema defaults run. Any requested output admits
  its whole binding, so split outputs with different inputs.
- **Round trips.** Each sequential statement costs a production round trip
  (about 50–75 ms through Hyperdrive). `listScaffold.list` starts id-only loads
  (quality, display images, pending suggestion counts) beside the row load and awaits display-only prepares
  at hydration; prepared values a binding projects load with the page
  ([derived-field contract](../../../docs/entities.md#filters-and-search)).
  Production list spans report `db.query.busy_intervals`.
- **Stored publications** load once per page for the combined key demand of the
  envelope and admitted bindings. Every binding that reads the shared stored map
  declares its keys; consumers reject unloaded keys.
- **Actions.** Bulk actions and selected-record action reads reload complete
  records strongly before checking availability. Identity-only navigation such as
  Inspect may use loaded rows. Merge row guards validate identity and required
  display fields only.
- **Identity.** Product pages carry storage IDs through USDA and pricing
  enrichment. Multi-record identity resolution uses `resolveLiveShortcodes` /
  `resolveAllOrThrow` once per entity and bounded page.
- **Detail relations.** A relation section's count is its own list read's
  `meta.totalCount` and its default columns come from `listHidden`
  ([detail sections](../../../docs/entities.md#one-declaration-several-consumers));
  add no count or column-roster read. Embedded relation tables use the same
  projection compiler. Inspector and relation headings request graph branch
  counts with a zero item budget.

### Machinery summaries

The canonical projection requests `machinery` with every roster page. A `bind.ids` loader resolves the capability once and calls `loadMachineryRows` once for the selected IDs. Count reads and empty pages load no binding. Cells render that summary without record queries. `machineryStage` and `machineryActor` are declared derived list fields; the scaffold prepares their capability and compiles their filters and sorts with `machineryStageSql` and `machineryActorSql`.

### Scope, paging and virtualization

`useInfiniteTableList` query keys own filter, ordering, grouping and projection
scope. A new scope shows its own cached rows or skeletons, never the previous
scope's rows or totals. Same-scope refreshes keep complete rows and totals and
block offset paging until reconciliation succeeds. Previous pages may bridge a
filter change only when their projection covers the newly visible columns.
Skullet boxes supply placeholders without rendering hidden data readers.

- Browser tables share a 50-record page unless a measured constraint requires
  otherwise; smaller pages repeat population reads to fill the runway.
- Desktop page tables start inside a CSS `60vh` bound until the pane is
  measured; an unbounded first layout would mount the whole page and page early.
  Embedded tables keep the cap.
- A full opening viewport does not start prefetch at scroll offset zero; an
  undersized viewport fills at once. Automatic paging pauses when every server
  group is collapsed. The virtualizer owns scroll offset and pane measurement: do
  not add row observers, scroll listeners or resize cycles for read scheduling.
- An entity with `presentation.state` opens grouped by the `phase` grouping
  (Needs you, Active, Recently finished). Its `list.initialFilter` filters
  `phase` to those three, so "Recently finished" is bounded by the declared
  `recentDays` rather than paged; the finished section's "Show older" adds
  `older` to that filter. Group counts come from the group summaries.
- With `nesting.batches`, the first page of a scope also returns `batches`:
  automatic members of one kind under one parent (or at the root) that number
  two or more leave the paged rows and arrive as one `ListBatch` each. A list
  requests batches only where a batch row has a section: ungrouped, grouped by
  `phase` (the top of its worst-phase group) or by the batch's own `by` field
  (its value's group); under any other grouping the members list unbatched in
  their own sections (`listTreeBatches`). A batch's rollup uses only counts the
  server can address (phase counts and latest activity), never progress summed
  client-side. Expanding a batch pages the `batch` nesting scope
  (`{scope: "batch", parentId, value}`) with the normal sort and paging.
  Batch commands read a batch's unfinished member codes through that scope
  (at most 50) and run the command once per member. Needs-you and
  member-started rows never fold into a batch.
- Desktop virtualization keeps four extra items beyond each edge. An open inline
  editor keeps its row mounted by stable occurrence key through save, cancel and
  focus restoration, and draft and focus survive scrolling away, without
  mounting intervening rows or creating paging demand. Changing row-action
  resolvers must not recreate the name editor's component.

### Filters, counts and pivots

Filter option sources compile from declarations: fixed choices are complete
local rosters, entity references use the shared live roster, and relation sources
use `entityFilterOptions.filterOptions` with `source: "relation"`, whose
eligibility and counts come from the list filter's traversal. Do not add
feature-local capped relationship rosters. The generic runtime owns search, page
accumulation, selected-record hydration, retry and batched display images.
Option query identities include source, scope, search, page and selected values;
a scope change never reuses previous candidates. Product filter rosters activate
when their editor opens or a selected value needs its label.

Saved-view counts load on interaction with the view tabs or filter editor and
share one cached operation. Pending or failed counts stay absent; never
substitute loaded-row length or zero. Counts go through the canonical repository
reader with the list's filters and membership facts but skip rows, bindings,
ordering and group summaries; sibling views may share explicitly
filter-independent preparation within one operation scope.

When `meta.unresolvedCount` is positive the displayed count covers known matches
and the footer offers the unresolved records under the same filters; changing
`resultMembership` changes query and selection scope without dropping filters.
Pivot sends the same list request with page size 0 and `groupBy`, reading counts,
`meta.groups`, `meta.margins` and declared contributor `meta.metrics` with no
summary operation; a placeholder from other filters renders as loading, never as
the current matrix.

### Images and enrichment

- Generic rosters request `displayCover` for thumbnails and keep its full count
  in badges; image-chain popovers load every image. Image bindings start from
  the page-ID prefetch. Nested image hydration validates every candidate and
  replaces stale representations without changing original values or gallery
  size.
- Related previews send at most 1000 source IDs per request and none when no
  relation is visible; loading and raw errors belong to the affected batch's
  cells. Connection evidence loads only for visible rows.
- Product kit enrichment batches the loaded roster through `kitComponentRows`.
  Keep each batch's membership stable as pages append (new IDs form new batches);
  re-keying a batch removes its children and discards open editors. Never sort
  and re-chunk the roster or send it in one request. Cached batches are reused on
  remount after validation with the operation's schema; do not copy rows into a
  separate store.
- Category labels read their shared unfiltered hierarchy with a fixed typed list
  input and never compile route search or admit category metadata. The Product
  Category vocabulary selects only label, hierarchy and record-mark fields; add a
  field there before reading it from a vocabulary row (the full projection is
  about 3.8 MB).
  Category pills share the complete vocabulary used by pickers and filters;
  unresolved references distinguish pending pages, missing IDs and failed reads.
- Inventory dialogs keep canonical amount, Product and Location evidence; a
  missing canonical quantity never falls back to a retained physical amount.
- Location valuation summaries read the canonical valuation envelope: missing
  results show pending or failed, successful empty outcomes a dash, and zero
  stays $0.00.
- Governed values read only from `record.fields[readKey ?? key]`. Edit intent
  comes from `current`, effective outcome and provenance from `result`; a cached
  result never supplies edit permissions. Why this value loads reset previews on
  demand and never substitutes the effective result.
- Pure WASM result memoization belongs to the current runtime: the browser keeps
  up to 2,048 primitive-keyed results; a Worker isolate keeps at most 128 and
  bypasses keys over 1,024 characters. Long text must not stay in the server
  cache across requests.

### Suggestions in lists

Passive lists consume published suggestions and indicators for visible rows plus
a bounded prefetch buffer, keeping successful reads during refresh. A missing
publication or failed read never calls `ai.suggestFields` or its batch operation;
explicit evaluation and editor flows keep their decision path. Ordinary
`entity.listEnrichment` reads stay provider-free.

- Proposal badges read pending, active review-family counts from each list row's
  primary record, excluding field guesses. The count loads with the page; the
  popover uses `suggestions.list` and can show either endpoint's suggestions.
- Pending Suggestions lists and bulk selection share published admission and the
  declared filter/order compiler, with totals, payloads and coverage from one
  SQL snapshot. Bulk execution passes every item through its current-evidence
  handler. Suggestion browsing runs in a read-only repeatable-read transaction
  with a 10-second statement timeout, separate from the request deadline.
- Stored suggestion reads split grouped rosters into at most 250 record IDs.
  Saved questions share activation and input reads within a request; answers,
  review state and commit fences are never shared.
- Live suggestions read complete target projections; explicit nulls and
  resolved references stay eligible.
- Field renderers subscribe to page review state only for fields in current
  suggestion admission or retained live, stored or accepted state. Retained
  proposals stay visible after automatic admission for their field is removed.

### Work queue

The Work queue's household and MCP reads share one engine over the composed Work
sources. Reason and record-scope filters prune sources before the union, the
filtered population materializes once, and totals and view/group counts use the
complete eligible population in the same pass; quality gaps and images load only
for the selected page. A relation list's search schema derives from its
declaration (`relationListSearch`), and row actions render through the
`workActions` table; Problem handlers and their `<problem>:<verb>` wire ids are
owned by `entity/problems/problem-actions.ts`, other sources by
`WorkSourceActionId`.

## Documentation diagrams

The Documentation route renders Mermaid fences with Pele, loaded only in the
browser so the renderer stays out of Worker uploads. Give each SVG a unique ID
prefix so accessibility references and markers stay local. Diagram sources stay
Mermaid in `docs/guide/`.
