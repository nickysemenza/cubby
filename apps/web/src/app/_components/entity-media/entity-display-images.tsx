import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import type { EntityDisplayImagesOutput } from "@cubby/schemas/entity-media";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { useQueries } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import { createContext, type ReactNode, useContext, useMemo } from "react";

import { entityMedia } from "~/entities/entity-media.functions";
import { ID_CHUNK_SIZE } from "~/misc/array-helpers";

export type EntityDisplayImageMap = EntityDisplayImagesOutput;
export type EntityDisplayImagesQueryOptions =
  typeof entityMedia.displayImages.queryOptions;

const EMPTY_IMAGES: EntityDisplayImageMap = {};
const EntityDisplayImagesContext =
  createContext<EntityDisplayImageMap>(EMPTY_IMAGES);

export const entityDisplayImageKey = (ref: EntityRef): string =>
  entityRefKey(ref.entityType, ref.entityId);

const stableRefs = (refs: readonly EntityRef[]) =>
  [
    ...new Map(refs.map((ref) => [entityDisplayImageKey(ref), ref])).values(),
  ].sort((left, right) =>
    entityDisplayImageKey(left).localeCompare(entityDisplayImageKey(right)),
  );

/**
 * Resolve only absent entries. A seeded `null` is authoritative: callers that
 * already know a record has no cover must not spend another request proving it.
 */
export function useEntityDisplayImages(
  refs: readonly EntityRef[],
  seeded: EntityDisplayImageMap = EMPTY_IMAGES,
  queryOptions: EntityDisplayImagesQueryOptions = (input) =>
    entityMedia.displayImages.queryOptions(input),
): EntityDisplayImageMap {
  // Do not make a caller's freshly mapped ref array a hook dependency. The
  // canonical key is stable for the same logical collection.
  const refsKey = stableRefs(refs).map(entityDisplayImageKey).join(",");
  const normalizedRefs = useMemo(
    () => (refsKey ? stableRefs(refs) : []),
    // `refsKey` changes whenever a resolved ref changes; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refsKey],
  );
  const unresolvedRefs = useMemo(
    () =>
      normalizedRefs.filter(
        (ref) => !Object.hasOwn(seeded, entityDisplayImageKey(ref)),
      ),
    [normalizedRefs, seeded],
  );
  const chunks = useMemo(
    () => chunk(unresolvedRefs, ID_CHUNK_SIZE),
    [unresolvedRefs],
  );

  return useQueries({
    queries: chunks.map((refsChunk) => ({
      ...queryOptions({ refs: refsChunk }),
      enabled: refsChunk.length > 0,
    })),
    combine: (results) => {
      const images: EntityDisplayImageMap = { ...seeded };
      for (const result of results) {
        if (result.data) Object.assign(images, result.data);
      }
      return images;
    },
  });
}

export function EntityDisplayImagesProvider({
  refs,
  seeded,
  queryOptions,
  children,
}: {
  refs: readonly EntityRef[];
  seeded?: EntityDisplayImageMap;
  queryOptions?: EntityDisplayImagesQueryOptions;
  children: ReactNode;
}) {
  const inherited = useContext(EntityDisplayImagesContext);
  const combinedSeeded = useMemo(
    () => ({ ...inherited, ...(seeded ?? EMPTY_IMAGES) }),
    [inherited, seeded],
  );
  const images = useEntityDisplayImages(refs, combinedSeeded, queryOptions);
  return (
    <EntityDisplayImagesContext.Provider value={images}>
      {children}
    </EntityDisplayImagesContext.Provider>
  );
}

export function useEntityDisplayImage(ref: EntityRef): ImageUrlSummary | null {
  return (
    useContext(EntityDisplayImagesContext)[entityDisplayImageKey(ref)] ?? null
  );
}

export function useEntityDisplayImageMap(): EntityDisplayImageMap {
  return useContext(EntityDisplayImagesContext);
}
