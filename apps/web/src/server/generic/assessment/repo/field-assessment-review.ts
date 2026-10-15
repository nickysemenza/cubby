import type { FieldSuggestion } from "@cubby/schemas/ai";
import type { AiProvenance } from "@cubby/schemas/ai-evaluation";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { CapturedInput } from "~/server/ai/evaluation-inputs";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";

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
