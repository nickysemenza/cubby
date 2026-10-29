# Durable Jobs

The universal `Job` table owns execution state for background work: claims,
leases, generations, retries and waits. Domain rows keep their outcomes and
evidence. [ADR 0015](adr/0015-unified-durable-work-coordination.md) records
the decision; this page owns the runtime contract. Derived-data families are
in [entities](entities.md#background-derived-data); Worker and database
capacity in [infrastructure](infrastructure.md#postgresql-and-hyperdrive).

## Job entity and identity retention

Job is a read-only generic entity over the durable `Job` table. Web, Apple and
MCP use the entity kernel for list/detail reads. Its `JOB-` shortcode has a
ten-character body from the shared shortcode alphabet. Enqueue creates its
`Entity` identity and execution row atomically through the shared identity
writer; a repeat enqueue by key preserves both identities. Kind policy supplies
the lane and internal-kind flag. Subject Images supply thumbnails, and Run
references arrive with their labels in the row read.

The entity exposes execution state, lane, waiting-on text, subject, Run,
attempts, raw error, lease end and timestamps. Filters cover lane, waiting-on
reason, state, kind, Run, attention and internal kinds. Internal work
(`image.device.wake`, `jobs.maintenance`, `derived.drain`, `derived.reconcile`,
`ai-refresh.activate`, anything policy marks internal) is hidden by default.
Retry now uses `job.retryNow` over checked codes or the exact current entity
filter.

Owning Run is the optional execution owner. Connected records and graph
traversal also expose typed entity subjects and the exact Image processing
record; a calendar origin is not an entity subject.

Job is the sole exception to permanent `Entity` identities: retention deletes
its identity in the same transaction as its pruned execution row. Enqueue
locks an existing Job through invalidation; retention skips locked
candidates, so it cannot prune a Job being invalidated or return a stale
identity. A pruned `JOB-` code may be recycled and no longer resolves; every
other entity retains its identity and code forever.

## Coarse Jobs and work items

A Job is a unit of execution, not a unit of household work. Work that fans out
over many records is a **drain Job** over **work items** in the generic
`WorkItem` table (`generic/jobs/repo/work-items.ts`): one Job per kind and
feature, and one item per `(target, ref)` it still owes. Drains:

| Drain Job key             | Kind                | Item `target`       | Item `ref`         |
| ------------------------- | ------------------- | ------------------- | ------------------ |
| `derived:drain`           | `derived.drain`     | derived family      | source row         |
| `ai-evaluation:<feature>` | `ai.evaluation`     | `ai.evaluation`     | AiEvaluation id    |
| `embedding:refresh`       | `embedding.refresh` | `embedding.refresh` | source entity id   |
| `embedding:cleanup`       | `embedding.cleanup` | `embedding.cleanup` | EntityEmbedding id |

An item holds only scheduling state: `drain` (its owning Job key), a fresh
`ticket` per mark, `priority` (0 for member and Run demand, 1 for automatic
work), `readyAt`, `attempts` and `lastError`. Domain rows keep outcomes.
`markWork` upserts items in the producer's transaction and wakes the drain
Job; `markWorkFrom` marks the rows a SQL source selects in one statement,
returning per-target counts (and a bounded ref sample) so a large fanout never
reaches the Worker. A re-mark during a page takes a new ticket, so the page
clears only the ticket it claimed and the item stays owed. The drain Job's
lease fences every item it claimed; items have no leases of their own.
`work-items.ts` is the producer and adapter interface (marking, pending and
ticket predicates, backlog); claiming, clearing and backoff
(`repo/work-claims.ts`) belong to `defineDrain` alone.

`defineDrain` (`generic/jobs/service/drain.ts`) is the one claim → prepare →
publish helper. It observes items by priority, readiness and ticket, keeps
only the ordered prefix admitted by the adapter's preparation budget (the
remaining observed tickets stay owed without consuming attempts unless the
existing coverage mechanism settles their identical applied effect), and prepares
it outside a transaction. It settles per-item preparation failures (backoff
from the kind policy, or the drain's `exhaust` at `maxAttempts`); then
publishes at most 25 weighted items per fenced transaction (SERIALIZABLE where
the drain declares it). A drain's `lock` takes its domain locks first and may
narrow the chunk: items it declines (a source row another writer holds) stay
owed, untouched, for a later page. A chunk that fails on a target error or
SQLSTATE class 22, 23 or 54 splits in halves until the failing item settles
alone; its siblings publish. `publish` may `retain` items it could not apply
(a derived target behind a newer fanout). `publish` may also report a bounded
set of extra ready marks whose identical
effect it already applied. `defineDrain` excludes the entire page's original
claims, then locks only unchanged covered tickets in the same drain with
`SKIP LOCKED` and clears them in the same fenced transaction. These covered
scheduling marks add no domain computation; the adapter bounds their observation
separately from weighted publication work. Newer or writer-held marks stay owed.
The page reports those settlements as `covered`; `processed` and `published`
keep counting the original page's claims.
An item's `lastError` keeps each
cause, capped so the database's own message survives. A drain with nothing
ready runs its `idle` publication (derived clock expiry) and completes, or
waits until its next item's `readyAt`; a `repeats` drain (derived, re-armed
each minute by `repeatJob`) completes even while items back off. Paid results that must survive a later publication
failure are written through `ctx.fenced` before publication (an evaluation's
`result_ready`). `postponeWork` waits without spending an attempt.

Work that is one record and one interactive outcome stays a Job of one:
`run.*`, `location-ai.*`, `image-metadata.extract`, calendar and connection
discovery, statement paging and image processing.

## Kinds and lanes

`apps/web/src/server/generic/jobs/kind-policy.ts` is the one registry of
per-kind policy: lane, internal flag, whether the server drain claims it,
`maxAttempts` (null never exhausts), failure backoff and an optional
`maxInFlight`. A kind absent there is a server kind with three attempts and
1 s doubling to 60 s backoff. Each lane names the executor that runs it:

| Lane           | Kinds                          | Executor                         |
| -------------- | ------------------------------ | -------------------------------- |
| `apple_device` | `image.device`                 | an Apple device's pull           |
| `frontier_ai`  | `image.cloud`, `ai.evaluation` | the server drain, paid providers |
| `external`     | `purchase.dispatch`            | a coordinator outside the drain  |
| `server`       | every other kind               | the server drain                 |

`drained: false` parks a kind: the drain never claims it, so device work does
not churn through server claims. Enqueueing device work rings connected
companions after commit, and a companion connecting to the doorbell is rung at
once; there is no polling interval. Work that comes due later (a failure
backoff, a deferral, a lapsed lease, a delayed release) rings through the
`image.device.wake` Job: each of those events wakes it (`wakeJob`), and its
page rings when parked work is claimable, then sleeps until the next parked
availability or lease expiry. A doorbell RPC failure fails the wake page, so
its retry rings again; reaching no open socket is not a failure. A release
with no delay also rings at once (best effort).

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
Mailbox discovery acquires at most five messages from its frozen provider page
per Job claim. Its durable message offset resumes the remaining messages without
replaying the completed prefix; absent offsets on retained pages mean zero.
Mailbox coverage advances only after every batch and history event is handled.
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
  availability, null until a hello reports it). Leases per device come from
  `job.queue` (`leases`), keeping the device list's core read to its page
  queries.

