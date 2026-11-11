ALTER TABLE "Shipment" ADD COLUMN "orderId" text;--> statement-breakpoint
-- A Mail import Run whose every admitted Email holds a recorded outcome
-- finished its work. One stopped for review only because some Emails were
-- resolved unresolved reads completed, and its `unresolved_targets` finding
-- resolves: each unresolved Email is now its own Work item. A Run with any
-- other open finding, or an admitted Email without an outcome, is unchanged.
WITH settled AS (
  SELECT r.id FROM "Run" r
  WHERE r.purpose = 'mail_import' AND r.status = 'needs_review'
    AND r."deletedAt" IS NULL
    AND jsonb_array_length(coalesce(r.input->'sources', '[]'::jsonb)) > 0
    AND EXISTS (
      SELECT 1 FROM "RunFinding" f
      WHERE f."runId" = r.id AND f.status = 'pending' AND f.active
        AND f.kind = 'unresolved_targets'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "RunFinding" f
      WHERE f."runId" = r.id AND f.status = 'pending' AND f.active
        AND f.kind <> 'unresolved_targets'
    )
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.input->'sources') source
      WHERE NOT EXISTS (
        SELECT 1 FROM "Email" e
        JOIN "RunOperation" o ON o."runId" = r.id
          AND o.kind = 'target_outcome' AND o.state = 'completed'
          AND o.result->'target'->>'entityId' = e.id::text
        WHERE e."orderMailId"::text = source->>'orderMailId'
      )
    )
),
resolved AS (
  UPDATE "RunFinding" f SET
    status = 'resolved',
    active = false,
    "updatedAt" = now(),
    resolutions = f.resolutions || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(),
      'operationId', 'migration:mail-import-outcomes',
      'verdict', 'resolved',
      'correction', jsonb_build_object('present', false),
      'reason', 'Every admitted Email has a recorded import outcome.',
      'evidence', NULL,
      'intent', 'history',
      'authority', 'automatic',
      'actorUserId', NULL,
      'receipt', NULL,
      'metadata', NULL,
      'createdAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ))
  FROM settled
  WHERE f."runId" = settled.id AND f.status = 'pending' AND f.active
    AND f.kind = 'unresolved_targets'
  RETURNING f."runId"
)
UPDATE "Run" r SET status = 'completed', "updatedAt" = now()
FROM settled
WHERE r.id = settled.id
  AND EXISTS (SELECT 1 FROM resolved WHERE resolved."runId" = r.id);
