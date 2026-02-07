import type { SearchType } from "@cubby/schemas/search";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Search } from "lucide-react";
import { Input } from "~/components/ui/input";
import { useTRPC } from "~/trpc/react";
import RTable from "../data-table/Table";
import { useEntityPreview } from "../hooks/useEntityPreview";
import { searchColumns } from "./search-columns";

interface SearchPageProps {
  query?: string;
  type: SearchType;
}

export function SearchPage({ query = "", type }: SearchPageProps) {
  const api = useTRPC();
  const navigate = useNavigate();
  const { onRowClick, PreviewSheet } = useEntityPreview(); // Dynamic entity from row

  // Search query - 50 per entity type for full search page
  const { data, isLoading, error } = useQuery({
    ...api.search.global.queryOptions({
      query: query || "a",
      limit: 50,
    }),
    enabled: query.length > 0,
  });

  // Create table instance (client-side filtering/sorting)
  const table = useReactTable({
    data: data ?? [],
    columns: searchColumns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      columnFilters: type !== "all" ? [{ id: "entityType", value: type }] : [],
    },
  });

  // Sync URL query param with input
  const handleSearchChange = (value: string) => {
    navigate({
      to: "/search",
      search: {
        q: value || undefined,
        type: type === "all" ? undefined : type,
      },
    });
  };

  return (
    <div className="container mx-auto space-y-4 p-1">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search products, recipes, locations..."
          defaultValue={query}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-10"
          autoFocus
        />
      </div>

      {/* Results table */}
      {query.length > 0 ? (
        <RTable
          table={table}
          isLoading={isLoading}
          error={error}
          ariaLabel="Search results"
          onRowClick={onRowClick}
        />
      ) : (
        <div className="flex h-48 items-center justify-center text-muted-foreground">
          Enter a search term to find items
        </div>
      )}
      <PreviewSheet />
    </div>
  );
}
