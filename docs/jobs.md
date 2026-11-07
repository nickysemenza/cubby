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
`SearchDocument`, `EntityEmbedding` and `ImageProcessingJob` own their scheduling. The first three supply a `DrainStore`
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
when a serializable transaction replays. Retained items stay owed. Empty pages
report their next due time; they have no idle publication or recurring Job.
Connection discovery holds one AppSettings cursor and returns a two-minute
continuation. Its retained legacy `runId` launches once after its pass finishes;
retained member stops and terminal errors remain stopped. AI refresh no longer
starts a separate automatic Sweep for connections.

One-record work stays a Job: Run execution, Location AI, image metadata,
calendar invalidation and purchase dispatch. Image processing owns its own row.
Job `generation` remains the supersession fence and Run execution attempt number.
Outcomes live on domain owners; Jobs retain no result JSON. `availableAt` is the
only stored wait deadline. Completed Jobs remain until retention prunes them.

## Kinds and lanes

`apps/web/src/server/generic/jobs/kind-policy.ts` is the one registry of
per-kind policy: lane, internal flag, `maxAttempts` (null never exhausts) and
failure backoff. A kind absent there is a server kind with three attempts and
1 s doubling to 60 s backoff. Each lane names the executor that runs it:

| Lane       | Kinds               | Executor                        |
| ---------- | ------------------- | ------------------------------- |
| `external` | `purchase.dispatch` | a coordinator outside the drain |
| `server`   | every other kind    | the server drain                |

Device image work is parked on its own row and never reaches the drain.
Enqueueing it rings connected
companions after commit, and a companion connecting to the doorbell is rung at
once; there is no polling interval. Work that comes due later (a failure
backoff, a deferral, a lapsed lease, a delayed release) rings through a
Queue-delayed wake carrying `ring`. A delay past one hour is left to the hourly
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
Mailbox discovery acquires at most five messages from its frozen provider page
per Job claim. Its durable message offset resumes the remaining messages without
replaying the completed prefix; absent offsets on retained pages mean zero.
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
by a later pass can be restored from that Run's frozen scope. A changed position
for the page's own query or history still refuses the checkpoint rather than
rewinding it.

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

`dueJobs` (private to `generic/jobs`) selects up to `JOB_DRAIN.batch` due
Jobs from one snapshot:

1. `run.execute` and Jobs whose `runId` is a running, member-visible Run lead
   (routine Runs such as connection discovery do not).
2. Within each class, kinds take turns: every kind's first Job, then every
   kind's second, with the least recently claimed kind first; within a kind,
   priority then age. A 100k flood of one kind therefore never starves
   another.

Timed Jobs and woken Jobs scan separately, so terminal history is never
searched to find a wake. The latest claim per kind comes from the
`(kind, lastClaimedAt)` index, including completed Jobs so that finishing a
pass never erases its service history.

Member-first ordering inside a drain is item priority: root transactions in
Job execution mark derived inputs at priority 1, member transactions at 0, and
savepoints inherit the outer transaction's priority.

The drain runs up to `JOB_DRAIN.concurrency` Jobs at once. The queue consumer runs
one batch at a time (`maxConcurrency: 1` in
`packages/shared/src/background-queue-consumer.json`), so one long active batch
holds accepted wakes undelivered. Smaller pages reduce that exposure, but one
provider wave can still run for minutes; no wake has a hard delivery time.

Free lanes refill while siblings run. A refused claim of an uncapped
kind stays excluded until another page makes progress, then rejoins fair
selection; progress during an in-flight refusal also permits reconsideration.
Capped kinds remain excluded for the invocation. Refusals still consume the
existing page budget, so locked rows cannot spin without bound. An escaped lane
error stops new selection, and the drain still joins active lanes before
returning it. The 20-second budget limits starting work, not the lease: an
in-flight provider call may cross it and still publish. A drain that stops
with due work left publishes another wake.

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
CPU: a drain can execute other pages within its existing wall-time budget.
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
proposal graphs or logging source content. They do not attribute invocation CPU
to one Job: maintenance and evaluation pages can run in the same invocation.

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
expired. A wake is only a Queue message that makes the drain look sooner (`wakeJobs`, `wakeAt`);
it carries no durable state, and the hourly cron recovers a lost one. `enqueueJob({ invalidate:
true })` is the only restart: it bumps the generation and clears the lease, so the old pass
fails its fence. Connection discovery repeats through its cursor; automatic work has no recurring Job.

