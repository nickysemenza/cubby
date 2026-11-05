-- Direct ownership cutover. No bank movement, Expense, allocation or member attribution is rewritten.
-- The full three predecessor tables remain inert under archive; unknown identity never becomes acceptance.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DO $migration$
DECLARE
  item record;
  locks text;
  original_oids oid[] := ARRAY['public."SourceTransactionRecord"'::regclass::oid,
    'public."TransactionImportRecord"'::regclass::oid, 'public."EntityExternalId"'::regclass::oid];
BEGIN
  LOCK TABLE public."RunStep" IN SHARE MODE;
  IF EXISTS (
    SELECT 1 FROM public."RunStep" step JOIN public."Run" run ON run.id=step."runId"
    WHERE (step.key LIKE 'statement\_%' ESCAPE '\' OR step.key LIKE 'transfer\_pair\_%' ESCAPE '\')
      AND step.state NOT IN ('done','skipped','cancelled')
      AND (run.status='running' OR step."runId"=(SELECT latest."runId" FROM public."RunStep" latest
        WHERE latest.key='statement_generate' ORDER BY latest."createdAt" DESC,latest.id DESC LIMIT 1))
  ) THEN RAISE EXCEPTION 'Financial refresh has unfinished steps; complete or explicitly cancel retained work before the occurrence cutover'; END IF;
  SELECT string_agg(format('%I.%I',n.nspname,c.relname),', ' ORDER BY n.nspname,c.relname) INTO locks
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.oid IN (SELECT unnest(original_oids) UNION SELECT conrelid FROM pg_constraint WHERE contype='f' AND confrelid=ANY(original_oids)
    UNION SELECT confrelid FROM pg_constraint WHERE contype='f' AND conrelid=ANY(original_oids)
    UNION SELECT 'public."FinancialTransaction"'::regclass::oid UNION SELECT 'public."Suggestion"'::regclass::oid);
  EXECUTE 'LOCK TABLE '||locks||' IN ACCESS EXCLUSIVE MODE';
  IF EXISTS(SELECT 1 FROM pg_depend dep JOIN pg_rewrite rewrite ON rewrite.oid=dep.objid WHERE dep.refobjid=ANY(original_oids)) THEN
    RAISE EXCEPTION 'Source evidence view dependencies require an explicit disposition'; END IF;
  IF EXISTS(SELECT 1 FROM public."SourceTransactionRecord" r WHERE r.amount::text IN ('NaN','Infinity','-Infinity')
    OR r."providerAmount"::text IN ('NaN','Infinity','-Infinity')
    OR r.amount::numeric*100<>trunc(r.amount::numeric*100) OR r."providerAmount"::numeric*100<>trunc(r."providerAmount"::numeric*100)
    OR abs(r.amount::numeric*100)>100000000000000 OR abs(r."providerAmount"::numeric*100)>100000000000000
    OR r.amount IS DISTINCT FROM -r."providerAmount") THEN RAISE EXCEPTION 'Source money or sign is not exactly representable'; END IF;
  CREATE TEMP TABLE occurrence_original_rows ON COMMIT DROP AS
    SELECT 'SourceTransactionRecord' AS owner,md5(to_jsonb(r)::text) AS hash FROM public."SourceTransactionRecord" r
    UNION ALL SELECT 'TransactionImportRecord',md5(to_jsonb(r)::text) FROM public."TransactionImportRecord" r
    UNION ALL SELECT 'EntityExternalId',md5(to_jsonb(r)::text) FROM public."EntityExternalId" r;
  CREATE TEMP TABLE occurrence_original_fks ON COMMIT DROP AS
    SELECT conrelid AS owner_oid,conrelid::regclass::text AS owner,conname,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE contype='f' AND (conrelid=ANY(original_oids) OR confrelid=ANY(original_oids));
  CREATE TEMP TABLE occurrence_original_triggers ON COMMIT DROP AS
    SELECT tgrelid::regclass::text AS owner,tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger
    WHERE tgrelid=ANY(original_oids) AND NOT tgisinternal;
  FOR item IN SELECT * FROM occurrence_original_fks LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.owner,item.conname); END LOOP;
  FOR item IN SELECT * FROM occurrence_original_triggers LOOP EXECUTE format('DROP TRIGGER %I ON %s',item.tgname,item.owner); END LOOP;
  CREATE SCHEMA IF NOT EXISTS archive;
  ALTER TABLE public."SourceTransactionRecord" SET SCHEMA archive;
  ALTER TABLE archive."SourceTransactionRecord" RENAME TO "SourceTransactionRecord_occurrence_preimage";
  ALTER TABLE public."TransactionImportRecord" SET SCHEMA archive;
  ALTER TABLE archive."TransactionImportRecord" RENAME TO "TransactionImportRecord_occurrence_preimage";
  ALTER TABLE public."EntityExternalId" SET SCHEMA archive;
  ALTER TABLE archive."EntityExternalId" RENAME TO "EntityExternalId_financial_preimage";

ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant', 'spendingCategory', 'email', 'imageJob', 'sourceTransactionRecord', 'transactionImport', 'job', 'shipment', 'sourceOccurrence'));
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' WHEN 'spendingCategory' THEN "Entity"."shortcode" LIKE 'SPC-%' WHEN 'email' THEN "Entity"."shortcode" LIKE 'EML-%' WHEN 'imageJob' THEN "Entity"."shortcode" LIKE 'IPR-%' WHEN 'sourceTransactionRecord' THEN "Entity"."shortcode" LIKE 'STR-%' WHEN 'transactionImport' THEN "Entity"."shortcode" LIKE 'TIM-%' WHEN 'job' THEN "Entity"."shortcode" LIKE 'JOB-%' WHEN 'shipment' THEN "Entity"."shortcode" LIKE 'SHIP-%' WHEN 'sourceOccurrence' THEN "Entity"."shortcode" LIKE 'SOC-%' ELSE false END);
CREATE TABLE "EntityExternalId" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entityId" uuid NOT NULL,
	"entityKind" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"externalId" text NOT NULL,
	"url" text,
	"isPrimary" boolean,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "EntityExternalId_kind_check" CHECK (("entityKind", "kind") IN (('product', 'asin'), ('product', 'retailer_sku'), ('product', 'internet_number'), ('product', 'item_number'), ('product', 'catalog_number'), ('product', 'manufacturer_part'), ('product', 'gtin_14'), ('expense', 'page'), ('task', 'page'), ('project', 'page'), ('recipe', 'page'), ('project', 'folder'))),
	CONSTRAINT "EntityExternalId_primary_check" CHECK (CASE WHEN "kind" IN ('asin', 'retailer_sku', 'internet_number', 'item_number', 'catalog_number', 'manufacturer_part', 'gtin_14', 'page', 'folder') THEN "isPrimary" IS NOT NULL ELSE "isPrimary" IS NULL END),
	CONSTRAINT "EntityExternalId_gtin_check" CHECK ("EntityExternalId"."kind" <> 'gtin_14' OR "EntityExternalId"."externalId" ~ '^[0-9]{14}$')
);

CREATE TABLE "FinancialEvidenceAlias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"observationId" uuid,
	"occurrenceId" uuid,
	"historicalTransactionId" uuid,
	"provenanceKey" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"scopeEvidence" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);

CREATE TABLE "SourceObservationAnnotation" (
	"observationId" uuid PRIMARY KEY NOT NULL,
	"accountId" uuid,
	"disposition" text DEFAULT 'open' NOT NULL,
	"dispositionReason" text,
	"dispositionNote" text,
	"supersededByObservationId" uuid,
	"notes" text,
	"current" boolean DEFAULT true NOT NULL,
	"withdrawnAt" timestamp,
	"withdrawalImportId" uuid,
	"lastObservedAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "SourceObservationAnnotation_disposition_check" CHECK (("SourceObservationAnnotation"."disposition" = 'open' AND "SourceObservationAnnotation"."dispositionReason" IS NULL AND "SourceObservationAnnotation"."dispositionNote" IS NULL) OR ("SourceObservationAnnotation"."disposition" = 'ignored' AND "SourceObservationAnnotation"."dispositionReason" IN ('not_modeled', 'not_a_purchase', 'duplicate_of_other_source', 'pre_cubby', 'other') AND "SourceObservationAnnotation"."dispositionNote" IS NOT NULL))
);

CREATE TABLE "SourceOccurrence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"source" text NOT NULL,
	"identityKind" text NOT NULL,
	"identityScope" text NOT NULL,
	"providerIdentity" text,
	"physicalImportId" uuid,
	"physicalPosition" integer,
	"currentObservationId" uuid,
	"accountId" uuid,
	"disposition" text DEFAULT 'open' NOT NULL,
	"dispositionReason" text,
	"dispositionNote" text,
	"supersededByOccurrenceId" uuid,
	"replacementObservationId" uuid,
	"withdrawnAt" timestamp,
	"withdrawalImportId" uuid,
	"lastObservedAt" timestamp DEFAULT now() NOT NULL,
	"acceptedTransactionId" uuid,
	"reviewState" text DEFAULT 'ready' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"identityProof" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "SourceOccurrence_identityKind_check" CHECK ("SourceOccurrence"."identityKind" IN ('provider', 'positioned')),
	CONSTRAINT "SourceOccurrence_reviewState_check" CHECK ("SourceOccurrence"."reviewState" IN ('ready', 'identity_conflict', 'judgment_conflict', 'ownership_conflict', 'revision_order_unknown', 'reappeared')),
	CONSTRAINT "SourceOccurrence_disposition_check" CHECK ("SourceOccurrence"."disposition" IN ('open', 'ignored')),
	CONSTRAINT "SourceOccurrence_dispositionReason_check" CHECK ("SourceOccurrence"."dispositionReason" IS NULL OR "SourceOccurrence"."dispositionReason" IN ('not_modeled', 'not_a_purchase', 'duplicate_of_other_source', 'pre_cubby', 'other')),
	CONSTRAINT "SourceOccurrence_identity_check" CHECK (("SourceOccurrence"."identityKind" = 'provider' AND "SourceOccurrence"."providerIdentity" IS NOT NULL AND "SourceOccurrence"."physicalImportId" IS NULL AND "SourceOccurrence"."physicalPosition" IS NULL) OR ("SourceOccurrence"."identityKind" = 'positioned' AND "SourceOccurrence"."providerIdentity" IS NULL AND "SourceOccurrence"."physicalImportId" IS NOT NULL AND "SourceOccurrence"."physicalPosition" > 0)),
	CONSTRAINT "SourceOccurrence_version_check" CHECK ("SourceOccurrence"."version" > 0),
	CONSTRAINT "SourceOccurrence_supersession_check" CHECK ("SourceOccurrence"."supersededByOccurrenceId" IS NULL OR "SourceOccurrence"."supersededByOccurrenceId" <> "SourceOccurrence"."id"),
	CONSTRAINT "SourceOccurrence_disposition_state_check" CHECK (("SourceOccurrence"."disposition" = 'open' AND "SourceOccurrence"."dispositionReason" IS NULL AND "SourceOccurrence"."dispositionNote" IS NULL) OR ("SourceOccurrence"."disposition" = 'ignored' AND "SourceOccurrence"."dispositionReason" IS NOT NULL AND "SourceOccurrence"."dispositionNote" IS NOT NULL))
);

