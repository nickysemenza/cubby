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
Linked/unlinked checks use the same accepted-source and active lifecycle-decision
policy as the Purchase association list, but may stop at the first matching
Purchase rather than enumerate and deduplicate all associations.

Classification-only backfill uses rules followed by Jev/Clef, with no Luna
relevance escalation or admission to Pi. It keeps related/uncertain content and
only the Email row for unrelated mail. Jev/Clef classification and extraction
have no dollar ceiling, while execution/retry bounds and cost accounting remain.
Jev receives bounded sender/domain and subject hints, plain text alongside
distinct readable HTML text, body head/end excerpts and attachment descriptors.
Whenever HTML is present, the input also keeps
bounded link labels and destinations, image URLs and alternative text, and raw
JSON-LD excerpts from the existing page condenser. These remain untrusted evidence;
clipped structured data is an excerpt, not a parsed order. The serialized view stays
within its context budget and marks omitted evidence explicitly. Definite Jev/Clef
decisions are honored; the exception-only Luna path retains uncertainty when a
negative lacks required evidence. Discarded layout markup alone does not make
evidence incomplete; retained originals and checksums remain complete. Sender
domains never establish Purchase or Vendor associations.
The exception-only Luna relevance path may acquire content images selected by
that compactor when labels alone cannot explain them; tracking pixels are excluded.
Responsive images inside hidden containers use the same bounded image path as
visible images, preserving their labels and sources rather than declaring them
lost. Unresolved sources, image overflow and omitted hidden transaction text
still report missing evidence; non-content script/style/template trees stay excluded.
Guarded HTTP retrieval rejects private destinations. Optional remote-image
failures leave evidence incomplete with diagnostics without aborting the batch.
Gmail success JSON is bounded at 36 MiB before parsing, accommodating Gmail
envelopes and preserving original retention independently of model admission. Decoded original
mail and acquired attachment/remote-image evidence share a 3 MiB acquisition
budget, with at most six supplied images. Local Worker-only Rust/WASM codecs produce full-frame JPEG renditions
(no public upload or Images binding): standard 1280 by 2048,
or one requested detail attempt at 2048 by 4096, each at most 128 KiB.
An oversized encoding gets a lower-quality encoding at the same dimensions,
then one smaller rendition (960 by 1536 standard, 1280 by 2560 detail) before
being marked unavailable. PNG/JPEG/GIF images use local resizing; bounded JPEG and WebP originals are
supplied without decoding or re-encoding, and need no detail retry. Oversized
WebP remains missing evidence. Animation and
other formats remain missing evidence. Before local decoding, refuse sources above
6 million pixels, 8192 pixels on either axis, or 24 MiB of decoded samples.
PNG decoder allocations request a 24 MiB limit. JPEG admission separately reserves
16 bytes per MCU-padded pixel within a 48 MiB working-storage estimate; metadata
and row buffers add overhead, and the codec output limit alone is not a hard cap.
Use unmodified codec dependencies; do not vendor or patch them to turn decoding
into an integrity proof. Ordinary decode errors remain missing evidence, and the
model still judges readability. JPEG encoding uses streaming 4:2:0 subsampling
with full-frame spatial dimensions. Block-average thumbnail resizing
allocates its output without a full-frame float scratch image. JPEG output writes
to a bounded buffer. At most six initial preparation attempts are allowed, including
renditions later rejected by request admission; one detail attempt reuses each
supplied source.
These per-image limits complement the aggregate acquisition budget. The complete
serialized feature request is bounded at 256 KiB; provider envelope/schema overhead
is outside that accounting. The model reports image readability. A still-unreadable
or omitted image cannot justify a negative, while an independently established
purchase stays related. Existing classification reasons include aggregate image,
source-byte and request-byte diagnostics. Remote pixels are transient, not retained
attachments; original attachment retention remains independent of model renditions.
The Email Review section and MCP `imports_read.mail_triage_preview` invoke the
same explicit classification preview: refetch Gmail, run Jev/Clef, and run Luna
only after uncertainty, using the production image preparation and completeness
guards. The response separates the initial decision from the final outcome and
includes image counts, byte sizes, refusal diagnostics, readability, detail retry,
elapsed time and priced usage (unpriced costs stay unknown). The UI folds these
diagnostics under Technical details. Usage telemetry is asynchronous: missing
call receipts leave costs unknown with accounting pending, never a false zero;
the diagnostic Run exposes usage after its telemetry arrives. A preview records only its diagnostic Run
and model usage; it publishes no Email classification, observation, retained
content, import or member grade. Existing Gmail execution approval is required;
preview never grants import authority or bypasses paid-request admission.
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