## Retries

Claiming is not an attempt; a failure is, and so is reclaiming an expired
lease (the previous executor vanished mid-pass, and a crash loop must still
exhaust). A failed Job backs off by its policy, `baseMs · 2^(failures - 1)` up
to `maxMs`, and fails after `maxAttempts`; `maxAttempts: null` never exhausts. `releaseJobClaim` hands a claim back without an
attempt, and deferrals never count. Drain items keep their own attempts and
backoff.

Serialization recovery is bounded inside a DB-only snapshot transaction. If all
attempts roll back, its owner emits `SnapshotWriteConflictError`; the durable Job
then backs off without exhausting its attempt budget. A raw SQLSTATE on an
after-commit effect is not this signal and cannot request unbounded replay.
Location description and inventory-analysis Jobs also never exhaust and use a
one-minute base with a fifteen-minute backoff cap: unchanged
failures keep diagnostics and backoff until corrected code or input heals them.
The model-input recovery migration reopens their retained failures and proven
failed outer Email gates, preserving checkpoints, attempts and errors. Reopened
location work is staggered over fifteen minutes without advancing an existing
future deadline. When the recovered universal Job executes, its matching Run reconciled to
`job_failed` returns to running under the Job fence. Another active Run owning
the admission slot causes retry backoff until it finishes;
member-controlled, retired and superseded Runs are excluded. Member
pauses/cancellations and running leases keep their states.

Retry now (`job.retryNow`, `retryJobsNow`) makes a filtered set due at once:
backoff and provider waits clear, prior errors stay, failed and cancelled Jobs
reopen with a fresh budget and generation, and running or member-paused Jobs
are left alone. A Run cancel is one set-based statement (`cancelRunJobs`);
never-exhausting work belongs to its subject and survives a Run cancel.

`run.funding-resume` is keyed by funding window, not Run: its one handler
resumes every funding-paused Run. A funding-paused import stays `paused_auth`
rather than stopping for review. Run control refusals are
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
still run independently for every image. Other executor skips, including
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
On-device descriptions use a fresh session, a full-frame image bounded to 1024 pixels,
and an explicit response budget of at most 512 tokens, reserved from the runtime
model context size. A context overflow retries once with 512 pixels and half the
response budget. Persistent failures retain the reported context/token counts and
remain visibly failed until explicit retry or changed source/processor inputs;
no cloud fallback or fabricated description is used. Structured parsing failures are
terminal and preserve the original raw diagnostic in the existing server reason.
Before releasing the failed session, native code appends fixed metadata: attempted
image dimensions and response budget, session output usage, latest-response
structure availability, completion and root shape, presence and shapes of the
three expected properties, underlying error type, and raw diagnostic equality
flags. Missing response metadata stays unknown; older responses are not used.
Output usage of zero does not establish that no tokens were generated. The
snapshot excludes generated values and arbitrary keys and precedes the raw
diagnostic so it survives the existing 1,000-character failure-reason limit.
The full raw reason can still contain private content.

Recurring image-execution repair also settles retained negative cutout failures in
bounded batches. This negative-outcome pass requires the current source/revision and the matching settled
attempt, locks the image and unleased image job, and leaves a running attempt
alone. Attempt records, result evidence and runtime
provenance are retained. The repair does not execute the image again or reclassify
model, network or other processing errors as negative cutouts.