CREATE TABLE "SourceTransactionRecord" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"occurrenceId" uuid,
	"factFingerprint" text NOT NULL,
	"batchId" uuid NOT NULL,
	"source" text NOT NULL,
	"rowPosition" integer,
	"providerTransactionId" text,
	"providerAccountId" text,
	"providerData" jsonb,
	"accountDescriptor" text NOT NULL,
	"statementDate" date NOT NULL,
	"amountMinor" bigint NOT NULL,
	"providerAmountMinor" bigint NOT NULL,
	"merchant" text,
	"rawDescription" text NOT NULL,
	"sourceCategory" text,
	"providerStatus" text,
	"providerNotes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "SourceTransactionRecord_id_occurrence_key" UNIQUE("id","occurrenceId"),
	CONSTRAINT "SourceTransactionRecord_position_check" CHECK ("SourceTransactionRecord"."rowPosition" IS NULL OR "SourceTransactionRecord"."rowPosition" > 0),
	CONSTRAINT "SourceTransactionRecord_source_slug_check" CHECK ("SourceTransactionRecord"."source" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "SourceTransactionRecord"."source" = lower(trim("SourceTransactionRecord"."source"))),
	CONSTRAINT "SourceTransactionRecord_amount_range_check" CHECK (abs("SourceTransactionRecord"."amountMinor") <= 100000000000000),
	CONSTRAINT "SourceTransactionRecord_providerAmount_range_check" CHECK (abs("SourceTransactionRecord"."providerAmountMinor") <= 100000000000000),
	CONSTRAINT "SourceTransactionRecord_providerStatus_check" CHECK ("SourceTransactionRecord"."providerStatus" IS NULL OR "SourceTransactionRecord"."providerStatus" IN ('posted', 'pending'))
);

