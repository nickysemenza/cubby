import { z } from "zod";

import { entityFieldModels } from "./entity-fields";
import type { ShortcodeEntity } from "./entity-manifest";

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