`ImageProcessingJob` is the sole owner of image execution: `lane`, `runAt`,
`leaseUntil`, `failures`, `waitReason` and the current `attemptId` live on the row,
and nothing else queues it. Cloud rows run through `cloudImageDrain`, a registered
drain (`generic/background/drains.ts`) with no Job row: it claims due rows under a
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
one retention page per tick. No maintenance Job or result timestamp is enrolled.
Completed Jobs retain eight days, cancelled fourteen and failed thirty, under
the existing pending-work and identity safeguards. Domain evidence stays.

`generic/jobs/repo/observation.ts` reads the real owners for Activity, maintenance,
MCP and native clients. `job.activity.rebuild` replaces the standalone maintenance rebuild-status operation. Rebuild movement is its last committed page, independently
of `finishedAt` and `cleanAt`. Failure totals name their units: failed work items, image-processing attempts
or rebuild pages, never invented execution counts. Run ETA reads remain
unchanged. Search repair reports committed record computations and failed pages;
its unknown total stays indeterminate.

A Queue batch runs one drain attempt, even on failure. All messages acknowledge
or retry consistently. Job and row drains return continuation hints; their round
owner coalesces the wake. Pre-execution recovery wakes remain armed.

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
Runs explicitly cancelled or aborted by a member remain in history and leave
the recovery attention roster through the same predicate used by Work sources. Source Problems and pending reviews retain their own lifecycle.

## Producers

Queue messages are best-effort wake-ups for intent already committed in
PostgreSQL. The shared `wakeJobs` sender uses the fetch request's `waitUntil`
lifetime, so a slow queue send does not delay a committed mutation receipt.
Without a request context (including queue and cron invocations), the caller
still awaits the send. Queue failures receive bounded delivery retries; daily/app-open recovery repairs exceptional missed
wakes; transaction rollback schedules no wake. Producers use this same sender
rather than implementing their own request-lifetime branch.

A producer must not enqueue faster than the drain can serve. One unbounded
connection-discovery pass once enqueued an evaluation for every household
record (~55k), which starved every other kind for days.

- Routine connection discovery (`discovery.connections`) queues one
  evaluation page (`CONNECTION_ROSTER_PAGE`, 100 records) per pass and holds
  its cursor while `CONNECTION_DISCOVERY_PENDING_CAP` (1,000)
  connection evaluations wait (`rate_limit`). Evaluation settlements make the
  existing discovery Job due; a one-hour deadline repairs a missed release.
  There is no 30-second idle polling. It walks the newest records first. Its work has no Run, so a
  member's Stop for automatic AI work holds its cursor. A changed record updates its queued slot in
  place, retaining its Job.
- `run.funding-resume` is one Job per funding window; its handler resumes every
  paused Run.

Each AI evaluation slot identifies feature, entity, record, field and (for a
Product pair) the other Product. A generated text key uses UTF-8 length prefixes;
input and option fingerprints remain execution evidence, outside the slot key.
A partial unique index permits one `queued` row per slot; retry and lease state
live on the evaluation's work item, never in `AiEvaluation.state`. The pending
share-key lookup is nonunique: a `result_ready` row keeps its paid result while
a queued successor waits in the same slot. Changed input updates the queued
row's snapshot, target, provenance and work key in place, clears any result,
receipt or error captured for its older input, and re-marks its item so an
attempt in flight cannot publish. Completed current input is not queued again
for `ai_refresh`. Member-initiated sweep, reclassification and retry requests
get a fresh evaluation; pending slots can still be shared. Reverting after
another input was evaluated creates a new row and reuses the AI response cache.
Declined input (`blocked`, `obsolete`, or cancelled as superseded) receives at
most three automatic attempts; member-cancelled Runs veto automatic
readmission. Attempt suffixes keep work keys unique without receipt chains.
Explicit member retries retain their `retryEvaluationId` receipt.
Admission includes automatic evaluations without a Run: unchanged queued or
completed input is skipped before taking the scheduling lock, and changed input
updates the queued slot in place. Run failure codes still fence member-cancelled
work.

### Embedding execution

