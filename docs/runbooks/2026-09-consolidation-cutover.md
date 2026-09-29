# 2026-09 consolidation cutover

Applies the consolidation PR's single migration, `0002_cleanup`, to production
and deploys the matching Workers and app. The change is breaking on purpose:
the deployed code and the migrated schema are incompatible in both directions,
so production is unavailable between the migration and the deploy. The owner
is present and approves each outward step. Secrets stay in the operator's
shell; nothing below prints or stores them.

Rehearse the same steps first against a restored copy of a production dump in a
throwaway local Postgres (never the shared `cubby-dev-pg` container): steps 5
through 9 with `--database-url` pointing at the copy, then the smoke list
against a local app on that copy. Record the timings and the number of
`InventoryEntry` rows whose stored `valuation` disagrees with the value computed
on read (the column is dropped, so this is informational).

## Facts this runbook depends on

- **One migration applies.** `drizzle/0000_baseline.sql` is the pre-PR schema,
  `0001_prod_drift.sql` is idempotent residual drift, `0002_cleanup.sql` is the
  transform. Production already has the baseline's schema but its
  `drizzle.__drizzle_migrations` holds six rows from an abandoned drizzle-kit
  era. `tooling/db-migrate.ts` refuses any bookkeeping that is not a prefix of
  `drizzle/meta/_journal.json`, so step 6 replaces those rows with exactly one:
  the baseline. Recording only `0000` is the same path a push-built local
  database takes (`adoptBaseline`): the migrator then applies `0001` (a no-op on
  a database that already has that drift) and `0002`.
- **The migration is one transaction.** A failure applies nothing. After it
  commits there is no undo short of restoring the backup (see Rollback).
- **Merging to main deploys.** `.github/workflows/deploy.yaml` builds and deploys
  the web Worker on every push to `main`. The migration must therefore run
  before the merge (its SQL is identical at the PR head and after merge,
  because `0002` is immutable once merged), or the deploy must be held.
  Decision for the owner, recorded before starting: **A** migrate from the PR
  head, then merge and let `deploy.yaml` deploy; **B** hold the `cloudflare`
  environment's deploy jobs (a required-reviewer gate on that environment),
  merge, migrate, then release the deploy. With A the old Workers run against
  the new schema from step 7 until the merge deploys, so step 1 must have
  taken production out of service. Whichever is chosen, step 9 is the
  moment the new Workers serve traffic.
- **Old app builds stop working.** The server returns a structured "update
  required" to a native client below the minimum version; step 14 ships the
  build that satisfies it.
- Production identifiers (R2 endpoint and bucket, Hyperdrive IDs) live in
  [infrastructure.md](../infrastructure.md), not here.

## Before starting

- [ ] The PR's required CI has passed on its final head; the head SHA is
      recorded: `PR_HEAD=<sha>`.
- [ ] `git log -1` in the checkout you run from shows `PR_HEAD` with a clean
      tree, and `pnpm install --frozen-lockfile` has run.
- [ ] `PRODUCTION_DIRECT_DATABASE_URL` is set to the **direct** (non-pooled)
      Neon URL. `db:migrate --target=production` reads only this variable and
      refuses a `-pooler` host; the ambient `DATABASE_URL` points at production
      for local sessions and is never used.
- [ ] R2 credentials for the media bucket are available as
      `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` in the shell (step 5).
