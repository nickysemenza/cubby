import type { ListNesting } from "@cubby/schemas/pagination";
import {
  type QueryClient,
  type QueryKey,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";

import { type EntityListParams, entityListFor } from "~/entity/entity-list";
import type { ListEntity } from "~/entity/generated/entity-lists.gen";

import type { EntityListRecord } from "./useAllEntityRecords";
import { useHydratedLoading } from "./useHydrated";
import {
  type ServerTreeRow,
  serverTreeChildCount,
} from "./useServerTreeChildren";

const TREE_PAGE_SIZE = 500;

/** Every row of one nesting scope, page by page until the server's total. */
async function readScope<E extends ListEntity>(
  queryClient: QueryClient,
  entity: E,
  input: EntityListParams<E>,
  nesting: ListNesting,
): Promise<EntityListRecord<E>[]> {
  const list = entityListFor(entity);
  const rows: EntityListRecord<E>[] = [];
  for (let pageIndex = 0; ; pageIndex++) {
    const page = await queryClient.fetchQuery(
      list.queryOptions({
        ...input,
        nesting,
        pagination: { pageIndex, pageSize: TREE_PAGE_SIZE },
      }),
    );
    // SAFETY: entityListFor(entity) parses every page with entity E's list
    // output schema; TS cannot resolve the indexed type through generic E.
    rows.push(...(page.items as EntityListRecord<E>[]));
    if (page.items.length === 0 || rows.length >= page.meta.totalCount)
      return rows;
  }
}

type ScopeResult<E extends ListEntity> = {
  data?: EntityListRecord<E>[];
  error: Error | null;
  refetch: () => Promise<object>;
};

/**
 * A tree entity's complete hierarchy as the server nests it: the `roots`
 * scope, then the `children` scope of every row the server counts children
 * for, level by level (the transport batches each level's reads). Each node
 * sits under the parent it was read for; the browser never nests rows by
 * their parent field. `input` carries the filters and sort, as in the list.
 */
export function useServerTree<E extends ListEntity>(
  entity: E,
  input: EntityListParams<E>,
) {
  const queryClient = useQueryClient();
  const scopeKey = entityListFor(entity).queryKey(input);
  const keyFor = (parentId: string | null): QueryKey => [
    ...scopeKey,
    "__server_tree__",
    parentId,
  ];

  // Discover parents breadth-first through the reads that have landed: a
  // loaded row the server counts children for adds that parent's read.
  const parentIds: string[] = [];
  const queue = [
    queryClient.getQueryData<EntityListRecord<E>[]>(keyFor(null)) ?? [],
  ];
  for (let rows = queue.shift(); rows; rows = queue.shift())
    for (const row of rows) {
      if (serverTreeChildCount(row) === 0) continue;
      parentIds.push(row.id);
      const nested = queryClient.getQueryData<EntityListRecord<E>[]>(
        keyFor(row.id),
      );
      if (nested) queue.push(nested);
    }
  const parentsKey = parentIds.join("\n");

  const combine = useCallback(
    (results: ScopeResult<E>[]) => {
      const parents = parentsKey ? parentsKey.split("\n") : [];
      const children = new Map<string, EntityListRecord<E>[]>();
      parents.forEach((parentId, index) => {
        const rows = results[index + 1]?.data;
        if (rows) children.set(parentId, rows);
      });
      const visit = (
        rows: readonly EntityListRecord<E>[],
      ): ServerTreeRow<EntityListRecord<E>>[] =>
        rows.map((row) => {
          const nested = children.get(row.id);
          return nested ? { ...row, subRows: visit(nested) } : row;
        });
      const roots = results[0]?.data;
      const failed = results.filter((result) => result.error);
      const pending = results.some((result) => !result.data && !result.error);
      return {
        tree: roots && !pending ? visit(roots) : null,
        pending,
        error: failed[0]?.error ?? null,
        retry: () => {
          for (const result of failed) void result.refetch();
        },
      };
    },
    [parentsKey],
  );
  const { tree, pending, error, retry } = useQueries({
    queries: [null, ...parentIds].map((parentId) => ({
      queryKey: keyFor(parentId),
      queryFn: () =>
        readScope(
          queryClient,
          entity,
          input,
          parentId === null
            ? { scope: "roots" }
            : { scope: "children", parentId },
        ),
    })),
    combine,
  });
  return {
    /** The roots with every child nested, once every read has landed. */
    tree,
    isLoading: useHydratedLoading(pending && !error),
    error,
    refetch: retry,
  };
}
