import type { PurchaseShortcode } from "@cubby/schemas/identifiers";
import { MAX_PAGE_SIZE } from "@cubby/schemas/pagination";
import { useQuery } from "@tanstack/react-query";

import { entityListFor } from "~/entities/entity-list";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  type FilterPatch,
  type FilterValue,
} from "~/entities/filters";
import {
  entityListParamsFromParsed,
  parseEntityListInput,
} from "~/entities/generated/entity-lists.gen";
import { viewsForEntity } from "~/entities/view-manifest";

/**
 * The product filter patch a saved view selects, exactly as the list page would
 * send it — the view manifest is the one statement of the predicate, so a
 * worklist that runs it here cannot drift from what the view shows.
 */
function productViewFilters(viewId: string): FilterPatch {
  const view = viewsForEntity("product").find((v) => v.id === viewId);
  if (!view) throw new Error(`Unknown product view: ${viewId}`);
  const values = new Map<string, FilterValue>(
    view.filters.map(({ id, value }) => [id, value]),
  );
  return buildFiltersFromManifest(getEntityFilters("product"), (columnId) =>
    values.get(columnId),
  );
}

/**
 * Every product a saved view selects, read once.
 *
 * A pass is a point-in-time worklist, so this is a snapshot: it never
 * refetches (not on focus, not when the pass's own writes invalidate product
 * data — the query carries no operation tags), and `gcTime: 0` drops it when
 * the pass unmounts so the next entry starts from the view's live state.
 * Paged at the server maximum until the view's total is covered.
 */
export function useProductViewSnapshot({
  viewId,
  purchaseIds,
  enabled = true,
}: {
  viewId: string;
  /** Narrow to products bought on these purchases (an import run's scope). */
  purchaseIds?: readonly PurchaseShortcode[];
  enabled?: boolean;
}) {
  const list = entityListFor("product");
  return useQuery({
    queryKey: ["product-view-snapshot", viewId, purchaseIds ?? null],
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      // An empty id list is "no purchases", not "no constraint": the filter
      // builder collapses `[]` to absent, which would select every product.
      if (purchaseIds?.length === 0) return [];
      const filters = productViewFilters(viewId);
      if (purchaseIds) filters.purchaseId = [...purchaseIds];
      const sort = viewsForEntity("product")
        .find((v) => v.id === viewId)
        ?.sort?.map((term) => ({
          orderBy: term.id,
          direction: term.desc ? ("desc" as const) : ("asc" as const),
        }));
      const rows = [];
      for (let pageIndex = 0; ; pageIndex += 1) {
        const params = entityListParamsFromParsed(
          "product",
          parseEntityListInput("product", {
            entity: "product",
            filters,
            sort: sort ?? { orderBy: "createdAt", direction: "desc" },
            pagination: { pageIndex, pageSize: MAX_PAGE_SIZE },
          }),
        );
        const page = await list.listQueryPlan(params).execute(signal);
        rows.push(...page.items);
        if ((pageIndex + 1) * page.meta.pageSize >= page.meta.totalCount) {
          return rows;
        }
      }
    },
  });
}
