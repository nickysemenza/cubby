"use client";

import { type ColumnHelper } from "@tanstack/react-table";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { TableLink, ImageThumbnail } from "../table";

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
  pathPrefix: string,
) {
  return columnHelper.accessor((row) => row.name, {
    id: "name",
    cell: (info) => (
      <TableLink href={`${pathPrefix}/${info.row.original.id}`}>
        {String(info.getValue())}
      </TableLink>
    ),
  });
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
      <ImageThumbnail images={info.getValue()} alt={headerText} />
    ),
  });
}
