# Migrate the retired `upc-lookup` D1 into `UpcLookupCache`

UPC lookups now run in the main Worker against Postgres `UpcLookupCache`, with
upcitemdb as the upstream fallback (`apps/web/src/server/services/upc/`). The
old Worker's hand-entered (`manual`) products and its checked-miss rows must be
copied across once, before the old Worker is deleted.

1. Dry run (reads D1 only; prints counts, samples and the referenced R2
   `upc-images` keys):

   ```bash
   node scripts/migrate-upc-d1.ts
   ```

2. Apply (idempotent upserts; run against the production database only after
   the schema migration `upc_cache_product_fields` has been applied):

   ```bash
   DATABASE_URL=<production url> node scripts/migrate-upc-d1.ts --apply
   ```

   `--copy-images` additionally copies each referenced object from R2
   `upc-images` into the main bucket under `cubby/upc-images/<key>` and sets the
   row's `imageUrl` to its public URL. Without it, `imageUrl` stays null.

3. Verify: `SELECT source, status, count(*) FROM "UpcLookupCache" GROUP BY 1, 2`
   matches the dry-run counts.

`manual` rows are never overwritten or aged out by upcitemdb refreshes. Miss
rows use `ON CONFLICT DO NOTHING`, so a re-run cannot clobber newer answers.
