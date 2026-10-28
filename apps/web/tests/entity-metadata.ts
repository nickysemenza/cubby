import { entityKeys } from "@cubby/schemas/entity-roster";
import { QueryClient } from "@tanstack/react-query";

import { entityMetadataQueryOptions } from "~/entity/metadata";
import { loadEntityMetadata } from "~/server/entity-metadata/loader.server";

/** Compiler declarations only: no household records, database, or HTTP request. */
export async function metadataQueryClient() {
  const queryClient = new QueryClient();
  await Promise.all(
    entityKeys.map(async (entity) => {
      const { primary } = await loadEntityMetadata(entity);
      queryClient.setQueryData(
        entityMetadataQueryOptions(entity).queryKey,
        primary,
      );
    }),
  );
  return queryClient;
}
