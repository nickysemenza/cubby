# Durable Jobs and background work

The `Job` table owns one-off or resumable execution: claims, leases,
generations, retries and waits. Domain rows keep their outcomes and evidence.
[ADR 0025](adr/0025-radical-simplification-of-background-work.md) records the
decision; this page owns the runtime contract for Jobs, drains, queue permits,
Runs' execution and the hourly cron. Derived-data families are in
[entities](entities.md#background-derived-data); Worker and database capacity
is in [infrastructure](infrastructure.md#postgresql-and-hyperdrive).

## Jobs are not entities

A Job has no public code, no `Entity` identity, no page and no relationships.
It is one row of owed background work in the `Job` table, keyed by `key`. Kind
policy supplies the lane and internal-kind flag. Work shows on the Work page
and through `job.activity`, and a Run's Jobs show on its detail page.
`job.retryNow` retries over a kind, lane, reason, state, Run or id filter. The
table stays named `Job` because `Task` is the household entity's table.

## Coarse Jobs and work items

A Job is a unit of execution, not a unit of household work. Work that fans out
over many records is a **drain** over **items** held on the rows that owe them:
`AiEvaluation`, `SearchDocument`, `EntityEmbedding` and `ImageProcessingJob`
own their scheduling. A drain unit's only `Job` row is its `background.drain`
record (rotation and latest execution); it never holds or schedules items. The
first three supply a `DrainStore` (`generic/jobs/drain-store.ts`). An item's
ticket says which intent a page may settle, so a re-mark during a page takes a
new ticket, and the page clears only what it claimed.

`rowDrain` (`generic/background/drains.ts`) is the single claim → prepare →
publish helper for embeddings and AI evaluation. It claims a bounded page,
prepares outside transactions and publishes chunks of at most 25 weighted
items. Domain locks precede item locks. An isolated publication error splits
the chunk until only the failing item backs off or exhausts; committed siblings
never replay. Adapters declare their own backoff and optional attempt limit. AI
evaluation supplies real lease-checking transactions, including SERIALIZABLE
publication; paid results survive publication failure on the evaluation row.
No synthetic Job context or claim generation stands in for that ownership.

Published and failed counts record committed settlements, once each even when
a serializable transaction replays. Retained items stay owed. Each drain
declares SQL for when it is due now and when it is next due; an empty page
publishes nothing and schedules nothing.

The production drain units (`workflows/jobs.ts`) are cloud images
(`image.cloud`), embedding refresh, embedding cleanup, one unit per AI
evaluation feature (`ai-evaluation:<feature>`), the resumable derived rebuild
(`derived-rebuild`, one pass with its own row, not items), Email purchase
discovery, field automation (`field-automation:events` and
`field-automation:policy`) and reconciliation of stopped executions
(`reconcile`).

Email purchase discovery holds one AppSettings cursor, publishes
`connection.email-purchase` recommendation Suggestions for Emails whose
retained evidence suggests a purchase link, and repeats hourly (its cursor's
`nextAt` is its next due time). It runs deterministic SQL: no model, no Run and
no evaluation.

One-record work stays a Job. Job `generation` is the supersession fence and the
Run execution attempt number. Outcomes live on domain owners; Jobs retain no
result JSON. `availableAt` is the only stored wait deadline. Completed Jobs
remain until retention prunes them.

| Job kind                                                     | Why a row                                      | Owner of the result           |
| ------------------------------------------------------------ | ---------------------------------------------- | ----------------------------- |
| `run.execute`                                                | Lease, pause and retry for a Run               | The Run                       |
| `purchase.dispatch`                                          | Durable handoff to the agent, deduped by event | The Run and its agent session |
| `run.funding-resume`                                         | Waits for a funding window to end              | The paused Runs               |
| `image-metadata.extract`, `location-ai.*`                    | One per record, replaced on re-admission       | The Image or Location         |
| `calendar-feed.mark-dirty`, `maintenance.purchase-discovery` | Keyed single passes                            | The feed, Vendor or queue     |

Everything else is a drain over its owner's rows and has no row here. There is
no stored queue health or alert engine: [Work status](#member-facing-work-explanations)
derives stuck work, and `job.activity` each unit's last hour, from the rows
above on every read.

## Kinds and lanes

`JOB_KIND_POLICY` in `packages/schemas/src/job.ts` is the one registry of
per-kind policy: lane, internal flag, `maxAttempts` (every kind has one),
failure backoff and member explanation. `generic/jobs/kind-policy.ts`
re-exports it for the server. A kind absent there is a server kind with three
attempts and 1 s doubling to 60 s backoff. Each lane names the executor that
runs it:

| Lane       | Kinds               | Executor                                        |
| ---------- | ------------------- | ----------------------------------------------- |
| `external` | `purchase.dispatch` | a coordinator, handed off by a permit           |
| `server`   | every other kind    | a [background permit](#selection-and-admission) |

Coordinators run at most `COORDINATOR_TURN_CAP` (6) work turns at once across
the household, queued in order by the `COORDINATOR_GATE` Durable Object
([budget](infrastructure.md#background-connection-budget)). A
`purchase.dispatch` whose coordinator finds every turn held defers with
`provider_capacity` and no attempt ("Waiting for a coordinator turn"); the
coordinator keeps its place in the queue and brings the Job forward when the
gate reserves it a turn, and an 8–12 minute fallback re-polls meanwhile. A
gate that cannot answer defers the same way ("Waiting for the coordinator gate
to answer") and re-polls in 1–2 minutes.

`background.drain` is an internal record kind: one completed row per drain unit
(`key` `drain:<unit>`) whose `lastClaimedAt` places the unit in rotation. It is
never claimed or executed. Its `lastExecution` is the unit's last page,
including a page that threw: the permit meters AI cost and item counts outside
the page, so a failed record keeps what committed before the failure.

Device image work is parked on its own row and never reaches a permit.
Enqueueing it rings connected companions after commit, and a companion
connecting to the doorbell is rung at once; there is no polling interval. Work
that comes due later (a failure backoff, a deferral, a lapsed lease, a delayed
release) rings through a Queue-delayed permit carrying `ring`. A delay past
twelve hours is left to the hourly cron, which also covers a lost message and
rings whenever parked work is claimable. A doorbell RPC failure fails the
delivery, so it retries; reaching no open socket is not a failure. A release
with no delay also rings at once (best effort).

## Waiting on

`generic/jobs/repo/waiting-on.ts` is the single derivation of what a live Job
waits on; every client (web, Apple, CLI, MCP) and every rollup reads it.
`jobWaitingOn` in `packages/schemas/src/job.ts` is the wire vocabulary:

- `due`: claimable now. The server reports no queue position or ETA: with a
  few dozen coarse Jobs, a position is noise.
- `waiting_device`: parked device work, with its position in device claim
  order, exact apart from a device's preference for work another device last
  ran.
- `waiting_funding`: an `ai_funding_window` wait until the window resets.
- `leased`: an executor holds it, named with its device installation id
  (`executorDeviceId`, null for cloud) and `leasedAt` (the claim time);
  `expired` once the lease lapsed unreclaimed. The holder is `Job.leaseHolder`
  (`{name, deviceId}`), which an external executor records at hand-off;
  generic code never reads a domain's attempt rows.
- `backing_off`: a failure backoff or provider wait (`cause`) until a time.
- `blocked`: waiting on other work, such as a device preparing AVIF input.
- `paused`: stopped by a member or its Run.
- `update_required`: reserved for an Apple device that must update; the Apple
  client reports it. The server derives `Device.updateRequired` from the stored
  `appVersion` against `APPLE_CLIENT_MINIMUM_VERSION` instead.

Terminal Jobs wait on nothing. `jobWaitingOnReasonSql` mirrors the derivation
for aggregates; a regression keeps the two in agreement. Text surfaces render
one line through `describeJobWaitingOn` (and `describeJobRollup` for counts),
so a lapsed lease reads "Lease on … expired; waiting to be reclaimed", never
"In progress".

Declared entity fields carry the same facts to web, Apple and MCP:

- Run: `waitingOn` (the rollup line), `stalled`, `successorRunId` ("Retried
  as", the newest Run whose `predecessorRunId` names it; `predecessorRunId`
  reads "Retry of"), and `displayStatus` for the header. A `needs_review` or
  `failed` Run with a successor reads `retried` (its open work moved; its own
  findings stay on its sections), and an `execution_limit` stop reads
  `waiting_for_funding`. The stored `status` stays the filter. Web photo Run
  details replace a predecessor's photo review with a link to its successor,
  its current status and the number of groups awaiting approval; retained
  predecessor photos are not shown as ungrouped once work continues in a
  successor.
- Image job: `waitingOn` for open rows.
- Device: `updateRequired`, `inactive` (not seen for 7 days or never) and
  `appleIntelligenceAvailable` (the hello's actual-image description
  availability, null until a hello reports it).

## Selection and admission

The `cubby-background` queue carries permits. Each message lets one invocation
run ONE unit: one Job page or one page of a named drain. The queue's
`maxConcurrency` (8, batch size 1, in
`packages/shared/src/background-queue-consumer.json`) is the only concurrency
bound; there is no in-isolate admission, page or wall budget.

`dueUnits` (private to `generic/jobs`) chooses the unit in one statement over
due Jobs and every drain's `due` SQL. It tags each drain unit with the drain
that reported it, and the permit runs the unit on that drain. A unit name is
only the key of the unit's rotation and execution record, so it must be unique
across drains but never has to match its drain's name:

1. `run.execute`, Jobs whose `runId` is a running, member-visible Run, and
   drain units with member demand (an AI evaluation at priority 0, a Run-owned
   cloud image) lead. Routine Runs do not.
2. Within each class, units take turns: every unit's first candidate, then
   every Job kind's second, least recently served first (a Job kind's latest
   claim from the `(kind, lastClaimedAt)` index, a drain unit's
   `background.drain` record row); within a kind, the longest due first, each
   priority point counting as one minute of head start. Priority never ranks
   absolutely, so Jobs that defer and fall due again cannot starve a lower
   priority. A flood of one kind therefore never starves another.

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

A permit acknowledges whatever its unit's outcome: the unit's rows own its
retries. Only a failure before or around selection (the database unreachable)
retries delivery, three times, 30 seconds apart.

Member-first ordering inside a drain is item priority: root transactions in
Job execution mark derived inputs at priority 1, member transactions at 0, and
savepoints inherit the outer transaction's priority.

This bounds concurrent units, not bytes or heap: each page's payload, HTTP
requests and response decoding still allocate. Native Worker outcomes remain
the memory-failure source of truth.

A device pull (`claimCompanionImageCommands`) claims, prepares, assigns and
reserves output in one transaction under an advisory lock, so concurrent
batches take their turns one at a time. An active, member-visible Run's parked
work leads; backfill runs when no Run needs the device. A device's preference
for work another device last ran only orders candidates within that. A hand-off
the server cannot make (participation turned off, output not reserved,
preparation failed) is released in the same transaction.

## Execution

A handler has one shape: `prepare(db, claim, input, ctx)` reads and calls
providers outside a transaction and returns an outcome with an optional
`publish(tx)`. The executor (`generic/jobs/service/jobs.ts`, private) owns
everything else:

- **Lease.** Sixteen minutes, without renewal, longer than a Queue consumer can
  execute. Token/generation fences and pre-provider checks still refuse stale
  work. Device image leases renew through their own wire contract.
- **Fence.** `publish` runs in a transaction that takes the handler's domain
  locks first, then one `FOR UPDATE` on the Job just before commit, and commits
  only while the claim's token, generation and lease still hold.
  `ctx.fenced(work)` applies the same fence to an intermediate write,
  `ctx.fence(tx)` to a caller's open transaction and `ctx.check()` before
  another provider batch. There is no early `FOR SHARE`; a lost race fails the
  fence, never deadlocks.
- **Explicit fences.** A fence is passed, never looked up. Run workflow code
  receives the claim's `fence`/`check` through `withWorkflowExecution`
  (`assertWorkflowEffect`, `assertWorkflowCurrent`); a standalone provider Job
  (`location-ai.*`) or the cloud image drain registers through `withJobFence`
  so the Gateway checks its lease before every paid request. A single-record
  handler passes `ctx.fenced` to its publication, and member or maintenance
  callers of the same publication pass `outsideJob(db)`, an ordinary
  transaction.
- **Failure.** One classifier walks the cause chain: a pause stops the Job; a
  deferral (`JobDeferredError`, funding, provider capacity) waits without an
  attempt; a superseded claim ends quietly; a target error isolates one item
  inside a drain; a retryable error backs off; anything else fails an attempt.

Producers use `repo/producer.ts`, member and Run controls `repo/operator.ts`,
drains `rowDrain`, and readers `repo/job-reads.ts` (rows by identity, a Run's
live lease, stopped Run executions). The queue core and selection
(`repo/queue.ts`), `db/job-schema.ts` and the `Job` table object are private to
`generic/jobs`, tests included: oxlint's `no-restricted-imports` and
`no-restricted-properties` exempt only `generic/jobs` and the files that
declare or aggregate the tables. Tests seed, age, lock, claim and inspect that
state through `generic/jobs/jobs.fixtures.ts`. Whole-model consumers (the
database client, migrations checks, test setup) import `db/drizzle-schema.ts`.

A resumed Run's evaluation item is rechecked under Run locks before a prepared
parked item can be cleared. Embedding publication takes source locks before
item locks, matching source producers.

### Statement pages

`JOB_PAGE_LIMITS` (`packages/shared/src/job-page-limits.ts`) owns application
page sizes. Statement generation and labeling scoped to an import process at
most four charges per page (`statementApplicationsPerPage`), because each
admits serial financial applications; unscoped generation selects at most 32
(`statementGenerationPerPage`); explicit label limits remain available.
Retained generation failures use the same limits. Both paths preserve the
ordered population cursor and all remaining work; only a completed page
publishes its checkpoint.

Cooperative label application checks a 20-second deadline between charges
while no financial rule has applied in that round. It settles at least one
charge, then leaves the untouched suffix's receipts and inclusive cursor for
the next page. Each charge still regenerates current evidence before serial
automatic-rule application, and interrupted pages replay their existing
publications and effects through the same guards. Automatic-rule refusals
return and log scrubbed causal diagnostics (including nested database messages
and SQLSTATE codes) and leave the suggestion pending.

Page caches and streamed fingerprints keep existing fingerprint bytes and never
cross a money write; commit re-reads its evidence. None of these bounds is a
Worker memory bound, and none relaxes a source, candidate, admission or money
policy. The [statement Sweep contract](import-evidence-convergence.md#statement-sweeps)
owns label reuse and scope.

`Statement generation phase` and `Statement label application phase` logs
enter each phase before awaiting it, so an invocation that exits early still
shows where it was. Payloads contain only phase names, charge indices and
aggregate counts, never source identities or content.

## Wakes

A Job is due when it is queued or in backoff and its time has come, or when its
lease has expired. A permit is only a Queue message that makes a unit run
sooner (`wakeJobs`, `wakeAt`); it carries no durable state, and the hourly cron
recovers a lost one. `enqueueJob({ invalidate: true })` is the only restart: it
bumps the generation and clears the lease, so the old pass fails its fence.
Email purchase discovery repeats through its cursor; automatic work has no
recurring Job.

## Retries

Claiming is not an attempt; a failure is, and so is reclaiming an expired lease
(the previous executor vanished mid-pass, and a crash loop must still exhaust).
A failed Job backs off by its policy, `baseMs · 2^(failures - 1)` up to
`maxMs`, and fails after `maxAttempts`; every kind has a bound, and a row
stored with a null column uses its kind's. Deferrals never count.

Transient failures back off without spending attempts; their delay grows with
the failing streak's age. They are a Hyperdrive pool-slot timeout (SQLSTATE
58000, "Timed out while waiting for an open slot in the pool"), a dropped
connection (SQLSTATE class 08 or 57P01, or anywhere in the cause chain a
code-less "Connection terminated unexpectedly", a pool connect timeout or an
`ECONNRESET`/`EPIPE`/`ETIMEDOUT` socket error), a `JobRetryableError` and an
exhausted snapshot replay. `failingSince` records the streak's first failure
and any successful or deferred page clears it. Whatever the class, a Job still
failing `JOB_FAILING_LIMIT_MS` (24 hours) after its streak began fails visibly.
Funding and provider waits stay `JobDeferredError` / `waiting_on` and never
start a streak.

Drain items are bounded too: AI evaluations settle `failed` after three
non-transient failures; an embedding refresh stops owing after 100 failures
(about a day at its 15-minute cap) and a vector deletion after 288 five-minute
retries, each keeping its error for Work's failed list; image processing stops
retrying after twelve failures (about a day and a half of doubling backoff) and
waits for explicit retry. Drain items follow the Job rule for transient
failures: they defer without spending an attempt, back off by the streak's age,
and record the streak's start on the owning row (`AiEvaluation.failingSince`,
`SearchDocument.embeddingFailingSince`, `EntityEmbedding.deletionFailingSince`);
any item still failing 24 hours after its streak began is settled as failed. A
page that fails whole (outside any one item) settles each item it still holds
as failed, so persistent page failures reach the same bounds. Funding and
provider waits stop the page without touching its items.

Serialization recovery is bounded inside a DB-only snapshot transaction. If all
attempts roll back, its owner emits `SnapshotWriteConflictError`; the durable
Job then backs off as a transient failure. A raw SQLSTATE on an after-commit
effect is not this signal and cannot request unbounded replay.

Location description and inventory-analysis Jobs use a one-minute base with a
fifteen-minute backoff cap and ten attempts. When a recovered universal Job
executes, its matching Run reconciled to `job_failed` returns to running under
the Job fence. Another active Run owning the admission slot causes retry
backoff until it finishes. Admission waits reserve exactly one further attempt,
rather than conserving the ordinary failure budget; member-controlled, retired
and superseded Runs are excluded. Member pauses/cancellations and running
leases keep their states.

### Execution records

Every execution writes `Job.lastExecution` (`jobExecution` in
`packages/schemas/src/job.ts`): outcome, error class, wall milliseconds,
database query count and time, the charged AI cost recorded during it, the
Worker version and its finish time. A drain unit records the same on its
`background.drain` row, with its claimed, published and failed item counts.
That row also keeps a failed page's raw error and `failingSince`, the start of
the unit's failing streak: a page that succeeded or deferred ends the streak,
and a page that claimed nothing leaves it. Failed Job executions and failed
drain pages reach Sentry tagged `cubby.background.unit` with the Job kind or
drain unit.

Only the latest execution of each row is stored; there is no execution log.
Reads that summarize a window therefore count rows by their latest execution,
never executions.

A record is written only when the execution ends, so an invocation the
runtime kills (exceeded memory or CPU) leaves none. Each permit therefore names
its unit before any work: a `permit claimed` log line with the unit, kind and,
for a Job, its id, key, Run and generation, and the same
`cubby.background.unit`/`.kind`, `cubby.job.id` and `cubby.run.id` attributes
on the invocation span. Join a killed invocation to its unit through that line.

Retry now (`job.retryNow`, `retryJobsNow`) makes a filtered set due at once:
backoff and provider waits clear, prior errors stay, failed and cancelled Jobs
reopen with a fresh budget and generation, and running or member-paused Jobs
are left alone. Every supplied retry restriction intersects, including row IDs
and Run scope. A Run cancel is one set-based statement (`cancelRunJobs`);
subject-owned work (Location AI) belongs to its subject and survives a Run
cancel.

### Funding waits

`run.funding-resume` is keyed by funding window, not Run: one Job per window,
whose handler resumes every funding-paused Run. A funding-paused import stays
`paused_auth` rather than stopping for review. The Workflow boundary translates
wrapped AI budget stops into `ai_funding_window` Job deferrals at the window end
plus 60 seconds; provider funding/configuration stops defer until the provider
retry time. Neither consumes an attempt or discards frozen input, page evidence
or the Job cursor. Generic early retries leave a funding-paused Run waiting
while its funding-resume Job is pending.

An explicit Run launch or Resume makes its retained queued/backing-off Job due
immediately, preserving its generation, attempts and cursor and clearing the
old wait reason; the next page still checks current funding and may pause
again. Resume creates no paid grant; `run_now_paid` uses its explicit paid
authority. An explicit budget increase releases funding-paused discovery before
bringing queued Jobs forward; claims reacquire their query resource or
exclusive mailbox scope, while contenders defer under the same Job fence
without spending failure attempts. Until admitted, a released discovery reads
as paused rather than waiting for funding. The release marker stays out of the
public checkpoint and grants no overage. A fresh funding stop clears it,
keeping the funding owner's frozen deadline for the next wait. Wait
publication locks the Run before the Job, so a concurrent release cannot be
overwritten by the older timer. A raise that precedes the funding stop itself
does not release that later stop. Member pauses remain stopped. Automatic
mailbox admission joins the retained Run. Run control refusals are
`RUN_CONTROL_REFUSED` (409), never 500.

## Runs and recovery

Reconciliation copies a stopped execution's failure to its Run and records an
end time for failed or cancelled execution; a member pause stays open-ended.
Running Sweeps and mail reclassification support member pause/resume through
the Run lifecycle, preserving their steps, scope and committed progress.

Failed-work recovery leaves cancelled evaluations and withdrawn shared requests
stopped, including their original receipts and superseded historical work. An
explicit Retry run on a member-cancelled Run revokes that member stop: its
interrupted steps reopen, member-cancelled owned evaluations get linked
replacements, and withdrawn requests rejoin any still-live shared evaluation
without a retry link to themselves. The stored member-cancellation marker has
one schema owner. A cancelled Run may also resume an interrupted or queued step
after all of its evaluations settled; that step still needs to publish its
final tally. Other cancellations remain stopped.

Retry failed on a cancelled Sweep step with no failed items directs the member
to Retry run; actual failures remain retryable without reviving the cancelled
remainder. A retained step with zero committed pages still retries its full
failed roster. Retry failed refuses a retained step absent from its Run's
current execution plan before changing its ledger or launching work; it does
not re-plan a retired population, and historical failures stay readable.

An explicit Retry run can reopen a completed execution Job when a failed Mail
discovery Run retains a valid frozen page. The same Job starts a new generation
while preserving the Run's input and page; page settlement and mailbox
admission still apply. A completed Job without retained work remains refused.
Executed workflow retries can resume the same Run and its committed steps; a
retry does not always create a successor.

AI refresh recovery requires a durable owned or requested evaluation roster,
including terminal rows and retry handoffs. With no roster, Retry run, Resume
and "Run now, paid allowed" refuse before launching or recording a paid grant.
The execution driver retains a raw failure rather than completing an unknown
scope. Discovery metadata is not a target roster.

A failed Mail reclassification with no durable roster can be closed only by an
explicitly authorized correction after every original identity and
execution-time checksum is proven handled by retained checkpoint evidence and
completed linked continuations. The correction rewrites the request's stored
status to completed; its original checkpoint, notes and end time remain
unchanged, and linkage includes child usage in the parent's cost rollup.

## Mailbox discovery admission

Mailbox discovery runs as `run.execute` pages under the Job contract above.
Its Mail-specific admission rules (targeted-search capacity, exclusive scans,
page yielding, coverage advancement and Gmail cooldowns) are owned by the
[purchase-import module guide](../apps/web/src/server/domains/purchase-import/service/README.md#mailbox-admission-and-coverage).

## Image processing

Image processing retains every outcome. `ImageProcessingJob.state` stores
`pending` while open, `ready`, `failed` for a deterministic refusal needing
explicit retry, or `skipped` for a completed negative subject lift or a moot
ending (image deleted, upload replaced, processor superseded, or type excluded:
device work on a source type no device command carries, such as a GIF). A
subject lift's `no_subject` or `not_suitable` result is final for that source
hash and processor revision: its negative evidence and attempt history stay
recorded, the derivative is skipped and the original remains usable. Other
executor skips, including `unsupported_format`, become deterministic failures
with their reason preserved. A stored `failed` retains the diagnostic, reported
result and attempt history.

The displayed state derives from the Job (`image-job-state.ts`): `leased` for a
live lease, `waiting_for_device` for parked device work, `pending`, and
`failed` ("Needs attention") once a job failed `JOB_NEEDS_ATTENTION_ATTEMPTS`
times in a row or its execution stopped; transient failures keep retrying. Only
stored `pending` jobs have a waiting explanation; a stopped job must not say it
is waiting for an Apple device. Work's View photos action opens the failed
display-state filter, covering both cases. Detail summaries render the
canonical field envelope, as the hero does. Attempt totals retain earlier
releases, lease expiries and failures under older policies; the latest
nonretryable result does not describe every earlier attempt.

An executor's `retryable: false` stops automatic dispatch for those
source/processor inputs; the matching cutout projection fails in the same
transaction while a ready output stays intact, and transient failures leave the
cutout pending. Storage verification failures retry; a verified content
mismatch stops. Superseded failed jobs retire as skipped while retaining their
diagnostics and results. A missing subject-lift derivative is rebuilt. Explicit
image retry reopens a negative cutout without discarding its evidence or
letting maintenance immediately settle it again. A changed source or new
processor revision is new work, and a newer Apple build's first pull makes
backing-off device work due.

### Apple subject lift and descriptions

Apple subject lift is independent of cloud cutout eligibility and attachment
purpose. Supported images reach Apple, which reports a cutout, no foreground
subject, an already-cut-out input, or an unsupported format. An input counts as
cut out only when its visible region itself has transparent area; an opaque
photo padded onto a transparent canvas is still lifted. The cloud
classification remains descriptive evidence, not a dispatch gate. Subject
lifting uses `VNGenerateForegroundInstanceMaskRequest` on the concurrent
executor. Only a successful empty observation means `no_subject`; cancellation
and all other errors remain failures. Parent cancellation is checked before and
after the request. Apple descriptions run independently for every image.

On-device descriptions use a fresh session, a full-frame image bounded to 1024
pixels, and an initial explicit response budget of at most 512 tokens, reserved
from the runtime model context size. A context overflow retries once with 512
pixels and half the response budget. A structured parsing failure retries only
when the latest structured response is explicitly incomplete and session output
usage reaches the configured response cap; that fresh-session retry keeps the
image size and raises the output budget to at most 1,024 tokens, bounded by one
quarter of runtime context. There are at most two attempts in total: context
shrinking and truncation recovery cannot chain. Unknown or complete response
metadata, below-cap output, arbitrary malformed parsing and repeated truncation
remain terminal, and no partial result is adopted. Because typed conversion can
succeed for an incomplete string or final array element, native code also
requires the raw response to be complete before adopting typed content.
Guardrails remain enabled. No prompt or schema change ships without a complete
description, eligibility and claims on retained inputs and synthetic controls.

Before releasing a failed session, native code appends fixed metadata: attempted
image dimensions and response budget, session output usage, latest-response
structure availability, completion and root shape, presence and shapes of the
three expected properties, underlying error type, and raw diagnostic equality
flags. Missing response metadata stays unknown, and output usage of zero does
not establish that no tokens were generated. The snapshot excludes generated
values and arbitrary keys and precedes the raw diagnostic so it survives the
1,000-character failure-reason limit; the full raw reason can still contain
private content. Guardrail failures also retain the SDK context debug
description. Wording such as "Response may contain sensitive or unsafe content"
is diagnostic evidence, not an authoritative input/output attribution.

A stored terminal Apple `guardrail_violation: ` or `structured_output_invalid: `
failure at the current processor revision leaves automatic Work failure
attention and the image's processing issue when a retained, undeleted current
preferred cloud description covers the same source hash. Both views use the
same evidence predicate, including provider, model, prompt, schema and
normalization revisions. The image-job list and detail project
`cloud_satisfied` ("Satisfied by cloud") from that predicate; their Needs
attention filter and counts exclude covered failures, and the processing
quality check passes. This is a read-only status, never a stored execution
outcome: the Apple job and attempts stay failed, with their raw reason, history
and explicit retry available. Source or preferred cloud evidence changes remove
satisfaction immediately. Quality uses the same live projection for detail and
the hourly quality publication for list quality (rule version 2); no read
repairs a snapshot. Without that exact cloud evidence, parsing failures remain
actionable. Model `refusal`, other errors, pending retrying work and failed
subject lifts remain actionable even with cloud evidence. No cloud request or
fabricated description is added.

Recurring image-execution repair settles retained negative cutout failures in
bounded batches. It requires the current source/revision and the matching
settled attempt, locks the image and unleased image job, and leaves a running
attempt alone. Attempt records, result evidence and runtime provenance are
retained. The repair does not execute the image again or reclassify model,
network or other processing errors as negative cutouts.

### Image execution ownership

`ImageProcessingJob` is the sole owner of image execution: `lane`, `runAt`,
`leaseUntil`, `failures`, `waitReason` and the current `attemptId` live on the
row, and nothing else queues it. Cloud rows run through `cloudImageDrain`, a
registered drain whose items have no Job row: it claims due rows under a
16-minute lease that nothing renews, because no consumer outlives 15 minutes. A
crashed page is reclaimed after that, and a reclaim counts as a failure. A cloud
image page runs two rows at once. `imageProcessingLane` fixes each job's lane:
subject lifts, Apple descriptions and AVIF cloud descriptions (which need
device JPEG preparation) run on devices; other cloud calls on the server.
Device pulls claim parked work directly and prefer work whose last attempt ran
on another device. They skip busy source rows, so an empty pull can precede a
later hand-off while work remains owed; consumers retry through their ordinary
pull cycle.

A typed provider wait or an exhausted AI budget is never an attempt on any
cloud call, including the description of a device-normalized AVIF
(`deferCloudAttemptForTypedWait`): the claim is released until the wait ends.
Companion completion loads cloud execution only when adopting a
device-prepared input that needs a cloud description; ordinary Apple results
use the lightweight description policy for their exact retained fingerprint.

Device wire contract:

- `imageProcessing.pull` leases for `leaseSeconds` (default 60, 20–300) and
  accepts optional `maxCommands` (1–16, default 1). `commands` contains up to
  that many commands in hand-off order; the `command` field is its first item
  or null, so older clients keep receiving one command. A batch uses one
  transaction and one advisory lock over a bounded candidate page; each
  hand-off rechecks due times and leases within that page, preserving
  per-command capabilities, device preference, attempts, leases and presigned
  URLs. A prepared row cannot re-enter the batch even if its initial lease
  expires during later preparation. Immediately before hand-off, still-owned
  leases are re-armed together and every returned command receives the fresh
  deadline. An empty array/null command means no hand-off: refused claims are
  released first. A preparation failure releases and backs off that claim; an
  already prepared prefix is returned, and if there is none the pull throws
  after the release commits. Neither valid commands nor the failed candidate
  can become invisible behind a batch error.
- `imageProcessing.renew` `{jobId, attemptId, deviceId}` extends the lease by
  60 s while the attempt still owns it, including an expired lease no newer
  claim replaced. It returns `{ok: true, leaseExpiresAt}` (the new command
  deadline) or `{ok: false, reason: "lease_lost" | "job_obsolete"}`; the device
  stops either way. Devices renew every 15 s.
- `imageProcessing.release` is never an attempt.
- `imageProcessing.complete` after expiry is adopted while the attempt id is
  unchanged; after a newer claim it returns `{adopted: false}` and a late
  failure is kept in the old attempt's history.

A photo-inventory Run's description gate accepts the Apple or the cloud
description; `cloudDescriptionMissing` and `withoutCloudDescriptionCount` note
photos grouped while their cloud description waits (for funding, say). A
description that settled without one (`failed` or `skipped`) holds the Run for
the member, who can continue without those photos; the coordinator never
starts on a photo it has no description for.

Each image job reads `leaseDeviceId` (the `DEV-` code whose attempt holds the
lease, live or expired) and `leaseExpiresAt`. Assigning an executor records it
as the Job's `leaseHolder` in the same transaction. Its saved views are
`waiting-for-apple` and `processing` (live leases).

## Producers

Queue messages are best-effort wake-ups for intent already committed in
PostgreSQL. The shared `wakeJobs` sender uses the fetch request's `waitUntil`
lifetime, so a slow queue send does not delay a committed mutation receipt.
Without a request context (including queue and cron invocations), the caller
awaits the send. Queue failures receive bounded delivery retries; app-open and
hourly recovery repair missed wakes; transaction rollback schedules no wake.
Producers use this sender rather than implementing their own request-lifetime
branch.

A background task kind is its schema in `backgroundTaskSchema`
(`@cubby/schemas/background-tasks`), its member-facing `JOB_KIND_POLICY` entry,
and one declaration in `server/workflows/background-tasks/kinds.ts` carrying
the Job key, the handler and provider fencing. Publishing and execution both
read that declaration; a handler parses only its own kind. The key is the
queued Job's identity, so changing one orphans queued rows.

A producer must not enqueue faster than its drain can serve, and no producer
fans out per household record.

Each AI evaluation slot identifies feature, entity, record and field. A
generated text key uses UTF-8 length prefixes; input and option fingerprints
remain execution evidence, outside the slot key. A partial unique index permits
one `queued` row per slot and execution kind; retry and lease state live on the
evaluation's work item, never in `AiEvaluation.state`. The pending share-key
lookup is nonunique: a `result_ready` row keeps its paid result while a queued
successor waits in the same slot. A retry carrying a retained answer never
joins that queued successor: it keeps a separate `result_ready` row and leaves
the successor's demand and any in-flight attempt unchanged.

Changed input updates the queued row's snapshot, target, provenance and work
key in place, clears any result, receipt or error captured for its older input,
and re-marks its item so an attempt in flight cannot publish. Completed current
input is not queued again for `ai_refresh`. Member-initiated sweep,
reclassification and retry requests get a fresh evaluation; pending slots are
shared only within the same execution kind. Discovery audit receipts never
reuse reclassification work, even when both describe the same Email and
feature. A completed discovery with a request pointing to another execution
kind or a missing receipt reports incomplete audit coverage; current Email
state cannot reconstruct the lost handling receipt. Reverting after another
input was evaluated creates a new row and reuses the AI response cache.

Declined input (`blocked`, `obsolete`, or cancelled as superseded) receives at
most three automatic attempts; member-cancelled Runs veto automatic
readmission. Attempt suffixes keep work keys unique without receipt chains.
Explicit member retries retain their `retryEvaluationId` receipt. Admission
includes automatic evaluations without a Run: unchanged queued or completed
input is skipped before taking the scheduling lock, and changed input updates
the queued slot in place. Run failure codes still fence member-cancelled work.

### Embedding execution

Embeddings run on two registered drains whose items have no Job row. A
`SearchDocument` owes a fresh embedding when `embeddingDueAt` is set; a failure
backs off on the document, and Vectorize visibility polling reschedules it
without spending an attempt. An `EntityEmbedding` that is retired or failed
with no `deletionId` owes a vector deletion, so nothing marks it; a failed
deletion waits on `deletionRetryAt`. The cleanup is safe to repeat because only
the receipt settles it.

A refresh keeps source dirtiness and execution apart. `embeddingGeneration` is
the intent, and a mark advances it at any time. `embeddingLeaseToken` and
`embeddingLeaseUntil` name the page allowed to pay the provider, and a mark
never touches them, so the hourly cron or a page across a deploy skips a held
document even after a re-mark. The lease outlasts the 15 minutes a consumer can
run, so a crashed page's documents come free on their own. Settling needs both
the lease and the claimed generation. After the provider has been paid, an
upload needs the lease and either that generation or text that still hashes the
same, and its receipt then needs only the lease: the next page adopts the
receipt. Changed text uploads nothing.

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
8,192-token input limit without failing neighbors
([OpenAI owns these limits](https://developers.openai.com/api/reference/resources/embeddings/methods/create)).
A configuration mismatch settles obsolete and re-admits current work.
Visibility polling postpones its item every 5 s without spending an attempt; an
upload still invisible after two minutes fails that item, which backs off and
keeps its receipt. Vectorize rate limits (including `VECTOR_DELETE_ERROR` 40041
with `Too Many Requests`) back off the item.

Visible uploads publish as chunks through the drain: sorted source locks, then
identity locks, one search preparation, one retirement update, one multi-row
selection insert and one reader notification. A vanished or changed source
fails or settles alone. Cleanup deletes only an unselected, stopped artifact
and records its delete receipt, so a delayed cleanup can never delete a
replacement upload. A shared provider call has no single owner: `AiUsage`
keeps one row per provider call and records the provider's total tokens once.
Embeddings remain outside frontier funding caps.

## AI evaluation drains

`ai/evaluation` owns the drain, its items and evaluation pages. Run authority
(live Run checks, pausing, funding resumption, the workflow fence around one
evaluation) comes in through the `AiEvaluationExecution` port that
`domains/run/service/ai-evaluation-execution.ts` provides; the drain itself
knows no Run tables. Saved-record questions and Sweeps are the only producers
of field evaluations; the drain evaluates field and statement work only, and no
discovery drain walks the household.

Automatic refresh work has no Run: its `runId` is null and its activation is
the authority. A member stops it from the Work page or `ai.stopAutomaticWork`:
discovery admits nothing, owed rows are parked, and `leaseStale` fails any
attempt in flight. It holds until a member resumes. Sweeps keep their Run.

Nothing queues an evaluation: `AiEvaluation.runAt` is set while the drain owes
it (`priority` 0 when the owner or an uncancelled requester is a running,
member-visible Run nobody scheduled; otherwise 1) and null once it settled or
parked. A parked evaluation is owed again when a member launches its Run, and
whenever a running Sweep's evaluate step still waits on it. Each feature is its
own permit unit, so features page in parallel up to
the queue's concurrency, which is also the bound on paid concurrency. A page
claims rows under one lease token (`attemptToken` on `DrainContext`), a
16-minute lease nothing renews because no consumer outlives 15 minutes. A mark
never takes a held lease, because that page may be paying the provider: no
sibling claims the row until the page releases it or the lease lapses. New
demand for the same input leaves the attempt to settle it. Changed input sets
`leaseStale`, which makes the attempt obsolete and fails its writes, and the
next page evaluates the new input once the row is released. Prepare rechecks
live Run authority, activation, pending or `result_ready` state and generation;
queued obsolete generations retire in sets before inference, and a stopped
requester parks its item. A paid answer is written as `result_ready` through
`ctx.fenced` before publication, so a later publication failure reuses it
instead of buying it again.

Each page observes up to 8 items; the rest stay owed and the drain rejoins fair
selection after the page's checkpoint. Items run two at a time, each in its own
guarded transactions under the drain lease. An item's workflow fence reads its
own row by primary key and fails once that row's lease is stale, lapsed or
released; the page-wide lease read filters on the unindexed `leaseToken`, so it
runs only outside SERIALIZABLE transactions, before paid requests. Heartbeat and
completion logs
annotate `drain.claim`, `drain.prepare` and `drain.publish` phase timing
without logging prompts or household evidence; the Job `page` log carries
`pageResult`, limited to the numeric `processed`, `published`, `failed` and
`covered` counts. Publication commits one SERIALIZABLE transaction per item
chunk; a failed chunk splits only after its transaction rolls back, and
committed siblings never replay.

Expected evidence invalidation is a typed obsolete outcome, including
acquisition eligibility that changed while inference ran and a Sweep basis
changed after queuing, before inference or paid-result reuse. Ordinary provider
text never decides obsoletion. Failures map at the drain seam:

- Invalidated evidence settles the evaluation `obsolete` as a publication
  outcome.
- AI budget, provider capacity and AI Gateway admission throw
  `JobDeferredError`, which stops the page without spending attempts. Funding
  or configuration refusal defers the affected feature, preserves the
  configured provider route and probes again after a bounded wait. The paid
  rung treats the Gateway's "Insufficient balance; add money to your gateway or
  use BYOK" refusal as a funding stop even when it arrives as HTTP 403 /
  `invalid_prompt`; that wrapper does not prove the prompt is malformed or that
  the household Run budget was spent. Gateway admission carries its actual
  retry time. Prepared paid siblings publish before a provider stop defers the
  remaining work.
- A governed target field whose current result is unavailable is that target's
  failure (`JobTargetError`), not an empty value or obsolete evidence. At
  publication its chunk rolls back and splits, so siblings commit without new
  inference; the target stays owed and spends item attempts.
- Anything else is the item's failure, and its third consecutive failure
  settles the evaluation `failed` with the raw error and settles its
  requesters. A Run cancel withdraws its requests and stops owing evaluations
  no other requester still wants.

Publication checks exact chunk leases under the ordered target locks, including
expiry; preparation still checks the whole claimed page. Atomic evidence,
activation, member-stop and receipt fences remain in the publication
transaction. Single-evaluation publication owns the same bounded snapshot
recovery as paged publication: a serialization conflict replays the DB-only
callback, lease and authority checks, settlement receipt and activation fence
in a fresh transaction, while inference and retained paid-result storage stay
outside that boundary. A caller-owned transaction owns its recovery and is not
replayed locally. Automatic application propagates serialization failures to
that owner, including preflight failures before review's savepoint; an aborted
serialization attempt is never converted to an ordinary policy refusal. Field
publication re-reads the declaration's read path, including mutation aliases
such as `ingredientId` exposed as `ingredient.id`. A loaded nullable relation is
empty; an absent root or missing governed result remains unavailable and cannot
authorize a proposal.

## Diagnostics and repair

A Worker memory termination can prevent item failures or a checkpoint from
being recorded. Read invocation outcomes alongside Run counters; a zero item
failure count alone does not establish uninterrupted execution.

- `job.runRollups` and `job.list` (`rollup`): a Run's live Jobs by reason
  (`leased` counts live leases; lapsed ones are `expiredLeases`, summarized as
  "N expired leases awaiting reclaim"), its own funding wait, and `stalled`
  when nothing was claimed or finished for `RUN_STALL_MS` and no live lease is
  in flight. A Run's demand is the Jobs and image rows it owns by `runId`;
  shared drain units belong to no Run.
- `job.activity` (`queue`): every Job kind and drain unit that is live or ran
  in the last hour, with the rows claimed in that hour, rows by latest outcome
  (succeeded, deferred, failed), the oldest due work, live and expired leases
  and the last claim. A Job kind lists its three largest groups of waiting
  Jobs by wait reason and Run purpose, each with a one-sentence summary and up
  to three Runs from the head of the kind's claim order; `retry` is a failure
  backoff and `turn` is plain queued work. A drain unit reports its latest
  page and reads its oldest due item and leased items from its stream. A unit
  that never ran has no record row and appears through its stream.
- `job.activity` (`evaluations`): `AiEvaluation` rows by feature and state:
  `queued` and `result_ready` whenever present, `blocked` when blocked in the
  last 7 days. Each carries its count, its oldest row's creation time and the
  most common stored error's first cause name.
- `job.deviceBacklog`: due Apple-device work, the Runs it holds up, devices
  that started an attempt in the last ten minutes (`Device.lastSeenAt` moves
  only on hello), device attempt starts per minute (reclaims included), and an
  ETA based on distinct accepted successful device completions over the last
  ten minutes. The completion sample excludes normalization, failed attempts
  and stale image sources; without a successful completion sample the ETA is
  unknown.

Runs use the generic `attention` saved view: member-visible stopped Runs that
have no successor, plus stalled Runs, ordered stalled first then newest. AI
cost is the Run's recorded charged usage. Apple Activity hands the household
queue off to `/work-queue` ([native Activity](../apps/apple/README.md#activity)).
The web audit-log changes feed follows the queue.

`generic/jobs/repo/observation.ts` reads the real owners for Activity,
maintenance, MCP and native clients. Rebuild movement is its last committed
page, independently of `finishedAt` and `cleanAt`. Failure totals name their
units: failed work items, image-processing attempts or rebuild pages, never
invented execution counts. Search repair reports committed record computations
and failed pages; its unknown total stays indeterminate.

### Hourly maintenance and retention

The hourly cron calls `maintainJobs` directly: one bounded image-repair page,
one retention page and one Suggestion-expiry page per tick. It also reconciles
stopped executions and dispatches each tick (`reconcileStoppedWork`). No
maintenance Job is enrolled.

- Completed Jobs are kept eight days, cancelled fourteen and failed thirty,
  under the pending-work and identity safeguards. A failed Job whose Run is
  terminal, not manual, not a member request and not mail or financial import
  work (`mail_import`, `mail_discovery`, `mail_search`, `mail_reclassify`,
  `purchase_validation`, `account_sync`) is pruned after fourteen days. Only Job
  rows are deleted; Runs stay as AiUsage cost evidence, and domain evidence
  stays.
- Pending Suggestions never expire: a field guess stays the picker's guess
  until its inputs change, and statement and recommendation Suggestions wait
  for a member.

### Recovery attention

Work excludes a retained failed evaluation after its owned retry receipt hands
off to a replacement, or after all remaining live requesters have handed off. A
shared failure remains visible while any uncancelled requester still needs that
original evaluation. Retry history and diagnostics remain stored.

Three history guards keep settled work from advertising recovery; Work and the
Run `needsAttention` value share them:

- Runs explicitly cancelled or aborted by a member, and permanently retired
  coordinators, stay in history without advertising execution recovery.
- Ended scheduled routine step kinds without an executor leave recovery
  attention only when they have no live Job, owned or requested evaluation
  roster, unresolved image job, active finding or proposed photo group. Manual
  Runs, funding stops and current executors remain visible. The manifest
  declares this history; no Run, step or transcript is retired or rewritten by
  the read.
- A failed `ai_refresh` Run with `ai_work_failed` stops advertising recovery
  when it has a durable owned roster, all current owned and requested
  evaluations are terminal (including blocked), and no live Job or unresolved
  image job remains. Effective request receipts and cancellation follow
  evaluation tally semantics. Retry handoffs can transfer responsibility to
  another owner and must resolve to retained evaluations; an applicable request
  receipt takes precedence. Malformed, missing, self-linked or cyclic targets,
  and chains exceeding 64 edges, keep recovery visible; the path checks defend
  against manual repairs as well as current forward-only writers. Paid
  `result_ready` work and current failures retain recovery.

The Runs attention saved view and stuck rollup additionally use
`ATTENTION_RUN_PURPOSES`, which omits routine kinds; Work retains actionable
routine failures. These are single-statement projections: evaluation-only
settlement becomes visible on the next poll without a synthetic Run change.
Failed status, diagnostics, results, requests, member cancellations and
conversations remain stored. Stalled execution, source Problems, findings and
pending photo proposals keep independent review paths. These projections do
not retire coordinators.

### Coordinator transcript retention

Coordinator transcripts are preserved until an explicit member-authorized
retirement. The maintenance `coordinators` step retires nothing, for both
scheduled and manual passes; there is no age threshold. Disposal follows the
[purchase-import module guide](../apps/web/src/server/domains/purchase-import/service/README.md#transcript-retention).
No Run status, transcript, source evidence, finding or paid result changes
under this policy, and execution alerts on already retired Runs stay stored.

## Run progress and diagnostics

Run detail shows a Plan table from `RUN_KINDS` in
`packages/schemas/src/activity-fields.ts`, filtered by the Run's selected
families. It lists steps in declaration order with purpose, scope, input count,
state, results, elapsed wall time and the current step ETA. Generic report
table cells keep their complete plain-text values and may also declare
status-pill, figure or internal-link presentation. Wall time includes queue and
paused time after the step starts; completed steps use their retained end time.

Inputs are counted at step start; unstarted steps never read as zero-input
work. Stored steps outside the current declaration/selection show separately
as execution history, not future planned work. Scope summaries describe
selected accounts/imports without exposing source IDs. Financial input links
use declared `runStepInput` list predicates backed by the same SQL selectors as
execution; they re-evaluate current eligibility under the stored Run scope and
recorded cutoff, not an archived membership snapshot. Source-record lists show
all live observations for selected charge keys, so their row count can exceed
the input count. Suggestion stages link to this Run's related decisions, not an
exact input population, and can show Suggestions other Runs published.

A Sweep covers statements and fields; its stored purpose is `sweep`. Field
sweeps use the `field_roster` / `field_evaluate` steps. Start them with
`run.sweep` and a field family containing entity, fields and filters; inspect
and pause/resume them with regular Run reads and controls. There are no
separate AI sweep operations or model overrides on a Run; each evaluation keeps
its own pinned model and evidence.

Step ETA uses at least three consecutive progress intervals (up to twelve),
including elapsed queue and handoff time between observations. Observed
throughput is available after the first completed interval but does not alone
support an estimate. The displayed range spans observed per-item durations with
a margin and rounds outwards to minutes, hours or days. Confidence is low with
fewer than six observations or more than threefold variation, otherwise
moderate; this is an observed range, not a statistical confidence interval. A
cheap latest page cannot replace the other observed durations. Phase changes
and retry resets clear observations; samples without interval history, unknown
input totals, stale progress, pauses and capacity waits produce no ETA. An
unfinished phase whose processed count reaches its initial total has no
remaining-work estimate and still needs its completion signal. Later steps
without estimates keep the overall ETA unknown, and no blended overall
percentage is inferred from different inputs.

Decision facets distinguish Ready to apply from Applied: readiness means the
current pending recommendation has passed checks and can be reviewed/applied;
only Applied means the change was recorded. Both counts remain visible at zero.
Multiple possible matches names competing candidates; other pending evidence
issues read Needs review. Replaced and No longer current explain why an old
recommendation cannot be acted on. Evidence starts with a plain-language
explanation of each blocker; raw blocker keys, reasons and apply refusal detail
remain in Raw diagnostics. Presentation never clears a blocker or changes a
recommendation's applicability.

Step pages record their own sample through `measurePage`
(`server/generic/jobs/page-work.ts`); executed steps receive it as their page
context's `work`.

- **Phases.** A driver times a phase with `work.time` or adds timings its
  repository already measured with `work.add`. Statement generation passes the
  same selection, preparation, publication and application times it logs.
- **Concurrency.** Peaks are `min(cap, items)`, the workers
  `forEachConcurrently` starts.
- **Queries.** The page runs inside `withDatabaseOperationMetrics`, so
  `queries` counts the traced pool's statements; zero counted means the page
  ran outside the traced pool and stores null ("not measured").
  `phaseQueries` attributes statements to phases measured with `work.time`;
  repeated phases accumulate and nested phases overlap, so their counts must
  not be summed as a page total. Timings supplied through `work.add` have no
  inferred query count.
- **Database waits.** Measured pages keep total wall time plus query, pool
  acquisition and client-queue durations; summed durations can overlap across
  concurrent work and are not additive phase timings.
- **Unmeasured drivers.** A page that records no phase stores no sample.

A Run's Diagnostics section and an Image's or Location's Jobs slot read one
Job's raw Worker lines through `job.logs`; credentials and limits are in
[infrastructure](infrastructure.md#inline-job-logs-and-limits).

## Apple version gate

Device work stops when the server refuses an older build's writes (HTTP 426):
the worker stops pulling and shows "Update required to process images". Raise
the minimum only for unsafe writes; see
[breaking changes](agents/domain-rules.md#breaking-changes).

## Member-facing work explanations

Work is the web entry point at `/activity`: one Background work list (the
health verdict, then each stuck or failed kind, device wait and stopped Run
with its retry) and one Needs you queue. `workQueue.status` is the single read
behind that list and the sidebar's stuck glyph, and agents can read it too. It
adds no alert engine, stored lanes or retry policy. The Needs you count is the
total published with the Work items read model
([work queue](guide/work-queue.md)); the status read carries none. A failing
kind reads as failing since the earliest `Job.failingSince` of its rows (the
last update for rows without one), and its diagnostic names the last
execution's error class with the stored error.

Stuck is decided on the server from completions over a window, never from a
snapshot of what is running, which reads as stopped between a drain's bursts:

- A drain or Job kind has work due for 30 minutes with no completion in those
  30 minutes. Retained tickets the drain never claims are not owed work. A
  drain's completions are published `DerivedValue` rows and its Job's latest
  page result. Thirty minutes outlasts the gaps between bursts and is half the
  one-hour lag members are promised, so the alarm shows before that breaks.
  The row leads with the cause when the stored rows name one: the largest
  group of that kind's waiting Jobs that share a wait reason ("115 Mail
  discovery Runs keep deferring on provider capacity."), or for a drain how
  long ago it last got a page. Its Technical details hold the whole
  `job.activity` queue as text, so the units that were served instead are
  named beside it.
- A drain unit's every page has failed for 30 minutes
  (`failingSince` on its record row) and its last page is under two hours old,
  so it is still being tried. Its Technical details hold the page's error
  class and stored error. Retry is withheld.
- An AI feature has `result_ready` evaluations that no page holds and whose
  failing streak (or last update) began 30 minutes ago: paid answers are not
  being published. The row counts them and names the most common error; it is
  omitted while the feature already shows failed work.
- A kind keeps failing: failed in the last 7 days with no later completion, or
  live with `JOB_NEEDS_ATTENTION_ATTEMPTS` failures. A drain item in that state
  counts, but Retry is withheld because retrying its Job does not move the
  item.
- Apple-device work has been due for 30 minutes and no device worked in 10.
- A Run a member started or reviews stalled, or its purpose failed in the last
  7 days with no successor and no later completion. A scheduled or discovered
  Run retries on its own, so it needs three failures in a row. Paused Runs are a
  member's choice and are never stuck.

For AI evaluations, settling obsolete evidence also advances the last-finished
signal: a queue retiring stale inputs is moving. It does not count as a
completed value or increase the published-value pace. Blocked admission and
member cancellation do not advance that signal.

Due for 15 minutes while still completing reads as catching up. Copy lives on
the kind (`stuck` in `JOB_KIND_POLICY`); an undeclared kind falls back to its
label so it cannot be silently invisible. The read probes indexes per drain and
priority and reads live and recently failed Jobs, so its cost does not follow
queue size. It takes the `run` and `workQueue` cache tags, not entity roots.

`RUN_KINDS` owns Run purpose, triggers, effects and declared steps.
`JOB_KIND_POLICY` co-locates each Job kind's member explanation with its
execution policy. Run and Job execution views show these definitions, while
actual outcomes, waits, raw errors and retry controls remain on their records.
Definitions are not evidence that execution happened. Retained unknown kinds
keep their diagnostics and explicitly lack a current definition.

Daily maintenance is a `maintenance` Run. Its declared effects are inspectable
before launch, and it remains one standard action. Exact input populations
become known at step start, provider estimates stay estimates, and
one-call/admission tallies do not imply a fixed total or ETA. Image maintenance
classification counts use the current processor revision and can overlap;
uncertain cutout eligibility does not imply a human review queue.

## Deadline scheduling and idle recovery

PostgreSQL owns Jobs, drain items, claims, progress, member pauses and retry
policy. Nothing but Postgres holds a deadline. A unit's successor permit is
delayed to the next owed time (at most twelve hours, Cloudflare Queues'
delivery-delay limit); the hourly cron reaches anything later and anything
whose message was lost. A permit cannot be cancelled, so a stale one touches
Postgres once and finds nothing due. A process dying between commit and its
post-commit signal recovers on app-open or the next hourly tick.

The hourly cron (`server/worker/scheduled.ts`) is the timer for work due later
and the backstop for a lost permit or broken delivery. It activates the
deployed Worker version's AI refresh policy on its first tick after a deploy,
rings due device work, reconciles, runs `maintainJobs`, runs units itself for
up to five minutes, then sends up to `maxConcurrency` permits for what is still
due (one delayed permit when the next work is later). A failure in one step
still lets the others and the daily pass run, then rejects the event.

The invocation at 7 a.m. America/Los_Angeles also launches the daily
`maintenance` Run and recovers missed work. Every daily step is idempotent, and
the daily pass is keyed by its household date (`Run.clientKey`), so a repeated
invocation reuses that date's pass even after it finished. Only an earlier
date's budget-paused pass makes way for a new one. A failed permit send retries
three times over about five seconds before the hourly cron is its only
recovery. App-open coalesces recovery and mail discovery. Gmail provider push
is not implemented.

`job.activity` and the status page report what runs, waits and last finished.
The Work page shows the `job.activity` queue and evaluation backlog behind its
closed Queue details disclosure.

### What references a Run

A Run is a member or agent session plus its history. These foreign keys are why
old routine Runs stay: no row is nulled or purged. Automatic work creates none
of the rows marked "session", and rows marked "no Run" can have none.

| Reference                                                                                                                             | Disposition                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `AiUsage`, `AiEvaluation`                                                                                                             | Session, or no Run for automatic work; `feature` and the actor attribute cost |
| `AiEvaluationRequest`                                                                                                                 | Session: a Run's request for an evaluation                                    |
| `Suggestion`, `RunFinding`, `AuditLog`, `McpToolCall`, `Job`                                                                          | Nullable provenance; cleared if a Run goes                                    |
| `RunOperation`                                                                                                                        | Exact-replay receipts, kept                                                   |
| `RunControlEvent`                                                                                                                     | Member history, kept                                                          |
| `RunStep`, `RunPushRegistration`                                                                                                      | Owned by the Run, deleted with it                                             |
| `Email`, `EmailCandidateObservation`, `EmailClassificationObservation`, `EmailRetrievalFailure`, `SourceOrderObservation`, `Purchase` | Source provenance, kept                                                       |
| `ImportPreparedOrder`, `ImportSourceClaim` (`firstRunId`, `lastRunId`)                                                                | Import session evidence, kept                                                 |
| `PhotoGroupProposal`, `PhotoRunImage`, `ImageProcessingJob`                                                                           | Photo session and device work, kept                                           |
| `Run` (`parentRunId`, `predecessorRunId`)                                                                                             | Lineage, kept                                                                 |

### Routine Run history

Default Run lists and counts omit the retained `ai_suggest` and `background`
purposes, omit `ai_refresh`, `connection_discovery` and `derived_refresh` once
they ended, and omit `mail_discovery` once it completed. An explicit purpose
filter includes them, and direct record reads still work. Automatic work
creates no Run: AI usage and evaluations can have none. Queue runtime failures
receive three delivery retries in addition to the durable Job's execution retry
policy.
