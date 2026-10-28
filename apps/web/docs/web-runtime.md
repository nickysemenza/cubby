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
The shared serializable carrier checks supported values with a type-directed
walk. It validates every container member without cloning the payload or
allocating errors for unsuccessful union branches in a valid response.
Producers observe the request signal, and early iterator return cancels the
request. Global server-function middleware owns CSRF and private response headers.
Cookbook import stays busy until its recipe stream and photo phase finish.
The stream's done event precedes iterator completion; hand off recipe progress
to photo progress atomically, with the outer import cleanup owning completion.
An enabled import button must not let a reattached EPUB feed an unfinished
automatic photo pass and bypass the failed photo's Retry action.

Hydration: TanStack Start's SSR query stream lands in the client cache before
React hydrates. First-screen protected reads inherit the root route's server
session guard and use `useSuspenseQuery` / `useSuspenseInfiniteQuery` inside
independent `QuerySection` boundaries. Start Home's shared reads concurrently
in its loader without awaiting the dashboard; the loader returns the stable
household date inputs. Needs you, What changed, Meals, the key-number strip,
detail summary cells and the first declared relation stream their real data.
Do not add client-session or hydration gates to these reads. Later sections
use `VisibleContent` for one-shot viewport admission and remain mounted after
admission. Declared Work slots and retained record suggestions mount with the
record so review actions and deep links into those slots are available before
scrolling. Other below-fold journeys navigate or scroll to the retained section
shell before using its lazy content. Handwritten generic list routes use the
same metadata admission and first-page loader as generated routes.
Query dehydration uses Start's native serializer for Dates, collections and
shared references. Do not wrap those query values in an additional JSON codec.
The browser operation HTTP transport retains its separate SuperJSON wire codec.
Interaction-only authenticated reads can use `useHydrated() &&
session`; passive loading branches use `useHydratedLoading`/`useHydrated`. Interactive controls in streamed sections, design showcases, and lazy
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
Ordinary browser surfaces read entity fields, filters and saved views from the
selected metadata slice in their explicit QueryClient. `getEntityFilters` adapts
`filterDescriptors` data, including preset expansions, declared dynamic expansion
rules, reference brands, sentinels and range bounds; it never imports the universal
filter bindings or exact filter-schema maps. Filter menus retain deferred rosters.
`viewsForEntity(queryClient, entity)` adapts only that entity's saved views. Home
uses the small generated home-pin roster. Canonical aggregate Problems declarations
stay server-owned; browser continuations read the selected declaration through a
server function. Technical schema surfaces request compact server-owned presentation
rows and the selected entity's report through local query boundaries. They never
hydrate every entity's metadata slice or import the full inspector into the browser.
Route loaders split through TanStack Router's `defaultBehavior` alongside
the component chunks. Keep lazy slot registries shared; entity metadata arrives as compiler-owned slices
in QueryClient rather than through global installed models, caches or proxies. Scope
`AuthUIProvider` to the auth/account views; ordinary session reads use
`authClient.useSession()`. The JSON viewer uses `browserOnlyLazy` at its interaction boundary. Keep the
generic editor eager: a cold editor graph delays opening and adds a Suspense
contract to every caller.
Date-cell inputs stay eager so typing to edit keeps every keystroke while
focus transfers to the input.
Keep picker option rosters and Base UI label/equality functions stable across
form rerenders; memoize the mounted control's scoped enum options and search projections.
Resolve the page toolbar's header portal target in a layout effect before paint:
moving the inline fallback later remounts it and discards an early search draft.
Keep list page factories (`list-page.tsx`) separate from detail factories
(`detail-page.tsx`) so lists do not import generic detail sections. Bind each
factory result to a module-level constant referenced by a splittable property
in the route's literal options object; loader-time helpers stay React-free in
`detail-loader.ts`.

## Entity metadata transport

Entity route `beforeLoad` awaits `ensureEntityMetadata(queryClient, entity)`
before list-filter compilation or rendering. The server imports the requested
entity slice and its directly declared relation/reference dependencies, validates
and freezes each compiler-owned slice, and returns them in one loader read.
Dependencies are not traversed transitively. Query's SSR dehydration owns their
transport; a document's QueryClient owns their cache. Accessors take that explicit
scope, and `useEntityMetadata` consumes the same cache without a hydration-time read.
Each query stores the requested slice and its direct dependencies together, so
SSR transports the complete admission rather than side-effect cache writes. A
dependency slice alone does not establish that its own dependencies are available:
later navigation admits that entity's complete bundle. Synchronous dependency
reads consult only bundles already admitted to the document's QueryClient.
Dynamic pickers, previews and graph nodes admit their requested slice through that
hook; non-entity Calendar loads its declared source slices before pure compilation.
The shell uses only the generated names/icons/routes/capabilities roster.

