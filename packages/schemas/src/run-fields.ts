import { z } from "zod";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { RUN_PURPOSE_LABEL, runPurpose } from "./activity-fields";
export {
  RUN_PURPOSE_LABEL,
  runPurpose,
  IMPORT_REPORT_RUN_PURPOSES,
  hasImportRunReports,
} from "./activity-fields";
export type { RunPurpose } from "./activity-fields";
import type { ExecutionAuthorizationInput } from "./execution-authorization.js";
import { executionAuthorizationRef } from "./execution-authorization.js";
import { plainDate } from "./base-entity.js";
import { financialTransactionNonZeroAmount } from "./financial-transaction-fields.js";
import { vendorAccountCursor } from "./vendor-account-fields.js";
import {
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
  mailboxHistoryEvent,
} from "./mailbox-research.js";

/**
 * Cycle-safe enums for the `run` declaration. `purchase-import.ts`
 * re-exports them so existing consumers keep their import paths.
 */
export const runTrigger = z.enum([
  "foreground",
  "discovery",
  "manual",
  "backfill",
  // Scheduled work nobody started: the daily cron and app-open catch-up. A
  // completed one that found nothing is `routine` and hidden by default.
  "scheduled",
  // A short-lived run that only groups AI work: created already `completed`,
  // and never blocks ledger-party delete/merge.
  "ephemeral",
]);
export const runStatus = z.enum([
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
  "needs_review",
  "completed",
  "failed",
  "dispatch_failed",
]);
export const runTargetEntityKind = z.enum([
  "purchase",
  "product",
  "image",
  "run",
]);
export type RunTargetEntityKind = z.infer<typeof runTargetEntityKind>;
/** Permanent retirement prevents disposed coordinator history from being recreated. */
export const runRetirementReason = z.enum(["unrelated_source"]);
export type RunRetirementReason = z.infer<typeof runRetirementReason>;
export const runEvidenceKind = z.enum([
  "browser_capture",
  "web_page",
  "mail_message",
  "gmail_attachment",
  "manual_upload",
  "upload_evidence",
]);
export type RunEvidenceKind = z.infer<typeof runEvidenceKind>;

export const researchRetentionPhase = z.enum([
  "fenced",
  "objects_deleted",
  "coordinators_destroyed",
  "completed",
]);
export type ResearchRetentionPhase = z.infer<typeof researchRetentionPhase>;
/** Only server-derived deletion/transfer identities survive interrupted cleanup. */
export const researchRetentionPlan = z.object({
  originOperationId: z.string().min(1),
  objectKeys: z.array(z.string()),
  screenshotRefs: z.array(
    z.object({ runId: z.uuid(), imageRef: z.string().min(1) }),
  ),
  retiredRunIds: z.array(z.uuid()),
  successors: z.array(
    z.object({ runId: z.uuid(), successorRunIds: z.array(z.uuid()) }),
  ),
});
export type ResearchRetentionPlan = z.infer<typeof researchRetentionPlan>;
/** What `run.control` can do to a Run; the report actions and the operation share it. */
export const runControlAction = z.enum([
  "pause",
  "resume",
  "cancel",
  "approve",
  "reject",
  "retry",
  "restart",
  "escalate_sol",
  "retry_dispatch",
  "abort",
  "upload_evidence",
  "no_evidence_available",
]);
export type RunControlAction = z.infer<typeof runControlAction>;
/** Why a new immutable attempt was admitted; historical lineage remains unknown. */
export const runCause = z.enum([
  "member_request",
  "scheduled",
  "source_discovered",
  "import_completed",
  "evidence_changed",
  "retry",
]);
export type RunCause = z.infer<typeof runCause>;

