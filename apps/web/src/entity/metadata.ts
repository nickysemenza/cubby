import type { Entity } from "@cubby/schemas/entity";
import {
  queryOptions,
  type QueryClient,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";

import type {
  EntityMetadataSlice,
  EntityMetadataByEntity,
} from "~/entity/generated/entity-metadata-types.gen";
import { loadBrowserEntityMetadata } from "~/entity/metadata-loader";

const readEntityMetadata = createIsomorphicFn()
  .server(async (entity: Entity) => {
    const { loadEntityMetadata } =
      await import("~/server/entity-metadata/read.boundary");
    return loadEntityMetadata(entity);
  })
  .client(loadBrowserEntityMetadata);

const metadataKey = (entity: Entity) => ["entity-metadata", entity] as const;
export type EntityMetadataFor<E extends Entity> = EntityMetadataByEntity[E];
type MetadataBundle = Awaited<ReturnType<typeof readEntityMetadata>>;

/** Metadata belongs to this document's QueryClient, just like its SSR data.
 * Complete bundles stay query data; the router transports only their admission
 * identities and restores the same bundles from immutable public chunks. */
export const entityMetadataQueryOptions = (entity: Entity) =>
  queryOptions({
    queryKey: metadataKey(entity),
    queryFn: () => readEntityMetadata(entity),
    staleTime: Infinity,
    gcTime: Infinity,
  });

export async function ensureEntityMetadata(
  queryClient: QueryClient,
  entity: Entity,
) {
  // A dependency slice alone never proves its own dependencies are present.
  await queryClient.ensureQueryData(entityMetadataQueryOptions(entity));
  return entityMetadata(queryClient, entity);
}

/** Loaders admit metadata before synchronous filter/editor compilation. */
export function entityMetadata<E extends Entity>(
  queryClient: QueryClient,
  entity: E,
): EntityMetadataFor<E>;
export function entityMetadata(
  queryClient: QueryClient,
  entity: Entity,
): EntityMetadataSlice {
  const bundle = queryClient.getQueryData(
    entityMetadataQueryOptions(entity).queryKey,
  );
  if (bundle?.primary.entity === entity) return bundle.primary;
  // Only bundles explicitly admitted to this document participate; this never
  // imports or hydrates the entity catalog or follows dependencies recursively.
  for (const [, admitted] of queryClient.getQueriesData<MetadataBundle>({
    queryKey: ["entity-metadata"],
  })) {
    const dependency = admitted?.dependencies.find(
      (slice) => slice.entity === entity,
    );
    if (dependency) return dependency;
  }
  throw new Error(`Metadata for ${entity} must be loaded before use`);
}

export function useEntityMetadata<E extends Entity>(
  entity: E,
): EntityMetadataFor<E> {
  const queryClient = useQueryClient();
  useSuspenseQuery(entityMetadataQueryOptions(entity));
  return entityMetadata(queryClient, entity);
}
