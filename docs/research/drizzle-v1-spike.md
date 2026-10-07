# Drizzle v1 RC evaluation

## Decision

Keep Cubby on Drizzle ORM 0.45.2. The 2026-10-05 local experiment used isolated
ORM/Kit/Seed 1.0.0-rc.4 dependencies and disposable PostgreSQL 17.11 databases.
It did not access production or upgrade the application.

- All 17 migrations present at the tested revision converted with identical SQL.
  An existing v0 database upgraded its bookkeeping without changing the public
  catalog, preserving a synthetic Product. Fresh/repeated v1 replay matched.
- Three prebuilt predicate forms still failed against v2's relational root alias.
  An alias-bound callback worked, but needed a separate count binding. A
  plain-select control worked on both v0 and v1.
- Table-derived Zod insert schemas omit virtual inputs and declaration defaults.
  Drizzle Seed was deterministic, but generated FK links and bypassed the kernel.
  Keep declaration-backed `buildEntity`/`createEntity` and the create-shape guard.
- Representative nested reads, array/numeric/date/JSON mapping, and transaction
  rollback passed. Full schema conversion/diff generation, Better Auth,
  workerd/browser E2E, native clients, and application-wide compatibility were
  not verified.

The list fix therefore proceeds on v0: `listScaffold` selects and counts in one
plain root-table context and loads relation graphs by selected IDs. A relation
page adds one bounded read; scalar projections keep their plain select. Empty
pages and count-only reads skip relation loading and hydration. The focused
PostgreSQL regressions and the existing all-entity filter/sort matrix own this
contract. The completed experimental runner was removed.

Reconsider v1 for its named migration bookkeeping, missing-migration handling,
and cross-branch conflict detection, rather than as a list-query or factory fix.
Before adoption, verify full generated-schema compatibility and Kit diff behavior
against fresh and already-migrated scratch databases; do not rewrite committed
SQL or access production as part of a compatibility spike.
