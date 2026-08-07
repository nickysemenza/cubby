/**
 * Shared merge machinery — the mechanics every entity merge runs underneath its
 * own public contract. See `core.ts` for why the contracts stay divergent and
 * why `finalizeMerge` is the piece that matters.
 */

export { foldAssociation, planSlotCollisions } from "./collisions";
export { finalizeMerge, repointEdge, resolveMergeTargets } from "./core";
