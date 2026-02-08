import type { ImageWithEntity } from "@cubby/schemas/image";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { createImageColumn } from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { EntityPillLink } from "~/app/_components/EntityPill";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { NoneState } from "~/app/_components/NoneState";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { formatBytes } from "~/lib/format";
import { useTRPC } from "~/trpc/react";

export default function ImageList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<ImageWithEntity>();
  const { onRowClick, PreviewSheet } = useEntityPreview("image");

  const { table, isLoading, error, timing, infiniteScroll, refreshControls } =
    useEntityList({
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
            mobile: { slot: "title", priority: 0 },
            filterConfig: {
              placeholder: "Filter by filename...",
            },
          },
        }),
        // Preview column
        createImageColumn(columnHelper, {
          getImages: (row) => (row.status === "UPLOADED" ? [row] : []),
          entity: "image",
        }),
        // Content type
        columnHelper.accessor("contentType", {
          header: "Type",
          meta: {
            mobile: { slot: "subtitle", priority: 10 },
          },
          cell: ({ getValue }) => <span>{getValue()}</span>,
        }),
        // File size
        columnHelper.accessor("size", {
          header: "Size",
          meta: {
            mobile: { slot: "trailing", priority: 5 },
          },
          cell: ({ getValue }) => <span>{formatBytes(getValue())}</span>,
        }),
        // Status
        columnHelper.accessor("status", {
          header: "Status",
          meta: {
            mobile: { slot: "meta", priority: 20 },
          },
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
            meta: {
              mobile: { slot: "meta", priority: 30 },
            },
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
                  entity={entityMap[entityType as keyof typeof entityMap]}
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
      infinite: true,
    });

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Images Table"
        timing={timing}
        entity="image"
        onRowClick={onRowClick}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
    </div>
  );
}
