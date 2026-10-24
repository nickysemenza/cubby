import type { FieldSuggestion } from "@cubby/schemas/ai";
import { fieldSuggestionsInput } from "@cubby/schemas/ai";
import {
  aiProvenance,
  capturedFieldInput,
  type AiProvenance,
} from "@cubby/schemas/ai-evaluation";
import type { AiRefreshManifest } from "@cubby/schemas/ai-evaluation";
import { fieldSuggestionIdentityBasis } from "@cubby/schemas/field-suggestion";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { CapturedInput } from "~/server/ai/evaluation-inputs";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { canonicalJson } from "~/server/lib/canonical-json";

const identityInput = z.object({
  entity: z.string(),
  field: z.string(),
  basis: z.json(),
  inputs: z.array(capturedFieldInput),
  dependencies: aiProvenance.shape.dependencies,
  incomplete: z.boolean().optional(),
});
export const fieldCorrectionRecipe = identityInput.extend({
  version: z.literal("field-correction-v2"),
});

/** Frozen raw-v1 serialization is also the proof for retained live evidence. */
async function rawFieldCorrectionIdentity(
  input: z.infer<typeof identityInput>,
) {
  const inputs = input.inputs.filter(
    (call) => call.operation === `suggestFields.${input.entity}.${input.field}`,
  );
  if (input.incomplete || !inputs.length || !input.dependencies.length)
    return null;
  return sha256Hex(
    canonicalJson({
      version: "field-correction-v1",
      entity: input.entity,
      field: input.field,
      basis: input.basis,
      inputs,
      dependencies: input.dependencies,
    }),
  );
}

/** Exact canonical pre-decision inputs, independent of record identity and output. */
export async function fieldCorrectionIdentity(input: {
  entity: string;
  field: string;
  basis: unknown;
  inputs: readonly CapturedInput[];
  dependencies: AiProvenance["dependencies"];
  incomplete?: boolean;
}) {
  const entity = fieldSuggestionsInput.shape.entity.safeParse(input.entity);
  const basis = entity.success
    ? fieldSuggestionIdentityBasis(entity.data, input.field, input.basis)
    : null;
  if (!basis) return null;
  const parsed = identityInput.parse({ ...input, basis });
  const inputs = parsed.inputs.filter(
    (call) => call.operation === `suggestFields.${input.entity}.${input.field}`,
  );
  if (input.incomplete || !inputs.length || !input.dependencies.length)
    return null;
  return sha256Hex(
    canonicalJson({
      version: "field-correction-v2",
      entity: input.entity,
      field: input.field,
      basis,
      inputs,
      dependencies: input.dependencies,
    }),
  );
}

/** A legacy key gains an alias only when retained evidence reproduces its immutable hash. */
export async function proveFieldCorrectionIdentity(input: {
  entity: string;
  field: string;
  evidence: unknown;
  manifest: AiRefreshManifest;
}) {
  const evidence = z
    .object({
      correctionKey: z.string().nullable(),
      correctionRecipe: fieldCorrectionRecipe.optional(),
      basis: z.json().optional(),
      inputs: z.array(capturedFieldInput).optional(),
      dependencies: aiProvenance.shape.dependencies.optional(),
    })
    .safeParse(input.evidence);
  const storedKey =
    z.object({ correctionKey: z.string().nullable() }).safeParse(input.evidence)
      .data?.correctionKey ?? null;
  const unsupported = (
    reason: "missing_key" | "missing_inputs" | "hash_mismatch",
  ) => ({ storedKey, canonicalKey: null, reason });
  if (!storedKey) return unsupported("missing_key");
  if (!evidence.success) return unsupported("hash_mismatch");
  if (evidence.data?.correctionRecipe) {
    const recipe = evidence.data.correctionRecipe;
    if (recipe.entity !== input.entity || recipe.field !== input.field)
      return unsupported("hash_mismatch");
    const canonicalKey = await fieldCorrectionIdentity(recipe);
    return canonicalKey === storedKey
      ? { storedKey, canonicalKey, reason: null }
      : unsupported("hash_mismatch");
  }
  if (evidence.data?.basis === undefined || !evidence.data.inputs?.length)
    return unsupported("missing_inputs");
  const dependencies =
    evidence.data.dependencies ??
    dependencyStamps(input.manifest, [
      ...fieldDependencyKeys(input.entity, input.field),
      ...evidence.data.inputs.map((call) => call.feature),
    ]);
  const recipe = {
    ...input,
    basis: evidence.data.basis,
    inputs: evidence.data.inputs,
    dependencies,
  };
  if (
    (await rawFieldCorrectionIdentity(identityInput.parse(recipe))) !==
    storedKey
  )
    return unsupported("hash_mismatch");
  return {
    storedKey,
    canonicalKey: await fieldCorrectionIdentity(recipe),
    reason: null,
  };
}

/** Match actual served evidence and the exact proposal across inference entry points. */
export async function fieldReviewIdentity(input: {
  entity: string;
  recordId: string | null;
  field: string;
  currentValue: unknown;
  proposal:
    | Pick<FieldSuggestion, "value" | "operation" | "removals">
    | null
    | undefined;
  model: string | null;
  inputs: CapturedInput[];
  dependencies: AiProvenance["dependencies"];
}) {
  const inputs = input.inputs.filter(
    (call) =>
      call.operation === `suggestFields.${input.entity}.${input.field}` &&
      call.model === input.model,
  );
  if (!input.proposal || !inputs.length) return null;
  return sha256Hex(
    canonicalJson(
      z.json().parse({
        entity: input.entity,
        recordId: input.recordId,
        field: input.field,
        inputs,
        dependencies: input.dependencies,
        candidate: {
          value: input.proposal.value,
          operation: input.proposal.operation,
          kind:
            input.proposal.operation === "remove"
              ? "prune"
              : input.currentValue == null || input.currentValue === ""
                ? "addition"
                : "correction",
          removals: input.proposal.removals.map((row) => row.value).sort(),
        },
      }),
    ),
  );
}
