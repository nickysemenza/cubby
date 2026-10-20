-- The approved breaking cutover keeps services enabled. Block concurrent old citation
-- writes and destination edits inside this transaction; an old writer may fail after DROP.
LOCK TABLE "EntitySource" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "Entity" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE research_notes_transfer ON COMMIT DROP AS
SELECT s.id, s."entityKind" AS kind,
       coalesce(owner."mergedIntoId", owner.id) AS "destinationId",
       s."createdAt",
       concat_ws(E'\n',
         'Research recorded ' || to_char(s."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
         CASE WHEN owner."mergedIntoId" IS NOT NULL THEN 'Original record: ' || coalesce(owner.shortcode, owner.id::text) END,
         CASE WHEN s."fieldPath" IS NOT NULL THEN 'Field: ' || s."fieldPath" END,
         CASE WHEN s."selectedVariant" IS NOT NULL THEN 'Selected variant: ' || s."selectedVariant" END,
         CASE WHEN s."observedAt" IS NOT NULL THEN 'Observed: ' || to_char(s."observedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
         s.quote,
         CASE WHEN s.url IS NOT NULL THEN 'URL: ' || s.url END,
         CASE WHEN s."sourceEntityId" IS NOT NULL THEN 'Record: ' || coalesce(target_survivor.shortcode, target.shortcode, s."sourceEntityKind" || ':' || s."sourceEntityId"::text) END,
         'Recorded by: ' || s."userId" || ' via ' || s.channel,
         CASE WHEN s."oauthClientId" IS NOT NULL THEN 'Client: ' || s."oauthClientId" END,
         CASE WHEN s."runId" IS NOT NULL THEN 'Run: ' || coalesce(recorder_run.shortcode, s."runId"::text) END,
         CASE WHEN s."deviceId" IS NOT NULL THEN 'Device: ' || coalesce(recorder_device.shortcode, s."deviceId"::text) END
       ) AS body,
       false AS copied
FROM "EntitySource" s
JOIN "Entity" owner ON owner.id = s."entityId" AND owner.kind = s."entityKind"
LEFT JOIN "Entity" target ON target.id = s."sourceEntityId"
LEFT JOIN "Entity" target_survivor ON target_survivor.id = target."mergedIntoId"
LEFT JOIN "Run" recorder_run ON recorder_run.id = s."runId"
LEFT JOIN "Device" recorder_device ON recorder_device.id = s."deviceId";
--> statement-breakpoint
DO $$
DECLARE
  destination record;
  missing bigint;
BEGIN
  -- Destination names come from the catalog, never from quoted research text.
  FOR destination IN
    SELECT DISTINCT t.kind, c.table_name
    FROM research_notes_transfer t
    JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.column_name = 'notes'
      AND lower(c.table_name) = lower(t.kind)
    ORDER BY c.table_name
  LOOP
    EXECUTE format('LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE', destination.table_name);
  END LOOP;

  IF (SELECT count(*) FROM research_notes_transfer) <> (SELECT count(*) FROM "EntitySource") THEN
    RAISE EXCEPTION 'Research notes destination missing for a Source identity';
  END IF;

  FOR destination IN
    SELECT DISTINCT t.kind, c.table_name
    FROM research_notes_transfer t
    JOIN information_schema.columns c
      ON c.table_schema = 'public' AND c.column_name = 'notes'
      AND lower(c.table_name) = lower(t.kind)
    ORDER BY c.table_name
  LOOP
    EXECUTE format($copy$
      WITH grouped AS (
        SELECT "destinationId", string_agg(body, E'\n\n' ORDER BY "createdAt", id) AS body
        FROM research_notes_transfer WHERE kind = $1 GROUP BY "destinationId"
      ), original AS MATERIALIZED (
        SELECT p.id, p.notes FROM %I p JOIN grouped g ON g."destinationId" = p.id
      ), updated AS (
        UPDATE %I p SET notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN g.body ELSE p.notes || E'\n\n' || g.body END
        FROM grouped g WHERE p.id = g."destinationId"
        RETURNING p.id, p.notes
      )
      UPDATE research_notes_transfer t SET copied = true
      FROM updated p JOIN original o ON o.id = p.id
      WHERE t.kind = $1 AND t."destinationId" = p.id
        AND position(t.body IN p.notes) > 0
        AND (o.notes IS NULL OR left(p.notes, char_length(o.notes)) = o.notes)
    $copy$, destination.table_name, destination.table_name) USING destination.kind;
  END LOOP;

  SELECT count(*) INTO missing FROM research_notes_transfer WHERE NOT copied;
  IF missing <> 0 THEN
    RAISE EXCEPTION 'Research notes destination missing or preservation failed for % Sources', missing;
  END IF;
END $$;
--> statement-breakpoint
-- The existing background framework refreshes search/AI inputs after the note transfer.
INSERT INTO "DerivedRefreshCaptureInbox" ("entityId", "entityKind", change, "inputFingerprint")
SELECT "destinationId", kind,
       jsonb_build_object('entityKind', kind, 'entityId', "destinationId", 'changedFields', jsonb_build_array('notes')),
       md5(string_agg(body, E'\n\n' ORDER BY "createdAt", id))
FROM research_notes_transfer GROUP BY "destinationId", kind;
--> statement-breakpoint
DELETE FROM "DerivedRefreshObservedInput" WHERE scope = 'context:EntitySource';
--> statement-breakpoint
DELETE FROM "DerivedRefreshRevision" WHERE key = 'context:EntitySource';
--> statement-breakpoint
DROP TABLE "EntitySource";
