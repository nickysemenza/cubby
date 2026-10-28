import type { Entity } from "@cubby/schemas/entity";

import { publicEntityMetadataLoaders } from "~/entity/generated/entity-metadata-loaders.gen";

/** Only the admitted primary and its direct dependencies enter this bundle. */
export async function loadBrowserEntityMetadata(entity: Entity) {
  const primary = await publicEntityMetadataLoaders[entity]();
  const dependencies = await Promise.all(
    primary.dependencies.map((dependency) =>
      publicEntityMetadataLoaders[dependency](),
    ),
  );
  return { primary, dependencies };
}
