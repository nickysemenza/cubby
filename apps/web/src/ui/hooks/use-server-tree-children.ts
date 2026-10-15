import type { ListNesting } from "@cubby/schemas/pagination";
import { useQueries } from "@tanstack/react-query";
import type { ExpandedState, OnChangeFn, RowData } from "@tanstack/react-table";
import { useCallback, useMemo, useState } from "react";
import { z } from "zod";

import { StartOperationError } from "~/integrations/tanstack-query/start-transport";

import type {
  ListQueryPlan,
  ListQueryResponse,
} from "./use-paginated-table-core";

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
      remaining: number;
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

type ChildPage<TData> = ListQueryResponse<TData> & {
  /** A deferred group that did not arrive; its fields would read as empty. */
  enrichmentError?: Error;
};

/**
 * One children page with its deferred groups merged in, so a nested row reads
 * as complete as a root row the progressive list enriched. A group that fails
 * keeps the base rows but surfaces its error.
 */
async function completeChildPage<TData extends { id: string }>(
  plan: ListQueryPlan<TData>,
  signal: AbortSignal,
): Promise<ChildPage<TData>> {
  const page = await plan.execute(signal);
  const groups = (page.deferredGroups ?? []).map((group) => group.id);
  if (!plan.progressive || groups.length === 0 || page.items.length === 0)
    return page;
  const enrichment = await plan.progressive.enrich(
    page.items.map((row) => row.id),
    groups,
    signal,
  );
  const patches = new Map<string, object>();
  let enrichmentError: Error | undefined;
  for (const id of groups) {
    const group = enrichment.groups.find((entry) => entry.id === id);
    if (group?.state !== "ready") {
      enrichmentError ??=
        group?.state === "error"
          ? new StartOperationError(group.error)
          : new Error(`No ${id} enrichment returned`);
      continue;
    }
    for (const patch of group.data)
      patches.set(patch.id, { ...patches.get(patch.id), ...patch });
  }
  return {
    ...page,
    items: page.items.map((row) => ({ ...row, ...patches.get(row.id) })),
    ...(enrichmentError ? { enrichmentError } : {}),
  };
}

const NO_PAGES: Readonly<Record<string, number>> = {};
const NO_EXPANDED: Readonly<Record<string, boolean>> = {};

type ChildResult<TData> = {
  data?: ChildPage<TData>;
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
  scope,
  planFor,
}: {
  enabled: boolean;
  /** Changes whenever the filters or sort change. */
  scope: string;
  planFor: (nesting: ListNesting, pageIndex: number) => ListQueryPlan<TData>;
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
          plan: planFor({ scope: "children", parentId }, pageIndex),
        })),
      ),
    [expandedIds, planFor, state.pages],
  );
  const combine = useCallback((results: ChildResult<TData>[]) => results, []);
  const results = useQueries({
    queries: requests.map(({ plan }) => ({
      queryKey: [...plan.queryKey, "__tree_children__"],
      meta: plan.meta,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        completeChildPage(plan, signal),
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
      { items: TData[]; status?: ServerTreeChildStatus }
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
      const failed = pages.filter(
        (page) => page.error || page.data?.enrichmentError,
      );
      const last = pages.at(-1);
      // Every page of one scope reports the same total.
      const meta = pages.find((page) => page.data)?.data?.meta;
      const remaining = meta ? meta.totalCount - items.length : 0;
      const status: ServerTreeChildStatus | undefined =
        failed.length > 0
          ? {
              kind: "error",
              error:
                failed[0]?.error ??
                failed[0]?.data?.enrichmentError ??
                new Error("Nested rows failed to load"),
              retry: () => {
                for (const page of failed) void page.refetch();
              },
            }
          : items.length === 0 && last?.isPending
            ? { kind: "loading" }
            : remaining > 0
              ? {
                  kind: "more",
                  remaining,
                  loading: Boolean(last?.isPending),
                  loadMore: () => loadMore(parentId),
                }
              : undefined;
      byParent.set(parentId, status ? { items, status } : { items });
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
    (roots: readonly TData[]): ServerTreeRow<TData>[] => {
      const visit = (rows: readonly TData[]): ServerTreeRow<TData>[] =>
        rows.map((row) => {
          const children = childrenByParent.get(row.id);
          if (!children) return row;
          const subRows = visit(children.items);
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
          return { ...row, subRows };
        });
      return visit(roots);
    },
    [childrenByParent],
  );

  return { expanded: state.expanded, onExpandedChange, attach };
}
