import {
  LIST_BATCH_COMMAND_LIMIT,
  type ListBatch,
  type ListNesting,
} from "@cubby/schemas/pagination";
import { useQueries, type QueryFunctionContext } from "@tanstack/react-query";
import type { ExpandedState, OnChangeFn, RowData } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";

import type {
  ListQueryPlan,
  ListQueryResponse,
} from "../table/use-paginated-table-core";
import type { ScopedPlanNarrowing } from "./use-infinite-table-list";

export type ServerTreeRow<T> = T & { subRows?: ServerTreeRow<T>[] };

const childCountSchema = z.object({
  childCount: z.number().int().nonnegative().optional(),
});

/** The server's count of a row's children that match the list's filters. */
export const serverTreeChildCount = (row: unknown): number =>
  childCountSchema.safeParse(row).data?.childCount ?? 0;

/** A row the server says has children that match the list's filters. */
export const serverTreeRowCanExpand = (row: unknown): boolean =>
  (childCountSchema.safeParse(row).data?.childCount ?? 0) > 0;

/** An expanded parent's children read, shown as one row after its children. */
export type ServerTreeChildStatus =
  | { kind: "loading" }
  | { kind: "error"; error: Error; retry: () => void }
  | {
      kind: "more";
      /** Matching children the loaded pages have not shown yet. */
      remaining?: number;
      loading: boolean;
      loadMore: () => void;
    };

// Status rows are registered by identity, so no record field can be
// mistaken for one.
const statusRows = new WeakMap<object, ServerTreeChildStatus>();

/**
 * The status a synthetic tree row carries, or undefined for a real record.
 * Renderers draw a status row in place of the record's cells, and selection
 * skips it.
 */
export const serverTreeStatusOf = (
  row: RowData,
): ServerTreeChildStatus | undefined =>
  typeof row === "object" && row !== null ? statusRows.get(row) : undefined;

/**
 * A folded batch of automatic siblings (`list.tree.batch`): the server's
 * rollup, drawn as one row whose expansion pages the batch's members.
 */
export type ServerTreeBatch = ListBatch & {
  /** The parent scope's expansion key, or null among roots. */
  scopeId: string | null;
};

// Batch rows are registered by identity like status rows.
const batchRows = new WeakMap<object, ServerTreeBatch>();

/** The batch a synthetic tree row stands for, or undefined for a record. */
export const serverTreeBatchOf = (row: RowData): ServerTreeBatch | undefined =>
  typeof row === "object" && row !== null ? batchRows.get(row) : undefined;

const BATCH_ID_PREFIX = "batch:";
const batchKeySchema = z.tuple([z.string().nullable(), z.string()]);

/** A batch row's id, unique beside record ids and stable across pages. */
export const serverTreeBatchId = (
  batch: Pick<ListBatch, "parentId" | "value">,
) => `${BATCH_ID_PREFIX}${JSON.stringify([batch.parentId, batch.value])}`;

function batchScopeOf(id: string): ListNesting | null {
  if (!id.startsWith(BATCH_ID_PREFIX)) return null;
  const parsed = batchKeySchema.safeParse(
    JSON.parse(id.slice(BATCH_ID_PREFIX.length)),
  );
  return parsed.success
    ? { scope: "batch", parentId: parsed.data[0], value: parsed.data[1] }
    : null;
}

const NO_PAGES: Readonly<Record<string, number>> = {};
const NO_EXPANDED: Readonly<Record<string, boolean>> = {};

type ChildResult<TData> = {
  data?: ListQueryResponse<TData>;
  error: Error | null;
  isPending: boolean;
  refetch: () => Promise<object>;
};

/**
 * A server-nested tree's lazily read children. The list pages its roots;
 * expanding a row reads the first page of that parent's `children` scope
 * through the same list query (same filters and sort), and its status row
 * offers the next page while more remain. Nothing is nested from loaded
 * pages: every child arrives under the parent the server read it for.
 * Expansion and child reads reset when `scope` (the filters and sort) changes.
 */
