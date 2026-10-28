import { z } from "zod";
import { ENTITY_KEYS } from "@cubby/shared/entity-keys";

/**
 * The closed entity vocabulary, from the generated roster of declarations.
 * `ENTITY_KEYS` is emitted before declarations load and is a bare `as const` tuple with no `Entity` constraint, so it
 * can be the leaf every other generated roster (all `satisfies
 * Record<Entity, …>`) derives from without a circular initializer.
 */
export const entitySchema = z.enum(ENTITY_KEYS);
export type Entity = z.infer<typeof entitySchema>;

export const entityRefFields = {
  entityKind: entitySchema,
  entityId: z.string(),
};

/**
 * General/public reference shape. `entityId` is intentionally a string: it can
 * carry a public shortcode and the roster includes non-local `usda-food`.
 * Internal UUID-only references use the correlated `EntityRef` from
 * `@cubby/schemas/identifiers` instead.
 */
export const entityRefSchema = z.object(entityRefFields);
export type EntityRef = z.infer<typeof entityRefSchema>;
