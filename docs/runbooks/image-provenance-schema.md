# Image provenance and devices schema rollout

Delivered in parts, one per PR in `docs/plans/image-provenance-and-devices.md`.
Each part's SQL is additive (new table or nullable columns only) and is
expand-before-deploy: apply the schema change, confirm it read back correctly,
THEN deploy the code that reads/writes it. No part here requires a backfill
for deploy compatibility.

## Part 1 — `Device`

New table, no existing rows to migrate. Idempotent SQL:

```sql
CREATE TABLE IF NOT EXISTS "Device" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shortcode" text NOT NULL,
  "installationId" text NOT NULL,
  "name" text NOT NULL,
  "platform" text NOT NULL,
  "appVersion" text,
  "osVersion" text,
  "lastSeenAt" timestamp,
  "automaticWork" boolean NOT NULL DEFAULT true,
  "remotePaused" boolean NOT NULL DEFAULT false,
  "ledgerPartyId" uuid REFERENCES "LedgerParty"("id"),
  "productId" uuid REFERENCES "Product"("id"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "deletedAt" timestamp
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Device_platform_check'
  ) THEN
    ALTER TABLE "Device"
      ADD CONSTRAINT "Device_platform_check"
      CHECK ("platform" IN ('ios', 'macos'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "Device_shortcode_unique" ON "Device" ("shortcode");

CREATE UNIQUE INDEX IF NOT EXISTS "Device_installationId_key"
  ON "Device" ("installationId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Device_ledgerPartyId_idx" ON "Device" ("ledgerPartyId");
CREATE INDEX IF NOT EXISTS "Device_productId_idx" ON "Device" ("productId");
```

Expand-before-deploy order:

1. Apply the SQL above against production. `CREATE TABLE IF NOT EXISTS` and
   `CREATE INDEX IF NOT EXISTS` make every statement safe to re-run.
2. Read the table definition back (`\d "Device"` in `psql`, or the equivalent
   `information_schema.columns` query) and confirm: every column's
   nullability matches the list above, the `Device_platform_check` constraint
   exists and is valid, `Device_installationId_key` is a unique index scoped
   by `"deletedAt" IS NULL` (not a plain unique constraint — a soft-deleted
   device must not block a fresh install claiming the same `installationId`),
   and both FK columns reference live tables.
3. Deploy the code that reads/writes `Device` (this PR): the companion durable
   object's hello handler, the generic entity CRUD/MCP surface, and the web
   list/detail pages. All new companion wire fields (`participation` on hello,
   the `helloAck` server message) are exercised by every hello after this
   deploy — there is no older-client compatibility branch to preserve for this
   field, so this deploy and the native build that sends `participation` must
   land together.

No rollback concern beyond the usual: dropping the table is safe as long as
no deployed code still references it (`Device` carries no incoming edges from
any other table in this PR — see `entity-edges.ts`'s empty `device: edges({})`
block — so there is nothing else to clean up first).

## Part 2 — `ImageSighting`, and `Image`'s derived capture columns

New table plus nullable/additive columns on the existing `Image` table — no
backfill required for deploy compatibility; every new column defaults to a
value that reads as "nothing derived yet". Idempotent SQL:

