CREATE TABLE "JobLaneAdmission" (
	"lane" text PRIMARY KEY NOT NULL,
	"ownedStreak" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Device pulls lock this row; the first pull after the cutover starts a new streak.
INSERT INTO "JobLaneAdmission" (lane) VALUES ('image.device') ON CONFLICT (lane) DO NOTHING;
