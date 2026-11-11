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
reading and writing the retired shape is deployed and verified, and a combined
migration-plus-deploy would lose data. One operator owns the whole sequence,
including Actions and local applications.

1. Set the `cloudflare` GitHub Environment variable
   `PRODUCTION_MIGRATION_THROUGH` to the exact last compatible migration folder
   name. If no new migration is safe before deploy, use the last applied one.
   Actions passes it to the runner as the inclusive `--through` boundary.
2. Merge the PR. Actions applies migrations through the boundary and deploys the
   Worker. Admit no other `main` merge or Deploy retry until the sequence ends:
   a revision that lacks the new migration folder fails closed.
3. Verify the deployed Worker, then take a named snapshot (see
   [Dropping a table](#dropping-a-table-or-deleting-retained-rows)).
4. Apply the destructive migration from the matching checkout:

   ```sh
   pnpm --filter @cubby/web db:migrate --target=production --through=EXACT_FOLDER_NAME
   ```

5. Read back the data and schema, then delete `PRODUCTION_MIGRATION_THROUGH` in
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

Take every lock a migration needs at its start, in a fixed order, so contention
fails in seconds instead of after a long copy. Dropping a foreign key also locks
the referenced table. A wide copy can hold `ACCESS EXCLUSIVE` for many minutes;
the Deploy job's 25-minute timeout bounds the whole run.

An ordinary migration runs in one transaction. The runner retries the whole
transaction on deadlock (`40P01`) or lock timeout (`55P03`), up to six attempts
15 seconds apart; each attempt rolls back whole, including other pending
migrations in that transaction. Any other error, or a sixth failure, stops the
Deploy with the migration unapplied.

A migration that takes `ACCESS EXCLUSIVE` on many tables can deadlock against
the running Worker's queue traffic on every attempt. Stop background work first
if locks contend.

## Migration runner opt-ins

`-- cubby:transaction-per-statement` makes the runner commit each statement
separately. Ordinary migrations keep Drizzle's transaction behavior. Every
opted-in statement must be idempotent: committed statements can replay after a
failure before the final journal receipt. Each statement has a 2-second lock
timeout, and the runner retries a statement that hits a lock timeout or deadlock
whole, for about two minutes, then stops the deployment. Everything committed so
far must stay compatible with the running Worker, because the next Deploy
resumes from there. One statement can hold several commands in one transaction,
so a copy and its retirement stay atomic.

- `-- cubby:repeat-batch` repeats a statement whose result is
  `{ remaining: boolean }`.
- `-- cubby:outside-transaction` is reserved for concurrent index creation or
  drop. The runner first drops any invalid index the statement names (left by
  an interrupted concurrent build), and stops the deployment if one remains
  invalid afterwards.

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

A table with no member facts, money, evidence, decisions or unfinished paid or
member-requested work may be dropped without an archive. Deploy and verify the
Worker with its readers and writers removed first, and run one destructive
migration at a time. Immediately before the migration, take a named manual
snapshot and record its id in the PR:

```sh
neon snapshots create --name drop-<table>-<date>
```

Keep the snapshot until the final report, which lists it for the owner to
delete. To recover, restore to a new branch, export the table from there and
load it into production:

```sh
neon snapshots restore <id> --name verify-<table>
```

Never pass `--finalize`, never run `snapshots finalize`, and never reset or
restore onto the production branch. If table-level recovery would not be enough,
do not drop the table; stop and report.

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
read-only. After deployment, verify one baseline bookkeeping row and unchanged
application data and schema. No reset or manual deletion of production
bookkeeping is part of this procedure. If Neon is behind, apply its missing
original migrations from the preceding revision before deploying the
consolidation. Remove tests that locate or replay retired SQL in the
consolidation PR, and keep domain write and read-back coverage for current
invariants.

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
