import { assessmentChildHandle } from "./assessment-reference";
import { workflowRecoveryProgress } from "./workflow-runs";
import { z } from "zod";
import { executionAuthorizationRef } from "./execution-authorization";

export const SUGGESTION_AUTO_APPLY_THRESHOLD = 0.85;

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
  runId: z.uuid().nullable(),
  auditIds: z.array(z.uuid()),
  acceptedAt: z.iso.datetime(),
  reason: z.enum([
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
export const aiEvaluationState = z.enum([
  "queued",
  "running",
  "result_ready",
  "retry_wait",
  "completed",
  "blocked",
  "failed",
  "obsolete",
  "cancelled",
]);
export const aiExecutionKind = z.enum([
  "ai_refresh",
  "mail_reclassify",
  "suggestion_sweep",
  "mail_discovery",
]);
export type AiExecutionKind = z.infer<typeof aiExecutionKind>;
export const aiEvaluationTarget = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("product_pair"),
    entity: z.literal("product"),
    recordId: z.uuid(),
    otherId: z.uuid(),
    field: z.null(),
    assessmentIds: z.array(assessmentChildHandle).max(0),
  }),
  z.object({
    kind: z.literal("product"),
    entity: z.literal("product"),
    recordId: z.uuid(),
    field: z.null(),
    assessmentIds: z.array(assessmentChildHandle).max(0),
  }),
  z.object({
    kind: z.literal("field"),
    entity: z.string(),
    recordId: z.uuid(),
    field: z.string(),
    assessmentIds: z.array(assessmentChildHandle),
  }),
  z.object({
    kind: z.literal("email"),
    entity: z.literal("email"),
    recordId: z.uuid(),
    field: z.null(),
    assessmentIds: z.array(assessmentChildHandle).max(0),
  }),
]);
export type AiEvaluationTarget = z.infer<typeof aiEvaluationTarget>;
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
  discoveryRunId: z.uuid().nullable().default(null),
  release: z.string(),
  manifest: aiRefreshManifest,
  activatedAt: z.iso.datetime(),
  enabled: z.boolean(),
});
export const aiRefreshRunInput = z.object({
  kind: z.literal("ai_refresh"),
  discovery: z.boolean().default(false),
  activation: aiRefreshActivation,
  executionAuthorization: executionAuthorizationRef.optional(),
  emails: z
    .array(z.object({ emailId: z.uuid(), checksum: z.string().nullable() }))
    .max(200)
    .optional(),
  mailboxId: z.string().optional(),
});
export type AiRefreshRunInput = z.infer<typeof aiRefreshRunInput>;
export const aiRefreshProgress = z.object({
  ...workflowRecoveryProgress.shape,
  attempt: z.number().int().nonnegative().default(0),
  selected: z.number().int().nonnegative().default(0),
  completed: z.number().int().nonnegative().default(0),
  blocked: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  queued: z.number().int().nonnegative().optional(),
  running: z.number().int().nonnegative().optional(),
  retryWait: z.number().int().nonnegative().optional(),
  resultReady: z.number().int().nonnegative().optional(),
  obsolete: z.number().int().nonnegative().optional(),
  cancelled: z.number().int().nonnegative().optional(),
  errors: z.array(z.string()).max(10).optional(),
});
