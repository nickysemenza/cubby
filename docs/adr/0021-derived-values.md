# ADR 0021: Derived values

Status: Accepted; engine implementation tracked in #3309, unified field
contract and editing experience in #3324. Amends
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
- **One computation can publish several fields.** The entity manifest owns a
  typed result schema, watched inputs, storage policy, scalar projections and
  explanation bindings. A batch adapter retains canonical domain policy; the
  existing drain publishes its payload, provenance and projections together.
  Contextual fields can fold those published facts with current eligibility and
  scope, while keeping their result revision attached to explanations.
- **Missing results leave membership unresolved.** Lists distinguish certain
  matches from candidates whose required computation is unavailable. The same
  predicates drive rows, selection IDs and counts. Members can inspect unresolved
  candidates under the original filters. Missing contributions make totals
  incomplete rather than zero; a published empty result remains a known outcome.
- **Store what folds across rows.** Values that walk a subtree or fold related
  rows, need TypeScript or WASM, or cost money are stored in one
  `DerivedValue` table, with generated expression indexes where lists sort or
  filter. One-hop lookups and indexed rollups stay compiled inline
  (`store: false`) when the list round-trip evidence shows them cheap. Quality
  moves into `DerivedValue`.
- **One typed field envelope.** Governed and derived values live under the
  record's `fields`, each with three independent parts: current authoritative
  assignment and permitted actions; an effective result paired with its own
  provenance; and background-work status. Ordinary fields remain simple.
  Generated schemas preserve each field's stored and effective value types.
  This replaces both `fieldResolutions` and the `derived` sidecar across web,
  Apple and MCP; it supersedes the original ordinary-slot-plus-sidecar design.
  A cached result and its provenance describe one computation. Current saved
  intent, receipt ownership and action eligibility never come from that cache.
- **Intent is independent of outcome.** Inherit, explicit value and explicit
  None are distinct saved choices; allocation is an effective result mechanism,
  not a saved assignment mode. Empty outcomes distinguish None, unset, blocked,
  mixed and inapplicable. Missing means that no computation exists. Refresh
  failure or waiting can coexist with either an old usable result or no result.
  An own assignment that decisively wins updates the effective value
  immediately, with the same precedence used by filtering and sorting.
- **Reset follows sources.** Use inherited removes the override; Keep this
  value creates an explicit assignment. Reset displays a valid fallback or
  Updating, never the removed override relabeled as inherited. Actionable reads
  expose current eligibility; exact fallback previews and explanation evidence
  load on demand. Writes revalidate policy through the existing commands.
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
  Descriptive fields stay hands-off through the existing Automatic rules,
  which apply high-confidence additions to declared fill fields with receipts;
  receipt and audit evidence establishes which current values those rules
  own. Member edits and same-value confirmation end automatic ownership
  immediately. There is no `automaticFields` cache or dirty target; the cutover
  retires those disposable rows while retaining receipts and audit evidence.
  Money and
  identity fields keep explicit writes. (Revised during
  implementation: deciding at read time without a write would have duplicated
  the Automatic rules and their receipts.)
- **Valuation and descriptive Cost are distinct fields.** Product `price` keeps
  numeric valuation and its existing assignments; it is inapplicable to services.
  Readonly `cost` describes an item amount or a service charge average with its
  matching count and latest charge. Physical Cost projects the complete selected
  price result, provenance and work instead of maintaining a second price cache.
  Service Cost publishes its tuple atomically. Cost sorting uses that same
  selected result; valuation-presence filters and the Item prices footer exclude
  services. Live charge evidence remains on demand, never a competing display
  amount. Old scalar price caches cannot establish a historical service tuple.
- **One explanation surface.** Clients render the envelope: a cell mark for
  inherited and auto values, an immediate updating dot, and one web popover or
  native sheet/popover combining current assignment, permitted edits and source
  evidence. One source-stack primitive renders ordered deciding, skipped and
  blocked levels with specialized reference, category or image-strip content.
  Image stacks are view-only. Multi-source allocations retain contributor
  semantics rather than inventing a single deciding record. Live comparisons
  are explicitly distinguished from the historical provenance of cached results.
  The drain rings the existing doorbell after each publication.

## Considered options

- **Postgres-native typed companion tables and SQL drain**: Hyperdrive rejects
  LISTEN/NOTIFY and Neon blocks PLV8, so TypeScript quality, WASM valuation and
  AI work cannot live in the database; most code would sit outside the design.
- **Keep inherited values and valuations live**: always fresh, but the measured
  list exceptions and the whole-inventory pre-pass remain.
- **Application change registration**: writers forget to register and no-op
  saves register anyway (#3281, #3287).
- **Keep effective values beside a metadata sidecar**: this leaves the
  relationship between a value and its provenance implicit. Extending that
  sidecar with the old edit object also lets cached metadata obscure current
  assignment intent. #3324 chooses concrete field envelopes despite the larger
  cross-client migration.

## Consequences

The `refresh.family` passes, `derived_refresh` Runs, family enrollment in
`recordChange`, quality publication, fingerprint supersession, read-time
valuation preparation and progressive list loading are removed by the engine
work. #3324 completes the separately tracked field contract migration, removing
`fieldResolutions`, the `derived` sidecar and their duplicate presentation
adapters. Stored results can lag a save and show an updating indicator; sorts
and filters use the same effective result, including decisive current own
intent. Correctness depends on declared inputs, which the read-set check and
reconciliation guard. #3338 extends materialization to ownership, beneficiary
seeds, Project and Shipment folds, and reusable Email facts. Task inheritance
continues to use generated live resolution declarations. Financial allocation,
write validation and household-date comparisons remain authoritative live policy.
Detailed query/latency and catch-up measurement follows the functional cutover
in #3420; the five-second dependent-publication target is not established by
functional tests. Image list loading optimization remains #3325.
