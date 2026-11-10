# AI prompt refresh

The [entity contract](../entities.md) owns refresh eligibility, history and
acceptance semantics. Refresh is always enabled: the hourly cron activates the
current compiled feature policy through a Job. Gateway coordination applies to
production paid inference independently.

## Activation and verification

- Use `cubby` for live tools, integration development and production. Environment
  metadata retains attribution; subscription calls retain their existing
  transport. Cloudflare's
  [200 requests/60 seconds/gateway limit](https://developers.cloudflare.com/ai-gateway/reference/limits/)
  concerns Unified Billing managed credentials, not BYOK. The production
  coordinator conservatively admits 180 starts/60 seconds; refresh's two-target
  cap reserves room for interactive traffic.
- Verify prompt changes with synthetic repository examples before they reach
  household data: run `pnpm --dir apps/web eval:mail-prompts` through the shared
  Gateway, plus the durable refresh regressions for affected features. No live
  source belongs in repository fixtures, reports or PR text.
- The hourly cron activates once per deployment version under a transactionally
  recorded occurrence. The gateway DO supplies its running version; a stale
  publisher cannot replace a later occurrence, and a rollback A → B → A gets a
  new occurrence. Policy fingerprints preserve existing feature generations when
  unchanged. No request nudge, observation alarm, activation endpoint or
  post-deploy action is required.

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

There is no discovery pass for AI refresh. Field evaluations come from
saved-record questions and Sweeps.
Ordinary refresh execution has two active Run slots across the household,
including funding/auth pauses. A short scheduling transaction uses a nonblocking
advisory lock to serialize slot checks, new Run creation and failed-Run
readmission; contention defers rather than holding another origin connection in
a lock wait. The two-target inference cap remains independent of these Run
slots. Cancelling a shared Run stops every target joined to that owner; inspect
its roster before cancelling, since same-fingerprint work stays stopped until
explicit member retry. If both slots are paused for authentication, ordinary
refresh work waits until the member resolves authentication, resumes or cancels
an owner. Cancelling a Sweep stops the evaluations it owns or requested.
Scheduling requires an actor without an inherited Run: a Run-scoped actor cannot
create an independent owner or advance its successor key through `ensureRun`.
A new policy obsoletes work stamped with the old one. During deploy overlap a
page whose Worker policy differs from the activation sleeps and retries (up to
30 minutes) instead of failing the Run.
The hourly cron and app-open catch-up inspect durable Jobs. Failed startup
activation uses Job retries; exhausted failures remain stopped for explicit
retry. Activation does not block interactive Gateway admission.
The Run executor's preliminary guard selects only its identity under the running
status and attempt predicate, omitting retained input and progress-history payloads. Callers that
need the Run data keep the full read under the same status/attempt fence.
Statement Transaction suggestion labels are not AiEvaluation targets: the
background queue labels pending rule suggestions in pages of 32 once the
deployment's AI refresh activation exists. A page builds its charges in one
batch, batches identity questions, prepares spending in waves of eight and
publishes with at most four database transactions, then applies automatic rules one
charge at a time; a rule that applied rebuilds the page's other charges and
relabels any whose evidence moved. Unlabelled suggestions stay
reviewable. A high-confidence same-charge label makes a single exact-amount
attach bulk-acceptable, and every create waits for its kind and counterparty
labels (one vote beside the category rule and merchant history); a label
itself applies nothing.
A stopped Sweep needs explicit same-Run retry after inspecting retained state;
deployment does not retry it. Job logs include phase durations
for statement decisions and spending, the current phase on lease renewal, and
refused versus failed renewal diagnostics. These logs establish execution timing,
not database wait attribution or proof of useful progress.

Jobs own execution retries; inference retains its bounded request deadlines. Nightly maintenance and existing
app-open recovery reconcile stranded Runs and relevant evidence/option changes.
The activation Job uses the current compiled manifest under its deployment
occurrence fence; a request from an old Worker cannot reinstall its policy. Saved field results resume
without another inference. Missing evidence, Mail import switched off and
genuine ambiguity wait for a relevant fingerprint change. Admission waits defer
without consuming inference retries. Cancelled Runs remain stopped, including
their blocked and obsolete evaluations. A changed fingerprint is new work; an
explicit member Run retry is still supported. Exhausted failures require Run
retry.

Already applied values and immutable history survive rollback. Startup activation is retained in a Job and guarded by the observed deployment
occurrence. Preserve provider admission and coordinator namespaces and their
stored receipts. Background source changes record Job intent and converge
through the same drain; no deployment-observation alarm repairs that work.

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
execution slots as Email refresh. Field and Product refresh have no Run and hold no
slot: a discovery page defers while 1,000 automatic evaluations are owed. Workflow target
steps retry infrastructure failures twice with exponential backoff; an exhausted
instance records a failed Run for recovery. Nightly and app-open recovery also
reconcile instances quiet for 30 minutes. Imported or historical Email sources
retain the existing classification-refresh deferral and report a blocked outcome.

## Recover a Run pileup

The slot limit prevents additional ordinary owners; it does not merge or cancel
existing Runs, move evaluations or rewrite retained receipts. Failed owners are
recovered before new work as slots become available, so a retained failed
backlog can delay new work until it drains or the member approves including it
in the stop set.

A data correction requires the member's explicit approval and a transactional
script outside the repository. First inspect aggregate Run purpose/status,
activation revision, attempts and evaluation states in `BEGIN READ ONLY`.
Distinguish previously failed work from member-cancelled work; an old start time
alone does not establish that a cancellation was reversed. Database timestamps
are UTC wall-clock `timestamp without time zone`; select them as text or bind
UTC ISO text cast to `timestamp` so the driver's local timezone cannot shift a
cutoff.

Proposed cleanup: choose an explicit UTC cutoff and the ordinary refresh owners
to stop, excluding Sweeps and member
work outside this scope. Under the AI-admission lock, mark selected active Runs
`failed` / `user_cancelled`, set `endedAt` and the cancellation diagnostic, and
cancel their pending evaluations in a batch, mirroring Run control. Preserve
settled rows, saved results, receipts and links. Include previously failed
ordinary Runs with pending work in the approved stop set if they must not be
readmitted; cancelling only currently running Runs leaves those recovery
candidates eligible. Recheck the exact selected statuses/attempts and pending
counts before committing, then read back cancellation invariants.

After the database commit, terminate the exact selected Workflow instances,
including still-live previously cancelled instances, as Run control does.
Guarded instances also stop at their next cancellation check; in-flight
publication remains fenced. Include termination in the explicit approval and
verify instance states without deleting Workflow history or evaluation ledgers. After cancellation,
new fingerprints can join the bounded owners. Retrying the same cancelled
fingerprints is a separate deliberate member action; retry only the chosen Run
after capacity is available. Verify post-deploy creation, cancellation stability,
recovery budgets and pool occupancy before starting another large Sweep.
