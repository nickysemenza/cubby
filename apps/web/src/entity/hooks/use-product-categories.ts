import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { entityListFor, type EntityListParams } from "~/entity/entity-list";
import { flattenUniquePageItems } from "~/entity/hooks/infinite-page-utils";
import { useLoadAllPages } from "~/entity/hooks/use-all-entity-records";
import { useHydratedLoading } from "~/ui/hooks/use-hydrated";

// The vocabulary is labels and hierarchy only. The full default projection
// returned every envelope and image (~3.8 MB for ~190 categories) and was the
// most expensive list read per call; images load through the display-image read.
const input = {
  filters: {},
  pagination: { pageIndex: 0, pageSize: 500 },
  sort: [{ orderBy: "sortOrder", direction: "asc" }],
  fields: ["name", "aliases", "description", "parentId", "path", "feature"],
} satisfies EntityListParams<"productCategory">;

type ProductCategoryOut = DetailRecordOf<"productCategory">;
/** A vocabulary row: exactly the requested label and hierarchy fields. */
export type ProductCategoryVocabularyRow = Pick<
  ProductCategoryOut,
  "id" | "name" | "parentId" | "aliases" | "description"
> & { fields: Pick<ProductCategoryOut["fields"], "path" | "feature"> };

/** A complete shared vocabulary: later pages must remain selectable, including
 * broad parents that a relevance-ranked first page might omit. */
export function useProductCategories(enabled = true) {
  const query = useInfiniteQuery({
    ...entityListFor("productCategory").browserInfiniteQueryOptions(input),
    enabled,
  });
  useLoadAllPages(query, enabled);
  const categories = useMemo(
    () =>
      // SAFETY: the operation parsed each page with Product Category's selected
      // schema for exactly `input.fields`; the selected result type is the
      // union over every list entity, so name this entity's row once here.
      flattenUniquePageItems(
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- selected list results are typed as a cross-entity union.
        query.data?.pages as unknown as
          | ReadonlyArray<{ items: readonly ProductCategoryVocabularyRow[] }>
          | undefined,
      ),
    [query.data],
  );
  return {
    categories,
    isLoading: useHydratedLoading(
      !query.isError &&
        (query.isPending || query.hasNextPage || query.isFetchingNextPage),
    ),
    error: query.error,
    onRetry: () => {
      if (query.isFetching) return;
      if (query.isFetchNextPageError) void query.fetchNextPage();
      else void query.refetch();
    },
    isComplete:
      !query.isPending &&
      !query.hasNextPage &&
      !query.isFetchingNextPage &&
      !query.isError,
  };
}
