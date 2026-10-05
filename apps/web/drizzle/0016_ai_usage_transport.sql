ALTER TABLE "AiUsage" ADD COLUMN "transport" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_transport_check" CHECK ("AiUsage"."transport" IN ('gateway', 'chatgpt', 'direct', 'cache', 'unknown'));--> statement-breakpoint
-- Backfill from positive evidence only; every other historical row stays
-- 'unknown' (a zero cost could be a ChatGPT plan call or a replay, and a
-- caller-cache 'hit' was also written for prompt-cache reads). An
-- application-cache hit placed no model call, so it outranks a log id.
UPDATE "AiUsage" SET "transport" = 'cache' WHERE "transport" = 'unknown' AND "applicationCacheStatus" = 'hit';--> statement-breakpoint
UPDATE "AiUsage" SET "transport" = 'gateway' WHERE "transport" = 'unknown' AND btrim(coalesce("gatewayLogId", '')) <> '';
