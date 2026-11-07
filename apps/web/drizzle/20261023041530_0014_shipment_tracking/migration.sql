CREATE TABLE "Shipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shortcode" text NOT NULL,
	"name" text NOT NULL,
	"purchaseId" uuid,
	"purchaseAssociationReviewed" boolean DEFAULT false NOT NULL,
	"carrierId" uuid,
	"trackingNumber" text,
	"extraTrackingNumbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"purpose" text DEFAULT 'unknown' NOT NULL,
	"notes" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "Shipment_purpose_check" CHECK ("Shipment"."purpose" IN ('outbound', 'replacement', 'return', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "ShipmentObservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipmentId" uuid NOT NULL,
	"sourceCaptureId" uuid NOT NULL,
	"sourceKey" text NOT NULL,
	"sourcePackageId" uuid NOT NULL,
	"sourceEventKey" text,
	"occurrenceKey" text NOT NULL,
	"fingerprint" text NOT NULL,
	"event" jsonb NOT NULL,
	"firstSeenAt" timestamp NOT NULL,
	"lastSeenAt" timestamp NOT NULL,
	"supersededById" uuid
);
--> statement-breakpoint
CREATE TABLE "ShipmentObservationCapture" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observationId" uuid NOT NULL,
	"captureId" uuid NOT NULL,
	"firstSeenAt" timestamp NOT NULL,
	"lastSeenAt" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ShipmentSourceCapture" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceKey" text NOT NULL,
	"checksum" text NOT NULL,
	"originalContent" jsonb,
	"source" jsonb NOT NULL,
	"emailId" uuid,
	"actorUserId" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ShipmentSourcePackage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipmentId" uuid NOT NULL,
	"sourceKey" text NOT NULL,
	"packageKey" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_kind_check";--> statement-breakpoint
ALTER TABLE "Entity" DROP CONSTRAINT "Entity_shortcode_prefix_check";--> statement-breakpoint
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_purchaseId_Purchase_id_fk" FOREIGN KEY ("purchaseId") REFERENCES "public"."Purchase"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_carrierId_Vendor_id_fk" FOREIGN KEY ("carrierId") REFERENCES "public"."Vendor"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_entity_identity_fk" FOREIGN KEY ("id","shortcode") REFERENCES "public"."Entity"("id","shortcode") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentObservation" ADD CONSTRAINT "ShipmentObservation_shipmentId_Shipment_id_fk" FOREIGN KEY ("shipmentId") REFERENCES "public"."Shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentObservation" ADD CONSTRAINT "ShipmentObservation_sourceCaptureId_ShipmentSourceCapture_id_fk" FOREIGN KEY ("sourceCaptureId") REFERENCES "public"."ShipmentSourceCapture"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentObservation" ADD CONSTRAINT "ShipmentObservation_sourcePackageId_ShipmentSourcePackage_id_fk" FOREIGN KEY ("sourcePackageId") REFERENCES "public"."ShipmentSourcePackage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentObservation" ADD CONSTRAINT "ShipmentObservation_supersededById_ShipmentObservation_id_fk" FOREIGN KEY ("supersededById") REFERENCES "public"."ShipmentObservation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentObservationCapture" ADD CONSTRAINT "ShipmentObservationCapture_observationId_ShipmentObservation_id_fk" FOREIGN KEY ("observationId") REFERENCES "public"."ShipmentObservation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentObservationCapture" ADD CONSTRAINT "ShipmentObservationCapture_captureId_ShipmentSourceCapture_id_fk" FOREIGN KEY ("captureId") REFERENCES "public"."ShipmentSourceCapture"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentSourceCapture" ADD CONSTRAINT "ShipmentSourceCapture_emailId_Email_id_fk" FOREIGN KEY ("emailId") REFERENCES "public"."Email"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentSourceCapture" ADD CONSTRAINT "ShipmentSourceCapture_actorUserId_user_id_fk" FOREIGN KEY ("actorUserId") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ShipmentSourcePackage" ADD CONSTRAINT "ShipmentSourcePackage_shipmentId_Shipment_id_fk" FOREIGN KEY ("shipmentId") REFERENCES "public"."Shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "Shipment_shortcode_unique" ON "Shipment" USING btree ("shortcode");--> statement-breakpoint
CREATE INDEX "Shipment_purchaseId_idx" ON "Shipment" USING btree ("purchaseId");--> statement-breakpoint
CREATE INDEX "Shipment_carrierId_trackingNumber_idx" ON "Shipment" USING btree ("carrierId","trackingNumber");--> statement-breakpoint
CREATE INDEX "ShipmentObservation_source_fingerprint_idx" ON "ShipmentObservation" USING btree ("shipmentId","sourceKey","fingerprint");--> statement-breakpoint
CREATE INDEX "ShipmentObservation_shipment_idx" ON "ShipmentObservation" USING btree ("shipmentId");--> statement-breakpoint
CREATE UNIQUE INDEX "ShipmentObservationCapture_observation_capture_key" ON "ShipmentObservationCapture" USING btree ("observationId","captureId");--> statement-breakpoint
CREATE UNIQUE INDEX "ShipmentSourceCapture_source_checksum_key" ON "ShipmentSourceCapture" USING btree ("sourceKey","checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "ShipmentSourcePackage_source_package_key" ON "ShipmentSourcePackage" USING btree ("sourceKey","packageKey");--> statement-breakpoint
CREATE INDEX "ShipmentSourcePackage_shipment_idx" ON "ShipmentSourcePackage" USING btree ("shipmentId");--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_kind_check" CHECK ("Entity"."kind" IN ('product', 'recipe', 'ingredient', 'cookbook', 'location', 'inventory', 'meal', 'ledgerParty', 'ledgerTransfer', 'project', 'task', 'vendor', 'purchase', 'financialAccount', 'financialTransaction', 'wish', 'expense', 'image', 'planting', 'gardenEntry', 'vendorAccount', 'productCategory', 'run', 'device', 'plant', 'spendingCategory', 'email', 'imageJob', 'sourceTransactionRecord', 'transactionImport', 'shipment'));--> statement-breakpoint
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_shortcode_prefix_check" CHECK ("Entity"."shortcode" IS NULL OR CASE "Entity"."kind" WHEN 'product' THEN "Entity"."shortcode" LIKE 'PRD-%' WHEN 'recipe' THEN "Entity"."shortcode" LIKE 'RCP-%' WHEN 'ingredient' THEN "Entity"."shortcode" LIKE 'ING-%' WHEN 'cookbook' THEN "Entity"."shortcode" LIKE 'CKB-%' WHEN 'location' THEN "Entity"."shortcode" LIKE 'LOC-%' WHEN 'inventory' THEN "Entity"."shortcode" LIKE 'INV-%' WHEN 'meal' THEN "Entity"."shortcode" LIKE 'MEL-%' WHEN 'ledgerParty' THEN "Entity"."shortcode" LIKE 'LPY-%' WHEN 'ledgerTransfer' THEN "Entity"."shortcode" LIKE 'LTR-%' WHEN 'project' THEN "Entity"."shortcode" LIKE 'PRJ-%' WHEN 'task' THEN "Entity"."shortcode" LIKE 'TSK-%' WHEN 'vendor' THEN "Entity"."shortcode" LIKE 'VEN-%' WHEN 'purchase' THEN "Entity"."shortcode" LIKE 'PUR-%' WHEN 'financialAccount' THEN "Entity"."shortcode" LIKE 'FAC-%' WHEN 'financialTransaction' THEN "Entity"."shortcode" LIKE 'FTX-%' WHEN 'wish' THEN "Entity"."shortcode" LIKE 'WSH-%' WHEN 'expense' THEN "Entity"."shortcode" LIKE 'EXP-%' WHEN 'image' THEN "Entity"."shortcode" LIKE 'IMG-%' WHEN 'planting' THEN "Entity"."shortcode" LIKE 'PLT-%' WHEN 'gardenEntry' THEN "Entity"."shortcode" LIKE 'GDE-%' WHEN 'vendorAccount' THEN "Entity"."shortcode" LIKE 'VACCT-%' WHEN 'productCategory' THEN "Entity"."shortcode" LIKE 'CAT-%' WHEN 'run' THEN "Entity"."shortcode" LIKE 'RUN-%' WHEN 'device' THEN "Entity"."shortcode" LIKE 'DEV-%' WHEN 'plant' THEN "Entity"."shortcode" LIKE 'PLANT-%' WHEN 'spendingCategory' THEN "Entity"."shortcode" LIKE 'SPC-%' WHEN 'email' THEN "Entity"."shortcode" LIKE 'EML-%' WHEN 'imageJob' THEN "Entity"."shortcode" LIKE 'IPR-%' WHEN 'sourceTransactionRecord' THEN "Entity"."shortcode" LIKE 'STR-%' WHEN 'transactionImport' THEN "Entity"."shortcode" LIKE 'TIM-%' WHEN 'shipment' THEN "Entity"."shortcode" LIKE 'SHIP-%' ELSE false END);