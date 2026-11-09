# Entity connections

A connection is a proposed relationship between two records, stored as a
`recommendation` Suggestion whose scope is `connection.<relation>`. Reading
connections reads stored Suggestions only and never calls a model. A member's
decision stays on its Suggestion; there is no separate review ledger. A new
connection always requires review.

The only relation discovered today is the Email purchase link,
`connection.email-purchase`. Product/Purchase, Product/Expense, Expense/Project,
Project/tool, Transaction/Purchase, refund and Inventory/Location discovery were
removed ([#3899](https://github.com/nickysemenza/cubby/issues/3899)): their model-backed
passes proposed tens of thousands of connections and applied one. Field
suggestions (Task subject Product, Product Ingredient or Plant, Device Product)
come from field suggestions and Sweeps, not from a connection pass.

## Discovery

Email→Purchase discovery starts from either endpoint and reuses bounded
retained-event matching: order identity, or sender-proof Vendor plus amount and
date when an order ID is missing. Subject text alone never matches. It is
deterministic SQL over the Email purchase evidence policy: no model, no Run and
no evaluation.

- The hourly `email-purchase-discovery` drain walks Emails whose retained
  evidence suggests a purchase link (see [Jobs](../jobs.md#producers)).
- The `connection.discover` mutation (agents: `entity_graph.discover`) runs the
  same discovery for one Email or Purchase and returns its stored proposals.
  Other record kinds return their stored proposals unchanged.
- Discovery publishes pending `connection.email-purchase` recommendations
  before any authority write, retaining original/event/checksum dependencies
  privately. It creates no retained originals or events and never publishes
  `EmailPurchaseDecision` rows as pending suggestions.

Acceptance calls `decideEmailPurchase` with that exact retained event under
Purchase→original→Email locks; only the owning member can accept, and agents use
`purchase_import.mail_resolve`. Accepted import sources require reconciliation
and are excluded. Replacing a reviewed Email event link is an explicit
consequence shown before confirmation; it is not a blocking contradiction.

## Failure modes

- A read must not infer, publish, or spend model budget.
- A retrieved candidate keeps its pre-inference evidence through publication; a
  later change cannot be adopted as a new basis.
- Repeated discovery must reuse an identical Suggestion; changed evidence must
  publish a different one, preserving any decision on the previous one.
- Wrong grades only that event and evidence. Persistent suppression is a
  separate explicit choice keyed by relation and endpoints.
- Confirmation must refuse deleted endpoints, changed evidence, mismatched
  scope/candidate, and an unexpected fingerprint inside the caller transaction.
- A rejected domain action must roll back; successful retries use the immutable
  receipt owned by `reviewSuggestion`, never an additional receipt store.
- Retained Email checksums, order events, reviewed links and accepted sources
  participate in currentness, including when no candidate exists. Purchase
  account assignments and account ownership/deletion participate too.
- Work and Relations use the same evidence-currentness filter. Stale rows
  cannot consume another endpoint's result allowance.

## Interface and review

`readEntityConnections` reads typed `connectionProposal` records from stored
Suggestions. Public endpoints validate shortcode ownership through
`entityGraphRootSchema`. Existing physical connection exports in the schema
module keep their original meaning.

A proposal carries canonical endpoints, a relation, reasons, contradictions,
unknowns, its Suggestion review handle and evidence fingerprint. Candidate keys
name the relation and endpoints. Changed evidence supersedes prior actionable
projections while retaining immutable history and explicit suppression. Bare
Wrong never becomes a persistent preference. Field and Email handles expose no
suppression; Product pairs retain their existing suppression contract.

`applyEntityConnection` is the recommendation handler called by
`reviewSuggestion`. Payload rows are acquired before the Suggestion lock,
evidence is read again, and the active/pending status is checked before the
domain write. The generic review handler owns the immutable application receipt
and retry. Reads omit stale new proposals. Incidental timestamps and media URL
changes are excluded from connection fingerprints.

Entity-pair Suggestion families (`entityPairSuggestionFamilies` in
`packages/schemas/src/suggestion.ts`; today only `product_pair`) still reach
Relations, so a record with a pending pair shows a compact "Possible match" mark
that links to its Relationships section. Member Wrong/Dismissed feedback and
suppression still exclude a pair. The AI product-identity evaluator that used to
produce those pairs was removed; pairs now come from deterministic import-time
matching and the `product_enrichment` propose action.

Email→Purchase recommendations come from a deterministic drain, with no model,
Run or AI evaluation: bounded retained-event matching by order identity, or
sender-proof Vendor plus amount and date when an order ID is missing. Subject
text alone never matches. An order id naming exactly one eligible Purchase is
linked automatically instead ([Emails sections](../entities.md#one-declaration-several-consumers));
an amount match or an order id shared by several Purchases stays a pending
`connection.email-purchase` recommendation. Acceptance calls
`decideEmailPurchase` with that exact retained event under
Purchase→original→Email locks; only the owning member can accept, and agents use
`purchase_import.mail_resolve`.