Retention skips Jobs with pending WorkItems or unobserved wakes. A producer
holds the existing Job's key-share lock through the wake transaction, so
retention either skips it or deletes it before the producer reads and recreates
its identity. A resumed Run's evaluation item is rechecked under Run locks
before a prepared parked item can be cleared. Embedding publication takes
source locks before WorkItem locks, matching source producers.

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

`maxInFlight` caps one kind's live leases across every drain (AI evaluation:
two, leaving the other lanes free). Claim-time admission takes a nonblocking
transaction advisory lock per kind and counts `running` Jobs whose lease has
not expired; an expired lease frees capacity and stays reclaimable. Run-owned
work bypasses the cap.

Member-first ordering inside a drain is item priority: root transactions in
Job execution mark derived inputs at priority 1, member transactions at 0, and
savepoints inherit the outer transaction's priority.

The drain runs up to `JOB_DRAIN.concurrency` Jobs at once, and the queue
consumer (`packages/shared/src/background-queue-consumer.json`) runs several
drains. Free lanes refill while siblings run; a skipped claim stays excluded
for the invocation, so a locked row cannot consume its budget. An escaped lane
error stops new selection, and the drain still joins active lanes before
returning it. The 20-second budget limits starting work, not the lease: an
in-flight provider call may cross it and still publish. A drain that stops
with due work left publishes another wake.

