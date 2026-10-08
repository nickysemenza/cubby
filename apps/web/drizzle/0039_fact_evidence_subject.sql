DROP INDEX "RunFactEvidence_claim_key";--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD COLUMN "entityKind" text;--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD COLUMN "entityId" uuid;--> statement-breakpoint
CREATE INDEX "RunFactEvidence_subject_idx" ON "RunFactEvidence" USING btree ("entityKind","entityId");--> statement-breakpoint
CREATE UNIQUE INDEX "RunFactEvidence_claim_key" ON "RunFactEvidence" USING btree ("targetId","evidenceId","entityKind","entityId","fieldPath","valueFingerprint");--> statement-breakpoint
ALTER TABLE "RunFactEvidence" ADD CONSTRAINT "RunFactEvidence_entityKind_check" CHECK ("RunFactEvidence"."entityKind" IN ('purchase', 'product', 'image', 'run'));
