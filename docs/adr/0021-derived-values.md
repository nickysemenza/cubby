# ADR 0021: Derived values

Status: Accepted; implementation tracked in #3309. Amends
[ADR 0015](0015-unified-durable-work-coordination.md): the `refresh.family`
passes and `derived_refresh` Runs it coordinates are retired.

## Context

Cubby computes many values from other data, each with its own machinery:
stored quality (`EntityQuality`, `EntityQualityCheck`) refreshed by a broad
family pass; effective inherited fields compiled to recursive SQL on every
read, filter and sort; valuations and kit pricing that value the whole
inventory in TypeScript before a Location or Inventory page query; recipe
totals and search documents with their own hashes; display images resolved
per page; and AI evaluations queued as one row per input fingerprint, with
supersede and reopen chains.

The cost showed up in two ways. About half of the background-work PRs merged
between 2026-10-21 and 2026-10-25 patched these mechanisms rather than
behavior: duplicate fingerprint rows (#3305, #3295, #3176), shared family
contention and restart starvation (#3302, #3281, #3301), and a stored versus
live quality split (#3193, #3205, #3214, #3217). Lists also stayed slow: the
read-layer work (#3291, #3304) measured Location and Inventory pages at 7 and
6 sequential round trips, and Product price, Project dates, Expense project and
display images at 170–730 ms each, and named a stored projection as the fix.
Progressive list loading exists only to defer these columns.

Earlier derived fanout triggers walked dependents inside the save transaction
and turned one Product save into a 115–147 second rollback; #2855 removed them.

## Decision

- **One concept.** A derived value is any field whose value does not come from
  the member typing it. Its field declares it once with `derive`: ordered
  levels (own, accepted suggestion, inherited, default, pending suggestion),
  a compute adapter (compiled SQL or a registered TypeScript batch function),
  `store`, declared `inputs`, and `rulesVersion`.
- **A disposable cache.** Stored derived values can be truncated and rebuilt
  without loss. Overrides, explicit None, waivers, accepted Suggestions and the
  AI response cache are inputs, never derived rows.
- **Store what folds across rows.** Values that walk a subtree or fold related
  rows, need TypeScript or WASM, or cost money are stored in one
  `DerivedValue` table, with generated expression indexes where lists sort or
  filter. One-hop lookups and indexed rollups stay compiled inline
  (`store: false`) when the list round-trip evidence shows them cheap. Quality
  moves into `DerivedValue`.
- **One envelope.** Values keep their field slot; a per-row `derived` sidecar
  carries state (fresh, stale, missing, waiting, failed), `decidedBy`
  provenance and `asOf`, replacing `fieldResolutions` on web, Apple and MCP.
- **Triggers mark, never expand.** Generated row triggers, guarded by changed
  declared input columns, upsert one `DerivedDirty` row for the written record
  and its own old and new relationship endpoints, with a sequence ticket. They
  never query dependents. No-op saves mark nothing.
- **One drain.** A single `derived.drain` Job kind claims dirty rows in
  batches, computes each field set-based, publishes only changed values, then
  marks dependents of changed values. It clears a dirty row only when its ticket
  is unchanged. Member edits go first; an hourly reconciliation of one 24th of
  the records (each record daily) and a CI read-set check cover undeclared
  inputs.
- **AI work has one slot.** Each (record, feature) owns one slot, keyed by a
  hash of its declared input projection; reverts reuse the response cache.
  High-confidence suggestions on descriptive fields decide at read time as
  `auto` without writing; money and identity fields keep explicit writes.
- **One explanation surface.** Clients render the envelope: a cell mark for
  inherited and auto values, an immediate updating dot, and one popover with
  the decision chain and stored versus live values. The drain rings the
  existing doorbell after each publication.

## Considered options

- **Postgres-native typed companion tables and SQL drain**: Hyperdrive rejects
  LISTEN/NOTIFY and Neon blocks PLV8, so TypeScript quality, WASM valuation and
  AI work cannot live in the database; most code would sit outside the design.
- **Keep inherited values and valuations live**: always fresh, but the measured
  list exceptions and the whole-inventory pre-pass remain.
- **Application change registration**: writers forget to register and no-op
  saves register anyway (#3281, #3287).

## Consequences

The `refresh.family` passes, `derived_refresh` Runs, family enrollment in
`recordChange`, quality publication, fingerprint supersession, read-time
valuation preparation, `fieldResolutions` and progressive list loading are
removed. Stored values can lag a save by seconds and show an updating dot;
sorts and filters read the stored value meanwhile. Correctness depends on
declared inputs, which the read-set check and reconciliation guard.
