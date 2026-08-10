/**
 * Shared removal machinery — the tail every non-merge removal path runs after
 * its own row-removal statements. See `core.ts` for why the embedding cascade
 * and the delete audit entries are one call.
 */

export type { RemovableEntity } from "./core";
export { cascadeRemoval } from "./core";
