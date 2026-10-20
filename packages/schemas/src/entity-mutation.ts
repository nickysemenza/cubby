import { z } from "zod";
import type { ShortcodeEntity } from "./entity-manifest";
import { shortcodeSchema } from "./identifiers";

/** Canonical saved scalars only; expanded records are a separate read. */
export const entityMutationItem = z
  .object({ id: z.string() })
  .catchall(z.json());
export const entityMutationAppliedFields = z.array(z.string());

export function entityMutationItemFor<E extends ShortcodeEntity>(entity: E) {
  return entityMutationItem.extend({ id: shortcodeSchema(entity) });
}
