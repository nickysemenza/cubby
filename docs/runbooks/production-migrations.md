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

## Dropping a table

A table with no member facts, money, evidence, decisions or unfinished paid or
member-requested work may be dropped without an archive. Deploy the Worker with its
readers and writers removed and verify it first, and run one destructive migration
at a time. Immediately before the migration:

```sh
neon snapshots create --name drop-<table>-<date>
```

Record the snapshot id and keep the snapshot until the owner deletes it. To recover,
export the table from an unfinalized restored branch and load it into production:

```sh
neon snapshots restore <id> --name verify-<table>
```

Never pass `--finalize`, never run `snapshots finalize`, and never reset or restore
onto the production branch. If table-level recovery would not be enough, do not drop
the table.

`0081_drop_assessment_read` drops `AssessmentReadPublication`,
`AssessmentReadMembership`, `AssessmentReadDependency` and `AssessmentReadStage`
this way, and aborts if any holds a row.

## Suggestion table (0080)

`0080_suggestion_table` moved `Assessment`, `AssessmentState` and `Feedback` to the
`archive` schema with their foreign keys, triggers and secondary indexes removed. The
archive stays until the owner decides otherwise; `db:check` covers only `public`.

Its transaction ran for 15.6 minutes in production, holding ACCESS EXCLUSIVE on Run,
LedgerParty and AiEvaluation for the wide copy, against a 10-minute estimate. The
deploy job took 17.5 minutes in all, which is why `deploy.yaml` allows 25. Budget a
similar copy from this, and take every lock before it, so contention fails in seconds:
dropping a foreign key also locks the referenced table.

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

## Remaining derived retirement gates

The typed reader/writer removal must deploy before destructive retirement.
The parent serializes all migration merges. Until deployment and live coverage
readback, retain every derived ticket and trigger: test output and a frozen copy
comparison are insufficient. B3 owns assessment.reviewFacts; B1 owns the other
WorkItem drains and the eventual WorkItem drop. Derived execution itself no
longer claims WorkItem. ProductConversionCoverage remains its typed table.

After three full Worker rebuilds, record their durations against 15 minutes;
require each full pass under 45 minutes and inspect CPU/memory termination logs.
Take the manual snapshot and record its id immediately before each table drop,
following the recovery procedure in this runbook. Replace derived_mark with a
no-op first, then use a separate transaction-per-statement migration with
idempotent table-specific trigger drops and 2-second lock timeout. Catalog
verification must inspect pg_proc function bodies and pg_trigger, because
PostgreSQL does not track plpgsql table dependencies. Retire tickets only for
proven replacement kinds and only where drain = 'derived:drain'.

Before DerivedValue drops, recheck decidedBy legacy counts by key, require zero
for any key without current replacement output, hand trace FKs/native/MCP and
identity cleanup, and confirm the deployed Worker has no reader or writer. A
snapshot restore is unfinalized on a separate verify branch; export that one
table and load it back if needed. Never finalize or reset production. Retain
snapshot ids through the final report for the owner to delete.

## Hourly deterministic pass

The Worker cutover adds one DerivedRebuild cursor row and switches execution off
per-value tickets. Retained tickets stay in place. Before retiring a target's
tickets, verify replacement output coverage. Retirement always filters
`drain = 'derived:drain'`; paid and member-directed work belongs to its owner.

Use maintenance.rebuildDerived to start or resume a Worker pass and
maintenance.derivedRebuildStatus for aggregate progress and the last three
wall-clock timings. Record three full corpus timings against 15 minutes;
separately require completion under 45 minutes and inspect Worker logs for CPU
or memory-limit terminations. A target miss is reported, never hidden by clearing
retained work. Trigger retirement, catalog checks and DerivedValue drop remain
separate deployed-reader-first steps under ADR 0025.

## Retiring derived source triggers

Deploy and verify the Worker with the ticket engine and explicit SQL admission
callers removed first. Require the full-pass gate in issue #3662 and per-kind
replacement coverage before this step. Retained tickets are not a completion
counter and are not deleted by either DDL migration.

First replace only the shared `derived_mark(text, uuid[], text)` function with a
no-op. Keep its signature/default and all source triggers for this deployment.
Use transaction-per-statement with a 2-second lock timeout. Read back its
`pg_get_functiondef` and confirm it references neither WorkItem nor
JobInvalidationCapture. Verify source edits still commit and replacement reads
remain available. B1 still owns the retained work tables.

Then take a named manual snapshot immediately before the separate source-trigger
retirement, record its id, and retain it through the final report. Retire source
triggers table by table in that migration. Every drop
is idempotent and uses `-- cubby:transaction-per-statement` with the 2-second
lock timeout, including after partial commits/retry. Verify `pg_trigger` has no
remaining derived-mark trigger and `pg_proc` has no body referring to retained
work tables before B1 drops them. Keep ProductConversionCoverage; only its ticket
trigger retires. The separate DerivedValue drop still requires its full consumer
trace, legacy count by key, production preservation proof and immediately named
manual snapshot under the table-drop procedure.

