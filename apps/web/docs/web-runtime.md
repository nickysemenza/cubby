# Web runtime rules

Never pass fresh inline objects/arrays/functions to hook dependency contracts;
use a stable module value, `useMemo`, or the established helper. In particular,
hook-result defaults use module-level constants (not `= []`/`{}`), and
`useQueries` uses `combine` for a stable result. Prefer the existing mutation,
query-key, clipboard, form-field, database, merge, and shortcode helpers over
hand-rolled equivalents; raw mutation is reserved for the documented dynamic
invalidation/inline-error/multi-mutation cases.
Router subscriptions select the scalar or derived value a component consumes;
components that genuinely consume the full dynamic search state retain it.
Do not enable global structural sharing merely to narrow scalar subscriptions.
Pass the displayed selection as mutation variables at the action boundary.
Queries stay passive on ordinary remount, but invalidated queries refetch when
reactivated. Detail loaders fetch invalidated records before returning them.
Ordinary saves finish at the validated server receipt. The root mutation cache
retires older reads, publishes confirmed compatible scalar fields into existing
projections, evicts inactive baselines, then refreshes active views independently.
Do not await a broad refresh in an editor or duplicate command invalidation in a
presentation wrapper. A refresh failure preserves the accepted write and offers
read retry, never write retry.
Create-from-picker dialogs resolve the pending choice synchronously from the
saved receipt's identity/title before closing. They must not require a full
detail schema from a mutation response; later picker queries own expanded rows.

Browser query HTTP requests share one admission budget across batches, header
groups, singleton reads and batch fallbacks, owned by
`integrations/tanstack-query/browser-operation-transport.ts`. That transport
retries explicit transient database failures with bounded backoff on fresh
request scopes; cancellation stops queued requests and retry waits. Successful
batch siblings are not replayed. Mutations are outside this read recovery
policy, and exhausted retries retain the last raw diagnostics. Keep passive
mount/focus/reconnect defaults separate from recovery of an active read.
Pass the optional per-call `{ batch: false }` for reads partitioned to fit a Worker invocation budget; all other calls keep batching, and opted-out reads retain shared admission, cancellation and retry.

This bounds HTTP requests, not origin database connections: each server batch
can run several operations using its request-scoped pool. It does not reserve
origin capacity or guarantee that pool-slot errors cannot occur. Recovery needs
an exposed transient database cause; failures before session verification have
no public causes and do not qualify. Jitter is shared within a browser tab so
siblings from a failed batch can coalesce again.

A mutation function must not read changing selection state from its closure:
observer options can lag the render that enabled the action.
Equivalent controls for one record share pending state through the mutation
cache, filtered by operation and validated record identity. Check the live cache
at submission too, before another control's observers rerender. Keep the request's
pending state separate from accepted background work and readiness polling;
other records remain usable and failed requests allow retry.
Resolve table selection updaters at the event boundary: they look up live rows
and must not be deferred to a React state replay after optimistic removal.
Successful bulk actions clear only the row IDs passed to that action. A new
selection made while its write or refetch is pending survives completion.
For hook-default and `useQueries` examples, load the relevant heading in the
[web UI reference](web-ui-reference.md).

Catalog query options validate input before `enabled` is evaluated. Construct
child queries only for roots their identifier contract accepts; disabling an
image-root query does not make its ID a valid Run ID.

The server render uses TanStack Start's local function execution, never an HTTP
request to itself. Keep `~/server` imports behind the `.server()` branch of an
isomorphic function. `ssr: false` is a measured cost choice, not a correctness
workaround; a loader may await `ensureQueryData` when that latency is warranted.
Workflow streams use one typed Start server function and an `AbortSignal`;
Start owns framing and serialization. The owning screen opens the stream
explicitly. Shared operation result envelopes retain normalized diagnostics;
domain input/events remain schema-validated inside the authenticated runtime.
Producers observe the request signal, and early iterator return cancels the
request. Global server-function middleware owns CSRF and private response headers.
Cookbook import stays busy until its recipe stream and photo phase finish.
The stream's done event precedes iterator completion; hand off recipe progress
to photo progress atomically, with the outer import cleanup owning completion.
An enabled import button must not let a reattached EPUB feed an unfinished
automatic photo pass and bypass the failed photo's Retry action.

