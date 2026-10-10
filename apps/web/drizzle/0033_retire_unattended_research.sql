-- ADR 0010: unattended Mail import stays in Pi; Product research moves to
-- interactive Burn-down. Runs after the code that stopped writing research
-- facts is deployed (the old code was their only writer), and before the
-- contract migration that drops the retired research tables.

-- 1. Supported research provenance becomes Sources. A fact on a record merged
--    away since it was recorded moves to the survivor (one hop: merges point
--    every loser at the final survivor). A string value keeps its field scope
--    and the Source writer's fingerprint (sha256 of the canonical JSON of the
--    value as an entity read returns it): a `categoryId` fact stores the
--    category's uuid, which reads as its public shortcode. Other values become
--    record-level Sources. Retired support and unsupported facts are not
--    copied.
INSERT INTO "EntitySource" (
  "entityId", "entityKind", "fieldPath", "url", "quote", "observedAt",
  "selectedVariant", "valueFingerprint", "userId", "channel",
  "oauthClientId", "runId", "createdAt"
)
SELECT
  coalesce(entity."mergedIntoId", entity."id"),
  fact."entityKind",
  CASE
    WHEN fact."fieldPath" = 'categoryId' AND category."id" IS NULL THEN NULL
    WHEN jsonb_typeof(fact."value") = 'string' THEN fact."fieldPath"
  END,
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
    WHEN fact."fieldPath" = 'categoryId' AND category."id" IS NULL THEN NULL
    WHEN fact."fieldPath" = 'categoryId'
      THEN encode(sha256(convert_to(to_jsonb(category."shortcode")::text, 'UTF8')), 'hex')
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
LEFT JOIN "ProductCategory" category
  ON fact."fieldPath" = 'categoryId'
  AND category."id"::text = fact."value" #>> '{}'
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
