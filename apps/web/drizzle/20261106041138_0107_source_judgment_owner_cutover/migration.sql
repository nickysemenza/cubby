-- One authoritative financial judgment per bank record; original annotations remain inert evidence.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DO $migration$
DECLARE
  attempt integer;
BEGIN
  LOCK TABLE public."Run", public."Job", public."RunStep" IN SHARE MODE;
  IF EXISTS (
    SELECT 1 FROM public."RunStep" step JOIN public."Run" run ON run.id=step."runId"
    WHERE (step.key LIKE 'statement\_%' ESCAPE '\' OR step.key LIKE 'transfer\_pair\_%' ESCAPE '\')
      AND step.state <> 'done'
      AND (run.status='running' OR step."runId"=(SELECT latest."runId" FROM public."RunStep" latest
        WHERE latest.key='statement_generate' ORDER BY latest."createdAt" DESC,latest.id DESC LIMIT 1))
      AND NOT (run.status='failed' AND run."failureCode" IS NOT DISTINCT FROM 'user_cancelled' AND run."endedAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public."Job" execution WHERE execution."runId"=run.id
          AND execution.state NOT IN ('completed','failed','cancelled')))
  ) THEN RAISE EXCEPTION 'Financial refresh has unfinished steps; complete or cancel it before the owner cutover'; END IF;
  LOCK TABLE public."Entity", public."FinancialAccount", public."FinancialTransaction", public."SourceOccurrence",
    public."SourceTransactionRecord", public."SourceObservationAnnotation", public."FinancialEvidenceAlias",
    public."TransactionImport", public."TransactionImportRecord", public."Suggestion",
    public."Expense", public."FinancialTransactionAllocation" IN ACCESS EXCLUSIVE MODE;
  CREATE TEMP TABLE owner_cutover_records ON COMMIT DROP AS TABLE public."SourceTransactionRecord";
  CREATE TEMP TABLE owner_cutover_annotations ON COMMIT DROP AS TABLE public."SourceObservationAnnotation";
  CREATE TEMP TABLE owner_cutover_aliases ON COMMIT DROP AS TABLE public."FinancialEvidenceAlias";
  CREATE TEMP TABLE owner_cutover_preservation ON COMMIT DROP AS
    SELECT 'owners' kind,to_jsonb(r) row FROM public."SourceOccurrence" r
    UNION ALL SELECT 'memberships',to_jsonb(r) FROM public."TransactionImportRecord" r
    UNION ALL SELECT 'transactions',to_jsonb(r) FROM public."FinancialTransaction" r
    UNION ALL SELECT 'expenses',to_jsonb(r) FROM public."Expense" r
    UNION ALL SELECT 'allocations',to_jsonb(r) FROM public."FinancialTransactionAllocation" r
    UNION ALL SELECT 'suggestions',jsonb_build_object('id',s.id,'hash',md5((to_jsonb(s)-'suppression')::text)) FROM public."Suggestion" s;
  IF EXISTS (SELECT 1 FROM public."SourceTransactionRecord" r LEFT JOIN public."SourceObservationAnnotation" a ON a."observationId"=r.id
    WHERE r."occurrenceId" IS NULL AND a."observationId" IS NULL) THEN
    RAISE EXCEPTION 'An ownerless bank record has no original judgment to preserve'; END IF;
  ALTER TABLE public."SourceOccurrence" DROP CONSTRAINT "SourceOccurrence_identityKind_check";
  ALTER TABLE public."SourceOccurrence" DROP CONSTRAINT "SourceOccurrence_reviewState_check";
  ALTER TABLE public."SourceOccurrence" DROP CONSTRAINT "SourceOccurrence_identity_check";
  CREATE TEMP TABLE singleton_owners ON COMMIT DROP AS
    SELECT r.id record_id,gen_random_uuid() id,NULL::text shortcode
    FROM public."SourceTransactionRecord" r WHERE r."occurrenceId" IS NULL;
  ALTER TABLE singleton_owners ADD PRIMARY KEY (id);
  CREATE UNIQUE INDEX ON singleton_owners(shortcode);
  -- Mint in sets: per-record scans of the reservation table become quadratic on historical populations.
  FOR attempt IN 1..10 LOOP
    WITH requested AS MATERIALIZED (
      SELECT id,row_number() OVER(ORDER BY id) n FROM singleton_owners WHERE shortcode IS NULL
    ), minted AS MATERIALIZED (
      SELECT DISTINCT 'SOC-'||substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',1+floor(random()*31)::int,1)||substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',1+floor(random()*31)::int,1)||substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',1+floor(random()*31)::int,1)||substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',1+floor(random()*31)::int,1)||substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',1+floor(random()*31)::int,1) AS code
      FROM generate_series(1,(SELECT count(*)::int*2 FROM requested))
    ), available AS MATERIALIZED (
      SELECT code,row_number() OVER(ORDER BY code) n FROM minted
      WHERE NOT EXISTS(SELECT 1 FROM public."Entity" reserved WHERE reserved.shortcode=minted.code)
        AND NOT EXISTS(SELECT 1 FROM singleton_owners reserved WHERE reserved.shortcode=minted.code)
    )
    UPDATE singleton_owners owner SET shortcode=available.code
      FROM requested JOIN available USING(n) WHERE owner.id=requested.id;
    EXIT WHEN NOT EXISTS(SELECT 1 FROM singleton_owners WHERE shortcode IS NULL);
    IF attempt=10 THEN RAISE EXCEPTION 'Could not reserve unused public occurrence codes'; END IF;
  END LOOP;
  INSERT INTO public."Entity" (id,kind,shortcode,"createdAt","deletedAt")
    SELECT owner.id,'sourceOccurrence',owner.shortcode,r."createdAt",r."deletedAt"
    FROM singleton_owners owner JOIN public."SourceTransactionRecord" r ON r.id=owner.record_id;
  INSERT INTO public."SourceOccurrence" (id,shortcode,source,"identityKind","identityScope","accountId",disposition,
    "dispositionReason","dispositionNote","withdrawnAt","withdrawalImportId","lastObservedAt","reviewState","identityProof","createdAt","updatedAt","deletedAt")
    SELECT owner.id,owner.shortcode,r.source,'unproven','unproven-record:'||r.id,a."accountId",a.disposition,
      a."dispositionReason",a."dispositionNote",a."withdrawnAt",a."withdrawalImportId",a."lastObservedAt",'unproven',
      jsonb_build_object('kind','unproven_record','observationId',r.id),r."createdAt",a."updatedAt",r."deletedAt"
    FROM singleton_owners owner JOIN public."SourceTransactionRecord" r ON r.id=owner.record_id
    JOIN public."SourceObservationAnnotation" a ON a."observationId"=r.id;
  UPDATE public."SourceTransactionRecord" r SET "occurrenceId"=owner.id FROM singleton_owners owner WHERE r.id=owner.record_id;
  UPDATE public."SourceOccurrence" owner SET "currentObservationId"=r.id
    FROM singleton_owners singleton JOIN public."SourceTransactionRecord" r ON r.id=singleton.record_id
    JOIN public."SourceObservationAnnotation" a ON a."observationId"=r.id
    WHERE owner.id=singleton.id AND a.current;
  UPDATE public."SourceOccurrence" owner SET "replacementObservationId"=successor.id,"supersededByOccurrenceId"=successor."occurrenceId"
    FROM singleton_owners singleton JOIN public."SourceObservationAnnotation" a ON a."observationId"=singleton.record_id
    JOIN public."SourceTransactionRecord" successor ON successor.id=a."supersededByObservationId"
    WHERE owner.id=singleton.id;
  UPDATE public."FinancialEvidenceAlias" a SET "occurrenceId"=owner.id FROM singleton_owners owner WHERE a."observationId"=owner.record_id;
  -- Obsolete presentation feedback is not a financial ignore judgment. Current exact revisions retain feedback.
  UPDATE public."Suggestion" SET suppression=NULL WHERE family IN ('statement_transaction','transfer_pair')
    AND suppression IS NOT NULL AND (NOT active OR fingerprint IS NULL);
  UPDATE public."Suggestion" SET suppression=jsonb_set(suppression,'{fingerprint}',to_jsonb(fingerprint))
    WHERE family IN ('statement_transaction','transfer_pair') AND active AND suppression IS NOT NULL AND fingerprint IS NOT NULL;
  IF EXISTS (
    SELECT 1 FROM owner_cutover_records old FULL JOIN public."SourceTransactionRecord" live USING(id)
    LEFT JOIN singleton_owners owner ON owner.record_id=old.id
    WHERE to_jsonb(live) IS DISTINCT FROM to_jsonb(old)||jsonb_build_object('occurrenceId',coalesce(old."occurrenceId",owner.id))
  ) OR EXISTS (
    (SELECT to_jsonb(a) FROM owner_cutover_annotations a EXCEPT ALL SELECT to_jsonb(a) FROM public."SourceObservationAnnotation" a)
    UNION ALL (SELECT to_jsonb(a) FROM public."SourceObservationAnnotation" a EXCEPT ALL SELECT to_jsonb(a) FROM owner_cutover_annotations a)
  ) OR EXISTS (
    SELECT 1 FROM owner_cutover_aliases old FULL JOIN public."FinancialEvidenceAlias" live USING(id)
    LEFT JOIN singleton_owners owner ON owner.record_id=old."observationId"
    WHERE to_jsonb(live) IS DISTINCT FROM to_jsonb(old)||jsonb_build_object('occurrenceId',coalesce(owner.id,old."occurrenceId"))
  ) THEN RAISE EXCEPTION 'Bank records, annotations or aliases failed independent preservation'; END IF;
  IF EXISTS (
    SELECT 1 FROM singleton_owners singleton JOIN public."SourceOccurrence" owner ON owner.id=singleton.id
    JOIN owner_cutover_annotations a ON a."observationId"=singleton.record_id
    WHERE (owner."accountId",owner.disposition,owner."dispositionReason",owner."dispositionNote",owner."withdrawnAt",owner."withdrawalImportId",owner."lastObservedAt")
      IS DISTINCT FROM (a."accountId",a.disposition,a."dispositionReason",a."dispositionNote",a."withdrawnAt",a."withdrawalImportId",a."lastObservedAt")
      OR owner."currentObservationId" IS DISTINCT FROM CASE WHEN a.current THEN singleton.record_id END
      OR owner."replacementObservationId" IS DISTINCT FROM a."supersededByObservationId"
      OR owner."acceptedTransactionId" IS NOT NULL OR owner."reviewState" <> 'unproven'
  ) THEN RAISE EXCEPTION 'Unproven owners failed original financial judgment preservation'; END IF;
  IF EXISTS (
    WITH live AS (
      SELECT 'owners' kind,to_jsonb(r) row FROM public."SourceOccurrence" r WHERE r.id NOT IN (SELECT id FROM singleton_owners)
      UNION ALL SELECT 'memberships',to_jsonb(r) FROM public."TransactionImportRecord" r
      UNION ALL SELECT 'transactions',to_jsonb(r) FROM public."FinancialTransaction" r
      UNION ALL SELECT 'expenses',to_jsonb(r) FROM public."Expense" r
      UNION ALL SELECT 'allocations',to_jsonb(r) FROM public."FinancialTransactionAllocation" r
      UNION ALL SELECT 'suggestions',jsonb_build_object('id',s.id,'hash',md5((to_jsonb(s)-'suppression')::text)) FROM public."Suggestion" s
    ) (SELECT * FROM owner_cutover_preservation EXCEPT ALL SELECT * FROM live)
      UNION ALL (SELECT * FROM live EXCEPT ALL SELECT * FROM owner_cutover_preservation)
  ) THEN RAISE EXCEPTION 'Existing owners, memberships or money changed in the owner cutover'; END IF;
