# Durable Jobs

The `Job` table owns one-off or resumable execution: claims,
leases, generations, retries and waits. Domain rows keep their outcomes and
evidence. [ADR 0025](adr/0025-radical-simplification-of-background-work.md) records
the decision; this page owns the runtime contract. Derived-data families are
in [entities](entities.md#background-derived-data); Worker and database
capacity in [infrastructure](infrastructure.md#postgresql-and-hyperdrive).

## Jobs are not entities

A Job has no public code, no `Entity` identity, no page and no relationships. It is
one row of owed background work in the `Job` table, keyed by `key`. Kind policy
supplies the lane and internal-kind flag. Work shows on the Work page and through
`job.activity`, and a Run's Jobs show on its detail page. Retry now uses
`job.retryNow` over a kind, lane, reason, state, Run or id filter.

## Coarse Jobs and work items

A Job is a unit of execution, not a unit of household work. Work that fans out over many
records is a **drain** over **items** held on the rows that owe them: `AiEvaluation`,
`SearchDocument`, `EntityEmbedding` and `ImageProcessingJob` own their scheduling.
A drain unit's only `Job` row is its `background.drain` record (rotation and
latest execution); it never holds or schedules items. The first three supply a `DrainStore`
(`generic/jobs/drain-store.ts`). An item's ticket says which intent a page may settle, so a
re-mark during a page takes a new ticket, and the page clears only what it claimed. The
derived rebuild is a resumable pass with its own row, not items.

`rowDrain` (`generic/background/drains.ts`) is the single claim → prepare →
publish helper for embeddings and AI evaluation. It claims a bounded page,
prepares outside transactions and publishes chunks of at most 25 weighted items.
Domain locks precede item locks. An isolated publication error splits the chunk
until only the failing item backs off or exhausts; committed siblings never replay.
Adapters declare their own backoff and optional attempt limit. AI evaluation
supplies real lease-checking transactions, including SERIALIZABLE publication;
paid results survive publication failure on the evaluation row. No synthetic Job
context or claim generation stands in for that ownership.

Published and failed counts record committed settlements, once each even
when a serializable transaction replays. Retained items stay owed. Each drain
declares SQL for when it is due now and when it is next due; an empty page
publishes nothing and schedules nothing.
Email purchase discovery holds one AppSettings cursor, publishes the
`connection.email-purchase` recommendation Suggestions for Emails whose retained
evidence suggests a purchase link, and repeats hourly (its cursor's `nextAt` is
its `next`). It runs deterministic SQL: no model, no Run and no evaluation.

One-record work stays a Job: Run execution, Location AI, image metadata,
calendar invalidation and purchase dispatch. Image processing owns its own row.
Job `generation` remains the supersession fence and Run execution attempt number.
Outcomes live on domain owners; Jobs retain no result JSON. `availableAt` is the
only stored wait deadline. Completed Jobs remain until retention prunes them.

## Kinds and lanes

`apps/web/src/server/generic/jobs/kind-policy.ts` is the one registry of
per-kind policy: lane, internal flag, `maxAttempts` (every kind has one) and
failure backoff. A kind absent there is a server kind with three attempts and
1 s doubling to 60 s backoff. Each lane names the executor that runs it:

| Lane       | Kinds               | Executor                                        |
| ---------- | ------------------- | ----------------------------------------------- |
| `external` | `purchase.dispatch` | a coordinator, handed off by a permit           |
| `server`   | every other kind    | a [background permit](#selection-and-admission) |

Coordinators run at most `COORDINATOR_TURN_CAP` (6) work turns at once across
the household ([budget](infrastructure.md#background-connection-budget)). A
`purchase.dispatch` whose coordinator finds every turn held defers with
`provider_capacity` and no attempt ("Waiting for a coordinator turn"); each
released turn brings the oldest such Job forward, and its 2–4 minute fallback
covers a turn that lapsed instead.

`background.drain` is an internal record kind: one completed row per drain
unit (`key` `drain:<unit>`) whose `lastClaimedAt` places the unit in rotation.
It is never claimed or executed. Its `lastExecution` is the unit's last page,
including a page that threw: the permit meters AI cost and item counts outside
the page, so a failed record keeps what committed before the failure.

Device image work is parked on its own row and never reaches a permit.
Enqueueing it rings connected
companions after commit, and a companion connecting to the doorbell is rung at
once; there is no polling interval. Work that comes due later (a failure
backoff, a deferral, a lapsed lease, a delayed release) rings through a
Queue-delayed permit carrying `ring`. A delay past twelve hours is left to the hourly
cron, which also covers a lost message and rings whenever parked work is
claimable. A doorbell RPC failure fails the delivery, so it retries; reaching
no open socket is not a failure. A release with no delay also rings at once
(best effort).

## Waiting on

`generic/jobs/repo/waiting-on.ts` is the single derivation of what a live Job
waits on; every client (web, Apple, CLI, MCP) and every rollup reads it.
`jobWaitingOn` in `packages/schemas/src/job.ts` is the wire vocabulary:

- `due`: claimable now. The server reports no queue position or ETA: with a
  few dozen coarse Jobs, a position is noise.
- `waiting_device`: parked device work; position in device claim order
  (`deviceSelectionIndex`, with backfill's turn), exact apart from a
  device's preference for work another device last ran.
- `waiting_funding`: an `ai_funding_window` wait until the window resets.
- `leased`: an executor holds it, named with its device installation id
  (`executorDeviceId`, null for cloud) and `leasedAt` (the claim time);
  `expired` once the lease lapsed unreclaimed. The holder is `Job.leaseHolder`
  (`{name, deviceId}`), which an external executor records at hand-off;
  generic code never reads a domain's attempt rows.
- `backing_off`: a failure backoff or provider wait (`cause`) until a time.
- `blocked`: waiting on other work, such as a device preparing AVIF input.
- `paused`: stopped by a member or its Run.
- `update_required`: reserved for an Apple device that must update; the
  Apple client reports it. The server derives `Device.updateRequired` from the
  stored `appVersion` against `APPLE_CLIENT_MINIMUM_VERSION` instead.

Terminal Jobs wait on nothing. `jobWaitingOnReasonSql` mirrors the derivation
for aggregates; a regression keeps the two in agreement. Text surfaces render
one line through `describeJobWaitingOn` (and `describeJobRollup` for counts),
so a lapsed lease reads "Lease on … expired; waiting to be reclaimed", never
"In progress".

Reconciliation copies a stopped execution's failure to its Run and records an
end time for failed or cancelled execution; a member pause stays open-ended.
Running Sweeps and mail reclassification support member pause/resume through
the Run lifecycle, preserving their steps, scope and committed progress. Failed-work
recovery leaves cancelled evaluations and withdrawn shared requests stopped,
including their original receipts and superseded historical work. An explicit
Retry run on a member-cancelled Run revokes that member stop: its interrupted
steps reopen, member-cancelled owned evaluations get linked replacements, and
withdrawn requests rejoin any still-live shared evaluation without a retry link
to themselves. The stored member-cancellation marker has one schema owner.
A cancelled Run may also resume an interrupted or queued step after all of its
evaluations settled; that step still needs to publish its final tally. Other
cancellations remain stopped. Retry failed on a cancelled Sweep step with
no failed items directs the member to Retry run. Actual failures remain
retryable without reviving the cancelled remainder.
A retained step with zero committed pages still retries its full failed roster.
Retry failed refuses a retained step absent from its Run's current execution
plan before changing its ledger or launching work. Historical failures and
references remain available; retry does not re-plan a retired population.
An explicit Retry run can also reopen a completed execution Job when a failed
Mail discovery Run retains a valid frozen page. The same Job starts a new
generation while preserving the Run's input and page; page settlement and mailbox
admission still apply. A completed Job without retained work remains refused.

AI refresh recovery requires a durable owned or requested evaluation roster,
including terminal rows and retry handoffs. With no roster, Retry run, Resume
and "Run now, paid allowed" refuse before launching or recording a paid grant.
The execution driver retains a raw failure rather than completing an unknown
scope. Historical discovery metadata is not a target roster.

A legacy failed Mail reclassification with no durable roster can be closed by
an explicitly authorized historical correction after every original identity
and execution-time checksum is proven handled by retained checkpoint evidence
and completed linked continuations. This rewrites the request's stored status
to completed; its original checkpoint, notes and end time remain unchanged.
The checkpoint can remain incomplete while the linked continuations establish
fulfillment. Linkage also includes child usage in the parent's cost rollup.

Mailbox discovery admits at most four independent targeted searches per member
and mailbox. Each Run keeps the complete frozen query roster and a stable
selected query resource. Legacy, history and controlled scans own the whole
mailbox. Short admission transactions coordinate resource conflicts; a database
guard preserves the capacity and exclusion rules during Worker cutover too.
Only current connected-mailbox discovery reconciles the canonical query roster;
individual query lanes cannot prune or restore other objectives.

An accepted retained Retry keeps its Run, frozen page and canonical Job. If its
resource is occupied it reads as queued automatic work, using the existing
paused state with a specific admission reason. Its fenced Job claim admits it
later. Repeated capacity deferrals consume no failure attempts. Eligible
recovery or an older yielded query reserves one vacancy; fresh continuations
cannot strand a parked page. An exclusive waiter stops fresh admissions until
existing owners drain. Other normal query work retains the remaining capacity.
Recovery query owners use at most three slots, leaving room for normal work.
Only a recovery with available recovery capacity and an unoccupied resource
reserves a vacancy; blocked recovery cannot strand the normal lane.
Eligibility includes the candidate's own reservation: a younger same-query
waiter cannot take its older owner's vacancy.
Normal history demand coalesces into one queued Run; its older exclusive request
also drains query owners instead of waiting behind endless recovery callbacks.
Running owners renew admission at the next Job claim, without interrupting an
in-flight request. A targeted page can park between five-message batches while
retaining its position against same-query demand; ambiguous or same-query
waiters keep that page exclusive until it checkpoints. Ordinary mailbox owners
execute history only, even if the shared cursor would otherwise select a scan.
Their internal scope pins that mode; initialization and unscoped retained work
keep conservative mailbox ownership without changing their frozen pages.
History pages yield only after their entire provider page checkpoints, and
controlled scans retain exclusive ownership. An owner restored from the queue
performs one Job quantum before renewing again, preventing pause/resume livelock.
Yielding preserves the frozen page, cursor, generation, attempts and funding
deadline; its new FIFO request allows already queued owners to proceed.
Creation, generation and wake intent commit together. A manual paid-start action
grants one Run's allowance and never duplicates it across parallel lanes.
Cancellation removes demand, and a missing or terminal Job leaves the Run
visible for recovery instead of hiding it as an automatic wait.

Mailbox discovery acquires at most five messages from its frozen provider page
per Job claim. Each lane fetches and publishes in source order without buffering
several full originals. Each claim runs in its own permit with that permit's
two database sockets. Its durable message offset resumes the remaining
messages without replaying the completed prefix; absent offsets on retained
pages mean zero.

Existing Job logs report Mail phase durations for listing, fetching, acquisition,
classification, attachments, candidate previews, evidence publication, progress,
import admission and checkpointing. Acquisition includes its nested classification,
attachment and publication phases, so these durations must not be added together.
Timings accumulate across messages handled by one claim, include awaited I/O and
failed work, and contain only static phase names and milliseconds. They neither
measure Worker CPU or heap nor start additional work. Job `dueLagMs` measures
claim time minus the stored `availableAt`, clamped to zero; on an expired-lease
reclaim it includes the previous invocation and lease wait, rather than isolating
time queued for capacity.

Gmail throttling and transient provider failures retain their raw diagnostics
and retry time. The mailbox cursor shares that cooldown across independent
clients; a Job defers before another provider request without spending attempts.
Retry-After is preserved beyond the client's short in-call retry bound.
Throttling and server responses with Retry-After reach the shared cooldown owner
before any further HTTP attempt; only server failures without a deadline retry
within the client.
An aborted discovery database snapshot or lock/capacity conflict defers the
canonical Job with its original cursor and failure allowance. Raw database
diagnostics remain in workflow logs; cancellation and lease loss still stop
that invocation instead of creating new demand.
Mailbox coverage advances only after every batch and history event is handled. A retained
automatic history page can then settle against a newer completed history cursor
under the same baseline when its numeric ID covers the entire frozen range.
It preserves all newer coverage; an in-flight token alone or a controlled scan
cannot authorize this recovery.
Import admission commits child dispatch intent atomically. An already-failed
child remains visible for its own retry and does not fail discovery or rewind
the mailbox page.
When a frozen page is retried after another pass, its checkpoint preserves the
latest unrelated searches and history. A stopped member-controlled query pruned
by a later pass can be restored from that Run's frozen scope. An unattended
targeted page whose messages are all handled may settle against a different
partial position for the same query and baseline, or after that search is pruned,
preserving current coverage and adding no shared counts. A pruned search stays
absent; settling the handled page does not restore or complete it. A continuation
carries only unchanged searches still present in current coverage.
Automatic continuations defer to an existing funding-paused discovery for the
same member and mailbox. Completing a retained page leaves the next acquisition
with that owner and its existing resume Job instead of enrolling another pass.
Continuation idempotency uses `mailbox-continuation:<completed Run id>`;
descendant readbacks must follow that key as well as explicit parent links.
Opaque tokens establish no order; a reset position can enumerate that range again
through idempotent ingestion. The Run completes
its one page, not the whole query. Targeted pages carry no history events, so
history recovery still requires its numeric coverage proof. A controlled page,
changed query or baseline, and an identical token with rewritten metadata still
refuse rather than overwriting coverage.
Discovery page and completion receipts use the universal Job generation, matching
the progress owner's fence.

Declared entity fields carry the same facts to web, Apple and MCP:

- Run: `waitingOn` (the rollup line), `stalled`, `successorRunId` ("Retried
  as", the newest Run whose `predecessorRunId` names it; `predecessorRunId`
  reads "Retry of"), and `displayStatus` for the header. A `needs_review` or
  `failed` Run with a successor reads `retried` (its open work moved; its own
  findings stay on its sections), and an `execution_limit` stop reads
  `waiting_for_funding`. The stored `status` stays the filter.
  Web photo Run details replace a predecessor's photo review with a link to its
  successor, its current status and the number of groups awaiting approval.
  Retained predecessor photos are not shown as ungrouped once work continues in
  a successor. The pointer reuses the Run controls' lineage links and live read.
- Image job: `waitingOn` for open rows.
- Device: `updateRequired`, `inactive` (not seen for 7 days or never) and
  `appleIntelligenceAvailable` (the hello's actual-image description
  availability, null until a hello reports it).

A resumed Run's evaluation item is rechecked under Run locks before a prepared parked item
can be cleared. Embedding publication takes source locks before item locks, matching source
producers.

## Selection and admission

The `cubby-background` queue carries permits. Each message lets one
invocation run ONE unit: one Job page, or one page of a named drain (cloud
images, embedding refresh, embedding cleanup, one AI evaluation feature as
`ai-evaluation:<feature>`, the derived rebuild, and reconciliation). The
queue's `maxConcurrency` (8, batch size 1, in
`packages/shared/src/background-queue-consumer.json`) is the only concurrency
bound; there is no in-isolate admission, page or wall budget, round or
Job/feature alternation.

`dueUnits` (private to `generic/jobs`) chooses the unit in one statement over
due Jobs and every drain's `due` SQL:

1. `run.execute`, Jobs whose `runId` is a running, member-visible Run, and drain
   units with member demand (an AI evaluation at priority 0, a Run-owned cloud
   image) lead (routine Runs such as connection discovery do not).
2. Within each class, units take turns: every unit's first candidate, then
   every Job kind's second, least recently served first (a Job kind's latest
   claim from the `(kind, lastClaimedAt)` index, a drain unit's
   `background.drain` record row); within a kind, priority then age. A 100k
   flood of one kind therefore never starves another.

A permit tries up to eight candidates in that order and runs the first it can
claim (`SKIP LOCKED`; a sibling's held row is skipped, not awaited). A unit
that claimed work sends exactly one successor permit for the earliest owed work
across Jobs, leases and drains (`nextDueAt`): now if anything is due, else
delayed until it is due (at most twelve hours). A permit that claimed nothing,
including an over-produced one, exits after its one selection query and sends
nothing, and a failed drain page sends no successor; so wake chains end when
the household goes idle. Each Job claim and each cloud image claim also sends
one recovery permit due when that claim's own lease lapses, naming the claim
(Job lease token, image attempt), so a killed invocation is recovered without
waiting for cron. A Job recovery runs only if that lease lapsed unsettled; an
image recovery atomically reclaims exactly that attempt, so of two overlapping
recoveries one runs and the other exits without work or a successor.

Member-first ordering inside a drain is item priority: root transactions in
Job execution mark derived inputs at priority 1, member transactions at 0, and
savepoints inherit the outer transaction's priority.

This bounds concurrent units, not bytes or heap: each page's payload,
HTTP requests and response decoding still allocate. Native Worker outcomes
remain the memory-failure source of truth. Existing source limits, retained
paid results, lease recovery, funding deadlines and claim/publication fences
remain unchanged.

A device pull (`claimCompanionImageCommands`) claims, prepares, assigns and
reserves output in one transaction under an advisory lock, so concurrent batches
take their turns one at a time. An active, member-visible Run's parked work leads;
backfill runs when no Run needs the device. A device's preference for work another
device last ran only orders candidates within that. A hand-off the server cannot
make (participation turned off, output not reserved, preparation failed) is
released in the same transaction.

## Execution

Import-scoped statement generation processes at most four charges per page.
Import-scoped labeling defaults to the same four-charge application limit;
unscoped labeling keeps its 32-charge default, and explicit label limits remain
available. Retained label receipts still need ordered, fresh-evidence automatic
application, even when the page asks no model questions. Smaller pages commit
completion and the remaining cursor before those repeated reads accumulate
across 32 charges. This bounds work between checkpoints, not total invocation
CPU.
Cooperative label application also checks its existing 20-second deadline
between charges while no financial rule has applied in that round. It settles at least one
charge, then leaves the untouched suffix's receipts and inclusive cursor for
the next page. Rounds with financial effects retain their existing ordered
regeneration rounds. This avoids accumulating several expensive regenerations
without a financial application before a checkpoint; it does not bound one charge's CPU or the
whole invocation.
Each charge still regenerates current evidence before serial automatic-rule
application. The smaller shared page limit bounds retained preparation and
repeated ledger reads between durable checkpoints; interrupted pages replay
their existing publications and effects through the same guards. It does not
increase attempts, provider budgets or Worker limits.
Automatic-rule refusals return and log the shared scrubbed causal diagnostics,
including nested database messages and SQLSTATE codes. A refused application
leaves its suggestion pending; diagnostic capture does not accept, retry or
change the financial operation.

Generation preparation and publication finish in a separate function that
returns only charge references, counters and timing values. The initial
proposal graph does not remain in the serial application frame. Each charge
still regenerates current evidence before applying automatic rules; this
lifetime boundary does not reuse financial candidates across money writes or
establish a Worker memory bound.

Financial fingerprints hash the same JSON serialization through server crypto,
preserving their UTF-8 SHA-256 bytes while avoiding a separate encoded WebCrypto
input buffer. This reduces one allocation; it does not establish a Worker
memory bound or identify the cause of an invocation's memory exit.

Canonical spending evidence keeps the same JSON normalization and persisted
fingerprint format. Its canonical writer feeds escaped, complete JSON tokens
into the hash in buffered batches instead of retaining the entire canonical
string and its outer JSON serialization. The buffer holds at most 32,768
characters unless an individual token is larger. This reduces intermediate string
allocation without narrowing candidates, changing evidence, or reusing snapshots
across financial writes. It does not establish a total Worker memory bound.

Spending discovery hydrates complete Purchase graphs in batches of 128. Its
page cache retains the fields used for capacity and category decisions plus
canonical JSON of every original graph field, including member attributions
and payment-account evidence. Snapshot hashing reinserts that JSON into the
same canonical graph positions, preserving existing fingerprint bytes without
cloning the whole candidate population again. Stored graph text is emitted in
32,768-character fragments that preserve surrogate pairs. Commit re-reads its
evidence; the cache never crosses a money write. Candidate counts, canonical
text and individual graph sizes still grow with evidence, so the batch size
does not establish a total Worker memory bound.
Full payment-evidence rows for eligible candidates are read together, ordered
by their existing IDs and reserved in the same page cache before concurrent
previews can repeat the read. Review-only candidates still load no payment rows.

Statement generation without an import scope selects at most 32 charges per page,
including account/date-filtered work. Import-scoped generation retains its
four-charge limit because it also admits serial financial
applications. Retained generation failures use the same limits, including large
failure sets. Both paths preserve the ordered population cursor and all remaining
work; only a completed page publishes its checkpoint. Smaller pages reduce the
proposal population retained through publication, but do not bound individual
graphs or total Worker memory. No source, candidate, admission or money policy is
relaxed by the page size.

`Statement generation phase` logs enter selection, preparation, publication,
and each charge's regeneration and application before awaiting that work.
Publication reports aggregate observation and candidate counts, without source
identities or content. These entry events complement the completed-page timings
when an invocation exits before it can publish a page summary; they do not
measure heap usage or establish a memory bound.

`Statement label application phase` logs enter each charge's regeneration,
automatic rules and refused-rule evidence check, then the page's receipt
completion. Payloads contain only phase names, charge indices and counts.
These entry events distinguish interrupted application work without retaining
proposal graphs or logging source content.

A handler has one shape: `prepare(db, claim, input, ctx)` reads and calls
providers outside a transaction and returns an outcome with an optional
`publish(tx)`. The executor (`generic/jobs/service/jobs.ts`, private) owns
everything else:

- **Lease.** Sixteen minutes, without renewal, longer than a Queue consumer can
  execute. Token/generation fences and pre-provider checks still refuse stale work.
  Device image lease renewal is unchanged.
- **Fence.** `publish` runs in a transaction that takes the handler's domain
  locks first, then one `FOR UPDATE` on the Job just before commit, and
  commits only while the claim's token, generation and lease still hold.
  `ctx.fenced(work)` applies the same fence to an intermediate write,
  `ctx.fence(tx)` to a caller's open transaction and `ctx.check()` before
  another provider batch. There is no early `FOR SHARE`; a lost race fails the
  fence, never deadlocks.
- **Explicit fences.** A fence is passed, never looked up. Run workflow code
  receives the claim's `fence`/`check` through `withWorkflowExecution`
  (`assertWorkflowEffect`, `assertWorkflowCurrent`); a standalone provider
  Job (`location-ai.*`) or the cloud image drain registers through `withJobFence` so the
  Gateway checks its lease before every paid request. A single-record handler
  passes `ctx.fenced` to its publication, and member or maintenance callers of
  the same publication pass `outsideJob(db)`, an ordinary transaction.
- **Failure.** One classifier walks the cause chain: a pause stops the Job; a
  deferral (`JobDeferredError`, funding, provider capacity) waits without an
  attempt; a superseded claim ends quietly; a target error isolates one item
  inside a drain; a retryable error backs off; anything else fails an attempt.

Image processing owns its own execution on `ImageProcessingJob`, with no Job
row: see [image processing](#image-processing). Producers use
`repo/producer.ts`, member and Run controls `repo/operator.ts`, drains
`rowDrain`, and readers `repo/job-reads.ts` (rows
by identity, a Run's live lease, stopped Run executions). The queue core
and selection (`repo/queue.ts`), `db/job-schema.ts` and the `Job` table object are private to
`generic/jobs`, tests included: oxlint's `no-restricted-imports` and
`no-restricted-properties` exempt only `generic/jobs` and the files that
declare or aggregate the tables. Tests seed, age, lock, claim and inspect that
state through `generic/jobs/jobs.fixtures.ts`. Whole-model consumers (the database client,
migrations checks, test setup) import `db/drizzle-schema.ts`.

## Wakes

A Job is due when it is queued or in backoff and its time has come, or when its lease has
expired. A permit is only a Queue message that makes a unit run sooner (`wakeJobs`, `wakeAt`);
it carries no durable state, and the hourly cron recovers a lost one. `enqueueJob({ invalidate:
true })` is the only restart: it bumps the generation and clears the lease, so the old pass
fails its fence. Email purchase discovery repeats through its cursor; automatic work has no recurring Job.

## Retries

Claiming is not an attempt; a failure is, and so is reclaiming an expired
lease (the previous executor vanished mid-pass, and a crash loop must still
exhaust). A failed Job backs off by its policy, `baseMs · 2^(failures - 1)` up
to `maxMs`, and fails after `maxAttempts`; every kind has a bound, and a row
stored with a null column uses its kind's. `releaseJobClaim` hands a claim back
without an attempt, and deferrals never count.

Transient failures — a Hyperdrive pool-slot timeout (SQLSTATE 58000, "Timed out
while waiting for an open slot in the pool"), a dropped connection (SQLSTATE
class 08 or 57P01, or anywhere in the cause chain a code-less "Connection
terminated unexpectedly", a pool connect timeout or an `ECONNRESET`/`EPIPE`/
`ETIMEDOUT` socket error), a `JobRetryableError` or an exhausted snapshot replay — back off without spending
attempts; their delay grows with the failing streak's age. `failingSince` records
the streak's first failure and any successful or deferred page clears it.
Whatever the class, a Job still failing `JOB_FAILING_LIMIT_MS` (24 hours) after
its streak began fails visibly. Funding and provider waits stay `JobDeferredError`
/ `waiting_on` and never start a streak.

Drain items are bounded too: AI evaluations settle `failed` after three
non-transient failures; an embedding refresh stops owing after 100 failures
(about a day at its 15-minute cap) and a vector deletion after 288 five-minute
retries, each keeping its error for Work's failed list; image processing stops
retrying after twelve failures (about a day and a half of doubling backoff) and
waits for explicit retry. Drain items follow the Job rule for transient
failures: they defer without spending an attempt, back off by the streak's age,
and record the streak's start on the owning row (`AiEvaluation.failingSince`,
`SearchDocument.embeddingFailingSince`, `EntityEmbedding.deletionFailingSince`);
any item still failing 24 hours after its streak began is settled as failed.
A page that fails whole (outside any one item) settles each item it still holds
as failed, so persistent page failures reach the same bounds. Funding and
provider waits stop the page without touching its items.

Serialization recovery is bounded inside a DB-only snapshot transaction. If all
attempts roll back, its owner emits `SnapshotWriteConflictError`; the durable Job
then backs off as a transient failure. A raw SQLSTATE on an after-commit effect
is not this signal and cannot request unbounded replay.
Location description and inventory-analysis Jobs use a one-minute base with a
fifteen-minute backoff cap and ten attempts. When a recovered universal Job
executes, its matching Run reconciled to `job_failed` returns to running under
the Job fence. Another active Run owning the admission slot causes retry backoff
until it finishes. Admission waits reserve exactly one further attempt, rather
than conserving the ordinary failure budget; member-controlled, retired and
superseded Runs are excluded. Member pauses/cancellations and running leases
keep their states.

### Execution records

Every execution writes `Job.lastExecution` (`jobExecution` in
`packages/schemas/src/job.ts`): outcome, error class, wall milliseconds, database
query count and time, the charged AI cost recorded during it, the Worker version
and its finish time. A drain unit records the same on its `background.drain`
row, with its claimed, published and failed item counts. Failed Job executions
and failed drain pages reach Sentry tagged `cubby.background.unit` with the Job
kind or drain unit.

Retry now (`job.retryNow`, `retryJobsNow`) makes a filtered set due at once:
backoff and provider waits clear, prior errors stay, failed and cancelled Jobs
reopen with a fresh budget and generation, and running or member-paused Jobs
are left alone. A Run cancel is one set-based statement (`cancelRunJobs`);
subject-owned work (Location AI) belongs to its subject and survives a Run cancel.

`run.funding-resume` is keyed by funding window, not Run: its one handler
resumes every funding-paused Run. A funding-paused import stays `paused_auth`
rather than stopping for review. The Workflow boundary translates wrapped AI
budget stops into `ai_funding_window` Job deferrals at the same window end plus
60 seconds as the resume owner; provider funding/configuration stops defer until
the provider retry time. Neither consumes an attempt or discards frozen input,
page evidence or the Job cursor. Generic early retries leave a funding-paused Run
waiting while its funding-resume Job is pending. An explicit Run launch or
Resume makes its retained queued/backing-off Job due immediately, preserving
its generation, attempts and cursor and clearing the old wait reason; the next
page still checks current funding
and may pause again. Resume creates no paid grant; `run_now_paid` uses its explicit
paid authority. An explicit budget increase releases funding-paused discovery
before bringing queued Jobs forward; claims reacquire their query resource or
exclusive mailbox scope, while contenders defer under the same Job fence
without spending failure attempts. Until admitted,
a released discovery reads as paused rather than waiting for funding. The release
marker stays out of the public checkpoint and grants no overage. A fresh funding
stop clears it, keeping the funding owner's frozen deadline for the next wait.
Wait publication locks the Run before the Job, so a concurrent release cannot be
overwritten by the older timer. A raise that precedes the funding stop itself
does not release that later stop. Member pauses remain stopped.
Automatic mailbox admission joins the retained Run.
Run control refusals are
`RUN_CONTROL_REFUSED` (409), never 500.

## Image processing

Image processing retains every outcome. `ImageProcessingJob.state` stores
`pending` while open, `ready`, `failed` for a deterministic refusal needing
explicit retry, or `skipped` for a completed negative
subject lift or a moot ending (image deleted, upload replaced, processor superseded,
or type excluded: device work on a source type no device command carries, such as a GIF).
A subject lift's `no_subject` or `not_suitable` result is final for that source hash
and processor revision. Its negative evidence and attempt history stay recorded;
the derivative is skipped and the original remains usable. Apple descriptions
run independently for every image, with the narrow cloud-satisfaction rule below.
Other executor skips, including
`unsupported_format`, become deterministic failures with their reason preserved. A
stored `failed` retains the diagnostic, reported result and attempt history. The displayed
state derives from the Job (`image-job-state.ts`): `leased` for a live lease,
`waiting_for_device` for parked device work, `pending`, and `failed` ("Needs
attention") once a job failed `JOB_NEEDS_ATTENTION_ATTEMPTS` times in a row
or its execution stopped; transient failures keep retrying. An executor's `retryable: false`
stops automatic dispatch for these source/processor inputs. The matching cutout
projection fails in that same transaction while a ready
output stays intact; transient failures leave the cutout pending.
Storage verification failures retry; a verified content mismatch stops. Superseded failed jobs retire
as skipped while retaining their diagnostics and results. A missing
subject-lift derivative is rebuilt. Explicit image retry reopens a negative cutout
without discarding its evidence or allowing maintenance to immediately settle it again.
A changed source or new processor revision is new work, and
a newer Apple build's first pull makes backing-off device work due.

Only stored `pending` jobs have a waiting explanation. Displayed Needs attention
can mean either an open job retrying with backoff or a stopped job; the latter
must not say it is waiting for an Apple device. Work's View photos action opens
the failed display-state filter for failure attention, including both cases.
Detail summaries render the canonical field envelope, as the hero does.
Attempt totals retain earlier releases, lease expiries and failures under older
policies; the latest nonretryable result does not describe every earlier attempt.

Subject lifting uses `VNGenerateForegroundInstanceMaskRequest` on the concurrent
executor. On the affected macOS 27.2 runtime, the Swift Vision request repeatedly
reported cancellation for a uniform-color synthetic image with an uncancelled
parent, while this API returned zero observations. Only a successful empty
observation means `no_subject`; cancellation and all other errors remain failures.
Parent cancellation is checked before and after the request. Source bytes,
derivative identity and attempt history remain unchanged.

On-device descriptions use a fresh session, a full-frame image bounded to 1024 pixels,
and an initial explicit response budget of at most 512 tokens, reserved from the runtime
model context size. A context overflow retries once with 512 pixels and half the
response budget. Persistent failures retain the reported context/token counts and
retain their failed outcome until explicit retry or changed source/processor inputs.
A stored terminal Apple `guardrail_violation: ` or `structured_output_invalid: `
failure at the current processor revision leaves automatic Work failure attention
and the image's processing issue when a retained, undeleted current preferred cloud description covers the same
source hash. Both views use the same evidence predicate, including provider,
model, prompt, schema and normalization revisions. This satisfies the productive
description need with the retained cloud answer; it
does not make the Apple evaluation successful or establish that those inputs are
impossible to describe. The image-job list and detail project `cloud_satisfied` ("Satisfied by cloud")
using this same predicate. Their Needs attention filter and counts exclude covered
failures, and the processing quality check passes. This is a read-only status,
never a stored execution outcome: the Apple job and attempts remain failed, with
their raw reason, history and explicit image retry available. Source or preferred
cloud evidence changes remove satisfaction immediately from status and filtering.
Quality uses the same live projection for detail and the ordinary hourly quality
publication for list quality, with rule version 2; no read repairs a snapshot. Without that exact cloud evidence,
parsing failures remain actionable. Model
`refusal`, other errors, pending retrying work and failed subject lifts remain
actionable even with cloud evidence. No additional
cloud request or fabricated description is introduced. A structured parsing failure
retries only when the latest structured response is explicitly incomplete and
session output usage reaches the configured response cap. That fresh-session retry
keeps the image size and raises the output budget to at most 1,024 tokens, bounded
by one quarter of runtime context. There are at most two attempts total: context
shrinking and truncation recovery cannot chain. Unknown/complete response metadata,
below-cap output, arbitrary malformed parsing, and repeated truncation remain
terminal. No partial result is adopted. Typed conversion can succeed for an incomplete
string or final array element, so native code also requires the raw response
to be complete before adopting typed content. It applies the same bounded
truncation recovery to this case. This acceptance check changes no generation
inputs or processor identity and does not reopen retained failures. Terminal
parsing failures preserve the
original raw diagnostic in the existing server reason.
Before releasing the failed session, native code appends fixed metadata: attempted
image dimensions and response budget, session output usage, latest-response
structure availability, completion and root shape, presence and shapes of the
three expected properties, underlying error type, and raw diagnostic equality
flags. Missing response metadata stays unknown; older responses are not used.
Output usage of zero does not establish that no tokens were generated. The
snapshot excludes generated values and arbitrary keys and precedes the raw
diagnostic so it survives the existing 1,000-character failure-reason limit.
The full raw reason can still contain private content. Guardrail failures also
retain the SDK context debug description. Wording such as “Response may contain
sensitive or unsafe content” is useful diagnostic evidence, not an authoritative
input/output attribution; empty metadata and zero reported output usage cannot
resolve that distinction. Guardrails remain enabled.

On the measured macOS 27.2 runtime, the same retained image completed as plain
text but exhausted its budget under the current structured request. Removing
claims did not complete the free-text output; moving eligibility first produced
that enum without fixing the unfinished text. An enum-only request completed
with both retained inputs, including one that refused plain-text descriptions.
These comparisons establish request/output-shape dependence on that runtime,
not a general image-input prohibition. No experimental prompt or schema is
shipped without a complete description, eligibility and claims on both retained
inputs and synthetic controls. [#3791](https://github.com/nickysemenza/cubby/issues/3791) was closed as not
planned: retained current cloud descriptions satisfy these productive needs.

Recurring image-execution repair also settles retained negative cutout failures in
bounded batches. This negative-outcome pass requires the current source/revision and the matching settled
attempt, locks the image and unleased image job, and leaves a running attempt
alone. Attempt records, result evidence and runtime
provenance are retained. The repair does not execute the image again or reclassify
model, network or other processing errors as negative cutouts.

`ImageProcessingJob` is the sole owner of image execution: `lane`, `runAt`,
`leaseUntil`, `failures`, `waitReason` and the current `attemptId` live on the row,
and nothing else queues it. Cloud rows run through `cloudImageDrain`, a registered
drain (`generic/background/drains.ts`) whose items have no Job row: it claims due rows under a
16-minute lease that nothing renews, because no consumer outlives 15 minutes. A
crashed page is reclaimed after that, and a reclaim counts as a failure.
`imageProcessingLane` fixes each job's lane: subject lifts, Apple descriptions
and AVIF cloud descriptions (which need device JPEG preparation) run on
devices; other cloud calls on the server. Device pulls claim parked work
directly and prefer work whose last attempt ran on another device.
They skip busy source rows, so an empty pull can precede a later hand-off
while work remains owed. Consumers retry through their ordinary pull cycle.

Device wire contract:

Companion completion loads cloud execution only when adopting a device-prepared
input that needs a cloud description. Ordinary Apple results use the lightweight
description policy for their exact retained fingerprint, without initializing
cloud execution merely to compute that identity.

- `imageProcessing.pull` leases for `leaseSeconds` (default 60, 20–300) and
  accepts optional `maxCommands` (1–16, default 1). `commands` contains up to
  that many commands in hand-off order; the retained `command` field is its
  first item or null. Older clients keep receiving one command without an
  update or minimum-version change. A batch uses one transaction and one
  advisory lock. A bounded candidate page avoids rescanning the full queue for
  every slot; each hand-off rechecks due times and leases within that page, preserving per-command capabilities, device preference,
  attempts, leases and presigned URLs. A prepared row cannot re-enter the batch
  even if its initial lease expires during later preparation. Immediately before
  hand-off, still-owned leases are re-armed together and every returned command
  receives the fresh deadline. An empty array/null command means no
  hand-off: refused claims are released first. A preparation failure releases
  and backs off that claim. An already prepared prefix is returned; if there
  is none, the pull throws after the release commits. Neither valid commands
  nor the failed candidate can become invisible behind a batch error.
- `imageProcessing.renew` `{jobId, attemptId, deviceId}` extends the lease by
  60 s while the attempt still owns it, including an expired lease no newer
  claim replaced. It returns `{ok: true, leaseExpiresAt}` (the new command
  deadline) or `{ok: false, reason: "lease_lost" | "job_obsolete"}`; the
  device stops either way. Devices renew every 15 s.
- `imageProcessing.release` is never an attempt.
- `imageProcessing.complete` after expiry is adopted while the attempt id is
  unchanged; after a newer claim it returns `{adopted: false}` and a late
  failure is kept in the old attempt's history.

A typed provider wait or an exhausted AI budget is never an attempt on any
cloud call, including the description of a device-normalized AVIF
(`deferCloudAttemptForTypedWait`): the claim is released until the wait ends.

A photo-inventory Run's description gate accepts the Apple or the cloud
description; `cloudDescriptionMissing` and `withoutCloudDescriptionCount`
note photos grouped while their cloud description waits (for funding, say).
A description that settled without one (`failed` or `skipped`) holds the
Run for the member, who can continue without those photos; the coordinator
never starts on a photo it has no description for.

Each image job reads `leaseDeviceId` (the `DEV-` code whose attempt holds
the lease, live or expired) and `leaseExpiresAt`. Assigning an executor
records it as the Job's `leaseHolder` in the same transaction. Its saved views are
`waiting-for-apple` and `processing` (live leases).

## Diagnostics and repair

A Worker memory termination can prevent item failures or a checkpoint from
being recorded. Read invocation outcomes alongside Run counters; a zero item
failure count alone does not establish uninterrupted execution.

- `job.runRollups` and `job.list` (`rollup`): a Run's live Jobs by reason
  (`leased` counts live leases; lapsed ones are `expiredLeases`, summarized as
  "N expired leases awaiting reclaim"), its own funding wait, and `stalled`
  when nothing was claimed or finished for `RUN_STALL_MS` and no live lease is
  in flight. A Run's demand is the Jobs and image rows it owns by `runId`; shared
  drain Jobs belong to no Run.
- `job.deviceBacklog`: due Apple-device work, the Runs it holds up, devices
  that started an attempt in the last ten minutes (`Device.lastSeenAt` moves
  only on hello), device attempt starts per minute (reclaims included), and an
  ETA based on distinct accepted successful device completions over the last ten
  minutes. The completion sample excludes normalization, failed attempts and stale
  image sources. Without a successful completion sample the ETA is unknown.

Every supplied retry restriction intersects, including row IDs and Run scope.
Runs use the generic `attention` saved view: member-visible stopped Runs that
have no successor, plus stalled Runs, ordered stalled first then newest.
AI cost is the Run's
recorded charged usage. Apple Activity hands the household queue off to
`/work-queue` ([native Activity](../apps/apple/README.md#activity)).
The web audit-log changes feed follows the queue.

The hourly cron calls `maintainJobs` directly: one bounded image-repair page and
one retention page per tick. It also reconciles stopped executions and
dispatches each tick (`reconcileStoppedWork`). No maintenance Job or result timestamp is enrolled.
Completed Jobs retain eight days, cancelled fourteen and failed thirty, under
the existing pending-work and identity safeguards. A failed Job whose Run is
terminal, not manual, not a member request and not mail or financial import work
(`mail_import`, `mail_discovery`, `mail_search`, `mail_reclassify`,
`purchase_validation`, `account_sync`) is pruned after fourteen days. Only Job
rows are deleted; Runs stay as AiUsage cost evidence. Domain evidence stays.
The same tick retires pending field Suggestions older than fourteen days when
the field is not `reviewRequired` and no member decided them; statement and
recommendation Suggestions wait for a member and never expire. A tick expires up to
5,000 rows, so a backlog clears within hours.

`generic/jobs/repo/observation.ts` reads the real owners for Activity, maintenance,
MCP and native clients. `job.activity.rebuild` replaces the standalone maintenance rebuild-status operation. Rebuild movement is its last committed page, independently
of `finishedAt` and `cleanAt`. Failure totals name their units: failed work items, image-processing attempts
or rebuild pages, never invented execution counts. Run ETA reads remain
unchanged. Search repair reports committed record computations and failed pages;
its unknown total stays indeterminate.

A permit acknowledges whatever its unit's outcome: the unit's rows own its
retries. Only a failure before or around selection (the database unreachable)
retries delivery, three times, 30 seconds apart.

| Job kind                                                     | Why a row                                      | Owner of the result           |
| ------------------------------------------------------------ | ---------------------------------------------- | ----------------------------- |
| `run.execute`                                                | Lease, pause and retry for a Run               | The Run                       |
| `purchase.dispatch`                                          | Durable handoff to the agent, deduped by event | The Run and its agent session |
| `run.funding-resume`                                         | Waits for a funding window to end              | The paused Runs               |
| `image-metadata.extract`, `location-ai.*`                    | One per record, replaced on re-admission       | The Image or Location         |
| `calendar-feed.mark-dirty`, `maintenance.purchase-discovery` | Keyed single passes                            | The feed, Vendor or queue     |

Everything else is a drain over its owner's rows and has no row here. AI refresh activation
is a function of the cron tick. The table stays named `Job` because `Task` is the household
entity's table.
There is no per-kind queue health or alerting: with a few dozen coarse Jobs,
Activity's counts and a stalled Run show a stuck queue directly.
Work excludes a retained failed evaluation after its owned retry receipt hands
off to a replacement, or after all remaining live requesters have handed off.
A shared failure remains visible while any uncancelled requester still needs
that original evaluation. Retry history and diagnostics remain stored.
Runs explicitly cancelled or aborted by a member, and permanently retired
coordinators, remain in history without advertising execution recovery. Work and
the Run `needsAttention` value share these stopped-state guards. Ended scheduled
historical routine step kinds without an executor also leave recovery attention
only when they have no live Job, owned or requested evaluation roster,
unresolved image job, active finding or proposed photo group. Manual Runs,
funding stops and current executors remain visible. The manifest declares this
history; no Run, step or transcript is retired or rewritten by the read.
The Runs attention saved view and stuck rollup additionally use
`ATTENTION_RUN_PURPOSES`, which omits routine kinds; Work retains actionable
routine failures such as connection discovery. These are three distinct history
guards: member stops and retired coordinators, settled AI recovery, and ended
historical routine execution without obligations. A failed `ai_refresh` Run with
`ai_work_failed` also stops advertising recovery when it has a durable owned
roster, all current owned and requested evaluations are terminal (including
blocked), and no live Job or unresolved image job remains. Effective request
receipts and cancellation follow evaluation tally semantics. Retry handoffs can
transfer responsibility to another owner and must resolve to retained evaluations;
an applicable request receipt still takes precedence. Malformed, missing, self-linked or cyclic targets,
and chains exceeding 64 edges, keep recovery visible. Current writers create
forward-only handoffs; the path checks defend against manual repairs and future
writers too. Paid `result_ready` work
and current failures retain recovery. These are single-statement projections;
evaluation-only settlement becomes visible on the next poll without a synthetic
Run change or badge-only relaunch. Failed status, diagnostics, results, requests,
member cancellations and conversations remain stored. Stalled execution, source
Problems, findings and pending photo proposals retain independent review paths.
These projections do not retire coordinators.

## Producers

Queue messages are best-effort wake-ups for intent already committed in
PostgreSQL. The shared `wakeJobs` sender uses the fetch request's `waitUntil`
lifetime, so a slow queue send does not delay a committed mutation receipt.
Without a request context (including queue and cron invocations), the caller
still awaits the send. Queue failures receive bounded delivery retries; daily/app-open recovery repairs exceptional missed
wakes; transaction rollback schedules no wake. Producers use this same sender
rather than implementing their own request-lifetime branch.

A background task kind is its schema in `backgroundTaskSchema`
(`@cubby/schemas/background-tasks`), its member-facing `JOB_KIND_POLICY`
entry, and one declaration in `server/workflows/background-tasks/kinds.ts`
carrying the Job key, the handler and provider fencing. Publishing and the
drain both read that declaration; a handler parses only its own kind. The key
is the queued Job's identity, so changing one orphans queued rows.

A producer must not enqueue faster than the drain can serve; the retired
connection-discovery pass once enqueued an evaluation for every household record
(~55k), which starved every other kind for days. No producer fans out per record
now.

- `run.funding-resume` is one Job per funding window; its handler resumes every
  paused Run.

Each AI evaluation slot identifies feature, entity, record and field. A generated text key uses UTF-8 length prefixes;
input and option fingerprints remain execution evidence, outside the slot key.
A partial unique index permits one `queued` row per slot and execution kind;
retry and lease state live on the evaluation's work item, never in
`AiEvaluation.state`. The pending
share-key lookup is nonunique: a `result_ready` row keeps its paid result while
a queued successor waits in the same slot. A retry carrying a retained answer
never joins that queued successor: it retains a separate `result_ready` row and
leaves the successor's demand and any in-flight attempt unchanged. Changed input
updates the queued row's snapshot, target, provenance and work key in place, clears any result,
receipt or error captured for its older input, and re-marks its item so an
attempt in flight cannot publish. Completed current input is not queued again
for `ai_refresh`. Member-initiated sweep, reclassification and retry requests
get a fresh evaluation; pending slots can be shared only within the same
execution kind. Discovery audit receipts never reuse reclassification work, even
when both describe the same Email and feature. A completed discovery with a
request pointing to another execution kind or a missing receipt reports
incomplete audit coverage; current Email state cannot reconstruct the lost
handling receipt. Reverting after another input was evaluated creates a new row
and reuses the AI response cache.
Declined input (`blocked`, `obsolete`, or cancelled as superseded) receives at
most three automatic attempts; member-cancelled Runs veto automatic
readmission. Attempt suffixes keep work keys unique without receipt chains.
Explicit member retries retain their `retryEvaluationId` receipt.
Admission includes automatic evaluations without a Run: unchanged queued or
completed input is skipped before taking the scheduling lock, and changed input
updates the queued slot in place. Run failure codes still fence member-cancelled
work.

### Embedding execution

Embeddings run on two registered drains whose items have no Job row
(`generic/background/drains.ts`). A `SearchDocument` owes a fresh embedding when
`embeddingDueAt` is set; a failure backs off on the document, and Vectorize
visibility polling reschedules it without spending an attempt. An `EntityEmbedding`
that is retired or failed with no `deletionId` owes a vector deletion, so nothing
marks it; a failed deletion waits on `deletionRetryAt`. The cleanup is safe to repeat
because only the receipt settles it.

A refresh keeps source dirtiness and execution apart. `embeddingGeneration` is the
intent, and a mark advances it at any time. `embeddingLeaseToken` and
`embeddingLeaseUntil` name the page allowed to pay the provider, and a mark never
touches them, so the hourly cron or a page across a deploy skips a held document even
after a re-mark. The lease outlasts the 15 minutes a consumer can run, so a crashed
page's documents come free on their own. Settling needs both the lease and the claimed
generation. After the provider has been paid, an upload needs the lease and either that
generation or text that still hashes the same, and its receipt then needs only the
lease: the next page adopts the receipt. Changed text uploads nothing.

An artifact moves `prepared` → `submitting` → `submitted` → `selected` →
`retired` (or `failed`). Each step that precedes a provider or Vectorize call
commits first through `ctx.fenced`, so an interrupted page resumes from its
receipt (`submissionId`, `vectorHash`, `observedAt`) without paying for the
embedding again. One in-flight submission per source and configuration
(`EntityEmbedding_one_submission_key`) sits beside at most one selected vector
(`EntityEmbedding_entity_model_key`).

Fresh submissions with the same provider/model/dimensions share one embedding
call and Vectorize upload. Requests contain at most 2,048 texts and 300,000
UTF-8 bytes, a conservative bound on OpenAI's 300,000-token request limit;
inputs over 8,192 bytes run alone, preserving provider validation of the
8,192-token input limit without failing neighbors.
[OpenAI owns these provider limits](https://developers.openai.com/api/reference/resources/embeddings/methods/create).
A configuration mismatch settles obsolete and re-admits current work. Visibility
polling postpones its item every 5 s without spending an attempt; an upload
still invisible after two minutes fails that item, which backs off and keeps
its receipt. Vectorize rate limits (including `VECTOR_DELETE_ERROR` 40041 with
`Too Many Requests`) back off the item.

Visible uploads publish as chunks through the drain: sorted source locks, then
identity locks, one search preparation, one retirement update, one multi-row
selection insert and one reader notification. A vanished or changed source
fails or settles alone. Cleanup deletes only an unselected, stopped artifact
and records its delete receipt, so a delayed cleanup can never delete a
replacement upload. A shared provider call has no single owner: `AiUsage`
keeps one row per provider call, attributes it to the daily background Run and
records the provider's total tokens once. Embeddings remain outside frontier
funding caps.

## AI evaluation drains

Expected evidence invalidation is a typed obsolete outcome, including acquisition
eligibility that changed while inference ran and a Sweep basis changed after
queuing, before inference or paid-result reuse. Ordinary provider text never decides
obsoletion. Funding/configuration refusal defers the affected feature without
spending target attempts; it preserves the configured provider route and probes
again after a bounded wait. The paid rung treats the Gateway's explicit
"Insufficient balance; add money to your gateway or use BYOK" refusal as a funding
stop even when it arrives as HTTP 403 / `invalid_prompt`; that wrapper is not
proof that the prompt is malformed or that the household Run budget was spent. Gateway admission carries its actual retry time.
Prepared paid siblings publish before a provider stop defers the remaining work.
Publication checks exact chunk leases under the ordered target locks, including
expiry; preparation still checks the whole claimed page. Atomic evidence,
activation, member-stop and receipt fences remain in the publication transaction.

`ai/evaluation` owns the drain, its items and evaluation pages. Run authority
(live Run checks, pausing, funding resumption, the workflow fence around one
evaluation) comes in through the `AiEvaluationExecution` port that
`domains/run/service/ai-evaluation-execution.ts` provides; the drain itself
knows no Run tables. Automatic refresh work has no Run: its `runId` is null and its activation is the
authority. A member stops it from the Work page or `ai.stopAutomaticWork`: discovery
admits nothing, owed rows are parked, and `leaseStale` fails any attempt in flight.
It holds until a member resumes. Sweeps keep their Run. Saved-record
questions and Sweeps are the only producers of field evaluations; no discovery
drain walks the household. Nothing queues an evaluation: `AiEvaluation.runAt` is set while
the drain owes it (`priority` 0 when the owner or an uncancelled requester is a
running, member-visible Run nobody scheduled; otherwise 1) and null once it settled
or parked. Each feature is its own permit unit, so features page in parallel up
to the queue's concurrency. A page claims
rows under one `leaseToken`, a 16-minute lease nothing renews because no consumer
outlives 15 minutes. The token is the attempt (`aiEvaluationAttemptToken`), and a
mark never takes a held lease, because that page may be paying the provider: no
sibling claims the row until the page releases it or the lease lapses. New demand
for the same input leaves the attempt to settle it. Changed input sets `leaseStale`,
which makes the attempt obsolete and fails its writes, and the next page evaluates
the new input once the row is released. Prepare rechecks live Run authority, activation, pending or
`result_ready` state and generation; queued obsolete generations retire in sets
before inference, and a stopped requester parks its item. A paid answer is
written as `result_ready` through `ctx.fenced` before publication, so a later
publication failure reuses it instead of buying it again.

Single-evaluation publication owns the same bounded snapshot recovery as paged
publication. A serialization conflict replays the DB-only callback, lease and
authority checks, settlement receipt and activation fence in a fresh transaction;
inference and retained paid-result storage stay outside that boundary. A
caller-owned transaction still owns its recovery and is not replayed locally.
Automatic application propagates serialization failures to that owner, including
preflight failures before review's savepoint. An aborted serialization attempt is
never converted to an ordinary policy refusal and then used for more publication.
Field publication re-reads the declaration's read path, including mutation aliases
such as `ingredientId` exposed as `ingredient.id`. A loaded nullable relation is
empty; an absent root or missing governed result remains unavailable and cannot
authorize a proposal.

Failures map at the drain seam: invalidated evidence settles the evaluation
`obsolete` as a publication outcome; AI budget, provider capacity and AI
Gateway admission throw `JobDeferredError`, which stops the page without
spending attempts; anything else is the item's failure, and its third
consecutive failure settles the evaluation `failed` with the raw error and
settles its requesters. A Run cancel withdraws its requests and stops owing
evaluations no other requester still wants. Paid concurrency is bounded by the
queue's `maxConcurrency`.

A governed target field whose current result is unavailable is that target's
failure (`JobTargetError`), not an empty value or obsolete evidence. At
publication its chunk rolls back and splits, so siblings commit without new
inference; the target stays owed and spends item attempts as above.

Each page observes up to 8 items; the rest stay owed and the drain rejoins fair
selection after the page's checkpoint. Items run two at a time, each in its own
guarded transactions under the drain lease. Heartbeat and completion logs
annotate `drain.claim`, `drain.prepare` and `drain.publish` phase timing without
logging prompts or household evidence; the Job `page` log carries `pageResult`,
limited to the numeric `processed`, `published`, `failed` and `covered` counts.
Publication commits one SERIALIZABLE transaction per item chunk; a failed chunk
splits only after its transaction rolls back, and committed siblings never
replay. Product identity, connection and Email refresh evaluation no longer
exist; the drain evaluates field and statement work only.

## Apple version gate

Device work stops when the server refuses an older build's writes (HTTP 426):
the worker stops pulling and shows "Update required to process images". Raise
the minimum only for unsafe writes; see
[breaking changes](agents/domain-rules.md#breaking-changes).

## Member-facing work explanations

Work is the web entry point at `/activity`: one Background work list (the
health verdict, then each stuck or failed kind, device wait and stopped Run with
its retry) and one Needs you queue. `workQueue.status` is the single read behind
that list and the sidebar's stuck glyph, and agents can read it too. It adds no
alert engine, stored lanes or retry policy; old `tab=` links redirect to
`/history`, `/suggestions` and Settings, and a `refresh=` locator to the value's
record. The Needs you count is the Work queue's own published total
([work queue](guide/work-queue.md)); the status read carries none. A failing
kind reads as failing since the earliest `Job.failingSince` of its rows (the last
update for rows from before that column), and its diagnostic names the last
execution's error class with the stored error.

Stuck is decided on the server from completions over a window, never from a
snapshot of what is running, which reads as stopped between a drain's bursts:

- A drain or Job kind has work due for 30 minutes with no completion in those 30
  minutes. Retained tickets the drain never claims are not owed work. A drain's completions are published `DerivedValue` rows and its Job's
  latest page result. Thirty minutes outlasts the gaps between bursts and is half
  the one-hour lag members are promised, so the alarm shows before that breaks.
- A kind keeps failing: failed in the last 7 days with no later completion, or
  live with `JOB_NEEDS_ATTENTION_ATTEMPTS` failures. A drain item in that state
  counts, but Retry is withheld because retrying its Job does not move the item.
- Apple-device work has been due for 30 minutes and no device worked in 10.
- A Run a member started or reviews stalled, or its purpose failed in the last 7
  days with no successor and no later completion. A scheduled or discovered Run
  retries on its own, so it needs three failures in a row. Paused Runs are a
  member's choice and are never stuck.

For AI evaluations, settling obsolete evidence also advances the last-finished
signal: a queue retiring stale inputs is moving. It does not count as a completed
value or increase the published-value pace. Blocked admission and member
cancellation do not advance that signal.

Due for 15 minutes while still completing reads as catching up. Copy lives on the
kind (`stuck` in `JOB_KIND_POLICY`); an undeclared kind falls back to its label so
it cannot be silently invisible. The read probes indexes per drain and priority
and reads live and recently failed Jobs, so its cost does not follow queue size.
It takes the `run` and `workQueue` cache tags, not entity roots.

`RUN_KINDS` owns Run purpose, triggers, effects and declared steps.
`JOB_KIND_POLICY` in `packages/schemas/src/job.ts` co-locates each Job kind’s
member explanation with its unchanged execution policy; the server kind-policy
module re-exports that policy. Run and Job execution views show these definitions,
while actual outcomes,
waits, raw errors and retry controls remain on their existing records.
Definitions are not evidence that execution happened. Retained unknown kinds
keep their diagnostics and explicitly lack a current definition.

Daily maintenance is a `maintenance` Run, separate from the daily
`jobs.maintenance` queue-upkeep Job. Its declared effects are inspectable before
launch; it remains one standard action. Exact input populations become known
at step start, provider estimates stay estimates, and one-call/admission
tallies do not imply a fixed total or ETA. Image maintenance classification
counts use the current processor revision and can overlap; uncertain cutout
eligibility does not imply a human review queue.

Coordinator transcripts are preserved until explicit member-authorized retirement.
The maintenance `coordinators` step does no retirement, for both scheduled and
manual passes; all other steps continue normally. The retirement mechanism is
retained, but its previous 24-hour threshold is disabled. No Run status,
transcript, source evidence, finding or paid result is changed by this policy.
The retirement pass's automatic closure of legacy execution alerts on already
retired Runs is also suspended; those findings remain stored.

## Deadline scheduling and idle recovery

PostgreSQL owns Jobs, drain items, claims, progress, member pauses and retry policy.
Nothing but Postgres holds a deadline. A unit's successor permit is delayed to the
next owed time (at most twelve hours, Cloudflare Queues' delivery-delay limit);
the hourly cron reaches anything later and anything whose message was lost. A
permit cannot be cancelled, so a stale one touches Postgres once and finds nothing
due. A process dying between commit and its post-commit signal recovers on app-open
or the next hourly tick.

The hourly cron is the timer for work due later and the backstop for a lost permit
or broken delivery: it reconciles, runs `maintainJobs`, runs units itself for up
to five minutes, then sends up to `maxConcurrency` permits for what is still due
(one delayed permit when the next work is later). Daily recovery runs at 7 a.m.
America/Los_Angeles: the invocation at that household hour also runs the daily pass.
Every daily step is idempotent, and the nightly pass is keyed by its household date
(`Run.clientKey`), so a repeated invocation reuses that date's pass even after it
finished. Only an earlier date's budget-paused pass makes way for a new one. A failed
permit send retries three times over about five seconds before the hourly cron is its
only recovery.
The first hourly tick after a deploy activates that Worker version's AI policy.
App-open coalesces recovery and mail discovery. Gmail provider push is not implemented here.

`job.activity` and the status page report what runs, waits and last finished.

### What references a Run

A Run is a member or agent session plus its history. These foreign keys are why old routine
Runs stay: no row is nulled or purged. Automatic work creates none of the rows marked
"session", and rows marked "no Run" can now have none.

| Reference                                                                                                                             | Disposition                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `AiUsage`, `AiEvaluation`                                                                                                             | Session, or no Run for automatic work; `feature` and the actor attribute cost |
| `AiEvaluationRequest`                                                                                                                 | Session: a Run's request for an evaluation                                    |
| `Suggestion`, `RunFinding`, `AuditLog`, `McpToolCall`, `Job`                                                                          | Nullable provenance; cleared if a Run goes                                    |
| `RunOperation`                                                                                                                        | Exact-replay receipts, kept                                                   |
| `RunControlEvent`, `RunApproval`                                                                                                      | Member history; `RunApproval` has no reader and keeps its rows                |
| `RunStep`, `RunPushRegistration`                                                                                                      | Owned by the Run, deleted with it                                             |
| `Email`, `EmailCandidateObservation`, `EmailClassificationObservation`, `EmailRetrievalFailure`, `SourceOrderObservation`, `Purchase` | Source provenance, kept                                                       |
| `ImportPreparedOrder`, `ImportSourceClaim` (`firstRunId`, `lastRunId`)                                                                | Import session evidence, kept                                                 |
| `PhotoGroupProposal`, `PhotoRunImage`, `ImageProcessingJob`                                                                           | Photo session and device work, kept                                           |
| `Run` (`parentRunId`, `predecessorRunId`)                                                                                             | Lineage, kept                                                                 |

### Routine Run history

Default Run lists and counts omit `ai_suggest` and `background`, omit `ai_refresh`,
`connection_discovery` and `derived_refresh` once they ended, and omit `mail_discovery`
once it completed. An explicit purpose filter includes them, and direct record reads
still work. Automatic work no longer creates `background` or `ai_suggest` Runs: AI usage
and evaluations can have no Run, and only a published connection suggestion still opens
an `ai_suggest` Run because its Suggestion slot is scoped by that Run. Executed workflow retries can
resume the same Run and its committed steps; a retry does not universally create
a successor. Queue runtime failures receive three delivery retries in addition to
the durable Job's execution retry policy.