Editors resolve their requested definition from the explicit QueryClient. A dynamic
dialog admits that metadata inside its local overlay before loading the baseline
or rendering the form. Slices transport compiler-owned `createDefaults` and
`structuredSchemas`; selected server validation applies the original exact Zod
contract asynchronously, preserving field paths and pending state. Enum option
rosters have no global metadata cache; mounted controls memoize their options.

Suggestions, editor basis helpers and Why-this-value source fields read an admitted
entity slice from their explicit QueryClient. The sweep menu uses the lean
suggestion-capable roster and loads selected field details before enabling its
scope. Metadata-dependent suggestion identity and review policy stay server-owned
in `field-suggestion-policy`; shared normalization and context helpers remain
metadata-free.

Browser list/detail contracts validate lightweight wire plans and import output
types only. The selected server read owner loads the full entity schemas,
validates exact filters, resolves filter tokens, and validates complete outputs.
Specialist operation contracts reference their selected per-entity envelope
schemas directly, so one operation never imports the aggregate schema catalog.
Keep those schemas and the whole metadata catalogs outside the browser and hot
Worker ingress. A dynamic import in source is not emitted-bundle evidence.

## Confirmed edit state

Query owns server records across entity lists, detail and inspector views.
`receipt-reconciliation.ts` consumes complete mutation receipts before adapters
narrow their public results. Only declared fields with matching stored/read
representations patch existing records. Inline reference/inherited edits fetch
one authoritative detail projection before releasing their editor, following
replacement reads if another write cancels the first attempt. Its declared read
fields update loaded rows, including resolved references; a genuine read failure
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

Loaded views retain data during reconciliation. Background refetch feedback belongs
to the shell status slot; refresh failures and Retry remain inline with the view. Server reads own membership, ordering, counts and paging: a
saved row may briefly remain in its previous position. Do not append offset pages
while the current list is reconciling or its refresh has failed. Retained
page refreshes must preserve confirmed fields until the complete replacement arrives.

Clipboard paste prepares all changed fields before issuing one update per row.
Invalid rows issue no writes; successful sibling rows remain saved. Errors keep
row and field context, and retry targets failed original row identities only.
Multi-field rows without a shared atomic row writer reject before dispatch.

## Read consistency

Ordinary browser display operations use `HYPERDRIVE_CACHED`: at most 60 seconds
of cached data plus 15 seconds of stale-while-revalidate. Authentication and
identity resolution remain authoritative. Mutations, money entry, financial
record reads/reports, settlement/reconciliation previews and receiving decisions
always use `HYPERDRIVE` with caching disabled. The shared operation runner makes
the policy decision after validating input, including the generic entity or
report slot, so an operation's explicit context policy cannot downgrade money.

Read-your-writes belongs to the member's browser session. Attempted writes return
a signed `cubby.last_write` cookie carrying the member, session and write time;
reads stay strong for 90 seconds, beyond the full cache window. The marker uses
the current Better Auth secret and cookie security helpers, `SameSite=Lax`,
`Path=/`, and `Secure` in production (the existing local test override applies).
It is script-readable so stream envelopes can renew it after headers were sent.
The transport sets a short-lived pending claim before a mutation or stream;
invalid claims fail closed if an aborted response never delivers its signature.
The marker grants no authentication authority. Tampering, wrong member/session,
future timestamps and expired signatures select strong reads. A browser without
a marker is cache eligible; API-key, MCP and native callers stay strong without
a valid marker (`X-Cubby-Read-Marker` can carry the signed token). Tokens remain
verifiable for one day so an API caller can retain a marker past the 90-second
strong-read window; the browser cookie itself expires after 90 seconds. There is no
freshness DO RPC on reads. Background and derived notifications do not mint
member markers.

Invalidated operation queries send `X-Cubby-Read-Consistency: strong` on their
refetch. The query's invalidation state preserves that bypass for inactive
baselines fetched later, including infinite queries. Query batching groups by
headers, so a strong refetch cannot downgrade into an ordinary cached batch.
Notifications invalidate only their existing affected cache ripples.

## Change notifications

The authenticated shell subscribes to the `household.changed` doorbell topic
(`/api/doorbell`, owned by the notification Durable Object) over a
same-origin WebSocket. A ring carries `changes`, a map from cache category to
public record shortcodes or `null` for a whole category. Writers that cannot name
records publish `null`; more than 200 distinct ids collapse to `null`. Image
processing resolves its storage UUIDs to public shortcodes before enrollment.
A ring without `changes` rereads every loaded view. Writers enroll changes in
their transaction; successful savepoints union ids (`null` absorbs ids), while
rollback discards them.
After the outer commit, one best-effort hint broadcasts the affected categories.
Notifications never advance a household or member strong-read window. Audit writes cover ordinary entity edits across transports;
non-audited recipe totals, conversion coverage, assessments, saved AI analyses and search/embedding
publication enroll at their saved projection owners. Image-processing completion, retry, retirement and subject-lift claims publish record-scoped hints; other claims, ordinary Job heartbeats and
cursor-only advances do not publish hints. Unchanged periodic projections do not
trigger refreshes merely to update a computation timestamp.

