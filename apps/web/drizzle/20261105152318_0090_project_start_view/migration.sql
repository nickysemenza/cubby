SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE OR REPLACE VIEW "ProjectStartDateView" AS SELECT "Project".id AS "entityId", 'project'::text AS kind,
    to_jsonb(d.value::text) AS value, d.value::timestamp AS "sortDate", NULL::double precision AS "sortNumber", NULL::text AS "sortText",
    jsonb_build_object('outcome', CASE WHEN d.value IS NULL THEN '{"kind":"empty","reason":"unset"}'::jsonb ELSE '{"kind":"value"}'::jsonb END,
      'provenance'::text, CASE WHEN "Project"."startDate" IS NULL THEN '{"kind":"computed"}'::jsonb ELSE '{"kind":"own","ownership":{"kind":"record"}}'::jsonb END) AS "decidedBy",
    d."computedAt" AS "computedAt"
    FROM "Project" JOIN "Entity" identity ON identity.id = "Project".id AND identity.kind = 'project'
    JOIN (
  SELECT p.id AS "entityId",
    coalesce(p."startDate", (s.rollups #>> '{dateWindow,derivedStart}')::date) AS value,
    CASE WHEN p."startDate" IS NOT NULL THEN now() AT TIME ZONE 'UTC'
      ELSE s."rollupsComputedAt" END AS "computedAt"
  FROM "Project" p LEFT JOIN "ProjectReadSnapshot" s ON s."entityId" = p.id
  WHERE "p"."deletedAt" is null) d ON d."entityId" = "Project".id
    WHERE "Project"."deletedAt" is null AND "identity"."deletedAt" is null;
