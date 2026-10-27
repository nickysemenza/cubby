# Entity connections

Connection discovery is an explicit mutation, usable by background work and
on-demand refresh. Reading connections reads stored Assessments only and never
calls a model. Recommendations use the existing Assessment/Feedback history;
there is no separate review ledger. A new connection always requires review.
Existing automatic domain behavior is unchanged.

## Failure modes

- A retrieved candidate keeps its pre-inference evidence through publication; a later assignment cannot be adopted as a new basis. Confirmation must still refuse an assigned or acquisition-ineligible Expense and an already acquired Product/Purchase pair, even when a supplied Assessment fingerprint matches the current rows.

- A read must not infer, publish, or spend model budget.
- Repeated discovery must reuse an identical immutable Assessment; changed
  evidence must publish a different event, preserving previous Feedback.
- Wrong grades only that event and evidence. Persistent suppression is a
  separate explicit choice keyed by relation and endpoints.
- Confirmation must refuse deleted endpoints, changed evidence, mismatched
  scope/candidate, and an unexpected fingerprint inside the caller transaction.
- Retrospective acquisition includes repeat purchases and Products already
  acquired or inventoried. Identity links alone do not prove acquisition.
- Financial matching cannot infer ownership or identity from similar names,
  payment frequency, equal amounts, or missing statement rows.
- Product identity/photo and Email events retain existing family authority.
  Twin-transaction merging remains owned by #2655 after #2656.
- A rejected domain action must roll back; successful retries use the immutable
  receipt owned by `reviewAssessment`, never an additional receipt store.
- Settlement confirmation refuses any existing live allocation under the
  transaction lock; it cannot replace a partially allocated transaction.
- Inventory placement can coalesce rows. Its immutable application receipt
  carries the source and surviving destination so clients follow the survivor.
- Work and Relations use the same evidence-currentness filter. Stale rows
  cannot consume another endpoint's result allowance.
- Background discovery publishes Assessments only inside the evaluation's
  attempt and generation fence. Candidate-roster changes invalidate negative scans.
- Discovery fingerprints include only the source's family inputs: deterministic
  candidate evidence, exact-Product stock for placement, scoped retained mail,
  and eligible target corpora for field inference and indexed/semantic retrieval.
  Unrelated families, orphaned account changes, projection rebuild timestamps,
  and inventory verification stamps do not invalidate completed scans or running
  evaluations. A target corpus can remain broad when any eligible target may be
  selected; its relevant content changes still invalidate negative scans.
  Indexed retrieval hashes cover every eligible field target, including aliases;
  Both acquisition endpoints retain their blocked counterpart set even when no
  candidate is currently eligible.
- Retained Email checksums, order events, reviewed links and accepted sources
  participate in discovery currentness, including scans with no candidates.
  Purchase account assignments and account ownership/deletion participate too.
- Field inference snapshots source and possible target rows before building
  model inputs. A selected target must match that snapshot after inference and
  again under publication locks; stale search projections cannot bless drift.
- The initiating client observes the public discovery Run through completion,
  refreshes stored proposals, and exposes stopped or failed work through that Run.
- Replacing a reviewed Email event link is an explicit consequence shown before
  confirmation; it is not a blocking contradiction.

## Interface and review

`prepareEntityConnections(db, context, source)` performs inference and returns
a publisher for the guarded evaluation transaction. `readEntityConnections`
reads typed `connectionProposal` records from stored Assessments; `readEntityConnectionsBatch`
accepts up to 250 sources and returns arrays in the same order. Public endpoints
validate shortcode ownership through `entityGraphRootSchema`, including legacy
Product and Location QR labels; the published pattern advertises canonical codes. Existing physical
connection exports in the schema module keep their original meaning.

`connectionSourceFingerprints(db, sources)` returns fingerprints in input order,
including duplicate sources. It loads each source's connection-relevant row in
one query per entity kind within that call and retains no cache across pages.
The source fingerprint hashes the same projected row as single-source reads;
batching preserves existing provenance. Per-source candidate and recommendation
evidence is still read separately. Evaluation and publication
fences continue to use a fresh `connectionSourceFingerprint(db, source)`; a page
estimate does not authorize publishing against old evidence.

The public Find connections mutation schedules a durable evaluation in the
active AI refresh generation, launches its Workflow, and returns its Run handle
alongside stored results. It requires that generation to be enabled.
Member-initiated discovery retains the initiating actor; unattended discovery
uses the reserved system actor. Coverage across every eligible record is a
[Sweep](terminology.md): one connection step whose child `ai_refresh` Run
evaluates each source not already evaluated under its current fingerprint.
Each AI-refresh discovery generation starts one routine Sweep unless one is
unfinished; a member's Find suggestions starts one with a chosen scope.
The Suggestions page, Relations on both endpoints, Work on both endpoints, and
RTable review affordances read stored proposals. RTable uses the owning field
or the endpoint's declared title column.

