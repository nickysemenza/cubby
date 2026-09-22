import { z } from "zod";

/**
 * Cycle-safe enums for the `purchaseImportRun` declaration. `purchase-import.ts`
 * re-exports them so existing consumers keep their import paths.
 */
export const importRunTrigger = z.enum([
  "foreground",
  "discovery",
  "manual",
  "backfill",
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
]);
export type ImportRunPurpose = z.infer<typeof importRunPurpose>;