```sql
-- Image: new derived capture columns, and the `screenshot` source value.
-- `source` and `captureAttribution` are TypeScript-level enums only — Image
-- has no CHECK constraint on either column today, so widening `source` to
-- include `screenshot` needs no ALTER beyond adding the columns below.
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "capturedAt" timestamp;
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "capturedAtOffsetMinutes" integer;
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "captureLocation" jsonb;
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "capturePlaceName" text;
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "captureDeviceLabel" text;
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "capturedByPartyId" uuid
  REFERENCES "LedgerParty"("id");
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "captureAttribution" text
  NOT NULL DEFAULT 'none';
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "provenanceEvidence" jsonb;
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "metadataRevision" integer;

CREATE INDEX IF NOT EXISTS "Image_capturedByPartyId_idx"
  ON "Image" ("capturedByPartyId");

-- ImageSighting: new table, no existing rows to migrate.
CREATE TABLE IF NOT EXISTS "ImageSighting" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "shortcode" text NOT NULL,
  "imageId" uuid NOT NULL REFERENCES "Image"("id"),
  "ledgerPartyId" uuid NOT NULL REFERENCES "LedgerParty"("id"),
  "deviceId" uuid NOT NULL REFERENCES "Device"("id"),
  "assetKey" text NOT NULL,
  "cloudIdentifier" text,
  "localIdentifier" text,
  "sourceType" text NOT NULL,
  "mediaSubtypes" text[] NOT NULL DEFAULT '{}'::text[],
  "originalFilename" text,
  "pixelWidth" integer,
  "pixelHeight" integer,
  "hasAdjustments" boolean NOT NULL DEFAULT false,
  "capturedAt" timestamp,
  "capturedAtOffsetMinutes" integer,
  "addedAt" timestamp,
  "location" jsonb,
  "placeName" text,
  "camera" jsonb,
  "matchKind" text NOT NULL,
  "hashDistance" integer,
  "aspectGate" boolean,
  "observedAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "deletedAt" timestamp
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ImageSighting_sourceType_check'
  ) THEN
    ALTER TABLE "ImageSighting"
      ADD CONSTRAINT "ImageSighting_sourceType_check"
      CHECK ("sourceType" IN ('userLibrary', 'cloudShared', 'iTunesSynced'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ImageSighting_matchKind_check'
  ) THEN
    ALTER TABLE "ImageSighting"
      ADD CONSTRAINT "ImageSighting_matchKind_check"
      CHECK ("matchKind" IN ('import', 'libraryMatch'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "ImageSighting_shortcode_unique"
  ON "ImageSighting" ("shortcode");

CREATE UNIQUE INDEX IF NOT EXISTS "ImageSighting_image_party_asset_key"
  ON "ImageSighting" ("imageId", "ledgerPartyId", "assetKey")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "ImageSighting_imageId_idx" ON "ImageSighting" ("imageId");
CREATE INDEX IF NOT EXISTS "ImageSighting_ledgerPartyId_idx" ON "ImageSighting" ("ledgerPartyId");
CREATE INDEX IF NOT EXISTS "ImageSighting_deviceId_idx" ON "ImageSighting" ("deviceId");
```

Expand-before-deploy order:

1. Apply the SQL above against production, after Part 1's `Device` table
   already exists (`ImageSighting.deviceId` references it). Every statement
   is safe to re-run: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT
   EXISTS`, `CREATE INDEX IF NOT EXISTS`, and the constraint block's own
   `pg_constraint` guard.
2. Read the schema back and confirm: `Image` has all nine new columns with
   the nullability above and `captureAttribution` defaulting to `'none'`;
   `ImageSighting` has both check constraints valid, `ImageSighting_
   image_party_asset_key` is a unique index scoped by `"deletedAt" IS NULL`
   (not a plain unique constraint — a soft-deleted sighting must not block a
   fresh report for the same image/party/asset), and all three FK columns
   (`imageId`, `ledgerPartyId`, `deviceId`) reference live tables.
3. Deploy the code that reads/writes both (this PR): the `ImageSighting`
   adapter and its `deriveAndStoreImageCapture` hook, the generic entity
   CRUD/MCP surface for `imageSighting`, the photo-import commit's per-item
   `library` block, the `attach_files` source/provenance fix, and the web
   list/detail pages for both entities. Every new field is additive and
   nullable/defaulted, so an older native build that doesn't send a
   `library` block or a `deviceId` on commit stays valid throughout — it
   simply produces no sighting for that upload, the same as before this PR.

No rollback concern beyond the usual: dropping `ImageSighting` and the nine
`Image` columns is safe as long as no deployed code still references them.
`ImageSighting` carries no incoming edges from any other table (nothing
references a sighting by id), so there is nothing else to clean up first;
`Image.capturedByPartyId` is the only new FK *from* this PR's columns, and it
is nullable, so dropping it does not require detaching anything first either.

## Part 3 — `Image.embeddedMetadata`

One new nullable column, read only by the `image-metadata.extract`
background task and `deriveAndStoreImageCapture`'s EXIF fallback. No backfill
required for deploy compatibility — a row with no `embeddedMetadata` yet
simply has no EXIF evidence, same as before this part. Idempotent SQL:

```sql
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "embeddedMetadata" jsonb;
```

Expand-before-deploy order:

1. Apply the SQL above against production.
2. Read the table definition back and confirm `Image.embeddedMetadata` exists
   and is nullable with no default.
3. Deploy the code that reads/writes it (PR6): the `image-metadata.extract`
   background task, `deriveAndStoreImageCapture`'s EXIF read, and
   `backfillImageMetadata` maintenance. `Image.metadataRevision` (added in
   Part 2, always nullable) is the stale marker this part's background task
   advances to `IMAGE_METADATA_REVISION`; a row with `metadataRevision IS
   NULL` or below the current revision is a candidate for extraction.

No rollback concern beyond the usual: dropping the column is safe as long as
no deployed code still references it — nothing else stores an incoming
reference to it.

## Later parts

None outstanding. PR 3b's `imageList` move onto `listScaffold`, Image data
quality, and `classifyImageProvenance` heuristics landed entirely in
application code — no schema change of their own.
