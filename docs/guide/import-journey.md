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

Cubby resolves financial merchant descriptions to Vendors before creating
Purchases just to discover email. A processor or marketplace description is a
lead, not proof of the seller. Uncertain vendor identity and missing websites or
logos go to research through the shared queue. A Vendor Account records a
member's relationship with a Vendor, not proof of a login; importing purchase
evidence attributed to a known Vendor and member creates or reuses it.

## Mail import

Mail import is one switch per connected mailbox (Settings → Mail import, or
`run.set_mail_import` over MCP). While it is on, the daily discovery pass needs
no further approval. It classifies new mail from every sender, so an unfamiliar
vendor can be discovered, and searches history for each Vendor's verified
receipt senders and website domain and for the merchants on unallocated
transactions. There is no all-of-Gmail crawl, and Spam and Trash are excluded.

A shared platform sender domain never identifies the seller by itself. Confirm
an exact address on a Vendor to attribute its mail and search it; removing the
attribution records an exclusion that automatic learning cannot reverse.
Conflicting receipts mark a learned mapping disputed without rewriting earlier
Purchases.

Mail coverage and Vendor coverage show what each mailbox has searched,
classified, retained and imported. Counts can overlap across Vendors, and a
completed search describes the scope scanned, not proof that every purchase was
found. Choose a coverage row to import one Vendor's mail for a date range; that
pauses other automatic imports for the mailbox until you resume them.

Pi imports what is unambiguous and leaves the rest in the Work queue. Each
unresolved Email becomes its own Work item, routed to an agent, to you, or to
Cubby itself when it is only waiting for another source. A transient failure
retries automatically with the same model; other failures stop with the raw
error. When the household AI budget runs out, Runs pause and resume once budget
is available again.

The [purchase import service](../../apps/web/src/server/domains/purchase-import/service/README.md#mail-import-end-to-end)
owns the admission, settlement, retry and coverage contracts.

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
