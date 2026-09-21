-- Additive schema preparation. Run before deploying the new code.
BEGIN;
ALTER TABLE "InventoryEntry" ADD COLUMN IF NOT EXISTS "ownershipMode" text NOT NULL DEFAULT 'inherit';
ALTER TABLE "InventoryEntry" ADD COLUMN IF NOT EXISTS "ownerLedgerPartyId" uuid REFERENCES "LedgerParty"(id);
ALTER TABLE "VendorAccount" ADD COLUMN IF NOT EXISTS "inventoryOwnerDefaultEnabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "FinancialAccount" ADD COLUMN IF NOT EXISTS "inventoryOwnerDefaultEnabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "useOriginal" boolean NOT NULL DEFAULT false;
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS "resultSchemaRevision" integer;
ALTER TABLE "AiAnalysis" ADD COLUMN IF NOT EXISTS runtime jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InventoryEntry_ownership_valid' AND conrelid = '"InventoryEntry"'::regclass) THEN
    ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_ownership_valid" CHECK (
      ("ownershipMode" = 'person' AND "ownerLedgerPartyId" IS NOT NULL)
      OR ("ownershipMode" IN ('inherit', 'unassigned') AND "ownerLedgerPartyId" IS NULL)
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "InventoryEntry_owner_idx" ON "InventoryEntry"("ownerLedgerPartyId");

CREATE TABLE IF NOT EXISTS "ImageDerivative" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "imageId" uuid NOT NULL REFERENCES "Image"(id),
  purpose text NOT NULL CONSTRAINT "ImageDerivative_purpose_check" CHECK (purpose IN ('transparent')),
  status text NOT NULL CONSTRAINT "ImageDerivative_status_check" CHECK (status IN ('pending','ready','skipped','failed','abandoned')),
  key text NOT NULL, "sourceContentHash" text NOT NULL, "processorRevision" integer NOT NULL,
  "contentType" text, sha256 text, width integer, height integer, "failureReason" text,
  "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(), "deletedAt" timestamp,
  CONSTRAINT "ImageDerivative_ready_metadata_check" CHECK (status <> 'ready' OR (
    "contentType" IS NOT NULL AND "contentType" = 'image/png' AND sha256 IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND width > 0 AND height > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImageDerivative_image_purpose_source_revision_key" ON "ImageDerivative"("imageId",purpose,"sourceContentHash","processorRevision") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "ImageDerivative_storage_key_key" ON "ImageDerivative"(key) WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "ImageDerivative_image_idx" ON "ImageDerivative"("imageId");
CREATE INDEX IF NOT EXISTS "ImageDerivative_status_idx" ON "ImageDerivative"(status);

CREATE TABLE IF NOT EXISTS "ImageProcessingJob" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "imageId" uuid NOT NULL REFERENCES "Image"(id),
  "derivativeId" uuid REFERENCES "ImageDerivative"(id),
  kind text NOT NULL CONSTRAINT "ImageProcessingJob_kind_check" CHECK (kind IN ('subject_lift','describe_image')),
  state text NOT NULL CONSTRAINT "ImageProcessingJob_state_check" CHECK (state IN ('pending','waiting_for_device','leased','ready','skipped','failed')),
  "sourceContentHash" text NOT NULL, "processorRevision" integer NOT NULL,
  "attemptId" uuid, "leaseExpiresAt" timestamp, attempts integer NOT NULL DEFAULT 0 CONSTRAINT "ImageProcessingJob_attempts_check" CHECK (attempts >= 0),
  "nextAttemptAt" timestamp NOT NULL DEFAULT now(), "dispatchedAt" timestamp, "completedAt" timestamp,
  "lastError" text, runtime jsonb, result jsonb,
  "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "ImageProcessingJob_lease_check" CHECK ((state = 'leased') = ("attemptId" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImageProcessingJob_identity_key" ON "ImageProcessingJob"("imageId",kind,"sourceContentHash","processorRevision");
CREATE INDEX IF NOT EXISTS "ImageProcessingJob_dispatch_idx" ON "ImageProcessingJob"(state,"nextAttemptAt");
CREATE INDEX IF NOT EXISTS "ImageProcessingJob_image_idx" ON "ImageProcessingJob"("imageId");

CREATE TABLE IF NOT EXISTS "ImageDescriptionCorrection" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "imageId" uuid NOT NULL REFERENCES "Image"(id),
  description text NOT NULL, "confirmedAt" timestamp NOT NULL DEFAULT now(), "deletedAt" timestamp
);
CREATE INDEX IF NOT EXISTS "ImageDescriptionCorrection_image_idx" ON "ImageDescriptionCorrection"("imageId");
CREATE UNIQUE INDEX IF NOT EXISTS "ImageDescriptionCorrection_active_image_key" ON "ImageDescriptionCorrection"("imageId") WHERE "deletedAt" IS NULL;
CREATE TABLE IF NOT EXISTS "ImageProcessingOrphan" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL, "attemptId" uuid, reason text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ImageProcessingOrphan_key_key" ON "ImageProcessingOrphan"(key);
CREATE INDEX IF NOT EXISTS "ImageProcessingOrphan_createdAt_idx" ON "ImageProcessingOrphan"("createdAt");
COMMIT;
