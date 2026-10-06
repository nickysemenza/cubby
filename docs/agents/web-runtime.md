# Web runtime rules

Never pass fresh inline objects/arrays/functions to hook dependency contracts;
use a stable module value, `useMemo`, or the established helper. In particular,
hook-result defaults use module-level constants (not `= []`/`{}`), and
`useQueries` uses `combine` for a stable result. Prefer the existing mutation,
query-key, clipboard, form-field, database, merge, and shortcode helpers over
hand-rolled equivalents; raw mutation is reserved for the documented dynamic
invalidation/inline-error/multi-mutation cases.
For hook-default and `useQueries` examples, load the relevant heading in the
[web UI reference](web-ui-reference.md).

The server render uses TanStack Start's local function execution, never an HTTP
request to itself. Keep `~/server` imports behind the `.server()` branch of an
isomorphic function. `ssr: false` is a measured cost choice, not a correctness
workaround; a loader may await `ensureQueryData` when that latency is warranted.
Workflow streams use typed JSONL server routes and an `AbortSignal`; the owning
screen opens them explicitly rather than a generic dispatcher.

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