Hydration: TanStack Start's SSR query stream lands in the client cache before
React hydrates, so gate loading branches with `useHydratedLoading`/`useHydrated`,
and gate auth-required queries on `useHydrated() && session`, never raw session
state. Interactive controls in streamed sections, design showcases, and lazy
detail slots stay disabled until their own
`useHydrated()` is true; shell hydration alone does not establish their handlers
are attached. Direct loads to protected routes are gated server-side at the root route
(`getGuardSession`) before any protected markup ships; a client-only guard is
bypassable. TanStack's `parseSearch` JSON-parses URL params, so a search field
that must stay a string (numeric-looking ids) uses `urlStringParam`. A child
route under a no-`<Outlet/>` detail route renders the parent invisibly — use the
trailing-underscore segment (`$shortcode_.export`) to un-nest. Client chunking
is Rolldown `codeSplitting.groups` in `vite.config.ts`; never group `@base-ui`
or do a naive vendor split — it drags lazy-route code into first paint. Detail
and list slot fills stay `lazy` in their registries (`detail-slots.tsx`,
`list-slots.ts`): every generic list route shares one closure, so one static
slot import ships to every list. Keep schema modules on the default graph:
bounded entry-aware schema grouping read an undefined `schema.shape` during
Product startup in a paired probe. A successful bundle build does not
establish client initialization; verify real authenticated navigation when
changing chunk boundaries.
Specialist list columns are declared as `route.listColumns` source references.
The account menu loads after hydration behind its existing SSR placeholder;
its session-dependent controls do not belong in the Worker render closure.
Interaction-only registry dialogs stay lazy with a local Suspense boundary
inside their open/selected state. Loading a dialog must not suspend the action
host or page. Feature installation stays synchronous and idempotent so child
lookups see registered components before rendering.
The generated route component imports only its own override and passes it to
`listPage`; the generic list must never import an all-entity column registry.
Shared cells live with their generic feature (for example, the unit-mappings
column lives in `features/units`), so generic hooks do not import a specialist
list module merely to reuse one renderer.
Scalar columns share `createEditableAccessorColumn`. One row-parametrized
clipboard descriptor supplies both range operations and the rendered editor;
declared-control bindings preserve its value type. Generated cells reread the
row, while ordinary factories request the cached accessor value lazily. Keep
inheritance intent and domain formatting in their existing adapters.
Full record timelines join the continuous detail page. Timeline renderers remain lazy imports; section navigation never unmounts an editor or timeline.
Ordinary browser surfaces never import `entityInspectorMetadata`: it carries the
compiler's filter descriptors, port refs, and a duplicate of the summary, and
one import ships all of it to every list. Read names, titles, resolved
`primarySearch`, `list.initialFilter`, `bulkUpdate`, `recordEmojiField`, and
`recordIconEntityField` from `entitySummary`;
`shortcodePrefix`/`searchable` from `entityManifest`; and filter
`field`/`columnId`/`kind`/URL key/`referenceEntity` from `getEntityFilters`
with `filterUrlKey` (a runtime spec omits `urlKey` when it equals
`columnId`). The server and the lazily loaded schema surfaces
(`entity/platform`: the Entities schema sheet and the
`/entities/schema/$entity` page) keep the full inspector.
Route loaders split through TanStack Router's `defaultBehavior` alongside
the component chunks. Keep the generated entity maps and lazy slot registries
shared: per-entity model registration adds initialization and cross-entity
Suspense contracts without removing the all-entity list schemas. Scope
`AuthUIProvider` to the auth/account views; ordinary session reads use
`authClient.useSession()`. The JSON viewer uses `browserOnlyLazy` at its interaction boundary. Keep the
generic editor eager: a cold editor graph delays opening and adds a Suspense
contract to every caller.
Date-cell inputs stay eager so typing to edit keeps every keystroke while
focus transfers to the input.
Keep picker option rosters and Base UI label/equality functions stable across
form rerenders; use the existing enum roster cache and memoize search projections.
Resolve the page toolbar's header portal target in a layout effect before paint:
moving the inline fallback later remounts it and discards an early search draft.
Keep list page factories (`list-page.tsx`) separate from detail factories
(`detail-page.tsx`) so lists do not import generic detail sections. Bind each
factory result to a module-level constant referenced by a splittable property
in the route's literal options object; loader-time helpers stay React-free in
`detail-loader.ts`.

