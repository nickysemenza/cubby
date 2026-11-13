import { entityIdSchema } from "./identifier-fields";
import { z } from "zod";

/** Stored marker distinguishing a member stop from other retained cancellations. */
export const MEMBER_CANCELLED_AI_WORK = "Cancelled by a member";

/** Public confidence labels and eligible empty-field filling share one boundary. */
export const HIGH_CONFIDENCE_PROBABILITY = 0.85;

/** @public Names a generated native model. */
export const aiDependencyStamp = z.object({
  feature: z.string().min(1),
  promptVersion: z.string().min(1),
  generation: z.number().int().nonnegative(),
  policyFingerprint: z.string(),
});
export const aiProvenance = z.object({
  dependencies: z.array(aiDependencyStamp),
  inputFingerprint: z.string(),
  optionFingerprint: z.string(),
  model: z.string().nullable(),
});
export type AiProvenance = z.infer<typeof aiProvenance>;
export const suggestionAcceptanceReceipt = z.object({
  mode: z.enum(["automatic", "member"]),
  runId: entityIdSchema("run").nullable(),
  auditIds: z.array(z.uuid()),
  acceptedAt: z.iso.datetime(),
  /** Authoritative evidence after application; absent on retained legacy receipts. */
  appliedInputFingerprint: z.string().optional(),
  /** Mutable projection bookkeeping for an agreeing reevaluation; historical Feedback is unchanged. */
  evaluatedInput: z
    .object({ fingerprint: z.string(), provenance: aiProvenance })
    .optional(),
  reason: z.enum([
    "confident_assignment",
    // Historical application receipts describe the policy actually applied.
    "confident_addition",
    "member_acceptance",
    "member_correction",
  ]),
  confidence: z.number().nullable(),
  threshold: z.number().nullable(),
});
export type SuggestionAcceptanceReceipt = z.infer<
  typeof suggestionAcceptanceReceipt
>;
export const suggestionSupersessionReceipt = z.object({
  reason: z.enum([
    "replacement",
    "input_changed",
    "target_changed",
    "no_proposal",
  ]),
  evaluationId: z.uuid().nullable(),
  at: z.iso.datetime(),
});
export type SuggestionSupersessionReceipt = z.infer<
  typeof suggestionSupersessionReceipt
>;

/**
 * Why field automation evaluated a field, carried from scheduling to the
 * published Suggestion so Changes by Cubby can group by it. `ref` names a
 * policy pass's activation revision; it never carries a raw identifier.
 */
export const fieldAutomationCause = z.object({
  kind: z.enum([
    "new_record",
    "import",
    "evidence_changed",
    "correction",
    "policy_revision",
    "released",
  ]),
  ref: z.string().optional(),
});

export const aiRefreshManifest = z.record(
  z.string(),
  z.object({
    promptVersion: z.string(),
    policyFingerprint: z.string(),
    generation: z.number().int().nonnegative(),
  }),
);
export type AiRefreshManifest = z.infer<typeof aiRefreshManifest>;
export const aiRefreshActivation = z.object({
  observationEpoch: z.number().int().nonnegative().default(0),
  revision: z.number().int().nonnegative().default(0),
  release: z.string(),
  manifest: aiRefreshManifest,
  activatedAt: z.iso.datetime(),
  enabled: z.boolean(),
});
export const aiRefreshRunInput = z.object({
  kind: z.literal("ai_refresh"),
  discovery: z.boolean().default(false),
  activation: aiRefreshActivation,
  emails: z
    .array(z.object({ emailId: z.uuid(), checksum: z.string().nullable() }))
    .max(200)
    .optional(),
  mailboxId: z.string().optional(),
});
export type AiRefreshRunInput = z.infer<typeof aiRefreshRunInput>;
export const aiRefreshProgress = z.object({
  attempt: z.number().int().nonnegative().default(0),
  selected: z.number().int().nonnegative().default(0),
  completed: z.number().int().nonnegative().default(0),
  blocked: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  queued: z.number().int().nonnegative().optional(),
  resultReady: z.number().int().nonnegative().optional(),
  obsolete: z.number().int().nonnegative().optional(),
  cancelled: z.number().int().nonnegative().optional(),
  errors: z.array(z.string()).max(10).optional(),
});

/**
 * Ordered provider input evidence retained with field correction identity recipes.
 * @public Names a generated native model.
 */
export const capturedFieldInput = z.object({
  feature: z.string(),
  promptVersion: z.string(),
  operation: z.string(),
  model: z.string(),
  fingerprint: z.string(),
});
