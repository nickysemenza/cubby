import type { Entity } from "@cubby/schemas/entity";

import { entityMetadataLoaders } from "~/server/generated/entity-metadata-loaders.gen";

/** Only the route entity and its directly declared relations cross this read.
 * Dependencies are deliberately not traversed transitively into a catalog. */
export async function loadEntityMetadata(entity: Entity) {
  const primary = await entityMetadataLoaders[entity]();
  const dependencies = await Promise.all(
    primary.dependencies.map((dependency) =>
      entityMetadataLoaders[dependency](),
    ),
  );
  return { primary, dependencies };
}
