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
ordinary Vendor's verified receipt senders and website domain seed exact
`from:`/domain searches; a Vendor name never becomes a free-text search, and a
Vendor without a verified sender or website waits for research. Merchant
descriptions on unallocated financial transactions seed one search per distinct
merchant; a transaction without a provider merchant searches its bank
descriptor instead, with the processor prefix (`SQ *`, `TST*`), store numbers
and trailing city/state removed (`parseBankDescriptor`). The raw descriptor
stays on the transaction, and the transaction list's processor filter derives
from it on read. Targets are recomputed on every pass; an unfinished search that is no
longer a target is dropped, and a Vendor that gains a verified sender
joins history search automatically. A newly created Brand uses that same
Vendor discovery path on the next pass, without needing a Purchase or
VendorAccount. Generic / Unbranded is excluded; its role is only Product Brand.
An explicit immediate search uses the existing Vendor mail-search action.
Targeted pages alternate with new mail;
there is no all-of-Gmail crawl, and Spam and Trash are excluded. Shared
platform domains do not identify the seller, establish purchase ownership, or
authorize an identifier issuer namespace.
Search completion describes the scope actually scanned, not proof that every
purchase from that Vendor has been found.

Each search records its finish time and the Emails its pages retained
(`completedAt`, `emailCount`); searches finished before that was tracked show
neither. The Mail import card shows, per mailbox, finished Vendor and charge
searches over today's targets only (a finished search whose target is gone
stays in the cursor but is not counted), the search in progress, the next five
queued searches, and a link to Mail import Runs that need review; it
refreshes every 30 seconds while a switched-on mailbox has searches left. The Vendor
list's derived Mail search column is done when every current search of that
Vendor has finished in every member's connected mailbox, in progress once any
has a finished page or a page token, not started otherwise, and blank for a
Vendor with no searches; the Vendor's Mail search section lists each search
per mailbox.

Discovery admits retained candidates to Pi, which imports what is unambiguous
under the writer contracts and leaves the rest in the Work queue. Keep a
minimal identity and classification footprint for scanned negatives; retain
useful related evidence and uncertain candidates for resolution.
Retained attachments and reversal or lifecycle exception evidence always go to
the coordinator, including Emails classified unrelated; neither rule shortcut
can clear those originals without review.
Original attachment reads support images and PDFs within the existing byte
limit. A generic binary content type is identified from the retained bytes;
the filename alone never establishes the format. Content-type case and
parameters are normalized for the read without rewriting source metadata.
Other formats return an explicit unsupported-reader response.
Import operation IDs identify exact requests. An unchanged retry replays its
retained result; a changed request under the same ID returns a conflict and
must use a new ID. This never replaces a saved result or relaxes source checks.
Catch-up also admits older retained related Emails in enabled mailboxes. Only
usable text or retained attachments count toward its bounded page; empty shells
and historical sources with unresolved ownership stay out. An admission failure
does not stop other sources or new-mail discovery, and retains its diagnostics.
Manual Run pauses remain active ownership: they can be resumed or cancelled,
and retain the vendor account's active-Run exclusion; catch-up never resumes
them.
A Mail import commit files supported Purchases and Product findings while
keeping the batch running; an unresolved principal line does not prevent the
next Email from being claimed. A member's own `file_import` still ends with
its commit. At Mail batch settlement, every import batch is audited, and open
commit or audit findings require review alongside any unresolved Emails.

A Mail import Run that fails on its own (its coordinator fails or aborts), or
whose coordinator stops for review before claiming every Email, returns its
still-researching Emails to catch-up once; `blocked` Emails, the review's
subject, stay. This release also applies when settlement revisits a Run already
stopped for review. An Email an earlier review or self-failed Run actually
attempted stays with the new Run: its `target_outcome` or Email claim in the
RunOperation ledger proves the attempt; roster admission alone does not.
A later completed outcome in that Run clears its earlier unsettled attempt.
This keeps repeatedly attempted, unsettled messages from spending a coordinator
every pass without pinning untouched batch members. A member's cancel keeps its Emails
with the cancelled Run. Retrying a failed Run transfers only the Emails it
still holds.
Run targets retain that Run's recorded Email outcomes. An unsettled target
now held elsewhere names the owning Run; it never inherits that Run's live
Email state or completion time.

The household AI budget is a stopgap safety net on frontier chat-model spend:
$1 per fixed six-hour UTC window (`server/ai/budget.ts`), summed from
`AiUsage`. Embeddings, closed-set decision models (Jev/Clef) and other model
roles are not budgeted, and neither is classification (mail triage and
relevance escalation). The limit is soft: usage lands after each call, so calls
already in flight can overshoot a window by their own cost. A Run that reaches
the limit pauses with `execution_limit`, and the Work queue shows it waiting on
the budget. Reclassification, suggestion sweeps and agent imports resume
through missed-work recovery once a later window has room. A member-selected
coordinator import is foreground work and is not budgeted.

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
