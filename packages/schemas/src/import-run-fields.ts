import { z } from "zod";

/**
 * Cycle-safe enums for the `importRun` declaration. `purchase-import.ts`
 * re-exports them so existing consumers keep their import paths.
 */
export const importRunTrigger = z.enum([
  "foreground",
  "discovery",
  "manual",
  "backfill",
  // A short-lived run that only groups AI work: created already `completed`,
  // hidden from default lists, and never blocks ledger-party delete/merge.
  "ephemeral",
]);
export const importRunStatus = z.enum([
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
  "needs_review",
  "completed",
  "failed",
  "dispatch_failed",
]);
export const importRunPurpose = z.enum([
  "account_sync",
  "purchase_validation",
  "product_enrichment",
  "photo_inventory",
  // Every AI call belongs to a run; these purposes group work that is not an
  // import. Their lifetime is set by `trigger` (`ephemeral` or not).
  "ai_suggest",
  "ai_action",
  "background",
  "file_import",
  "legacy",
]);
export type ImportRunPurpose = z.infer<typeof importRunPurpose>;
