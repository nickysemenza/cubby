CREATE TABLE "ManualEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entity" text NOT NULL,
	"userId" text NOT NULL,
	"payload" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
