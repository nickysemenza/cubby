import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";

/**
 * Depth cap of the location tree's display walks. List filters and level
 * grouping walk the whole tree, bounded only by a cycle guard.
 */
export const MAX_TREE_DEPTH =
  generatedEntityListFields.location.hierarchy.maxDepth;
