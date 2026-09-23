# Entity identity and attachments rollout

Ships ADR 0006 in one maintenance window. Downtime is acceptable: there is no
maintenance mode, and old-code writes that fail during the window surface as
errors. Native clients may break until the household installs the matching
build. The development `DATABASE_URL` may be production; never point
`db:push` at this change.

All SQL lives in `scripts/cutovers/`. Run each file whole in the Neon SQL
editor (or `psql -f`), in order.

## PR 1: expand and switch

The PR is opened without auto-merge. Do not merge it until step 5.

1. **Back up.** Take a Neon branch/snapshot of production and export an R2
   object listing.
2. **Preflight.** Run `entity-identity.preflight.sql`. Every query must
   return no rows. A row names data that would fail the cutover; understand
   and repair it first. The cutover repairs exactly one known pattern itself:
   early-2026 audit entries that filed Product ids under `inventory`.
3. **Pause queue delivery** so no message runs against the half-migrated
   schema (the queues have no dead-letter queue and drop a message after
   three retries):

   ```bash
   pnpm --filter @cubby/web exec wrangler queues pause-delivery cubby-background
   pnpm --filter @cubby/web exec wrangler queues pause-delivery cubby-telemetry
   pnpm --filter @cubby/web exec wrangler queues pause-delivery cubby-purchase-agent
   ```

   Cron is left running; a failed run is retried by the next one.
4. **Cutover.** Run `entity-identity.sql`. It is one transaction: it locks
   the entity tables against writes (reads continue), creates `Entity`,
   `EntityAttachment`, and `DataException`, backfills identities, merge
   redirects, code-less tombstones for history naming hard-deleted rows,
   attachments, data exceptions, and proposal FKs, validates every new FK,
   and installs the identity triggers. Any failure rolls the whole file back;
   restore nothing, fix the cause, and rerun. Read the verify queries at the
   end: per-kind identity counts, the redirect and tombstone counts, gallery
   attachment parity with the legacy joins, no unclassified Purchase
   document, and three identity triggers on every table.
5. **Merge and deploy.** Merge the PR and wait for the deploy to finish.
   Between step 4 and here, the previous build keeps working: the triggers
   give its inserts and deletes an identity, and it still writes the legacy
   image joins and jsonb columns.
6. **Catch up.** Run `entity-identity.catchup.sql`. It is idempotent and
   mirrors what the previous build wrote after step 4: legacy gallery, cover,
   and logo writes; merges (from their survivor audit entries); data
   exceptions; and proposal codes.
7. **Smoke test.**
   - Open a live entity by code, a merged-away code (it shows the survivor),
     and a deleted code (it refuses with the deletion date).
   - Try to edit through a merged-away code; it refuses with the survivor's
     code.
   - Upload, reorder, and detach a photo on a Product; set and clear a cookbook
     cover.
   - Open a detail page's Relations tab (Connections) and a delete dialog
     (impact preview).
8. **Resume queue delivery** with `wrangler queues resume-delivery` for the
   same three queues.

Rollback before step 5: restore the snapshot from step 1. After step 5:
redeploy the previous build; the legacy tables are intact but miss writes made
since the deploy, so restore the snapshot if those matter.

## PR 2: drop the legacy storage

Run this right after the PR 1 deploy rather than waiting: the legacy joins and
the cover and logo columns still hold `NO ACTION` foreign keys into `Image`,
so the new build's image hard-delete (detach, cover or logo replacement) fails
on any image a legacy row still names. The build no longer declares any of
these objects, so dropping them never breaks a read.

1. **Back up** (`pg_dump -Fc`).
2. **Catch up.** Rerun `entity-identity.catchup.sql`; it is idempotent.
3. **Drop.** Run `entity-identity.drop.sql`. One transaction: a guard refuses
   if any live legacy association or data exception has no `EntityAttachment`
   or `DataException` row, then it drops the eight `<Entity>Image` joins,
   `Cookbook.coverImageId`, `Vendor.logoImageId`,
   `Image.targetType`/`targetId`/`idempotencyKey` with the
   `Image_attachment_idempotency_key` index, and the Product and Purchase
   `dataExceptions` columns. Both verify queries at the end return no rows.
   It locks every affected table first with a 5-second `lock_timeout`; on a
   lock timeout, nothing changed, so rerun it.

`psql` (keg-only under `/opt/homebrew/opt/libpq/bin`) runs each file as
written: use the direct Neon host (drop `-pooler`) with
`sslrootcert=system`, and `-v ON_ERROR_STOP=1`.

## Known `db:push` drift

An interactive `db:push` against a database built by this cutover offers to
drop and re-add `AuditLog_entity_fk`, `SearchDocument_entity_fk`, and
`EntityEmbedding_entity_fk` (drizzle-kit misreads composite FKs into
`Entity(id, kind)`). Cancel those statements; they are unchanged.
