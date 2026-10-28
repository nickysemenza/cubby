import type { Entity } from "@cubby/schemas/entity";
import type { StructuredValueSchema } from "@cubby/schemas/structured-value-schema";
import type { QueryClient } from "@tanstack/react-query";

import { entityMetadata } from "~/entity/metadata";

/** Only the requested entity's serialized structured schemas enter an editor. */
export const structuredSchemaFor = (
  queryClient: QueryClient,
  entity: Entity,
  field: string,
): StructuredValueSchema | undefined =>
  Object.entries(entityMetadata(queryClient, entity).structuredSchemas).find(
    ([key]) => key === field,
  )?.[1];
