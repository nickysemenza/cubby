"use client";

import { type ColumnHelper, type CellContext } from "@tanstack/react-table";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { TableLink, ImageThumbnail } from "../table";
import { entities } from "~/entities/entities";
import { type Entity } from "~/entities/types";

// Extend TanStack Table's meta type to include our custom properties
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    mobileCategory?: "hero" | "compact" | "medium" | "wide";
    className?: string;
  }
}

// Initialize dayjs relative time plugin

interface BaseRow {
  id: string | number;
  name?: string;
  createdAt?: string | Date;
}

interface ImageRow extends BaseRow {
  images?: Array<{
    id: string;
    url: string;
    filename: string;
  }>;
}

/**
 * Creates a standard name column that links to the detail page
 */
export function createNameColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  fieldName: keyof T = "name" as keyof T,
) {
  const config = {
    id: String(fieldName),
    enableSorting: true,
    meta: { className: "w-48 max-w-48" },
    cell: (info: CellContext<T, T[keyof T]>) => (
      <TableLink href={`/${entities[entity].basePath}/${info.row.original.id}`}>
        {String(info.getValue())}
      </TableLink>
    ),
  };

  // Only add header if it's not the default "name" field
  if (fieldName === "filename") {
    return columnHelper.accessor((row) => row[fieldName], {
      ...config,
      header: "Filename",
    });
  }

  return columnHelper.accessor((row) => row[fieldName], config);
}

/**
 * Creates a relative timestamp column
 */
export function createCreatedAtColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
) {
  return columnHelper.accessor((row) => row.createdAt, {
    id: "createdAt",
    cell: (info) => {
      const value = info.getValue();
      return value ? <HoverableTimestamp timestamp={value} /> : "";
    },
  });
}

/**
 * Creates an image column that displays the first image thumbnail
 */
export function createImageColumn<T extends ImageRow>(
  columnHelper: ColumnHelper<T>,
  headerText: string = "Image",
) {
  return columnHelper.accessor((row) => row.images, {
    id: "image",
    header: headerText,
    enableSorting: false,
    cell: (info) => (
      <ImageThumbnail images={info.getValue() ?? []} alt={headerText} />
    ),
  });
}
