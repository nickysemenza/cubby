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

When the member explicitly authorizes a non-graceful cutover with writers
enabled, the normal Actions migration-before-deploy sequence may apply the
preserving contraction before the matching Worker deploys. Old requests and
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

## Unified Job cutover

This migration replaces the old job tables and removes business triggers. Pause
writes from web, native, MCP, cron, queues, and existing Workflows while applying
it. Keep writes paused until the matching Worker and clients are deployed and
checks confirm the data was preserved. This PR does not authorize a production
deploy or Cloudflare configuration changes.

Before merging, the production operator must hold the automatic Deploy workflow
and set `PRODUCTION_MIGRATION_THROUGH=0003_explicit_field_publication`. Otherwise
the main-push workflow removes tables that live code still uses. The variable
alone is insufficient: the new Worker also requires the new Job table. With
writes paused, explicitly migrate through `0004_unified_jobs`, deploy the
matching Worker and clients, and check the retained data. Only then delete
`PRODUCTION_MIGRATION_THROUGH` and release automatic deploys.
These are operator prerequisites, not actions performed by this PR.

Before stopping the old queue consumers, stop new requests and let the old
Worker finish every legacy queue request. Verify and record that the queue,
its dead-letter queue, and requests already being processed are empty. This
includes location descriptions and inventory requests: their only durable copy
may be the old queue message, so the database migration cannot recreate them.
Resolve failures with the old Worker before proceeding; do not discard messages
to make the queue empty. Only then stop consumers and apply the migration with
writes paused. New code accepts only Job wake messages, so this verified drain
is required before switching versions.

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

`0005_thin_blink` follows the unified-Jobs migration and shares its writer hold
and queue-drain prerequisites above. Deploy the matching Worker and updated
clients together: financial CSV upload operations are removed. Agents parse
exports with the `financial-evidence-import` skill and submit normalized rows.
Keep automatic deployment held until this coordinated cutover is ready.

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
Monarch response cannot authorize them. Resume writers only after these checks.

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