A proposal carries canonical endpoints, a relation, reasons, contradictions,
unknowns, its Assessment review handle and evidence fingerprint. New connections
use `recommendation` subjects with `connection.<relation>` scopes. Candidate keys
name the relation and endpoints. Changed evidence supersedes prior actionable
projections while retaining immutable history and explicit suppression. Bare
Wrong never becomes a persistent preference. Field and Email handles expose no
suppression; Product pairs retain their existing suppression contract.

Entity-pair Assessment families (`entityPairAssessmentFamilies` in
`packages/schemas/src/assessment.ts`; today only `product_pair`) declare their
relation, review integration, current-policy check and stored-reason reader in
`existing-assessments.ts`. Every pending, active, served pair under current
policy reaches Relations, including pairs that are not actionable or carry an
identity conflict: the stored evidence text is a reason, the stored conflicting
values are contradictions, and a missing exact identifier is an unknown. Member
Wrong/Dismissed feedback and suppression still exclude a pair. Proposals carry
`review.family`; on an entity list, a record with entity-pair proposals shows a
compact "Possible match" mark (named with the count and record title) in its
title cell that links to the record's Relationships section, read through the
same batched `connection.readBatch` as the row popover. The mark is desktop-row
only; phone users see the pairs in the record's Relationships section. The
Workbench match card shows the same "Not actionable" line as Suggestions for a
pair without exact-identifier admission, and keeps merge available.

`applyEntityConnection` is the recommendation handler called by
`reviewAssessment`. Payload rows are acquired before projection locks, evidence
is read again, and the active/pending projection is checked before the domain
write. The generic review handler owns the immutable application receipt and
retry. New field discovery uses the real declared inference and shared
Suggestion publisher, always pending; `assertConnectionFieldFresh` guards those
field applications before the generic handler acquires its projection lock.
Reads omit stale new proposals. Incidental timestamps and media URL changes are
excluded from connection fingerprints.

## Family behavior

- Acquisition searches existing links, indexed lexical/semantic candidates, and
  a bounded saved-notes fallback, from either Product or Purchase/Expense.
  It does not require inventory or a missing earlier acquisition. A confirmed
  connection excludes only that Product/event pair. Confirming a Purchase uses
  `confirmPurchaseAcquisition`; confirming an individual Expense uses the normal
  Expense writer. Neither operation invents an amount, quantity or stock row.
  Negative/exiting and `not_allowed` Expense evidence is excluded. A
  semantic-only hit must reach `SEMANTIC_MATCH_MIN_SIMILARITY`, and an Expense
  line naming a known Brand (a live Product's joined Vendor name) other than the
  Product's own is never proposed (`otherBrandNamed`); an unknown Brand
  on either side does not reject.
- Product identity and photo evidence use the existing identity detector,
  Product-pair Assessments and merge handler. Similarity is not merge authority.
- Expense→Project, Project→tool usage and Inventory→Location reuse existing
  recommendation policies and their normal domain writers. Suggested tool use
  still needs member confirmation.
- Task→subject Product, Product→Ingredient/Plant, Cookbook→Product and
  Device→Product use declared field inference, existing bounded rosters and
  field Assessments. Missing or conflicting identity can produce no suggestion.
- Transaction→Purchase/refund candidates use the existing settlement policy.
  Only wholly unallocated transactions are offered by this connection flow;
  editing partial allocations remains in the allocation editor. Transfers use
  the existing pairing and acceptance paths with canonical outflow→inflow
  direction. They do not infer account ownership from similar payments.
- Email→Purchase discovery starts from either endpoint and reuses bounded
  retained-event matching: order identity, or sender-proof Vendor plus amount
  and date when an order ID is missing. Subject text alone never matches.
  It publishes pending `connection.email-purchase` recommendations before any
  authority write, retaining original/event/checksum dependencies privately.
  Acceptance calls `decideEmailPurchase` with that exact retained event under
  Purchase→original→Email locks; only the owning member can accept, and agents
  use `purchase_import.mail_resolve`. Accepted import sources require reconciliation and are
  excluded. Discovery creates no retained originals/events and never publishes
  operational `email_link` decisions as pending suggestions. Twin-transaction
  merge remains unavailable here while its authoritative workflow is developed.

Assessment selection is batched. Current freshness validation also rereads
family evidence for returned proposals, so batch reads do not yet guarantee a
constant query count independent of proposal count.

Acquisition discovery sends only the identity query to lexical search. If the
identity has fewer than three characters, lexical retrieval is skipped;
description and notes remain eligible for semantic retrieval.
