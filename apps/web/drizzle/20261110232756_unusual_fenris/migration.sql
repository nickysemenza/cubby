SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
-- The per-provider-id consolidation below runs about 10k groups under exclusive locks.
SET LOCAL statement_timeout = '30min';
--> statement-breakpoint
LOCK TABLE "Entity", "FinancialTransaction", "SourceOccurrence", "SourceTransactionRecord", "FinancialEvidenceAlias", "Suggestion" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS archive;
--> statement-breakpoint
CREATE TABLE archive."SourceOccurrence_convergence_preimage" AS TABLE "SourceOccurrence";
--> statement-breakpoint
CREATE TABLE archive."SourceTransactionRecord_convergence_preimage" AS TABLE "SourceTransactionRecord";
--> statement-breakpoint
CREATE TABLE archive."FinancialEvidenceAlias_convergence_preimage" AS TABLE "FinancialEvidenceAlias";
--> statement-breakpoint
CREATE TABLE archive."Suggestion_convergence_preimage" AS TABLE "Suggestion";
--> statement-breakpoint
ALTER TABLE "SourceOccurrence" DROP CONSTRAINT "SourceOccurrence_unproven_check", DROP CONSTRAINT "SourceOccurrence_identityKind_check", DROP CONSTRAINT "SourceOccurrence_reviewState_check", DROP CONSTRAINT "SourceOccurrence_identity_check";
--> statement-breakpoint
UPDATE "SourceOccurrence" SET "identityKind"='legacy', "reviewState"='ready',
  "identityScope"=regexp_replace("identityScope", '^unproven-record:', 'legacy-record:')
WHERE "identityKind"='unproven';
--> statement-breakpoint
DO $migration$
DECLARE candidate record;
BEGIN
  FOR candidate IN
    SELECT owner.id, (array_agg(DISTINCT binding."historicalTransactionId"))[1] transaction_id
    FROM "SourceOccurrence" owner
    JOIN "FinancialEvidenceAlias" observed ON observed."occurrenceId"=owner.id
    JOIN "FinancialEvidenceAlias" binding ON binding.source=observed.source AND binding.value=observed.value AND binding."deletedAt" IS NULL
    JOIN "FinancialTransaction" ft ON ft.id=binding."historicalTransactionId" AND ft."deletedAt" IS NULL
    JOIN "SourceTransactionRecord" head ON head.id=owner."currentObservationId" AND head."deletedAt" IS NULL
    WHERE owner."identityKind"='legacy' AND owner."deletedAt" IS NULL AND owner."withdrawnAt" IS NULL
      AND owner."supersededByOccurrenceId" IS NULL
    GROUP BY owner.id, owner."createdAt"
    HAVING count(DISTINCT binding."historicalTransactionId")=1
    ORDER BY owner."createdAt", owner.id
  LOOP
    UPDATE "SourceOccurrence" owner SET "acceptedTransactionId"=candidate.transaction_id
    FROM "FinancialTransaction" ft, "SourceTransactionRecord" head
    WHERE owner.id=candidate.id AND ft.id=candidate.transaction_id AND head.id=owner."currentObservationId"
      AND ft."amountMinor"=head."amountMinor"
      AND (owner."accountId" IS NULL OR owner."accountId"=ft."accountId")
      AND NOT EXISTS (SELECT 1 FROM "SourceOccurrence" other WHERE other.source=owner.source
        AND other.id<>owner.id AND other."acceptedTransactionId"=ft.id);
  END LOOP;
END $migration$;
--> statement-breakpoint
-- Group live owners by provider transaction id. Ambiguous multi-id owners cannot be split without losing decisions.
CREATE TEMP TABLE monarch_owner_ids ON COMMIT DROP AS
SELECT DISTINCT owner.id, record."providerTransactionId" AS provider_id
FROM "SourceOccurrence" owner JOIN "SourceTransactionRecord" record ON record."occurrenceId"=owner.id
WHERE owner.source='monarch' AND owner."deletedAt" IS NULL AND owner."withdrawnAt" IS NULL
  AND owner."supersededByOccurrenceId" IS NULL AND record."deletedAt" IS NULL AND record."providerTransactionId" IS NOT NULL
