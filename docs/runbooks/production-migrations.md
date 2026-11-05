# Production migrations

The GitHub production deployment applies pending committed migrations before
deploying the already-built Worker. A migration failure stops deployment. The
runner uses only `PRODUCTION_DIRECT_DATABASE_URL` for production; it never
falls back to `DATABASE_URL`. Default to one preserving migration followed by the
matching Worker deploy. Old requests and Job attempts may fail; compatibility
rollouts, timed retirement waits and feature-specific release procedures are not
the default. There is no daily whole-population consistency pass. A newly declared target
enrolls only records missing its publication, using its declared source and
publication owner in the migration. Existing publications and tickets stay
intact; a changed rule does not re-enroll the entire population. Use an explicit
scoped repair when a demonstrated defect requires recomputation. Temporary stale
quality badges do not justify a staged cutover.
Preserve source data, money and member decisions, verify with synthetic predecessor
data before merge, then read back production data and schema after release. See the
[domain rules](../agents/domain-rules.md#production-changes) for preservation
requirements and [CI](../ci.md#deployment) for workflow execution and retries.
Do not run production migrations by hand while a Deploy run is queued or
running; Actions serialization does not cover operator shells.

## Historical investigation

For Neon snapshot readback, pass `finalize: false` explicitly to
`restore_snapshot`, omit `target_branch_id`, and use a separate endpoint on the
returned branch. `finalize: true` can replace the source branch's production
endpoint and default designation even when the restore creates a new branch;
it is a production cutover, not an isolated copy. Before querying, verify both
branch IDs and endpoint assignments: the production hostname and default branch
must still point to the original production branch. Retain any unexpected
branch writes for reconciliation before removing an investigation branch.

## Staged and breaking cutovers

One exclusive operator owns a staged cutover, including Actions and local
applications. Before merging a journal containing an unsafe contraction, set
the `cloudflare` GitHub Environment variable `PRODUCTION_MIGRATION_THROUGH` to
the exact last compatible migration tag. Actions passes this inclusive boundary
to the existing runner, then deploys the matching code. Leave it set until the
operator applies and verifies the contraction after deployment; then delete the
variable before the next release. A boundary behind the applied database fails
closed. If no new migration is safe before deploy, use the last already-applied
tag. Never guess compatibility from a migration's name or SQL keywords.
From setting the boundary or applying an unmerged expansion until the staged
PR merges, admit no other `main` merge or Deploy retry: that revision lacks the
new journal tag and fails closed. Merge the staged PR next.

For a breaking cutover that cannot use this sequence, establish its documented
writer barrier and apply the authorized migrations manually before merge; the
deployment runner will verify that applied prefix. Keep the barrier until the
matching deployment and preservation readback succeed. No other release or
operator may overlap this cutover.

For authorized household deployments, use a non-graceful cutover with writers
enabled by default. No writer hold or maintenance window is required. The normal
Actions migration-before-deploy sequence may apply the preserving contraction
before the matching Worker deploys. Old requests and
Workflow attempts may fail during or after that cutover. Lock every retired
copy source and destination against writes before reading them, hold those
locks through the copy/drop commit, and refuse contraction unless all retained
content has a verified destination. Verify preservation and deployment after
release; do not overlap a manual schema application with Actions.

For an expand/contract rollout, choose the exact last expand tag from
`apps/web/drizzle/meta/_journal.json`, excluding the contract migration. Set
`PRODUCTION_MIGRATION_THROUGH` to that tag before merge, then let Actions apply
the expansion and deploy. To apply the same expansion manually before merge,
first ensure no Deploy run can overlap, then run:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=EXACT_LAST_EXPAND_TAG
```

Replace the placeholder with the complete journal tag, without `.sql`.
`--through` is inclusive: every pending predecessor runs, and no later entry
runs. Unknown tags, non-prefix or changed-hash bookkeeping, and unordered
journals refuse before any database write. A database already beyond the
requested tag also refuses without mutation; this command never rolls back
applied migrations. The runner has no dry-run mode.

Verify the applied bookkeeping ends at the expand boundary and read back the
preserved data. If expansion was manual, keep the environment boundary set
while merging and deploying the code that stops reading or writing the retired
shape. Only after that deployment finishes, apply through the chosen contract tag:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=EXACT_LAST_CONTRACT_TAG
```

Read back the transformed data and schema again, then delete the environment
boundary. A boundary does not identify
which SQL is compatible with the deployed code; the owner must review that
boundary before execution. Omitting `--through` retains the usual behavior of
applying every pending journal entry and is unsuitable for a staged rollout
whose journal already contains an undeployed contract.

## Mail decision owners (0074)

`0074_mail_decision_owners` moves `email_link`, `email_relevance`,
`mail_import_outcome` and `run_finding` out of the Assessment ledgers. It runs in
one transaction with `lock_timeout` 10s per lock. It first takes the
`email-evidence-write` gate, then locks, in order: Run, LedgerParty, OrderMail,
OrderMailEvent, Email, EmailClassificationObservation (ACCESS EXCLUSIVE, for its
new columns), RunOperation, Assessment, AssessmentState, Feedback. Those are held
through commit and block their writers; only the observation table also blocks
reads. Each LOCK is a separate acquisition, and deployed mail writers touch
Assessment and Email in both orders, so a deadlock or timeout is possible. The
runner makes up to six attempts on `40P01` and `55P03`, 15 seconds apart; each
attempt rolls back whole, including other pending migrations in that transaction.
Any other error, or a sixth failure, stops the Deploy with this migration unapplied. Use the normal Actions
migration-before-deploy sequence: no environment boundary, writer hold or waiting
period. Production duration at 2 CU is unmeasured.

It creates `EmailPurchaseDecision`, `EmailReview` and `RunFinding`, keeping old
ids, and adds `mailOutcome` to each outcome's `target_outcome` receipt plus
`application` and `publication` to EmailClassificationObservation. An outcome pairs
with the receipt its settling transaction wrote: same Run, Email, checksum and
transaction timestamp. No match or two matches abort. Pending `email_relevance`
State rows carry no member input and do not migrate. Those updates disable the two
derived capture triggers, so they enroll nothing. It compares row-hash multisets
for every copied review, decisions, Emails with an accepted association, member
labels, current member classification, protecting events per Email, findings,
finding resolutions with payloads, outcomes with their operation, and prediction
application, and raises on any difference. Every Feedback row of the four families
must be copied or fall in a named category, or the migration aborts: projection
events, independent `email_accuracy` grades and prediction routing receipts stay
in the ledger.

The unknown-authority `legacy-decision` link apply events (750 on 2026-11-05) are
not proven to be member decisions. Their current values and `unknown` authority
are copied to `EmailPurchaseDecision`; the events are excluded from `EmailReview`,
stay in Feedback for the later archive, and must never be discarded.

Ledger rows stay untouched; a later migration archives them. New triggers refuse
new Assessment, State and Feedback rows in these families, so a stale Worker's
write fails instead of committing where nothing reads it. A stale read of
`AssessmentEmailLink` also fails until the matching Worker serves.

After release, read back the row counts below. A difference from the pre-release
source aggregate is a blocker: the migration should already have refused it.

```sql
SELECT count(*), count(*) FILTER (WHERE active) FROM "EmailPurchaseDecision";
SELECT authority, verdict, count(*) FROM "EmailReview" GROUP BY 1, 2;
SELECT status, count(*) FROM "RunFinding" GROUP BY 1;
SELECT count(*) FROM "RunOperation" WHERE (result->'mailOutcome') IS NOT NULL;
SELECT application, count(*) FROM "EmailClassificationObservation" GROUP BY 1;
```

The synthetic predecessor fixture is
`apps/web/tooling/mail-decision-owners-migration.integration.test.ts`.

## Assessment read publication storage (0072)

`0072_assessment_read_publications` adds four tables: revisioned publication
results, exact memberships, reverse dependencies and a small recovery stage.
Active and staged results share the publication relation; an explicit empty
result differs from an Assessment with no active publication. The stage retains
unfinished old scopes independently of WorkItem cancellation, using the existing
drain's ticket and lease for execution authority. It adds no scheduler or queue.
The migration also adds a nullable `WorkItem.fanoutAfter` cursor.
Existing unfinished work starts without a cursor; tickets, attempts, deadlines,
waits and retained errors are unchanged. The updated `derived_mark` clears the
cursor when a new source ticket is captured. No existing rows are rewritten or
removed. The migration installs the Assessment source captures and enrolls the
served/open publication population at reconciliation priority. Initial enrollment
keeps any existing target ticket, attempts, deadline, wait and error intact.
It never fabricates a successful empty result. Missing publications remain an
explicit coverage gap until the existing drain publishes them.

Use the normal Actions migration-before-deploy sequence for this direct cutover.
Downtime and failed predecessor requests are acceptable; no environment boundary,
writer hold or timed waiting period is required. After the matching Worker is
serving, re-enroll the open Assessment population through the existing target
reconciliation with `existing: "keep"`. This recovers initial marks a predecessor
drain may have consumed without resetting surviving tickets, attempts or waits.
Verify source-data and unfinished-work preservation and initial coverage
convergence through committed publications, including explicit empty results,
rather than merely observing an empty queue.

The same transaction builds `AssessmentState_active_suppression_idx` over
`(entity, recordId)` for active rows with non-null suppression. It may wait for
writers and blocks State writes until commit. Keep serialized migration ownership,
and verify the index is ready and valid after release. The seeded predecessor
journey checks retained Assessments, Feedback, State, Jobs and WorkItems, long
membership tokens, and cursor reset through the actual mark function.

## Assessment endpoint indexes (0065)

`0065_assessment_connection_reference_indexes` adds two partial expression
indexes over the immutable connection source and target. It changes no rows,
stored evidence, Feedback, queues or app state. The normal migration-before-deploy
sequence builds them before the indexed scoped reads ship. This ordinary migration
runs both non-concurrent index builds in one transaction. Each build reads the
retained connection evidence. It can wait behind an existing writer, then blocks
Assessment writes until both builds commit. The runner sets no lock or statement
timeout for this migration; its two-second lock timeout applies only to opted-in
transaction-per-statement migrations. Keep single-operator ownership. A failed
build rolls back both indexes atomically and must stop deployment without
bypassing bookkeeping.

After deployment, verify both `Assessment_connection_source_ref_idx` and
`Assessment_connection_target_ref_idx` are ready and valid in `pg_index`. Verify
normal scoped Suggestions/Automatic Decisions and record counts, then correlate
their database I/O and transaction-start, backlog and session-lookup behavior
with Worker/Hyperdrive evidence. Quiet Sentry groups alone do not establish
recovery. Preserve the independent native and retained-work acceptance checks.

## Assessment settlement source index (0068)

`0068_assessment_settlement_source_index` adds
`Assessment_served_source_ref_idx`, a partial B-tree over hashes of the two
immutable Statement source-reference text paths. Only served rows with both
extracted values present enter the index. There is no immutable-family filter;
current State family still owns admission. Readers recheck both exact text
values, so hash equality never replaces source identity. Bounded index keys also
allow unrestricted historical text without dropping or truncating stored values.

The ordinary migration-before-deploy sequence builds this index in one
transaction. It reads retained judgments and can wait for writers, then block
Assessment writes until commit. Keep exclusive migration ownership; do not run
manual DDL alongside Actions. A failure must roll back and stop deployment.
The migration rewrites no household rows, Feedback, publications or durable work.

After deployment, verify the index is ready and valid, and that scoped settlement
discovery uses both hash keys in index conditions with exact-text rechecks.
Compare complete identities and both family values, verify ordinary counts and
history, and read back retained work and paused Jobs. Measure full request
latency separately from the database plan; index-build success alone does not
establish the badge target or lower-compute suitability.

## Explicit WorkItem waits (0069)

`0069_work_item_coverage_waits` appends nullable `waitCause` and
`waitStartedAt` columns, requires both or neither, and replaces `derived_mark`
so a fresh source ticket clears the wait. Existing tickets, attempts, errors,
source evidence and paused Jobs are retained; no backfill or replay occurs.
The existing `readyAt` column remains the retry deadline.

Apply through the normal serialized migration-before-deploy workflow. The
ALTER TABLE and function replacement can briefly block writers. After release,
verify both columns and the CHECK constraint, retained unfinished work, and
that a fresh mark clears the wait. Pending search coverage must appear as
waiting rather than as an active failure even when an earlier error is retained.
Fixed candidate-budget failures remain bounded failures. Historical failed
evaluations are not reopened by this migration.

## Image-description capture scope (0070)

`0070_image_description_capture_scope` replaces only the Feedback and
AssessmentState capture functions. Image search depends on image-description
State and automatic system correction-history receipts; unrelated writes no
longer enqueue those image-description dependencies. OLD and NEW row filters
retain capture when a relevant row enters or leaves that scope.

Apply through the normal serialized migration-before-deploy workflow. Function
replacement can briefly block writers. Input positions, paths, target names,
and stored rows do not change. Retain existing fanout and direct tickets,
including backoff and explicit waits, and let the existing drain settle them.
Do not delete or re-ticket the backlog. After deployment, verify the two
function definitions, continued image-correction search refreshes, retained
unfinished work, and convergence of the pre-existing backlog separately from
new-mark production.

## Existing connection membership indexes

`AssessmentState_active_value_status_idx` indexes status and the hash of the
suggested text on active States. `Assessment_served_other_id_idx` indexes the
hash of present other-ID text on served publications. They narrow existing
field and Product-pair discovery before the shared identity CTE hydrates
evidence. Exact text remains an authoritative recheck; hashes never establish
membership. Bounded keys preserve arbitrary long historical values.

The ordinary migration-before-deploy workflow builds both indexes transactionally.
It reads retained State values and publication subjects and can block writes to
those tables until commit. Keep one migration owner and do not overlap manual
DDL with Actions. No publications, Feedback, member decisions or durable work
are rewritten or discarded.

Verify both catalog entries are ready and valid, confirm custom and generic
plans use the matching index conditions, and compare complete result identities,
ordering and both family authorities. Read back paused Jobs and retained work.
Measure the full request independently; removing these scans alone does not
establish the 500 ms badge goal or lower-compute suitability.

## Source-order fanout capture

Migration `0061_source_order_purchase_fanout` stops new
`email.relationshipFacts@8` captures and starts input 9 with the source row's old
and new Purchase references. Input 8 remains declared so retained SourceOrder-ID
tickets keep their broad expansion. Neither migration nor cutover clears or
reinterprets queue work or publications.

The preceding Worker does not recognize input 9 and can settle that unknown work.
Before merging this migration, set the `cloudflare` Environment's
`PRODUCTION_MIGRATION_THROUGH` to `0060_precise_location_fanout`. One operator owns
the cutover; admit no other main merge, Deploy retry or manual schema application
until it completes. Let Actions deploy the compatible Worker with the previous
trigger still capturing input 8. Verify its successful Deploy, full source SHA,
the authoritative Cloudflare deployment assigning 100% to that one version and
the live Worker version. Keep the migration boundary in place.

Retire incompatible consumers before activating the new trigger. Audit the final
source: production `drainDueJobs`/`advanceJob` roots must remain Queue delivery and
Cron recovery; HTTP app-open only enqueues work. Both roots have a
[15-minute invocation wall limit](https://developers.cloudflare.com/queues/platform/limits/).
After the compatible deployment completes its full traffic cutover, require at
least 16 minutes with no intervening deployment, rollback, version override or
externally started legacy consumer. Record the deployment and live version
throughout this bounded observation. Waiting one Job lease period does not prove
retirement: old consumers can renew their leases.

After that interval, inspect `derived:drain` under its Job-row lock. Release its
exact current running token/generation through `releaseJobClaim` in a one-off
operator transaction unless compatible-version ownership is positively
established. A claim timestamp after cutover does not establish compatibility:
an old invocation can acquire and renew another claim before its wall limit.
The existing token fence serializes release with any delayed publication
transaction. Preserve attempts, cursor, result and all WorkItems; use neither
cancellation/retry nor a bulk requeue. Record the release or positive ownership
evidence, including a non-running Job with no live claim. Keep private claim
evidence and the temporary operator script outside committed files. New
compatible claims may continue normally.

With the boundary and exclusive operator ownership still in place, verify no
Deploy is queued or running, then apply the committed migration:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=0061_source_order_purchase_fanout
```

Read back the exact trigger/catalog, retained work and publications, and a
synthetic supported save's input-9 Purchase capture. Remove
`PRODUCTION_MIGRATION_THROUGH` only after verification. If retirement or any other
gate cannot be established, leave the old trigger active and the boundary set;
do not enable input 9. A rollback after activation must retain support for input 9.

## Source-claim fanout capture

Migration `0062_source_claim_family_fanout` stops new
`email.relationshipFacts@7` captures and starts inputs 10 and 11 with the changed
Claim ID and its old/new canonical parent IDs. Input 7 keeps its broad expansion
for retained Claim-ID tickets; input 9's Purchase capture and other Claim consumers
remain unchanged. The migration replaces only `derived_mark_importsourceclaim`;
it neither rewrites publications nor clears or reinterprets queue work.

The preceding Worker can settle unknown inputs 10 and 11. Before merging, set
the `cloudflare` Environment's `PRODUCTION_MIGRATION_THROUGH` to exactly
`0061_source_order_purchase_fanout`. Use the exclusive operator, deployment,
consumer-root audit, at-least-16-minute full-cutover observation and exact-current
Job-claim fencing procedure above. Establish that evidence for this cutover;
the earlier source-order observation is not evidence that these preceding
consumers have retired. Keep the old Claim trigger active until every gate holds.
Claim acquisition time never establishes executing-version compatibility.

After compatible code serves 100% and retirement plus claim fencing is recorded,
verify no Deploy is queued or running, then apply the committed migration:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=0062_source_claim_family_fanout
```

Read back its exact migration hash and trigger body, retained work/publications,
and a synthetic supported save's own-Claim and old/new-parent captures. Preserve
attempts, readiness, cursor and result; no cancellation, requeue or bulk lease
invalidation. Remove the boundary only after verification. Any rollback after
activation must recognize inputs 10 and 11.

## Coarse Job drains cutover

The coarse Job migrations follow `0046_remaining_derived_results` in the
journal; their filename prefixes are retained from the unmerged branch.
The rename and carry migrations fence evaluation, embedding, Job identity,
wake and WorkItem sources and destinations before copying or retiring work.
Their table locks remain held through the transaction. Old Worker requests
may fail until the matching deployment completes.

After deployment, verify the journal prefix, retained paid
evaluation results, pending work on the feature drains, and embedding cleanup
work before declaring the cutover complete. Do not reset the migration ledger
or overlap Actions with a manual migration.

Large identity retirements must check foreign-key indexes before applying SQL.
An index restricted to live rows cannot support checks against every referring
row. In particular, `SearchDocument`'s live-row identity index does not cover
tombstones. For a one-time populated cutover, the exclusive operator may create
a temporary full index on `SearchDocument ("entityId", "entityKind")` before
the retirement transaction. Verify the query plan and preserve the exact
committed migration SQL and ledger hashes. After the migration commits and
preservation readback passes, drop that support index and confirm the schema
matches the committed journal. Record creation, application, readback and
cleanup evidence; never overlap this operator sequence with an Actions deploy.

## Job entity identity backfill

`0036_job_entity_identity` uses the migration runner's explicit
`-- cubby:transaction-per-statement` opt-in. Ordinary migrations retain Drizzle's
transaction behavior. Every opted-in statement must be idempotent: committed
statements/batches can replay after a failure before the final journal receipt.
`-- cubby:repeat-batch` repeats a statement whose result is `{ remaining: boolean }`;
`-- cubby:outside-transaction` is reserved here for concurrent index creation/drop.
The same journal hash/prefix checks and deployment serialization still apply.
Each statement has a 2-second lock timeout, and the runner retries a statement that
hits a lock timeout or deadlock whole, about two minutes in all, then stops the
deployment. Everything committed so far must stay compatible with the running Worker,
because the next Deploy resumes from there. One statement can hold several commands
in one transaction, so a cutover's copy and retirement stay atomic.

`0043_activity_indexes` uses the same opt-ins for its DerivedValue and Job
indexes: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` runs outside a transaction.
These are index-only additions; ordinary writes and stored records survive.
`0044_evaluation_page_admission` adds a nullable admission token without changing
live per-target lease fences and backfills missing owning evaluation requests.
Settled evaluations retain their state and receipt even if the member later
cancelled the owning Run; only unfinished, receipt-less demand inherits that
stop. Existing request receipts survive replay. The migration neither resets
Jobs nor discards evaluation history.

The Job migration widens identity checks without scanning under an exclusive
lock, adds a nullable shortcode and a not-valid not-null check, and builds
indexes concurrently. The check immediately refuses new code-less Jobs, so old
Worker writes may fail during this preserving non-graceful cutover. No queued
work, capture, lease, cursor, result or diagnostic is discarded. Each backfill
transaction locks at most 1,000 Jobs, creates their identities and assigns their
codes, then commits. Colliding code candidates retry in another batch; an
existing conflicting identity refuses the migration. Execution fields and
original timestamps are unchanged. A partial index keeps successive batches
bounded. Final check/FK validation allows ordinary writes; SET NOT NULL reuses
the validated check, and the temporary index/check are removed. Transactional
DDL and batches use a two-second lock acquisition timeout, failing safely for
replay instead of waiting indefinitely behind a writer. Concurrent indexes run
outside transactions and may be rebuilt on replay.

For approximately 196,000 Jobs, budget 196 nonempty batch commits plus an empty
probe and the index/check steps. Rehearse against a seeded synthetic database
and a retained production copy to measure actual SQL and network time. A
planning allowance of a few minutes is appropriate; local timings are not a
production runtime guarantee. Do not overlap Actions or another migration
operator. Deploy matching code immediately after the migration; no writer hold
is required.

After deployment the retention pass reconciles orphan Job identities in bounded
batches: old retention could have deleted a backfilled Job before the new Worker
deployed. It repeats immediately while a full batch remains. Confirm this pass
finishes before verifying that no orphan Job identities remain.

After deployment, verify every Job has exactly its matching live `Entity` row
of kind `job`, codes match `JOB-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}`, no
unreferenced Job identities remain, and the pending-capture population and
execution payloads match the retained pre-deploy evidence. Verify enqueue
replay preserves the code, Job reads on web/Apple/MCP, Retry now with one selected
Job and with a filter, a new queue claim, and retention removing only eligible
Jobs and their identities atomically. Verify the temporary backfill index is
absent and both permanent identity constraints are validated. Report any checks
not performed; migration success alone is not deployment verification.

## Derived values cutover

### Publication evidence (0057)

`0057_publication_evidence` queues retained service Cost publications missing
their positive charge total and scalar Product/Inventory publications missing
private computation inputs. It leaves stored values, publication timestamps,
existing tickets, member-edit priority and retry state untouched. After deployment,
verify that pending refreshes retain their old Cost and that a completed refresh
publishes its charge total with the average and count. Verify scalar valuation,
quantity and USDA explanations use their captured inputs while ordinary list
responses omit that evidence. Legacy evidence remains
explicitly unavailable until that publication; opening a popover is never a repair.

It also installs the declared household diagnostic inputs, including constant
fixed-target fanout for nullable source references, and queues the live reserved
household Project without replacing any existing ticket. The predecessor drain
does not recognize that target and can discard its initial work. Use the existing
code-first sequence: before merge set the `cloudflare` environment's
`PRODUCTION_MIGRATION_THROUGH` to `0056_recipe_publication`, deploy the matching
code, and verify its release. With no Deploy queued/running, apply through
`0057_publication_evidence`, read back preservation and the new publication, then
remove the boundary before another release. No writer hold is needed. The
migration uses a two-second lock timeout and rolls back for replay on contention.

### Recipe publication identity (0056)

`0056_recipe_publication` adds a retained publication timestamp independently of
Recipe's null-as-stale nutrition marker. Known fresh timestamps are copied;
unknown legacy timestamps are never invented. Stored totals remain intact, and
active Recipes without a publication identity are marked through the existing
ticketed drain. The Recipe trigger ignores its own publication timestamp.
Search enrollment also ignores both publication/freshness timestamps, preserving
content invalidation without adding search work when only readiness changes.
Inventory ownership and Product stock-input evidence are backfilled through
reconciliation-priority work. Existing tickets, retry state and member-edit
priority remain intact. Product category ancestry/policy edits enqueue Product
read facts conservatively; the migration replaces that trigger function too.
After authorized deployment, verify retained totals, pending work, subsequent
publication, and strict stale-nutrition reads separately.

### Product facts and prefix index (0054)

0054 adds the WorkItem prefix index, Product fact/food invalidation and initial
work for every live Product. It preserves member assignments and retained
evidence. Its predecessor can discard unfamiliar derived targets, so this
authorized release uses the exclusive-operator cutover from the laptop before
merge; the general GitHub migration-before-deploy order remains unchanged.

Use the exact reviewed PR head with required CI green, rebased onto current
main. With no Deploy queued/running and no other main merge in flight, run
`pnpm --filter @cubby/web run deploy:cf` and verify the live Worker. Obtain a
direct connection with `neon connection-string --project-id purple-wildflower-50486824`
and pass it only as `PRODUCTION_DIRECT_DATABASE_URL` to
`pnpm --filter @cubby/web db:migrate --target=production --through=0054_work_item_prefix_and_product_facts`.
Read back schema, retained populations and successful `product.readFacts` /
`product.food` publication coverage. Valid null food publications count;
missing results do not. A zero backlog alone is insufficient.

Merge immediately without changing the deployed PR head. The merge-triggered
Deploy must find no pending migrations and redeploy identical code. Do not set
`PRODUCTION_MIGRATION_THROUGH` for this sequence. If main changes between laptop
deployment and merge, stop and report rather than rebasing the live release.

### Remaining result materialization (0046)

`0046_remaining_derived_results` installs declaration-generated invalidation
triggers and backfills disposable results for ownership, beneficiary seeds,
Project rollups, Shipment summaries and Email relationship facts. It does not
rewrite member assignments, financial facts or retained source evidence.

The predecessor Worker does not recognize the new target names and can discard
their dirty marks as retired work. For an authorized release, use the staged
procedure above with `PRODUCTION_MIGRATION_THROUGH` set to
`0045_field_envelope_decisions`: deploy the matching Worker first, then apply
through `0046_remaining_derived_results`, verify it and remove the boundary.
Do not overlap another merge, Deploy retry or manual application during that
sequence. No writer hold is required. Before 0046 the new fields truthfully show
missing results; after it the existing drain owns catch-up.

Read back the six target populations, retained assignment/evidence counts,
ready/error backlog and successful publications. Verify initial results reach
the canonical list and explanation interfaces without a member edit. A cleared
backlog alone is insufficient: compare live target populations with successful
published results so discarded or failed initial work cannot appear complete.
Record catch-up duration separately from ordinary-edit latency. These are release
instructions, not evidence that production application or readback occurred.

During the initial Email facts backfill, an eligible Email without facts can be
an unresolved candidate in several Purchase or Vendor sections. A large unresolved
count is not a large known-match count. Use the existing target backlog/error
diagnostics and unresolved-record access; do not hide those candidates or infer
an unlinked outcome merely because the facts have not published.

### Initial engine cutover (0037)

`0037_derived_values` (ADR 0021) runs as one ordinary transaction with a
30-second lock acquisition timeout and first takes `ACCESS EXCLUSIVE` on every
table it alters, drops, triggers or writes. A timeout or deadlock rolls the
whole migration back for replay. In production the running Worker's queue
traffic deadlocked against that lock statement on every attempt; the migration
was applied from an operator machine (`application_name=cubby-migrate-0037`)
while a sidecar terminated the backends in `pg_blocking_pids` of that
connection every 100 ms, which is acceptable under the non-graceful cutover.
Deploy afterwards finds the migration applied and only ships the Worker. It creates `DerivedValue`,
`DerivedDirty` and the `DerivedTicket` sequence; drops `EntityQuality` and
`EntityQualityCheck` (disposable, rebuilt by the drain); adds the generated
`AiEvaluation.slotKey`, cancels older duplicate open evaluations per slot
(moving each Run's outstanding request to the slot's survivor and waking that
Run) before the open-slot unique index; installs the mark function and one
trigger per source table; holds Job writers (`SHARE ROW EXCLUSIVE`) while it
deletes retired `refresh.family` Jobs with their identities and extends the
retired-kind check; then marks every stored value for backfill at propagation
priority. A pre-cutover Worker's `refresh.family` write fails the check rather
than landing as work nothing serves. Locally, about 270,000 backfill marks on a
synthetic 38,000-Product corpus took under three seconds; rehearse against a
retained production copy for real lock and SQL time.

Fields read empty or stale until the drain publishes them; catch-up creates the
`derived:drain` and `derived:reconcile` Jobs within a minute. Watch the backfill
drain to zero and record its duration.

After deployment, verify and report:

- Backlog: `WorkItem` ready rows for `derived:drain` reach zero; list failing targets
  (`attempts > 0`, `lastError`) and their age; no target stays deferred.
- Slots: one open (`queued`/`retry_wait`) evaluation per `slotKey`; running and
  result-ready evaluations retained; every uncancelled request on a cancelled
  duplicate moved to its survivor; affected Runs advanced.
- Jobs: no `refresh.family` Jobs or `refresh:*` captures/invalidations; every Job
  still has its matching `job` identity; the retired-kind check is validated.
- Data: waivers (`DataException`), member decisions, Assessments and source
  evidence are unchanged against retained pre-deploy counts; stale dots clear
  on web and Apple as the drain publishes.
- Replay one of each against production-safe synthetic records or read-back: a
  no-op save marks nothing; a reparent marks both endpoints; a save while a
  page publishes neither deadlocks nor waits; a rejected target backs off with
  its database message while others publish.
- Throughput: drain duration, pages, expansion ratio (dependent marks per
  fanout mark), publication latency, and the first reconcile bucket's drift.

Report any check not performed; migration success alone is not deployment
verification.

### Field-envelope decision cutover

`0045_field_envelope_decisions` takes `ACCESS EXCLUSIVE` on `DerivedDirty`,
`DerivedValue`, invalidation capture and the affected source tables together
with a 30-second lock timeout. It preserves retained cached values, sort columns,
timestamps, input hashes and original metadata. Non-price non-null legacy
snapshots receive typed outcome metadata; only recorded inherited,
default or computed provenance is translated. Unsupported historical ownership
stays unknown. Original metadata remains under `decidedBy.legacy` until the next
ordinary publication replaces that disposable cache row.

Old non-empty price snapshots may be valuations or service averages. Their raw
values and metadata remain retained as legacy evidence; the reader and sort SQL
withhold them until valuation-only recomputation. The migration does not invent
a service Cost snapshot from a scalar without matching count/latest evidence.
It separately queues live Products for the new service Cost publisher; physical
Cost projects the selected price without a second cached value.
It retires only `automaticFields` values and direct/fanout marks, replaces the
affected trigger functions, and drops the now-unused AuditLog derived trigger.
Checks on both cache tables reject late old-Worker writes to those retired
targets. Automatic-rule receipts and audit rows are unchanged.

The migration queues converted snapshots and legacy nulls lacking an outcome
reason, including ambiguous prices. It advances dirty tickets while retaining attempts and raw refresh
errors, and captures the existing drain Job invalidation. A typed empty result
already stored is unchanged. The new reader withholds ambiguous legacy nulls
until a typed result arrives; it never reconstructs their meaning from current
assignments or receipts. No assignments, financial allocations, automatic-rule
receipts or source records are modified.

After deployment, verify those marks drain, cached empty results decode, refresh
failures retain usable results, and reset does not display the removed override.
Record any remaining failing targets and raw errors. This cutover has not been
rehearsed against a retained production copy by the implementation's synthetic
migration test; that test verifies preservation, retirement and late-write guards.

## Unified Job cutover

This migration replaces the old job tables and removes business triggers. Use
the non-graceful migration-before-deploy sequence above for an authorized
deployment; old web, native, MCP, cron and Workflow requests may fail during
the switch. The migration locks retired sources and destinations before copying
them. Verify retained data after deploying the matching Worker and clients.

If an earlier operator left the Deploy workflow disabled or pinned
`PRODUCTION_MIGRATION_THROUGH=0003_explicit_field_publication`, verify no other
migration owner is active, clear that boundary, and release the matching
deployment. A boundary at `0003` cannot serve the new Worker, which requires
the Job table. Do not run a manual migration concurrently with Actions.

Before replacing the old queue consumers, verify and record that legacy messages
in the queue, its dead-letter queue, and requests already being processed have
finished or have a verified durable destination in the new model. This
includes location descriptions and inventory requests: their only durable copy
may be the old queue message, so the database migration cannot recreate them.
Resolve failures with the old Worker or preserve their complete work intent
before proceeding; do not discard messages to make the queue empty. New code
accepts only Job wake messages, so database preservation alone does not establish
preservation of legacy queue work. This is a data-preservation check, not a
requirement to hold household writers.

The migration creates Jobs before removing old scheduling fields. It carries
pending AI results forward for application without another provider call,
retains image-processing attempt tokens as historical receipts, and keeps
embedding IDs and upload receipts. Review history retains who or what made each
decision. Currently selected embeddings and authoritative household facts are
preserved. Retired embeddings keep separate history keys; deleted image work is
cancelled. Historical failed Runs remain available only through explicit retry.
Terminal AI retry/lease counters are discarded; domain state, raw errors, paid
usage, results and receipts remain in their owning records.

Run the populated predecessor migration test before release. During the switch,
record counts and retained receipts for each transformed source, verify the new
Jobs before dropping their old tables, and confirm the database has no business
triggers afterward. Resume queue messages only after the new handlers are
deployed. Then verify a save updates its derived data, cron repairs a missed
queue message, and failed or manually paused Jobs remain visible without being
automatically restarted. The migration runner owns the transaction; do not run
it alongside Actions or another operator.

## Financial evidence cutover

`0005_thin_blink` follows the unified-Jobs migration and shares its data and
legacy-queue preservation requirements above. Deploy the matching Worker and updated
clients together: financial CSV upload operations are removed. Agents parse
exports with the `financial-evidence-import` skill and submit normalized rows.
Use the authorized non-graceful cutover; no writer hold is required.

Rehearse both migrations on an isolated production copy. Compare complete
preexisting FinancialTransaction, allocation, Expense, attribution, and external
reference payloads before and after; totals alone do not prove preservation.
Verify one current head per explicit source charge, retained first-import
memberships, migrated Suggestion suppression ownership, and no invented
completed account windows. Retained ID-less observations stay independent;
equal amount/date/description is only a reconciliation candidate.

Historical file coverage requires a physical occurrence mapping, including
zero rows, source bytes, parsed metadata, signed totals, and preserved legacy
memberships. Registered fingerprints or membership counts alone are insufficient
where previous imports were partial or accumulated overlapping memberships.
Rehearse any one-off evidence repair and require unchanged preexisting rows and
financial lineage inside its transaction. Do not call an export a completed
provider window or create Expenses merely to close its count discrepancy.

After deployment, start an existing Sweep for `statement_transaction` and
`transfer_pair` over the retained historical accounts without a recent-date
filter. Exact evidence replay deliberately schedules no new work, so a
historical data-only repair needs this explicit discovery pass. Follow its Run
and budget state, review ambiguous identities against existing Expenses, and
report unmatched/unbooked work by year. Evidence coverage alone does not satisfy
historical spending reconciliation.

After deployment, verify a normalized intake and exact replay, a fresh source
revision, paused automatic spending, and visible correction review. Confirm
pending or unknown evidence stays honestly labeled. Withdrawals require a
completed, all-visibility account window plus persisted source recheck; a limited
Monarch response cannot authorize them. Check ordinary household writes after
deployment; a temporary failure during the switch does not justify skipping
these checks.

## Baseline consolidation

Neon is the only persistent application database; dev and CI databases are
synthetic and disposable. The current baseline replaces the retired series
through `0103_statement_charge_history`. Fresh databases apply
`0000_baseline.sql`, including derived DDL, optional Neon diagnostics, and
fresh-install Automatic rule defaults. `db:check` compares the resulting
catalog with `schema.ts` plus desired-state derived DDL.

`meta/_baseline.json` pins the baseline SQL hash and the count and SHA-256
fingerprint of the complete retired ledger. The fingerprint hashes the ordered
`created_at:hash\n` rows (decimal timestamps, original SQL SHA-256 hashes).
On encountering that exact ledger, the normal runner transactionally replaces
only `drizzle.__drizzle_migrations` rows with the baseline record, then applies
any post-baseline migrations. It never executes baseline SQL on that database,
changes application data, or resets the database. Partial, edited, extra, or
unknown histories fail closed. An interrupted transaction retains the old
ledger; rerunning after successful adoption follows the ordinary prefix path.
The baseline hash is immutable after adoption.

Before merging a consolidation, serialize with production deployment and verify
that Neon has applied the complete retired journal, including any staged
contractions. Clear any obsolete `PRODUCTION_MIGRATION_THROUGH` boundary before
the new baseline deploy; retired tags are deliberately rejected. Compare a
fresh baseline catalog with production using `db:check --against-production`
and record the retired ledger fingerprint read-only. After deployment, verify
one baseline bookkeeping row and unchanged application data/schema. No reset or
manual deletion of production bookkeeping is part of this procedure. If Neon
is behind, apply its missing original migrations from the preceding revision
before deploying the consolidation. Retired SQL and its preservation tests
remain in Git history: remove tests that locate or replay retired SQL in the
consolidation PR, while retaining domain write/readback coverage for current
invariants. New migrations get populated-predecessor coverage.

Only the newest schema snapshot is retained. Drizzle Kit uses it to generate
the next SQL diff; it does not apply snapshots to the database. After generation,
delete older `*_snapshot.json` files while retaining SQL, `_journal.json`, and
`_baseline.json`. `db:check` enforces this, and snapshot line diffs are suppressed
by `.gitattributes`; review the SQL and journal for executable changes.
