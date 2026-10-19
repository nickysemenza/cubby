DROP INDEX "ImportSourceOrder_source_order_key";--> statement-breakpoint
DROP INDEX "SourceOrderObservation_content_key";--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ALTER COLUMN "purchaseId" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ImportSourceOrder_source_order_key" ON "ImportSourceOrder" USING btree ("sourceClaimId","orderKey") WHERE "ImportSourceOrder"."purchaseId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "SourceOrderObservation_content_key" ON "SourceOrderObservation" USING btree ("sourceClaimId","orderKey","checksum","contentFingerprint","purchaseId");