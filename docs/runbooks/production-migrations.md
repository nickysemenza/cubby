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

## Job entity identity backfill

`0036_job_entity_identity` uses the migration runner's explicit
`-- cubby:transaction-per-statement` opt-in. Ordinary migrations retain Drizzle's
transaction behavior. Every opted-in statement must be idempotent: committed
statements/batches can replay after a failure before the final journal receipt.
`-- cubby:repeat-batch` repeats a statement whose result is `{ remaining: boolean }`;
`-- cubby:outside-transaction` is reserved here for concurrent index creation/drop.
The same journal hash/prefix checks and deployment serialization still apply.

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

After deployment, verify every Job has exactly its matching live `Entity` row
of kind `job`, codes match `JOB-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}`, no
unreferenced Job identities remain, and the pending-capture population and
execution payloads match the retained pre-deploy evidence. Verify enqueue
replay preserves the code, Job reads on web/Apple/MCP, Retry now with one selected
Job and with a filter, a new queue claim, and retention removing only eligible
Jobs and their identities atomically. Verify the temporary backfill index is
absent and both permanent identity constraints are validated. Report any checks
not performed; migration success alone is not deployment verification.

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
