# Durable Jobs

The universal `Job` table owns execution state for background work: claims,
leases, generations, retries and waits. Domain rows keep their outcomes and
evidence. [ADR 0015](adr/0015-unified-durable-work-coordination.md) records
the decision; this page owns the runtime contract. Derived-data families are
in [entities](entities.md#background-derived-data); Worker and database
capacity in [infrastructure](infrastructure.md#postgresql-and-hyperdrive).

## Kinds and lanes

`apps/web/src/server/generic/jobs/kind-policy.ts` is the one registry of
per-kind policy. A kind absent there runs on the server drain and fails after
its row's `maxAttempts`. Each kind names its lane, the executor that runs it:

| Lane           | Kinds                          | Executor                         |
| -------------- | ------------------------------ | -------------------------------- |
| `apple_device` | `image.device`                 | an Apple device's pull           |
| `frontier_ai`  | `image.cloud`, `ai.evaluation` | the server drain, paid providers |
| `external`     | `purchase.dispatch`            | a coordinator outside the drain  |
| `server`       | every other kind               | the server drain                 |

`drained: false` parks a kind: the drain never claims it, so device work no
longer churns through server claims. Enqueueing device work rings connected
companions after commit, and a companion connecting to the doorbell is rung at
once; there is no polling interval. Work that comes due later (a failure
backoff, a deferral, a lapsed lease, a delayed release) rings through the
`image.device.wake` Job: each of those events arms it (`armDeviceWake`, a
restarting invalidation of its own Job, so an arm during a wake page is never
lost), and its page rings when parked work is claimable, then sleeps until
the next parked availability or lease expiry. A doorbell RPC failure fails
the wake page, so its retry rings again; reaching no open socket is not a
failure. A release with no delay also rings at once (best effort).

## Waiting on

`generic/jobs/repo/waiting-on.ts` is the single derivation of what a live Job
waits on; every client (web, Apple, CLI, MCP) and every rollup reads it.
`jobWaitingOn` in `packages/schemas/src/job.ts` is the wire vocabulary:

- `due`: claimable now; `aheadCount` in the drain's own selection order (the
  fair order per class, interleaved per batch with backfill's reserve:
  `drainSelectionIndex`) and `etaSeconds` from claims over the last 30
  minutes. Only the next batch is exact: later batches re-rank kinds by their
  last service, so beyond `JOB_DRAIN.batch` the position is a projection and
  `aheadIsEstimate` is true (shown as "behind about N").
- `waiting_device`: parked device work; position in device claim order
  (`deviceSelectionIndex`, with backfill's turn), exact apart from a
  device's preference for work another device last ran.
- `waiting_funding`: an `ai_funding_window` wait until the window resets.
- `leased`: an executor holds it, named with its device installation id
  (`executorDeviceId`, null for cloud) and `leasedAt` (the claim time);
  `expired` once the lease lapsed unreclaimed.
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

Declared entity fields carry the same facts to web, Apple and MCP:

- Run: `waitingOn` (the rollup line), `stalled`, `successorRunId` ("Retried
  as", the newest Run whose `predecessorRunId` names it; `predecessorRunId`
  reads "Retry of"), and `displayStatus` for the header. A `needs_review` or
  `failed` Run with a successor reads `retried` (its open work moved; its own
  findings stay on its sections), and an `execution_limit` stop reads
  `waiting_for_funding`. The stored `status` stays the filter.
- Image job: `waitingOn` for open rows.
- Device: `updateRequired`, `inactive` (not seen for 7 days or never) and
  `appleIntelligenceAvailable` (the hello's actual-image description
  availability, null until a hello reports it). Leases per device come from
  `job.queue` (`leases`), keeping the device list's core read to its page
  queries.

## Priority and fairness

`dueJobs` builds each batch of `JOB_DRAIN.batch` Jobs:

1. Jobs whose `runId` is a running, member-visible Run lead (routine Runs such
   as connection discovery do not).
2. Backfill (everything else) keeps `JOB_BACKFILL_SHARE` of every batch.
3. Within each class, a weighted round-robin across kinds: a kind's share of
   a round is `1 + log10(backlog)`, at most `JOB_MAX_KIND_WEIGHT`, so a
   100k flood gets more slots but never starves another kind. Within a round
   the least recently claimed kind goes first; within a kind, priority, then
   age.

The drain runs up to `JOB_DRAIN.concurrency` pages of a batch at once, and the
queue consumer (`packages/shared/src/background-queue-consumer.json`) runs
several drains. Every page holds its own row lock and lease. AI evaluation Jobs
carry no `runId` because shared evaluations serve several Runs; they compete
as backfill. Run views still attribute them: a Run's demand (`runDemandPairs`)
is its own Jobs plus the evaluation Jobs it owns or still requests (an
uncancelled `AiEvaluationRequest`), once each, for rollups, `job.queue` with a
Run, Retry now and explain.

Device pulls apply the same two classes to one claim at a time
(`generic/jobs/repo/device-admission.ts`): an active, member-visible Run's
parked work leads, and after `DEVICE_OWNED_STREAK` (`1 / JOB_BACKFILL_SHARE -
1`) run-owned device services in a row, the next pull serves backfill. The
owed class is chosen first; a device's preference for work another device
last ran only orders candidates within it. A service is one device claim
(each reclaim counts), classified when admitted by selection's own
`jobRunOwned`: serving an ended Run's work is backfill and resets the turn,
and a Run ending later never reclassifies services already counted. The
streak lives in the `image.device` row of `JobLaneAdmission`, which each
device claim locks and updates in its transaction, so concurrent pulls take
their turns one at a time. A claim the server cannot hand over (preparation
fails, participation turned off, output reservation fails) is undone in its
release's transaction as if never admitted: a refused Run claim gives back its
slot, and a refused backfill restores the streak it reset plus Run claims
admitted since, unless another backfill was admitted meanwhile
(`backfillAdmissions` moved), which already spent the turn.

## Durable invalidation

A source capture never writes a long-lived Job's execution row. It bumps the
Job's `JobInvalidation` revision in the save's transaction
(`recordJobInvalidation`; refresh families through `invalidateRefreshFamily`).
Claims, renewals and publication never write that row, so execution on
another connection cannot abort a capture's serializable transaction, and a
rolled-back save leaves no invalidation.

The Job observes the revision itself. A Job whose `observedRevision` trails
the marker is due, even when completed. The claim that observes it starts a
fresh pass: a new generation, no cursor or result, a fresh attempt budget, and
the revision recorded as observed. `restartsPass: false` (the quality family)
lets a pass in progress keep its cursor, and the finishing page absorbs
captures made meanwhile; its scheduled repeat reruns it. Rerunning on them
would never settle, because the pass's own Run records invalidate quality. Publication of a restarting kind rereads the marker and supersedes
a page whose pass began before a capture, as a generation change does. For
restarting kinds, a capture committing during publication or while a worker
dies is never lost: the finished or reclaimed Job still trails the marker.
Failure does not end a restarting family either: execution reads the marker
before its terminal write, so a capture can commit in between, and a failed
Job trailing a restarting marker is due again with a fresh pass and recovery
window. Paused and cancelled Jobs are member stops and never wake.

Each capture also appends its revision and time to `JobInvalidationCapture`.
Health dates a woken Job from its first revision past `observedRevision`, so
repeated captures keep the original pending start, and so does a catch-up
requeue (`repeatJob`) that resets availability to now without serving the
capture: a woken Job is due since the earlier of its first unseen capture and
its availability. Retention deletes rows a claim has observed. Migration 0030
recorded each marker already ahead of its Job at the cutover as a capture of
its current revision, dated by the marker's last write.

## Retries

A failed page of an exhausting kind waits `1 s · 2^attempts` (at most 60 s)
and fails after `maxAttempts`; each claim counts. A never-exhausted kind
(`exhaust: false`: image processing, the watchdog, retention) counts only
reported failures: a claim, a release, or reclaiming a vanished executor's
expired lease is not an attempt. It backs off from `baseMs` doubling to
`maxMs` (24 h for images) forever. `releaseJobClaim` hands a claim back
without counting; typed waits (`JobDeferredError`, funding) never count.

Retry now (`job.retryNow`, `retryJobsNow`) makes a filtered set due at once:
backoff and provider waits clear, prior errors stay, failed and cancelled Jobs
reopen with a fresh budget and generation, and running or member-paused Jobs
are left alone. A Run cancel is one set-based statement (`cancelJobsWhere`);
never-exhausted work belongs to its subject and survives a Run cancel.

`run.funding-resume` is keyed by funding window, not Run: its one handler
resumes every funding-paused Run. A funding-paused import stays `paused_auth`
rather than stopping for review; a legacy review stop with
`failureCode = execution_limit` resumes and continues with the window unless
a retry or restart successor names it as `predecessorRunId`: its open work moved
to the successor, so neither the window nor direct resume redispatches it. Run
control refusals are `RUN_CONTROL_REFUSED` (409), never 500.

## Image processing

Image processing is never abandoned. `ImageProcessingJob.state` stores only
the outcome: `pending` while open, `ready`, or `skipped` for a moot ending
(image deleted, upload replaced, processor superseded, type excluded). Only
the server decides a moot ending: an executor's `skipped` (`no_subject`,
`not_suitable`, `unsupported_format`) is recorded as a retryable failure that
keeps its reason code, backs off and asks for attention like any failure. A
stored `failed` is a legacy state of a superseded processor. The displayed
state derives from the Job (`image-job-state.ts`): `leased` for a live lease,
`waiting_for_device` for parked device work, `pending`, and `failed` ("Needs
attention (retrying)") once a job failed `JOB_NEEDS_ATTENTION_ATTEMPTS` times in a row
or its execution stopped; it keeps retrying. An executor's `retryable: false`
(say `deadline_exceeded`) retries later with its cause recorded; a missing
subject-lift derivative is rebuilt. A new processor revision is new work, and
a newer Apple build's first pull makes backing-off device work due.

`imageProcessingLane` fixes each job's lane: subject lifts, Apple descriptions
and AVIF cloud descriptions (which need device JPEG preparation) run on
devices; other cloud calls on the server. Device pulls claim parked work
directly and prefer work whose last attempt ran on another device.

Migration 0029 converted the pre-lane `image.processing` kind under a lock on
`Job`, then added `Job_kind_retired_check`, which refuses that kind. A
pre-cutover Worker's write of it waits for the migration and then fails, so
it is never accepted as work no handler serves; a rejected scheduling is
recreated by the image backfill. Executions an old Worker stopped (claimed
`image.cloud` without a handler and failed) are restarted by the watchdog's
image repair. The check retains no work and can be dropped once no
pre-cutover Worker can run; nothing reads it.

Device wire contract:

- `imageProcessing.pull` leases for `leaseSeconds` (default 60, 20–300). A
  null command means an empty queue: a claim the server cannot hand over is
  released first, and a failed hand-off is an error, not an empty pull.
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

## Diagnostics and repair

- `job.queue`: live Jobs counted by lane and waiting-on reason, the set's
  leased image work per executor (`leases`: live and expired), and a page of
  matching Jobs with their `waitingOn`.
- `job.runRollups` and `job.list` (`rollup`): a Run's live Jobs by reason
  (`leased` counts live leases; lapsed ones are `expiredLeases`, summarized as
  "N expired leases awaiting reclaim"), its own funding wait, and `stalled`
  when nothing was claimed or finished for `RUN_STALL_MS` and no live lease is
  in flight. `job.list {runId}` groups the Run's demand, including AI
  evaluation Jobs it requests.
- `job.explain {id}`: the waiting-on chain for a `RUN-`, `IPR-` or `EML-` code
  or a Job id, on MCP (`maintenance`) and `cubby call`.
- `job.health`: `{snapshot}`, the queue watchdog's latest measurement, null
  before its first page.

The web Activity page is the overview: the watchdog's red badge with raw
alert evidence when unhealthy, the queue counts by lane and reason (the Apple
lane also counts active installs, those needing an update, and leases per
device with expired ones flagged), Runs needing attention with their rollup
and stall flag, then the filtered Job list. Every count links to that list
(`/activity?lane=…&reason=…`, also `state`, `kind`, `runId`, `attention`);
Retry now confirms and applies `job.retryNow` to the list's filter, and each
row expands to its `job.explain` chain. The audit-log changes feed follows.

The `queue.watchdog` Job re-arms every five minutes from the minute cron. It
first repairs image execution in bounded batches (retires moot work, reopens
legacy leased rows, restarts stopped executions of open rows), then measures
per-kind due count, oldest due age, claims per minute, due growth, expired
leases and image/Job disagreement against `QUEUE_ALERT_THRESHOLDS`.
`no_claims` fires when a drained kind with due work had no claims in the
window, or when a Job stayed due through the whole window although the
kind's claims could have served every due Job (claims of one family do not
cover another). New
alerts log at error level with raw numbers; Activity reads them through
`job.health`. There is no household push channel for them: push
registrations exist only per photo Run.

The `jobs.retention` Job prunes completed and cancelled Jobs older than
`JOB_RETENTION_MS`, and observed capture times, in bounded batches. Failed Jobs, embedding Jobs (their
cleanup reads finished rows), and all domain evidence (image attempts, AI
evaluations, Run history, audit) stay.

A kind's `maxQueued` is a watchdog bound, not an admission gate: the watchdog
raises `over_capacity` past it, and producers pace themselves (see Producers).

## Producers

A producer must not enqueue faster than the drain can serve. One unbounded
connection-discovery pass once enqueued an evaluation for every household
record (~55k), which starved every other kind for days.

- Routine connection discovery (`discovery.connections`) holds its cursor while
  `CONNECTION_DISCOVERY_PENDING_CAP` connection evaluations wait (`rate_limit`),
  walks the newest records first, and never appends to a stopped Run. A changed
  record's new evaluation cancels its older queued one. Cancelled work whose Run
  failed with `failureCode = "superseded"` (a cleared backlog, not a member's
  decision) is re-admitted at that pace; a member's cancel stays final.
- Publication correction work is one `assessment.correction` Job per
  publication commit (`targetAssessmentIds`), not one per assessment; sources are
  still resolved after commit under serializable isolation.
- `run.funding-resume` is one Job per funding window; its handler resumes every
  paused Run.

## Planned: batch evaluation

Measured on 2026-10-25: one entity-connections evaluation page took ~4.7 s and
each backlogged kind drained ~140 Jobs/h, while the Jev decision model allows
80 requests/s and batches many records per request. The planned redesign runs
many records per claim, executes them concurrently, packs decision calls into
Jev batch requests, and decouples product identity from per-record `ai_suggest`
Runs. Until then the producer caps above keep evaluation backlogs bounded.

## Apple version gate

Device work stops when the server refuses an older build's writes (HTTP 426):
the worker stops pulling and shows "Update required to process images". Raise
the minimum only for unsafe writes; see
[breaking changes](agents/domain-rules.md#breaking-changes).