Device pulls apply the same two classes to each command in a batch
(`domains/image-processing/repo/device-admission.ts`): an active, member-visible Run's
parked work leads, and after `DEVICE_OWNED_STREAK` (`1 / DEVICE_BACKFILL_SHARE -
1`) run-owned device services in a row, the next command serves backfill. The
owed class is chosen first; a device's preference for work another device
last ran only orders candidates within it. A service is a device hand-off
that commits (an assigned attempt of `image.device` work; each reclaim
counts), classified at assignment by selection's own `jobRunOwned`: serving
an ended Run's work is backfill and resets the turn, and a Run ending later
never reclassifies services already counted. The streak lives in the
`image.device` row of `JobLaneAdmission`. A device pull
(`claimCompanionImageCommands`) claims, prepares, assigns and reserves output
in one transaction that locks that row before choosing a class, so
concurrent batches take their turns one at a time. Each committed hand-off
updates the streak before selecting the next command, so a wide batch keeps
backfill's reserved share. A hand-off the server cannot make (participation
turned off, output not reserved, preparation failed) is released in the same
transaction and counts nothing.

## Execution

A handler has one shape: `prepare(db, claim, input, ctx)` reads and calls
providers outside a transaction and returns an outcome with an optional
`publish(tx)`. The executor (`generic/jobs/service/jobs.ts`, private) owns
everything else:

- **Lease.** Five minutes, renewed every 30 seconds. A refused renewal aborts
  `ctx.signal` with `JobSupersededError`; provider calls take the signal.
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
  Job (`location-ai.*`, `image.cloud`) registers through `withJobFence` so the
  Gateway checks its lease before every paid request. A single-record handler
  passes `ctx.fenced` to its publication, and member or maintenance callers of
  the same publication pass `outsideJob(db)`, an ordinary transaction.
- **Failure.** One classifier walks the cause chain: a pause stops the Job; a
  deferral (`JobDeferredError`, funding, provider capacity) waits without an
  attempt; a superseded claim ends quietly; a target error isolates one item
  inside a drain; a retryable error backs off; anything else fails an attempt.

The external-claim interface (`repo/external-claim.ts`) lets an executor
outside the server drain, an Apple device pull, hold the same lease and settle
through the same fences: claim, hold, release, fail and settle a claim; renew
or re-arm leases; record the lease holder; retire, restart or end the waits of
external Jobs. Image processing is its one caller and owns device admission,
backlog and leases (`domains/image-processing/repo/device-*.ts`). Producers use
`repo/producer.ts`, member and Run controls `repo/operator.ts`, drains
`defineDrain` and `repo/work-items.ts`, and readers `repo/job-reads.ts` (rows
by identity, a Run's live lease, stopped Run executions). The queue core,
selection and item claiming (`repo/queue.ts`, `repo/work-claims.ts`),
`db/job-schema.ts` and the `Job`, `JobInvalidationCapture`,
`JobLaneAdmission`, `WorkItem` and `WorkTicket` table objects are private to
`generic/jobs`, tests included: oxlint's `no-restricted-imports` and
`no-restricted-properties` exempt only `generic/jobs` and the files that
declare or aggregate the tables. Tests seed, age, lock and inspect that state
through `generic/jobs/jobs.fixtures.ts` and claim through
`repo/external-claim.ts`. Whole-model consumers (the database client,
migrations checks, test setup) import `db/drizzle-schema.ts`.

## Wakes

A source capture appends its own row to `JobInvalidationCapture` in the
save's transaction (`wakeJob`; the generated derived mark function captures
`derived:drain` once per writing transaction, ADR 0021). It never updates
another capture or the Job's execution row, so concurrent writers share no
mutable counter, and a rolled-back save leaves no capture. A first wake
creates the Job.

