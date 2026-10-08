-- Existing proof is about its entity task. Preserve every accepted value and
-- source reference while making the canonical subject explicit.
UPDATE "RunFactEvidence" AS proof
SET "entityKind" = target."entityKind", "entityId" = target."entityId"
FROM "RunTarget" AS target
WHERE proof."targetId" = target.id
  AND proof."entityKind" IS NULL AND proof."entityId" IS NULL;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ALTER COLUMN "entityKind" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ALTER COLUMN "entityId" SET NOT NULL;
