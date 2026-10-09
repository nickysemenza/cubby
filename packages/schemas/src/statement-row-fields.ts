import { z } from "zod";

// Leaf enums for the Statement Rows route search; `./statement-row` imports
// the financial-transaction read schemas, which a route's eager search
// validation must not load.

export const statementRowDisposition = z.enum(["open", "ignored"]);
export type StatementRowDisposition = z.infer<typeof statementRowDisposition>;

/**
 * Derived from whether a live transaction carries the row's `(source,
 * externalId)` pair — never stored, so it cannot go stale.
 */
export const statementRowMatchState = z.enum([
  "matched",
  "unmatched",
  "superseded",
  "ignored",
]);
export type StatementRowMatchState = z.infer<typeof statementRowMatchState>;
