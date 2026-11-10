-- RunApproval has no producer or reader; the member chose to drop its rows.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE "RunApproval";
