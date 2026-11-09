-- Lock waits fail fast instead of queueing every Email reader behind this
-- migration; the runner's transaction rolls back whole and Deploy stops.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Serialization boundary: every admission, transfer and roster append writes
-- "Run", so this lock (held to commit) freezes the rosters the attempt
-- counts are aggregated from. Run reads continue; Run writers wait for the
-- seconds the aggregation and the Email rewrite take. Admission locks Email
-- rows before inserting its Run, so a concurrent admission can deadlock with
-- the later Email lock; Postgres aborts one side, the whole migration rolls
-- back, and the runner retries deadlock and lock-timeout failures.
LOCK TABLE "Run" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- The revision fence now reads the frozen input, which a release never
-- clears; carry each sender-proof revision out of its replay key.
UPDATE "Run"
SET input = input || jsonb_build_object('evidenceRevision', substring("clientKey" from 'sender-proof:([0-9a-f]{64}):'))
WHERE purpose = 'mail_import' AND jsonb_typeof(input) = 'object'
  AND NOT input ? 'evidenceRevision'
  AND substring("clientKey" from 'sender-proof:([0-9a-f]{64}):') IS NOT NULL;
--> statement-breakpoint
-- Roster aggregation reads Run and Email under ordinary snapshots, before any
-- Email lock: every Mail import Run (deleted ones included) that admitted an
-- Email at its current checksum, keyed by the evidence revision it attempted
-- (the checksum, plus `:<evidenceRevision>` for a recheck admission).
CREATE TEMP TABLE email_import_admission ON COMMIT DROP AS
SELECT e.id AS email_id,
  e.checksum || coalesce(':' || (r.input->>'evidenceRevision'), '') AS revision,
  r.id AS run_id, r."startedAt" AS started_at, r.status AS run_status,
  r."deletedAt" AS run_deleted_at
FROM "Run" r
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(r.input->'sources') = 'array' THEN r.input->'sources' ELSE '[]'::jsonb END
) source
JOIN "Email" e ON e."orderMailId"::text = source->>'orderMailId'
  AND e.checksum = source->>'checksum'
WHERE r.purpose = 'mail_import';
--> statement-breakpoint
-- The counter follows the revision that would admit each Email next: plain
-- admissions of its checksum for an unheld pending Email (discovery's next
-- attempt), otherwise its latest attempted revision.
CREATE TEMP TABLE email_import_attempts ON COMMIT DROP AS
SELECT latest.email_id, latest.revision, counted.attempts,
  plain.attempts AS plain_attempts,
  latest.run_id AS latest_run_id, latest.run_status AS latest_run_status,
  latest.run_deleted_at AS latest_run_deleted_at
FROM (
  SELECT DISTINCT ON (email_id) *
  FROM email_import_admission
  ORDER BY email_id, started_at DESC NULLS LAST, run_id DESC
) latest
JOIN (
  SELECT email_id, revision, count(DISTINCT run_id)::int AS attempts
  FROM email_import_admission
  GROUP BY email_id, revision
) counted ON counted.email_id = latest.email_id AND counted.revision = latest.revision
LEFT JOIN (
  SELECT email_id, count(DISTINCT run_id)::int AS attempts
  FROM email_import_admission
  WHERE strpos(revision, ':') = 0
  GROUP BY email_id
) plain ON plain.email_id = latest.email_id;
--> statement-breakpoint
CREATE UNIQUE INDEX ON email_import_attempts (email_id);
--> statement-breakpoint
-- From here the Email table is ACCESS EXCLUSIVE until commit: column
-- additions are catalog-only, and the rewrites below join precomputed rows by
-- primary key.
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
-- The checksum is rechecked under the lock; a row changed since aggregation
-- keeps no count, as a never-admitted Email would.
UPDATE "Email" e
SET "importAttempts" = CASE
  WHEN e.status = 'pending' AND e."runId" IS NULL AND a.plain_attempts IS NOT NULL
  THEN jsonb_build_object('revision', e.checksum, 'count', a.plain_attempts)
  ELSE jsonb_build_object('revision', a.revision, 'count', a.attempts) END
FROM email_import_attempts a
WHERE e.id = a.email_id AND split_part(a.revision, ':', 1) = e.checksum;--> statement-breakpoint
-- A released Email that already used every plain attempt would otherwise sit
-- `pending` forever, out of both discovery and evidence recovery: hold it
-- `unsettled` with the latest ended Run that attempted it, so only a new
-- evidence revision readmits it.
UPDATE "Email" e
SET status = 'unsettled', "runId" = a.latest_run_id
FROM email_import_attempts a
WHERE e.id = a.email_id AND split_part(a.revision, ':', 1) = e.checksum
  AND a.plain_attempts >= 3
  AND a.latest_run_deleted_at IS NULL
  AND a.latest_run_status IN ('completed', 'needs_review', 'failed', 'dispatch_failed')
  AND e.status = 'pending' AND e."runId" IS NULL AND e.classification = 'related'
  AND e."deletedAt" IS NULL;--> statement-breakpoint
ALTER TABLE "Email" ADD CONSTRAINT "Email_status_check" CHECK ("status" IN ('pending', 'researching', 'completed', 'unsettled', 'deleted', 'excluded'));
