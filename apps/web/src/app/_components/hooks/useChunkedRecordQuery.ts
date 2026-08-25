import { useQueries } from "@tanstack/react-query";
import { chunk, uniq } from "es-toolkit";
import { useMemo } from "react";
import { ID_CHUNK_SIZE } from "~/misc/array-helpers";

const uniqueSortedIds = (ids: readonly string[]) =>
  uniq(ids.filter(Boolean)).sort();

export function useChunkedRecordQuery<TRecord extends Record<string, unknown>>({
  ids,
  empty,
  queryOptions,
}: {
  ids: readonly string[];
  empty: TRecord;
  // Transport queryOptions carry specialized error/query-key generics that don't
  // reduce cleanly to React Query's public UseQueryOptions type.
  // biome-ignore lint/suspicious/noExplicitAny: intentional queryOptions boundary
  queryOptions: (ids: string[]) => any;
}): TRecord {
  const idsKey = useMemo(() => uniqueSortedIds(ids).join(","), [ids]);
  const sortedIds = useMemo(() => (idsKey ? idsKey.split(",") : []), [idsKey]);
  const idChunks = useMemo(() => chunk(sortedIds, ID_CHUNK_SIZE), [sortedIds]);

  return useQueries({
    queries: idChunks.map((chunkIds) => {
      const options = queryOptions(chunkIds);
      return options.enabled === undefined
        ? { ...options, enabled: chunkIds.length > 0 }
        : options;
    }),
    combine: (results) => {
      if (results.every((result) => !result.data)) {
        return empty;
      }

      return Object.assign(
        {},
        ...results.map((result) => result.data ?? empty),
      ) as TRecord;
    },
  });
}