A Job is due when it is queued and not waiting, or completed, and has an
unobserved capture. A claim acknowledges exactly the captures visible in its
transaction; there is no timestamp or sequence frontier, so a capture that
commits later stays pending. Wakes never restart a pass: a running pass
finishes and publishes its paid outputs, and the pending capture makes the Job
due again. `enqueueJob({ invalidate: true })` is the only restart: it bumps the
generation and clears the lease, so the old pass fails its fence. Catch-up
(`repeatJob`) requeues only a completed Job no capture has woken.
Retention deletes only acknowledged captures.

Retained completed Jobs outnumber live ones, so the due predicate tests
pending captures as key membership in the few distinct pending keys; a
BitmapOr reaches woken Jobs through `Job_key_unique` and live ones through
`Job_due_idx`.

## Retries

Claiming is not an attempt; a failure is, and so is reclaiming an expired
lease (the previous executor vanished mid-pass, and a crash loop must still
exhaust). A failed Job backs off by its policy, `baseMs · 2^(failures - 1)` up
to `maxMs`, and fails after `maxAttempts`; `maxAttempts: null` (drains, image
processing, maintenance) never exhausts. A woken completed Job starts a fresh
pass with a fresh budget. `releaseJobClaim` hands a claim back without an
attempt, and deferrals never count. Work items keep their own attempts and
backoff inside a drain.

Retry now (`job.retryNow`, `retryJobsNow`) makes a filtered set due at once:
backoff and provider waits clear, prior errors stay, failed and cancelled Jobs
reopen with a fresh budget and generation, and running or member-paused Jobs
are left alone. A Run cancel is one set-based statement (`cancelJobsWhere`);
never-exhausting work belongs to its subject and survives a Run cancel.

`run.funding-resume` is keyed by funding window, not Run: its one handler
resumes every funding-paused Run. A funding-paused import stays `paused_auth`
rather than stopping for review. Run control refusals are
`RUN_CONTROL_REFUSED` (409), never 500.

## Image processing

