ALTER TABLE "Email" ADD COLUMN "orderKeys" jsonb;--> statement-breakpoint
ALTER TABLE "Email" ADD COLUMN "trackingKeys" jsonb;--> statement-breakpoint
ALTER TABLE "Email" ADD COLUMN "mailKeysChecksum" text;--> statement-breakpoint
ALTER TABLE "Email" ADD COLUMN "importAttempts" jsonb;--> statement-breakpoint
ALTER TABLE "Email" DROP CONSTRAINT "Email_status_check";--> statement-breakpoint
-- `blocked` is retired. A held Email an attempt left without accepted or linked
-- evidence is `unsettled` and keeps its holder Run, outcomes and evidence. An
-- unheld one was retained without import content (ingest's other meaning) and
-- is `pending`. `updatedAt` stays throughout: evidence recovery compares it
-- with the holder's unresolved outcome.
UPDATE "Email" SET status = CASE WHEN "runId" IS NULL THEN 'pending' ELSE 'unsettled' END
WHERE status = 'blocked';--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_status_check" CHECK ("status" IN ('pending', 'researching', 'completed', 'unsettled', 'deleted', 'excluded'));--> statement-breakpoint
-- The revision fence now reads the frozen input, which a release never
-- clears; carry each sender-proof revision out of its replay key.
UPDATE "Run"
SET input = input || jsonb_build_object('evidenceRevision', substring("clientKey" from 'sender-proof:([0-9a-f]{64}):'))
WHERE purpose = 'mail_import' AND jsonb_typeof(input) = 'object'
  AND NOT input ? 'evidenceRevision'
  AND substring("clientKey" from 'sender-proof:([0-9a-f]{64}):') IS NOT NULL;--> statement-breakpoint
-- Every Mail import Run (deleted ones included) that admitted an Email at its
-- current checksum counts toward that revision's attempt bound.
UPDATE "Email" e
SET "importAttempts" = jsonb_build_object('checksum', e.checksum, 'count', admitted.attempts)
FROM (
  SELECT source->>'orderMailId' AS order_mail_id, source->>'checksum' AS checksum,
    count(DISTINCT r.id)::int AS attempts
  FROM "Run" r
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(r.input->'sources') = 'array' THEN r.input->'sources' ELSE '[]'::jsonb END
  ) source
  WHERE r.purpose = 'mail_import'
  GROUP BY 1, 2
) admitted
WHERE e."orderMailId"::text = admitted.order_mail_id AND e.checksum = admitted.checksum;--> statement-breakpoint
-- A released Email that already used every attempt would otherwise sit
-- `pending` forever, out of both discovery and evidence recovery: hold it
-- `unsettled` with the latest ended Run that attempted it, so only a new
-- evidence revision readmits it.
UPDATE "Email" e
SET status = 'unsettled', "runId" = latest.run_id
FROM (
  SELECT DISTINCT ON (source->>'orderMailId', source->>'checksum')
    source->>'orderMailId' AS order_mail_id, source->>'checksum' AS checksum,
    r.id AS run_id, r.status AS run_status
  FROM "Run" r
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(r.input->'sources') = 'array' THEN r.input->'sources' ELSE '[]'::jsonb END
  ) source
  WHERE r.purpose = 'mail_import' AND r."deletedAt" IS NULL
  ORDER BY source->>'orderMailId', source->>'checksum', r."startedAt" DESC NULLS LAST, r.id DESC
) latest
WHERE e."orderMailId"::text = latest.order_mail_id AND e.checksum = latest.checksum
  AND latest.run_status IN ('completed', 'needs_review', 'failed', 'dispatch_failed')
  AND e.status = 'pending' AND e."runId" IS NULL AND e.classification = 'related'
  AND e."deletedAt" IS NULL
  AND (e."importAttempts"->>'count')::int >= 3;