CREATE TABLE "TransactionImportRecord" (
	"importId" uuid NOT NULL,
	"statementRowId" uuid NOT NULL,
	"rowPosition" integer,
	"requestFingerprint" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "TransactionImportRecord_position_check" CHECK ("TransactionImportRecord"."rowPosition" IS NULL OR "TransactionImportRecord"."rowPosition" > 0)
);

  CREATE TEMP TABLE observation_mapping ON COMMIT DROP AS
  WITH facts AS (
    SELECT old.*,batch.fingerprint,
      batch.source=old.source AND EXISTS(SELECT 1 FROM archive."TransactionImportRecord_occurrence_preimage" member
        WHERE member."importId"=old."batchId" AND member."statementRowId"=old.id) AS original_member,
      old.source='monarch' AND old."providerTransactionId" IS NOT NULL AND old."providerAccountId" IS NOT NULL
        AND coalesce(old."providerData"->'transaction'->>'id',old."providerData"->>'id')=old."providerTransactionId"
        AND coalesce(old."providerData"->>'account_id',old."providerData"->'account'->>'id',CASE WHEN jsonb_typeof(old."providerData"->'account')='string' THEN old."providerData"->>'account' END)=old."providerAccountId"
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(old."providerData"->'transaction'->'id',old."providerData"->'id')) value
          WHERE value<>'null'::jsonb AND (jsonb_typeof(value)<>'string' OR value #>> '{}' <> old."providerTransactionId"))
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(jsonb_build_array(old."providerData"->'account_id',old."providerData"->'account'->'id',CASE WHEN jsonb_typeof(old."providerData"->'account')='string' THEN old."providerData"->'account' END,old."providerData"->'transaction'->'account_id')) value
          WHERE value<>'null'::jsonb AND (jsonb_typeof(value)<>'string' OR value #>> '{}' <> old."providerAccountId")) AS provider_proven,
      old."rowPosition">0 AND old."externalId"='v2:'||encode(sha256(convert_to('['||to_json(old.source)::text||',"v2",'||to_json(batch.fingerprint)::text||','||old."rowPosition"::text||']','UTF8')),'hex') AS position_proven,
      encode(sha256(convert_to('['||to_json(old.source)::text||','||coalesce(to_json(old."providerTransactionId")::text,'null')||','||coalesce(to_json(old."providerAccountId")::text,'null')||','||to_json(old."accountDescriptor")::text||','||to_json(old."statementDate"::text)::text||','||to_json((old."providerAmount"::numeric*100)::bigint::text)::text||','||to_json((old.amount::numeric*100)::bigint::text)::text||','||coalesce(to_json(old.merchant)::text,'null')||','||to_json(old."rawDescription")::text||','||coalesce(to_json(old."sourceCategory")::text,'null')||','||coalesce(to_json(old."providerStatus")::text,'null')||','||coalesce(to_json(old."providerNotes")::text,'null')||']','UTF8')),'hex') AS fact_fingerprint
    FROM archive."SourceTransactionRecord_occurrence_preimage" old JOIN public."TransactionImport" batch ON batch.id=old."batchId"
  ), identities AS (
    SELECT *,CASE WHEN original_member AND provider_proven THEN 'provider' WHEN original_member AND position_proven THEN 'positioned' END AS identity_kind
    FROM facts
  ) SELECT *,CASE identity_kind WHEN 'provider' THEN 'provider-account:'||"providerAccountId" WHEN 'positioned' THEN 'collection:'||fingerprint END AS identity_scope,
    NULL::uuid AS occurrence_id FROM identities;
  IF EXISTS(SELECT 1 FROM observation_mapping WHERE identity_kind='positioned' GROUP BY "batchId","rowPosition" HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Original physical collection position has conflicting retained observations'; END IF;
  CREATE TEMP TABLE proven_occurrences ON COMMIT DROP AS
    SELECT gen_random_uuid() AS id,branch.*,NULL::text AS shortcode FROM (
      SELECT DISTINCT source,identity_kind,identity_scope,
        CASE WHEN identity_kind='provider' THEN "providerTransactionId" END AS provider_id,
        CASE WHEN identity_kind='positioned' THEN "batchId" END AS physical_import_id,
        CASE WHEN identity_kind='positioned' THEN "rowPosition" END AS physical_position
      FROM observation_mapping WHERE identity_kind IS NOT NULL
    ) branch;
  -- Ordinals mint public entity codes only; they never establish occurrence identity across collections.
  WITH numbered AS(SELECT id,(row_number() OVER(ORDER BY source,identity_kind,identity_scope,provider_id,physical_import_id,physical_position)-1)::int AS n FROM proven_occurrences)
  UPDATE proven_occurrences target SET shortcode='SOC-'||
    substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',n/923521%31+1,1)||substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',n/29791%31+1,1)||
    substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',n/961%31+1,1)||substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',n/31%31+1,1)||substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',n%31+1,1)
    FROM numbered WHERE target.id=numbered.id;
  IF (SELECT count(*) FROM proven_occurrences)>28629151 THEN RAISE EXCEPTION 'Occurrence public-code namespace is exhausted'; END IF;
  UPDATE observation_mapping observation SET occurrence_id=owner.id FROM proven_occurrences owner
    WHERE observation.source=owner.source AND observation.identity_kind=owner.identity_kind AND observation.identity_scope=owner.identity_scope
      AND (observation.identity_kind='provider' AND observation."providerTransactionId"=owner.provider_id
        OR observation.identity_kind='positioned' AND observation."batchId"=owner.physical_import_id AND observation."rowPosition"=owner.physical_position);
  INSERT INTO public."Entity" (id,kind,shortcode,"createdAt","deletedAt")
    SELECT id,'sourceOccurrence',shortcode,now(),NULL FROM proven_occurrences;
  INSERT INTO public."SourceTransactionRecord" (id,shortcode,"occurrenceId","factFingerprint","batchId",source,"rowPosition","providerTransactionId","providerAccountId","providerData","accountDescriptor","statementDate","amountMinor","providerAmountMinor",merchant,"rawDescription","sourceCategory","providerStatus","providerNotes","createdAt","deletedAt")
    SELECT id,shortcode,occurrence_id,fact_fingerprint,"batchId",source,"rowPosition","providerTransactionId","providerAccountId","providerData","accountDescriptor","statementDate",(amount::numeric*100)::bigint,("providerAmount"::numeric*100)::bigint,merchant,"rawDescription","sourceCategory","providerStatus","providerNotes","createdAt","deletedAt" FROM observation_mapping;
  IF EXISTS(SELECT 1 FROM archive."SourceTransactionRecord_occurrence_preimage" old FULL JOIN public."SourceTransactionRecord" fresh USING(id)
    WHERE old.id IS NULL OR fresh.id IS NULL OR old.amount IS DISTINCT FROM fresh."amountMinor"::float8/100 OR old."providerAmount" IS DISTINCT FROM fresh."providerAmountMinor"::float8/100) THEN
    RAISE EXCEPTION 'Source money failed independent IEEE round-trip preservation'; END IF;
  INSERT INTO public."SourceObservationAnnotation" ("observationId","accountId",disposition,"dispositionReason","dispositionNote","supersededByObservationId",notes,current,"withdrawnAt","withdrawalImportId","lastObservedAt","updatedAt")
    SELECT id,"accountId",disposition,"dispositionReason","dispositionNote","supersededByRowId",notes,current,"withdrawnAt","withdrawalImportId","lastObservedAt","updatedAt" FROM observation_mapping;
  CREATE TEMP TABLE occurrence_frontiers ON COMMIT DROP AS
    SELECT occurrence_id AS id,count(DISTINCT fact_fingerprint) AS fact_count,
      count(DISTINCT jsonb_build_array("accountId",disposition,"dispositionReason","dispositionNote","supersededByRowId","withdrawnAt","withdrawalImportId")) AS judgment_count,
      count(*) FILTER(WHERE current AND "deletedAt" IS NULL) AS live_heads,
      count(*) FILTER(WHERE current AND "deletedAt" IS NOT NULL) AS deleted_heads,
      (array_agg(id ORDER BY id) FILTER(WHERE current AND "deletedAt" IS NULL))[1] AS head_id,
      max("lastObservedAt") AS last_observed_at,min("createdAt") AS created_at,max("updatedAt") AS updated_at
    FROM observation_mapping WHERE occurrence_id IS NOT NULL GROUP BY occurrence_id;
  INSERT INTO public."SourceOccurrence" (id,shortcode,source,"identityKind","identityScope","providerIdentity","physicalImportId","physicalPosition","currentObservationId","accountId",disposition,"dispositionReason","dispositionNote","withdrawnAt","withdrawalImportId","lastObservedAt","reviewState","identityProof","createdAt","updatedAt","deletedAt")
    SELECT owner.id,owner.shortcode,owner.source,owner.identity_kind,owner.identity_scope,owner.provider_id,owner.physical_import_id,owner.physical_position,
      CASE WHEN frontier.fact_count=1 AND frontier.live_heads=1 AND frontier.deleted_heads=0 THEN frontier.head_id END,
      CASE WHEN frontier.judgment_count=1 THEN representative."accountId" END,
      CASE WHEN frontier.judgment_count=1 THEN representative.disposition ELSE 'open' END,
      CASE WHEN frontier.judgment_count=1 THEN representative."dispositionReason" END,
      CASE WHEN frontier.judgment_count=1 THEN representative."dispositionNote" END,
      CASE WHEN frontier.judgment_count=1 THEN representative."withdrawnAt" END,
      CASE WHEN frontier.judgment_count=1 THEN representative."withdrawalImportId" END,
      frontier.last_observed_at,
      CASE WHEN frontier.judgment_count>1 THEN 'judgment_conflict' WHEN frontier.fact_count>1 THEN 'revision_order_unknown'
        WHEN frontier.live_heads<>1 OR frontier.deleted_heads>0 THEN 'identity_conflict' ELSE 'ready' END,
      CASE owner.identity_kind WHEN 'provider' THEN jsonb_build_object('kind','raw_provider_ids','source',owner.source,'account',substring(owner.identity_scope FROM length('provider-account:')+1),'provider',owner.provider_id)
        ELSE jsonb_build_object('kind','original_collection_position','source',owner.source,'fingerprint',substring(owner.identity_scope FROM length('collection:')+1),'position',owner.physical_position) END,
      frontier.created_at,frontier.updated_at,NULL
    FROM proven_occurrences owner JOIN occurrence_frontiers frontier USING(id)
    JOIN LATERAL(SELECT * FROM observation_mapping member WHERE member.occurrence_id=owner.id ORDER BY member.id LIMIT 1) representative ON true;
  -- Retain exact replacement meaning. Neither this edge nor an alias copies accepted ownership.
  UPDATE public."SourceOccurrence" owner SET "replacementObservationId"=old."supersededByRowId",
    "supersededByOccurrenceId"=CASE WHEN successor.occurrence_id<>owner.id THEN successor.occurrence_id END
    FROM occurrence_frontiers frontier JOIN observation_mapping old ON old.occurrence_id=frontier.id
    LEFT JOIN observation_mapping successor ON successor.id=old."supersededByRowId"
    WHERE owner.id=frontier.id AND frontier.judgment_count=1 AND old."supersededByRowId" IS NOT NULL AND successor.occurrence_id IS DISTINCT FROM owner.id;
  -- Weak historical grouping can only hold uncertain cross-collection overlap, never establish identity.
  UPDATE public."SourceOccurrence" owner SET "reviewState"='identity_conflict'
    WHERE owner."reviewState"='ready' AND EXISTS(
      SELECT 1 FROM observation_mapping own JOIN observation_mapping other ON other.source=own.source AND other."chargeKey"=own."chargeKey"
      WHERE own.occurrence_id=owner.id AND other.occurrence_id IS DISTINCT FROM own.occurrence_id);
  UPDATE public."SourceOccurrence" owner SET "deletedAt"=(SELECT max(member."deletedAt") FROM observation_mapping member WHERE member.occurrence_id=owner.id)
    WHERE NOT EXISTS(SELECT 1 FROM observation_mapping member WHERE member.occurrence_id=owner.id AND member."deletedAt" IS NULL);
  UPDATE public."Entity" identity SET "createdAt"=owner."createdAt","deletedAt"=owner."deletedAt" FROM public."SourceOccurrence" owner WHERE identity.id=owner.id;
  -- Attested new scope cannot silently resolve older observations with an unknown provider namespace.
  UPDATE public."SourceOccurrence" owner SET "reviewState"='identity_conflict'
    WHERE owner."identityKind"='provider' AND owner."reviewState"='ready' AND EXISTS(
      SELECT 1 FROM observation_mapping uncertain WHERE uncertain.source=owner.source AND uncertain."providerTransactionId"=owner."providerIdentity"
        AND uncertain.occurrence_id IS DISTINCT FROM owner.id AND uncertain.identity_kind IS DISTINCT FROM 'provider');
  INSERT INTO public."TransactionImportRecord" ("importId","statementRowId","rowPosition","createdAt")
    SELECT old."importId",old."statementRowId",CASE WHEN mapped."batchId"=old."importId" AND mapped.original_member AND mapped.position_proven THEN mapped."rowPosition" END,old."createdAt"
    FROM archive."TransactionImportRecord_occurrence_preimage" old JOIN observation_mapping mapped ON mapped.id=old."statementRowId";
  INSERT INTO public."EntityExternalId" SELECT * FROM archive."EntityExternalId_financial_preimage"
    WHERE NOT ("entityKind"='financialTransaction' AND kind='settlement_ref');
  INSERT INTO public."FinancialEvidenceAlias" (source,kind,value,"observationId","occurrenceId","provenanceKey",provenance,"scopeEvidence","createdAt","deletedAt")
    SELECT old.source,alias.kind,alias.value,old.id,old.occurrence_id,'observation:'||old.id::text||':'||alias.kind,
      jsonb_build_object('kind','retained_observation_alias'),jsonb_build_object('identityKind',old.identity_kind,'scope',old.identity_scope),old."createdAt",old."deletedAt"
    FROM observation_mapping old CROSS JOIN LATERAL(VALUES('externalId',old."externalId"),('legacyExternalId',old."legacyExternalId"),('legacyReference',old."legacyReference"),('chargeKey',old."chargeKey")) alias(kind,value)
    WHERE alias.value IS NOT NULL;
  CREATE TEMP TABLE retained_bindings ON COMMIT DROP AS
    SELECT binding.*,mapped.id AS observation_id,mapped.occurrence_id,
      mapped."externalId"=binding."externalId" AND binding."externalId" ~ '^v[23]:' AS direct_binding
    FROM archive."EntityExternalId_financial_preimage" binding
    LEFT JOIN observation_mapping mapped ON mapped.source=binding.source AND binding."externalId" IN (mapped."externalId",mapped."legacyExternalId",mapped."legacyReference",mapped."chargeKey")
    WHERE binding."entityKind"='financialTransaction' AND binding.kind='settlement_ref';
  CREATE TEMP TABLE binding_scopes ON COMMIT DROP AS
    SELECT id,count(DISTINCT occurrence_id) AS occurrences,count(*) FILTER(WHERE occurrence_id IS NULL) AS unresolved,
      (array_agg(occurrence_id ORDER BY occurrence_id) FILTER(WHERE occurrence_id IS NOT NULL))[1] AS occurrence_id
    FROM retained_bindings GROUP BY id;
  INSERT INTO public."FinancialEvidenceAlias" (id,source,kind,value,"occurrenceId","historicalTransactionId","provenanceKey",provenance,"scopeEvidence","createdAt","deletedAt")
    SELECT old.id,old.source,'transaction_ref',old."externalId",CASE WHEN scope.occurrences=1 AND scope.unresolved=0 THEN scope.occurrence_id END,
      old."entityId",'binding:'||old.id::text,to_jsonb(old),jsonb_build_object('kind','retained_binding'),old."createdAt",old."deletedAt"
    FROM archive."EntityExternalId_financial_preimage" old JOIN binding_scopes scope USING(id);
  -- Acceptance needs direct v2/v3 proof AND complete unique binding closure, including tombstones.
  CREATE TEMP TABLE acceptance_candidates ON COMMIT DROP AS
    SELECT owner.id,(array_agg(DISTINCT binding."entityId"))[1] AS transaction_id,
      count(DISTINCT binding."entityId") AS owners,
      bool_or(binding.direct_binding AND binding."deletedAt" IS NULL) AS direct_proof,
      bool_or(scope.occurrences<>1 OR scope.unresolved<>0 OR binding."deletedAt" IS NOT NULL) AS ambiguous
    FROM public."SourceOccurrence" owner JOIN retained_bindings binding ON binding.occurrence_id=owner.id
    JOIN binding_scopes scope ON scope.id=binding.id GROUP BY owner.id;
  UPDATE public."SourceOccurrence" owner SET "acceptedTransactionId"=candidate.transaction_id
    FROM acceptance_candidates candidate JOIN public."FinancialTransaction" accepted ON accepted.id=candidate.transaction_id
    WHERE owner.id=candidate.id AND candidate.owners=1 AND candidate.direct_proof AND NOT candidate.ambiguous
      AND owner."reviewState"='ready' AND accepted."deletedAt" IS NULL
      AND owner."accountId"=accepted."accountId" AND EXISTS(SELECT 1 FROM public."SourceTransactionRecord" head
        WHERE head.id=owner."currentObservationId" AND head."deletedAt" IS NULL AND accepted.amount=head."amountMinor"::float8/100);
  UPDATE public."SourceOccurrence" owner SET "reviewState"='ownership_conflict'
    WHERE owner."acceptedTransactionId" IS NULL AND EXISTS(SELECT 1 FROM acceptance_candidates candidate WHERE candidate.id=owner.id);

