# AI prompt refresh

The [entity contract](../entities.md) owns refresh eligibility, history and
acceptance semantics. Refresh is always enabled; the existing
Gateway Durable Object detects its own compiled feature policy. Gateway coordination
applies to production paid inference independently.

## Rollout

1. One migration owner applies the additive AiEvaluation/provenance/receipt
   expansion using the [production migration procedure](production-migrations.md)
   before merge, then verifies retained household data and `db:check
   --against-production`. Legacy nullable provenance stays unknown; no historical
   row or applied value is backfilled with a guessed version.
2. Use `cubby` for live tools, integration development and production; verify
   provider routes/managed credentials before rollout. Environment metadata
   retains attribution; subscription calls retain their existing transport. Cloudflare's
   [200 requests/60 seconds/gateway limit](https://developers.cloudflare.com/ai-gateway/reference/limits/)
   concerns Unified Billing managed credentials, not BYOK. The production
   coordinator conservatively admits 180 starts/60 seconds and four streams;
   refresh's two-target cap reserves room for interactive traffic.
3. Verify local/development work with synthetic repository examples before
   household activation: run `pnpm --dir apps/web eval:mail-prompts` through the
   shared Gateway, plus the durable refresh regressions for affected features,
   legacy work, repeated activation, no-proposal completion and member decisions
   during inference. No live source belongs in repository fixtures, reports or
   PR text.
4. Requests and nightly
   maintenance nudge the production Gateway singleton. It checks its own
   deployment version in Durable Object storage before opening Neon once to
   compare the exact compiled feature manifest.
   A monotonically increasing Durable Object ownership epoch fences delayed
   old instances transactionally, including rollback. A changed policy atomically
   updates generations and creates one discovery Run;
   repeated nudges and interrupted handoffs reuse it. Code-only releases do not
   create another Run. Rollback compares exact policies, including older versions.
   No activation endpoint, credential or post-deploy action is required.

## Database pool diagnosis

An idle Postgres server can still have no Hyperdrive origin slots: open and
lock-waiting transactions each pin an origin connection. Inspect transaction
age, `pg_blocking_pids` and singleton/advisory lock holders before increasing
Postgres capacity. Product catalog size must not extend a publication
transaction across per-pair snapshots. The [entity contract](../entities.md)
owns the preparation, attempt/Run/activation fences and partial-catalog retry
semantics. Cancellation batches requester updates and live-demand checks while
holding AI admission; it must not issue per-item queries under that global lock.

## Observe and recover

AiEvaluation is the durable per-target ledger: target/snapshot, dependency
stamps, unique work key, attempt token/Run epoch, deadlines, saved results,
outcome receipt and scrubbed error. Run progress reports completed, blocked and
failed counts. AiUsage/EmailClassificationObservation and Suggestion receipts
retain inference and actual business-write provenance.

Discovery advances durable cursors through at most 200 field targets and 400
eligible Emails per invocation; Email execution rosters still cap at 200.
Ordinary refresh execution has two active Run slots across the household,
including funding/auth pauses and connection Sweep children. Discovery is a
separate activation Run; a Sweep's connection child retains its explicit parent
while consuming the same admission capacity. Product, field and on-demand connection targets share a running
non-Email Run for their actor and activation revision. New policy work waits
for capacity rather than joining an older policy owner. Frozen Email rosters retain their mailbox and
200-item boundary. A short scheduling transaction uses a nonblocking advisory
lock to serialize slot checks, new Run creation and failed-Run readmission;
contention defers rather than holding another origin connection in a lock wait.
The two-target inference cap remains independent of these Run slots.
Cancelling a shared Run stops every Product, field and connection target joined
to that owner. Inspect its roster before cancelling; same-fingerprint work stays
stopped until explicit member retry.
If both slots are paused for authentication, ordinary refresh work waits until
the member resolves authentication, resumes or cancels an owner. Cancelling a
Sweep child also stops its parent roster step rather than reviving that child.

When slots are full, discovery retains the affected stream's cursor and waits
30 seconds in its existing Workflow before trying again. Capacity waits do not
consume deployment-policy waits or inference retries. Unchanged, already queued,
failed or cancelled work creates no empty Run. An on-demand connection request
that cannot obtain capacity reports the capacity diagnostic; scheduling-lock
contention reports a separate short-retry diagnostic. Rediscovery returns an
existing recoverable failed or dispatch-failed owner for relaunch, reporting
admission refusal while preserving its automatic recovery budget. Cancelled, exhausted or paused
owners report their retained status and diagnostic instead of silently returning
no work.
Ordinary entity writes capture dirty roots and wake the generic background
refresh framework. Connection discovery and admission happen in the resulting
background Sweep; see the [derived-data contract](../entities.md#background-derived-data).
Scheduling requires an actor without an inherited Run: a Run-scoped actor cannot
create an independent owner or advance its successor key through `ensureRun`.
A new policy resets the scan cursor and its discovery Workflow checkpoints
bounded pages until both independent streams finish. Cursor writes are fenced
by activation revision, so an old page cannot overwrite a newer reset. During
deploy overlap a discovery page whose Worker policy differs from the activation
sleeps and retries (up to 30 minutes) instead of failing the Run.
There is no frequent polling cron. Request nudges stay in Durable Object storage
when the deployment version is already observed. The nightly cron is the idle
reconciliation exception. An alarm verifies and retries an interrupted startup handoff; external
activation does not block interactive Gateway admission.
The Workflow's preliminary Run guard selects only its identity under the running
status and attempt predicate, omitting retained input and progress-history payloads. Callers that
need the Run data keep the full read under the same status/attempt fence.
Statement Transaction suggestion labels are not AiEvaluation targets: the
background queue labels pending rule suggestions in pages of 100 once the
deployment's AI refresh activation exists. A page builds its charges in one
batch, labels and publishes four at a time, then applies automatic rules one
charge at a time; a rule that applied rebuilds the page's other charges and
relabels any whose evidence moved. Unlabelled suggestions stay
reviewable. A high-confidence same-charge label makes a single exact-amount
attach bulk-acceptable, and every create waits for its kind and counterparty
labels (one vote beside the category rule and merchant history); a label
itself applies nothing.
Workflows own inference deadlines and retries. Nightly maintenance and existing
app-open recovery reconcile stranded Runs and relevant evidence/option changes.
The singleton uses its own compiled manifest, never a caller-supplied version;
a request from an old Worker cannot reinstall that Worker's policy. Saved field results resume
without another inference. Missing evidence, Mail import switched off and
genuine ambiguity wait for a relevant fingerprint change. Rediscovery reopens a
blocked or obsolete target at most three times: a replacement row
(`<workKey>:reopen:<n>`) joins a running Run, while the settled row keeps its
Run, receipt and error and links the replacement through `retryEvaluationId`.
Switching Mail import on therefore resumes the blocked Emails. Admission waits defer without consuming inference retries.
Cancelled Runs remain stopped, including their blocked/obsolete evaluations:
rediscovery cannot replay the same fingerprint in a successor Run. A changed
fingerprint is new work; an explicit member Run retry is still supported.
Exhausted failures require Run retry; replacement
evaluations retain the earlier failed rows and link their receipts.

Already applied values and immutable history survive rollback. Do not delete
the additive ledger/receipt columns during rollback.
A failed startup handoff retains its alarm and retries the same discovery Run;
nightly reconciliation is the additional backstop. Preserve the Gateway
namespace and its storage during changes. If stored ownership falls behind
PostgreSQL, the current object reports the fence and schedules a retry above
the recorded epoch instead of acknowledging a stale observation. Input-only changes can wait
until app-open recovery or nightly maintenance; they do not require idle database
polling.

Use existing Run cancel/retry controls for individual failures; investigate the
ledger and Run diagnostics before replaying exhausted work. Gateway leases and
rolling starts survive DO restarts; cancelled/finished streams release capacity,
and abandoned requests expire after the bounded deadline.

Discovery isolates preparation and launch failures per target or Run, emits a
scrubbed diagnostic, and advances its bounded cursor; the next cursor pass retries
preparation. Recovery first launches unstarted Runs that already hold slots,
then considers failed and dispatch-failed Runs oldest first, within its ten-Run budget;
exhausted automatic-recovery budgets and member cancellations are excluded before
the limit, so they cannot starve relaunches. Recovery uses the same two ordinary
execution slots as new discovery. Existing unfinished Runs launch
before new discovery. Workflow target
steps retry infrastructure failures twice with exponential backoff; an exhausted
instance records a failed Run for recovery. Nightly and app-open recovery also
reconcile instances quiet for 30 minutes. Imported or historical Email sources
retain the existing classification-refresh deferral and report a blocked outcome.

## Recover an existing Run pileup

Deploy the scheduling fix before clearing an accumulated backlog. The new slot
limit prevents additional ordinary owners; it does not merge or cancel existing
Runs, move evaluations, or rewrite retained receipts. Existing active owners
above the limit can finish; failed owners wait for capacity.
Previously failed owners are recovered before new discovery as slots become
available. A retained legacy failed backlog can therefore delay new work until
it drains or the member approves including it in the stop set.

A data correction requires the member's explicit approval and a transactional
script outside the repository. First inspect aggregate Run purpose/status,
activation revision, attempts and evaluation states in `BEGIN READ ONLY`.
Distinguish previously failed work from member-cancelled work; an old start time
alone does not establish that a cancellation was reversed. Database timestamps
are UTC wall-clock `timestamp without time zone`; select them as text or bind
UTC ISO text cast to `timestamp` so the driver's local timezone cannot shift a
cutoff.

Proposed cleanup: choose an explicit UTC cutoff and the ordinary refresh owners
to stop, excluding the current discovery Run, explicit Sweep children and member
work outside this scope. Under the AI-admission lock, mark selected active Runs
`failed` / `user_cancelled`, set `endedAt` and the cancellation diagnostic, and
cancel their pending evaluations in a batch, mirroring Run control. Preserve
settled rows, saved results, receipts and links. Include previously failed
ordinary Runs with pending work in the approved stop set if they must not be
readmitted; cancelling only currently running Runs leaves those recovery
candidates eligible. Recheck the exact selected statuses/attempts and pending
counts before committing, then read back cancellation invariants.

After the database commit, terminate the exact selected Workflow instances,
including still-live previously cancelled instances, as Run control does. This
retires pinned older code instead of relying on it to adopt the new launch
fence. Guarded instances also stop at their next cancellation check; in-flight
publication remains fenced. Include termination in the explicit approval and
verify instance states without deleting Workflow history or evaluation ledgers. After cancellation,
new fingerprints can join the bounded owners. Retrying the same cancelled
fingerprints is a separate deliberate member action; retry only the chosen Run
after capacity is available. Verify post-deploy creation, cancellation stability,
recovery budgets and pool occupancy before starting another large Sweep.
