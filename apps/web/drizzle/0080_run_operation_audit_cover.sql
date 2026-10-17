DROP INDEX "RunOperation_run_state_idx";--> statement-breakpoint
CREATE INDEX "RunOperation_run_state_idx" ON "RunOperation" USING btree ("runId","state","id");