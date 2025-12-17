-- Update existing NULL userId values to the first member of the organization
UPDATE "AuditLog" a
SET "userId" = (
  SELECT m."userId"
  FROM "member" m
  WHERE m."organizationId" = a."organizationId"
  LIMIT 1
)
WHERE a."userId" IS NULL;--> statement-breakpoint

-- Delete any audit log entries that still have no user (orphaned orgs)
DELETE FROM "AuditLog" WHERE "userId" IS NULL;--> statement-breakpoint

ALTER TABLE "AuditLog" ALTER COLUMN "userId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "AuditLog" ADD COLUMN "source" text DEFAULT 'ui' NOT NULL;
