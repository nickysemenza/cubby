SET LOCAL lock_timeout='2s';
--> statement-breakpoint
CREATE TABLE "ManualEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entity" text NOT NULL,
	"userId" text NOT NULL,
	"payload" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "Suggestion_statement_charge_key";
DROP INDEX IF EXISTS "Suggestion_statement_charge_history_idx";
DROP INDEX IF EXISTS "Suggestion_statement_account_idx";
DROP INDEX IF EXISTS "Suggestion_statement_label_native_idx";
DROP INDEX IF EXISTS "Suggestion_statement_label_receipt_idx";