Embeddings run on two registered drains with no Job row
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
eligibility that changed while inference ran. Ordinary provider text never decides
obsoletion. Funding/configuration refusal defers the affected feature without
spending target attempts; it preserves the configured provider route and probes
again after a bounded wait. Gateway admission carries its actual retry time.
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
It holds until a member resumes. Email refresh, Sweeps and
member-started discovery keep their Run. `ai-refresh.discovery` is a drain whose
state is its cursor; a finished pass starts again after an hour. Nothing queues an
evaluation: `AiEvaluation.runAt` is set while
the drain owes it (`priority` 0 when the owner or an uncancelled requester is a
running, member-visible Run nobody scheduled; otherwise 1) and null once it settled
or parked. Each round pages up to two features, most urgent first. A page claims
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
spending attempts; [pending semantic coverage](#semantic-coverage-waits) postpones
only its item; anything else is the item's failure, and its third
consecutive failure settles the evaluation `failed` with the raw error and
settles its requesters. A Run cancel withdraws its requests and stops owing
evaluations no other requester still wants. Paid concurrency is bounded by the
one queue consumer and the two feature lanes.

A governed target field whose current result is unavailable is that target's
failure (`JobTargetError`), not an empty value or obsolete evidence. At
publication its chunk rolls back and splits, so siblings commit without new
inference; the target stays owed and spends item attempts as above.

Each page observes up to 8 items; the rest stay owed and the drain rejoins fair
selection after the page's checkpoint. Product identity and connection features
prepare and evaluate those items as one wave and publish admitted evidence in
fenced chunks; other features run them two at a time, each in its own guarded
transactions under the drain lease.
Paged evaluations annotate the existing Job heartbeat and completion logs with
`evaluation.prepare`, `evaluation.stage` and `evaluation.infer` phase timing.
These labels distinguish evidence preparation from decision work without logging
prompts or household evidence; concurrent decisions share one inference phase.
Connection stages add `connections.*` timings within inference, and drains add
`drain.claim`, `drain.prepare` and `drain.publish`. Heartbeats list all active
phases when work overlaps; completed durations sum per phase, so nested and
concurrent phase totals are not additive wall time or allocation evidence.
A drain publishes its chunks during prepare, so the Job `page` log's timing
contains `drain.publish` and the `publish` log's `publicationDurationMs` mostly
covers settling the outer Job. Both logs carry `pageResult`, limited to the
numeric `processed`, `published`, `failed` and `covered` counts.

`EvaluationPageAdapter` in `ai/evaluation/repo/evaluation-page.ts` owns finite feature
preparation, decision evaluation and publication results. Every target carries
its own evidence digest. Each preparation/provider continuation runs in the
drain Job's execution context. The executor interns one usage context
per compatible Run/feature/operation/force/funding group; each adapter names
its operation (`product-identity`, `entity-connections`) and uses default
force/funding policy. The shared context carries
no target Job/entity id. Distinct Runs remain separate usage groups.
`settleDecisionWorkItems` supplies finite waves; `DecisionRequestBatch` packs
up to 64 questions/32,000 text bytes, with four request chunks in flight.
Routing, response-cache keys and per-question avoided usage stay unchanged.
An oversized question fails visibly. Page evidence is limited to 4 MiB. Admission
runs after the page's preparation wave and keeps the ordered evidence prefix.
Failures and individually oversized evidence retain their own handling.
Unadmitted items keep their original ticket, priority, attempts and
readiness rather than completing their enumeration receipts or being reticketed.
Staging runs once after admission. Retained evaluation snapshots still load for
the observed page before preparation; neither the serialized evidence bound nor
the target count is a total Worker heap bound.

Connection pages evaluate 8 sources at once. A Worker invocation holds three
strong connections, a ceiling shared with everything else in that invocation
rather than reserved for the page. Expense Project recommendation inputs and
FinancialTransaction settlement/transfer retrieval load for the page before
provider work. Evidence capture shares each preparation wave's reads and the validated frozen
JSON of repeated recommendation contexts within that capture pass, instead of
copying the same context into every candidate tree.
All evidence fields and serialized fingerprints remain unchanged. Locked
publication capture always obtains a fresh snapshot; unlocked caches cannot
satisfy its authority checks. If one candidate becomes unreadable, capture retries
per source and returns that
source's failure without rejecting healthy sources. Nearby purchases retain their per-transaction top ten and each
Purchase retains its original ranked settlement limit before allocation and
conflict filtering. Acquisition search still captures each newly retrieved
candidate before subsequent provider waits. Its semantic scan resolves ranked
refs through the live search-document projection and reads only candidate
identity and similarity, so it issues no emoji, image, path or placement reads.
Compatible Product identity and
field questions share operation-specific usage objects and the page's decision
wave; nested pair evaluation joins that wave instead of dispatching per source.
Distinct Runs, features, models and operations remain separate accounting groups.
Duplicate questions inside one wave await its own cache claim's completion;
Jobs still defer when another invocation owns the claim.

One batched fingerprint read fences the page before evaluation and each chunk
before writes; a changed or deleted source is obsolete without writes.
Incomplete candidate coverage [retries or waits](#semantic-coverage-waits) before
any of the source's candidates publish. Candidate publication locks live endpoints in the shared
`orderedEntityLockKinds` order (parents before dependent kinds, then alphabetical),
which embedding publication also uses. Connection chunks prelock the union of
candidate endpoints, Product pairs and field callback endpoints before any
callback runs. Retained Email evidence keeps its Purchase → original → Email
order after the chunk's Purchase locks. Candidate publication
recomputes dependency bases and acquisition eligibility in sets, and compares
each locked basis against its original retrieval evidence. Invalidated connection
or retained Email evidence raises `ConnectionEvidenceInvalidatedError` and
settles that source obsolete, including on its final allowed attempt. It then uses one
immutable Assessment batch and one supersession transition for the chunk.
Supersession first scopes indexed live subjects, then joins the chunk's slots
to immutable Assessment evidence once, rather than scanning history per slot.
Repeated edges retain the last publication's active fingerprint, preserving
sequential publication semantics; member suppression and review are unchanged.
Canonical Product pairs retrieved by multiple source owners publish once per
chunk through the existing pair batch writer, before those owners settle.
The single-target path shares the candidate publisher in batches of 16 while
retaining its existing publication authority and incomplete-coverage behavior.

Publication commits at most 25 weighted outcomes per SERIALIZABLE transaction
(a connection with many candidates fills its chunk sooner). Locks follow Run,
slot, item, then the Job row at commit, compatible with cancellation. The
feature adapter revalidates each evidence digest and member decision before
business writes. Evaluation state and uncancelled requester receipts settle in
sets in the same commit; explicit `retryEvaluationId` receipts survive.
Requester coordinators wake through one deduplicated after-commit signal, and
an `ai_refresh` Run rechecks every 60 s at most. A failed chunk splits only
after its transaction rolls back; committed siblings never replay.
Source-to-pair enrollment finishes before the source receipt; Run completion
still includes its requested pair work. Refresh coordinators read state counts,
error summaries and bounded pending identities; they never reload frozen
inference payloads just to update progress.

Product discovery reads snapshots for the scan page and schedules one roster
transaction, reusing the activation's shared refresh owner. Slot admission,
evaluation/request insertion and work-item marks use set writes. The Product adapter uses `prepareProductIdentityPage` and
`publishProductIdentityChunk` for shared preparation and publication. Source
edges enroll in guarded chunks of at most 25 sources, 25 business
publications and 100 enrollment edges before enumeration receipts, and
canonical pairs share decision waves. Standalone catalog evaluation reuses the
candidate read's source eligibility instead of repeating its snapshot; pair
evaluation and publication retain their current-input fences. Semantic coverage
uses the shared direct/fanout dirty-mark probe once per page. [#3320](https://github.com/nickysemenza/cubby/issues/3320)
owns full synthetic throughput acceptance.
Full re-check scheduling remains gated on that acceptance; no production
throughput improvement is established by the page lifecycle alone.

### Semantic coverage waits

An incomplete semantic scan names its gap on the typed coverage result, and
`SemanticCoverageIncomplete` carries it to the drain without message matching:

- `pending`: search-document marks or missing embeddings are owed for a
  candidate kind. Owed work can invalidate the artifacts that filled the ANN
  budget, so pending wins within one scan.
- `budget_exceeded`: the settled corpus left the fixed ANN budget short of valid
  matches. Waiting cannot change that, so it wins across a source's searches.
- No gap: a provider or configuration failure, or a failed search-document read.
  A display read cannot cause one, because the acquisition scan issues none.

A connection source stops immediately after its acquisition scan on either typed
gap, before the tag, Product identity and field stages. Its candidates do not
publish. When every incomplete search is `pending`, the item keeps its ticket,
priority, attempts, `reason` and `lastError` and stores the `search_coverage` wait.
Healthy siblings on the page continue, and an empty page keeps the item's deadline.

Nothing wakes the evaluation when upstream settles, except a new mark, which clears
the wait with a fresh attempt budget. It retries once a minute. Pending has no attempt
ceiling: the evaluation stays queued and owed for as long as upstream owes the work.
Run detail counts it under Waiting. Each
retry repeats page preparation, rechecking source and requester authority before any
paid stage, and may embed its queries again. A paused or cancelled requester
therefore settles at the next retry or through Run control, not at wait publication,
which writes only the evaluation's work columns. A `budget_exceeded` gap or a provider failure spends
attempts, clears any wait, and settles `failed` as above.

The `evaluation page prepared` log names a page's slots, prepared bytes and overflow before
inference starts, so an invocation killed mid-page still identifies it. The `evaluation page`
log describes one attempt before the drain maps it, with `waiting` and `failed` apart. The
Job page result owns committed outcomes.

Wait pages and AI work Runs read their rosters through `evaluation-tally.ts`, so a page costs
one aggregate rather than the roster, which can reach tens of thousands of rows. Failed ids and
the joined error text are read only when the work settles. A Mail reclassify Run still reads
its rows, because its checkpoint records a result per Email.

## Apple version gate

Device work stops when the server refuses an older build's writes (HTTP 426):
the worker stops pulling and shows "Update required to process images". Raise
the minimum only for unsafe writes; see
[breaking changes](agents/domain-rules.md#breaking-changes).

## Member-facing work explanations

Work is the web entry point at `/activity`: one health line, Stuck when something
is, and one Needs you queue. `workQueue.status` is the single read behind the page
and the sidebar, and agents can read it too. It adds no alert engine, stored lanes
or retry policy; old `tab=` links redirect to `/history`, `/suggestions` and
Settings, and a `refresh=` locator to the value's record.

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

## Deadline scheduling and idle recovery

PostgreSQL owns Jobs, drain items, claims, progress, member pauses and retry policy.
The queue executes ready work immediately; subsequent pages continue while work
is runnable. Kind capacity refusals do not themselves generate immediate wake loops.
Nothing but Postgres holds a deadline. At the end of a round the drains and the Job
drain each send one Queue-delayed wake for their next known due time, up to one hour
out; the hourly cron reaches anything later and anything whose message was lost. Each
round that claims a Job first arms a wake for its lease to lapse, so a killed
invocation recovers without waiting for the cron. A wake cannot be cancelled, so a
stale one touches Postgres once and finds nothing due. A process dying between commit
and its post-commit signal recovers on app-open or the next hourly tick.

Queue maintenance finishes after bounded repair/retention pages instead of repeating every
five minutes. Existing Job identities, cursors, tickets, errors and stops survive.

The cron fires hourly and drains whatever is due, so it is the timer for work due
later and the backstop for a lost wake. Daily recovery runs at 7 a.m.
America/Los_Angeles: the invocation at that household hour also runs the daily pass.
Every daily step is idempotent, and the nightly pass is keyed by its household date
(`Run.clientKey`), so a repeated invocation reuses that date's pass even after it
finished. Only an earlier date's budget-paused pass makes way for a new one. A failed
wake send retries three times over about five seconds before the hourly cron is its
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