## Typed domain read snapshots

The read snapshot cutover copies each declared result into named, typed columns
on ProductReadSnapshot, InventoryReadSnapshot, LocationReadSnapshot,
ProjectReadSnapshot, ExpenseReadSnapshot, EmailReadSnapshot and
ShipmentReadSnapshot. It preserves the complete decision/evidence JSON, scalar
sort and publication time. A frozen bidirectional EXCEPT ALL comparison aborts
on any mismatch; it is copy evidence, not a production rebuild timing. SQL NULL
publication payloads normalize to JSON null in that comparison, matching the
reader contract while retaining decisions and publication presence. The populated
predecessor fixture is `apps/web/tooling/typed-read-snapshots-migration.integration.test.ts`. Foreign
keys are validated after the copy. The 2-second lock timeout rolls back on
contention. Retain DerivedValue and tickets until the replacement Worker has
rebuilt every kind and production coverage is verified.

After deployment, request a Worker rebuild and require all live legacy identities
for each converted key to have a replacement publication (including successful
empty output). Investigate missing rows against current sources: deleted or
inapplicable results may correctly disappear. Keep the scoped 16-minute repair
procedure below for predecessor invocations. No broad WorkItem retirement is
part of this migration. ProductConversionCoverage is unchanged.

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
When the hourly pass is deployed, request maintenance.rebuildDerived instead of
marking tickets below. The old Worker can publish only to DerivedValue between migration and deploy,
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

### Declared views during a table reshape

A view follows its source table's OID when `ALTER TABLE ... SET SCHEMA archive`
moves it. Creating a replacement public table does not rebind that view. Any
reshape of a declared view's source must recreate the view against the new public
table in the same migration. Regenerate it from `renderDeclaredDerivedViews` and
verify its values before retiring the old source. `db:check`, including
`--against-production`, rejects public views and materialized views with catalog
dependencies on `archive`; the populated catalog journey covers this exact move.

## Dropping a table or deleting retained rows

Do this only after the Worker with its readers and writers removed is deployed and read
back. Run one destructive migration at a time. Immediately before merging it, take a
named manual snapshot and record its id in the PR:

```sh
neon snapshots create --name drop-<table>-<date>
```

Keep it until the final report, which lists it for the owner to delete. To recover,
restore to a new branch, export the table from there and load it into production:

```sh
neon snapshots restore <id> --name verify-<table>
```

Never pass `--finalize`, never run `snapshots finalize`, and never reset or restore onto
the production branch. If table-level recovery would not be enough, stop and report.

## Source-claim minor units

`0096_source_claim_minor_units` is a direct contract cutover. The running statement planner and label application read LedgerSourceClaim through booking-lineage checks. Label application also reaches LedgerTransfer through canonical FinancialTransaction read-back. A zero-row result does not establish table independence, so these refresh gates remain until the retained steps are terminal. The release owner
must wait for the active financial refresh's generation and subsequent statement
steps to reach terminal outcomes before merging it. No writer hold, branch-copy
rehearsal or dual writer is required. Parent owns merge sequencing with other
migration lanes; regenerate its journal position on current main before release.
The migration takes a short `RunStep` share lock and refuses unfinished financial
steps in any running Run or the latest statement Run, including a failed Run
awaiting recovery. A failed parent status does not prove its continuation finished.

The migration locks the claim table and its FK endpoints with a two-second lock
timeout. It refuses unrepresentable money and unhandled view dependencies before
changing storage. It moves the complete original table to
`archive.LedgerSourceClaim_dollar_preimage`, creates the replacement with signed
bigint `targetAmountMinor`, and compares complete row-level hash multisets, including nulls
and tombstones, against the exact allowed conversion. Original rows are checked
again unchanged. An independent ID join also requires every archived dollar
double to equal converted cents divided by 100 in IEEE arithmetic; this catches
noise hidden by PostgreSQL's rounded `float8::numeric` cast. It rebinds incoming/outgoing FKs and current triggers, then
removes archived outgoing FKs, triggers and nonessential indexes. The archive is
retained indefinitely in this goal; no table or original source JSON is dropped.

Run the populated-predecessor source-claim migration regression and `db:check`
before merge. Parent's independent reviewer must examine signed conversion,
full-row preservation, FK/trigger rebinding, archive inertness and the unchanged
native dollar-number boundary. After deployment, independently compare retained
claim IDs, source keys, decisions, normalized evidence and timestamps; verify
target cents exactly match archived dollars × 100 and that Expense/transfer
reads still return dollar numbers. Verify live source-claim replacement and
exact replay through supported commands. A successful migration alone proves
neither runtime acceptance nor completed historical reconciliation.

