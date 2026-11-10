import type { RunWorkSamples } from "./run-work-progress";
import {
  type AiRefreshRunInput,
  aiRefreshActivation,
  aiRefreshProgress,
  aiRefreshRunInput,
} from "./ai-evaluation";
import type { MailReclassificationCheckpoint } from "./email-actions.js";
import { z } from "zod";
import { entityIdSchema } from "./identifier-fields";
import {
  ATTENTION_RUN_PURPOSES,
  RUN_KINDS,
  RUN_PURPOSE_LABEL,
  runPurpose,
} from "./activity-fields";
export {
  EXECUTED_RUN_PURPOSES,
  isExecutedRunPurpose,
  isStepRunPurpose,
  OWNED_AI_WORK_PURPOSES,
  RUN_KINDS,
  runStepDeclaration,
  STEP_RUN_PURPOSES,
  ATTENTION_RUN_PURPOSES,
  VISIBLE_RUN_PURPOSES,
  type ExecutedRunPurpose,
  type RunKindDeclaration,
  type RunStepDeclaration,
  type RunStepDeclarationOf,
  type RunStepInputMode,
  type RunStepKey,
  type StepRunPurpose,
} from "./activity-fields";
export {
  RUN_PURPOSE_LABEL,
  runPurpose,
  hasImportRunReports,
} from "./activity-fields";
export type { RunPurpose } from "./activity-fields";
import type { PhotoInventoryRunInput } from "./photo-run-input.js";
import { plainDate } from "./base-entity.js";
import { financialTransactionNonZeroAmount } from "./financial-transaction-fields.js";
import { vendorAccountCursor } from "./vendor-account-fields.js";
import {
  EMAIL_RECLASSIFY_LIMIT,
  mailboxDiscoveryInput,
  mailboxDiscoveryProgress,
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
const MEMBER_FACING_PURPOSES = new Set<string>(ATTENTION_RUN_PURPOSES);
/** A Run a member or their agent started; its transitions ring open tabs. */
export const isMemberStartedRun = (run: { purpose: string; trigger: string }) =>
  MEMBER_FACING_PURPOSES.has(run.purpose) &&
  (run.trigger === "foreground" || run.trigger === "manual");
export const runStatus = z.enum([
  "running",
  "paused",
  "paused_auth",
  "paused_offline",
  "needs_review",
  "completed",
  "failed",
  "dispatch_failed",
]);
/**
 * The status a Run reads as: its stored status, except that a Run stopped for
 * review or failed whose open work moved to a retry successor reads
 * `retried`, and a funding stop reads `waiting_for_funding`.
 */
export const runDisplayStatus = z.enum([
  ...runStatus.options,
  "retried",
  "waiting_for_funding",
]);
export const runTargetEntityKind = z.enum([
  "purchase",
  "product",
  "image",
  "run",
]);
/** Permanent retirement prevents disposed coordinator history from being recreated. */
export const runRetirementReason = z.enum(["unrelated_source", "settled"]);
/**
 * Unrelated-source retirement erased the Run's input, progress and targets
 * with the Email they named; `settled` only disposed the coordinator, so a
 * settled Run keeps its inputs and can still be restarted.
 */
export const runInputsErased = (reason: string | null) =>
  reason === runRetirementReason.enum.unrelated_source;
/** What `run.control` can do to a Run; the report actions and the operation share it. */
export const runControlAction = z.enum([
  "pause",
  "resume",
  "cancel",
  "retry",
  "restart",
  "escalate_sol",
  "retry_dispatch",
  "abort",
  "upload_evidence",
  "no_evidence_available",
  // A paused background Run resumes now with paid funding allowed.
  "run_now_paid",
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
const mailDiscoveryRunInput = mailboxDiscoveryInput;
type MailDiscoveryRunInput = z.infer<typeof mailDiscoveryRunInput>;
export const mailDiscoveryRunProgress = mailboxDiscoveryProgress;
type MailDiscoveryRunProgress = z.infer<typeof mailDiscoveryRunProgress>;
/**
 * Admission freezes at most 50 targets; supporting originals a notice needs
 * append beyond them up to this backstop, so a full batch never strands a
 * notice. The bound only stops a runaway coordinator.
 */
export const MAIL_RUN_ROSTER_LIMIT = 150;
/** Original retained sources; interpreted order identity remains a research decision. */
export const mailResearchRunInput = z.object({
  kind: z.literal("mail_research"),
  sources: z
    .array(
      z.object({
        orderMailId: z.uuid(),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(MAIL_RUN_ROSTER_LIMIT),
  /**
   * The evidence revision (sender mapping, accepted order evidence or new
   * retained bytes) this Run attempts. The revision fence reads it from every
   * frozen roster, independently of the replay `clientKey` a release clears.
   */
  evidenceRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
type MailResearchRunInput = z.infer<typeof mailResearchRunInput>;
export const productResearchRunInput = z.object({
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
type ProductResearchRunInput = z.infer<typeof productResearchRunInput>;
/** Purchase validation freezes recorded context and optional original-source preference. */
export const purchaseValidationResearchRunInput = z.strictObject({
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
type PurchaseValidationResearchRunInput = z.infer<
  typeof purchaseValidationResearchRunInput
>;
/** One saved placement confirmation a mail import run is assigned. */
const orderMailImportOrder = z.object({
  eventId: z.uuid(),
  evidenceChecksum: z.string().min(1),
  orderId: z.string().min(1),
});
export type OrderMailImportOrder = z.infer<typeof orderMailImportOrder>;
/**
 * `Run.input` for mail-only imports. The single form (one confirmation) is
 * what every run started before multi-select carries and stays readable; the
 * `orders` form is one run over several selected confirmations of one member
 * and Vendor.
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
type OrderBackfillRunInput = z.infer<typeof orderBackfillRunInput>;
/**
 * `Run.input` of a retired browser run over selected charge hunts. Only
 * historical Runs carry it; it stays parseable so their detail still reads.
 */
export const chargeHuntRunInput = z.object({
  kind: z.literal("charge_hunts"),
  huntIds: z.array(z.uuid()).min(1).max(50),
});
const researchDateRange = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
});

/** Host-frozen objectives; source identity is never supplied by the researcher. */
const researchObjective = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("vendor_purchases"),
    vendorId: z.uuid(),
    range: researchDateRange.nullable(),
  }),
  z.strictObject({
    kind: z.literal("account_history"),
    vendorAccountId: z.uuid(),
    range: researchDateRange.nullable(),
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
export const researchObjectivesRunInput = z.strictObject({
  kind: z.literal("research_objectives"),
  instructionRevision: z.number().int().positive(),
  objectives: z.array(researchObjective).min(1).max(50),
});
type ResearchObjectivesRunInput = z.infer<typeof researchObjectivesRunInput>;

/**
 * What a restart copies from `Run.input`, by public values only: a mail
 * import's order ids, a backfill's range, or how many charges a charge run
 * carries, or a retained mail source count. Source, mail-event and hunt ids
 * are private and never cross it.
 * @public Names a generated native model.
 */
export const runRestartOrderMailInput = z
  .object({
    kind: z.literal("order_mail_import"),
    orderIds: z.array(z.string()),
  })
  .meta({ id: "RunRestartOrderMailInput" });
/** @public Names a generated native model. */
export const runRestartOrderBackfillInput = z
  .object({
    kind: z.literal("order_backfill"),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .meta({ id: "RunRestartOrderBackfillInput" });
/** @public Names a generated native model. */
export const runRestartChargeHuntsInput = z
  .object({
    kind: z.literal("charge_hunts"),
    chargeCount: z.number().int().positive(),
  })
  .meta({ id: "RunRestartChargeHuntsInput" });
/** @public Names a generated native model. */
export const runRestartVendorPurchasesInput = researchObjective.options[0]
  .extend({ vendorId: z.string().min(1) })
  .meta({ id: "RunRestartVendorPurchasesInput" });
/** @public Names a generated native model. */
export const runRestartMailResearchInput = mailResearchRunInput
  .pick({ kind: true })
  .extend({
    sourceCount: z.number().int().min(1).max(MAIL_RUN_ROSTER_LIMIT),
  })
  .meta({ id: "RunRestartMailResearchInput" });
export const runRestartInput = z.discriminatedUnion("kind", [
  runRestartOrderMailInput,
  runRestartOrderBackfillInput,
  runRestartChargeHuntsInput,
  runRestartVendorPurchasesInput,
  runRestartMailResearchInput,
]);
export type RunRestartInput = z.infer<typeof runRestartInput>;
/**
 * A member's Reclassify, extraction-preview rerun, or read-only triage preview
 * of selected Emails in one mailbox.
 */
export const mailReclassifyRunInput = z.strictObject({
  kind: z.literal("mail_reclassify"),
  mode: z.enum(["relevance", "preview", "triage_preview"]),
  mailboxId: z.string().min(1),
  emails: z
    .array(
      z.strictObject({
        emailId: entityIdSchema("email"),
        checksum: z.string(),
      }),
    )
    .min(1)
    .max(EMAIL_RECLASSIFY_LIMIT),
});
export type MailReclassifyRunInput = z.infer<typeof mailReclassifyRunInput>;
/** A member's Reclassify Run: classification-tier work that never admits import. */
export const isMailReclassifyRun = (run: { purpose: string; input: unknown }) =>
  (run.purpose === "background" || run.purpose === "mail_reclassify") &&
  mailReclassifyRunInput.safeParse(run.input).success;
export const isAiRefreshMailRun = (run: {
  purpose: string;
  input: unknown;
}) => {
  const input = aiRefreshRunInput.safeParse(run.input);
  return (
    run.purpose === "ai_refresh" &&
    input.success &&
    Boolean(input.data.mailboxId && input.data.emails?.length)
  );
};
/** Entity and decision fields a field Sweep covers. */
export const sweepFieldTargets = z
  .array(
    z.strictObject({
      entity: z.string().min(1),
      fields: z.array(z.string().min(1)).min(1),
      filters: z.record(z.string(), z.json()).default({}),
    }),
  )
  .max(50);

/** The Suggestion families a Sweep can cover, each with its own scope. */
export const sweepFamilyScope = z.discriminatedUnion("family", [
  z.strictObject({
    family: z.literal("statement_transaction"),
    scope: z
      .strictObject({
        importId: z.uuid().optional(),
        accountIds: z.array(z.uuid()).max(100).optional(),
        since: plainDate.optional(),
      })
      .default({}),
  }),
  z.strictObject({
    family: z.literal("field"),
    scope: z
      .strictObject({
        /** Omitted covers every declared decision field. */
        targets: sweepFieldTargets.optional(),
      })
      .default({}),
  }),
]);
export type SweepFamilyScope = z.infer<typeof sweepFamilyScope>;
export type SweepFamily = SweepFamilyScope["family"];
/**
 * Families a Sweep once covered and no longer runs (#3899). Stored inputs keep
 * them as non-executable history: they parse and display as retired, never plan
 * steps and never run. Their scopes are not interpreted.
 */
const retiredSweepFamilyScope = z.discriminatedUnion("family", [
  z.object({
    family: z.literal("transfer_pair"),
    scope: z.record(z.string(), z.json()).default({}),
  }),
  z.object({
    family: z.literal("recommendation"),
    scope: z.record(z.string(), z.json()).default({}),
  }),
]);
export type RetiredSweepFamilyScope = z.infer<typeof retiredSweepFamilyScope>;
export const RETIRED_SWEEP_FAMILY_LABEL = {
  transfer_pair: "Transfer pairs",
  recommendation: "Connections",
} as const satisfies Record<RetiredSweepFamilyScope["family"], string>;
/** A stored Sweep input's family: executable or retired history. */
const storedSweepFamilyScope = z.discriminatedUnion("family", [
  ...sweepFamilyScope.options,
  ...retiredSweepFamilyScope.options,
]);
export type StoredSweepFamilyScope = z.infer<typeof storedSweepFamilyScope>;
export const isExecutableSweepFamily = (
  entry: StoredSweepFamilyScope,
): entry is SweepFamilyScope => entry.family in SWEEP_FAMILY_LABEL;
/** Each Suggestion family's plural name, shared by Sweep steps, chips, and dialogs. */
export const SWEEP_FAMILY_LABEL = {
  statement_transaction: "Statements",
  field: "Fields",
} as const satisfies Record<SweepFamily, string>;
export const sweepRunInput = z.strictObject({
  kind: z.literal("sweep"),
  families: z.array(storedSweepFamilyScope).min(1).max(4),
});
type SweepRunInput = z.infer<typeof sweepRunInput>;
const maintenanceRunInput = z.strictObject({
  kind: z.literal("maintenance"),
});
type MaintenanceRunInput = z.infer<typeof maintenanceRunInput>;
/** The derived data families a routine refresh pass covers, one per Run. */
const derivedRefreshFamily = z.enum(
  // SAFETY: the declared steps are a non-empty literal list of these keys.
  RUN_KINDS.derived_refresh.steps.map((step) => step.key) as [
    (typeof RUN_KINDS.derived_refresh.steps)[number]["key"],
    ...(typeof RUN_KINDS.derived_refresh.steps)[number]["key"][],
  ],
);
const derivedRefreshRunInput = z.strictObject({
  kind: z.literal("derived_refresh"),
  family: derivedRefreshFamily,
});
type DerivedRefreshRunInput = z.infer<typeof derivedRefreshRunInput>;
/** The routine connection discovery pass, under the AI refresh generation it ran for. */
const connectionDiscoveryRunInput = z.strictObject({
  kind: z.literal("connection_discovery"),
  activation: aiRefreshActivation,
});
type ConnectionDiscoveryRunInput = z.infer<typeof connectionDiscoveryRunInput>;

export type RunInput =
  | SweepRunInput
  | MaintenanceRunInput
  | DerivedRefreshRunInput
  | ConnectionDiscoveryRunInput
  | MailReclassifyRunInput
  | ResearchObjectivesRunInput
  | MailResearchRunInput
  | ProductResearchRunInput
  | PurchaseValidationResearchRunInput
  | MailDiscoveryRunInput
  | z.infer<typeof orderMailImportRunInput>
  | OrderBackfillRunInput
  | z.infer<typeof chargeHuntRunInput>
  | AiRefreshRunInput
  | PhotoInventoryRunInput;
export type RunProgress =
  | MailDiscoveryRunProgress
  | MailReclassificationCheckpoint
  | z.infer<typeof aiRefreshProgress>;

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
  if (isMailReclassifyRun(run)) return "Email reclassification";
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

/** Delivery metadata and display state owned by the Run, separate from its checkpoint. */
export const runProgressStamp = z.object({
  generation: z.string().min(1),
  sequence: z.number().int().nonnegative(),
});
export type RunProgressStamp = z.infer<typeof runProgressStamp>;
export const runProgressEvent = runProgressStamp.extend({
  eventId: z.string().min(1),
  phase: z.string().min(1),
  currentItem: z.string().nullable(),
  awaitingApproval: z.boolean(),
  detail: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type RunProgressEvent = z.infer<typeof runProgressEvent>;
/** Live-only sampling metadata; history retains the original small event payload. */
export type RunLiveProgressEvent = RunProgressEvent & { work?: RunWorkSamples };
export type RunProgressHistory = RunProgressEvent[];
export type RunProgressEventIds = string[];

/** Historical target attribution is immutable operation evidence after roster retirement. */
export const runTargetOutcomeReceipt = z.object({
  target: z.object({
    entityKind: z.enum([...runTargetEntityKind.options, "email"]),
    entityId: z.uuid(),
    workKey: z.string(),
    state: z.string(),
    outcome: z.string().nullable(),
    warning: z.string().nullable(),
    diff: z.json().nullable(),
    completedAt: z.iso.datetime().nullable(),
    targetFingerprint: z.string(),
    sourceKind: z.string().nullable().optional(),
    sourceExternalKey: z.string().nullable().optional(),
    vendorAccountId: z.uuid().nullable().optional(),
    evidenceFingerprint: z.string().nullable().optional(),
    position: z.number().int().nullable().optional(),
  }),
});
export type RunTargetOutcomeReceipt = z.infer<typeof runTargetOutcomeReceipt>;