CREATE UNIQUE INDEX "EntityExternalId_source_kind_externalId_key" ON "EntityExternalId" USING btree ("source","kind","externalId") WHERE "EntityExternalId"."deletedAt" IS NULL;

CREATE UNIQUE INDEX "EntityExternalId_entity_source_kind_primary_key" ON "EntityExternalId" USING btree ("entityId","source","kind") WHERE "EntityExternalId"."isPrimary" AND "EntityExternalId"."deletedAt" IS NULL;

CREATE INDEX "EntityExternalId_entityId_idx" ON "EntityExternalId" USING btree ("entityId");

CREATE UNIQUE INDEX "FinancialEvidenceAlias_provenance_key" ON "FinancialEvidenceAlias" USING btree ("provenanceKey");

CREATE INDEX "FinancialEvidenceAlias_lookup_idx" ON "FinancialEvidenceAlias" USING btree ("source","kind","value");

CREATE INDEX "FinancialEvidenceAlias_observation_idx" ON "FinancialEvidenceAlias" USING btree ("observationId");

CREATE UNIQUE INDEX "FinancialEvidenceAlias_observation_kind_key" ON "FinancialEvidenceAlias" USING btree ("observationId","kind") WHERE "FinancialEvidenceAlias"."kind" IN ('externalId', 'legacyExternalId', 'legacyReference', 'chargeKey');

CREATE INDEX "FinancialEvidenceAlias_occurrence_idx" ON "FinancialEvidenceAlias" USING btree ("occurrenceId");

CREATE INDEX "FinancialEvidenceAlias_historical_transaction_idx" ON "FinancialEvidenceAlias" USING btree ("historicalTransactionId");

CREATE INDEX "SourceObservationAnnotation_account_idx" ON "SourceObservationAnnotation" USING btree ("accountId");

CREATE INDEX "SourceObservationAnnotation_superseded_idx" ON "SourceObservationAnnotation" USING btree ("supersededByObservationId");

CREATE INDEX "SourceObservationAnnotation_withdrawal_idx" ON "SourceObservationAnnotation" USING btree ("withdrawalImportId");

CREATE UNIQUE INDEX "SourceOccurrence_shortcode_unique" ON "SourceOccurrence" USING btree ("shortcode");

CREATE UNIQUE INDEX "SourceOccurrence_provider_key" ON "SourceOccurrence" USING btree ("source","identityScope","providerIdentity") WHERE "SourceOccurrence"."identityKind" = 'provider';

CREATE UNIQUE INDEX "SourceOccurrence_position_key" ON "SourceOccurrence" USING btree ("physicalImportId","physicalPosition") WHERE "SourceOccurrence"."identityKind" = 'positioned';

CREATE INDEX "SourceOccurrence_account_review_idx" ON "SourceOccurrence" USING btree ("accountId","reviewState","lastObservedAt");

CREATE INDEX "SourceOccurrence_source_review_idx" ON "SourceOccurrence" USING btree ("source","reviewState");

CREATE INDEX "SourceOccurrence_physicalImportId_idx" ON "SourceOccurrence" USING btree ("physicalImportId");

CREATE INDEX "SourceOccurrence_currentObservationId_idx" ON "SourceOccurrence" USING btree ("currentObservationId");

CREATE INDEX "SourceOccurrence_supersededByOccurrenceId_idx" ON "SourceOccurrence" USING btree ("supersededByOccurrenceId");

CREATE INDEX "SourceOccurrence_replacementObservationId_idx" ON "SourceOccurrence" USING btree ("replacementObservationId");

CREATE INDEX "SourceOccurrence_withdrawalImportId_idx" ON "SourceOccurrence" USING btree ("withdrawalImportId");

CREATE INDEX "SourceOccurrence_acceptedTransactionId_idx" ON "SourceOccurrence" USING btree ("acceptedTransactionId");

CREATE UNIQUE INDEX "SourceTransactionRecord_shortcode_unique" ON "SourceTransactionRecord" USING btree ("shortcode");

CREATE INDEX "SourceTransactionRecord_occurrence_facts_idx" ON "SourceTransactionRecord" USING btree ("occurrenceId","factFingerprint");

CREATE UNIQUE INDEX "SourceTransactionRecord_batch_position_key" ON "SourceTransactionRecord" USING btree ("batchId","rowPosition") WHERE "SourceTransactionRecord"."deletedAt" IS NULL;

CREATE INDEX "SourceTransactionRecord_source_providerTransactionId_idx" ON "SourceTransactionRecord" USING btree ("source","providerTransactionId");

CREATE INDEX "SourceTransactionRecord_statementDate_idx" ON "SourceTransactionRecord" USING btree ("statementDate");

CREATE INDEX "SourceTransactionRecord_descriptor_date_amount_idx" ON "SourceTransactionRecord" USING btree ("source","accountDescriptor","statementDate","providerAmountMinor");

CREATE INDEX "SourceTransactionRecord_rawDescription_gin_idx" ON "SourceTransactionRecord" USING gin ("rawDescription" gin_trgm_ops);

CREATE INDEX "SourceTransactionRecord_batchId_idx" ON "SourceTransactionRecord" USING btree ("batchId");

CREATE UNIQUE INDEX "TransactionImportRecord_import_row_key" ON "TransactionImportRecord" USING btree ("importId","statementRowId");

CREATE INDEX "TransactionImportRecord_row_idx" ON "TransactionImportRecord" USING btree ("statementRowId");

CREATE UNIQUE INDEX "TransactionImportRecord_position_key" ON "TransactionImportRecord" USING btree ("importId","rowPosition") WHERE "TransactionImportRecord"."rowPosition" IS NOT NULL;
ALTER TABLE "EntityExternalId" ADD CONSTRAINT "EntityExternalId_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;

ALTER TABLE "EntityExternalId" ADD CONSTRAINT "EntityExternalId_entity_fk" FOREIGN KEY ("entityId","entityKind") REFERENCES "public"."Entity"("id","kind") ON DELETE no action ON UPDATE no action;

ALTER TABLE "FinancialEvidenceAlias" ADD CONSTRAINT "FinancialEvidenceAlias_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;

ALTER TABLE "FinancialEvidenceAlias" ADD CONSTRAINT "FinancialEvidenceAlias_observationId_SourceTransactionRecord_id_fk" FOREIGN KEY ("observationId") REFERENCES "public"."SourceTransactionRecord"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "FinancialEvidenceAlias" ADD CONSTRAINT "FinancialEvidenceAlias_occurrenceId_SourceOccurrence_id_fk" FOREIGN KEY ("occurrenceId") REFERENCES "public"."SourceOccurrence"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "FinancialEvidenceAlias" ADD CONSTRAINT "FinancialEvidenceAlias_historicalTransactionId_FinancialTransaction_id_fk" FOREIGN KEY ("historicalTransactionId") REFERENCES "public"."FinancialTransaction"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceObservationAnnotation" ADD CONSTRAINT "SourceObservationAnnotation_observationId_SourceTransactionRecord_id_fk" FOREIGN KEY ("observationId") REFERENCES "public"."SourceTransactionRecord"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceObservationAnnotation" ADD CONSTRAINT "SourceObservationAnnotation_accountId_FinancialAccount_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."FinancialAccount"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceObservationAnnotation" ADD CONSTRAINT "SourceObservationAnnotation_supersededByObservationId_SourceTransactionRecord_id_fk" FOREIGN KEY ("supersededByObservationId") REFERENCES "public"."SourceTransactionRecord"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceObservationAnnotation" ADD CONSTRAINT "SourceObservationAnnotation_withdrawalImportId_TransactionImport_id_fk" FOREIGN KEY ("withdrawalImportId") REFERENCES "public"."TransactionImport"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_physicalImportId_TransactionImport_id_fk" FOREIGN KEY ("physicalImportId") REFERENCES "public"."TransactionImport"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_currentObservationId_SourceTransactionRecord_id_fk" FOREIGN KEY ("currentObservationId") REFERENCES "public"."SourceTransactionRecord"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_accountId_FinancialAccount_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."FinancialAccount"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_supersededByOccurrenceId_SourceOccurrence_id_fk" FOREIGN KEY ("supersededByOccurrenceId") REFERENCES "public"."SourceOccurrence"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_replacementObservationId_SourceTransactionRecord_id_fk" FOREIGN KEY ("replacementObservationId") REFERENCES "public"."SourceTransactionRecord"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_withdrawalImportId_TransactionImport_id_fk" FOREIGN KEY ("withdrawalImportId") REFERENCES "public"."TransactionImport"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_acceptedTransactionId_FinancialTransaction_id_fk" FOREIGN KEY ("acceptedTransactionId") REFERENCES "public"."FinancialTransaction"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_head_membership_fk" FOREIGN KEY ("currentObservationId","id") REFERENCES "public"."SourceTransactionRecord"("id","occurrenceId") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceOccurrence" ADD CONSTRAINT "SourceOccurrence_replacement_membership_fk" FOREIGN KEY ("replacementObservationId","supersededByOccurrenceId") REFERENCES "public"."SourceTransactionRecord"("id","occurrenceId") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_occurrenceId_SourceOccurrence_id_fk" FOREIGN KEY ("occurrenceId") REFERENCES "public"."SourceOccurrence"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_batchId_TransactionImport_id_fk" FOREIGN KEY ("batchId") REFERENCES "public"."TransactionImport"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_source_ExternalSource_slug_fk" FOREIGN KEY ("source") REFERENCES "public"."ExternalSource"("slug") ON DELETE no action ON UPDATE cascade;

