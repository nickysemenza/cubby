import { entitySchema, type Entity } from "@cubby/schemas/entity";
import {
  queryOptions,
  type QueryClient,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";

import type {
  EntityMetadataSlice,
  EntityMetadataByEntity,
} from "~/entity/generated/entity-metadata-types.gen";

const readEntityMetadata = createServerFn({ method: "GET" })
  .validator(entitySchema)
  .handler(async ({ data }) => {
    const { loadEntityMetadata } =
      await import("~/server/entity-metadata/read.boundary");
    return loadEntityMetadata(data);
  });

const metadataKey = (entity: Entity) => ["entity-metadata", entity] as const;
export type EntityMetadataFor<E extends Entity> = EntityMetadataByEntity[E];

/** Metadata belongs to this document's QueryClient, just like its SSR data.
 * One route read installs its direct dependencies before compilation starts. */
export const entityMetadataQueryOptions = (entity: Entity) =>
  queryOptions({
    queryKey: metadataKey(entity),
    queryFn: async ({ client }) => {
      const { primary, dependencies } = await readEntityMetadata({
        data: entity,
      });
      for (const dependency of dependencies) {
        client.setQueryDefaults(metadataKey(dependency.entity), {
          staleTime: Infinity,
          gcTime: Infinity,
        });
        client.setQueryData(metadataKey(dependency.entity), dependency);
      }
      return primary;
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });

const metadataWithDependencies = (queryClient: QueryClient, entity: Entity) => {
  const primary = queryClient.getQueryData(
    entityMetadataQueryOptions(entity).queryKey,
  );
  if (primary?.entity !== entity) return undefined;
  return primary.dependencies.every(
    (dependency) =>
      queryClient.getQueryData(entityMetadataQueryOptions(dependency).queryKey)
        ?.entity === dependency,
  )
    ? primary
    : undefined;
};

// A cached dependency is a slice, not proof that its own direct dependencies
// have been admitted. Keep that completion bit separate from slice storage.
const metadataAdmissionOptions = (queryClient: QueryClient, entity: Entity) =>
  queryOptions({
    queryKey: ["entity-metadata-admission", entity],
    initialData: () =>
      metadataWithDependencies(queryClient, entity) ? true : undefined,
    queryFn: async () => {
      if (!metadataWithDependencies(queryClient, entity))
        await queryClient.fetchQuery({
          ...entityMetadataQueryOptions(entity),
          staleTime: 0,
        });
      if (!metadataWithDependencies(queryClient, entity))
        throw new Error(
          `Metadata dependencies for ${entity} were not admitted`,
        );
      return true;
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });

export async function ensureEntityMetadata(
  queryClient: QueryClient,
  entity: Entity,
) {
  await queryClient.ensureQueryData(
    metadataAdmissionOptions(queryClient, entity),
  );
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
  const metadata = queryClient.getQueryData(
    entityMetadataQueryOptions(entity).queryKey,
  );
  if (!metadata || metadata.entity !== entity)
    throw new Error(`Metadata for ${entity} must be loaded before use`);
  return metadata;
}

export function useEntityMetadata<E extends Entity>(
  entity: E,
): EntityMetadataFor<E> {
  const queryClient = useQueryClient();
  useSuspenseQuery(metadataAdmissionOptions(queryClient, entity));
  return entityMetadata(queryClient, entity);
}
