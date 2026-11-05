-- cubby:transaction-per-statement
-- See 0073 for how this mode behaves against live writers.
ALTER TABLE "AiEvaluation" ALTER COLUMN "runId" DROP NOT NULL;
