-- cubby:transaction-per-statement
-- Apply only after the reader/writer removal Worker is deployed and verified.
-- The following per-table trigger migration runs in this same retirement deployment.
SET lock_timeout = '2s';--> statement-breakpoint
DROP FUNCTION IF EXISTS derived_mark(text, uuid[]);--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark(p_target text, p_refs uuid[], p_reason text DEFAULT 'Refresh requested') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RETURN;
END $$;--> statement-breakpoint
RESET lock_timeout;
