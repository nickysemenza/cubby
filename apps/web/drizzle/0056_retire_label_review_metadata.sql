-- Retired check metadata is separate from the photos, Sources and tag notes.
DELETE FROM "DataException"
WHERE "entityKind" = 'product' AND "check" = 'product_label_review';
--> statement-breakpoint
-- Identity exceptions retain their observed value, without a label-photo revision.
WITH label_bound AS (
  SELECT id, "check",
    substring(fingerprint FROM length("check") + 2)::jsonb AS inputs
  FROM "DataException"
  WHERE "entityKind" = 'product'
    AND "check" IN ('product_manufacturer', 'product_external_id', 'product_category')
    AND fingerprint LIKE "check" || ':[%label-v1:%'
)
UPDATE "DataException" AS exception
SET fingerprint = label_bound."check" || ':' || (label_bound.inputs -> 0)::text
FROM label_bound
WHERE exception.id = label_bound.id
  AND jsonb_typeof(label_bound.inputs) = 'array'
  AND jsonb_array_length(label_bound.inputs) = 2
  AND label_bound.inputs ->> 1 ~ '^label-v1:[0-9a-f]{32}$';
