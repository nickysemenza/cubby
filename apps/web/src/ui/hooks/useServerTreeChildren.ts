import type { ListNesting } from "@cubby/schemas/pagination";
import { useQueries } from "@tanstack/react-query";
import type { ExpandedState, OnChangeFn } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";

import type { ListQueryPlan, ListQueryResponse } from "./usePaginatedTableCore";

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

/**
 * One children page with its deferred groups merged in, so a nested row reads
 * as complete as a root row the progressive list enriched.
 */
async function completeChildPage<TData extends { id: string }>(
  plan: ListQueryPlan<TData>,
  signal: AbortSignal,
): Promise<ListQueryResponse<TData>> {
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
  for (const group of enrichment.groups) {
    if (group.state !== "ready") continue;
    for (const patch of group.data)
      patches.set(patch.id, { ...patches.get(patch.id), ...patch });
  }
  return {
    ...page,
    items: page.items.map((row) => ({ ...row, ...patches.get(row.id) })),
  };
}

const NO_PAGES: Readonly<Record<string, number>> = {};
const NO_EXPANDED: Readonly<Record<string, boolean>> = {};

/**
 * A server-nested tree's lazily read children. The list pages its roots;
 * expanding a row reads that parent's `children` scope through the same list
 * query (same filters and sort), page by page until the scope is continuing.
 * Nothing is nested from loaded pages: every child arrives under the parent
 * the server read it for. Expansion and child reads reset when `scope` (the
 * filters and sort) changes.
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
  const combine = useCallback(
    (results: { data?: ListQueryResponse<TData> }[]) => results,
    [],
  );
  const results = useQueries({
    queries: requests.map(({ plan }) => ({
      queryKey: [...plan.queryKey, "__tree_children__"],
      meta: plan.meta,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        completeChildPage(plan, signal),
    })),
    combine,
  });

  const childrenByParent = useMemo(() => {
    const byParent = new Map<string, TData[]>();
    requests.forEach(({ parentId }, index) => {
      const items = results[index]?.data?.items;
      if (items)
        byParent.set(parentId, [...(byParent.get(parentId) ?? []), ...items]);
    });
    return byParent;
  }, [requests, results]);

  // Continue a parent's paging while its last loaded page leaves more.
  const continuing = useMemo(() => {
    const more: string[] = [];
    requests.forEach(({ parentId, pageIndex }, index) => {
      const meta = results[index]?.data?.meta;
      if (
        meta &&
        pageIndex === (state.pages[parentId] ?? 1) - 1 &&
        (pageIndex + 1) * meta.pageSize < meta.totalCount
      )
        more.push(parentId);
    });
    return more;
  }, [requests, results, state.pages]);
  useEffect(() => {
    if (continuing.length === 0) return;
    setState((current) => ({
      ...current,
      pages: Object.fromEntries([
        ...Object.entries(current.pages),
        ...continuing.map((id) => [id, (current.pages[id] ?? 1) + 1] as const),
      ]),
    }));
  }, [continuing]);

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
          return children ? { ...row, subRows: visit(children) } : row;
        });
      return visit(roots);
    },
    [childrenByParent],
  );

  return { expanded: state.expanded, onExpandedChange, attach };
}