## Confirmed edit state

Query owns server records across entity lists, detail and inspector views.
`receipt-reconciliation.ts` consumes complete mutation receipts before adapters
narrow their public results. Only declared fields with matching stored/read
representations patch existing records. Inline reference/inherited edits fetch
one authoritative detail projection before releasing their editor, following
replacement reads if another write cancels the first attempt. Its declared read
fields update loaded rows, including deferred references; a genuine read failure
is reported separately from the accepted write. Confirmed deletes
and merged-away identities retire centrally. Never seed full detail from a
partial receipt or retain a second committed value in a cell.

Editors show Saving… until acceptance. Offline writes reject without queuing;
overlapping writes to the same record reject while unrelated records stay usable.
Draft and failed-write retry state remain local. Collection and inherited-value
full editors load an authoritative baseline on reopening when their cache was
retired or invalidated. Field-scoped correction editors retain their reviewed
field projection and submit through its correction owner; they do not replace it
with an unrelated full-record baseline. A dependent action may wait; the accepted
save is complete. Settlement matching starts each review visit from a fresh candidate read and with no retained
selection or draft; cached candidates stay unavailable until that read finishes.
A paused/offline read cannot satisfy a fresh-baseline gate.

Loaded views retain data with Updating… during reconciliation and report refresh
failure separately. Server reads own membership, ordering, counts and paging: a
saved row may briefly remain in its previous position. Do not append offset pages
while the current list is reconciling or its refresh has failed. Retained
progressive enrichment must not overwrite confirmed base fields.

Clipboard paste prepares all changed fields before issuing one update per row.
Invalid rows issue no writes; successful sibling rows remain saved. Errors keep
row and field context, and retry targets failed original row identities only.
Multi-field rows without a shared atomic row writer reject before dispatch.

## Change notifications

The authenticated shell subscribes to the `household.changed` doorbell topic
(`/api/doorbell`, owned by the household freshness Durable Object) over a
same-origin WebSocket. A ring names the changed categories; a ring without them
rereads every loaded view. Writers enroll changed cache categories in their
transaction; successful savepoints merge them and rollback discards them.
After the outer commit, one best-effort hint advances the strong-read window
before broadcasting. Audit writes cover ordinary entity edits across transports;
non-audited recipe totals, conversion coverage, assessments, saved AI analyses and search/embedding
publication enroll at their saved projection owners. Job claims, heartbeats and
cursor-only advances do not publish hints. Unchanged periodic projections do not
trigger refreshes merely to update a computation timestamp.

Hints invalidate the existing cache ripples; they never carry record values or
replace receipt reconciliation. Reads already in flight are retired and loaded
views retain their ordinary refresh/error UI. Notification invalidation retains
inactive baselines because streamed sections may still need them to hydrate;
mount and detail loaders refetch those invalidated baselines before reuse.
Refresh status renders only after its own hydration boundary is ready, since
the shell can initiate subscription recovery before streamed sections hydrate.
Additional hints received during refresh are combined for the next read.
Declared reference and projection-path consumers add their own cache roots to
the hint's ripple. This uses generated read dependencies without recursively
expanding mutation ripples. Projection completion uses the same notification
path as edits; timestamp-only periodic updates do not imply changed output.
Subscription establishment, reconnect and app resume resync cache-backed queries
to recover missed hints. Logout unmounts the subscription; delivery requires
reauthentication after its five-minute lease expires.

This replaces fixed post-mutation refresh timers. Delivery is not a durable event
log: a Worker can die after database commit but before publishing, even while a
browser remains connected. Such a tab has no bounded catch-up guarantee until
resume, reconnect or explicit refresh. Notification failures are logged separately
and never make an accepted save fail. Existing workflow progress polling remains
owned by its workflow and is not a guarantee that every derived value is current.

