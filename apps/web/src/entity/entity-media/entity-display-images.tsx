import { entityRefKey, type EntityRef } from "@cubby/schemas/entity";
import {
  ID_CHUNK_SIZE,
  type EntityDisplayImagesOutput,
} from "@cubby/schemas/entity-media";
import type { ImageUrlSummary } from "@cubby/schemas/image-summary";
import { useQueries } from "@tanstack/react-query";
import { chunk } from "es-toolkit";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { entityMedia } from "~/integrations/tanstack-query/generated/catalog/entityMedia.gen";

export type EntityDisplayImageMap = EntityDisplayImagesOutput;
export type EntityDisplayImagesQueryOptions =
  typeof entityMedia.displayImages.queryOptions;

const CoveredImageRefsContext = createContext<ReadonlySet<string>>(new Set());
const RegisterImageRefContext = createContext<
  ((ref: EntityRef) => () => void) | null
>(null);

const EMPTY_IMAGES: EntityDisplayImageMap = {};
const EntityDisplayImagesContext =
  createContext<EntityDisplayImageMap>(EMPTY_IMAGES);

export const entityDisplayImageKey = (ref: EntityRef): string =>
  entityRefKey(ref.entityKind, ref.entityId);

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
  collectMountedRefs = false,
}: {
  /** App-level fallback; explicit collection refs keep their own batch owner. */
  collectMountedRefs?: boolean;
  refs: readonly EntityRef[];
  seeded?: EntityDisplayImageMap;
  queryOptions?: EntityDisplayImagesQueryOptions;
  children: ReactNode;
}) {
  const inherited = useContext(EntityDisplayImagesContext);
  const inheritedCovered = useContext(CoveredImageRefsContext);
  const [mounted, setMounted] = useState<
    ReadonlyMap<string, { ref: EntityRef; count: number }>
  >(new Map());
  const register = useCallback((ref: EntityRef) => {
    const key = entityDisplayImageKey(ref);
    setMounted((current) =>
      new Map(current).set(key, {
        ref,
        count: (current.get(key)?.count ?? 0) + 1,
      }),
    );
    return () =>
      setMounted((current) => {
        const next = new Map(current);
        const entry = next.get(key);
        if (entry && entry.count > 1)
          next.set(key, { ...entry, count: entry.count - 1 });
        else next.delete(key);
        return next;
      });
  }, []);
  const coveredKey = [
    ...refs.map(entityDisplayImageKey),
    ...Object.keys(seeded ?? EMPTY_IMAGES),
  ]
    .sort()
    .join(",");
  const covered = useMemo(
    () =>
      new Set([...inheritedCovered, ...coveredKey.split(",").filter(Boolean)]),
    [inheritedCovered, coveredKey],
  );
  const combinedSeeded = useMemo(
    () => ({ ...inherited, ...(seeded ?? EMPTY_IMAGES) }),
    [inherited, seeded],
  );
  const images = useEntityDisplayImages(
    collectMountedRefs
      ? [...refs, ...Array.from(mounted.values(), (entry) => entry.ref)]
      : refs,
    combinedSeeded,
    queryOptions,
  );
  const content = (
    <CoveredImageRefsContext.Provider value={covered}>
      <EntityDisplayImagesContext.Provider value={images}>
        {children}
      </EntityDisplayImagesContext.Provider>
    </CoveredImageRefsContext.Provider>
  );
  return collectMountedRefs ? (
    <RegisterImageRefContext.Provider value={register}>
      {content}
    </RegisterImageRefContext.Provider>
  ) : (
    content
  );
}

export function useEntityDisplayImage(
  ref: EntityRef,
  seeded?: ImageUrlSummary | null,
): ImageUrlSummary | null {
  const register = useContext(RegisterImageRefContext);
  const covered = useContext(CoveredImageRefsContext).has(
    entityDisplayImageKey(ref),
  );
  const { entityKind, entityId } = ref;
  // Collection owners declare their complete batch; only otherwise-uncovered
  // mounted references join the shell batch. No pill owns a network query.
  useEffect(() => {
    if (!covered && seeded === undefined)
      return register?.({ entityKind, entityId });
  }, [register, covered, entityKind, entityId, seeded]);
  const images = useContext(EntityDisplayImagesContext);
  const key = entityDisplayImageKey(ref);
  return Object.hasOwn(images, key) ? (images[key] ?? null) : (seeded ?? null);
}

export function useEntityDisplayImageMap(): EntityDisplayImageMap {
  return useContext(EntityDisplayImagesContext);
}
