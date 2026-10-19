DROP INDEX "SourceOrderObservation_content_key";--> statement-breakpoint
ALTER TABLE "ImportSourceOrder" ALTER COLUMN "purchaseId" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "SourceOrderObservation_content_key" ON "SourceOrderObservation" USING btree ("sourceClaimId","orderKey","checksum","contentFingerprint","purchaseId");