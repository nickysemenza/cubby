import type { Entity } from "@cubby/schemas/entity";
import { ENTITY_KEYS } from "@cubby/shared/entity-keys";

import { freezeMetadata } from "~/entity/immutable-metadata";
import type { EntityMetadataSlice } from "~/entity/model/metadata-types";

type MetadataModule = { metadata: EntityMetadataSlice };
// A relative template import, not `import.meta.glob`: Playwright fixtures load
// this module under Node, and Vite still splits one chunk per entity.
// SAFETY: the generated metadata modules use exactly the declaration key roster.
export const publicEntityMetadataLoaders = Object.fromEntries(
  ENTITY_KEYS.map((entity) => [
    entity,
    async () => {
      const { metadata }: MetadataModule = await import(
        `../../../../packages/schemas/src/generated/entity-metadata.${entity}.gen.ts`
      );
      return freezeMetadata(metadata);
    },
  ]),
) as Record<Entity, () => Promise<EntityMetadataSlice>>;

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
