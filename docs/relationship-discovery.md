# Relationship discovery and suggestions

Relationships are shared by the web interface and the iOS/macOS apps through
the ordinary operation contracts and `/api/v1`.

## Discovery

`entity.explore` takes an entity reference and a depth of one, two, or three.
It reads the manifest-backed graph breadth-first and returns its nodes, directed
edges, branches, explanatory paths, and completion state. A hop is a displayed
entity relationship; a derived relationship retains its declared provenance.

Each branch contributes its first 12 records. The result retains `nextOffset`
for explicit paging through `entity.graph`; expanding more levels does not
silently exhaust a large branch. Reads use batches of up to 25 roots, with
aggregate ceilings of 500 records, 1,000 edges, 32 reads, and ten seconds.
Completion distinguishes exhausted exploration from depth, pagination, and
budget limits. Returned paths are explanatory paths through the explored
records, not a claim that an unsearched branch has no shorter connection.

Existing `entity.graphPaths` remains the destination-path search. Ordinary
relationship cycles are valid. All traversal uses the existing live-record
filters, including intermediate tables.

## Suggestions

`recommendations.forEntity` returns a source reference, a source-context
`basisKey`, and typed groups. Discovery continues to work independently when
recommendations or a similarity index are unavailable.

- **Expense projects:** candidates overlap the expense date, exclude the
  current project, and rank by same-trade principal expenses, then exact-product
  principal expenses, then the narrower date window, name, and identifier.
  The reviewed expense is excluded from history and derived dates before
  ancestor windows are folded. Explicit date overrides still win. At most
  three candidates and three linked supporting expenses per candidate are
  returned.
- **Inventory placement:** the existing parked-stock rule applies unchanged:
  stock in Unknown earns a suggestion only when the exact product has one
  unambiguous other live stock destination.
- **Product relatedness:** the existing semantic candidates and shared-tag
  evidence remain discovery, with their existing similarity readiness state.

Graph proximity alone never enables a write. An expense project proposal uses
the existing expense update; inventory placement uses the existing move
operation. Both require explicit acceptance, preserve the proposal on failure,
and refresh affected views after success. A changed source basis clears an
outstanding proposal. When an inventory move coalesces stock into an existing
row, both clients follow the surviving row and replace the deleted source
in navigation.

## Client contracts

Web inline previews and the full Relationships section share the same query
result. Swift maps generated OpenAPI payloads into CubbyKit relationship
models; ranking and eligibility are not reimplemented on device. Native graph
and list views share selection and loaded data. Graph state is local to the
active view and is not persisted across launches.

The cross-client wire example lives in
`packages/schemas/fixtures/relationship-discovery.json`. Zod and Swift mapping
tests consume that same file to guard path and recommendation interpretation.

The endpoints are additive. Deploy the server contracts before dependent
native app releases. No database migration is required.
