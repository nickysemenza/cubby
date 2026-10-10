-- ADR 0008: unattended Mail import stays in Pi; Product research moves to
-- interactive Burn-down. This preserving step runs before the contract
-- migration that drops the retired research tables.

-- 1. Supported research provenance becomes Sources. A string value keeps its
--    field scope; its fingerprint matches the Source writer's (sha256 of the
--    canonical JSON of the value). Other values become record-level Sources.
--    Retired support and unsupported facts are not copied.
INSERT INTO "EntitySource" (
  "entityId", "entityKind", "fieldPath", "url", "quote", "observedAt",
  "selectedVariant", "valueFingerprint", "userId", "channel",
  "oauthClientId", "runId", "createdAt"
)
SELECT
  fact."entityId",
  fact."entityKind",
  CASE WHEN jsonb_typeof(fact."value") = 'string' THEN fact."fieldPath" END,
  CASE
    WHEN evidence."sourceMetadata"->>'sourceURL' ~ '^https?://'
      THEN left(evidence."sourceMetadata"->>'sourceURL', 2048)
  END,
  left(fact."support"->>'observation', 2000),
  CASE
    WHEN evidence."sourceMetadata"->>'capturedAt' ~ '^\d{4}-\d{2}-\d{2}T'
      THEN (evidence."sourceMetadata"->>'capturedAt')::timestamptz AT TIME ZONE 'UTC'
  END,
  left(fact."support"->'selectedVariant'->>'identity', 200),
  CASE
    WHEN jsonb_typeof(fact."value") = 'string'
      THEN encode(sha256(convert_to(fact."value"::text, 'UTF8')), 'hex')
  END,
  run."actorUserId",
  run."channel",
  run."oauthClientId",
  run."id",
  fact."createdAt"
FROM "RunFactEvidence" fact
JOIN "RunEvidence" evidence ON evidence."id" = fact."evidenceId"
JOIN "RunTarget" target ON target."id" = fact."targetId"
JOIN "Run" run ON run."id" = target."runId"
JOIN "Entity" entity
  ON entity."id" = fact."entityId" AND entity."kind" = fact."entityKind"
WHERE fact."supportRetiredAt" IS NULL
  AND nullif(trim(fact."support"->>'observation'), '') IS NOT NULL;
--> statement-breakpoint

-- 2. Findings whose fix interpreter or source evidence is retired lose their
--    Apply action: open ones are dismissed with a note, and no stored fix of a
--    retired kind survives.
UPDATE "RunFinding"
SET "status" = 'dismissed',
    "resolvedAt" = now(),
    "summary" = "summary" || ' (Dismissed: its browser research workflow was retired.)',
    "updatedAt" = now()
WHERE "status" = 'open'
  AND (
    "proposedFix"->>'kind' IN (
      'vendor_capture_profile', 'research_field_correction', 'validation_corrections'
    )
    OR "kind" IN ('auth_required', 'expected_order_not_found', 'receipt_required')
  );
--> statement-breakpoint
UPDATE "RunFinding"
SET "proposedFix" = NULL, "updatedAt" = now()
WHERE "proposedFix"->>'kind' IN (
  'vendor_capture_profile', 'research_field_correction', 'validation_corrections'
);
--> statement-breakpoint

-- 3. Unfinished Runs of retired purposes stop; their history stays readable.
UPDATE "Run"
SET "status" = 'failed',
    "failureCode" = 'retired_workflow',
    "endedAt" = coalesce("endedAt", now()),
    "updatedAt" = now()
WHERE "purpose" IN ('account_sync', 'purchase_validation', 'product_enrichment', 'mail_search')
  AND "status" IN (
    'running', 'paused_auth', 'paused_offline', 'paused_approval', 'dispatch_failed'
  );
