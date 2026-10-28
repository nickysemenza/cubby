import { z } from "zod";

import { entityFieldModels } from "./entity-fields";
import type { ShortcodeEntity } from "./entity-manifest";
import { basisValueOf, fieldSuggestionContextKeys } from "./field-suggestion";

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
