/**
 * Shared removal machinery, in two depths:
 *
 *  - `removeEntity` (`entity.ts`) — the whole write half of a delete: children,
 *    the entity's own rows, then the tail. What most delete paths want.
 *  - `cascadeRemoval` (`core.ts`) — the tail alone, for the paths that must
 *    interleave their own statements with it. See `core.ts` for why the
 *    embedding cascade and the delete audit entries are one call.
 */

export type { RemovableEntity } from "./core";
export { cascadeRemoval } from "./core";
export { executeDeleteWithEffects } from "./delete-effects";
export type { ChildCascade } from "./entity";
export {
  applyMergePolicy,
  deleteByPolicy,
  type DeleteHooks,
  policyDelete,
} from "./dispositions";
