import { z } from "zod";

import { entityFieldModels } from "./entity-fields";
import type { ShortcodeEntity } from "./entity-manifest";
import {
  fieldEnvelope,
  fieldAssignment,
  fieldDecision,
  fieldProvenance,
} from "./field-envelope";

const INHERITANCE_CONTEXT_KEYS = {
  expense: ["lineKind", "purchaseId", "productId", "projectId", "trade"],
  task: [
    "parentTaskId",
    "projectId",
    "projectMode",
    "subjectProductId",
    "subjectProductMode",
    "trade",
  ],
} as const;

/** Runtime context is shared by live forms and canonical background preparation. */
export function fieldSuggestionContextKeys(
  entity: string,
  basisKeys: readonly string[],
): readonly string[] {
  const inherited =
    entity === "expense"
      ? INHERITANCE_CONTEXT_KEYS.expense
      : entity === "task"
        ? INHERITANCE_CONTEXT_KEYS.task
        : [];
  const finance =
    entity === "financialTransaction"
      ? ["purchaseId", "spendingCategoryId", "itemizationExpectation"]
      : entity === "purchase"
        ? ["vendorId", "spendingCategoryId", "itemizationExpectation"]
        : [];
  return [...new Set([...basisKeys, ...inherited, ...finance])];
}

/** Suggestion evidence excludes refresh timing, work and presentation controls. */
export const fieldSuggestionResolutionEvidence = z.object({
  current: z.object({ assignment: fieldAssignment(z.json()).nullable() }),
  decision: z
    .object({
      outcome: fieldDecision(z.json()).shape.outcome,
      provenanceKind: z
        .enum(fieldProvenance.options.map((option) => option.shape.kind.value))
        .nullable(),
    })
    .nullable(),
});
export type FieldSuggestionResolutionEvidence = z.output<
  typeof fieldSuggestionResolutionEvidence
>;

export function fieldSuggestionResolutionContext(
  raw: unknown,
  keys: readonly string[],
): string | null {
  const parsed = z
    .record(z.string(), fieldEnvelope(z.unknown(), z.unknown()))
    .safeParse(raw);
  if (!parsed.success) return null;
  const selected = new Set(keys);
  const evidence = Object.fromEntries(
    Object.entries(parsed.data)
      .filter(([key]) => selected.has(key))
      .map(([key, envelope]) => {
        const decision =
          envelope.result.kind === "missing" ? null : envelope.result.decision;
        return [
          key,
          {
            current: { assignment: envelope.current.assignment },
            decision: decision
              ? {
                  outcome: decision.outcome,
                  provenanceKind: decision.provenance?.kind ?? null,
                }
              : null,
          },
        ];
      }),
  );
  // The JSON boundary normalizes Date-valued field inputs to their wire strings.
  return JSON.stringify(
    z
      .record(z.string(), fieldSuggestionResolutionEvidence)
      .parse(JSON.parse(JSON.stringify(evidence))),
  );
}

/** Only declared per-field inputs enter identity; presentation metadata is not evidence. */
export function fieldSuggestionIdentityBasis(
  entity: ShortcodeEntity,
  field: string,
  raw: unknown,
) {
  const definition = entityFieldModels[entity].fields.find(
    (candidate) => candidate.key === field,
  );
  const policy = definition?.control?.suggest;
  const parsed = z.record(z.string(), z.json()).safeParse(raw);
  if (!policy || !parsed.success) return null;
  return Object.fromEntries(
    fieldSuggestionContextKeys(entity, [...policy.basis, field]).map((key) => [
      key,
      basisValueOf(parsed.data[key]),
    ]),
  );
}

/** These questions read a dedicated saved finance/vendor context beyond their basis. */
export function usesSavedFieldSuggestionContext(entity: string): boolean {
  return ["financialTransaction", "purchase", "expense", "vendor"].includes(
    entity,
  );
}

/** Every automatic assignment path obeys the target's declared review policy. */
export function requiresSuggestionReview(
  entity: ShortcodeEntity,
  field: string,
): boolean {
  return Boolean(
    entityFieldModels[entity].fields.find((item) => item.key === field)?.control
      ?.suggest?.reviewRequired,
  );
}

const basisIdSchema = z.object({ id: z.string() });
const basisArraySchema = z.array(z.json());

/**
 * A basis value in the shape `ai.suggestFields` wants: a trimmed string, an
 * id pulled off a picker's `{ id }` value (`ComboboxItem`-shaped or a raw
 * `{id}`), a JSON-encoded array (a text-array field's current entries — a
 * prune target's own self-basis, or a sibling array field like `aliases`),
 * a JSON-encoded owned object or structured history, or `null` when the value carries nothing usable.
 */
export function basisValueOf(value: unknown): string | null {
  const text = z.string().safeParse(value);
  if (text.success) {
    const trimmed = text.data.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const withId = basisIdSchema.safeParse(value);
  if (withId.success) {
    const trimmed = withId.data.id.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const array = basisArraySchema.safeParse(value);
  if (array.success) return JSON.stringify(array.data);
  const object = z.record(z.string(), z.json()).safeParse(value);
  if (object.success) return JSON.stringify(object.data);
  return null;
}