When a monetary column changes units, give the physical minor-unit column a
new name. Keeping a numeric predecessor column name can silently accept an old
Worker's whole-dollar integer as cents, especially on a reviewed mismatch.
Old writers must fail at the database boundary; downtime does not authorize
wrong-unit writes. Keep client dollar-number fields at the checked output
boundary. Verify a predecessor write refuses after the cutover.

Financial cutover gates recognize only done steps or an ended failed Run with failureCode user_cancelled and no nonterminal Job. Run, Job and RunStep share locks close admission races. A cancelled parent with queued, running, retry_wait or paused execution remains blocked; every other failure still blocks the existing active/latest-refresh scope. Old running step cursors and counters remain unchanged by the gate exception. No nonexistent RunStep cancelled state is assumed.

## Ledger-transfer minor units

`0097_ledger_transfer_minor_units` follows the source-claim migration in this
unmerged stack; the release owner renumbers the stack against the actual main
prefix. Hold it for the terminal financial refresh and independent money review.
It preserves original transfer rows under `archive.LedgerTransfer_dollar_preimage`
and compares full-row hash multisets against exactly `amount` → `amountMinor`
and dollars × 100, including parties, notes, dates and tombstones. Money
also passes independent IEEE round-trip equality by ID, and the same
RunStep release refusal protects a refresh started between stack deployments.
Incoming FinancialTransaction/source-claim references and outgoing party/identity FKs
are rebound to the replacement; archived rows retain no live FKs or triggers.

Run the populated-predecessor transfer migration regression, ledger/transfer
journeys and household contribution report coverage, then check catalog parity.
After deployment, independently verify retained transfers and claims, party
positions, attached evidence, exact archived-dollar/current-cent equality, number
outputs and refusal of predecessor `amount` writes. Include kernel create/update `item.amount`
responses in the unit audit: mutation receipts patch client caches directly.
Stored bigint cents must be converted before constructing receipt JSON. Note-only
transfer edits preserve omitted evidence; fresh or changed evidence must reject
noisy amounts through the financial constraint boundary. Migration completion is not
historical financial acceptance. No transfer is reclassified as Expense spend.

## Source occurrence ownership (provisional 0098)

`0098_source_occurrence_ownership` follows both minor-unit money migrations.
The parent assigns its release number. It is a direct cutover, with the same
RunStep gate: all retained financial refresh steps must be terminal.

Retain `archive.SourceTransactionRecord_occurrence_preimage`,
`archive.TransactionImportRecord_occurrence_preimage` and
`archive.EntityExternalId_financial_preimage`. They preserve complete original
rows, including tombstones and original source judgments. The migration rebuilds
public facts, annotations, aliases and memberships, reconstructs every removed
field independently, and refuses any mismatch. Exact source money must pass
independent IEEE round-trip comparison. Incoming/outgoing FKs and row triggers
are rebound; archives retain no live FK, trigger or nonessential index.

Retain pending review rows in place: no pending Suggestion, paid label, suppression or member decision is retired by the cutover. Existing held work remains visible in review; automatic eligibility is a separate current-identity check. Historical transaction links are labelled evidence, never accepted ownership. Failed Run steps retain their errors, counters and metadata. Their old source-key cursors are archived in `archive.RunStep_occurrence_cursor_preimage` and cleared; retry resolves retained aliases into current independent source handles before planning, with one progress unit per original failure ref. Held identities keep a specific review-required failure until explicitly resolved and retried.

The exact migration predicates prove **22,057 identities covering 22,057 of 56,208 observations**: 169 attested provider observations and 21,888 original physical positions; 34,151 remain unresolved. This supersedes the initial 22,139-candidate estimate: 271 flat Monarch rows fail raw scope agreement. Never turn a sole alias owner into accepted identity. The migration promotes acceptance only with a ready proven occurrence, direct v2/v3 binding, complete unique retained binding closure, live target and exact account/amount agreement. Otherwise money stays unchanged. No new review task is generated merely for missing proof.

SourceRecord's existing audited update accepts an explicit `identityResolution`: confirm a distinct event, accept a named existing transaction, or assign an unresolved observation to a reviewed occurrence. It requires the exact observation fingerprint, owner version, accepted owner and complete live historical transaction set that were reviewed, plus account, explicit open/ignored judgment and decision note. It preserves ignore judgments and original evidence, records resolved historical bindings without deleting them, and never runs from intake or automatic rules. Missing proof alone is not a member task. Use this only for an actual explicit financial judgment; do not invent one to drain historical work.

Before release, independently review identity partitions, current-pointer and
replacement membership FKs, all lock classes and stale receipts, money and
relationship conservation, inert archives, and every retired alias/folding caller.
After deploy, read back counts and full-row preservation aggregates and verify
representative member reads/writes before historical booking or a Monarch pull.
Do not run the SQL manually. Native installation remains unverified.
