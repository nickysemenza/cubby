# ADR 0012: Import convergence through Burn-down

Status: Accepted.

Email, retailer history, receipts and product photos must converge regardless
of arrival order. Reuse existing Purchase identity, Product matching, source
replay and reviewed aggregate-replacement contracts. Photos establish Products
and Inventory without inventing Purchases or Expenses; later purchase evidence
can connect to those records without receiving stock as a side effect.

Competing itemizations become structured reconciliation findings accessible
through public MCP tools. During Burn-down, Claude or Codex compares evidence,
prepares a resolution and commits it, asking the member directly when evidence
leaves a material choice. Equivalent evidence adds provenance without adding
spend. Corrections and replacements preserve source observations and reject
stale proposals. Changed accepted financial facts require explicit
reconciliation; exact replay remains automatic. The server enforces identity,
money and replay contracts while the member's client supplies judgment.

A changed source is recorded as a new observation before reconciliation; it
does not refresh accepted payment evidence automatically. Commit rechecks the
accepted lines, payment evidence, allocations, identities and proposed changes
transactionally.

A reviewed commit may adopt the proposed Vendor order identity when the target
Purchase has no order ID. Preparation and commit refuse an identity already
owned by another live Purchase for that Vendor; an existing distinct target
order ID is never overwritten. Identity adoption shares the ownership and
fingerprint transaction with the reviewed ledger changes, retains original
source observations and does not receive stock. Replayed approval preserves
the resulting identity and money. Principal lines whose reviewed Product
remains unresolved retain one open Expense-keyed Product finding with the
observation's truthful Run and member ownership, including a null historical
Run when none was retained.

Sources supporting field values, import-source ownership and
execution replay remain separate authorities with distinct invariants.
Every monetary reconciliation, including attach-only association, requires
explicit USD proposal currency before numerical payment matching. Foreign or
unknown currency cannot authorize changes through a stored legacy approval.

SourceOrderObservation extraction, product bindings, checksum and content
fingerprint remain immutable; optional media FKs may be cleared only by explicit
Image deletion, and observation references prevent automatic orphan cleanup.

A historical accepted observation may be promoted only from a valid stored
original extraction whose checksum matches the accepted association. The Vendor
UUID encoded in the historical order key must equal the live Purchase Vendor or
reach it through the existing durable Entity merge redirect; promotion retains
that original Vendor UUID. An unrelated reassignment or invalid historical Vendor
remains unknown. Missing or mismatched originals remain unknown; historical
Product decisions, Run and media provenance are not reconstructed from current
ledger state. Promotion adds an observation and its accepted reference without
advancing accepted checksums or changing money or inventory.

Purchase and Vendor merges preserve observation UUIDs and use the existing
compressed Entity merge redirect to validate their live accepted association.
Fresh review follows the survivor; a review prepared before the merge is stale
and must be prepared again. Unrelated identity changes have no such redirect
and remain a refusal.

Accepted-source preparation may expand a selected item into a complete explicit
review only through unique, exact live Expense mappings, including untouched
items, tax and shipping. Finding resolutions and every commit still require the
complete roster. Untouched Products, quantities, party cents, payments and stock
remain unchanged. Historical source aliases supply immutable provenance through
their canonical owned family; reconciliation does not make aliases writable.

This uses a derived queue and bounded caller-driven batches rather than adding
an unattended reconciliation worker or a second persisted task system. Web
views expose the same findings and supported resolutions. Sources accompany
researched facts. Spend remains SUM(Expense.cost), independent of source count
and arrival order.

Wardrobe import uses this same Product and photo workflow: one Product per exact
apparel variant, explicit owned copies and locations, retained item/label
images, and tag transcription. Claude/Codex can burn down wardrobe details
through MCP just as other Product details, with Sources and direct member
questions for ambiguous evidence. Existing size/color names and printed-tag
notes remain the contract until structured apparel fields are separately
decided; enrichment does not invent purchase facts or change quantities.

Attaching labels to a reused Product has an explicit follow-up enrichment step:
read the resulting Product, preserve its notes, and patch supported facts and
verbatim tag text with Sources. A generic new-label-evidence review check keeps
unfinished transcription discoverable. Its completion is keyed to the reviewed
image/content revision, so new evidence reopens review. Wardrobe size and color
remain in the Product title; other printed tag facts remain verbatim in notes.
Queue completion means the declared checks are resolved, not that every
possible apparel detail is known.

Include import cost estimates and actual costs, distinguishing paid gateway
usage from plan-backed usage. Estimates expose their basis and uncertainty,
including missing comparable history. Jev/Clef-assisted extraction is in scope:
deterministic parsing supplies candidate values or sections, decision models
select among them, and unsupported or ambiguous extraction remains unresolved
or uses the existing appropriate import path. Do not treat a closed-set
decision as arbitrary free-text extraction. Backfill still admits nothing to
Pi or Luna/Sol until a subsequent member decision.

Persisted-state regression tests cover source arrival permutations, independent
receipt evidence, duplicate spending, provenance and interrupted retries. Small
automated Tester Army journeys verify discovery and resolution of findings and
the visible resulting state. Client acceptance never requires manual device
verification.
