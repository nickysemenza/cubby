import type { EntityBrowserMutationResult } from "~/server/entity-kernel/contracts";

type EntityDeleteResult = Extract<
  EntityBrowserMutationResult,
  { action: "delete" }
>;

/** Counts the command entity only; cascaded cross-entity references stay detail. */
export function countPrimaryDeletedReferences(result: EntityDeleteResult) {
  return result.deletedReferences.filter(
    (reference) => reference.entity === result.entity,
  ).length;
}
