"use client";

import Link from "next/link";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { type ColumnHelper } from "@tanstack/react-table";

// Initialize dayjs relative time plugin
dayjs.extend(relativeTime);

interface BaseRow {
  id: string | number;
  name?: string;
  createdAt?: string | Date;
}

/**
 * Creates a linked ID column with consistent styling
 */
export function createIdColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  pathPrefix: string,
) {
  return columnHelper.accessor((row) => row.id, {
    id: "id",
    enableSorting: false,
    cell: (info) => (
      <div>
        <Link
          className="group-selected:bg-slate-700 group-selected:border-slate-800 rounded-sm border border-slate-200 bg-slate-100 px-1 font-mono font-medium text-blue-600 hover:underline dark:text-blue-500"
          href={`${pathPrefix}/${info.getValue()}`}
        >
          {String(info.getValue())}
        </Link>
      </div>
    ),
  });
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
        className="text-blue-600 hover:underline dark:text-blue-500"
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
export function createCreatedAtColumn<T extends BaseRow>(columnHelper: ColumnHelper<T>) {
  return columnHelper.accessor((row) => row.createdAt, {
    id: "createdAt",
    cell: (info) => {
      const value = info.getValue();
      return value ? dayjs(value).fromNow() : "";
    },
  });
}