UNION
SELECT owner.id, owner."providerIdentity" FROM "SourceOccurrence" owner
WHERE owner.source='monarch' AND owner."identityKind"='provider' AND owner."providerIdentity" IS NOT NULL
  AND owner."deletedAt" IS NULL AND owner."withdrawnAt" IS NULL AND owner."supersededByOccurrenceId" IS NULL;
--> statement-breakpoint
CREATE INDEX ON monarch_owner_ids (provider_id);
--> statement-breakpoint
CREATE INDEX ON monarch_owner_ids (id);
--> statement-breakpoint
ANALYZE monarch_owner_ids;
--> statement-breakpoint
DO $migration$
DECLARE grp record; survivor uuid; survivor_code text; template uuid; attempt int; decision_count int; transaction_count int; fact_count int; latest uuid; latest_time timestamp; accepted uuid; had_accepted boolean; evidence_conflict boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM monarch_owner_ids GROUP BY id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'A Monarch owner carries multiple provider ids; review before consolidation';
  END IF;
  CREATE TEMP TABLE monarch_upstream (id uuid, replacement uuid) ON COMMIT DROP;
  FOR grp IN SELECT provider_id FROM monarch_owner_ids GROUP BY provider_id ORDER BY provider_id LOOP
    SELECT (array_agg(o.id ORDER BY o."createdAt",o.id))[1] INTO template
      FROM "SourceOccurrence" o JOIN monarch_owner_ids m ON m.id=o.id WHERE m.provider_id=grp.provider_id;
    SELECT CASE WHEN count(*)=1 THEN (array_agg(o.id))[1] END INTO survivor
      FROM "SourceOccurrence" o JOIN monarch_owner_ids m ON m.id=o.id
      WHERE m.provider_id=grp.provider_id AND o."identityKind"='provider';
    UPDATE "SourceOccurrence" reserved SET "identityScope"='retired-provider:'||reserved.id::text
      WHERE reserved.source='monarch' AND reserved."identityKind"='provider'
        AND reserved."providerIdentity"=grp.provider_id AND reserved."identityScope"='provider:monarch'
        AND reserved.id IS DISTINCT FROM survivor;
    IF survivor IS NULL THEN
      survivor := gen_random_uuid();
      FOR attempt IN 1..100 LOOP
        SELECT 'SOC-'||string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',1+floor(random()*31)::int,1),'') INTO survivor_code FROM generate_series(1,5);
        EXIT WHEN NOT EXISTS(SELECT 1 FROM "Entity" WHERE shortcode=survivor_code);
      END LOOP;
      IF EXISTS(SELECT 1 FROM "Entity" WHERE shortcode=survivor_code) THEN RAISE EXCEPTION 'Cannot mint occurrence shortcode'; END IF;
      INSERT INTO "Entity" (id,kind,shortcode) VALUES(survivor,'sourceOccurrence',survivor_code);
      INSERT INTO "SourceOccurrence" (id,shortcode,source,"identityKind","identityScope","providerIdentity", "identityProof", "accountId", disposition, "dispositionReason", "dispositionNote", "lastObservedAt")
        SELECT survivor,survivor_code,'monarch','provider','provider:monarch',grp.provider_id,
          jsonb_build_object('kind','provider_id','source','monarch','provider',grp.provider_id),
          "accountId",disposition,"dispositionReason","dispositionNote","lastObservedAt" FROM "SourceOccurrence" WHERE id=template;
    END IF;
    SELECT count(DISTINCT jsonb_build_array(o."accountId",o.disposition,o."dispositionReason",o."dispositionNote")) INTO decision_count
      FROM "SourceOccurrence" o JOIN monarch_owner_ids m ON m.id=o.id WHERE m.provider_id=grp.provider_id;
    SELECT count(DISTINCT links.id), (array_agg(DISTINCT links.id))[1] INTO transaction_count, accepted FROM (
      SELECT o."acceptedTransactionId" AS id FROM "SourceOccurrence" o JOIN monarch_owner_ids m ON m.id=o.id
        JOIN "FinancialTransaction" ft ON ft.id=o."acceptedTransactionId" AND ft."deletedAt" IS NULL WHERE m.provider_id=grp.provider_id
      UNION
      SELECT ft.id FROM monarch_owner_ids m JOIN "FinancialEvidenceAlias" observed ON observed."occurrenceId"=m.id
        JOIN "FinancialEvidenceAlias" binding ON binding.source=observed.source AND binding.value=observed.value AND binding."deletedAt" IS NULL
        JOIN "FinancialTransaction" ft ON ft.id=binding."historicalTransactionId" AND ft."deletedAt" IS NULL WHERE m.provider_id=grp.provider_id
    ) links;
    SELECT EXISTS(SELECT 1 FROM "SourceOccurrence" prior JOIN monarch_owner_ids m ON m.id=prior.id
      WHERE m.provider_id=grp.provider_id AND prior."acceptedTransactionId"=accepted) INTO had_accepted;
    SELECT count(DISTINCT r."providerAccountId")>1 OR coalesce(bool_or(
      EXISTS (SELECT 1 FROM jsonb_array_elements(jsonb_build_array(r."providerData"->'id',r."providerData"->'transaction'->'id')) claim
        WHERE claim<>'null'::jsonb AND (jsonb_typeof(claim)<>'string' OR claim #>> '{}' <> grp.provider_id)) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(jsonb_build_array(r."providerData"->'account_id',r."providerData"->'transaction'->'account_id',
        CASE WHEN jsonb_typeof(r."providerData"->'account')='string' THEN r."providerData"->'account' ELSE r."providerData"->'account'->'id' END)) claim
        WHERE claim<>'null'::jsonb AND (jsonb_typeof(claim)<>'string' OR (r."providerAccountId" IS NOT NULL AND claim #>> '{}' <> r."providerAccountId")))
    ), false) INTO evidence_conflict FROM monarch_owner_ids m JOIN "SourceTransactionRecord" r ON r."occurrenceId"=m.id AND r."deletedAt" IS NULL
      WHERE m.provider_id=grp.provider_id;
    IF (SELECT count(DISTINCT account_id)>1 FROM (
      SELECT r."providerAccountId" AS account_id FROM monarch_owner_ids m JOIN "SourceTransactionRecord" r ON r."occurrenceId"=m.id
        WHERE m.provider_id=grp.provider_id AND r."deletedAt" IS NULL AND r."providerAccountId" IS NOT NULL
      UNION ALL
      SELECT claim #>> '{}' FROM monarch_owner_ids m JOIN "SourceTransactionRecord" r ON r."occurrenceId"=m.id
        CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(r."providerData"->'account_id',r."providerData"->'transaction'->'account_id',
          CASE WHEN jsonb_typeof(r."providerData"->'account')='string' THEN r."providerData"->'account' ELSE r."providerData"->'account'->'id' END)) claim
        WHERE m.provider_id=grp.provider_id AND r."deletedAt" IS NULL AND jsonb_typeof(claim)='string'
    ) accounts) THEN evidence_conflict := true; END IF;
    SELECT count(DISTINCT r."factFingerprint"), (array_agg(r.id ORDER BY b."observedAt" DESC, r."createdAt" DESC, r.id DESC))[1], max(b."observedAt")
      INTO fact_count, latest, latest_time FROM monarch_owner_ids m JOIN "SourceTransactionRecord" r ON r."occurrenceId"=m.id AND r."deletedAt" IS NULL
      JOIN "TransactionImport" b ON b.id=r."batchId" WHERE m.provider_id=grp.provider_id;
    -- Preserve accepted links as live historical evidence before clearing owners.
    INSERT INTO "FinancialEvidenceAlias" (source,kind,value,"occurrenceId","historicalTransactionId","provenanceKey",provenance,"scopeEvidence")
      SELECT 'monarch','transaction_ref','convergence:'||o.id::text,o.id,o."acceptedTransactionId",
        'convergence:'||o.id::text,jsonb_build_object('kind','convergence_preimage'),jsonb_build_object('kind','convergence')
      FROM "SourceOccurrence" o JOIN monarch_owner_ids m ON m.id=o.id
      WHERE m.provider_id=grp.provider_id AND o."acceptedTransactionId" IS NOT NULL;
    TRUNCATE monarch_upstream;
    INSERT INTO monarch_upstream SELECT u.id,u."replacementObservationId" FROM "SourceOccurrence" u
      JOIN monarch_owner_ids m ON m.id=u."supersededByOccurrenceId"
      WHERE m.provider_id=grp.provider_id AND m.id<>survivor;
    UPDATE "SourceOccurrence" u SET "replacementObservationId"=NULL FROM monarch_upstream p WHERE u.id=p.id;
    UPDATE "Suggestion" s SET active=false,status='superseded',"updatedAt"=now()
      FROM "SourceTransactionRecord" r JOIN "SourceOccurrence" old ON old.id=r."occurrenceId" JOIN monarch_owner_ids m ON m.id=old.id
      WHERE m.provider_id=grp.provider_id AND old.id<>survivor AND s.family='statement_transaction' AND s.status='pending' AND s.active
        AND s."recordId"=r.id AND s.data->>'chargeKey'=old.shortcode;
    UPDATE "SourceOccurrence" old SET "currentObservationId"=NULL,"accountId"=NULL,"acceptedTransactionId"=NULL,
      "supersededByOccurrenceId"=survivor,"replacementObservationId"=NULL,
      "identityProof"=jsonb_build_object('kind','consolidated','previousOwner',to_jsonb(old),'survivorId',survivor),
      version=old.version+1,"updatedAt"=now()
      FROM monarch_owner_ids m WHERE m.id=old.id AND m.provider_id=grp.provider_id AND old.id<>survivor;
    UPDATE "SourceTransactionRecord" r SET "occurrenceId"=survivor FROM monarch_owner_ids m
      WHERE r."occurrenceId"=m.id AND m.provider_id=grp.provider_id AND m.id<>survivor;
    UPDATE "FinancialEvidenceAlias" a SET "occurrenceId"=survivor FROM monarch_owner_ids m
      WHERE a."occurrenceId"=m.id AND m.provider_id=grp.provider_id AND m.id<>survivor;
    UPDATE "SourceOccurrence" u SET "supersededByOccurrenceId"=survivor,"replacementObservationId"=p.replacement
      FROM monarch_upstream p WHERE u.id=p.id;
    UPDATE "SourceOccurrence" o SET "identityScope"='provider:monarch',
      "identityProof"=jsonb_build_object('kind','provider_id','source','monarch','provider',grp.provider_id,'previousProof',o."identityProof"),
      "currentObservationId"=CASE WHEN fact_count=1 THEN latest END,
      "lastObservedAt"=coalesce(latest_time,o."lastObservedAt"),
      "acceptedTransactionId"=CASE WHEN transaction_count=1 AND decision_count=1 AND had_accepted
        AND NOT EXISTS (SELECT 1 FROM "SourceOccurrence" other WHERE other.source='monarch'
          AND other.id<>survivor AND other."acceptedTransactionId"=accepted AND other."supersededByOccurrenceId" IS NULL)
        THEN accepted END,
      "reviewState"=CASE WHEN transaction_count>1 OR decision_count>1 OR evidence_conflict THEN 'identity_conflict'
        WHEN fact_count>1 THEN 'revision_order_unknown'
        WHEN o."reviewState" IN ('unproven','identity_conflict') THEN 'ready' ELSE o."reviewState" END,
      version=o.version+1,"updatedAt"=now() WHERE o.id=survivor;
  END LOOP;
END $migration$;
--> statement-breakpoint
ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_identityKind_check" CHECK ("identityKind" IN ('legacy', 'provider', 'positioned', 'reviewed'));
--> statement-breakpoint
ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_reviewState_check" CHECK ("reviewState" IN ('ready', 'identity_conflict', 'judgment_conflict', 'ownership_conflict', 'revision_order_unknown', 'reappeared'));
--> statement-breakpoint
ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_identity_check" CHECK (("identityKind" = 'provider' AND "providerIdentity" IS NOT NULL AND "physicalImportId" IS NULL AND "physicalPosition" IS NULL) OR ("identityKind" = 'positioned' AND "providerIdentity" IS NULL AND "physicalImportId" IS NOT NULL AND "physicalPosition" > 0) OR ("identityKind" IN ('reviewed', 'legacy') AND "providerIdentity" IS NULL AND "physicalImportId" IS NULL AND "physicalPosition" IS NULL));