Image processing is never abandoned. `ImageProcessingJob.state` stores only
the outcome: `pending` while open, `ready`, or `skipped` for a completed negative
subject lift or a moot ending (image deleted, upload replaced, processor superseded,
or type excluded: device work on a source type no device command carries, such as a GIF).
A subject lift's `no_subject` or `not_suitable` result is final for that source hash
and processor revision. Its negative evidence and attempt history stay recorded;
the derivative is skipped and the original remains usable. Apple descriptions
still run independently for every image. Other executor skips, including
`unsupported_format`, become retryable failures with their reason preserved. A
stored `failed` is a legacy state of a superseded processor. The displayed
state derives from the Job (`image-job-state.ts`): `leased` for a live lease,
`waiting_for_device` for parked device work, `pending`, and `failed` ("Needs
attention (retrying)") once a job failed `JOB_NEEDS_ATTENTION_ATTEMPTS` times in a row
or its execution stopped; it keeps retrying. An executor's `retryable: false`
(say `deadline_exceeded`) retries later with its cause recorded; a missing
subject-lift derivative is rebuilt. Explicit image retry reopens a negative cutout
without discarding its evidence or allowing maintenance to immediately settle it again.
A changed source or new processor revision is new work, and
a newer Apple build's first pull makes backing-off device work due.

Recurring image-execution repair also settles retained negative cutout failures in
bounded batches. This negative-outcome pass requires the current source/revision and the matching settled
attempt, locks the image, image job and unclaimed execution, and leaves running,
paused and cancelled executions alone. Attempt records, result evidence and runtime
provenance are retained. The repair does not execute the image again or reclassify
model, network or other processing errors as negative cutouts.

`imageProcessingLane` fixes each job's lane: subject lifts, Apple descriptions
and AVIF cloud descriptions (which need device JPEG preparation) run on
devices; other cloud calls on the server. Device pulls claim parked work
directly and prefer work whose last attempt ran on another device.

Migration 0029 converted the pre-lane `image.processing` kind under a lock on
`Job`, then added `Job_kind_retired_check`, which refuses that kind. A
pre-cutover Worker's write of it waits for the migration and then fails, so
it is never accepted as work no handler serves; a rejected scheduling is
recreated by the image backfill. An execution an old Worker failed (claimed
`image.cloud` without a handler) needs no repair: image kinds never exhaust,
so a failed row is due again once available, with its attempts and backoff. The check retains no work and can be dropped once no
pre-cutover Worker can run; nothing reads it.

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
  admission lock. A bounded candidate page per class avoids rescanning the full
  queue for every slot; each hand-off rechecks due times, leases and Run class
  within that page, preserving per-command capabilities, device preference,
  attempts, leases and presigned URLs. A prepared Job cannot re-enter the batch
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
- `imageProcessing.complete` after expiry is adopted while the token is
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

- `job.queue`: live Jobs counted by lane and waiting-on reason, the set's
  leased image work per executor (`leases`: live and expired), and a page of
  matching Jobs with their `waitingOn`.
- `job.runRollups` and `job.list` (`rollup`): a Run's live Jobs by reason
  (`leased` counts live leases; lapsed ones are `expiredLeases`, summarized as
  "N expired leases awaiting reclaim"), its own funding wait, and `stalled`
  when nothing was claimed or finished for `RUN_STALL_MS` and no live lease is
  in flight. A Run's demand is the Jobs it owns by `runId`; shared drain Jobs
  belong to no Run.
- `job.explain {id}`: the waiting-on chain for a `RUN-`, `IPR-` or `EML-` code
  or a Job id, on MCP (`maintenance`) and `cubby call`.
- `job.deviceBacklog`: due Apple-device work, the Runs it holds up, devices
  that started an attempt in the last ten minutes (`Device.lastSeenAt` moves
  only on hello), device attempt starts per minute (reclaims included), and an
  ETA based on distinct accepted successful device completions over the last ten
  minutes. The completion sample excludes normalization, failed attempts and stale
  image sources. Without a successful completion sample the ETA is unknown.

Web Activity’s Now view presents the device backlog banner, compact lane/reason
counts, Runs needing attention, then Jobs. Needs you also exposes Run and Job
attention alongside the Work queue’s Decisions and Problems groups. Navigable counts use the Job entity
population, hiding internal work with the table. Every supplied retry
restriction intersects, including mixed entity filters, row IDs and Run scope.
Count chips scope the Job table; web records that scope in Activity's URL.
Runs use the generic `attention` saved view: member-visible stopped Runs that
have no successor, plus stalled Runs, ordered stalled first then newest.
The embed shows ten rows and links to all matching Runs. AI cost is the Run's
recorded charged usage. Jobs use the generic In progress view, including image
subject thumbnails, and a chevron expands Explain, that Job's Worker logs and
Retry now underneath its row. Closed web rows remain 32 px. There is one
shared table renderer. Apple Activity hands the household queue off to
`/work-queue` ([native Activity](../apps/apple/README.md#activity)).
The web audit-log changes feed follows the queue.

The `jobs.maintenance` Job (`workflows/job-maintenance.ts`) re-arms every five
minutes from the minute cron. Each pass repairs image execution in bounded
batches (retires moot work, gives open rows without a live execution one;
failed image executions count as live) and keeps the device wake armed. Every
six hours it also prunes completed and cancelled Jobs older than
`JOB_RETENTION_MS` with their `Entity` identities, and observed captures, in
bounded batches, continuing at once while a batch fills. Failed Jobs and all
domain evidence (image attempts, AI evaluations, Run history, audit) stay.
There is no per-kind queue health or alerting: with a few dozen coarse Jobs,
Activity's counts and a stalled Run show a stuck queue directly.

## Producers

Queue messages are best-effort wake-ups for intent already committed in
PostgreSQL. The shared `wakeJobs` sender uses the fetch request's `waitUntil`
lifetime, so a slow queue send does not delay a committed mutation receipt.
Without a request context (including queue and cron invocations), the caller
still awaits the send. Queue failures are logged and cron recovers committed
work; transaction rollback schedules no wake. Producers use this same sender
rather than implementing their own request-lifetime branch.

A producer must not enqueue faster than the drain can serve. One unbounded
connection-discovery pass once enqueued an evaluation for every household
record (~55k), which starved every other kind for days.

- Routine connection discovery (`discovery.connections`) queues one
  evaluation page (`CONNECTION_ROSTER_PAGE`, 100 records) per pass and holds
  its cursor for 30 s while `CONNECTION_DISCOVERY_PENDING_CAP` (1,000)
  connection evaluations wait (`rate_limit`). A full pass over ~55k records
  is meant to finish within an hour; a longer wait idled the pass, not the
  queue. It walks the newest records first, and never appends to a stopped Run. A changed
  record updates its queued slot in place, retaining its Job. Cancelled work whose Run
  failed with `failureCode = "superseded"` (a cleared backlog, not a member's
  decision) is re-admitted at that pace; a member's cancel stays final. A
  member's cancel of the pass's Run also stops the pass: it resets its cursor
  and waits a day rather than continuing under a new Run. The roster admission
  transaction locks the cursor's owning/replaced Runs before reading status or
  opening a continuation. A member-stopped result resets the cursor and persists
  the one-day wait; superseded Runs can still continue.
- Publication correction work is one `assessment.correction` Job per
  publication commit (`targetAssessmentIds`), not one per assessment; sources are
  still resolved after commit under serializable isolation.
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

### Embedding execution

Embeddings run on two drains. `embedding:refresh` items are keyed by source
entity id; prepare reads the source's kind from its `Entity` identity, builds
current search text and hashes it, so a re-mark during a page simply takes a
new ticket. `embedding:cleanup` items are keyed by `EntityEmbedding` id, which
is also the physical Vectorize vector id: a Job id is never a vector id.
Search publication, search-index repair and derived compute mark sources with
`markWork`; cleanup marks every retired, failed or deleted artifact whose
vector has no delete receipt.

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

`ai/evaluation` owns the drain, its items and evaluation pages. Run authority
(live Run checks, pausing, funding resumption, the workflow fence around one
evaluation) comes in through the `AiEvaluationExecution` port that
`domains/run/service/ai-evaluation-execution.ts` provides; the drain itself
knows no Run tables. Each feature has one drain Job, `ai-evaluation:<feature>`, over items keyed by
evaluation id (priority 0 when the owner or an uncancelled requester is a
running, member-visible Run nobody scheduled; otherwise 1). An attempt is the
drain lease plus the item's ticket (`aiEvaluationAttemptToken`): a lost lease,
changed input or new demand makes an in-flight attempt obsolete without any
per-evaluation Job. Prepare rechecks live Run authority, activation, pending or
`result_ready` state and generation; queued obsolete generations retire in sets
before inference, and a stopped requester parks its item. A paid answer is
written as `result_ready` through `ctx.fenced` before publication, so a later
publication failure reuses it instead of buying it again.

Failures map at the drain seam: invalidated evidence settles the evaluation
`obsolete` as a publication outcome; AI budget, provider capacity and AI
Gateway admission throw `JobDeferredError`, which stops the page without
spending attempts; anything else is the item's failure, and its third
consecutive failure settles the evaluation `failed` with the raw error and
settles its requesters. A Run cancel withdraws its requests and drops the items
of evaluations no other requester still wants. `maxInFlight: 2` leaves the
other drain lanes free for other kinds.

Product identity and connection features prepare a page of up to 100 items
together and publish it in fenced chunks; other features run up to 8 items, two
at a time, each in its own guarded transactions under the drain lease.
Paged evaluations annotate the existing Job heartbeat and completion logs with
`evaluation.prepare`, `evaluation.stage` and `evaluation.infer` phase timing.
These labels distinguish evidence preparation from decision work without logging
prompts or household evidence; concurrent decisions share one inference phase.
Connection stages add `connections.*` timings within inference, and drains add
`drain.claim`, `drain.prepare` and `drain.publish`. Heartbeats list all active
phases when work overlaps; completed durations sum per phase, so nested and
concurrent phase totals are not additive wall time or allocation evidence.

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
An oversized question fails visibly. Page evidence is limited to 4 MiB; an
unadmitted suffix stays due rather than completing its enumeration receipt.

Connection pages evaluate 8 sources at once (a Worker invocation holds five
strong connections). Expense Project recommendation inputs and
FinancialTransaction settlement/transfer retrieval load for the page before
provider work. Evidence capture shares the page's reads and the validated frozen
JSON of repeated recommendation contexts within that capture pass, instead of
copying the same context into every candidate tree.
All evidence fields and serialized fingerprints remain unchanged. Locked
publication capture always obtains a fresh snapshot; unlocked caches cannot
satisfy its authority checks. If one candidate becomes unreadable, capture retries
per source and returns that
source's failure without rejecting healthy sources. Nearby purchases retain their per-transaction top ten and each
Purchase retains its original ranked settlement limit before allocation and
conflict filtering. Acquisition search still captures each newly retrieved
candidate before subsequent provider waits. Compatible Product identity and
field questions share operation-specific usage objects and the page's decision
wave; nested pair evaluation joins that wave instead of dispatching per source.
Distinct Runs, features, models and operations remain separate accounting groups.
Duplicate questions inside one wave await its own cache claim's completion;
Jobs still defer when another invocation owns the claim.

One batched fingerprint read fences the page before evaluation and each chunk
before writes; a changed or deleted source is obsolete without writes.
Incomplete candidate coverage retries the source before any of its candidates
publish. Candidate publication locks live endpoints in the shared
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

## Apple version gate

Device work stops when the server refuses an older build's writes (HTTP 426):
the worker stops pulling and shows "Update required to process images". Raise
the minimum only for unsafe writes; see
[breaking changes](agents/domain-rules.md#breaking-changes).

## Member-facing work explanations

Activity is the web entry point for Needs you, Now, History and Advanced
maintenance (`tab=needs-you|now|history|maintenance`). Legacy Activity links
with queue filters open Now; audit filters open History. Needs you reuses the
canonical Work queue and Run/Job attention predicates. It does not add an
alert engine or change retry policy. Normal retries, waits and dependencies
remain in Now. Existing Work queue views remain usable.

`RUN_KINDS` owns Run purpose, triggers, effects and declared steps.
`JOB_KIND_POLICY` in `packages/schemas/src/job.ts` co-locates each Job kind’s
member explanation with its unchanged execution policy; the server kind-policy
module re-exports that policy. `/runs/types` renders the static reference.
Run and Job execution views link to these definitions, while actual outcomes,
waits, raw errors and retry controls remain on their existing records.
Definitions are not evidence that execution happened. Retained unknown kinds
keep their diagnostics and explicitly lack a current definition.

Nightly maintenance is a `maintenance` Run, separate from the five-minute
`jobs.maintenance` queue-upkeep Job. Its declared effects are inspectable before
launch; it remains one standard action. Exact input populations become known
at step start, provider estimates stay estimates, and one-call/admission
tallies do not imply a fixed total or ETA. Image maintenance classification
counts use the current processor revision and can overlap; uncertain cutout
eligibility does not imply a human review queue.