- [ ] Deploy path chosen (A or B above) and, for B, the environment gate is on.
- [ ] No other session holds a production schema change
      ([domain rules](../agents/domain-rules.md#production-changes)).
- [ ] Not within an hour of the `0 12 * * *` UTC cron (noon UTC), so it cannot
      fire mid-cutover.

## Steps

### 1. Start maintenance

Turn on the web Worker's maintenance switch (`apps/web/src/server/maintenance.ts`):
every request then gets a 503 (JSON for `/api`, `/_serverFn`, `/mcp`; a short
page otherwise) and the daily cron skips. A secret change deploys a new
version of the current code, so it takes effect within seconds:

```bash
echo true | pnpm --dir apps/web exec wrangler secret put MAINTENANCE_MODE
curl -sI https://<app origin>/ | head -1   # expect 503
```

Queue consumers are not gated by the switch; step 2 pauses their delivery.

- [ ] Production requests return the maintenance response (or the household has
      been told not to use the app); record the time.

### 2. Pause queues and scheduled work

- [ ] Pause delivery on the three producer queues from `apps/web/wrangler.jsonc`,
      and confirm each with `queues info`:

```bash
pnpm --dir apps/web exec wrangler queues pause-delivery cubby-background
pnpm --dir apps/web exec wrangler queues pause-delivery cubby-telemetry
pnpm --dir apps/web exec wrangler queues pause-delivery cubby-purchase-agent
```

- [ ] Note that no cron pause command exists; the single cron (noon UTC) is
      avoided by scheduling, not paused.
- [ ] Wait until in-flight Runs settle: no `Run` is still running or has been
      updated in the last five minutes (a read-only count with `psql`).

### 3. Stop device work

- [ ] Ask household members to close the native app and stop Photo Library
      sync; the app has no remote pause. Anything they send after this point is
      lost or refused, and the old build cannot run after step 7 regardless.

### 4. Back up

- [ ] Create a Neon branch named `pre-cutover-<yyyymmdd-hhmm>` from the current
      production state (Neon console or CLI); record its ID.
- [ ] Take a logical dump into a directory outside the repository, and check it
      lists tables:

```bash
pg_dump -Fc --no-owner --file "$HOME/cutover-backups/pre-cutover-<ts>.dump" \
  "$PRODUCTION_DIRECT_DATABASE_URL"
pg_restore --list "$HOME/cutover-backups/pre-cutover-<ts>.dump" | head
```

### 5. Move order-mail attachments to object storage

The migration drops `OrderMailAttachment.pendingDataBase64Url` after recording
`pendingObjectKey = 'order-mail-attachment/' || id`, so the bytes must already
be in R2 under that key. The script only reads the database; the key is not
under `R2_KEY_PREFIX`. Read its header
([`apps/web/scripts/order-mail-attachments-to-r2.ts`](../../apps/web/scripts/order-mail-attachments-to-r2.ts))
for the full contract.

- [ ] Dry run: prints counts, touches neither storage nor rows.

```bash
pnpm --dir apps/web exec tsx scripts/order-mail-attachments-to-r2.ts \
  --database-url "$PRODUCTION_DIRECT_DATABASE_URL"
```

- [ ] Execute with a manifest. The endpoint and bucket are the media bucket in
      [infrastructure.md](../infrastructure.md#r2-and-media-domain).

```bash
pnpm --dir apps/web exec tsx scripts/order-mail-attachments-to-r2.ts \
  --database-url "$PRODUCTION_DIRECT_DATABASE_URL" \
  --r2-endpoint "https://<account-id>.r2.cloudflarestorage.com" \
  --r2-bucket "<media-bucket>" --execute --manifest ./order-mail-manifest.jsonl
```

- [ ] Exit code 0, zero mismatches in the summary, and the manifest's line count
      equals the candidate count. A non-zero exit or any mismatch stops the
      cutover: an object whose bytes differ is reported and never overwritten,
      so resolve it by hand before continuing.

### 6. Snapshot, then fix the migration bookkeeping

- [ ] Snapshot the pre-migration aggregates for the verifier (read-only,
      counts only). Do this after step 3, before anything writes to the schema:

```bash
pnpm --dir apps/web exec tsx scripts/verify-consolidation-cutover.ts snapshot \
  --database-url "$PRODUCTION_DIRECT_DATABASE_URL" --out ./cutover-pre.json
```

- [ ] Compute the baseline's bookkeeping values the way the runner does. The
      hash is the migrator's `readMigrationFiles` value for the first journal
      entry and `folderMillis` is that entry's `when`; the runner compares both
      to the row exactly.

```bash
pnpm --dir apps/web exec tsx -e 'import { readMigrationFiles } from "drizzle-orm/migrator"; const [baseline] = readMigrationFiles({ migrationsFolder: "drizzle" }); console.log(JSON.stringify({ hash: baseline.hash, folderMillis: baseline.folderMillis }))'
```

- [ ] Inspect the current rows and confirm there are six, all older than the
      journal's first `when`:

```sql
SELECT id, created_at FROM drizzle.__drizzle_migrations ORDER BY id;
```

- [ ] In one transaction, replace them with the baseline row, then assert the
      table holds exactly one row. Substitute the two values printed above;
      do not reuse values from any other database or checkout.

```sql
BEGIN;
DELETE FROM drizzle.__drizzle_migrations;
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
  VALUES ('<hash>', <folderMillis>);
SELECT count(*) FROM drizzle.__drizzle_migrations;  -- must be 1
COMMIT;
```

### 7. Migrate

- [ ] Run from the PR head. The runner checks that the bookkeeping is a journal
      prefix, then applies `0001` and `0002`; `0002` opens with its guard block
      and ends with its relative post-checks, and raises (rolling back
      everything) on any mismatch.

```bash
pnpm --dir apps/web db:migrate --target=production
```

- [ ] The command prints `production database is current`. If it fails, nothing
      was applied: read the error (it names the guard or check), fix, and
      repeat from step 6 only if the bookkeeping changed.

### 8. Verify the data externally

- [ ] Run the verifier against the migrated database; it must exit 0.

```bash
pnpm --dir apps/web exec tsx scripts/verify-consolidation-cutover.ts verify \
  --database-url "$PRODUCTION_DIRECT_DATABASE_URL" --pre ./cutover-pre.json
```

- [ ] Prove production's catalog equals the model, using the same read CI's
      `db:check` uses (`readSchemaCatalog` and `diffSchemaCatalogs` in
      `apps/web/tooling/db-catalog.ts`): diff production against a database
      built by the committed migrations.

```bash
PRODUCTION_DIRECT_DATABASE_URL=... pnpm --dir apps/web db:check --against-production
```

It builds a scratch database from the committed migrations in the local test
Postgres, reads production through a read-only session, prints every catalog
difference, and exits non-zero on any.

- [ ] The catalog diff is empty. A non-empty diff or a verifier failure blocks
      step 9; go to Rollback.

### 9. Deploy

Path A (merge from the PR head):

- [ ] Merge the PR. `deploy.yaml` deploys the web Worker, the auxiliary Workers,
      and the purchase agent from `main`; wait for it to finish green.

Path B (held deploy):

- [ ] Merge the PR, then approve the held `cloudflare` deploy jobs and wait for
      them to finish green.

- [ ] Record the new web Worker version ID
      (`pnpm --dir apps/web exec wrangler deployments list`).

### 10. Refresh cached reads

`HYPERDRIVE_CACHED` serves reads for 60 seconds plus 15 seconds of
stale-while-revalidate, so reads taken against the old schema can outlive the
deploy. Wrangler has no purge subcommand; toggling caching is the closest
reset, and waiting bounds staleness by the configured max age plus SWR.

- [ ] Wait at least 75 seconds after the deploy finishes before the smoke list.
- [ ] Optional hard reset: toggle caching on the cached config (IDs in
      [infrastructure.md](../infrastructure.md#postgresql-and-hyperdrive);
      policy in `apps/web/src/lib/hyperdrive-cache-policy.ts`). Read
      `wrangler hyperdrive update --help` first: `--max-age` and `--swr` cannot
      be set while caching is disabled, so the re-enable form must be checked
      before caching is turned off.

```bash
pnpm --dir apps/web exec wrangler hyperdrive update <cached-id> --caching-disabled
```

- [ ] Resume the queues paused in step 2:

```bash
pnpm --dir apps/web exec wrangler queues resume-delivery cubby-background
pnpm --dir apps/web exec wrangler queues resume-delivery cubby-telemetry
pnpm --dir apps/web exec wrangler queues resume-delivery cubby-purchase-agent
```

### 11. Lift maintenance

The switch blocks every request, owner included, so lift it before smoking and
keep the household off the app until step 12 passes.

```bash
pnpm --dir apps/web exec wrangler secret delete MAINTENANCE_MODE
```

- [ ] Requests no longer return 503. Record the time; the window is from step 1
      to here.

### 12. Smoke

Signed in on the production web app and through the MCP server:

- [ ] A product's components list opens and a component quantity edits.
- [ ] Statement matching: open a statement-import review and confirm matched
      rows still resolve.
- [ ] A purchase's settlement status shows the same value as before (compare
      with the verifier's settlement histogram).
- [ ] The Run list opens and hides ephemeral AI runs by default.
- [ ] Photo library sync: after installing the TestFlight build (step 14, or a
      local build pointing at production), one sync reports sightings without
      error.
- [ ] MCP `entity` read of one product returns, with its external identifiers.
- [ ] No new errors in Sentry for the release.

- [ ] Tell the household the app is back.

### 13. Analyze

- [ ] Refresh planner statistics (the migration rewrote and dropped large
      tables). `VACUUM` cannot run inside a transaction block, so run it as its
      own statement from `psql`:

```sql
VACUUM (ANALYZE);
```

### 14. Ship the app

- [ ] Push a `vMAJOR.MINOR.PATCH` tag at the merge commit on `main`. The tag is
      the marketing version: it must be higher than the last release, and at or
      above the minimum the server's client-version gate requires
      (`.github/workflows/apple-testflight.yaml` validates the tag and refuses
      one that is not on `main`).

The minimum is `MINIMUM_APPLE_CLIENT_VERSION` in
`apps/web/src/server/apple-client-gate.ts` (`2.0` for this cutover): Apple
builds older than it get HTTP 426 `CLIENT_UPDATE_REQUIRED` on `/api/v1`. Tag
this release `v2.0.0` or higher, or the new build is gated too.

- [ ] The TestFlight build is processed; install it and repeat the photo sync
      smoke item.

## Rollback

- **Before step 7 commits** (including a failed `0002`): nothing changed in the
  schema, and nothing else reads the bookkeeping table, so leave the single
  baseline row in place and restart at step 7 once the cause is fixed. Resume
  queues and lift maintenance if the attempt is abandoned.
- **After step 7 commits, before the deploy:** restore. Create a new Neon
  branch or restore point from `pre-cutover-<ts>`, point production at it (a
  Hyperdrive origin update, via the direct URL), and confirm the old Workers
  still serve. If Neon restore is unavailable, restore the `-Fc` dump into an
  empty database with `pg_restore --no-owner --clean --if-exists` and repoint.
  The R2 objects from step 5 are additive and can stay.
- **After the deploy:** run `wrangler rollback` for the web Worker to the
  version recorded before step 9 (and the purchase agent if it deployed), then
  restore the database as above; the previous Workers cannot read the new
  schema. Native builds already released keep requiring the new server, so pull
  or expire the TestFlight build.
- After any rollback: resume queues, lift maintenance, and record what failed
  in a follow-up before retrying, since `0002` is immutable once merged and a
  fix ships as a new migration.