ALTER TABLE "SourceTransactionRecord" ALTER COLUMN "occurrenceId" SET NOT NULL;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_unproven_check" CHECK (("SourceOccurrence"."identityKind" = 'unproven') = ("SourceOccurrence"."reviewState" = 'unproven') AND ("SourceOccurrence"."identityKind" <> 'unproven' OR "SourceOccurrence"."acceptedTransactionId" IS NULL));

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_identityKind_check" CHECK ("SourceOccurrence"."identityKind" IN ('unproven', 'provider', 'positioned', 'reviewed'));

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_reviewState_check" CHECK ("SourceOccurrence"."reviewState" IN ('unproven', 'ready', 'identity_conflict', 'judgment_conflict', 'ownership_conflict', 'revision_order_unknown', 'reappeared'));

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_identity_check" CHECK (("SourceOccurrence"."identityKind" = 'provider' AND "SourceOccurrence"."providerIdentity" IS NOT NULL AND "SourceOccurrence"."physicalImportId" IS NULL AND "SourceOccurrence"."physicalPosition" IS NULL) OR ("SourceOccurrence"."identityKind" = 'positioned' AND "SourceOccurrence"."providerIdentity" IS NULL AND "SourceOccurrence"."physicalImportId" IS NOT NULL AND "SourceOccurrence"."physicalPosition" > 0) OR ("SourceOccurrence"."identityKind" IN ('reviewed', 'unproven') AND "SourceOccurrence"."providerIdentity" IS NULL AND "SourceOccurrence"."physicalImportId" IS NULL AND "SourceOccurrence"."physicalPosition" IS NULL));
END;
$migration$;
