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

## Large identity retirements

Check foreign-key indexes before applying SQL. An index restricted to live rows
cannot support checks against every referring row; `SearchDocument`'s live-row
identity index does not cover tombstones. For a one-time populated cutover, the
exclusive operator may create a temporary full index on
`SearchDocument ("entityId", "entityKind")` before the retirement transaction, then
drop it after preservation readback and confirm the schema matches the committed
journal. Never overlap this sequence with an Actions deploy.

## Locks against live queue traffic

A migration that takes `ACCESS EXCLUSIVE` on many tables can deadlock against the
running Worker's queue traffic on every attempt, as `0037_derived_values` did. Stop
background work first if locks contend.

## Migration runner opt-ins

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

## Quality snapshot cutover

The quality cutover adds `QualitySnapshot` and copies every `dataQuality` row's
identity, kind, rules version, check states and publication time from
`DerivedValue`. It takes a source SHARE lock with a 2-second lock timeout. The
foreign key is validated **after** the copy/comparison, taking a short
SHARE ROW EXCLUSIVE lock on `Entity` at the end of the transaction. A lock
failure rolls everything back; one rerun after checking contention is reasonable.
The `EXCEPT ALL` assertion verifies the frozen copy, not live state after commit.
No legacy rows or waivers are deleted. The matching Worker publishes only the
typed snapshot and reads it for browse, gap filters/sorts, Work admission and
field explanations. Quality's snapshot source is declared on its capability,
so its field envelope retains cached revision, missing and pending states.

Freeze other migration merges from this migration's merge through its deploy.
The old Worker can publish only to DerivedValue between migration and deploy,
including in-flight invocations. At least 16 minutes after the deployed Worker
is verified (past the 15-minute consumer wall limit), admit the scoped cutover
repair through the authorized production maintenance procedure:

```sql
SELECT derived_mark(d.kind || '.dataQuality', array_agg(d."entityId"), 'Quality cutover repair')
FROM "DerivedValue" d LEFT JOIN "QualitySnapshot" q USING ("entityId")
WHERE d.key = 'dataQuality' AND (q."entityId" IS NULL OR
  (d."computedAt" > q."computedAt" AND
   (d.value->'checks', (d.value->>'rulesVersion')::integer)
     IS DISTINCT FROM (q.checks, q."rulesVersion")))
GROUP BY d.kind;
```

Read back that the same missing-or-different predicate reaches zero after the
drain, and verify the quality journey. Stable snapshots deliberately retain
their last content-publication time: a newer legacy timestamp with identical
checks/version needs no repair and cannot reach timestamp-only equality under
`IS DISTINCT FROM` publication. Repair never copies old output over new output;
it recomputes current evidence and waivers. If current source changes produce a
different result from the old publication, verify it against the current live
calculation rather than repeatedly re-enrolling the old value. Record aggregates
and any unresolved difference. Do not infer production preservation from the
migration comparison alone.

The pair-review input keeps its existing fanout index, now watching
QualitySnapshot. Its new trigger is installed **after** the bulk copy. The old
DerivedValue source trigger becomes a no-op until its separate retirement.
Old quality rows stay until deployed all-reader removal and the separate
DerivedValue drop. This is not permission to retire tickets before the hourly
pass proves replacement output.


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
