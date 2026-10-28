# Production migrations

The GitHub production deployment applies pending committed migrations before
deploying the already-built Worker. A migration failure stops deployment. The
runner uses only `PRODUCTION_DIRECT_DATABASE_URL` for production; it never
falls back to `DATABASE_URL`. Ordinary migrations must work with the currently
deployed code. Verify preservation with synthetic predecessor data before merge,
then read back production data and schema after release. See the
[domain rules](../agents/domain-rules.md#production-changes) for preservation
requirements and [CI](../ci.md#deployment) for workflow execution and retries.
Do not run production migrations by hand while a Deploy run is queued or
running; Actions serialization does not cover operator shells.

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
