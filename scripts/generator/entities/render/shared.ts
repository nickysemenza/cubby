import type { CompiledEntity } from "../declarations.ts";

/**
 * Entities the kernel can execute directly: a bound repository port, plus
 * `image` (which the kernel always handles even without one). Shared by
 * every kernel-facing artifact — the roster, capability/action metadata, and
 * the runtime binding module — so they stay correlated on one filter instead
 * of each recomputing (and risking drift on) their own entity subset.
 */
export const kernelEntitiesFor = (
  entities: readonly CompiledEntity[],
): readonly CompiledEntity[] =>
  entities.filter(
    ({ contract, key, ports }) =>
      (contract !== null && ports.repository !== null) || key === "image",
  );