export function useServerTreeChildren<TData extends { id: string }>({
  enabled,
  batches = false,
  scope,
  planFor,
}: {
  enabled: boolean;
  /** The entity declares `list.tree.batch`: scopes fold automatic siblings. */
  batches?: boolean;
  /** Changes whenever the filters or sort change. */
  scope: string;
  planFor: (
    nesting: ListNesting,
    pageIndex: number,
    narrow?: ScopedPlanNarrowing,
  ) => ListQueryPlan<TData>;
}) {
  const [state, setState] = useState({
    scope,
    expanded: NO_EXPANDED,
    pages: NO_PAGES,
  });
  // Reset during render, not in an effect: the stale expansion must never
  // issue a children read under the new filters.
  if (state.scope !== scope)
    setState({ scope, expanded: NO_EXPANDED, pages: NO_PAGES });

  const expandedIds = useMemo(
    () =>
      enabled
        ? Object.entries(state.expanded).flatMap(([id, open]) =>
            open ? [id] : [],
          )
        : [],
    [enabled, state.expanded],
  );
  const requests = useMemo(
    () =>
      expandedIds.flatMap((parentId) =>
        Array.from({ length: state.pages[parentId] ?? 1 }, (_, pageIndex) => ({
          parentId,
          pageIndex,
          plan: planFor(
            batchScopeOf(parentId) ??
              (batches
                ? { scope: "children", parentId, batches: true }
                : { scope: "children", parentId }),
            pageIndex,
          ),
        })),
      ),
    [batches, expandedIds, planFor, state.pages],
  );
  const combine = useCallback((results: ChildResult<TData>[]) => results, []);
  const results = useQueries({
    queries: requests.map(({ plan }) => ({
      queryKey: [...plan.queryKey, "__tree_children__"],
      meta: plan.meta,
      queryFn: ({ signal, client, queryKey }: QueryFunctionContext) =>
        plan.execute(
          signal,
          client.getQueryState(queryKey)?.isInvalidated ? "strong" : undefined,
        ),
    })),
    combine,
  });

  const loadMore = useCallback(
    (parentId: string) =>
      setState((current) => ({
        ...current,
        pages: {
          ...current.pages,
          [parentId]: (current.pages[parentId] ?? 1) + 1,
        },
      })),
    [],
  );

  const childrenByParent = useMemo(() => {
    const byParent = new Map<
      string,
      {
        items: TData[];
        status?: ServerTreeChildStatus;
        batches?: readonly ListBatch[];
      }
    >();
    const pagesByParent = new Map<string, ChildResult<TData>[]>();
    requests.forEach(({ parentId }, index) => {
      const result = results[index];
      if (result)
        pagesByParent.set(parentId, [
          ...(pagesByParent.get(parentId) ?? []),
          result,
        ]);
    });
    for (const [parentId, pages] of pagesByParent) {
      const items = pages.flatMap((page) => page.data?.items ?? []);
      const failed = pages.filter((page) => page.error);
      const last = pages.at(-1);
      // Every page of one scope reports the same total.
      const meta = pages.find((page) => page.data)?.data?.meta;
      const remaining =
        meta?.totalCount === undefined
          ? undefined
          : meta.totalCount - items.length;
      const hasMore = last?.data?.meta.hasNextPage ?? false;
      const status: ServerTreeChildStatus | undefined =
        failed.length > 0
          ? {
              kind: "error",
              error:
                failed[0]?.error ?? new Error("Nested rows failed to load"),
              retry: () => {
                for (const page of failed) void page.refetch();
              },
            }
          : items.length === 0 && last?.isPending
            ? { kind: "loading" }
            : hasMore
              ? {
                  kind: "more",
                  remaining,
                  loading: Boolean(last?.isPending),
                  loadMore: () => loadMore(parentId),
                }
              : undefined;
      byParent.set(parentId, {
        items,
        ...(status ? { status } : {}),
        ...(meta?.batches ? { batches: meta.batches } : {}),
      });
    }
    return byParent;
  }, [loadMore, requests, results]);

  const onExpandedChange = useCallback<OnChangeFn<ExpandedState>>(
    (updater) =>
      setState((current) => {
        const next =
          typeof updater === "function" ? updater(current.expanded) : updater;
        // `true` (expand all) is not offered: every child is a lazy read.
        return next === true ? current : { ...current, expanded: { ...next } };
      }),
    [],
  );

  const attach = useCallback(
    (
      roots: readonly TData[],
      rootBatches: readonly ListBatch[] = [],
    ): ServerTreeRow<TData>[] => {
      // A scope's batch rows lead its records. A batch row carries only its
      // id and member count; table renderers draw it from its rollup.
      const withBatches = (
        rows: readonly TData[],
        scopeBatches: readonly ListBatch[],
        scopeId: string | null,
      ): readonly TData[] => {
        if (scopeBatches.length === 0) return rows;
        const batchRowsForScope = scopeBatches.map((batch) => {
          // SAFETY: renderers, selection and grouping consult
          // `serverTreeBatchOf` before reading any record field.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a batch row is synthetic: it has an id and a member count, never record fields.
          const row = {
            id: serverTreeBatchId(batch),
            childCount: batch.count,
          } as unknown as TData;
          batchRows.set(row, { ...batch, scopeId });
          return row;
        });
        return [...batchRowsForScope, ...rows];
      };
      const visit = (rows: readonly TData[]): ServerTreeRow<TData>[] =>
        rows.map((row) => {
          const children = childrenByParent.get(row.id);
          if (!children) return row;
          const subRows = visit(
            withBatches(children.items, children.batches ?? [], row.id),
          );
          // The status row copies its parent's fields so a grouped list
          // files it in the parent's section; it is never expandable.
          if (children.status) {
            const statusRow = {
              ...row,
              id: `${row.id}:tree-status`,
              childCount: 0,
            };
            statusRows.set(statusRow, children.status);
            subRows.push(statusRow);
          }
          const expanded = { ...row, subRows };
          // An opened batch row is a new object; it stays a batch row.
          const batch = batchRows.get(row);
          if (batch) batchRows.set(expanded, batch);
          return expanded;
        });
      return visit(withBatches(roots, rootBatches, null));
    },
    [childrenByParent],
  );

  // A batch command's members: the batch scope's active members under the
  // list's own filters, one bounded page.
  const readBatchMembers = useCallback(
    async (
      batch: ListBatch,
      signal: AbortSignal,
    ): Promise<readonly TData[]> => {
      const page = await planFor(
        { scope: "batch", parentId: batch.parentId, value: batch.value },
        0,
        { filters: { phase: ["active"] }, pageSize: LIST_BATCH_COMMAND_LIMIT },
      ).execute(signal, "strong");
      return page.items;
    },
    [planFor],
  );

  return {
    expanded: state.expanded,
    onExpandedChange,
    attach,
    readBatchMembers,
  };
}
