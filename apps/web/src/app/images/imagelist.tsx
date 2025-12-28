import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";
import { createNameColumn } from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { useTableConfig } from "~/app/_components/data-table/useTableConfig";
import { useTableState } from "~/app/_components/data-table/useTableState";
import { EntityPillLink } from "~/app/_components/EntityPill";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { NoneState } from "~/app/_components/NoneState";
import { ImageThumbnail } from "~/app/_components/table/ImageThumbnail";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { Input } from "~/components/ui/input";
import useDebounce from "~/hooks/useDebounce";
import { useQueryWithTiming } from "~/hooks/useQueryWithTiming";
import { assertNever } from "~/lib/assert";
import type { ImageWithEntity } from "~/schemas/image";
import { useTRPC } from "~/trpc/react";

export default function ImageList() {
  const api = useTRPC();

  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Set up search - track input value and debounced value separately
  const [searchInput, setSearchInput] = useState<string>("");
  const debouncedSearchQuery = useDebounce(searchInput, 300);
  const isFirstRender = useRef(true);

  // Reset to first page when debounced search changes (but not on initial render)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    tableState.setPagination({ ...tableState.pagination, pageIndex: 0 });
  }, [tableState.pagination, tableState.setPagination]);

  // Query for images using the new list endpoint
  const {
    data: imagesResp,
    isLoading,
    error,
    timing,
  } = useQueryWithTiming(
    api.image.list.queryOptions({
      filters: {
        searchFilter: debouncedSearchQuery || undefined,
      },
      sort: {
        orderBy: tableState.sorting[0]?.id || "createdAt",
        direction: tableState.sorting[0]?.desc ? "desc" : "asc",
      },
      pagination: {
        pageIndex: tableState.pagination.pageIndex,
        pageSize: tableState.pagination.pageSize,
      },
    }),
  );

  const data = imagesResp?.items || [];
  const totalCount = imagesResp?.meta?.totalCount || 0;

  // Set up column helper
  const columnHelper = createColumnHelper<ImageWithEntity>();

  // Column definitions
  const columns = [
    columnHelper.display({
      id: "preview",
      header: "Preview",
      cell: ({ row }) => {
        const image = row.original;
        return (
          <Link to="/images/$id" params={{ id: image.id }} className="block">
            {row.original.status === "UPLOADED" ? (
              <ImageThumbnail images={[image]} alt={image.filename} size="md" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-md border bg-muted">
                <NoneState />
              </div>
            )}
          </Link>
        );
      },
    }),
    createNameColumn(columnHelper, "image", "filename", {
      filterConfig: { placeholder: "Filter by filename..." },
    }),
    columnHelper.accessor("contentType", {
      header: "Type",
      meta: {
        filterConfig: { placeholder: "Filter by content type..." },
      },
      cell: ({ getValue }) => <span>{getValue()}</span>,
    }),
    columnHelper.accessor("size", {
      header: "Size",
      cell: ({ getValue }) => <span>{formatBytes(getValue())}</span>,
    }),
    columnHelper.accessor("status", {
      header: "Status",
      cell: ({ getValue }) => {
        const status = getValue();
        return <ImageStatusBadge status={status} />;
      },
    }),
    columnHelper.accessor(
      (row) => ({
        entityType: row.entityType,
        entityId: row.entityId,
        entityName: row.entityName,
      }),
      {
        id: "entity",
        header: "Associated Entity",
        cell: ({ getValue }) => {
          const { entityType, entityId, entityName } = getValue();

          if (!entityType || !entityId || !entityName) {
            return <NoneState />;
          }

          switch (entityType) {
            case "PRODUCT":
              return (
                <EntityPillLink
                  entity="product"
                  data={{
                    id: entityId,
                    name: entityName,
                    manufacturer: "", // We don't have this info here
                  }}
                  minimal
                />
              );
            case "LOCATION":
              return (
                <EntityPillLink
                  entity="location"
                  data={{
                    id: entityId,
                    name: entityName,
                    type: "room", // Default type for minimal display
                  }}
                  minimal
                />
              );
            case "RECIPE":
              return (
                <EntityPillLink
                  entity="recipe"
                  data={{
                    id: entityId,
                    name: entityName,
                  }}
                  minimal
                />
              );
            default:
              return assertNever(entityType);
          }
        },
      },
    ),
    columnHelper.accessor("createdAt", {
      header: "Created",
      enableSorting: true,
      cell: ({ getValue }) => <HoverableTimestamp timestamp={getValue()} />,
    }),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount,
  });

  // Show empty state when no images
  if (!isLoading && (!data || data.length === 0) && !searchInput) {
    return <NoneState />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-2">
        <Input
          placeholder="Search images..."
          className="max-w-sm"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Images Table"
        timing={timing}
      />
    </div>
  );
}

// Helper function to format bytes
function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}