Accuracy review lives in the Emails list's Accuracy view and is accessible
through MCP, rather than requiring a separate private report file. Each Email's
detail shows only its own Email pipeline (retrieval, rule, Jev, relevance model,
member review, extraction preview, import Run and linked Purchase, each ran,
skipped, not reached or failed) and links to that view. Preserve original
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

A member may Reclassify up to 200 owned Emails at once. One Run per mailbox
(a `mail_reclassify` Run with a frozen Email roster, bound to that mailbox's
backfill or continuous execution approval) reruns rule, Jev and the relevance
model even under classification-only policy, refetching each original from
Gmail. The rerun is always recorded as a prediction, but it never becomes the
Email's processing Run and never admits import. Unaccepted retained negatives
settle automatically through the protected original-disposal writer. Completed
or researching imports keep their Relevance until member acceptance. Unreadable
refetches cannot discard an earlier retained original. Accepted associations,
member resolutions and independent reviews of the same checksum are never
discarded by a negative rerun. A rule, Jev or model prediction that
disagrees with the member's resolution or latest review of the same checksum
records a `member_review` conflict. The request always returns Run references;
Cloudflare Workflows finishes the roster with bounded retries and exact publication
receipts. Each target follows current evidence, with bounded restarts before a
linked delayed continuation, so a changing Email cannot starve its roster. A
usable bound approval stays bound; otherwise execution selects the newest
applicable approval and retains the switch audit. Missing authority pauses work
until an approval wake or reconciliation can resume it.
Metered fallback refusal also pauses the roster without consuming a target retry.
Recovery checks the denied request's quoted allowance against current-period
reservations before selecting authority; a replacement approval or a renewed
continuous budget can resume it, with the binding switch retained in the audit.

Run reads expose per-Email receipts and linked continuation Run references.
Discovery Run reads also page through handling receipts, including reused
classifications, with ownership and outcomes at handling time alongside current
Email state. These receipts share the Run request ledger. Historical coverage
uses only stored receipts and immutable observations and is explicitly incomplete
when handling membership was not recorded; an Email's current processing Run
does not establish historical membership. Audit reads never replay classification
to fill missing history.

Historical `deferred` and missing outcomes are reconciled into linked continuation
Runs without rewriting original Runs or receipts. Recovery has no age cutoff; it
checks current eligibility, ownership and authority, skips cancelled, already
fulfilled and known permanently failed targets, and permits bounded reinference
when publication remains unknown. Observations alone do not prove publication.
The shared durable execution decision is [ADR 0015](0015-unified-durable-work-coordination.md).

One shared predicate drives the list's
review-conflict filter and saved view, and the Accuracy view counts conflicts
by stage and model. Email quality scores these pipeline gaps per Relevance:
undecided, unreviewed, missing original, missing preview and not imported;
settled unrelated Emails need no member review and leave the operational queue.
Their prediction history remains eligible for independent accuracy sampling.
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

Addendum (Emails sections): the derived links are declared as `derived`
relationships (Purchase, Vendor and Vendor Account `emails`) over Email list
filters, still storing nothing of their own. Reviewed decisions record who
proposed each link (`proposedBy`); that column describes the existing decision
rows and adds no relationship. A member's Link marks the Email related as a
member resolution, since a reviewed Purchase link is relevance evidence.