/** Bounded acquisition and independent full/scoped mailbox coverage. */
export const mailDiscoveryRunInput = mailboxDiscoveryInput;
export type MailDiscoveryRunInput = z.infer<typeof mailDiscoveryRunInput>;
export const mailDiscoveryEvent = mailboxHistoryEvent;
export const mailDiscoveryRunProgress = mailboxDiscoveryProgress;
export type MailDiscoveryRunProgress = z.infer<typeof mailDiscoveryRunProgress>;
/** Original retained sources; interpreted order identity remains a research decision. */
export const mailResearchRunInput = z.object({
  executionAuthorization: executionAuthorizationRef.optional(),
  kind: z.literal("mail_research"),
  sources: z
    .array(
      z.object({
        orderMailId: z.uuid(),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(50),
});
export type MailResearchRunInput = z.infer<typeof mailResearchRunInput>;
export const productResearchRunInput = z.object({
  executionAuthorization: executionAuthorizationRef.optional(),
  kind: z.literal("product_research"),
  instructionRevision: z.number().int().positive(),
  products: z
    .array(
      z.object({
        productId: z.uuid(),
        contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(50),
});
export type ProductResearchRunInput = z.infer<typeof productResearchRunInput>;
/** Purchase validation freezes recorded context and optional original-source preference. */
export const purchaseValidationResearchRunInput = z.strictObject({
  executionAuthorization: executionAuthorizationRef.optional(),
  kind: z.literal("purchase_validation_research"),
  instructionRevision: z.number().int().positive(),
  purchases: z
    .array(
      z.strictObject({
        purchaseId: z.uuid(),
        manualEvidenceUnavailable: z.boolean().default(false),
        contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
        selectedSource: z
          .strictObject({
            sourceOrderId: z.uuid(),
            checksum: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .nullable(),
      }),
    )
    .min(1)
    .max(50),
});
export type PurchaseValidationResearchRunInput = z.infer<
  typeof purchaseValidationResearchRunInput
>;
/** A listed or selected order's terminal outcome on one Run. */
export const runOrderCandidateState = z.enum([
  "pending",
  "covered",
  "imported",
  "skipped",
]);
/** One saved placement confirmation a mail import run is assigned. */
export const orderMailImportOrder = z.object({
  eventId: z.uuid(),
  evidenceChecksum: z.string().min(1),
  orderId: z.string().min(1),
});
export type OrderMailImportOrder = z.infer<typeof orderMailImportOrder>;
/**
 * `Run.input` for mail-only imports. The single form (one confirmation) is
 * what every run started before multi-select carries and stays readable; the
 * `orders` form is one run over several selected confirmations of one member
 * and Vendor, each tracked as a `RunOrderCandidate`.
 */
export const orderMailImportRunInput = z.union([
  orderMailImportOrder.extend({ kind: z.literal("order_mail_import") }),
  z.object({
    kind: z.literal("order_mail_import"),
    orders: z.array(orderMailImportOrder).min(1).max(50),
  }),
]);
/** Every confirmation a mail import run was assigned, in claim order. */
export const orderMailImportRunOrders = (
  input: z.infer<typeof orderMailImportRunInput>,
): OrderMailImportOrder[] =>
  "orders" in input
    ? input.orders
    : [
        {
          eventId: input.eventId,
          evidenceChecksum: input.evidenceChecksum,
          orderId: input.orderId,
        },
      ];
/**
 * `Run.input` for an explicit historical backfill: list and import only
 * orders placed within the inclusive range, newest first. It never moves the
 * account's incremental cursor.
 */
export const orderBackfillRunInput = z
  .object({
    kind: z.literal("order_backfill"),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((range) => range.from <= range.to, {
    message: "Backfill range must start on or before its end",
    path: ["from"],
  });
export type OrderBackfillRunInput = z.infer<typeof orderBackfillRunInput>;
/**
 * `Run.input` for a browser run over charge hunts a member selected: exactly
 * these `ImportHunt` ids are its work. Their outcomes live on the hunts
 * themselves (see `chargeHuntOutcome`), so no migration or per-run table is
 * needed; a hunt belongs to at most one unfinished run.
 */
export const chargeHuntRunInput = z.object({
  kind: z.literal("charge_hunts"),
  huntIds: z.array(z.uuid()).min(1).max(50),
});
/** Host-frozen objectives; source identity is never supplied by the researcher. */
export const researchObjective = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("vendor_purchases"),
    vendorId: z.uuid(),
    range: z.strictObject({ from: z.iso.date(), to: z.iso.date() }).nullable(),
  }),
  z.strictObject({
    kind: z.literal("account_history"),
    vendorAccountId: z.uuid(),
    range: z.strictObject({ from: z.iso.date(), to: z.iso.date() }).nullable(),
    cursor: vendorAccountCursor.nullable(),
  }),
  z.strictObject({
    kind: z.literal("charge_hunt"),
    huntId: z.uuid(),
    financialTransactionId: z.uuid(),
    vendorAccountId: z.uuid().nullable(),
    range: z.strictObject({ from: plainDate, to: plainDate }),
    charge: z.strictObject({
      merchant: z.string().nullable(),
      rawDescription: z.string().nullable(),
      amount: financialTransactionNonZeroAmount,
      transactionDate: plainDate.nullable(),
      postedDate: plainDate.nullable(),
    }),
  }),
  z.strictObject({
    kind: z.literal("receipt_hunt"),
    huntId: z.uuid(),
    imageId: z.uuid(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
]);
export type ResearchObjective = z.infer<typeof researchObjective>;
export const researchObjectivesRunInput = z.strictObject({
  executionAuthorization: executionAuthorizationRef.optional(),
  kind: z.literal("research_objectives"),
  instructionRevision: z.number().int().positive(),
  objectives: z.array(researchObjective).min(1).max(50),
});
export type ResearchObjectivesRunInput = z.infer<
  typeof researchObjectivesRunInput
>;

/**
 * What a restart copies from `Run.input`, by public values only: a mail
 * import's order ids, a backfill's range, or how many charges a charge run
 * carries, or a retained mail source count. Source, mail-event and hunt ids
 * are private and never cross it.
 */
export const runRestartOrderMailInput = z
  .object({
    kind: z.literal("order_mail_import"),
    orderIds: z.array(z.string()),
  })
  .meta({ id: "RunRestartOrderMailInput" });
export const runRestartOrderBackfillInput = z
  .object({
    kind: z.literal("order_backfill"),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .meta({ id: "RunRestartOrderBackfillInput" });
export const runRestartChargeHuntsInput = z
  .object({
    kind: z.literal("charge_hunts"),
    chargeCount: z.number().int().positive(),
  })
  .meta({ id: "RunRestartChargeHuntsInput" });
export const runRestartVendorPurchasesInput = researchObjective.options[0]
  .extend({ vendorId: z.string().min(1) })
  .meta({ id: "RunRestartVendorPurchasesInput" });
export const runRestartMailResearchInput = mailResearchRunInput
  .pick({ kind: true })
  .extend({ sourceCount: z.number().int().min(1).max(50) })
  .meta({ id: "RunRestartMailResearchInput" });
export const runRestartInput = z.discriminatedUnion("kind", [
  runRestartOrderMailInput,
  runRestartOrderBackfillInput,
  runRestartChargeHuntsInput,
  runRestartVendorPurchasesInput,
  runRestartMailResearchInput,
]);
export type RunRestartInput = z.infer<typeof runRestartInput>;
/** `ImportHunt.state` values a selected-charges run writes (plain text column). */
export const CHARGE_HUNT_STATE = {
  queued: "browser_queued",
  resolved: "resolved",
  deferred: "deferred_for_review",
  notFound: "expected_order_not_found",
} as const;
/** A selected hunt's outcome on its run; `pending` blocks finishing. */
export const chargeHuntOutcome = z.enum([
  "pending",
  "resolved",
  "deferred",
  "not_found",
]);
export const chargeHuntOutcomeOf = (
  state: string,
): z.infer<typeof chargeHuntOutcome> => {
  switch (state) {
    case CHARGE_HUNT_STATE.queued:
      return "pending";
    case CHARGE_HUNT_STATE.resolved:
      return "resolved";
    case CHARGE_HUNT_STATE.notFound:
      return "not_found";
    default:
      return "deferred";
  }
};
export const suggestionSweepRunInput = z.object({
  kind: z.literal("suggestion_sweep"),
  entity: z.string().min(1),
  fields: z.array(z.string().min(1)).min(1),
  filters: z.record(z.string(), z.json()),
  decisionModel: supportedDecisionModelSchema,
  taxonomyRevision: z.string().optional(),
  paused: z.boolean(),
});
export type SuggestionSweepRunInput = z.infer<typeof suggestionSweepRunInput>;
export const suggestionSweepRunProgress = z.object({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  diagnostics: z
    .array(
      z.object({
        targetId: z.string(),
        stage: z.enum(["apply", "paired_model"]),
        reason: z.string(),
      }),
    )
    .default([]),
});
export type SuggestionSweepRunProgress = z.infer<
  typeof suggestionSweepRunProgress
>;
export type RunInput =
  | ExecutionAuthorizationInput
  | ResearchObjectivesRunInput
  | MailResearchRunInput
  | ProductResearchRunInput
  | PurchaseValidationResearchRunInput
  | MailDiscoveryRunInput
  | z.infer<typeof orderMailImportRunInput>
  | OrderBackfillRunInput
  | z.infer<typeof chargeHuntRunInput>
  | SuggestionSweepRunInput;
export type RunProgress = MailDiscoveryRunProgress | SuggestionSweepRunProgress;

/**
 * What one run actually does, for every surface that names it (lists,
 * detail titles, MCP, the Mac, notifications). An `account_sync` run is
 * several kinds of work told apart by its input: mail imports, selected
 * charge searches and history backfills share the purpose with a plain
 * order-history sync, and a vendor-less run with no input only holds a
 * finding about mail from an unknown sender.
 */
export function runWorkLabel(run: {
  purpose: string;
  input: unknown;
  vendorId?: string | null;
}): string {
  const purpose = runPurpose.safeParse(run.purpose);
  if (!purpose.success) return run.purpose;
  if (purpose.data !== "account_sync") return RUN_PURPOSE_LABEL[purpose.data];
  const kind = z.object({ kind: z.string() }).safeParse(run.input);
  switch (kind.success ? kind.data.kind : null) {
    case "research_objectives": {
      const objectives = researchObjectivesRunInput.parse(run.input).objectives;
      if (objectives.some((objective) => objective.kind === "receipt_hunt"))
        return "Receipt research";
      if (objectives.some((objective) => objective.kind === "charge_hunt"))
        return "Charge search";
      return objectives.some(
        (objective) => objective.kind === "account_history" && objective.range,
      )
        ? "Order history backfill"
        : "Order history sync";
    }
    case "mail_research":
      return "Purchase research";
    case "order_mail_import":
      return "Order mail import";
    case "charge_hunts":
      return "Charge search";
    case "order_backfill":
      return "Order history backfill";
    default:
      return run.vendorId ? "Order history sync" : "Unknown sender review";
  }
}
