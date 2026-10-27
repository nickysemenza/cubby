-- Carry AiEvaluation execution states into the drain model: retry and lease
-- state now live on the drain's WorkItem, so retry_wait and running become
-- queued. Only running rows can collide with the open-slot index (it already
-- covered queued and retry_wait); the newest open row of a slot stays queued.
UPDATE "AiEvaluation" SET state = 'queued' WHERE state = 'retry_wait';--> statement-breakpoint
WITH ranked AS (
  SELECT e.id, row_number() OVER (PARTITION BY e."slotKey" ORDER BY e."createdAt" DESC, e.id DESC) AS position
    FROM "AiEvaluation" e
   WHERE e.state = 'running'
     AND NOT EXISTS (SELECT 1 FROM "AiEvaluation" o WHERE o."slotKey" = e."slotKey" AND o.state = 'queued')
)
UPDATE "AiEvaluation" e SET state = CASE WHEN ranked.position = 1 THEN 'queued' ELSE 'obsolete' END
  FROM ranked WHERE ranked.id = e.id;--> statement-breakpoint
UPDATE "AiEvaluation" SET state = 'obsolete' WHERE state = 'running';--> statement-breakpoint
ALTER TABLE "AiEvaluation" DROP CONSTRAINT "AiEvaluation_state_check";--> statement-breakpoint
DROP INDEX "AiEvaluation_open_slot_key";--> statement-breakpoint
DROP INDEX "AiEvaluation_pending_share_key";--> statement-breakpoint
CREATE UNIQUE INDEX "AiEvaluation_open_slot_key" ON "AiEvaluation" USING btree ("slotKey") WHERE "AiEvaluation"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "AiEvaluation_pending_share_key" ON "AiEvaluation" USING btree ("shareKey") WHERE "AiEvaluation"."shareKey" IS NOT NULL AND "AiEvaluation"."state" IN ('queued','result_ready');--> statement-breakpoint
ALTER TABLE "AiEvaluation" ADD CONSTRAINT "AiEvaluation_state_check" CHECK ("AiEvaluation"."state" IN ('queued','result_ready','completed','blocked','failed','obsolete','cancelled'));
