import { z } from "zod";
import { recipeId } from "./identifiers";

export const recipeFlowNodeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

export const recipeFlowInstructionRefSchema = z.object({
  sectionId: z.uuid(),
  instructionIndex: z.number().int().nonnegative(),
});
export type RecipeFlowInstructionRef = z.infer<
  typeof recipeFlowInstructionRefSchema
>;

export const recipeFlowAnnotationSchema = z.object({
  kind: z.enum(["time", "temperature", "cue"]),
  text: z.string().min(1).max(160),
});
export type RecipeFlowAnnotation = z.infer<typeof recipeFlowAnnotationSchema>;

export const recipeFlowSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    id: recipeFlowNodeId,
    kind: z.literal("usage"),
    usageId: z.uuid(),
    role: z.string().min(1).max(120).nullable(),
  }),
  z.object({
    id: recipeFlowNodeId,
    kind: z.literal("unlisted"),
    label: z.string().min(1).max(160),
    instructionRefs: z.array(recipeFlowInstructionRefSchema).min(1),
  }),
]);
export type RecipeFlowSource = z.infer<typeof recipeFlowSourceSchema>;

export const recipeFlowSetupSchema = z.object({
  id: recipeFlowNodeId,
  label: z.string().min(1).max(160),
  instructionRefs: z.array(recipeFlowInstructionRefSchema).min(1),
  annotations: z.array(recipeFlowAnnotationSchema),
});
export type RecipeFlowSetup = z.infer<typeof recipeFlowSetupSchema>;

export const recipeFlowInputRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("source"),
    id: recipeFlowNodeId,
  }),
  z.object({
    kind: z.literal("operation"),
    id: recipeFlowNodeId,
  }),
]);
export type RecipeFlowInputRef = z.infer<typeof recipeFlowInputRefSchema>;

export const recipeFlowOperationSchema = z.object({
  id: recipeFlowNodeId,
  label: z.string().min(1).max(160),
  outputLabel: z.string().min(1).max(160).nullable(),
  inputs: z.array(recipeFlowInputRefSchema).min(1),
  instructionRefs: z.array(recipeFlowInstructionRefSchema).min(1),
  annotations: z.array(recipeFlowAnnotationSchema),
});
export type RecipeFlowOperation = z.infer<typeof recipeFlowOperationSchema>;

export const recipeFlowPlanSchema = z.object({
  schemaVersion: z.literal(1),
  setup: z.array(recipeFlowSetupSchema),
  sources: z.array(recipeFlowSourceSchema),
  operations: z.array(recipeFlowOperationSchema).min(1),
  outputOperationIds: z.array(recipeFlowNodeId).min(1),
});
export type RecipeFlowPlan = z.infer<typeof recipeFlowPlanSchema>;

export const recipeFlowWarningCode = z.enum([
  "unlisted-input",
  "unreferenced-instruction",
  "divided-usage",
  "multiple-outputs",
]);
export type RecipeFlowWarningCode = z.infer<typeof recipeFlowWarningCode>;

export const recipeFlowWarningSchema = z.object({
  code: recipeFlowWarningCode,
  message: z.string().min(1),
  nodeIds: z.array(recipeFlowNodeId),
});
export type RecipeFlowWarning = z.infer<typeof recipeFlowWarningSchema>;

export const recipeFlowArtifactSchema = z.object({
  plan: recipeFlowPlanSchema,
  guidance: z.string().min(1).max(1000).nullable(),
  warnings: z.array(recipeFlowWarningSchema),
  contentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  generatedAt: z.coerce.date(),
});
export type RecipeFlowArtifact = z.infer<typeof recipeFlowArtifactSchema>;

const recipeFlowStateFields = {
  currentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};

export const recipeFlowStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("missing"),
    ...recipeFlowStateFields,
  }),
  z.object({
    status: z.literal("current"),
    ...recipeFlowStateFields,
    artifact: recipeFlowArtifactSchema,
  }),
  z.object({
    status: z.literal("stale"),
    ...recipeFlowStateFields,
    artifact: recipeFlowArtifactSchema,
  }),
]);
export type RecipeFlowState = z.infer<typeof recipeFlowStateSchema>;

export const recipeFlowGetInputSchema = z.object({
  id: recipeId,
});

export const recipeFlowGenerateInputSchema = z.object({
  id: recipeId,
  guidance: z.string().trim().min(1).max(1000).nullable().optional(),
  force: z.boolean().optional().default(false),
});
export type RecipeFlowGenerateInput = z.infer<
  typeof recipeFlowGenerateInputSchema
>;
