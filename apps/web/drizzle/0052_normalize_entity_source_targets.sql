-- Post-deployment only: old merge writers must finish before URLs are cleared.
-- Preserve citation metadata and fingerprints; unresolved URLs remain intact.
WITH candidates AS (
  SELECT "id", upper(substring("url" FROM '[^/?#]+(?=/*(?:[?#].*)?$)')) AS code
  FROM "EntitySource"
  WHERE "sourceEntityId" IS NULL
    AND "url" ~* '^https://cubby\.nickysemenza\.com(:443)?/'
), normalized AS (
  -- Frozen inbound-only label aliases from the shortcode contract at cutover.
  SELECT "id", CASE
    WHEN code LIKE 'P-%' THEN 'PRD-' || substring(code FROM 3)
    WHEN code LIKE 'L-%' THEN 'LOC-' || substring(code FROM 3)
    ELSE code
  END AS code
  FROM candidates
), targets AS (
  SELECT normalized."id" AS "sourceId", canonical."id", canonical."kind"
  FROM normalized
  JOIN "Entity" target ON target."shortcode" = normalized.code
  JOIN "Entity" canonical ON canonical."id" = COALESCE(target."mergedIntoId", target."id")
    AND canonical."kind" = target."kind"
)
UPDATE "EntitySource" source
SET "sourceEntityId" = targets."id", "sourceEntityKind" = targets."kind", "url" = NULL
FROM targets WHERE source."id" = targets."sourceId";
