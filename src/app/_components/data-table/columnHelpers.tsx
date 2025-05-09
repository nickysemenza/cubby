"use client";

import Link from "next/link";
import { type ColumnHelper } from "@tanstack/react-table";
import { HoverableTimestamp } from "../HoverableTimestamp";

// Initialize dayjs relative time plugin

interface BaseRow {
  id: string | number;
  name?: string;
  createdAt?: string | Date;
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
      <Link
        className="font-medium text-blue-600 hover:underline dark:text-blue-500"
        href={`${pathPrefix}/${info.row.original.id}`}
      >
        {String(info.getValue())}
      </Link>
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
