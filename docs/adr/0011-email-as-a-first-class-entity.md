# ADR 0011: Email as a first-class entity

Status: Accepted.

Email is every message Cubby scans, including unrelated messages. Promote it to
the entity manifest with an `EML-` shortcode and generic list/detail access on
web, native, HTTP and MCP, replacing the earlier decision to keep Email outside
the entity model. Members need to inspect classification and import gaps even
when a message never becomes a Purchase. This extends ADR 0010 without changing
its division between unattended Mail import and interactive Burn-down.

Keep sender, subject and received date for every Email. Never retain unrelated
mail's content: bodies and attachments are retained only for related or uncertain
messages. Relevance records related/unrelated/uncertain, the deciding stage
(rule, Jev, model or member resolution), and its reason. Lists expose sender,
subject, received date, Relevance with stage and reason, status and mailbox;
filters include these dimensions and linked/unlinked.

Build the entity over the existing mailbox-message and classified-mail records,
backfilling existing rows rather than losing household history. Links remain
derived: Purchases through existing lifecycle link decisions, Expenses and
Products through those Purchases, and related Emails through a shared Purchase
or Gmail thread. Email does not introduce a second stored relationship graph.

Classification-only backfill uses rules followed by Jev/Clef, with no Luna
relevance escalation or admission to Pi. It keeps related/uncertain content and
only the Email row for unrelated mail. Jev/Clef classification and extraction
have no dollar ceiling, while execution/retry bounds and cost accounting remain.
Pi/Luna/Sol authorization remains separate. Classification and import are
separate operations, allowing members to assess Relevance before import.
A classifier-version refresh defers Emails already assigned to a frozen import
Run, including ambiguous historical assignments, before fetching from Gmail.
Their status, Run assignment, checksum, retained content and historical prediction
metadata survive unchanged; the refresh emits no model work or admission.
Provider and model calls finish before publication. Publication locks the owner,
captured Runs and Email in that order, then rechecks the captured routing state.
A concurrent import admission or member correction wins, including a correction
that keeps the same message checksum; the stale classifier publishes no content,
disposition or candidate preview. Explicit correction uses the same owner-first
lock order. Ordinary durable ingestion keeps its existing attachment policy;
the bounded transient-read and correction limits do not apply to that path.

Members may explicitly correct an unrelated Email to related or uncertain and
refetch its original from Gmail. If retrieval is unavailable, preserve the
metadata and expose the retrieval failure. Correction does not automatically
admit the Email to Pi during classification-only backfill. Paid Luna/Sol import
remains available outside that backfill; enabling it for backfill requires a
subsequent member decision after assessing classification quality and cost.

An explicit per-Email import action lets a member authorize Pi for a selected
eligible Email without enabling automatic backfill admission. Show estimated
cost before the action and actual cost afterward; expose the same operation
through MCP and the other clients. Actual cost includes every owned Run with the
matching frozen source identity and checksum, independently of the recent sample
used for estimates. Preserve the ordinary import authorization,
identity and replay checks. The automatic backfill gate stays closed.

Accuracy review lives in authenticated Email views and is accessible through
MCP, rather than requiring a separate private report file. Preserve original
predictions separately from independently reviewed labels. A sampled review
freezes the latest non-resolution prediction per owned Email, stratifies by
stage/classification/actual model including unrelated messages, and stores
each stratum's population, sample count and known inclusion probability.
The same owned-Email snapshot freezes the member Email count and the count
without an eligible prediction, including Emails whose classification is
unknown. Those Emails remain outside the classified prediction population;
reports state that undercoverage alongside conditional metrics. Later evidence
or ownership changes never rewrite the frozen counts. Earlier rosters that
never captured member-wide coverage report it as unknown. Known historical
predictions with unknown stage remain a null-stage stratum; stage, reason and
model are preserved as unknown rather than inferred.
Member-only blind reads expose public Email references and headers without
prediction metadata. Immutable grades append independent labels only when
the member proves reviewing the frozen message checksum; unavailable items
do not append labels or change effective relevance. Reports use inverse
probability weights for pipeline and exact-known Jev/Clef model-only binary
confusion matrices. Precision and recall are conditional on determinate
predictions and labels, with uncertain, unavailable, ungraded, historical
metadata, missing Email and ownership-change counts and denominator warnings.
Real message content and review records never enter the public repository.

Previously discarded unrelated messages may lack headers. Repair those headers
from Gmail during classification-only backfill; preserve explicit unknowns and
a retrieval diagnostic if the original is unavailable. Never invent metadata.

Email has one durable identity/header owner and optional content. Content
disposal preserves checksums, source identity and link/dismissal decisions.
New attachment uploads use distinct object keys. Disposal retains exact retired
keys on the attachment until storage deletion succeeds, and daily maintenance
retries them even after a member restores the Email. Delayed disposal or rollback
cleanup cannot delete bytes from a newer upload of the same attachment.
Upload reservations use the existing storage-orphan registry before writing
bytes, survive publication rollback, and are consumed by successful publication.
When a caller already owns a transaction, reservation uses a separate pooled
connection. A single-connection transaction scope refuses before uploading bytes;
walking transaction ancestry alone does not establish an independent commit.
Mail reservations have their own cleanup path, separate from signed image
uploads; cleanup holds the reservation lock through deletion. A failed key or
Email never prevents disposal of independent keys and Emails, and failures
remain retryable and visible.
An attachment deliberately promoted to independently owned Purchase/Product
evidence survives clearing an Email's content; correcting an erroneous
attachment or association is explicit reconciliation.
An accepted Purchase association is relevance evidence; an automatic unrelated
prediction becomes a reconciliation conflict rather than silently clearing
linked content.
One association resolver serves hydration, linked filters, counts and related
records. It distinguishes accepted import associations, active lifecycle links,
dismissed candidates and mailbox-scoped thread context.

Classification-only mode is persisted and enforced at classification and
admission boundaries, including retries and continuation Runs. A successful
classification does not make an Email eligible for import. Predictions are
immutable and tied to the message checksum, stage, model/version and usage
where known. Historical overwritten predictions and missing cost attribution
remain unknown; a fresh evaluation never claims to reconstruct them.

After seven days, unresolved member-search caches lose only unaccepted bodies
and unpromoted attachment files. Keep Email metadata, classification/review
history and the compact search disposition, along with accepted Sources,
Purchase links and independently owned Images. Expiry is based on explicit
search origin and expiry metadata, not unrelated updates to the Email row.
A frozen or ambiguous import assignment preserves its original body and files
until its Run is resolved; expiry cannot dispose of an admitted source.
It never deletes a message in Gmail. Later retrieval remains on demand.

Routine Runs with classification predictions, retrieval failures, candidate previews
or RunOperation receipts retain their original Run reference, even when no model
call was billed. Daily pruning never deletes that immutable history.
