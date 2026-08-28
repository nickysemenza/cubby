import {
  type QueryKey,
  type UseQueryOptions,
  useQueries,
} from "@tanstack/react-query";
import { chunk, uniq } from "es-toolkit";
import { useMemo } from "react";

import { ID_CHUNK_SIZE } from "~/misc/array-helpers";

const uniqueSortedIds = (ids: readonly string[]) =>
  uniq(ids.filter(Boolean)).sort();

export function useChunkedRecordQuery<
  TRecord extends object,
  TQueryResult,
  TKey extends QueryKey,
>({
  ids,
  empty,
  queryOptions,
}: {
  ids: readonly string[];
  empty: TRecord;
  queryOptions: (
    ids: string[],
  ) => UseQueryOptions<TQueryResult, Error, TRecord, TKey>;
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
    combine: (results): TRecord => {
      if (results.every((result) => !result.data)) {
        return empty;
      }

      const combined: TRecord = { ...empty };
      for (const result of results) {
        if (result.data) Object.assign(combined, result.data);
      }
      return combined;
    },
  });
}
