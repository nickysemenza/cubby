"use client";

import Link from "next/link";
import Image from "next/image";
import { type ColumnHelper } from "@tanstack/react-table";
import { HoverableTimestamp } from "../HoverableTimestamp";

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
    cell: (info) => {
      const images = info.getValue();
      if (!images || images.length === 0) {
        return (
          <div className="flex h-12 w-12 items-center justify-center rounded-md border bg-gray-100">
            <span className="text-xs text-gray-500">No image</span>
          </div>
        );
      }

      // Use the first image
      const image = images[0];
      return (
        <div className="relative h-12 w-12 overflow-hidden rounded-md border">
          <Image
            src={image.url}
            alt={image.filename || "Image"}
            fill
            sizes="48px"
            className="object-cover"
          />
          {images.length > 1 && (
            <div className="absolute right-0 bottom-0 flex h-5 w-5 items-center justify-center rounded-tl-md bg-black/70 text-xs text-white">
              +{images.length - 1}
            </div>
          )}
        </div>
      );
    },
  });
}
