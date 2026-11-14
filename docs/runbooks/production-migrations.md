# Production migrations

Merging to `main` deploys production. The Deploy workflow applies every pending
committed migration in `apps/web/drizzle/`, then deploys the already-built
Worker. A migration failure stops the deployment. The runner uses only
`PRODUCTION_DIRECT_DATABASE_URL`; it never falls back to `DATABASE_URL`. See
[CI](../ci.md#deployment) for workflow execution and retries and the
[domain rules](../agents/domain-rules.md#production-changes) for preservation
requirements.

Do not run production migrations by hand while a Deploy run is queued or
running; Actions serialization does not cover operator shells.

## Non-graceful cutover (default)

Ship one preserving migration with the matching Worker and clients in one PR.
Merging applies the migration and deploys the code. Downtime is acceptable: old
web, native, MCP, cron and queue requests may fail during or after the switch.
No writer hold, maintenance window, rehearsal, compatibility rollout, timed wait
or feature-specific release procedure is required.

Preservation is still required:

- Transform existing rows in the same migration that changes their shape.
- Lock every copy source and destination against writes before reading them,
  hold those locks through the copy and drop, and refuse a contraction unless
  all retained content has a verified destination.
- Preserve source data, money, member decisions and unfinished paid or
  member-requested work. Queued work whose only durable copy is a queue message
  needs a destination before its consumer changes.
- Cover the migration with synthetic predecessor data before merge
  (`apps/web/tooling/*-migration.integration.test.ts`).
- After release, read back the transformed data and schema, and check that
  ordinary household writes work. A temporary failure during the switch does
  not justify skipping the read-back.

Derived data needs no migration-time backfill; its owner is
[Background derived data](../entities.md#background-derived-data). Temporary
stale badges do not justify a staged cutover.

## Staged destructive migration (rare)

Use this only when a destructive step must wait until the Worker that stops
reading and writing the retired shape is deployed, and a combined
migration-plus-deploy would lose data. One operator owns the whole sequence,
including Actions and local applications.

1. Set the `cloudflare` GitHub Environment variable
   `PRODUCTION_MIGRATION_THROUGH` to the exact last compatible migration folder
   name. If no new migration is safe before deploy, use the last applied one.
   Actions passes it to the runner as the inclusive `--through` boundary.
2. Merge the PR. Actions applies migrations through the boundary and deploys the
   Worker. Admit no other `main` merge or Deploy retry until the sequence ends:
   a revision that lacks the new migration folder fails closed.
3. Apply the destructive migration from the matching checkout:

   ```sh
   pnpm --filter @cubby/web db:migrate --target=production --through=EXACT_FOLDER_NAME
   ```

4. Read back the data and schema, then delete `PRODUCTION_MIGRATION_THROUGH` in
   the same task.

`--through` takes the complete timestamped folder name and is inclusive: every
pending predecessor runs and no later entry runs. Unknown folder names and
unknown, duplicate or changed-hash receipts refuse before any SQL. A database
already beyond the requested boundary refuses without mutation, and so does a
boundary behind the applied database. The runner never rolls back applied
migrations and has no dry-run mode. Omitting `--through` applies every pending
migration.

A boundary does not prove which SQL is compatible with the deployed code; the
operator reviews it. Never infer compatibility from a migration's name or SQL
keywords.

## Locks

The runner applies every pending migration in one transaction with a 2-second
lock timeout, inserting each journal receipt inside it. Before the first
statement it takes `ACCESS EXCLUSIVE`, in sorted order, on every existing table
the pending chain names in `LOCK TABLE`, `ALTER TABLE`, `DROP TABLE`,
`TRUNCATE`, `CREATE INDEX`, `CREATE TRIGGER` or `REFERENCES`, on the table of
each index it drops, on the referenced table of each constraint it drops, and on
the foreign-key partners of each table it drops (`lockPendingTables` in
`tooling/db-migrate.ts`). No lock is upgraded later in the transaction, and
contention fails in seconds instead of after a long copy. A migration that only
reads a table it needs stable names it in `LOCK TABLE`; the runner cannot see
tables touched only through dynamic SQL. A wide copy holds these locks for many
minutes; the Deploy job's 25-minute timeout bounds the whole run.

The runner retries the whole transaction on deadlock (`40P01`) or lock timeout
(`55P03`), up to six attempts 15 seconds apart; each attempt rolls back every
pending migration and receipt. Any other error, or a sixth failure, stops the
Deploy with nothing applied.

The up-front lock set is wide and can contend with the running Worker's queue
traffic on every attempt. Stop background work first if locks contend.

## Migration runner markers

The runner removes `CONCURRENTLY` from every statement, so indexes are built
and dropped inside the transaction. It ignores
`-- cubby:transaction-per-statement`; such a migration commits with the rest of
the run.

- `-- cubby:repeat-batch` repeats a statement whose result is
  `{ remaining: boolean }` until it reports none remaining, inside the same
  transaction.
- `-- cubby:outside-transaction` marks an index build or drop. Before running
  the statement in the transaction, the runner drops any invalid index the
  statement names, left by an interrupted concurrent build.

The same migration name and hash checks and deployment serialization apply.

## Foreign-key indexes

Check foreign-key indexes before applying SQL that deletes or rekeys many rows.
An index restricted to live rows cannot support checks against every referring
row; for example, `SearchDocument`'s live-row identity index does not cover
tombstones. The operator may create a temporary full index before the
transaction, drop it after the preservation read-back, and confirm the schema
matches the committed journal. Never overlap this with an Actions deploy.

## Money unit changes

When a monetary column changes units, give the physical minor-unit column a new
name. Keeping a numeric predecessor column name can silently accept an old
Worker's whole-dollar value as cents. Old writers must fail at the database
boundary; downtime does not authorize wrong-unit writes. Keep client
dollar-number fields at the checked output boundary, compare every converted row
by ID, and verify a predecessor write refuses after the cutover.

## Archive schema

Preimages that a migration must retain move to the `archive` schema with their
foreign keys, triggers and nonessential indexes removed. `db:check` covers only
`public`. Archived money preimages are retained evidence; drop one only on the
owner's request.

## Dropping a table or deleting retained rows

A table or column whose hand trace shows no member facts, money, evidence,
decisions or unfinished paid or member-requested work may be dropped without an
archive or snapshot, in the same change that removes its last reader and writer
([ADR 0025](../adr/0025-radical-simplification-of-background-work.md) decision
10). Old requests may fail during the cutover. An authoritative table replaced by
a reshape carries its data through the migration and keeps its preimage in the
[archive schema](#archive-schema).

## Snapshot investigation

For Neon snapshot read-back through MCP, pass `finalize: false` explicitly to
`restore_snapshot`, omit `target_branch_id`, and use a separate endpoint on the
returned branch. `finalize: true` can replace the source branch's production
endpoint and default designation even when the restore creates a new branch; it
is a production cutover, not an isolated copy. Before querying, verify both
branch IDs and endpoint assignments: the production hostname and default branch
must still point to the original production branch. Retain any unexpected branch
writes for reconciliation before removing an investigation branch.

## Baseline consolidation

Neon is the only persistent application database; dev and CI databases are
synthetic and disposable. Fresh databases apply
`20261020233250_0000_baseline/migration.sql`, including derived DDL, optional
Neon diagnostics and fresh-install Automatic rule defaults. `db:check` compares
the resulting catalog with `schema.ts` plus desired-state derived DDL.

`baseline.json` pins the baseline SQL hash and the count and SHA-256 fingerprint
of the complete retired ledger. The fingerprint hashes the ordered
`created_at:hash\n` rows (decimal timestamps, original SQL SHA-256 hashes). On
encountering that exact ledger, the runner transactionally replaces only
`drizzle.__drizzle_migrations` rows with the baseline record, then applies any
post-baseline migrations. It never executes baseline SQL on that database,
changes application data or resets the database. Partial, edited, extra or
unknown histories fail closed. An interrupted transaction retains the old
ledger; rerunning after adoption follows the ordinary named-history path. The
baseline hash is immutable after adoption.

A new consolidation needs explicit authorization. Before merging it, serialize
with production deployment and verify that Neon has applied the complete retired
journal. Clear any `PRODUCTION_MIGRATION_THROUGH` boundary first; retired tags
are rejected. Compare a fresh baseline catalog with production using
`db:check --against-production` and record the retired ledger fingerprint
read-only. No reset or manual deletion of production
bookkeeping is part of this procedure. If Neon is behind, apply its missing
original migrations from the preceding revision before deploying the
consolidation.

### Drizzle v1 history

Each migration lives in `<UTC timestamp>_<name>/migration.sql`, whose bytes are
immutable once merged. The snapshot graph starts at the format-9 generation
baseline `20261106180850_0116_adr25-l2f-image/snapshot.json`; keep every
snapshot after it, because v1 reconstructs later state from the complete graph.
Earlier SQL folders remain executable history.

The runner validates applied SQL hashes before Drizzle adds `name` and
`applied_at` to legacy bookkeeping; new receipts use full folder names. SQLite
stores use Drizzle's in-place ledger upgrade under their initialization
transaction. `db:check` checks the snapshot graph against the generated model
and compares fresh replay with a model-built catalog. Run `drizzle-kit check` for
branch conflicts. Never run `generate --fix-conflicts` against history a durable
database has applied: that repair may delete migrations and demand a reset.

### Declared views during a table reshape

A view follows its source table's OID when `ALTER TABLE ... SET SCHEMA archive`
moves it. Creating a replacement public table does not rebind that view. Any
reshape of a declared view's source must recreate the view against the new
public table in the same migration. Regenerate it from
`renderDeclaredDerivedViews` and verify its values before retiring the old
source. `db:check`, including `--against-production`, rejects public views and
materialized views with catalog dependencies on `archive`.
