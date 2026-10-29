import type { Entity } from "@cubby/schemas/entity";
import { ENTITY_KEYS } from "@cubby/shared/entity-keys";

import type { EntityMetadataSlice } from "~/entity/model/metadata-types";

import { immutableMetadataSchema } from "./immutable-slice";

type MetadataModule = { metadata: EntityMetadataSlice };
const modules = import.meta.glob<MetadataModule>(
  "../../../../../packages/schemas/src/generated/entity-metadata.*.gen.ts",
);
// SAFETY: the generated metadata modules use exactly the declaration key roster.
export const entityMetadataLoaders = Object.fromEntries(
  ENTITY_KEYS.map((entity) => [
    entity,
    async () => {
      const loader =
        modules[
          `../../../../../packages/schemas/src/generated/entity-metadata.${entity}.gen.ts`
        ];
      if (!loader) throw new Error(`No metadata module for ${entity}`);
      const { metadata } = await loader();
      return immutableMetadataSchema(metadata).parse(metadata);
    },
  ]),
) as Record<Entity, () => Promise<EntityMetadataSlice>>;
