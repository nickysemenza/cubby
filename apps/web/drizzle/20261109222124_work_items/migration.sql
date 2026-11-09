CREATE TABLE "WorkItem" (
	"key" text,
	"inputIncomplete" boolean,
	"source" text NOT NULL,
	"entity" text,
	"id" text,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"executor" text NOT NULL,
	"reason" text NOT NULL,
	"reasonKeys" text[] NOT NULL,
	"owners" uuid[] NOT NULL,
	"exclusiveOwner" uuid,
	"shared" boolean NOT NULL,
	"amount" double precision,
	"date" date,
	"ownerCodes" text[] NOT NULL,
	"ownerKey" text,
	"ownerLabel" text,
	CONSTRAINT "WorkItem_pkey" PRIMARY KEY("key","inputIncomplete")
);
--> statement-breakpoint
CREATE TABLE "WorkPublication" (
	"id" smallint PRIMARY KEY,
	"publishedAt" timestamp,
	"dirtyAt" timestamp,
	"attemptedAt" timestamp,
	"error" text,
	"meta" jsonb
);
