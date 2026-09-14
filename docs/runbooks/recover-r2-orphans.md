# Recover orphaned R2 objects

The `Image` row is the only database record of an object's R2 key, and
`deleteStoredObjects` swallows failures by contract (a failed object delete only
strands bytes). Any path that removes rows without their objects therefore
creates orphans that are unrecoverable from the database — silently.

Recovery is a bucket listing, not a query:

1. Sign a `list-type=2` GET with `aws4fetch` (the repo's S3 client — not
   `@aws-sdk/client-s3`) against `$R2_ENDPOINT/$R2_BUCKET_NAME`, paging on
   `NextContinuationToken`. Put the script under `apps/web/scripts/` (ESM,
   top-level `await` is fine); a scratchpad script outside `apps/web` cannot
   resolve the workspace's dependencies.
2. Subtract `SELECT key FROM "Image"` **including soft-deleted rows** — they
   still name their object.
3. Ignore two prefixes that a naive diff over-reports ~4×: `vendors/*` (vendor
   logos seeded by `seed-vendor-logos.ts`, referenced by URL convention rather
   than an `Image` row — in active use) and `recipehub-dev/*` (another app's
   legacy prefix). Only `cubby/images/*` is a genuine Cubby orphan set.

`R2_BUCKET_NAME` in `apps/web/.env` looks like a placeholder but is the real
bucket (it matches `R2_PUBLIC_URL`). The fastest existence check for one key is
`curl -I $R2_PUBLIC_URL/<key>` — 200 means the object is still there.
