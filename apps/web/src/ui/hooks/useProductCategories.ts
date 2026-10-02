import { useAllEntityRecords } from "./useAllEntityRecords";

/** A complete shared vocabulary: later pages must remain selectable, including
 * broad parents that a relevance-ranked first page might omit. */
export function useProductCategories() {
  const { records, isLoading } = useAllEntityRecords("productCategory", {
    filters: {},
    pagination: { pageIndex: 0, pageSize: 500 },
    sort: [{ orderBy: "sortOrder", direction: "asc" }],
  });
  return { categories: records, isLoading };
}
