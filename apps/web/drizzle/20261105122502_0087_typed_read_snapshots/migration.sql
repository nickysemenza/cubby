SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
LOCK TABLE "DerivedValue" IN SHARE MODE;
--> statement-breakpoint
CREATE TABLE "EmailReadSnapshot" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'email' NOT NULL,
	"relationshipFacts" jsonb,
	"relationshipFactsDecision" jsonb,
	"relationshipFactsComputedAt" timestamp,
	"relationshipFactsSort" text
);
--> statement-breakpoint
CREATE TABLE "ExpenseReadSnapshot" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'expense' NOT NULL,
	"beneficiaryResult" jsonb,
	"beneficiaryResultDecision" jsonb,
	"beneficiaryResultComputedAt" timestamp,
	"beneficiaryResultSort" text
);
--> statement-breakpoint
CREATE TABLE "InventoryReadSnapshot" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'inventory' NOT NULL,
	"valuation" double precision,
	"valuationDecision" jsonb,
	"valuationComputedAt" timestamp,
	"valuationSort" double precision,
	"ownership" jsonb,
	"ownershipDecision" jsonb,
	"ownershipComputedAt" timestamp,
	"ownershipSort" text
);
--> statement-breakpoint
CREATE TABLE "LocationReadSnapshot" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'location' NOT NULL,
	"valuationRollup" jsonb,
	"valuationRollupDecision" jsonb,
	"valuationRollupComputedAt" timestamp,
	"valuationRollupSort" double precision
);
--> statement-breakpoint
CREATE TABLE "ProductReadSnapshot" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'product' NOT NULL,
	"price" double precision,
	"priceDecision" jsonb,
	"priceComputedAt" timestamp,
	"priceSort" double precision,
	"ledgerExpectedQuantity" double precision,
	"ledgerExpectedQuantityDecision" jsonb,
	"ledgerExpectedQuantityComputedAt" timestamp,
	"ledgerExpectedQuantitySort" double precision,
	"quantityVariance" double precision,
	"quantityVarianceDecision" jsonb,
	"quantityVarianceComputedAt" timestamp,
	"quantityVarianceSort" double precision,
	"readFacts" jsonb,
	"readFactsDecision" jsonb,
	"readFactsComputedAt" timestamp,
	"readFactsSort" text,
	"food" jsonb,
	"foodDecision" jsonb,
	"foodComputedAt" timestamp,
	"foodSort" text,
	"ownership" jsonb,
	"ownershipDecision" jsonb,
	"ownershipComputedAt" timestamp,
	"ownershipSort" text
);
--> statement-breakpoint
CREATE TABLE "ProjectReadSnapshot" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'project' NOT NULL,
	"startDate" text,
	"startDateDecision" jsonb,
	"startDateComputedAt" timestamp,
	"startDateSort" timestamp,
	"completionYear" text,
	"completionYearDecision" jsonb,
	"completionYearComputedAt" timestamp,
	"completionYearSort" text,
	"workDiagnosticFacts" jsonb,
	"workDiagnosticFactsDecision" jsonb,
	"workDiagnosticFactsComputedAt" timestamp,
	"workDiagnosticFactsSort" text,
	"rollups" jsonb,
	"rollupsDecision" jsonb,
	"rollupsComputedAt" timestamp,
	"rollupsSort" text
);
--> statement-breakpoint
CREATE TABLE "ShipmentReadSnapshot" (
	"entityId" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'shipment' NOT NULL,
	"eventSummary" jsonb,
	"eventSummaryDecision" jsonb,
	"eventSummaryComputedAt" timestamp,
	"eventSummarySort" text
);
--> statement-breakpoint
INSERT INTO "ProductReadSnapshot" ("entityId",kind,"price","priceDecision","priceSort","priceComputedAt")
SELECT "entityId",kind,(value #>> '{}')::double precision,"decidedBy","sortNumber","computedAt" FROM "DerivedValue" WHERE kind='product' AND key='price'
ON CONFLICT ("entityId") DO UPDATE SET "price"=EXCLUDED."price","priceDecision"=EXCLUDED."priceDecision","priceSort"=EXCLUDED."priceSort","priceComputedAt"=EXCLUDED."priceComputedAt";
--> statement-breakpoint
INSERT INTO "ProductReadSnapshot" ("entityId",kind,"ledgerExpectedQuantity","ledgerExpectedQuantityDecision","ledgerExpectedQuantitySort","ledgerExpectedQuantityComputedAt")
SELECT "entityId",kind,(value #>> '{}')::double precision,"decidedBy","sortNumber","computedAt" FROM "DerivedValue" WHERE kind='product' AND key='ledgerExpectedQuantity'
ON CONFLICT ("entityId") DO UPDATE SET "ledgerExpectedQuantity"=EXCLUDED."ledgerExpectedQuantity","ledgerExpectedQuantityDecision"=EXCLUDED."ledgerExpectedQuantityDecision","ledgerExpectedQuantitySort"=EXCLUDED."ledgerExpectedQuantitySort","ledgerExpectedQuantityComputedAt"=EXCLUDED."ledgerExpectedQuantityComputedAt";
--> statement-breakpoint
INSERT INTO "ProductReadSnapshot" ("entityId",kind,"quantityVariance","quantityVarianceDecision","quantityVarianceSort","quantityVarianceComputedAt")
SELECT "entityId",kind,(value #>> '{}')::double precision,"decidedBy","sortNumber","computedAt" FROM "DerivedValue" WHERE kind='product' AND key='quantityVariance'
ON CONFLICT ("entityId") DO UPDATE SET "quantityVariance"=EXCLUDED."quantityVariance","quantityVarianceDecision"=EXCLUDED."quantityVarianceDecision","quantityVarianceSort"=EXCLUDED."quantityVarianceSort","quantityVarianceComputedAt"=EXCLUDED."quantityVarianceComputedAt";
--> statement-breakpoint
INSERT INTO "ProductReadSnapshot" ("entityId",kind,"readFacts","readFactsDecision","readFactsSort","readFactsComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='product' AND key='readFacts'
ON CONFLICT ("entityId") DO UPDATE SET "readFacts"=EXCLUDED."readFacts","readFactsDecision"=EXCLUDED."readFactsDecision","readFactsSort"=EXCLUDED."readFactsSort","readFactsComputedAt"=EXCLUDED."readFactsComputedAt";
--> statement-breakpoint
INSERT INTO "ProductReadSnapshot" ("entityId",kind,"food","foodDecision","foodSort","foodComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='product' AND key='food'
ON CONFLICT ("entityId") DO UPDATE SET "food"=EXCLUDED."food","foodDecision"=EXCLUDED."foodDecision","foodSort"=EXCLUDED."foodSort","foodComputedAt"=EXCLUDED."foodComputedAt";
--> statement-breakpoint
INSERT INTO "ProductReadSnapshot" ("entityId",kind,"ownership","ownershipDecision","ownershipSort","ownershipComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='product' AND key='ownership'
ON CONFLICT ("entityId") DO UPDATE SET "ownership"=EXCLUDED."ownership","ownershipDecision"=EXCLUDED."ownershipDecision","ownershipSort"=EXCLUDED."ownershipSort","ownershipComputedAt"=EXCLUDED."ownershipComputedAt";
--> statement-breakpoint
INSERT INTO "InventoryReadSnapshot" ("entityId",kind,"valuation","valuationDecision","valuationSort","valuationComputedAt")
SELECT "entityId",kind,(value #>> '{}')::double precision,"decidedBy","sortNumber","computedAt" FROM "DerivedValue" WHERE kind='inventory' AND key='valuation'
ON CONFLICT ("entityId") DO UPDATE SET "valuation"=EXCLUDED."valuation","valuationDecision"=EXCLUDED."valuationDecision","valuationSort"=EXCLUDED."valuationSort","valuationComputedAt"=EXCLUDED."valuationComputedAt";
--> statement-breakpoint
INSERT INTO "InventoryReadSnapshot" ("entityId",kind,"ownership","ownershipDecision","ownershipSort","ownershipComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='inventory' AND key='ownership'
ON CONFLICT ("entityId") DO UPDATE SET "ownership"=EXCLUDED."ownership","ownershipDecision"=EXCLUDED."ownershipDecision","ownershipSort"=EXCLUDED."ownershipSort","ownershipComputedAt"=EXCLUDED."ownershipComputedAt";
--> statement-breakpoint
INSERT INTO "LocationReadSnapshot" ("entityId",kind,"valuationRollup","valuationRollupDecision","valuationRollupSort","valuationRollupComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortNumber","computedAt" FROM "DerivedValue" WHERE kind='location' AND key='valuationRollup'
ON CONFLICT ("entityId") DO UPDATE SET "valuationRollup"=EXCLUDED."valuationRollup","valuationRollupDecision"=EXCLUDED."valuationRollupDecision","valuationRollupSort"=EXCLUDED."valuationRollupSort","valuationRollupComputedAt"=EXCLUDED."valuationRollupComputedAt";
--> statement-breakpoint
INSERT INTO "ProjectReadSnapshot" ("entityId",kind,"startDate","startDateDecision","startDateSort","startDateComputedAt")
SELECT "entityId",kind,(value #>> '{}'),"decidedBy","sortDate","computedAt" FROM "DerivedValue" WHERE kind='project' AND key='startDate'
ON CONFLICT ("entityId") DO UPDATE SET "startDate"=EXCLUDED."startDate","startDateDecision"=EXCLUDED."startDateDecision","startDateSort"=EXCLUDED."startDateSort","startDateComputedAt"=EXCLUDED."startDateComputedAt";
--> statement-breakpoint
INSERT INTO "ProjectReadSnapshot" ("entityId",kind,"completionYear","completionYearDecision","completionYearSort","completionYearComputedAt")
SELECT "entityId",kind,(value #>> '{}'),"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='project' AND key='completionYear'
ON CONFLICT ("entityId") DO UPDATE SET "completionYear"=EXCLUDED."completionYear","completionYearDecision"=EXCLUDED."completionYearDecision","completionYearSort"=EXCLUDED."completionYearSort","completionYearComputedAt"=EXCLUDED."completionYearComputedAt";
--> statement-breakpoint
INSERT INTO "ProjectReadSnapshot" ("entityId",kind,"workDiagnosticFacts","workDiagnosticFactsDecision","workDiagnosticFactsSort","workDiagnosticFactsComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='project' AND key='workDiagnosticFacts'
ON CONFLICT ("entityId") DO UPDATE SET "workDiagnosticFacts"=EXCLUDED."workDiagnosticFacts","workDiagnosticFactsDecision"=EXCLUDED."workDiagnosticFactsDecision","workDiagnosticFactsSort"=EXCLUDED."workDiagnosticFactsSort","workDiagnosticFactsComputedAt"=EXCLUDED."workDiagnosticFactsComputedAt";
--> statement-breakpoint
INSERT INTO "ProjectReadSnapshot" ("entityId",kind,"rollups","rollupsDecision","rollupsSort","rollupsComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='project' AND key='rollups'
ON CONFLICT ("entityId") DO UPDATE SET "rollups"=EXCLUDED."rollups","rollupsDecision"=EXCLUDED."rollupsDecision","rollupsSort"=EXCLUDED."rollupsSort","rollupsComputedAt"=EXCLUDED."rollupsComputedAt";
--> statement-breakpoint
INSERT INTO "ExpenseReadSnapshot" ("entityId",kind,"beneficiaryResult","beneficiaryResultDecision","beneficiaryResultSort","beneficiaryResultComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='expense' AND key='beneficiaryResult'
ON CONFLICT ("entityId") DO UPDATE SET "beneficiaryResult"=EXCLUDED."beneficiaryResult","beneficiaryResultDecision"=EXCLUDED."beneficiaryResultDecision","beneficiaryResultSort"=EXCLUDED."beneficiaryResultSort","beneficiaryResultComputedAt"=EXCLUDED."beneficiaryResultComputedAt";
--> statement-breakpoint
INSERT INTO "EmailReadSnapshot" ("entityId",kind,"relationshipFacts","relationshipFactsDecision","relationshipFactsSort","relationshipFactsComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='email' AND key='relationshipFacts'
ON CONFLICT ("entityId") DO UPDATE SET "relationshipFacts"=EXCLUDED."relationshipFacts","relationshipFactsDecision"=EXCLUDED."relationshipFactsDecision","relationshipFactsSort"=EXCLUDED."relationshipFactsSort","relationshipFactsComputedAt"=EXCLUDED."relationshipFactsComputedAt";
--> statement-breakpoint
INSERT INTO "ShipmentReadSnapshot" ("entityId",kind,"eventSummary","eventSummaryDecision","eventSummarySort","eventSummaryComputedAt")
SELECT "entityId",kind,value,"decidedBy","sortText","computedAt" FROM "DerivedValue" WHERE kind='shipment' AND key='eventSummary'
ON CONFLICT ("entityId") DO UPDATE SET "eventSummary"=EXCLUDED."eventSummary","eventSummaryDecision"=EXCLUDED."eventSummaryDecision","eventSummarySort"=EXCLUDED."eventSummarySort","eventSummaryComputedAt"=EXCLUDED."eventSummaryComputedAt";
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (WITH previous AS (SELECT "entityId",kind,key,coalesce(value,'null'::jsonb) AS value,"decidedBy","sortNumber","sortText","sortDate","computedAt" FROM "DerivedValue" WHERE (kind='product' AND key='price') OR (kind='product' AND key='ledgerExpectedQuantity') OR (kind='product' AND key='quantityVariance') OR (kind='product' AND key='readFacts') OR (kind='product' AND key='food') OR (kind='product' AND key='ownership') OR (kind='inventory' AND key='valuation') OR (kind='inventory' AND key='ownership') OR (kind='location' AND key='valuationRollup') OR (kind='project' AND key='startDate') OR (kind='project' AND key='completionYear') OR (kind='project' AND key='workDiagnosticFacts') OR (kind='project' AND key='rollups') OR (kind='expense' AND key='beneficiaryResult') OR (kind='email' AND key='relationshipFacts') OR (kind='shipment' AND key='eventSummary')),
    replacement AS (SELECT "entityId",kind,'price'::text AS key,coalesce(to_jsonb("price"),'null'::jsonb) AS value,"priceDecision" AS "decidedBy","priceSort" AS "sortNumber",NULL::text AS "sortText",NULL::timestamp AS "sortDate","priceComputedAt" AS "computedAt" FROM "ProductReadSnapshot" WHERE "priceComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'ledgerExpectedQuantity'::text AS key,coalesce(to_jsonb("ledgerExpectedQuantity"),'null'::jsonb) AS value,"ledgerExpectedQuantityDecision" AS "decidedBy","ledgerExpectedQuantitySort" AS "sortNumber",NULL::text AS "sortText",NULL::timestamp AS "sortDate","ledgerExpectedQuantityComputedAt" AS "computedAt" FROM "ProductReadSnapshot" WHERE "ledgerExpectedQuantityComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'quantityVariance'::text AS key,coalesce(to_jsonb("quantityVariance"),'null'::jsonb) AS value,"quantityVarianceDecision" AS "decidedBy","quantityVarianceSort" AS "sortNumber",NULL::text AS "sortText",NULL::timestamp AS "sortDate","quantityVarianceComputedAt" AS "computedAt" FROM "ProductReadSnapshot" WHERE "quantityVarianceComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'readFacts'::text AS key,coalesce(to_jsonb("readFacts"),'null'::jsonb) AS value,"readFactsDecision" AS "decidedBy",NULL::double precision AS "sortNumber","readFactsSort" AS "sortText",NULL::timestamp AS "sortDate","readFactsComputedAt" AS "computedAt" FROM "ProductReadSnapshot" WHERE "readFactsComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'food'::text AS key,coalesce(to_jsonb("food"),'null'::jsonb) AS value,"foodDecision" AS "decidedBy",NULL::double precision AS "sortNumber","foodSort" AS "sortText",NULL::timestamp AS "sortDate","foodComputedAt" AS "computedAt" FROM "ProductReadSnapshot" WHERE "foodComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'ownership'::text AS key,coalesce(to_jsonb("ownership"),'null'::jsonb) AS value,"ownershipDecision" AS "decidedBy",NULL::double precision AS "sortNumber","ownershipSort" AS "sortText",NULL::timestamp AS "sortDate","ownershipComputedAt" AS "computedAt" FROM "ProductReadSnapshot" WHERE "ownershipComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'valuation'::text AS key,coalesce(to_jsonb("valuation"),'null'::jsonb) AS value,"valuationDecision" AS "decidedBy","valuationSort" AS "sortNumber",NULL::text AS "sortText",NULL::timestamp AS "sortDate","valuationComputedAt" AS "computedAt" FROM "InventoryReadSnapshot" WHERE "valuationComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'ownership'::text AS key,coalesce(to_jsonb("ownership"),'null'::jsonb) AS value,"ownershipDecision" AS "decidedBy",NULL::double precision AS "sortNumber","ownershipSort" AS "sortText",NULL::timestamp AS "sortDate","ownershipComputedAt" AS "computedAt" FROM "InventoryReadSnapshot" WHERE "ownershipComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'valuationRollup'::text AS key,coalesce(to_jsonb("valuationRollup"),'null'::jsonb) AS value,"valuationRollupDecision" AS "decidedBy","valuationRollupSort" AS "sortNumber",NULL::text AS "sortText",NULL::timestamp AS "sortDate","valuationRollupComputedAt" AS "computedAt" FROM "LocationReadSnapshot" WHERE "valuationRollupComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'startDate'::text AS key,coalesce(to_jsonb("startDate"),'null'::jsonb) AS value,"startDateDecision" AS "decidedBy",NULL::double precision AS "sortNumber",NULL::text AS "sortText","startDateSort" AS "sortDate","startDateComputedAt" AS "computedAt" FROM "ProjectReadSnapshot" WHERE "startDateComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'completionYear'::text AS key,coalesce(to_jsonb("completionYear"),'null'::jsonb) AS value,"completionYearDecision" AS "decidedBy",NULL::double precision AS "sortNumber","completionYearSort" AS "sortText",NULL::timestamp AS "sortDate","completionYearComputedAt" AS "computedAt" FROM "ProjectReadSnapshot" WHERE "completionYearComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'workDiagnosticFacts'::text AS key,coalesce(to_jsonb("workDiagnosticFacts"),'null'::jsonb) AS value,"workDiagnosticFactsDecision" AS "decidedBy",NULL::double precision AS "sortNumber","workDiagnosticFactsSort" AS "sortText",NULL::timestamp AS "sortDate","workDiagnosticFactsComputedAt" AS "computedAt" FROM "ProjectReadSnapshot" WHERE "workDiagnosticFactsComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'rollups'::text AS key,coalesce(to_jsonb("rollups"),'null'::jsonb) AS value,"rollupsDecision" AS "decidedBy",NULL::double precision AS "sortNumber","rollupsSort" AS "sortText",NULL::timestamp AS "sortDate","rollupsComputedAt" AS "computedAt" FROM "ProjectReadSnapshot" WHERE "rollupsComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'beneficiaryResult'::text AS key,coalesce(to_jsonb("beneficiaryResult"),'null'::jsonb) AS value,"beneficiaryResultDecision" AS "decidedBy",NULL::double precision AS "sortNumber","beneficiaryResultSort" AS "sortText",NULL::timestamp AS "sortDate","beneficiaryResultComputedAt" AS "computedAt" FROM "ExpenseReadSnapshot" WHERE "beneficiaryResultComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'relationshipFacts'::text AS key,coalesce(to_jsonb("relationshipFacts"),'null'::jsonb) AS value,"relationshipFactsDecision" AS "decidedBy",NULL::double precision AS "sortNumber","relationshipFactsSort" AS "sortText",NULL::timestamp AS "sortDate","relationshipFactsComputedAt" AS "computedAt" FROM "EmailReadSnapshot" WHERE "relationshipFactsComputedAt" IS NOT NULL UNION ALL SELECT "entityId",kind,'eventSummary'::text AS key,coalesce(to_jsonb("eventSummary"),'null'::jsonb) AS value,"eventSummaryDecision" AS "decidedBy",NULL::double precision AS "sortNumber","eventSummarySort" AS "sortText",NULL::timestamp AS "sortDate","eventSummaryComputedAt" AS "computedAt" FROM "ShipmentReadSnapshot" WHERE "eventSummaryComputedAt" IS NOT NULL)
    SELECT 1 FROM ((SELECT * FROM previous EXCEPT ALL SELECT * FROM replacement) UNION ALL (SELECT * FROM replacement EXCEPT ALL SELECT * FROM previous)) difference)
  THEN RAISE EXCEPTION 'Typed read snapshot copy mismatch'; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "EmailReadSnapshot" ADD CONSTRAINT "EmailReadSnapshot_entityId_kind_Entity_id_kind_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ExpenseReadSnapshot" ADD CONSTRAINT "ExpenseReadSnapshot_entityId_kind_Entity_id_kind_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "InventoryReadSnapshot" ADD CONSTRAINT "InventoryReadSnapshot_entityId_kind_Entity_id_kind_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "LocationReadSnapshot" ADD CONSTRAINT "LocationReadSnapshot_entityId_kind_Entity_id_kind_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ProductReadSnapshot" ADD CONSTRAINT "ProductReadSnapshot_entityId_kind_Entity_id_kind_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ProjectReadSnapshot" ADD CONSTRAINT "ProjectReadSnapshot_entityId_kind_Entity_id_kind_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ShipmentReadSnapshot" ADD CONSTRAINT "ShipmentReadSnapshot_entityId_kind_Entity_id_kind_fk" FOREIGN KEY ("entityId","kind") REFERENCES "public"."Entity"("id","kind") ON DELETE cascade ON UPDATE no action;
