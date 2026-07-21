import type { ImageWithEntity } from "@cubby/schemas/image";
import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import prettyBytes from "pretty-bytes";
import { useMemo } from "react";
import { createImageColumn } from "~/app/_components/data-table/columnHelpers";
import RTable from "~/app/_components/data-table/Table";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useEntityList } from "~/app/_components/hooks/useEntityList";
import { useEntityPreview } from "~/app/_components/hooks/useEntityPreview";
import { ImageStatusBadge } from "~/app/_components/table/StatusBadge";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";

export default function ImageList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<ImageWithEntity>(), []);
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("image");

  // Memoize columns to prevent recreating on every render (feeds the
  // useStandardColumns columns memo, which now re-runs on identity change).
  const columns = useMemo(
    () => [
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
              {filename || <NoneValue />}
            </Link>
          );
        },
        meta: {
          className: "min-w-0 w-64 truncate",
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
          className: "w-28",
          mobile: { slot: "subtitle", priority: 10 },
        },
        cell: ({ getValue }) => <span>{getValue()}</span>,
      }),
      // File size
      columnHelper.accessor("size", {
        header: "Size",
        meta: {
          numeric: true,
          className: "w-24",
          mobile: { slot: "trailing", priority: 5 },
        },
        cell: ({ getValue }) => <span>{prettyBytes(getValue())}</span>,
      }),
      // Status
      columnHelper.accessor("status", {
        header: "Status",
        meta: {
          className: "w-28",
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
            className: "w-40",
            mobile: { slot: "meta", priority: 30 },
          },
          cell: ({ getValue }) => {
            const { entityType, entityId, entityName } = getValue();

            if (!entityType || !entityId || !entityName) {
              return <NoneValue />;
            }

            const entityMap = {
              PRODUCT: "product",
              LOCATION: "location",
              RECIPE: "recipe",
            } as const;

            return (
              <EntityInlineLink
                entity={entityMap[entityType as keyof typeof entityMap]}
                data={{ id: entityId, name: entityName }}
                compact
              />
            );
          },
        },
      ),
    ],
    [columnHelper],
  );

  const { table, isLoading, error, timing, infiniteScroll, refreshControls } =
    useEntityList({
      entity: "image",
      queryOptions: (params) => api.image.list.queryOptions(params),
      buildFilters: (ts) => ({
        // Map the filename column filter to the API's nameFilter
        nameFilter: ts.getColumnFilter("filename") ?? undefined,
      }),
      columns,
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
        onRowHover={onRowHover}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
    </div>
  );
}
