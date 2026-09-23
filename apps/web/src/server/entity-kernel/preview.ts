import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { resolveExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type { FieldResolutions } from "@cubby/schemas/field-resolution";
import { z } from "zod";

import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import { generatedMcpEntityActionEntities } from "~/server/generated/entity-kernel-entities.gen";
import { resolveDraftExpenseFields } from "~/server/repo/expense-inheritance";
import { resolveDraftTaskFields } from "~/server/repo/task-project-inheritance";
import { ensureRun } from "~/server/runs/ensure-run";

import type { EntityKernelContext } from "./adapter";

const previewEntitySchema = z.enum(generatedMcpEntityActionEntities.create);
const previewObjectSchema = z.record(z.string(), z.json());

export const entityPreviewInputSchema = z
  .object({
    entity: previewEntitySchema,
    /** Explicit values win over contextual seeds. */
    data: previewObjectSchema.default({}),
    context: z
      .object({
        /** Values inherited from a relation, route, or source record. */
        seeds: previewObjectSchema.default({}),
        /** Jev is opt-out for deterministic or privacy-sensitive callers. */
        suggest: z.boolean().default(true),
        /** Defaults to every manifest-declared suggestion target. */
        targets: z.array(z.string().min(1)).optional(),
      })
      .prefault({ seeds: {}, suggest: true }),
  })
  .strict();

const previewIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

const previewSuggestionSchema = z.object({
  value: z.string().nullable(),
  label: z.string().nullable(),
  detail: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  probability: z.number().min(0).max(1).nullable(),
  reasoning: z.string(),
  applied: z.boolean(),
});

export const entityPreviewOutputSchema = z.object({
  action: z.literal("preview"),
  entity: z.string(),
  proposed: previewObjectSchema,
  seeds: previewObjectSchema,
  suggestions: z.record(z.string(), previewSuggestionSchema.nullable()),
  warnings: z.array(z.string()),
  errors: z.array(previewIssueSchema),
  canCommit: z.boolean(),
});

export type EntityPreviewInput = z.input<typeof entityPreviewInputSchema>;
export type EntityPreviewOutput = z.output<typeof entityPreviewOutputSchema>;

const issueOutput = (issue: z.ZodIssue) => ({
  path: issue.path.filter(
    (part): part is string | number =>
      typeof part === "string" || typeof part === "number",
  ),
  message: issue.message,
});

type PreviewSuggestion = z.infer<typeof previewSuggestionSchema>;

export interface PreviewEntityPorts {
  suggest: typeof suggestFields;
  resolveExpense: typeof resolveDraftExpenseFields;
  resolveTask: typeof resolveDraftTaskFields;
  /** Ported so a unit test's fake `EntityKernelContext` (no real db/actor)
   * never exercises the real run-lookup query. */
  ensureRun: typeof ensureRun;
}

const productionPreviewPorts: PreviewEntityPorts = {
  suggest: suggestFields,
  resolveExpense: resolveDraftExpenseFields,
  resolveTask: resolveDraftTaskFields,
  ensureRun,
};

async function applyPreviewSuggestions(args: {
  context: EntityKernelContext;
  entity: EntityPreviewInput["entity"];
  model: (typeof entityFieldModels)[EntityPreviewInput["entity"]];
  targets: readonly string[];
  merged: z.output<typeof previewObjectSchema>;
  explicit: z.output<typeof previewObjectSchema>;
  proposed: z.output<typeof previewObjectSchema>;
  fieldResolutions: FieldResolutions;
  ports: PreviewEntityPorts;
}): Promise<{
  suggestions: Record<string, PreviewSuggestion | null>;
  warnings: string[];
}> {
  const suggestions: Record<string, PreviewSuggestion | null> = {};
  const warnings: string[] = [];
  if (args.targets.length === 0) return { suggestions, warnings };

  const dependencyKeys = new Set<string>(
    args.model.fields
      .filter((field) => field.control?.suggest)
      .flatMap((field) => {
        const suggest = field.control?.suggest;
        if (!suggest) return [];
        // A prune target judges its own current entries, so it is an
        // implicit self-basis (Amendment 1) — the manifest compiler rejects
        // naming it explicitly, so it's added back here.
        return suggest.mode === "prune"
          ? [...suggest.basis, field.key]
          : suggest.basis;
      }),
  );
  if (args.entity === "expense") {
    for (const key of [
      "lineKind",
      "purchaseId",
      "productId",
      "projectId",
      "trade",
    ]) {
      dependencyKeys.add(key);
    }
  }
  if (args.entity === "task") {
    for (const key of [
      "parentTaskId",
      "projectId",
      "projectMode",
      "subjectProductId",
      "subjectProductMode",
      "trade",
    ]) {
      dependencyKeys.add(key);
    }
  }
  const basis = args.model.fields
    .filter((field) => dependencyKeys.has(field.key))
    .reduce<Record<string, string | null>>((result, field) => {
      const raw = args.merged[field.key];
      // A text-array basis value (a prune target's own self-basis, or a
      // sibling array field) JSON-encodes the same way the client's
      // `basisValueOf` does — the field-suggest registry parses it back.
      result[field.key] = Array.isArray(raw)
        ? JSON.stringify(raw)
        : z.string().nullable().catch(null).parse(raw);
      return result;
    }, {});
  basis.__resolutionContext = JSON.stringify(args.fieldResolutions);
  const suggestedTargets = args.targets.filter((field) => {
    const resolution = args.fieldResolutions[field];
    return (
      args.explicit[field] === undefined &&
      (resolution === undefined ||
        (resolution.mode === "inherit" && resolution.value === null))
    );
  });
  const suggestedSet = new Set(suggestedTargets);
  const providedTargets = args.targets.filter(
    (field) => !suggestedSet.has(field),
  );

  const runId = await args.ports.ensureRun(
    args.context.db,
    args.context.actorContext,
    { purpose: "ai_action" },
  );
  const runBatch = async (
    basisMode: "suggested" | "provided",
    targets: readonly string[],
  ) => {
    if (targets.length === 0) return;
    const result = await args.ports.suggest(args.context.db, runId, {
      basisMode,
      entity: args.entity,
      targets: [...targets],
      basis,
    });
    for (const [field, suggestion] of Object.entries(result.suggestions)) {
      if (!suggestion) {
        suggestions[field] = null;
        continue;
      }
      const applied =
        basisMode === "suggested" &&
        args.explicit[field] === undefined &&
        suggestion.confidence === "high" &&
        // A `remove` proposal is always a review-and-approve action, never a
        // silent auto-apply — even at high confidence.
        suggestion.operation !== "remove";
      if (applied) args.proposed[field] = suggestion.value;
      suggestions[field] = { ...suggestion, applied };
    }
  };
  try {
    await Promise.all([
      runBatch("suggested", suggestedTargets),
      runBatch("provided", providedTargets),
    ]);
  } catch (error) {
    warnings.push(
      `Suggestions were unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  return { suggestions, warnings };
}

const inheritanceDraftSchema = z.looseObject({
  name: z.string().nullable().optional(),
  lineKind: z.string().optional(),
  projectId: z.string().nullable().optional(),
  projectMode: z.string().optional(),
  subjectProductId: z.string().nullable().optional(),
  subjectProductMode: z.string().optional(),
  parentTaskId: z.string().nullable().optional(),
  productId: z.string().nullable().optional(),
  purchaseId: z.string().nullable().optional(),
  trade: z.string().nullable().optional(),
});

function previewRequiresTrade(
  entity: EntityPreviewInput["entity"],
  proposed: z.output<typeof previewObjectSchema>,
) {
  if (entity === "task") return true;
  if (entity !== "expense") return false;
  return (
    proposed.lineKind === undefined ||
    proposed.lineKind === "principal" ||
    proposed.lineKind === "auto"
  );
}

async function resolveDraftInheritance(
  context: EntityKernelContext,
  entity: EntityPreviewInput["entity"],
  merged: z.output<typeof previewObjectSchema>,
  ports: PreviewEntityPorts,
): Promise<FieldResolutions> {
  const draft = inheritanceDraftSchema.parse(merged);
  if (entity === "expense") {
    // SAFETY: inheritanceDraftSchema validates the complete Expense draft
    // subset consumed by the authoritative resolver.
    return ports.resolveExpense(
      context.db,
      draft as Parameters<typeof resolveDraftExpenseFields>[1],
    );
  }
  if (entity === "task") {
    // SAFETY: inheritanceDraftSchema validates the complete Task draft subset
    // consumed by the authoritative resolver.
    return ports.resolveTask(
      context.db,
      draft as Parameters<typeof resolveDraftTaskFields>[1],
    );
  }
  return {};
}

/**
 * Preview parses the generated create schema, resolves inherited draft fields
 * through the same authoritative readers used by writes, then asks Jev only
 * for unresolved manifest-declared targets.
 */
export async function previewEntity(
  context: EntityKernelContext,
  rawInput: EntityPreviewInput,
  ports: PreviewEntityPorts = productionPreviewPorts,
): Promise<EntityPreviewOutput> {
  const input = entityPreviewInputSchema.parse(rawInput);
  const binding = ENTITY_SCHEMA_BINDINGS[input.entity];
  const seeds = input.context.seeds;
  const explicit = input.data;
  const merged = { ...seeds, ...explicit };
  if (input.entity === "expense") {
    merged.lineKind = resolveExpenseLineKind(
      inheritanceDraftSchema.parse(merged),
    );
  }
  const errors: z.infer<typeof previewIssueSchema>[] = [];
  const warnings: string[] = [];

  if (!binding.createInput) {
    errors.push({ path: [], message: "This entity does not support create." });
  }

  const parsed = binding.createInput?.safeParse(merged);

  const proposed = previewObjectSchema.parse(
    parsed?.success ? parsed.data : merged,
  );
  const model = entityFieldModels[input.entity];
  const fieldResolutions = await resolveDraftInheritance(
    context,
    input.entity,
    merged,
    ports,
  );
  const targets = (
    input.context.targets ??
    model.fields.flatMap((field) => (field.control?.suggest ? [field.key] : []))
  ).filter(
    (field) =>
      !(
        input.entity === "expense" &&
        field === "projectId" &&
        merged.lineKind !== undefined &&
        merged.lineKind !== "principal"
      ),
  );
  const suggestionResult = input.context.suggest
    ? await applyPreviewSuggestions({
        context,
        entity: input.entity,
        model,
        targets,
        merged,
        explicit,
        proposed,
        fieldResolutions,
        ports,
      })
    : { suggestions: {}, warnings: [] };
  const suggestions = suggestionResult.suggestions;
  warnings.push(...suggestionResult.warnings);

  for (const [field, value] of Object.entries(seeds)) {
    if (explicit[field] !== undefined && explicit[field] !== value) {
      warnings.push(
        `Explicit value for ${field} overrides its contextual seed.`,
      );
    }
  }

  // Jev suggestions are still untrusted input. Re-parse the final proposal so
  // defaults, refinements, and reference brands are applied after inference.
  const finalParsed = binding.createInput?.safeParse(proposed);
  if (finalParsed?.success) {
    Object.assign(proposed, finalParsed.data);
    const finalResolutions = await resolveDraftInheritance(
      context,
      input.entity,
      proposed,
      ports,
    );
    if (
      previewRequiresTrade(input.entity, proposed) &&
      finalResolutions.trade?.value === null
    ) {
      errors.push({
        path: ["trade"],
        message:
          "No effective trade is available from this record or its inheritance sources.",
      });
    }
  } else if (finalParsed) {
    errors.push(...finalParsed.error.issues.map(issueOutput));
  }

  return entityPreviewOutputSchema.parse({
    action: "preview",
    entity: input.entity,
    proposed,
    seeds,
    suggestions,
    warnings,
    errors,
    canCommit: errors.length === 0,
  });
}
