CREATE INDEX "Email_source_key_idx" ON "Email" USING btree ("ledgerPartyId",("provider" || ':' || "mailboxId" || ':' || "messageId"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "AssessmentState_email_purchase_uuid_idx" ON "AssessmentState" (((data->>'purchaseId')::uuid)) WHERE family='email_link' AND active;
