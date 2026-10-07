import { z } from "zod";
import { runStatus, runPurpose } from "./run-fields";

import {
  productShortcode,
  purchaseShortcode,
  runShortcode,
  vendorAccountShortcode,
} from "./identifiers";

export {
  runFilterFields,
  runFilters,
  runOut,
  type RunFilters,
  type RunOut,
} from "./generated/run.gen";

export const targetedImportPurpose = z.enum([
  "purchase_validation",
  "product_enrichment",
]);
export type TargetedImportPurpose = z.infer<typeof targetedImportPurpose>;

/**
 * Targeted import launch input. Exported (and named) here, not inline in
 * `contracts/run.contract.ts`, because the OpenAPI generator only assigns
 * component names to a discriminated union's members when the union itself
 * is a named export of a scanned schema module (see
 * `scripts/generator/http-api/schema-names.ts`): an inline union in a
 * contract file never gets its members visited by `nameUnionMembers`, so
 * `discriminator.mapping` has nothing to point `$ref` at. Entity targets use
 * public shortcodes; an opaque source-claim id is resolved again against the
 * actor's own claims.
 */
export const targetedImportStartInput = z
  .discriminatedUnion("purpose", [
    z
      .object({
        purpose: z.literal("purchase_validation"),
        purchaseId: purchaseShortcode,
        sourceId: z.string().min(1).nullable(),
      })
      .meta({ id: "TargetedImportStartInputPurchaseValidation" }),
    z
      .object({
        purpose: z.literal("product_enrichment"),
        targets: z
          .array(
            z.object({
              productId: productShortcode,
              sourceId: z.string().min(1).nullable(),
            }),
          )
          .min(1),
      })
      .meta({ id: "TargetedImportStartInputProductEnrichment" }),
  ])
  .meta({ id: "TargetedImportStartInput" });
export type TargetedImportStartInput = z.input<typeof targetedImportStartInput>;

export const targetedImportStartOutput = z.object({
  runs: z.array(
    z.object({
      created: z.boolean(),
      run: z
        .object({
          id: runShortcode,
          status: z.string().min(1),
          purpose: targetedImportPurpose,
          dispatchEventId: z.string().nullable(),
        })
        .nullable(),
      blockingRun: z
        .object({ id: runShortcode, status: z.string().min(1) })
        .nullable(),
    }),
  ),
});
export type TargetedImportStartOutput = z.infer<
  typeof targetedImportStartOutput
>;

export const runSummary = z.object({
  publicId: runShortcode,
  purpose: runPurpose,
  vendorAccountLabel: z.string().nullable(),
  vendorName: z.string().nullable(),
  trigger: z.string(),
  status: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  ordersSeen: z.number().int(),
  imported: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  failureCode: z.string().nullable(),
  estimatedCost: z.number().nullable(),
});
export type RunSummary = z.infer<typeof runSummary>;

export const runHistoryOut = z.object({ runs: z.array(runSummary) });

/** Advisory sync decision; admission rechecks it under the account transaction. */
export const accountSyncAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), since: z.iso.datetime() }),
  z.object({ kind: z.literal("firstSync") }),
  z.object({
    kind: z.literal("resume"),
    runId: runShortcode,
    status: runStatus,
    detail: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("blocked"),
    runId: runShortcode,
    purpose: runPurpose,
  }),
]);
export const syncPlanInput = z.object({
  vendorAccountId: vendorAccountShortcode.optional(),
});
export const syncPlanAccount = z.object({
  shortcode: vendorAccountShortcode,
  label: z.string(),
  vendorName: z.string(),
  action: accountSyncAction,
  line: z.string(),
  disabledReason: z.string().nullable(),
});
export const syncPlanOutput = z.object({ accounts: z.array(syncPlanAccount) });
export const startSyncInput = z.object({
  vendorAccountId: vendorAccountShortcode,
  backfill: z.object({ from: z.iso.date(), to: z.iso.date() }).optional(),
});
export const startSyncOutput = z.object({
  runId: runShortcode,
  resumed: z.boolean(),
});
export type SyncPlanInput = z.infer<typeof syncPlanInput>;
export type SyncPlanAccount = z.infer<typeof syncPlanAccount>;
export type StartSyncInput = z.infer<typeof startSyncInput>;
