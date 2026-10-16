import { generatedEntityListFields } from "@cubby/schemas/entity-list-fields";

/** Depth cap shared by every recursive walk over the location tree. */
export const MAX_TREE_DEPTH =
  generatedEntityListFields.location.hierarchy.maxDepth;
