ALTER TABLE "Image" ADD COLUMN "confirmedDescription" text;--> statement-breakpoint
ALTER TABLE "Image" ADD COLUMN "descriptionContentHash" text;--> statement-breakpoint
ALTER TABLE "Image" ADD COLUMN "descriptionConfirmedAt" timestamp;--> statement-breakpoint
ALTER TABLE "Image" ADD COLUMN "descriptionConfirmationOwner" jsonb;--> statement-breakpoint
-- Direct cutover: fence old confirmations/inference and content replacement through commit.
LOCK TABLE public."Suggestion", public."Image" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS archive;
--> statement-breakpoint
-- Retain all immutable evidence, historical confirmations and member decisions exactly.
CREATE TABLE archive."Suggestion_image_description" AS
SELECT * FROM public."Suggestion" WHERE family = 'image_description';
--> statement-breakpoint
DO $$
DECLARE
  source record;
  confirmed_at timestamp;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public."Suggestion" s
    FULL JOIN archive."Suggestion_image_description" a ON a.id = s.id
    WHERE (s.family = 'image_description' OR a.id IS NOT NULL)
      AND to_jsonb(s) IS DISTINCT FROM to_jsonb(a)
  ) THEN
    RAISE EXCEPTION 'Image description archive differs from source';
  END IF;

  -- Each live confirmation is copied and verified; the last live authority wins.
  FOR source IN SELECT s.*,
    (s.active AND s.entity = 'image' AND s.fingerprint = i.sha256 AND i."deletedAt" IS NULL
      AND (s.data->'confirmationOwner' IS NULL OR (
        s.data->'confirmationOwner'->>'kind' = 'member'
        AND pg_input_is_valid(s.data->'confirmationOwner'->>'effectId', 'uuid')
        AND pg_input_is_valid(s.data->'confirmationOwner'->>'commandFeedbackId', 'uuid')
        AND length(s.data->'confirmationOwner'->>'actorUserId') > 0
      ))) IS TRUE AS eligible
    FROM archive."Suggestion_image_description" s
    LEFT JOIN public."Image" i ON i.id = s."recordId"
    WHERE s."confirmedValue" @> '{"present":true}'::jsonb
    ORDER BY eligible, s."updatedAt", s.id
  LOOP
    -- Ineligible confirmations stay only in the verified archive, so historical
    -- shapes or since-deleted Images cannot block the cutover.
    CONTINUE WHEN NOT source.eligible;
    IF jsonb_typeof(source."confirmedValue"->'value') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Confirmed image description is not text: %', source.id;
    END IF;
    IF source.subject->>'recordId' IS DISTINCT FROM source."recordId"::text
      OR source.subject->>'contentHash' IS DISTINCT FROM source.fingerprint THEN
      RAISE EXCEPTION 'Confirmed image description subject differs from target: %', source.id;
    END IF;
    confirmed_at := coalesce(
      (SELECT max((d->>'createdAt')::timestamp)
       FROM jsonb_array_elements(source.decisions) d
       WHERE d @> '{"metadata":{"kind":"assessment_application"}}'::jsonb),
      source."updatedAt"
    );
    UPDATE public."Image" SET
      "confirmedDescription" = source."confirmedValue"->>'value',
      "descriptionContentHash" = source.fingerprint,
      "descriptionConfirmedAt" = confirmed_at,
      "descriptionConfirmationOwner" = source.data->'confirmationOwner'
    WHERE id = source."recordId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Confirmed image description has no Image: %', source.id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public."Image" i WHERE i.id = source."recordId"
        AND i."confirmedDescription" IS NOT DISTINCT FROM source."confirmedValue"->>'value'
        AND i."descriptionContentHash" IS NOT DISTINCT FROM source.fingerprint
        AND i."descriptionConfirmedAt" IS NOT DISTINCT FROM confirmed_at
        AND i."descriptionConfirmationOwner" IS NOT DISTINCT FROM source.data->'confirmationOwner'
    ) THEN
      RAISE EXCEPTION 'Image description copy differs from source: %', source.id;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Retire live family rows only after exact archive and per-confirmation verification.
DELETE FROM public."Suggestion" WHERE family = 'image_description';
