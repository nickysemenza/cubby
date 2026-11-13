ALTER TABLE "PurchasePaymentEvidence" ADD COLUMN "orderObservationId" uuid;--> statement-breakpoint
ALTER TABLE "PurchasePaymentEvidence" ALTER COLUMN "purchaseId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "PurchasePaymentEvidence" ALTER COLUMN "sourceClaimId" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "PurchasePaymentEvidence_observation_index_key" ON "PurchasePaymentEvidence" ("orderObservationId","evidenceIndex");--> statement-breakpoint
ALTER TABLE "PurchasePaymentEvidence" ADD CONSTRAINT "PurchasePaymentEvidence_orderObservationId_SourceOrderObservati" FOREIGN KEY ("orderObservationId") REFERENCES "SourceOrderObservation"("id");