import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { createImageColumn } from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { EntityPillLink } from "~/app/_components/EntityPill";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { NoneState } from "~/app/_components/NoneState";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import type { ImageWithEntity } from "~/schemas/image";
import { useTRPC } from "~/trpc/react";

export default function ImageList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<ImageWithEntity>();

  const { table, isLoading, error, timing, data } = useEntityList({
    entity: "image",
    queryOptions: api.image.list.queryOptions,
    buildFilters: (ts) => ({
      // Map filename column filter to the API's searchFilter
      searchFilter: ts.getColumnFilter("filename") ?? undefined,
    }),
    columns: [
      // Filename column (links to detail page)
      columnHelper.accessor("filename", {
        header: "Filename",
        cell: ({ row, getValue }) => {
          const filename = getValue();
          return (
            <Link
              to="/images/$id"
              params={{ id: row.original.id }}
              className="font-medium text-primary hover:underline"
            >
              {filename || <NoneState />}
            </Link>
          );
        },
        meta: {
          filterConfig: {
            placeholder: "Filter by filename...",
          },
        },
      }),
      // Preview column
      createImageColumn(columnHelper, {
        getImages: (row) => (row.status === "UPLOADED" ? [row] : []),
      }),
      // Content type
      columnHelper.accessor("contentType", {
        header: "Type",
        cell: ({ getValue }) => <span>{getValue()}</span>,
      }),
      // File size
      columnHelper.accessor("size", {
        header: "Size",
        cell: ({ getValue }) => <span>{formatBytes(getValue())}</span>,
      }),
      // Status
      columnHelper.accessor("status", {
        header: "Status",
        cell: ({ getValue }) => {
          const status = getValue();
          return <ImageStatusBadge status={status} />;
        },
      }),
      // Associated entity
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

            const entityMap = {
              PRODUCT: "product",
              LOCATION: "location",
              RECIPE: "recipe",
            } as const;

            return (
              <EntityPillLink
                entity={entityMap[entityType]}
                data={{ id: entityId, name: entityName }}
                compact
              />
            );
          },
        },
      ),
    ],
    filters: [
      {
        id: "filename",
        placeholder: "Filter by filename...",
      },
    ],
  });

  // Show empty state when no images and not loading
  if (!isLoading && (!data || data.length === 0)) {
    return <NoneState />;
  }

  return (
    <RTable
      table={table}
      isLoading={isLoading}
      error={error}
      ariaLabel="Images Table"
      timing={timing}
      entity="image"
    />
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