Receiving dialogs reuse the Product label already present on the Expense detail
or Purchase line. Do not fetch a full Product detail solely for that label; fall
back to its public identity when the parent has no label. Receiving stock,
possible photo matches and allowed plans still come from `receivingContext` on
every open with zero stale/garbage-collection time. Presentation labels must not
replace this fresh decision read or the receiving command's current-stock checks.

## List loading and enrichment

First-page list compilation uses the entity's declared opening sort and direction
when neither the URL nor a caller supplies an override. SSR preloads, secondary
lists and mounted table state share the same lightweight sort-roster owner.
Lexical search still omits the ordinary default sort so relevance remains authoritative.

Extend the generic list enrichment pipeline for data shared across rows,
including saved suggestion outcomes and review status. Batch server reads and
share preparation across the bounded record set; HTTP batching alone still
repeats work when each operation prepares and queries independently. Preserve
per-record cache identity, errors, cancellation and progressive delivery.
Category reference pills share the complete projected vocabulary used by pickers
and filters. Its `effectiveFeature` scalar uses the declared category inheritance
resolver; displaying a reference must not load the full nested hierarchy or
category stock, mapping and product-count provenance. Hierarchy views retain
server-defined nesting. Unresolved references distinguish pending pages, completed
missing IDs and failed reads; cached matches remain visible during refresh errors.
Progressive row views preserve the data array and unaffected record objects
until their immutable base pages or enrichment patches change; loading and
summary-only updates must not rebuild the table dataset.
Custom renderers declare additional row reads in column metadata; Project task
progress requests its rollup alongside its textual value. Action admission parses
only the identity and fields consumed by the action, so deferred list fields
cannot hide actions on a selected base row.
Column read demand includes declared label paths for server-composed values,
including non-reference fields such as Shipment event spans. It also includes
the top-level roots of declared explanation source
dependencies, so explanation evidence remains available when reads are narrowed.
Reference demand includes canonical labels, allocations and assignment
resolutions. Visible suggestion targets add their basis and context inputs
through the same target declarations used by request construction. Progressive
tables admit automatic suggestions only after those inputs are ready; an
explicit null target remains eligible.
Saved-view counts forward count intent through the canonical repository reader.
They retain the same filters, prepared membership facts and custom counts as the
list, while skipping row selection, presentation bindings, ordering and group
summaries. Filter-dependent preparation remains necessary for exact totals.
Sibling saved-view counts may share explicitly filter-independent preparation
through one database-bound operation scope. Each view still selects its own
membership and applies its complete filters. Ordinary filter-dependent prepares
and seeded contexts remain local; the scope ends with the count operation.
Proposal-count badges subscribe to shared counts only for eligible title cells
and fieldless mobile titles. Other cells return their existing content before
joining that context.
For automatic suggestion recomputation, prioritize visible rows plus a bounded
prefetch buffer, reuse current saved answers, and batch only missing or
invalidated decisions after checking their individual caches. Virtualized
rendering alone does not bound the records passed to a data provider. Verify
server operation and SQL counts as well as HTTP request counts when changing
list loading; increasing concurrency is not a substitute for shared work.

`RecordSuggestionsProvider` keeps stored review/bulk-action scope over loaded
records while mounted `RecordSuggestionBoundary` rows admit automatic work
from desktop and mobile virtualizers, including their overscan. Its AI
enrichment stage uses `ai.suggestFieldsBatch`: shared policy, Run and roster
preparation, then individually cached decision waves and existing assessment
publication. Ordinary `entity.listEnrichment` reads remain provider-free.
Queued batches discard cancelled members after shared admission; started work
retains normal publication and freshness checks.
Field renderers subscribe to mutable page review state only for fields in
current suggestion admission or retained live, stored or accepted state.
Retained proposals remain visible even after automatic admission for their
field is removed. Other columns consume a stable eligibility scope and retain
their ordinary content when another field's review state changes.

