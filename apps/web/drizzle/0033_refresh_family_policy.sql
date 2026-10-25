-- Refresh families no longer restart a pass on capture: restarting on every
-- household write kept the search pass from ever finishing. Markers 0028
-- backfilled as restarting follow the new policy. Families that failed under
-- the old attempt budget need no sweep: a never-exhausted kind's failed row
-- is due again (jobDue), including one an older Worker writes after this.
UPDATE "JobInvalidation" SET "restartsPass" = false
WHERE key LIKE 'refresh:%' AND "restartsPass";