Hints invalidate the existing cache ripples. Within an explicitly record-scoped
category, `entity.detail` and record-scoped `entityReport.get`/`getMany`
invalidate only matching record shortcodes, or when another category in the same
coalesced hint is `null`. Id-scoped dependent categories do not reach them: an
`image` ripple covers every displaying entity, so it would refetch every open
Image job. `entityGraph.connectedRecords` lists other records and keeps its
ripple, as do lists and dashboard/nav counts; a `null` category keeps full
invalidation. Hints
never carry record values or
replace receipt reconciliation. Reads already in flight are retired and loaded
views retain their ordinary refresh/error UI. Notification invalidation retains
inactive baselines because streamed sections may still need them to hydrate;
mount and detail loaders refetch those invalidated baselines before reuse.
The first ring refreshes immediately; further rings accumulate into at most one
refresh every five seconds, with a final trailing refresh. A slow read completes
before starting another. Own mutations retain their immediate local invalidation.
Subscription recovery on open/resume bypasses the ring throttle. Background
refetch feedback appears in the reserved sidebar status slot (or a BottomNav
spinner on mobile) only after 300ms; it never inserts a row into page content.
Inline refresh errors retain their data and Retry. Native workspace routes have
no shell indicator.
Declared reference and projection-path consumers add their own cache roots to
the hint's ripple. This uses generated read dependencies without recursively
expanding mutation ripples. Projection completion uses the same notification
path as edits; timestamp-only periodic updates do not imply changed output.
Subscription establishment, reconnect and app resume resync cache-backed queries
to recover missed hints. Logout unmounts the subscription; delivery requires
reauthentication after its five-minute lease expires.

The derived backlog badge and its overview consume these change notifications,
including reconnect/resume resync, without a fixed polling interval. Workflow
progress polling stays local to its workflow; query defaults pause intervals
while the browser tab is hidden.

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

Pure WASM result memoization belongs to the current runtime. The browser keeps
up to 2,048 primitive-keyed results; a reused Worker isolate keeps at most 128
and bypasses keys over 1,024 characters. Object inputs are batched and bypass
memoization. Long authored text must not remain in the server cache as both a
key and a parsed result across unrelated requests.

Location valuation summaries consume the canonical valuation envelope: missing results show their shared pending or failed state, successful empty outcomes show a dash, and a numeric zero remains $0.00. Pricing counts come only from a successful valuation result; stale usable values retain their refresh status and raw failure.

Governed values are read only from `record.fields[readKey ?? key]`; ordinary fields remain plain. Assignment intent and edit controls come from `current`, effective outcomes and provenance from `result`, and refresh failures from `work`. A cached result never supplies current edit permissions. Why this value loads exact reset previews on demand; missing previews are not substituted with the effective result. Reference and image evidence share the ordered SourceStack; allocated values retain all contributors.

First-page list compilation uses the entity's declared opening sort and direction
when neither the URL nor a caller supplies an override. SSR preloads, secondary
lists and mounted table state share the same lightweight sort-roster owner.
Lexical search still omits the ordinary default sort so relevance remains authoritative.

Every entity page reads complete rows, counts with membership completeness,
full-filter totals and canonical `fields` envelopes in one `entity.list` request.
When `meta.unresolvedCount` is positive, the displayed count covers known matches;
the list status strip explains the incomplete count and offers the unresolved
records under the same filters. Changing `resultMembership` changes the query
and bulk-selection scope, without removing the member's filters. Totals over
known matches use that caption rather than claiming to cover unresolved records.