Canonical repository lists use `listScaffold.read` with schema-picked output
bindings in `list-projection.ts`. The assembler selects and validates present
canonical scalars, converts root identity, excludes private foreign keys, and
owns quality/media completion. Generic browser list schemas include `displayImages`; declare it in `presentation.list.read.media` and enable `media` in the repository read plan, including entities with no images. This keeps the field out of the base response until its media loader runs. Reference instructions distinguish stored UUID
lookups from already projected public IDs. Domain bindings retain their typed
computations and page-batch inputs; their output schema determines admission
from the canonical partition. Stored reference names derive from declared label
paths; to-one record-valued derived paths use compiled traversal and the canonical
label resolver. Explicit bindings retain domain enrichment and inheritance.
Shared batches memoize once for the selected page,
including explicit dependencies between domain computations. Unknown demand or
conflicting writers fail before selection; count and empty pages never load
bindings. A skipped field remains absent, and a required field missing from a
selected source or binding fails before schema defaults run.
Any requested output admits its entire binding. Split outputs whose inputs have
different readiness: a core identity must not share a binding that requires a
deferred relation column. Selected-field regressions should omit that relation
and verify both the public patch and the work it avoids.

Narrow pickers and internal target readers use `listScaffold.raw` and keep their
own output contract. Both methods share authoritative filtering, sorting,
pagination, exact counts, prepared context and selected-ID order restoration.
There is no public full-row hydration callback.
Reference lookup targets come from declared read fields as well as storage
fields: table-only lineage columns can still expose declared public references.
Photo receipt recovery captures the requested current revision even when a
completed Run blocks new approvals; the server validates the existing receipt.
An unsaved-field refusal restores focus after approval's pending state clears,
so the field is enabled when focus lands.

Review outcomes and completion callbacks belong to the submitting view visit.
Capture its identity before dispatch and compare it on completion; a query key
alone cannot distinguish leaving a view and returning to it. Cache invalidation
still completes for authorized writes. Ordinary workflow commands execute through
the generated operation catalog with its mutation metadata and optional scope.
When a command patches a saved snapshot, synchronous `onResult` receipt work runs
before catalog invalidation. Asynchronous follow-up failures are reported
separately from the accepted command. Keep serialization scope on a
transport-owning mutation only when the workflow requires it; a presentation
wrapper awaiting that command must not acquire the same scope. Ordinary entity
commands share neither a global nor entity-wide serialization scope.

List actions must accept the base row before progressive enrichment arrives.
Merge row guards validate the owner identifier and required display fields;
optional statistics such as a Product barcode cannot gate opening the dialog.

Same-query list refreshes retain completed enrichment while cancelling obsolete
reads. Invalidation and base-page refetch must not turn loaded cells back into
skeletons; filter/sort scope changes must not reuse another scope's enrichment.
Fresh enrichment replaces retained values, and failures still expose diagnostics.
The same scope retains completed totals during refresh. Related previews send
at most 1000 source IDs per request and send none when no relation is visible;
loading and raw read errors belong to the affected batch's cells.
Live suggestions wait for their target projection; an absent deferred field is
not an empty saved value. Explicit nulls and resolved references remain eligible.
Stored suggestion reads split grouped-list rosters into at most 250 record IDs
before validation, and split full result pages further to avoid truncation.

Lists, filtering, sorting, totals, and pagination belong on the server. A saved
view is visible manifest-backed URL state; `scopeFilters` is only a visible
contextual scope. Missing filters never widen a query; renderer omissions are
server-enforced and disclosed.

Infinite tables use the shared pagination default unless a measured caller
constraint requires an override. A smaller batch can repeat full population
reads just to fill the same prefetch runway. Measure first-data latency and
buffer completion separately; keep the shared prefetch and paging behavior.

## Reuse before writing a helper

The catalog of shared helpers and generic paths lives in
[generic paths](../../../docs/agents/generic-paths.md).

Do not turn every raw mutation into `useActionMutation`: it has static
invalidation and toast semantics. A raw mutation remains correct for shared
multi-mutation invalidation, conditional query keys, caller-owned error UI, or
variables-driven local state. `noUncheckedIndexedAccess` is on: guard a
possibly absent array, record, or map entry instead of asserting it away.

## Documentation diagrams

The Documentation route renders Mermaid code fences with Pele, loaded only in
the browser so the renderer stays out of Worker uploads. Give each SVG a unique
ID prefix to keep accessibility references and SVG markers local to its diagram.
Diagram sources remain Mermaid syntax in `docs/guide/`.
