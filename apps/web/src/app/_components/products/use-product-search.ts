import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTRPC } from "~/integrations/trpc/react";
import { buildProductComboboxItem } from "../combobox/combobox-builders";
import type { ComboboxItem } from "../combobox/combobox-types";

const pagination = { pageIndex: 0, pageSize: 20 };

/**
 * Standalone hook for product search.
 * Drives a combobox with product search results without the dialog-based
 * WithProductSearch wrapper.
 */
export function useProductSearch() {
  const api = useTRPC();
  const [searchQuery, setSearchQuery] = useState("");

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const { data, isLoading } = useQuery(
    api.product.search.queryOptions({
      filters: { nameFilter: searchQuery },
      pagination,
    }),
  );

  const items: ComboboxItem[] = data?.items.map(buildProductComboboxItem) ?? [];

  return {
    items,
    onSearchChange,
    isLoading,
    searchQuery,
  };
}
