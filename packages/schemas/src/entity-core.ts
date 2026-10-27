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
