# Web runtime rules

Never pass fresh inline objects/arrays/functions to hook dependency contracts;
use a stable module value, `useMemo`, or the established helper. In particular,
hook-result defaults use module-level constants (not `= []`/`{}`), and
`useQueries` uses `combine` for a stable result. Prefer the existing mutation,
query-key, clipboard, form-field, database, merge, and shortcode helpers over
hand-rolled equivalents; raw mutation is reserved for the documented dynamic
invalidation/inline-error/multi-mutation cases.
Pass the displayed selection as mutation variables at the action boundary.
A mutation function must not read changing selection state from its closure:
observer options can lag the render that enabled the action.
For hook-default and `useQueries` examples, load the relevant heading in the
[web UI reference](web-ui-reference.md).

Catalog query options validate input before `enabled` is evaluated. Construct
child queries only for roots their identifier contract accepts; disabling an
image-root query does not make its ID a valid Run ID.

The server render uses TanStack Start's local function execution, never an HTTP
request to itself. Keep `~/server` imports behind the `.server()` branch of an
isomorphic function. `ssr: false` is a measured cost choice, not a correctness
workaround; a loader may await `ensureQueryData` when that latency is warranted.
Workflow streams use typed JSONL server routes and an `AbortSignal`; the owning
screen opens them explicitly rather than a generic dispatcher.
Cookbook import stays busy until its recipe stream and photo phase finish.
The stream's done event precedes iterator completion; hand off recipe progress
to photo progress atomically, with the outer import cleanup owning completion.
An enabled import button must not let a reattached EPUB feed an unfinished
automatic photo pass and bypass the failed photo's Retry action.

Hydration: TanStack Start's SSR query stream lands in the client cache before
React hydrates, so gate loading branches with `useHydratedLoading`/`useHydrated`,
and gate auth-required queries on `useHydrated() && session`, never raw session
state. Direct loads to protected routes are gated server-side at the root route
(`getGuardSession`) before any protected markup ships; a client-only guard is
bypassable. TanStack's `parseSearch` JSON-parses URL params, so a search field
that must stay a string (numeric-looking ids) uses `urlStringParam`. A child
route under a no-`<Outlet/>` detail route renders the parent invisibly — use the
trailing-underscore segment (`$shortcode_.export`) to un-nest. Client chunking
is Rolldown `codeSplitting.groups` in `vite.config.ts`; never group `@base-ui`
or do a naive vendor split — it drags lazy-route code into first paint. Detail
and list slot fills stay `lazy` in their registries (`detail-slots.tsx`,
`list-slots.ts`): every generic list route shares one closure, so one static
slot import ships to every list.
Specialist list columns are declared as `route.listColumns` source references.
The generated route component imports only its own override and passes it to
`listPage`; the generic list must never import an all-entity column registry.
Shared cells live with their generic feature (for example, the unit-mappings
column lives in `features/units`), so generic hooks do not import a specialist
list module merely to reuse one renderer.
Timeline rendering loads only when its view is selected.
Ordinary browser surfaces never import `entityInspectorMetadata`: it carries the
compiler's filter descriptors, port refs, and a duplicate of the summary, and
one import ships all of it to every list. Read names, titles, resolved
`primarySearch`, `list.initialFilter`, and `bulkUpdate` from `entitySummary`;
`shortcodePrefix`/`searchable` from `entityManifest`; and filter
`field`/`columnId`/`kind`/URL key/`referenceEntity` from `getEntityFilters`
with `filterUrlKey` (a runtime spec omits `urlKey` when it equals
`columnId`). The server and the lazily loaded schema surfaces
(`features/entity-platform`: the Entities schema sheet and the
`/entities/schema/$entity` page) keep the full inspector.
Route loaders split through TanStack Router's `defaultBehavior` alongside
the component chunks. Keep the generated entity maps and lazy slot registries
shared: per-entity model registration adds initialization and cross-entity
Suspense contracts without removing the all-entity list schemas. Scope
`AuthUIProvider` to the auth/account views; ordinary session reads use
`authClient.useSession()`. Editors and the JSON viewer use `browserOnlyLazy` at their interaction boundary.
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

List actions must accept the base row before progressive enrichment arrives.
Merge row guards validate the owner identifier and required display fields;
optional statistics such as a Product barcode cannot gate opening the dialog.

Lists, filtering, sorting, totals, and pagination belong on the server. A saved
view is visible manifest-backed URL state; `scopeFilters` is only a visible
contextual scope. Missing filters never widen a query; renderer omissions are
server-enforced and disclosed.

## Reuse before writing a helper

The catalog of shared helpers and generic paths lives in
[generic paths](generic-paths.md).

Do not turn every raw mutation into `useActionMutation`: it has static
invalidation and toast semantics. A raw mutation remains correct for shared
multi-mutation invalidation, conditional query keys, caller-owned error UI, or
variables-driven local state. `noUncheckedIndexedAccess` is on: guard a
possibly absent array, record, or map entry instead of asserting it away.
