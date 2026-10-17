# Evidence arrives in any order

Status: agreed product direction. This journey describes the intended outcome;
current writer, source-admission and review contracts still govern available
actions. It does not establish deployed or live acceptance. GitHub Issues owns
implementation and remaining work.

Start with an Email, a financial transaction, a retailer order, a receipt, a
photo or a manual record. Cubby should connect that evidence to the same real
purchase, payment, transfer or exact Product, however the evidence arrives.
Useful work happens automatically; unresolved facts remain visible through
the [shared work model](work-queue.md).

## Discover from financial history

Resolve financial merchant descriptions to Vendors before creating Purchases
just to discover email. A processor or marketplace description is a lead, not
proof of the seller. Research uncertain vendor identity and missing websites
or logos through the shared queue. A VendorAccount records a member's vendor
relationship, not proof of a login, and is not a prerequisite for discovery.
VendorAccounts have no active/disabled status. The Mail import switch, the AI
budget and explicit Run controls own whether work can proceed.

Mail import is one switch per connected mailbox (Settings → Mail import, or
`run.set_mail_import` over MCP). While it is on, the daily discovery pass needs
no further approval: it classifies new mail across all senders, so an
unfamiliar vendor can be discovered, and pages targeted history searches. Each
known Vendor's verified receipt senders and website domain seed exact
`from:`/domain searches; a Vendor name never becomes a free-text search, and a
Vendor without a verified sender or website waits for research. Merchant
descriptions on unallocated financial transactions seed further searches.
Targets are recomputed on every pass, so a Vendor that gains a verified sender
joins history search automatically. Targeted pages alternate with new mail;
there is no all-of-Gmail crawl, and Spam and Trash are excluded. Shared
platform domains do not identify the seller or establish purchase ownership.
Search completion describes the scope actually scanned, not proof that every
purchase from that Vendor has been found.

Discovery admits retained candidates to Pi, which imports what is unambiguous
under the writer contracts and leaves the rest in the Work queue. Keep a
minimal identity and classification footprint for scanned negatives; retain
useful related evidence and uncertain candidates for resolution.

Every metered model call draws from one household AI budget: $1 per fixed
six-hour UTC window (`server/ai/budget.ts`), summed from `AiUsage`.
Classification (mail triage, relevance escalation and closed-set decision
models) is exempt and never waits. The limit is soft: usage lands after each
call, so calls already in flight can overshoot a window by their own cost. A
Run that reaches the limit stops with `execution_limit`; reclassification
pauses and resumes once a later window has budget, and the Work queue shows
why other stopped work waits. A member-selected coordinator import is
foreground work and is not budgeted.

## Follow the evidence

A delivery event can lead to its order confirmation, receipt and payment.
Within the authorized mailbox, Pi should search, open and import supporting
originals for the same purchase without requiring a person to preselect every
message. Record the source identity and checksum; a search result alone does
not prove a purchase. Contextual reading and authority to mutate remain
separate, even when both can proceed automatically.

A forwarded receipt alone does not establish the recipient's purchase or
VendorAccount. Withhold it from automatic import; explicit selection can admit
it after attribution is resolved. Retaining a separate forwarded Email is not
by itself a duplicate purchase. Equivalent sources should converge without
duplicating canonical purchases, associations or spending.

## Converge on the financial event

One bank transaction is not necessarily one Purchase. Shipment charges or split
tender can settle one order, and one payment can cover several orders. Refunds,
card repayments, reimbursements, incoming payments and account transfers keep
their own financial meanings. Venmo email and Monarch evidence belong in this
same model, rather than a separate Venmo spending ledger.

For a distinct purchase event, reuse the existing Purchase and spending first.
If no receipt is available, supported booking can establish an orderless
Purchase with aggregate spending. Later itemization should replace that
aggregate through reconciliation, preserving truthful totals and attribution.
Neither a second source nor the payment's funding leg books the spending again.

Preserve each source's original dates, names, amounts and identifiers. Posting
can change transaction observations; the two sides of a transfer can retain
different dates and descriptions permanently. Prefer provider identity links
when available. Dates, amounts and merchant similarity retrieve candidates;
one candidate or a confident model ranking alone does not prove identity.

Automatically apply uniquely supported matches, booking and itemized
replacement when identity, attribution and money reconcile under the writer's
contract. Jev/Clef can propose ambiguous relationships; review explains the
choice, supporting evidence and changes. Conflicts with accepted facts need
explicit reconciliation. [Evidence convergence](../import-evidence-convergence.md)
owns the financial rules; [Product identity](product-identity-journey.md) owns
exact variants, itemization and physical ownership.

## Finish or explain what remains

Every entry point should show the connected records, committed changes and
remaining work. A missing website can wait for Claude/Codex research; a transfer
can wait for its posted counterpart; ambiguous settlement can wait for a
decision. Independent logo research never blocks an otherwise valid import.
The shared work model owns executor routing, prerequisite explanations and
resumption after those gaps change.

Arrival, itemization and settlement do not receive or remove inventory.
Source coverage, financial correctness and physical ownership are separate
outcomes, each with its own evidence.
