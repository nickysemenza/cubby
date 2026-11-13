import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { POSTING_WINDOW_DAYS } from "~/server/domains/financial-transaction/policy/settlement-window";

/**
 * SQL form of the instant window for a timestamp expression against one
 * instant. Both sides are UTC epoch seconds, independent of the session time
 * zone; the instant is floored to the second.
 */
export const withinPostingInstantWindowSql = (
  column: SQLWrapper,
  instant: Date,
): SQL =>
  sql`abs(extract(epoch FROM ${column}) - ${Math.floor(instant.getTime() / 1_000)}) <= ${POSTING_WINDOW_DAYS * 86_400}`;
