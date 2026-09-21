import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { z } from "zod";

import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import { generatedMcpEntityActionEntities } from "~/server/generated/entity-kernel-entities.gen";

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

async function applyPreviewSuggestions(args: {
  context: EntityKernelContext;
  entity: EntityPreviewInput["entity"];
  model: (typeof entityFieldModels)[EntityPreviewInput["entity"]];
  targets: readonly string[];
  merged: z.output<typeof previewObjectSchema>;
  explicit: z.output<typeof previewObjectSchema>;
  proposed: z.output<typeof previewObjectSchema>;
}): Promise<{
  suggestions: Record<string, PreviewSuggestion | null>;
  warnings: string[];
}> {
  const suggestions: Record<string, PreviewSuggestion | null> = {};
  const warnings: string[] = [];
  if (args.targets.length === 0) return { suggestions, warnings };

  const basis = args.model.fields
    .filter((field) => field.control?.suggest)
    .reduce<Record<string, string | null>>((result, field) => {
      result[field.key] = z
        .string()
        .nullable()
        .catch(null)
        .parse(args.merged[field.key]);
      return result;
    }, {});
  try {
    const result = await suggestFields(args.context.db, {
      basisMode: "suggested",
      entity: args.entity,
      targets: [...args.targets],
      basis,
    });
    for (const [field, suggestion] of Object.entries(result.suggestions)) {
      if (!suggestion) {
        suggestions[field] = null;
        continue;
      }
      const applied =
        args.explicit[field] === undefined && suggestion.confidence === "high";
      if (applied) args.proposed[field] = suggestion.value;
      suggestions[field] = { ...suggestion, applied };
    }
  } catch (error) {
    warnings.push(
      `Suggestions were unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  return { suggestions, warnings };
}

/**
 * Preview is deliberately a pure application-layer operation: it parses the
 * generated create schema, asks the existing Jev suggestion service for
 * manifest-declared targets, and never calls an entity repository.
 */
export async function previewEntity(
  context: EntityKernelContext,
  rawInput: EntityPreviewInput,
): Promise<EntityPreviewOutput> {
  const input = entityPreviewInputSchema.parse(rawInput);
  const binding = ENTITY_SCHEMA_BINDINGS[input.entity];
  const seeds = input.context.seeds;
  const explicit = input.data;
  const merged = { ...seeds, ...explicit };
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
  const targets =
    input.context.targets ??
    model.fields.flatMap((field) =>
      field.control?.suggest ? [field.key] : [],
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
