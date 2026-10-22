import { z } from "zod";
import { financialTransactionProviderStatus } from "./financial-transaction-fields";

export const statementDateKind = z.enum(["posted", "transaction", "unknown"]);
export type StatementDateKind = z.infer<typeof statementDateKind>;

export const sourceTransactionRecordDisposition = z.enum(["open", "ignored"]);
export type SourceTransactionRecordDisposition = z.infer<
  typeof sourceTransactionRecordDisposition
>;

/**
 * Why a row will never match. Parallel in style to `dataExceptionReason`, but a
 * deliberately separate set: that vocabulary is about a record Cubby owns being
 * wrong, this one is about a statement line Cubby will never hold.
 */
export const sourceTransactionRecordDispositionReason = z.enum([
  /**
   * Legacy: real spend once judged out of scope. Every charge is now in scope,
   * consumer spend included, so new judgments never use it; it stays only so
   * stored rows still parse.
   */
  "not_modeled",
  "not_a_purchase",
  "duplicate_of_other_source",
  "pre_cubby",
  "other",
]);
export type SourceTransactionRecordDispositionReason = z.infer<
  typeof sourceTransactionRecordDispositionReason
>;

export const sourceTransactionRecordProviderStatus =
  financialTransactionProviderStatus;

/**
 * Derived from whether a live transaction carries the row's `(source,
 * externalId)` pair — never stored, so it cannot go stale.
 */
export const sourceTransactionRecordMatchState = z.enum([
  "matched",
  "unmatched",
  "superseded",
  "ignored",
]);
export type SourceTransactionRecordMatchState = z.infer<
  typeof sourceTransactionRecordMatchState
>;