Batch shared row bindings inside that read and run independent loads concurrently.
Image bindings start from the scaffold's page-ID prefetch rather than waiting
for public row codes. Analysis includes live Product labels and verified
correction receipts without dependent reader queries; embedded-media callers
can still select the same readers by public Image codes.
Stored metadata uses internal page IDs. Columns,
actions, captions and providers consume complete rows; no client field-readiness
tracking, enrichment patches, generation retries or separate summary requests.
Loading and errors apply to the whole page. Normal query cancellation, stale
page protection, infinite pagination and lazy tree expansion remain page-level
concerns. Tree children and selected-record action reads use the same complete
list contract. A detail relation section's count is its own list read's
`meta.totalCount` ([detail sections](../../../docs/entities.md#one-declaration-several-consumers)),
and default columns come from declared `listHidden`
([column defaults](../../../docs/entities.md#bulk-edit)); add no count or
column-roster read.
Category reference pills share the complete vocabulary used by pickers and
filters, including all pages and the inherited `effectiveFeature` value.
Unresolved references distinguish pending pages, completed missing IDs and
failed reads; cached matches remain visible during refresh errors.

Saved-view counts load on interaction with the view tabs or filter editor,
sharing one cached operation across observers. Pending or failed counts stay
absent; never substitute loaded-row length or zero for a population total.
Product filter rosters activate when their editor opens (or a selected value
needs its label); a complete deferred roster retains local picker search.
Saved-view counts forward count intent through the canonical repository reader.
They retain the same filters, prepared membership facts and custom counts as the
list, while skipping row selection, presentation bindings, ordering and group
summaries. Filter-dependent preparation remains necessary for exact totals.
Internal base projections bind no fields or totals and skip total-completeness
queries; result-dependent filters still report membership completeness.
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

Product list pages carry storage IDs through USDA and pricing enrichment; they
must not resolve each public row code back to its ID. Multi-record identity
resolution uses the shared `resolveLiveShortcodes` / `resolveAllOrThrow` helpers
once per entity and bounded page. An inventory-location suggestion reads its
Product source by shortcode and carries that source's ID into the candidate
aggregates, avoiding a separate identity query for every roster. This keeps
live-row and legacy-code handling at the read boundary.
Field suggestion batches carry those resolved subject IDs into correction checks.
Product report slots share their request's identity dependency, including stock,
pricing, use and evidence summaries; standalone summary reads still resolve their
own subject.

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
owns quality/media completion. Generic browser list schemas include `displayImages`; declare it in `presentation.list.read.media`. The read plan resolves it from internal ids for every entity that declares it, so the kernel's media pass only re-resolves rows that arrive without it; enable `media` only for bespoke media bindings. This keeps the field out of the base response until its media loader runs. Reference instructions distinguish stored UUID
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
different inputs: an identity must not share a binding that requires an
otherwise unused relation. Selected-field regressions should omit that relation
and verify both the public projection and the work it avoids.

A list page costs one network round trip per sequential statement in
production (about 50-75 ms through Hyperdrive), so `listScaffold.list` keeps
the chain short: the id-and-count query starts the page's id-only loads
(quality, display images) beside the row load, and prepares a page only
displays load beside both queries, awaited at hydration. A repository that
builds its own context keeps every prepare ahead of its query, because its
select or footer reads the prepared data.
Production list spans report `db.query.busy_intervals`, a lower bound on
sequential round trips (a dependent query that starts while another still
runs joins that interval).

Narrow pickers and internal target readers use `listScaffold.raw` and keep their
own output contract. Both methods share authoritative filtering, sorting,
pagination, exact counts, prepared context and selected-ID order restoration.
There is no public full-row hydration callback.
Detail route loaders retain a query observer while awaiting a shared record
read, so closing an inspector cannot cancel the incoming route's request.
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

List actions consume the complete page row.
Merge row guards validate the owner identifier and required display fields;
optional statistics such as a Product barcode cannot gate opening the dialog.

Same-query refreshes retain complete rows and totals while the replacement
page loads. Filter/sort changes never mix rows or metadata from different scopes.
Whole-page failures expose diagnostics and retry through the normal query.
Related previews send at most 1000 source IDs per request and send none when no
relation is visible; loading and raw read errors belong to the affected batch's
cells. Live suggestions read complete target projections; explicit nulls and
resolved references remain eligible.
Stored suggestion reads split grouped-list rosters into at most 250 record IDs
before validation, and split full result pages further to avoid truncation.

Lists, filtering, sorting, totals, and pagination belong on the server. A saved
view is visible manifest-backed URL state; `scopeFilters` is only a visible
contextual scope. Missing filters never widen a query; renderer omissions are
server-enforced and disclosed.

The Work queue's household and MCP reads share one engine over the composed
Work sources. Reason include/exclude and record scope prune sources that cannot
emit a row before the union; filters, search and the view then narrow the one
materialized union. Exact totals and view/group counts use the complete
eligible population in the same pass; quality gaps and display images load only
for the selected page. A relation list's route derives its search schema from
its declaration (`relationListSearch`), and its rows' declared actions render
through the `workActions` feature table; neither is hand-listed per page. That
table's Problem handlers are shaped by `entity/problems/problem-actions.ts`,
which also owns the `<problem>:<verb>` wire id; other sources' actions are
keyed by `WorkSourceActionId`. Pending
statement-reference invalidation uses one hashable source-reference set rather
than a source-record lookup per reference per pending suggestion.
Statement counts decode one compact page-independent eligibility projection.
Connection publication retains its small target reference in the existing
`AssessmentState.data` projection; the migration fills current pending rows
from immutable evidence without changing decisions. Queue counts still check
live endpoints, feedback and suppression. A missing projection falls back to
immutable evidence, including writes completed by the predecessor during deployment.

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
