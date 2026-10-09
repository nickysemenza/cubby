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
and list slot fills and verbs live in each entity's hook module
(`entity/clients/<entity>.{detail,list}.tsx`), bound by its generated client
module, which only that entity's route component imports — so a slot ships
with its own entity's page and nowhere else. Never gather fills into an
all-entities registry.
Specialist list columns are declared as `route.listColumns` source references.
The generated route component imports only its own override and passes it to
`listPage`; the generic list must never import an all-entity column registry.
Shared cells live with their generic feature (for example, the unit-mappings
column lives in `features/units`), so generic hooks do not import a specialist
list module merely to reuse one renderer.
Timeline rendering loads only when its view is selected.
Browser code never value-imports the all-entities model aggregates
(`entity-manifest`, `entity-summary`, `entity-fields`, the inspector map) or
server code that collects every entity's schemas (`~/server/generated`,
`~/server/entity-kernel`; `cubby/no-client-entity-aggregate`,
[ADR 0009](../adr/0009-per-entity-client-manifests.md)). The editor parses a
draft with `~/entity/generated/entity-edit-inputs.gen`; the server re-parses
every mutation command, so the browser sends it unparsed.
Read names, titles, icons, traits, `shortcodePrefix`, resolved
`primarySearch`, `list.initialFilter`, and the `bulkUpdate` flag from
`@cubby/schemas/entity-index`; a loaded entity's field model, summary and
descriptor through `~/entity/entity-model`; and filter
`field`/`columnId`/`kind`/URL key/`referenceEntity` from `getEntityFilters`
with `filterUrlKey` (a runtime spec omits `urlKey` when it equals
`columnId`). Only the schema surfaces (`features/entity-platform`: the
Entities schema sheet and the `/entities/schema/$entity` page) load the
per-entity inspector modules, through `useEntityInspectors`.
Keep list page factories (`list-page.tsx`) separate from detail factories
(`detail-page.tsx`) so lists do not import generic detail sections. Bind each
factory result to a module-level constant referenced by a splittable property
in the route's literal options object; loader-time helpers stay React-free in
`detail-loader.ts`.
Everything in a route file except its component and loader — `validateSearch`,
search middlewares, `beforeLoad`, `head`, `params`, and the imports they use —
ships in the app entry for every page. Those parts import only leaf modules:
an enum or id schema comes from its `*-fields.ts` module (or a dedicated
`*-search.ts`), never from a module holding read/response schemas, generated
entity field schemas, or an entity declaration. Import `@cubby/shared` through
its subpaths; the barrel re-exports modules a page does not need.
better-auth-ui's provider wraps only the auth and account views
(`app/auth/auth-ui-provider.tsx`).
App code reaches a page through its route and per-entity modules, never a
`lazy()` boundary. Load manually only (a) a heavy or browser-only third-party
library behind the interaction that needs it, (b) dev-only tooling, or (c)
code kept out of the Worker; use `browserOnlyLazy` for a component or a
per-feature `import()` at the interaction, with a one-line reason. The edit
dialog shell (`entity-edit-dialog.tsx`) is the one boundary for the editor
graph (react-hook-form, react-dropzone): import the shell statically and never
wrap it again.

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
