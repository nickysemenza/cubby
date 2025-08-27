"use client";

import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { useState } from "react";
import {
  ProductPillLink,
  LocationPillLink,
  RecipePillLink,
} from "~/app/_components/EntityPill";
import { HoverableTimestamp } from "~/app/_components/HoverableTimestamp";
import { Input } from "~/components/ui/input";
import RTable from "~/app/_components/data-table/Table";
import { NoneState } from "~/app/_components/NoneState";
import useDebounce from "~/hooks/useDebounce";
import { useQuery } from "@tanstack/react-query";
import { useTableState } from "~/app/_components/data-table/useTableState";
import { useTableConfig } from "~/app/_components/data-table/useTableConfig";
import Link from "next/link";
import { type ImageWithEntity } from "~/schemas/image";
import { assertNever } from "~/lib/assert";
import {
  TableLink,
  ImageThumbnail,
  ImageStatusBadge,
} from "~/app/_components/table";

export default function ImageList() {
  const api = useTRPC();

  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Set up search
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Create debounced search function
  const debouncedSearch = useDebounce((value: string) => {
    setSearchQuery(value);
    // Reset to first page on search
    tableState.setPagination({ ...tableState.pagination, pageIndex: 0 });
  }, 300);

  // Query for images using the new list endpoint
  const { data: imagesResp, isLoading } = useQuery(
    api.image.list.queryOptions({
      filters: {
        searchFilter: searchQuery || undefined,
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
          <Link href={`/images/${image.id}`} className="block">
            {row.original.status === "UPLOADED" ? (
              <ImageThumbnail images={[image]} alt={image.filename} size="md" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-md border bg-gray-100">
                <NoneState />
              </div>
            )}
          </Link>
        );
      },
    }),
    columnHelper.accessor("filename", {
      header: "Filename",
      cell: ({ row }) => (
        <TableLink href={`/images/${row.original.id}`}>
          {row.original.filename}
        </TableLink>
      ),
    }),
    columnHelper.accessor("contentType", {
      header: "Type",
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
            return <span className="text-gray-500 italic">None</span>;
          }

          switch (entityType) {
            case "PRODUCT":
              return (
                <ProductPillLink
                  product={{
                    id: entityId,
                    name: entityName,
                    manufacturer: "", // We don't have this info here
                  }}
                />
              );
            case "LOCATION":
              return (
                <LocationPillLink
                  location={{
                    id: entityId,
                    name: entityName,
                    type: "", // We don't have this info here
                  }}
                />
              );
            case "RECIPE":
              return (
                <RecipePillLink
                  recipe={{
                    id: entityId,
                    name: entityName,
                  }}
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
  if (!isLoading && (!data || data.length === 0) && !searchQuery) {
    return <NoneState />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-2">
        <Input
          placeholder="Search images..."
          className="max-w-sm"
          onChange={(e) => debouncedSearch(e.target.value)}
        />
      </div>

      <RTable
        table={table}
        filterableColumns={[
          {
            id: "filename",
            placeholder: "Filter by filename...",
          },
          {
            id: "contentType",
            placeholder: "Filter by content type...",
          },
        ]}
        isLoading={isLoading}
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

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}