ALTER TABLE "SourceTransactionRecord" ADD CONSTRAINT "SourceTransactionRecord_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;

ALTER TABLE "TransactionImportRecord" ADD CONSTRAINT "TransactionImportRecord_importId_TransactionImport_id_fk" FOREIGN KEY ("importId") REFERENCES "public"."TransactionImport"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "TransactionImportRecord" ADD CONSTRAINT "TransactionImportRecord_statementRowId_SourceTransactionRecord_id_fk" FOREIGN KEY ("statementRowId") REFERENCES "public"."SourceTransactionRecord"("id") ON DELETE no action ON UPDATE no action;

  -- Only uncommitted machine advice becomes stale. Member decisions/suppression and successful receipts are untouched.
  CREATE TABLE archive."Suggestion_occurrence_preimage" AS SELECT * FROM public."Suggestion" suggestion
    WHERE suggestion.status='pending' AND suggestion.suppression IS NULL AND suggestion.decisions='[]'::jsonb AND (
      suggestion.family='statement_transaction' AND suggestion.data->>'chargeKey' NOT LIKE 'SOC-%'
      OR suggestion.family='transfer_pair' AND (
        suggestion.judgment#>>'{outflow,charge,chargeKey}' NOT LIKE 'SOC-%'
        OR suggestion.judgment#>>'{inflow,charge,chargeKey}' NOT LIKE 'SOC-%'));
  UPDATE public."Suggestion" current SET active=false,status='superseded',"updatedAt"=now()
    FROM archive."Suggestion_occurrence_preimage" original WHERE current.id=original.id;
  IF EXISTS(SELECT 1 FROM archive."Suggestion_occurrence_preimage" original JOIN public."Suggestion" current USING(id)
    WHERE (to_jsonb(original)-'active'-'status'-'updatedAt') IS DISTINCT FROM (to_jsonb(current)-'active'-'status'-'updatedAt')) THEN
    RAISE EXCEPTION 'Stale-advice retirement changed retained financial evidence or decisions'; END IF;
  -- Restore external incoming references and row triggers against the replacement public owners.
  FOR item IN SELECT * FROM occurrence_original_fks WHERE NOT owner_oid=ANY(original_oids) LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s',item.owner,item.conname,item.definition); END LOOP;
  FOR item IN SELECT * FROM occurrence_original_triggers LOOP EXECUTE item.definition; END LOOP;
  IF EXISTS(
    (SELECT owner,hash,count(*) FROM occurrence_original_rows GROUP BY owner,hash EXCEPT ALL
      SELECT owner,hash,count(*) FROM (
        SELECT 'SourceTransactionRecord' AS owner,md5(to_jsonb(r)::text) AS hash FROM archive."SourceTransactionRecord_occurrence_preimage" r
        UNION ALL SELECT 'TransactionImportRecord',md5(to_jsonb(r)::text) FROM archive."TransactionImportRecord_occurrence_preimage" r
        UNION ALL SELECT 'EntityExternalId',md5(to_jsonb(r)::text) FROM archive."EntityExternalId_financial_preimage" r) rows GROUP BY owner,hash)
    UNION ALL
    (SELECT owner,hash,count(*) FROM (
        SELECT 'SourceTransactionRecord' AS owner,md5(to_jsonb(r)::text) AS hash FROM archive."SourceTransactionRecord_occurrence_preimage" r
        UNION ALL SELECT 'TransactionImportRecord',md5(to_jsonb(r)::text) FROM archive."TransactionImportRecord_occurrence_preimage" r
        UNION ALL SELECT 'EntityExternalId',md5(to_jsonb(r)::text) FROM archive."EntityExternalId_financial_preimage" r) rows GROUP BY owner,hash
      EXCEPT ALL SELECT owner,hash,count(*) FROM occurrence_original_rows GROUP BY owner,hash)
  ) THEN RAISE EXCEPTION 'Archived occurrence preimages failed full-row multiset preservation'; END IF;
  -- Independently reconstruct every removed observation field from its explicit retained owner/history.
  IF EXISTS(
    SELECT 1 FROM archive."SourceTransactionRecord_occurrence_preimage" original
    FULL JOIN (
      SELECT fact.id,(to_jsonb(fact)-'occurrenceId'-'factFingerprint'-'amountMinor'-'providerAmountMinor')
        || jsonb_build_object('amount',fact."amountMinor"::float8/100,'providerAmount',fact."providerAmountMinor"::float8/100,
          'externalId',own.value,'legacyExternalId',legacy.value,'legacyReference',reference.value,'chargeKey',charge.value,
          'accountId',annotation."accountId",'disposition',annotation.disposition,'dispositionReason',annotation."dispositionReason",'dispositionNote',annotation."dispositionNote",
          'supersededByRowId',annotation."supersededByObservationId",'notes',annotation.notes,'current',annotation.current,
          'withdrawnAt',annotation."withdrawnAt",'withdrawalImportId',annotation."withdrawalImportId",'lastObservedAt',annotation."lastObservedAt",'updatedAt',annotation."updatedAt") AS restored
      FROM public."SourceTransactionRecord" fact JOIN public."SourceObservationAnnotation" annotation ON annotation."observationId"=fact.id
      LEFT JOIN public."FinancialEvidenceAlias" own ON own."observationId"=fact.id AND own.kind='externalId'
      LEFT JOIN public."FinancialEvidenceAlias" legacy ON legacy."observationId"=fact.id AND legacy.kind='legacyExternalId'
      LEFT JOIN public."FinancialEvidenceAlias" reference ON reference."observationId"=fact.id AND reference.kind='legacyReference'
      LEFT JOIN public."FinancialEvidenceAlias" charge ON charge."observationId"=fact.id AND charge.kind='chargeKey'
    ) reconstructed USING(id)
    WHERE original.id IS NULL OR reconstructed.id IS NULL OR to_jsonb(original) IS DISTINCT FROM reconstructed.restored
  ) THEN RAISE EXCEPTION 'Retained source facts, aliases, decisions or lifecycle failed independent reconstruction'; END IF;
  IF EXISTS((SELECT to_jsonb(old) AS row FROM archive."TransactionImportRecord_occurrence_preimage" old EXCEPT ALL SELECT to_jsonb(fresh)-'rowPosition'-'requestFingerprint' FROM public."TransactionImportRecord" fresh)
    UNION ALL (SELECT to_jsonb(fresh)-'rowPosition'-'requestFingerprint' FROM public."TransactionImportRecord" fresh EXCEPT ALL SELECT to_jsonb(old) FROM archive."TransactionImportRecord_occurrence_preimage" old)) THEN
    RAISE EXCEPTION 'Import membership preservation failed'; END IF;
  IF EXISTS(
    (SELECT to_jsonb(old) AS row FROM archive."EntityExternalId_financial_preimage" old EXCEPT ALL
      (SELECT to_jsonb(fresh) FROM public."EntityExternalId" fresh UNION ALL SELECT alias.provenance FROM public."FinancialEvidenceAlias" alias WHERE alias."provenanceKey" LIKE 'binding:%'))
    UNION ALL
    ((SELECT to_jsonb(fresh) FROM public."EntityExternalId" fresh UNION ALL SELECT alias.provenance FROM public."FinancialEvidenceAlias" alias WHERE alias."provenanceKey" LIKE 'binding:%')
      EXCEPT ALL SELECT to_jsonb(old) FROM archive."EntityExternalId_financial_preimage" old)
  ) THEN RAISE EXCEPTION 'External identifier and financial binding preservation failed'; END IF;
  FOR item IN SELECT n.nspname,c.relname AS name FROM pg_index idx JOIN pg_class c ON c.oid=idx.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE idx.indrelid=ANY(original_oids) AND NOT idx.indisprimary LOOP
    EXECUTE format('DROP INDEX %I.%I',item.nspname,item.name); END LOOP;
  IF EXISTS(SELECT 1 FROM pg_constraint WHERE contype='f' AND (conrelid=ANY(original_oids) OR confrelid=ANY(original_oids)))
    OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=ANY(original_oids) AND NOT tgisinternal)
    OR EXISTS(SELECT 1 FROM pg_index WHERE indrelid=ANY(original_oids) AND NOT indisprimary) THEN
    RAISE EXCEPTION 'Archived source preimages are not inert'; END IF;
END $migration$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_entityattachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('product.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'recipe' THEN PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'recipe' OR NEW."entityKind" = 'recipe') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('recipe.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ingredient' THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ingredient' OR NEW."entityKind" = 'ingredient') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('ingredient.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('ingredient.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'cookbook' THEN PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'cookbook' OR NEW."entityKind" = 'cookbook') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('cookbook.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('cookbook.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'location' THEN PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'location' OR NEW."entityKind" = 'location') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('location.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('location.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'inventory' THEN PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'inventory' OR NEW."entityKind" = 'inventory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('inventory.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'meal' THEN PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'meal' OR NEW."entityKind" = 'meal') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('meal.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerParty' THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ledgerParty' OR NEW."entityKind" = 'ledgerParty') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'ledgerTransfer' THEN PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'ledgerTransfer' OR NEW."entityKind" = 'ledgerTransfer') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'project' THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'project' OR NEW."entityKind" = 'project') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@24', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@24', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@24', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@28', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@28', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@28', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@32', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@32', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('project.dataQuality@32', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'task' THEN PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'task' OR NEW."entityKind" = 'task') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@11', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@11', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@11', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@15', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@15', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@15', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@19', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@19', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@19', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@23', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@23', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@23', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@27', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@27', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@27', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@31', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@31', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@31', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@35', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@35', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@35', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@39', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@39', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@39', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@45', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@45', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@45', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@48', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@48', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@48', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@52', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@52', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@52', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@56', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@56', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@56', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@60', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@60', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@60', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@64', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@64', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@64', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@68', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@68', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@68', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@72', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@72', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@72', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@76', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@76', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('task.dataQuality@76', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'vendor' THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'vendor' OR NEW."entityKind" = 'vendor') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@15', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@15', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@15', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@18', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@18', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@18', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@22', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@22', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('purchase.dataQuality@22', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialAccount' THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialAccount' OR NEW."entityKind" = 'financialAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialAccount.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'financialTransaction' THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'financialTransaction' OR NEW."entityKind" = 'financialTransaction') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'wish' THEN PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'wish' OR NEW."entityKind" = 'wish') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('wish.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@10', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@10', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('wish.dataQuality@10', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'expense' THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'expense' OR NEW."entityKind" = 'expense') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@8', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@8', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@8', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@12', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@12', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@16', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@16', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@16', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@20', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@20', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@20', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@24', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@24', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('expense.dataQuality@24', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'image' THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'image' OR NEW."entityKind" = 'image') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."imageId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."imageId"::uuid] || ARRAY[NEW."imageId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'planting' THEN PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'planting' OR NEW."entityKind" = 'planting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@6', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@6', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@6', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@13', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@13', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('planting.dataQuality@13', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'gardenEntry' THEN PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'gardenEntry' OR NEW."entityKind" = 'gardenEntry') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'productCategory' THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'productCategory' OR NEW."entityKind" = 'productCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('productCategory.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('productCategory.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'run' THEN PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'run' OR NEW."entityKind" = 'run') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('run.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('run.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'device' THEN PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'device' OR NEW."entityKind" = 'device') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('device.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('device.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@9', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@9', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('device.dataQuality@9', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'plant' THEN PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'plant' OR NEW."entityKind" = 'plant') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@5', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@5', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@5', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@10', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@10', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@10', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@14', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@14', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (true OR true) AND (OLD."entityId", OLD."deletedAt", OLD."imageId", OLD."purpose", OLD."role") IS DISTINCT FROM (NEW."entityId", NEW."deletedAt", NEW."imageId", NEW."purpose", NEW."role") THEN
    PERFORM derived_mark('plant.dataQuality@14', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'spendingCategory' THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'spendingCategory' OR NEW."entityKind" = 'spendingCategory') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'email' THEN PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'email' OR NEW."entityKind" = 'email') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'imageJob' THEN PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'imageJob' OR NEW."entityKind" = 'imageJob') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('imageJob.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'sourceTransactionRecord' THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'sourceTransactionRecord' OR NEW."entityKind" = 'sourceTransactionRecord') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'transactionImport' THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'transactionImport' THEN PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'transactionImport' OR NEW."entityKind" = 'transactionImport') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('transactionImport.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity attachment created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'shipment' THEN PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity attachment removed'); END IF;
  ELSIF (OLD."entityKind" = 'shipment' OR NEW."entityKind" = 'shipment') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('shipment.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity attachment changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "EntityAttachment_derived_mark" ON "EntityAttachment";
CREATE TRIGGER "EntityAttachment_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EntityAttachment"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_entityattachment();

CREATE OR REPLACE FUNCTION derived_mark_entityexternalid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.food', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.food', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.food', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('recipe.totals@0', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('recipe.totals@0', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.totals@0', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@12', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'product' THEN PERFORM derived_mark('inventory.searchDocument@12', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'product' OR NEW."entityKind" = 'product') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@12', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@6', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity external id changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."entityId"::uuid], 'Entity external id created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entityKind" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid], 'Entity external id removed'); END IF;
  ELSIF (OLD."entityKind" = 'purchase' OR NEW."entityKind" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."entityId"::uuid] || ARRAY[NEW."entityId"::uuid], 'Entity external id changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "EntityExternalId_derived_mark" ON "EntityExternalId";
CREATE TRIGGER "EntityExternalId_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EntityExternalId"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_entityexternalid();

CREATE OR REPLACE FUNCTION derived_mark_entitylink() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.price@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.price@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.price@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.cost@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.cost@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.readFacts@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@21', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@21', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@21', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@28', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts@28', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@28', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@12', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership@12', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@12', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@2', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@3', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@3', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@3', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@5', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'productComponent' THEN PERFORM derived_mark('inventory.valuation@5', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'productComponent' OR NEW."kind" = 'productComponent') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.valuation@5', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@6', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@6', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@6', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@13', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@13', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@13', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@18', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('inventory.ownership@18', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@18', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@7', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('project.dataQuality@18', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('project.dataQuality@18', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('project.dataQuality@18', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@25', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@25', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('task.dataQuality@25', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@62', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'projectTool' THEN PERFORM derived_mark('task.dataQuality@62', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'projectTool' OR NEW."kind" = 'projectTool') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('task.dataQuality@62', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchaseProduct' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchaseProduct' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchaseProduct' OR NEW."kind" = 'purchaseProduct') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'purchasePaymentAccount' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'purchasePaymentAccount' OR NEW."kind" = 'purchasePaymentAccount') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@26', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.dataQuality@4', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'wishCandidate' THEN PERFORM derived_mark('wish.dataQuality@4', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'wishCandidate' OR NEW."kind" = 'wishCandidate') AND (OLD."fromEntityId", OLD."deletedAt", OLD."toEntityId", OLD."kind") IS DISTINCT FROM (NEW."fromEntityId", NEW."deletedAt", NEW."toEntityId", NEW."kind") THEN
    PERFORM derived_mark('wish.dataQuality@4', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('planting.dataQuality@4', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('planting.dataQuality@4', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (OLD."toEntityId", OLD."deletedAt", OLD."fromEntityId", OLD."kind") IS DISTINCT FROM (NEW."toEntityId", NEW."deletedAt", NEW."fromEntityId", NEW."kind") THEN
    PERFORM derived_mark('planting.dataQuality@4', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[NEW."fromEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument', ARRAY[OLD."fromEntityId"::uuid] || ARRAY[NEW."fromEntityId"::uuid], 'Entity link changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('plant.dataQuality@8', ARRAY[NEW."toEntityId"::uuid], 'Entity link created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."kind" = 'gardenEntryPlanting' THEN PERFORM derived_mark('plant.dataQuality@8', ARRAY[OLD."toEntityId"::uuid], 'Entity link removed'); END IF;
  ELSIF (OLD."kind" = 'gardenEntryPlanting' OR NEW."kind" = 'gardenEntryPlanting') AND (OLD."toEntityId", OLD."deletedAt", OLD."fromEntityId", OLD."kind") IS DISTINCT FROM (NEW."toEntityId", NEW."deletedAt", NEW."fromEntityId", NEW."kind") THEN
    PERFORM derived_mark('plant.dataQuality@8', ARRAY[OLD."toEntityId"::uuid] || ARRAY[NEW."toEntityId"::uuid], 'Entity link changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "EntityLink_derived_mark" ON "EntityLink";
CREATE TRIGGER "EntityLink_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "EntityLink"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_entitylink();

CREATE OR REPLACE FUNCTION derived_mark_expense() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@20', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@20', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@20', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@27', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@27', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@27', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@4', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@4', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@4', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@11', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@11', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@11', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@7', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@7', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@7', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@23', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@23', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@23', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@1', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@6', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@6', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."productId", OLD."cost", OLD."productQuantity", OLD."lineKind", OLD."future", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."productId", NEW."cost", NEW."productQuantity", NEW."lineKind", NEW."future", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@6', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@3', ARRAY[NEW."productId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@3', ARRAY[OLD."productId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@3', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@5', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@5', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@5', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@12', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@12', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@12', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@8', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."date", OLD."purchaseId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."date", NEW."purchaseId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."cost", OLD."future", OLD."lineKind", OLD."date", OLD."purchaseId", OLD."productId", OLD."deletedAt") IS DISTINCT FROM (NEW."projectId", NEW."cost", NEW."future", NEW."lineKind", NEW."date", NEW."purchaseId", NEW."productId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@12', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@12', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@12', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@14', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@14', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('project.dataQuality@14', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@21', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@21', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('task.dataQuality@21', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@58', ARRAY[NEW."projectId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@58', ARRAY[OLD."projectId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."projectId", OLD."deletedAt", OLD."productId", OLD."purchaseId", OLD."lineKind") IS DISTINCT FROM (NEW."projectId", NEW."deletedAt", NEW."productId", NEW."purchaseId", NEW."lineKind") THEN
    PERFORM derived_mark('task.dataQuality@58', ARRAY[OLD."projectId"::uuid] || ARRAY[NEW."projectId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('purchase.dataQuality@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@10', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@25', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."cost", OLD."future", OLD."purchaseId", OLD."deletedAt", OLD."name") IS DISTINCT FROM (NEW."id", NEW."cost", NEW."future", NEW."purchaseId", NEW."deletedAt", NEW."name") THEN
    PERFORM derived_mark('expense.beneficiaryResult', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@13', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@13', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."cost", OLD."lineKind", OLD."productId", OLD."projectId", OLD."spendingCategoryId", OLD."trade", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."purchaseId", NEW."cost", NEW."lineKind", NEW."productId", NEW."projectId", NEW."spendingCategoryId", NEW."trade", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@13', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[NEW."id"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@14', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@14', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."deletedAt", OLD."productId", OLD."projectId", OLD."lineKind") IS DISTINCT FROM (NEW."purchaseId", NEW."deletedAt", NEW."productId", NEW."projectId", NEW."lineKind") THEN
    PERFORM derived_mark('expense.dataQuality@14', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@31', ARRAY[NEW."purchaseId"::uuid], 'Expense created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@31', ARRAY[OLD."purchaseId"::uuid], 'Expense removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."cost", OLD."lineKind", OLD."productId", OLD."projectId", OLD."spendingCategoryId", OLD."trade", OLD."future", OLD."deletedAt") IS DISTINCT FROM (NEW."purchaseId", NEW."cost", NEW."lineKind", NEW."productId", NEW."projectId", NEW."spendingCategoryId", NEW."trade", NEW."future", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@31', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Expense changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "Expense_derived_mark" ON "Expense";
CREATE TRIGGER "Expense_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_expense();

CREATE OR REPLACE FUNCTION derived_mark_financialaccount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@25', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@25', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@32', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@32', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@9', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@9', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@16', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@16', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@10', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@10', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@17', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@17', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[NEW."ledgerPartyId"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."ledgerPartyId"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerParty.dataQuality', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@26', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@26', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@27', ARRAY[NEW."providerVendorId"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@27', ARRAY[OLD."providerVendorId"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (OLD."providerVendorId", OLD."identity", OLD."ledgerPartyId", OLD."deletedAt") IS DISTINCT FROM (NEW."providerVendorId", NEW."identity", NEW."ledgerPartyId", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@27', ARRAY[OLD."providerVendorId"::uuid] || ARRAY[NEW."providerVendorId"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@29', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@29', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@13', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@13', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[NEW."id"::uuid], 'Financial account created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[OLD."id"::uuid], 'Financial account removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Financial account changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "FinancialAccount_derived_mark" ON "FinancialAccount";
CREATE TRIGGER "FinancialAccount_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "FinancialAccount"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_financialaccount();

CREATE OR REPLACE FUNCTION derived_mark_financialevidencealias() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."historicalTransactionId"::uuid], 'Financial evidence alias created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."historicalTransactionId"::uuid], 'Financial evidence alias removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."historicalTransactionId"::uuid] || ARRAY[NEW."historicalTransactionId"::uuid], 'Financial evidence alias changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."historicalTransactionId"::uuid], 'Financial evidence alias created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."historicalTransactionId"::uuid], 'Financial evidence alias removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."historicalTransactionId"::uuid] || ARRAY[NEW."historicalTransactionId"::uuid], 'Financial evidence alias changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "FinancialEvidenceAlias_derived_mark" ON "FinancialEvidenceAlias";
CREATE TRIGGER "FinancialEvidenceAlias_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "FinancialEvidenceAlias"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_financialevidencealias();

CREATE OR REPLACE FUNCTION derived_mark_financialtransactionallocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@23', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@23', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@23', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@30', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@30', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@30', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@7', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@7', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@7', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@14', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@14', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@14', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@8', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@8', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@8', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@15', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@15', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@15', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@12', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (OLD."transactionId", OLD."deletedAt", OLD."purchaseId") IS DISTINCT FROM (NEW."transactionId", NEW."deletedAt", NEW."purchaseId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@6', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."transactionId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."transactionId"::uuid] || ARRAY[NEW."transactionId"::uuid], 'Financial transaction allocation changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[OLD."purchaseId"::uuid], 'Financial transaction allocation removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@3', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Financial transaction allocation changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "FinancialTransactionAllocation_derived_mark" ON "FinancialTransactionAllocation";
CREATE TRIGGER "FinancialTransactionAllocation_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "FinancialTransactionAllocation"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_financialtransactionallocation();

CREATE OR REPLACE FUNCTION derived_mark_image() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('product.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('product.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('product.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('recipe.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('recipe.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('ingredient.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('ingredient.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('ingredient.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('cookbook.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('cookbook.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('cookbook.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('location.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('location.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('location.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('location.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('inventory.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('inventory.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('meal.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('meal.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('meal.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('meal.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerParty.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('ledgerTransfer.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@14', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('project.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('project.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@25', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@25', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@29', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@29', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@33', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@33', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('project.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('task.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('task.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@12', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@12', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@16', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@16', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@20', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@20', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@24', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@24', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@28', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@28', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@32', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@32', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@36', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@36', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@36', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@40', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@40', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@40', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@46', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@46', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@46', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@49', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@49', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@49', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@53', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@53', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@53', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@57', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@57', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@57', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@61', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@61', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@61', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@65', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@65', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@65', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@69', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@69', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@69', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@73', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@73', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@73', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@77', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@77', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('task.dataQuality@77', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('vendor.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('purchase.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@16', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@16', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@16', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@19', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@19', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@23', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@23', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('purchase.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('financialAccount.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialAccount.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('wish.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('wish.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@11', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@11', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('wish.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('expense.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@9', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@9', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@13', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@13', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@17', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@17', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@21', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@21', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@25', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@25', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('expense.dataQuality@25', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('image.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('image.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('image.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('planting.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@14', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@14', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('planting.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('gardenEntry.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('productCategory.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('productCategory.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('run.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('run.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('device.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@10', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@10', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('device.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('plant.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@7', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.searchDocument@7', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."sha256", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."sha256", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.searchDocument@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@6', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@6', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@11', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@11', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@15', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@15', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType") THEN
    PERFORM derived_mark('plant.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('spendingCategory.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('imageJob.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('transactionImport.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument@2', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.searchDocument@2', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."shortcode") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."shortcode") THEN
    PERFORM derived_mark('shipment.searchDocument@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@3', ARRAY[NEW."id"::uuid], 'Image created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@3', ARRAY[OLD."id"::uuid], 'Image removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."renderStatus", OLD."storageStatus", OLD."detectedContentType", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."renderStatus", NEW."storageStatus", NEW."detectedContentType", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.dataQuality@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Image changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "Image_derived_mark" ON "Image";
CREATE TRIGGER "Image_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Image"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_image();

CREATE OR REPLACE FUNCTION derived_mark_importsourceorder() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@18', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@18', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@18', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@31', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@31', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@31', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[NEW."purchaseId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[OLD."purchaseId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId") THEN
    PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(NEW."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(OLD."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId", OLD."checksum") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId", NEW."checksum") THEN
    PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(OLD."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source order changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@9', ARRAY[NEW."sourceClaimId"::uuid], 'Import source order created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@9', ARRAY[OLD."sourceClaimId"::uuid], 'Import source order removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@9', ARRAY[OLD."sourceClaimId"::uuid] || ARRAY[NEW."sourceClaimId"::uuid], 'Import source order changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "ImportSourceOrder_derived_mark" ON "ImportSourceOrder";
CREATE TRIGGER "ImportSourceOrder_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ImportSourceOrder"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_importsourceorder();

CREATE OR REPLACE FUNCTION derived_mark_importsourceproduct() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."productId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."productId"::uuid] || ARRAY[NEW."productId"::uuid], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@45', ARRAY[NEW."sourceOrderId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@45', ARRAY[OLD."sourceOrderId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@45', ARRAY[OLD."sourceOrderId"::uuid] || ARRAY[NEW."sourceOrderId"::uuid], 'Import source product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@32', ARRAY[NEW."sourceOrderId"::uuid], 'Import source product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@32', ARRAY[OLD."sourceOrderId"::uuid], 'Import source product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@32', ARRAY[OLD."sourceOrderId"::uuid] || ARRAY[NEW."sourceOrderId"::uuid], 'Import source product changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "ImportSourceProduct_derived_mark" ON "ImportSourceProduct";
CREATE TRIGGER "ImportSourceProduct_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ImportSourceProduct"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_importsourceproduct();

CREATE OR REPLACE FUNCTION derived_mark_product() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.quantityVariance', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."expectedQuantity", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."expectedQuantity", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."stockTracked", OLD."categoryId") IS DISTINCT FROM (NEW."id", NEW."stockTracked", NEW."categoryId") THEN
    PERFORM derived_mark('product.readFacts', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.food', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.food', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."fdc_id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."fdc_id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.food', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.ownership', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.conversionCoverage', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."name", OLD."shortcode", OLD."categoryId", OLD."fdc_id", OLD."labelNutrition", OLD."usdaUnavailable", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."ingredientId", NEW."name", NEW."shortcode", NEW."categoryId", NEW."fdc_id", NEW."labelNutrition", NEW."usdaUnavailable", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('recipe.totals@2', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."ingredientId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('ingredient.dataQuality@4', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."ingredientId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."ingredientId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('ingredient.dataQuality@7', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[NEW."ingredientId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.dataQuality', ARRAY[OLD."ingredientId"::uuid] || ARRAY[NEW."ingredientId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('cookbook.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@1', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.valuationRollup@1', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."deletedAt") THEN
    PERFORM derived_mark('location.valuationRollup@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('location.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@0', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@0', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@0', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."price", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."price", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@1', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@1', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.ownership@1', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@10', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@10', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('inventory.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@18', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@18', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('inventory.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@34', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@21', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@19', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@19', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@30', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@30', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('project.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@12', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.searchDocument@12', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@13', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@13', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@18', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@18', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@29', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@29', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@33', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@33', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@33', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@37', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@37', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@37', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@44', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@44', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@50', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@50', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@50', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@55', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@55', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@55', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@59', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@59', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@59', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@63', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@63', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@63', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@66', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@66', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@66', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@70', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@70', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@70', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@74', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@74', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('task.dataQuality@74', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@14', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@14', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@20', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@20', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('purchase.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@34', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@34', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."categoryId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."categoryId") THEN
    PERFORM derived_mark('purchase.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."model", OLD."brandId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."model", NEW."brandId", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@5', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@5', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('wish.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@10', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@10', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('expense.dataQuality@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@15', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@15', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@22', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@22', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('expense.dataQuality@22', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@26', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@26', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."categoryId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."categoryId", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@35', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@35', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@8', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@8', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@11', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@11', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('planting.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[NEW."categoryId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[OLD."categoryId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."categoryId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."categoryId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('productCategory.dataQuality@4', ARRAY[OLD."categoryId"::uuid] || ARRAY[NEW."categoryId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[NEW."categoryId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[OLD."categoryId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."categoryId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."categoryId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('productCategory.dataQuality@7', ARRAY[OLD."categoryId"::uuid] || ARRAY[NEW."categoryId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@4', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@4', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@7', ARRAY[NEW."id"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@7', ARRAY[OLD."id"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('device.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@4', ARRAY[NEW."growsPlantId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@4', ARRAY[OLD."growsPlantId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."growsPlantId", OLD."deletedAt", OLD."id") IS DISTINCT FROM (NEW."growsPlantId", NEW."deletedAt", NEW."id") THEN
    PERFORM derived_mark('plant.dataQuality@4', ARRAY[OLD."growsPlantId"::uuid] || ARRAY[NEW."growsPlantId"::uuid], 'Product changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@12', ARRAY[NEW."growsPlantId"::uuid], 'Product created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@12', ARRAY[OLD."growsPlantId"::uuid], 'Product removed'); END IF;
  ELSIF (true OR true) AND (OLD."growsPlantId", OLD."deletedAt", OLD."brandId") IS DISTINCT FROM (NEW."growsPlantId", NEW."deletedAt", NEW."brandId") THEN
    PERFORM derived_mark('plant.dataQuality@12', ARRAY[OLD."growsPlantId"::uuid] || ARRAY[NEW."growsPlantId"::uuid], 'Product changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "Product_derived_mark" ON "Product";
CREATE TRIGGER "Product_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Product"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_product();

CREATE OR REPLACE FUNCTION derived_mark_productcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.price@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.price@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.price@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.cost@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.cost@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.cost@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ledgerExpectedQuantity@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.quantityVariance@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@15', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@15', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."stockTracked", OLD."parentId", OLD."name", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."stockTracked", NEW."parentId", NEW."name", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.readFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@3', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.conversionCoverage@3', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('product.conversionCoverage@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@10', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@10', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@28', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@28', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@4', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@4', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@8', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.valuation@8', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.valuation@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@10', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@10', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@35', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@22', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@6', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@6', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."feature", OLD."parentId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."feature", NEW."parentId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@6', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@35', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@35', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@35', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@9', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@9', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@27', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@27', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."parentId", OLD."feature", OLD."spendingCategoryId", OLD."spendingCategoryMode", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."parentId", NEW."feature", NEW."spendingCategoryId", NEW."spendingCategoryMode", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[NEW."id"::uuid], 'Product category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid], 'Product category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('productCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Product category changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "ProductCategory_derived_mark" ON "ProductCategory";
CREATE TRIGGER "ProductCategory_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "ProductCategory"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_productcategory();

CREATE OR REPLACE FUNCTION derived_mark_purchase() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@19', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@19', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@26', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.readFacts@26', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.readFacts@26', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@3', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@3', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@3', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.ownership@10', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.ownership@10', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.ownership@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@18', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@18', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@19', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@19', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@11', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.ownership@11', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.ownership@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@38', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@38', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@38', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@14', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@14', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.rollups@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@5', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@5', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@4', ARRAY[NEW."defaultProjectId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@4', ARRAY[OLD."defaultProjectId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@4', ARRAY[OLD."defaultProjectId"::uuid] || ARRAY[NEW."defaultProjectId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@5', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@5', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorId", OLD."defaultProjectId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorId", NEW."defaultProjectId", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."vendorId"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."vendorId"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."vendorId", OLD."deletedAt") IS DISTINCT FROM (NEW."vendorId", NEW."deletedAt") THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."vendorId"::uuid] || ARRAY[NEW."vendorId"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."vendorId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."vendorId") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.beneficiaryResult@2', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@17', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@17', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@7', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@7', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@18', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@18', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."vendorId") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."vendorId") THEN
    PERFORM derived_mark('expense.dataQuality@18', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@34', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@34', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."orderId", OLD."vendorId", OLD."vendorAccountId", OLD."statedTotal", OLD."date", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."orderId", NEW."vendorId", NEW."vendorAccountId", NEW."statedTotal", NEW."date", NEW."deletedAt") THEN
    PERFORM derived_mark('email.relationshipFacts@5', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."vendorAccountId", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."vendorAccountId", NEW."deletedAt") THEN
    PERFORM derived_mark('email.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@11', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@11', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@4', ARRAY[NEW."id"::uuid], 'Purchase created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('shipment.dataQuality@4', ARRAY[OLD."id"::uuid], 'Purchase removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('shipment.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Purchase changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "Purchase_derived_mark" ON "Purchase";
CREATE TRIGGER "Purchase_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Purchase"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_purchase();

CREATE OR REPLACE FUNCTION derived_mark_sourceobservationannotation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[NEW."observationId"::uuid], 'Source observation annotation created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."observationId"::uuid], 'Source observation annotation removed'); END IF;
  ELSIF (true OR true) AND (OLD."observationId", OLD."notes") IS DISTINCT FROM (NEW."observationId", NEW."notes") THEN
    PERFORM derived_mark('sourceTransactionRecord.searchDocument', ARRAY[OLD."observationId"::uuid] || ARRAY[NEW."observationId"::uuid], 'Source observation annotation changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "SourceObservationAnnotation_derived_mark" ON "SourceObservationAnnotation";
CREATE TRIGGER "SourceObservationAnnotation_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "SourceObservationAnnotation"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_sourceobservationannotation();

CREATE OR REPLACE FUNCTION derived_mark_sourceoccurrence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[NEW."acceptedTransactionId"::uuid], 'Source occurrence created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."acceptedTransactionId"::uuid], 'Source occurrence removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument', ARRAY[OLD."acceptedTransactionId"::uuid] || ARRAY[NEW."acceptedTransactionId"::uuid], 'Source occurrence changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[NEW."acceptedTransactionId"::uuid], 'Source occurrence created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."acceptedTransactionId"::uuid], 'Source occurrence removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.dataQuality', ARRAY[OLD."acceptedTransactionId"::uuid] || ARRAY[NEW."acceptedTransactionId"::uuid], 'Source occurrence changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "SourceOccurrence_derived_mark" ON "SourceOccurrence";
CREATE TRIGGER "SourceOccurrence_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "SourceOccurrence"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_sourceoccurrence();

CREATE OR REPLACE FUNCTION derived_mark_spendingcategory() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.startDate@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.startDate@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.startDate@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.completionYear@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.completionYear@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@45', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.rollups@7', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.rollups@7', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.rollups@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@32', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@32', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('purchase.dataQuality@32', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@11', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@11', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.searchDocument@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@12', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@12', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.searchDocument@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@29', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@29', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.dataQuality@29', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@30', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@30', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt", OLD."productExpectation") IS DISTINCT FROM (NEW."id", NEW."deletedAt", NEW."productExpectation") THEN
    PERFORM derived_mark('expense.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[NEW."id"::uuid], 'Spending category created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."id"::uuid], 'Spending category removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('spendingCategory.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Spending category changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "SpendingCategory_derived_mark" ON "SpendingCategory";
CREATE TRIGGER "SpendingCategory_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "SpendingCategory"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_spendingcategory();

CREATE OR REPLACE FUNCTION derived_mark_vendor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@9', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.searchDocument@9', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@5', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@5', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@5', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@20', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('product.dataQuality@20', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('product.dataQuality@20', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('ingredient.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('cookbook.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('location.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('location.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@11', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@11', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@19', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('inventory.dataQuality@19', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('inventory.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@48', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@23', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@23', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@27', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@27', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@27', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@31', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.dataQuality@31', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('project.dataQuality@31', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@14', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@14', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@14', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@30', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@30', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@30', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@34', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@34', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@34', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@38', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@38', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@38', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@51', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@51', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@51', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@67', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@67', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@67', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@71', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@71', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@71', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@75', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('task.dataQuality@75', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('task.dataQuality@75', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.dataQuality', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@17', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@17', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@17', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@21', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@21', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('purchase.dataQuality@21', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@44', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@44', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@44', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.searchDocument@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('financialAccount.dataQuality@7', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@15', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt", OLD."itemizationExpectation") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt", NEW."itemizationExpectation") THEN
    PERFORM derived_mark('financialTransaction.dataQuality@24', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@9', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('wish.dataQuality@9', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('wish.dataQuality@9', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@10', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.searchDocument@10', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.searchDocument@10', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@11', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@11', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@11', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@19', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@19', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@19', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@23', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@23', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@23', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@28', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.dataQuality@28', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."name", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."name", NEW."deletedAt") THEN
    PERFORM derived_mark('expense.dataQuality@28', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@12', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('planting.dataQuality@12', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('planting.dataQuality@12', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('productCategory.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@4', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('run.dataQuality@4', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('run.dataQuality@4', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@8', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('device.dataQuality@8', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('device.dataQuality@8', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@13', ARRAY[NEW."id"::uuid], 'Vendor created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('plant.dataQuality@13', ARRAY[OLD."id"::uuid], 'Vendor removed'); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."deletedAt") IS DISTINCT FROM (NEW."id", NEW."deletedAt") THEN
    PERFORM derived_mark('plant.dataQuality@13', ARRAY[OLD."id"::uuid] || ARRAY[NEW."id"::uuid], 'Vendor changed');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "Vendor_derived_mark" ON "Vendor";
CREATE TRIGGER "Vendor_derived_mark" AFTER INSERT OR UPDATE OR DELETE ON "Vendor"
  FOR EACH ROW EXECUTE FUNCTION derived_mark_vendor();