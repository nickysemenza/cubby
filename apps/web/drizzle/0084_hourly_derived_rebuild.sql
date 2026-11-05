SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "DerivedRebuild" (
	"key" text PRIMARY KEY NOT NULL,
	"running" boolean DEFAULT false NOT NULL,
	"target" text,
	"afterId" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"startedAt" timestamp,
	"finishedAt" timestamp,
	"token" uuid,
	"leaseExpiresAt" timestamp,
	"failures" integer DEFAULT 0 NOT NULL,
	"cursorAttempts" integer DEFAULT 0 NOT NULL,
	"passFailures" integer DEFAULT 0 NOT NULL,
	"error" text,
	"durationsMs" double precision[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
INSERT INTO "DerivedRebuild" (key) VALUES ('deterministic') ON CONFLICT (key) DO NOTHING;
