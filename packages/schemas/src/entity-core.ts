import { z } from "zod";
import { entityKeys } from "./generated/entity-summary.gen";

/**
 * The closed entity vocabulary, from the generated roster of declarations.
 * `entityKeys` is a bare `as const` tuple with no `Entity` constraint, so it
 * can be the leaf every other generated roster (all `satisfies
 * Record<Entity, …>`) derives from without a circular initializer.
 */
export const entitySchema = z.enum(entityKeys);
export type Entity = z.infer<typeof entitySchema>;
