ALTER TABLE "RunTarget" DROP CONSTRAINT "RunTarget_entityKind_check";--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD COLUMN "runId" uuid;--> statement-breakpoint
ALTER TABLE "MailboxMessage" ADD CONSTRAINT "MailboxMessage_runId_Run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."Run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunTarget" ADD CONSTRAINT "RunTarget_entityKind_check" CHECK ("RunTarget"."entityKind" IN ('purchase', 'product', 'image', 'run'));