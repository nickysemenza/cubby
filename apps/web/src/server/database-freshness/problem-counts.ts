import { db, withRequestDbClient } from "~/server/db";
import { findProblemCounts } from "~/server/services/problems.service";
import { createUpcLookupService } from "~/server/services/upc";

/** The freshness object's problem-count refresh on its own database client. */
export function findProblemCountsWithClient(connectionString: string) {
  return withRequestDbClient(connectionString, () =>
    findProblemCounts(db, createUpcLookupService(db)),
  );
}
