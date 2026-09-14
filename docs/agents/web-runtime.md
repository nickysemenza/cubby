# Web runtime rules

Never pass fresh inline objects/arrays/functions to hook dependency contracts;
use a stable module value, `useMemo`, or the established helper. In particular,
hook-result defaults use module-level constants (not `= []`/`{}`), and
`useQueries` uses `combine` for a stable result. Prefer the existing mutation,
query-key, clipboard, form-field, database, merge, and shortcode helpers over
hand-rolled equivalents; raw mutation is reserved for the documented dynamic
invalidation/inline-error/multi-mutation cases.

The server render uses TanStack Start's local function execution, never an HTTP
request to itself. Keep `~/server` imports behind the `.server()` branch of an
isomorphic function. `ssr: false` is a measured cost choice, not a correctness
workaround; a loader may await `ensureQueryData` when that latency is warranted.

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
or do a naive vendor split — it drags lazy-route code into first paint.

Lists, filtering, sorting, totals, and pagination belong on the server. A saved
view is visible manifest-backed URL state; `scopeFilters` is only a visible
contextual scope. Missing filters never widen a query; renderer omissions are
server-enforced and disclosed.

For the full helper catalogue and SSR rationale, load the relevant heading in
[the preserved root reference](root-rules-reference.md).
