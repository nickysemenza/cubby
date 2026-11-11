# Purchase import: Mail import, member imports and Burn-down

[ADR 0010](../../../../../../../docs/adr/0010-mail-import-unattended-burn-down-interactive.md)
splits purchase work in two (vocabulary: [terminology](../../../../../../../docs/guide/terminology.md#purchase-research)):

- **Mail import** (unattended): Gmail discovery classifies and retains order
  Email, and a Pi agent turns it into Purchases, Expenses, Product resolutions
  and Email links. It reads only Email; there is no browser and no web search.
- **Burn-down** (interactive): a member's Claude or Codex session works the
  Research queue (the `research-queue` saved views over existing data-quality
  gaps) with its own browser, writing through ordinary MCP writes that retain
  research in editable notes.

Both use the same public tools. Cubby owns ownership, retained-Email checksums,
replay, identifier collisions, money conservation, stock neutrality and safe
writes; the caller owns research and judgment. An absent caller leaves work
pending: nothing here starts Product research.

## Mail import, end to end

1. **Discovery** pages a connected mailbox, classifies each message and retains
   related originals.
2. **Admission** freezes up to 50 Emails into one `mail_import` Run and
   dispatches its coordinator.
3. **The coordinator** (the [purchase agent](#purchase-agent)) claims each
   Email; the [Mail import rule](#mail-import-rule) settles the ones it can
   decide without a model turn.
4. **Writes** import orders, link lifecycle Emails and dispose of unrelated
   mail through public MCP actions.
5. **Settlement** reconciles the Run, retries transient failures and leaves
   held work for review.

Mailbox admission, paging and recovery semantics are in
[Mailbox admission and coverage](#mailbox-admission-and-coverage); the Job
contract underneath is [Durable Jobs](../../../../../../../docs/jobs.md).

### Discovery and classification

Discovery (`gmail/discovery.ts`, the `MAIL_DISCOVERY` Workflow) pages a
connected mailbox (`-in:spam -in:trash`), freezes each provider page in
`Run.progress` (its message ids, history events and only the coverage positions
it advances, never the mailbox's whole query roster), and replays it until its
page commits; the checkpoint rebases those positions onto the cursor's current
coverage. `gmail/ingest.ts`
classifies each message (`gmail/triage.ts` rule/decision model, then
`gmail/relevance.ts` for uncertain mail) and records the deciding stage and
reason on `Email`. Confident positives proceed to extraction/matching; only
uncertain relevance reaches the relevance fallback. Related originals become
`OrderMail`; unrelated mail keeps only its provider identity. Coverage is
checkpointed with a compare-and-swap in the same transaction as the page's
events (`gmail/persistence.ts`).

Jev and Clef own their decisions: bounded-view incompleteness is sent to the
model and reported in previews, but does not replace a definite choice with
uncertain. Negative decisions still require high model confidence. Missing or
incomplete original body bytes remain a rule exception before inference; model
abstentions reach the relevance fallback, which uses the same Email compactor
(including preheaders) and keeps its missing-evidence guard.

Relevance rules:

- Related evidence concerns the recipient or household, including forwarded
  confirmations; newsletters about an author's or other people's shopping are
  unrelated. Recommendations explicitly confirming a named product the
  recipient bought or returned remain related; campaign metadata alone does
  not supply that confirmation.
- Gift thresholds, shipping benefits, generic order or security assurances and
  back-in-stock notices do not confirm a transaction; omitted promotional
  labels alone do not require abstention. The prompt requests uncertainty when
  body text is clipped without visible confirmation, since the purchase-cue
  scanner does not cover every transaction phrase.
- Hidden images at most one pixel in both dimensions are tracking metadata;
  their bounded labels stay in the model view as readable metadata (including
  explicit transaction confirmations), and surrounding links still participate
  in evidence checks. Omitted or clipped pixel labels keep incompleteness;
  larger hidden pictures keep their guards.
- Accessibility-only `aria-hidden` does not hide visually rendered text or
  pictures; actual CSS visibility and `hidden` attributes do. Hidden HTTP(S)
  links and their labels stay in the bounded link set; omitted cue-bearing
  links and cues lost during URL normalization mark evidence incomplete. Hidden
  receipt text marks evidence incomplete only when the visible text and
  preheader do not repeat its purchase cues (responsive mobile/desktop
  duplicates are complete).
- Referenced `cid:` pictures count as available only when their exact MIME
  Content-ID image bytes fit and reach the relevance interpreter; missing,
  unsupported or oversized parts remain incomplete.

An unattended retained page whose exact search already completed in newer
coverage settles its processed messages without rewinding or crediting that
search twice. Member-controlled scans still refuse changed selected coverage.
Fresh automatic discovery and its continuations yield the mailbox slot to a
retained scheduled discovery whose failed execution has a runnable recovery
Job. The existing Job keeps its backoff, frozen scope and evidence; only its
current fenced claim restores the Run. Paused, cancelled, retired or superseded
work does not reserve this recovery admission, and explicit paid launches keep
their funding admission.

### Mailbox admission and coverage

Mailbox discovery admits at most four independent targeted searches per member
and mailbox. Each Run keeps the complete frozen query roster and a stable
selected query resource. History and controlled scans own the whole mailbox.
Short admission transactions coordinate resource conflicts, and a database
guard preserves the capacity and exclusion rules. Only current
connected-mailbox discovery reconciles the canonical query roster; individual
query lanes cannot prune or restore other objectives.

An accepted retained Retry keeps its Run, frozen page and canonical Job. If its
resource is occupied it reads as queued automatic work, using the paused state
with a specific admission reason, and its fenced Job claim admits it later.
Repeated capacity deferrals consume no failure attempts.

- Eligible recovery or an older yielded query reserves one vacancy; fresh
  continuations cannot strand a parked page. Recovery query owners use at most
  three slots. Only a recovery with available recovery capacity and an
  unoccupied resource reserves a vacancy, so blocked recovery cannot strand the
  normal lane. Eligibility includes the candidate's own reservation: a younger
  same-query waiter cannot take its older owner's vacancy.
- An exclusive waiter stops fresh admissions until existing owners drain.
  Normal history demand coalesces into one queued Run; its older exclusive
  request also drains query owners instead of waiting behind recovery
  callbacks.
- Running owners renew admission at the next Job claim, without interrupting
  an in-flight request. An owner restored from the queue performs one Job
  quantum before renewing again, preventing pause/resume livelock.
- A targeted page can park between five-message batches while retaining its
  position against same-query demand; ambiguous or same-query waiters keep that
  page exclusive until it checkpoints. History pages yield only after their
  entire provider page checkpoints, and controlled scans keep exclusive
  ownership.
- Ordinary mailbox owners execute history only, even if the shared cursor would
  otherwise select a scan. Their internal scope pins that mode; initialization
  and unscoped retained work keep conservative mailbox ownership without
  changing their frozen pages.
- Yielding preserves the frozen page, cursor, generation, attempts and funding
  deadline; its new FIFO request lets already queued owners proceed.

Creation, generation and wake intent commit together. A manual paid-start
action grants one Run's allowance and never duplicates it across parallel
lanes. Cancellation removes demand, and a missing or terminal Job leaves the
Run visible for recovery instead of hiding it as an automatic wait.

Discovery acquires at most five messages from its frozen provider page per Job
claim. Each lane fetches and publishes in source order without buffering
several full originals, and each claim runs in its own permit with that
permit's two database sockets. A durable message offset resumes the remaining
messages without replaying the completed prefix; an absent offset on a
retained page means zero.

Gmail throttling and transient provider failures retain their raw diagnostics
and retry time. The mailbox cursor shares that cooldown across independent
clients; a Job defers before another provider request without spending
attempts. Throttling and server responses with Retry-After reach the shared
cooldown owner before any further HTTP attempt, beyond the client's short
in-call retry bound; only server failures without a deadline retry within the
client. An aborted discovery database snapshot or lock/capacity conflict defers
the canonical Job with its original cursor and failure allowance. Raw database
diagnostics remain in workflow logs; cancellation and lease loss still stop
that invocation instead of creating new demand.

Mailbox coverage advances only after every batch and history event is handled.

- A retained automatic history page can settle against a newer completed
  history cursor under the same baseline when its numeric ID covers the entire
  frozen range. It preserves all newer coverage; an in-flight token alone or a
  controlled scan cannot authorize this.
- When a frozen page is retried after another pass, its checkpoint preserves
  the latest unrelated searches and history. A stopped member-controlled query
  pruned by a later pass can be restored from that Run's frozen scope.
- An unattended targeted page whose messages are all handled may settle against
  a different partial position for the same query and baseline, or after that
  search is pruned, preserving current coverage and adding no shared counts. A
  pruned search stays absent; settling the handled page does not restore it. A
  continuation carries only unchanged searches still present in coverage.
- A controlled page, changed query or baseline, and an identical token with
  rewritten metadata refuse rather than overwriting coverage. Opaque tokens
  establish no order; a reset position can enumerate that range again through
  idempotent ingestion.

Import admission commits child dispatch intent atomically. An already-failed
child remains visible for its own retry and does not fail discovery or rewind
the mailbox page. Automatic continuations defer to an existing funding-paused
discovery for the same member and mailbox. Completing a retained page leaves the
next acquisition with that owner and its existing resume Job. Continuation
idempotency uses `mailbox-continuation:<completed Run id>`; descendant
readbacks must follow that key as well as explicit parent links. The Run
completes its one page, not the whole query. Targeted pages carry no history
events, so history recovery still requires its numeric coverage proof.
Discovery page and completion receipts use the universal Job generation,
matching the progress owner's fence.

Job logs report Mail phase durations for listing, fetching, acquisition,
classification, attachments, candidate previews, evidence publication,
progress, import admission and checkpointing. Acquisition includes its nested
classification, attachment and publication phases, so these durations must not
be added together. Timings accumulate across the messages one claim handles,
include awaited I/O and failed work, and contain only static phase names and
milliseconds; they measure neither Worker CPU nor heap. Job `dueLagMs` is claim
time minus the stored `availableAt`, clamped to zero; on an expired-lease
reclaim it includes the previous invocation and lease wait.

### Reclassification

A member's **Reclassify** (`gmail/reclassify.ts`, MCP
`purchase_import.email_reclassify`) reruns these stages, including the
relevance model, for up to 200 selected Emails through the same ingest path in
its `reclassify` mode: the result is history, it replaces Relevance only
without dropping retained content or an import, and it never overrides a member
resolution (ADR 0011).

Each relevance rerun stores a versioned publication-receipt checkpoint in
`Run.progress` before work, after every reached Email, and with the deferred
tail on completion; the frozen selection and checksums stay in `Run.input`.
`run_read.work_snapshot` exposes `mailReclassification` through a narrow
member-owned read: selected Email codes/checksums, exact receipts, retained
notes, and separately labeled immutable classification observations. Missing
Email identities are null, never raw UUIDs.

- A client timeout does not imply the Run stopped: recover its receipts before
  deciding whether to rerun only deferred work.
- `complete` means the entire roster has receipts, including deferred
  outcomes; it does not mean every Email was classified.
- Receipt persistence follows publication in a separate transaction: an
  abrupt termination between them leaves an unknown outcome, not permission to
  rerun. A failed outcome can follow publication if read-back fails, so it also
  needs reconciliation before retrying.
- A Run without a receipt checkpoint reads null receipts; notes can be
  truncated and observations do not establish publication outcomes.

The status header reuses the canonical Run projection without entity-quality
hydration.

### Admission

Admission (`mail-import-run.ts`) freezes up to 50 Emails' checksums into one
`mail_import` Run with a RunTarget per Email, assigns ownership through
`Email.runId`, and dispatches `start_or_resume` to a `purchase.dispatch` Job in
the admission transaction (`dispatch.ts`). Each paid call checks the Run is
still executable and draws from the household AI budget
(`execution-transport.ts`, `server/ai/budget.ts`).

Existing discovery wakes also recover untouched automatic unresolved work when
its retained original changes, its sender becomes verified, or accepted source
evidence now establishes its exact order on the member's own Vendor account.
Source and accepted-evidence fingerprints deduplicate attempts; Purchase edits
and unchanged evidence do not reopen work, and accepted source publication must
be newer than the latest unresolved outcome. Recovery first pages bounded
untouched gaps, then reads only Purchases for their printed identifiers and
verified Vendors; it never builds a sender-by-Purchase cross product or
searches every imported original's full body. Admission rechecks literal
identifiers, current source bytes, source ownership, live dispatch leases and
retained member intent under the evidence-write scope. A successor keeps the
predecessor's frozen roster/outcomes and records the ownership transfer.
Foreground, retired, reviewed and excluded work stays held.

### Coordinator turns

Pi (`agent-host.ts`, `server/domains/purchase-agent/`) runs on the generic agent
tools (`claim_next_import_work`, `stop_import_run_for_review`) plus the MCP
actions its manifest mounts (`packages/schemas/src/import-run-agent.ts`), called
in process through the MCP handler with a run-bound delegation
(`agent-services.ts` `mcpFetch`). Instructions:
`.agents/skills/purchase-import/references/mail-import.md` via
`server/domains/purchase-agent/service/import-run-workflows.ts`. The host runs
every alarm, dispatch and prompt inside a household coordinator turn
(`coordinator-turn.ts`) granted by the `COORDINATOR_GATE` Durable Object
(`coordinator-gate.ts`); without a free turn it loads nothing and waits in the
gate's queue, and pi's services refuse database work once the turn is lost
([budget](../../../../../../../docs/infrastructure.md#background-connection-budget)).

Memoized claims publish host-owned progress, heartbeat and work samples.
Progress publication is best-effort: a telemetry failure never turns a
successful durable claim into a tool error. RunOperation activity also feeds
the stale-run check. Mail has no model-directed progress or approval pause;
Email gaps use `mail_resolve` and Run-wide provider failures use the explicit
stop tool. The MCP adapter binds the Run and request generation; Email
identities, checksums and replay ids stay explicit, so an old call cannot
silently follow a newer claim. The host normalizes a Mail envelope returned
inside a compact action's `input` to the root before signing its originating
generation. `mail_resolve` and `shipments.record` publish their complete input
schemas to the coordinator; other compact actions keep `describe`.

**Escalation.** Stronger-model escalation is explicitly requested with a
blocker category and one question. Missing evidence, member decisions, held
sources and transient failures do not escalate. An unresolved disposition or
refused preparation does not automatically spend a stronger-model turn;
repairable extraction, identity, contradictory evidence or an unclassified
reasoning gap may ask. The host asks the `standard` tier, then the `quality`
tier, one question each per Email, with the compact Email and the
coordinator's stated facts, outside the conversation; the `fast` coordinator
keeps the Email, its cache and every write
([ADR 0027](../../../../../../../docs/adr/0027-tier-routed-models-on-a-funding-first-ladder.md)).
Spent questions survive re-claims and coordinator recovery, and each answer's
usage records operation `agent.escalation`. A background Run whose free sources
are all refused or spent lets the primary settle the Email rather than
escalate onto paid funding.

**Extraction budgets.** The RunOperation ledger owns claim-evidence extraction
budgets across Runs: two primary submissions (initial plus repair) and one
escalation submission. Identical extraction replay does not consume another
attempt; repeated claims and successor Runs keep the budget. The claim binds
the original checksum, sender proof and accepted order-source context;
display-name and Purchase-date edits do not reset it. Writer classification
uses trusted MCP error metadata, never Email text. Held-source refusals are
exempt. A call the harness refuses before any writer runs (invalid arguments,
a host block) spends its primary attempt through malformed-call accounting and
settles as rejected; that settlement touches only its own reservation, never an
identical attempt whose outcome is uncertain. When the primary budget is spent before any
escalation answer, the coordinator is offered its escalation question once; the
next exhaustion settles. Ordinary-path calls on incomplete compact evidence are blocked before
either malformed-call accounting or writer admission, preserving the
exception-flow budget. A source that consumes more than 16 model requests in one
Run settles the same way, whatever its attempt count. Exhaustion uses
`attempt_limit` and records an unresolved gap through the delegated
mail-resolve writer, with a stable
operation ID and the issuing generation fence. Unresolved judgments keep a typed
gap category alongside the explanation; uncategorized ones read as unknown.

**Writer outcomes.** Confirmed writer refusals return for changed input
without automatic replay; repeating an identical refused commit encounters its
retained uncertain receipt. A preparation deadline asks for identical retry.
Explicitly uncertain receipts are not retried inside the tool. Preparation
failures cannot leave uncertain money writes. Commit failures without a server
verdict, deadlines and explicitly uncertain operation outcomes keep their
reservation until exact writer recovery. After a predecessor is terminal or
retired, only identical extraction facts can replay under the successor's
locked, unchanged Email. Ordinary attempts retain their validated proposal
before execution; a claim returns an unreconciled proposal from a terminal
owner or from the claiming Run itself as `recovery` for exact tool replay, so
neither retirement nor the coordinator's trimmed context can lose the input
needed to recover. Attempt identity ignores the free-text review `detail`, so a
reworded replay is still identical. Canonical source writers preserve earlier effects; the
successor keeps its own pending receipt, and replay identities count once
across Runs. Changed input stays blocked until that recovery has a known
outcome. Generation response hooks only account for submissions; they never
publish dispositions.

**`import_extracted_order`** handles complete, admitted, attachment-free
Email. Ordinary candidates keep literal source excerpts for identifiers, dates,
totals, lines and payments; the tool checks their coverage and occurrence in
the current complete compact original before preparation. Excerpts establish
traceability; the writers still own money and identity validation. It
generates stable IDs and runs the prepare/commit tools as durable nested calls.
Its model-facing `extraction` is one candidate beside `status`, `reason` and
`detail` (`importExtractionAgentInput`), parsed into the stored outcome union.
Newly discovered Product candidates return the preparation for review instead
of creating a possible duplicate. Incomplete source views and complex originals
keep the exception path. After a known, non-conflicting publication, the same
durable tool claims and returns the next Email with its evidence, so the model
does not spend a separate turn on that claim. Unknown writes and conflicts do
not advance.

**Claims.** A Mail import claim (`operations/mail-import-claim.ts`) returns
the claimed Email's compact read (`readMail`, bounded by `fitMailRead`, which
also drops a snippet or preheader the body page already begins with). Tracking
pixels and click-tracking redirect images are not listed in `images`.
Coordinator claims also include up to 20 Product candidates from exact printed
ASIN-shaped link identifiers under the verified sender's registered issuer, and
live Products recorded on up to 5 matching own-account Purchases at that
Vendor. Ambiguous identifier hits stay separate candidates; omission is
explicit. These hints grant no identity authority, and deterministic rule-only
claims skip the lookup.

### Mail import rule

Before claiming, a claim settles leading roster Emails that the Mail import
rule decides (`service/mail-import-rule.ts`, revision
`MAIL_IMPORT_RULE_REVISION`) through `purchase_import.mail_resolve`'s own
writer, with no model call.

- **Lifecycle link.** A related shipped, delivered or confirmation notice
  (subject phrase; no refund, cancellation, return or failure wording,
  including item cancellations in the body) with a complete compact read and no
  retained attachment bytes links as that event (proposer `heuristic`,
  Suggestion producer `rule`) when every exact rule that applies names the
  same one Purchase on the Email owner's own account: (a) a Shipment this Email
  already sourced, (b) a tracking key (`Email.trackingKeys`) equal to exactly
  one Shipment, (c) a normalized order key (`Email.orderKeys`) equal to exactly
  one live Purchase of the sender-proof Vendor (`senderProofVendor`). A (b)/(c)
  link records the Email's one package in the same resolution as a dated
  notification observation.
- **Carrier notice.** An exact USPS or FedEx carrier notice classified related
  records its package, then links only the Purchase that Shipment already holds
  or settles unresolved; it goes to the coordinator if the writer holds the
  package.
- **Unrelated.** An Email the classifier confidently called unrelated (stage
  `rule`, `decision` or `model`, in a Run the member did not select, from a
  sender that proves no Vendor) resolves `unrelated`; its resolution
  observation carries the revision.
- **Coordinator.** A disagreement, another member's Shipment or order-key
  Purchase, a sender proven to be another Vendor, a shipping or delivery notice
  without recognised tracking, more than one package, an unknown carrier or an
  unrecognised tracking reference (`hasUnrecognisedTracking`), a confirmation
  of a Purchase no import has sourced, an incomplete or paged compact read, and
  any refusal `mail_resolve` returns go to the coordinator.

Keys come from one extractor (`extractMailKeys`: `purchase_cues` identifiers
minus carrier tracking; UPS/USPS/FedEx/OnTrac formats and tracking-link
parameters) and are stored at ingest or recomputed when missing or stale
(`readEmailMailKeys`). A rule link skips the `mail-attribution` judgment: on the
owner's own account it cannot change what the link writes. An Email handed to
the coordinator carries the rule's evidence as `known` (the sender-proof
Vendor, the recognized order identifiers and up to five live Purchases holding
one), so the coordinator skips the Vendor and order-id lookups most Emails
otherwise start with.

### Writes and the Run roster

`purchase_import_read.mail_read` reads a retained Email (`mail-tool.ts`
`readMail`); `purchase_import.prepare/commit` (`import-orders.ts`) import an
order through `writer.ts`. A mail-sourced commit (message or attachment) links
and settles the Email as the Purchase's confirmation, and a commit that
creates Products starts a `scheduled` category suggestion sweep for them when
AI refresh is active (`import-category-sweep.ts`). The writer also links other
retained Emails whose undecided order event names the new or updated
Purchase's order id and no other Purchase (`linkExactOrderEmails`, an automatic
decision; see [Emails sections](../../../../../../../docs/entities.md#one-declaration-several-consumers)).
`purchase_import.mail_resolve` records a lifecycle link, an unresolved gap or
an unrelated disposal, which deletes the retained copy unless a reviewed
decision or import uses it; the daily catch-up retries a disposal lost after
its disposition, and a repeated `unrelated` resolve replays without the copy.

A Mail import Run may read its member's retained Emails from the mailboxes it
admitted, but writes (prepare, commit, resolve) only the Emails on its roster
(`mail-run-membership.ts`), and every mail call refuses it once it is
cancelled, finished, retired or deleted. Naming another original in `prepare`
or a `linked` resolve admits it to the roster
(`operations/mail-source-admission.ts`) only when the `mail-source-relation`
decision confidently finds the same purchase as a roster Email (or, along a
`via` path, as the Email before it, the first against the roster) and
`mail-attribution` finds the recipient's own transaction, within the Run's
execution claims. Supporting originals append past admission's 50 targets up to
the roster backstop (`MAIL_RUN_ROSTER_LIMIT`), so a full batch never strands a
notice whose original is still unclaimed.

**Attribution.** A Run the member did not explicitly select (`trigger` other
than `foreground`) prepares a Purchase only from an Email attributed to its
recipient: forwarding alone never proves ownership, and an unattributed Email
may still link to an existing Purchase without creating the recipient's
VendorAccount. Attribution (`service/mail-source-judgment.ts`) always asks
`mail-attribution` (apart from the rule link above), with the owner and
household members as trusted evidence: the owner LedgerParty's linked sign-in
email and connected Gmail profile address (cached per isolate by
`repo/mail-owner.ts`; an unreadable profile is reported to Sentry and named in
the judgment's warnings), compared lowercased, `+tag`-free and, for Gmail,
dot-free on addr-specs only. Own mail (`service/mail-owner.ts`: an owner
address in To, a sender who is neither the owner nor another live member, no
`X-Forwarded-*`, `Resent-*` or `X-Google-Original-From` header, no `Fwd:`
subject and no forwarded-message marker in the text or HTML body) defaults to
`recipient` unless the model answers `third_party` with high confidence;
evidence too large for the model stays `uncertain`, own mail included, since
the default needs an actual answer. Delivered-To or Cc alone is not own mail.
Any other Email needs a high-confidence answer. A refusal reports the label,
its basis (`owner_default`, `model` or `oversized`), the model's label and
probability, and any owner-evidence warnings.

Payment, refund and transfer Emails reach `finance.converge`, whose mail
branch uses the checksum- and literal-verified `mail-financial-event`
preparation (`service/mail-financial-event.ts`, revalidated by
`repo/mail-financial-event.ts`). New preparations may not name the retired
`browser_order` source kind; stored rows keep it.

### Settlement and retries

A normal Mail coordinator answer first rechecks runnable work through the
leased `claim_next_work` operation. If an Email remains, the generation's yield
hook continues with its current claim, preserving the claim result on replay. A
source-specific blocker is resolved as `unresolved`, then the coordinator
continues the batch; an unavailable escalation does not block unrelated
Emails. Explicit Run review, stopped Runs and exhausted rosters still settle.
Pi's settled submission reconciles the Run (`run-review.ts`
`reconcileSettledRun`); the daily cron expires stale Runs.

An unanswered submission is classified (`purchase-agent/service/settlement.ts`
`coordinatorFailureCode`) from Pi's reason and the last model error or failed
tool result the coordinator recorded (`run-agent.ts` `recordFailure`):

- a funding stop pauses;
- `agent_transient` (including Pi's `stale`, `reset`, `restart_limit` and
  `interrupted` stops) retries in `markRunFailed` as one successor
  (`cause: retry`, the primary coordinator model) taking only the Run's held
  unsettled Emails with an attempt left;
- `agent_failed` (including any explicit 401/403) never retries.

A database fault in paid or free admission is not a refusal: `admissionRead`
marks it and the coordinator's transport answers a retryable 502 rather than
the final 403. The last failed attempt carries one Run finding with the class
and raw error. Every admission counts against the evidence revision that
admitted it (`Email.importAttempts`: checksum plus the Run's
`evidenceRevision`; `MAIL_IMPORT_ATTEMPTS_PER_REVISION`); at most three Runs
attempt one revision. Failed and reviewed Runs release unreached Emails below
the bound and keep claimed or exhausted ones `unsettled`; recheck Runs and
member cancels keep them all, and evidence recovery skips a member-cancelled
holder unless the evidence postdates the cancel. Recheck admissions record
their revision in the frozen input (`evidenceRevision`). Retirement skips a Run
still holding a `researching` Email.

### Transcript retention

Transcripts are preserved until an explicit member-authorized retirement
([policy](../../../../../../../docs/jobs.md#coordinator-transcript-retention)).
Authorized disposal destroys settled Runs' transcripts (`run-retirement.ts`),
oldest first in bounded batches; the destroying call and an immediate
follow-up that reaches a fresh, empty coordinator let one pass stamp
`Run.retiredAt`. A failing coordinator is reported and does not block the Runs
behind it. Runs of retired purposes are destroyed by their stored coordinator
identity without loading the current agent. Once disposal is authorized the
coordinator writes a durable fence table, refuses every entry point (also after
a restart) and drains admitted ones before deleting, so nothing recreates
storage before `retiredAt` is stamped; an inventory holding only the fence is
empty. Retirement atomically dismisses only the machine-written Run execution
alerts for coordinator inactivity or an unfinished coordinator. Finding
evidence, genuine source review (including Run-targeted review), unresolved
entity and settlement work, and Run provenance remain. Readers exclude obsolete
execution alerts on retired Runs. A stored finding whose fix kind is retired
reads as having no executable fix (`storedImportFix`).

## Purchase agent

The purchase agent coordinates import Runs inside Worker `cubby`: an Agents SDK
`Agent` hosting a pi-durable conversation through `PiHarness`. It uses the
upstream lifecycle: a failed cached session requires explicit disposal or
Durable Object recreation before reopening; Cubby does not override the SDK's
cache. Bindings, the OAuth client and deploy constraints are in
[infrastructure](../../../../../../../docs/infrastructure.md#purchase-agent).

### Runtime

- SQLite Durable Object class `PurchaseImportRunAgent` (binding
  `PURCHASE_IMPORT_RUN`), one instance named `import-run:<Run.id>` or
  `photo-inventory:<Run.id>` per Run (`importRunAgentIdentity`). pi keeps the
  transcript, inbox and tasks in the object's SQLite, and lifecycle jobs wake it
  through its alarm after eviction.
- The `purchase.dispatch` Job handler, admitted in the Run transaction, fences
  duplicate and late starts with the Run's dispatch generation and
  `coordinatorStartedAt`; stable operation IDs survive lost replies. The Job
  completes once the coordinator accepts a stable operation identity, so an
  acknowledged coordinator is never submitted again by retrying a start Job.
  The Job owns bounded retries and raw terminal errors; the coordinator owns
  conversation settlement and its SDK lifecycle alarms. Funding pauses use the
  [funding-resume Job](../../../../../../../docs/jobs.md#funding-waits); domain
  resumption regenerates funding-paused purchase dispatches, and manual pauses
  stay stopped.
- Every model call goes through AI Gateway `cubby` on the Worker's `AI`
  binding, by the shared pi-ai providers (`@cubby/shared/ai/pi-providers`). The
  gateway shim disables parallel tool calls: pi ends a run on a terminating
  tool only when it is the round's sole call. A paid- or credit-admission
  refusal (household AI budget, Run no longer executable) reaches the
  coordinator as an HTTP 403 carrying its reason, not a network error.
- Run purposes and MCP authority are declared in
  `packages/schemas/src/import-run-agent.ts`. The shared host records model
  usage in `AiUsage`; transport attribution follows
  [ChatGPT-plan usage attribution](../../../../../../../docs/runbooks/chatgpt-plan.md#usage-attribution).
  Model and tool content stays out of Sentry and Workers traces.

### Model context and caching

Each request's context follows the purpose's `workItemContext`
(`@cubby/schemas/import-run-agent`). Mail import sends only the kickoff, user
and system messages, and the latest `claim_next_import_work` onward, because
each Email is independent and durable records carry what earlier ones settled.
The stored transcript keeps every Email for the Run page. Each Anthropic
request marks a cache breakpoint at the end of that kept prefix, and each
OpenAI request keys `prompt_cache_key` to the coordinator purpose
(`withWorkItemCaching`), so every Run reads the shared prefix from cache on each
Email. Unattended coordinators request OpenAI's `flex` service tier. Shared instructions precede
dynamic context. The ChatGPT plan transport places the tool block before the
conversation so the plan's prefix cache covers it
([runbook](../../../../../../../docs/runbooks/chatgpt-plan.md)).

Photo inventory reconstructs bounded context from uncovered photos and its
durable boundary proposal. Compact proposal responses include up to eight
groups needing repair, with conflict identities and bounded error text; the
coordinator repairs them and reads again for further failures. Publishing a
page resets model input; accumulated candidate lookups also have a byte
budget. The stored transcript remains the evidence history, while proposals and
their atomic boundary checkpoint own recovery. Photo inventory keeps its
model-directed progress tool. Public external-agent full-scan pagination
remains available.

The agent's `entity_read` schema is narrowed to the purpose's `entityRead` view
(Mail import: purchase, vendor and product, each with only its curated list
filters, and no `groupBy`/`groupLevel`/`nesting`); other kinds are refused for
the Run, omitted filters still validate, and members' `tools/list` keeps every
kind and input. An agent tool advertises `_runExecution` only when one of its
mounted actions reads it (Mail import: `purchase_import`, `finance`,
`shipments`). The Mail host stamps the immutable Run and originating
generation; the model still names its original Email, checksum and operation
ids.

### Observation

The Run page observes without resuming work. Opening a harness resumes its
pending tasks, so `/stream` from an object whose agent is already constructed
for Run work is the agent's live push stream; every other observation reads the
retained pi_ SQLite tables (`agent-transcript.ts`, version-fenced). Both read
adapters accept the known SQLite 1 and 2 layouts: upstream
[schema 2](https://github.com/earendil-works/pi/commit/f75b3240abc354bd1a666748e9101220554f5be2)
adds sleeping tasks without changing committed entries, usage documents or
their revisions, and a sleeping task stays unfinished in the observed status.
The readers reject unknown retained or installed versions, never migrate
storage, and do not imply that the installed SDK can resume a newer store. Live
and retained observations include pi's own `pi.usage` token totals per model
(`purchase-agent/service/model-usage.ts`), which the Run page compares against
the Run's `AiUsage` rows to expose calls the usage hook missed, such as
compaction summaries; cost stays in `AiUsage`. The agent's MCP calls are
recorded as `McpToolCall` with `surface: in_app_agent` and the Run.

pi-durable owns migrations of its stored tool tasks. When upgrading it,
validate preservation of live call identities, arguments and replay
checkpoints; after a task migration, a rollback must keep an SDK that can read
the migrated state. The host discards a failed in-memory harness after it
closes and reopens the same SQLite store on next use; an older session's late
close cannot discard its replacement.

### Trust boundary

The agent reads untrusted mail and photos, so prompt injection must not reach
anything beyond the Run it serves. It runs in Worker `cubby` behind an
in-process boundary enforced by construction:

- The agent's code (`server/domains/purchase-agent/`) receives no `env`. Its
  host (`operations/agent-host.ts`) builds a narrowed environment
  (`purchase-agent/service/environment.ts`): the AI Gateway, the scripted test
  model in the workerd harness, the purpose's MCP tool definitions, and the
  services of the one Run the object's name identifies
  (`importRunIdFromAgentIdentity`), so a coordinator cannot address another
  Run. The dispatch Job gets a separate environment that resolves any Run's
  services and coordinator. The Agents SDK base class gets an empty
  environment.
- Every Cubby effect is a Run service (`operations/agent-services.ts`): bound
  to one Run when created, it parses its input
  (`@cubby/schemas/purchase-agent-services`), opens its own database scope and
  resolves every target from that Run. No input names a Run, party, account,
  vendor, SQL, script or generic mutation target. A new coordinator first
  calls `authorize`, which requires the member's live Purchase Agent grant and
  otherwise pauses the Run for authorization.
- MCP calls run Cubby's MCP handler in process. For each request the host mints
  a fresh five-minute delegation bearer bound to the Run and the member's live
  Purchase Agent grant; the MCP handler verifies it, the grant, that the member
  started the Run and owns it through their LedgerParty (a photo Run may be
  owned by the other member's party) (`delegatedRunHolds`), and narrows every
  tool to the purpose's manifest actions
  (`importRunAgentManifest[purpose].mcpActions`). The agent never holds the
  token, and the host reads the agent's request before opening its database
  scope.
- Oxlint rule `cubby/purchase-agent-boundary` (`tools/oxlint/cubby/`) fails any
  import from that directory outside its runtime packages, pure Cubby contracts
  (`@cubby/schemas`, `@cubby/shared`, `@cubby/worker-tracing`), its own files
  and the bundled skill Markdown, and any reach for an `env` or `exports`
  property (including `ctx.exports`, the Worker's loopback bindings) or the
  `process`, `globalThis`, `self` and `require` globals, under any spelling. A
  new agent capability is a new Run service, never an import.

The model never runs code: its only authority is the tool set, and every tool
is a Run service or an MCP call checked as above. The boundary keeps Cubby's
own agent code on that path. It is not a sandbox: the agent shares the Worker's
isolate, so its dependencies (the Agents SDK, pi) run with the same runtime
authority as any Worker code, including `process.env` populated by
`nodejs_compat`. A dependency added to the agent deserves the same review as
one in the web app.

The scripted workerd harness exercises the built agent without production
data; profile/provenance contracts belong in
[test runtime guidance](../../../../../../../docs/agents/validation-tests.md#workerd-test-runtime-and-profiles).

## Member imports

A member (or their Claude/Codex session) calls the same
`purchase_import.prepare` without a Run: it opens a `file_import` Run keyed by
the operation id and returns its `RUN-` code, which `commit` names in
`_runExecution.run`. Each order names its Vendor (`vendorId`, or `vendor.name`
to reuse an exact-name Vendor). Replay is by operation id (`RunOperation`), and
the `ImportSourceClaim` fence keeps a source from importing twice. A receipt
photo becomes a Purchase through ordinary booking and attachment; its attached
receipt puts the Purchase in the Research queue through `purchase_itemization`
until a session itemizes it.

## Where to look

| Need                                       | File                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Public mail tool (read, search, resolve)   | `mail-tool.ts`, `packages/schemas/src/mailbox-research.ts`             |
| Import writers                             | `import-orders.ts`, `writer.ts`, `writer-policy.ts`                    |
| Mail import admission                      | `mail-import-run.ts`                                                   |
| Run lifecycle, controls                    | `run-service.ts`, `run-review.ts`                                      |
| Agent capabilities per Run purpose         | `capabilities.ts`                                                      |
| Gmail discovery, classification, retention | `gmail/`                                                               |
| Pi host and services                       | `agent-host.ts`, `agent-services.ts`, `server/domains/purchase-agent/` |
| Findings and their fixes                   | `findings.ts`                                                          |

## Mail replay evaluation

`eval:mail-replay:stdin` replays the synthetic originals in
`apps/web/tooling/ai/mail-import-comparison.json` through the current writers;
live replay requires explicit spending authority. Live `eval:mail-replay`
requires `MAIL_REPLAY_PRICING_FILE` (an official models.dev `?type=all`
snapshot) and `MAIL_REPLAY_BUDGET_FILE`. The exclusive JSON ledger records
`limitUsd`, `accountedUsd`, `outstandingUsd`, `stopped`, and outstanding
physical `reservations` (ID, model, maximum cost and refusal proof). The ledger
spans fresh databases, peer isolates and launcher invocations; a stale lock or
outstanding reservation requires reconciliation before another launch.

- One loopback admission server serializes full catalog-window reservations
  for both peers before every physical call. It reconciles exact stored
  receipts between requests, so sequential calls can reuse unused capacity
  without partitioning the allowance between coordinator and other features.
- Frontier requests require the subscriber-credit alias and no-wholesale flag;
  paid forwarding is disabled.
- Uncertain calls keep their reservations and stop further evaluation. Only
  exact reconciliation of successful physical requests with priced stored usage
  releases unused capacity. A fully read credit refusal also requires its exact
  failed receipt with no token usage before its reservation is released. A
  funding fallback can wait up to five seconds for that queued receipt; expiry
  stops the evaluation and keeps the reservation. Unknown failures stay
  reserved with their physical IDs.
- The replay checks a stopped allowance while observing the Run, and
  finalization closes physical admission before reading the last receipts,
  allowing the same bounded wait for final queued usage. Outstanding cost is
  derived from retained reservations, so subtraction residue cannot block the
  next case.

The report covers all Run-scoped AI usage, including extraction and audit, with
raw token/cache counts, duration and unknown prices. Known cost subtotals are
not complete costs when calls are unpriced. Version 2 synthetic replays fail on
disposition, total, line-cost or supported-link disagreements; free-form line
names and unresolved wording remain review differences. Capture baselines with
this all-Run-feature cost scope before comparing performance. Private replay
disagreements remain report-only evidence for member grading. Scripted replay
proves execution plumbing, not model quality or speed.

## Hidden dependencies

- Pi's instructions are skill Markdown (`mail-import.md`, `extraction.md`, the
  settlement rules) selected in `import-run-workflows.ts`; editing them changes
  production behavior.
- `server/domains/purchase-agent/service/signals.ts` bytes are matched by the
  workerd scripted model; keep them stable.
- Pi mounts MCP tools from the same compiled catalog the MCP server lists
  (`server/mcp/agent-tool-catalog.ts`); renaming a tool or action changes both.
