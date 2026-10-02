DROP TRIGGER IF EXISTS "sync_project_emoji_icon" ON "Project";
--> statement-breakpoint
DROP FUNCTION IF EXISTS "sync_project_emoji_icon"();
--> statement-breakpoint
ALTER TABLE "Project" DROP COLUMN "icon";
