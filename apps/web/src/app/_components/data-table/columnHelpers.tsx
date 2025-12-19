"use client";

import { type ColumnHelper, type CellContext } from "@tanstack/react-table";
import { type ComponentType } from "react";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { TableLink, ImageThumbnail } from "../table";
import { entities } from "~/entities/entities";
import { type Entity } from "~/entities/types";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { SpacedContainer } from "~/components/ui/spaced-container";
import { tryFormatAmount } from "../inventory/format-amount";
import { NoneState } from "../NoneState";
import { type Amount } from "~/codec/codec";

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

// ============================================================================
// Entity Relationship Columns
// ============================================================================

/**
 * Creates a column that displays a list of related entities as pill links.
 *
 * @example
 * // For displaying location children
 * createEntityPillColumn(columnHelper, "children", LocationPillLink, "location")
 *
 * // For displaying products linked to an ingredient
 * createEntityPillColumn(columnHelper, "product", ProductPillLink, "product", { className: "w-48" })
 */
export function createEntityPillColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
  TItem extends { id: string; name: string },
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Pill: ComponentType<any>,
  pillPropName: string,
  options?: {
    header?: string;
    className?: string;
    /** Optional filter to deduplicate items */
    dedupe?: boolean;
  },
) {
  return columnHelper.accessor((row) => row[accessor] as TItem[], {
    id: String(accessor),
    header: options?.header,
    enableSorting: false,
    meta: options?.className ? { className: options.className } : undefined,
    cell: (info) => {
      let items = info.getValue() ?? [];
      if (options?.dedupe) {
        items = items.filter(
          (item, i, arr) =>
            arr.findIndex((other) => other.id === item.id) === i,
        );
      }
      return (
        <EntityPillLinkList
          items={items}
          Pill={Pill}
          pillPropName={pillPropName}
        />
      );
    },
  });
}

// ============================================================================
// Unit Mappings Column
// ============================================================================

type UnitMapping = Parameters<typeof UnitMappingDisplay>[0]["mappings"][number];

/**
 * Creates a column that displays unit mappings for an entity.
 * Requires a pre-computed mappingsMap that maps entity IDs to their unit mappings.
 *
 * @example
 * const mappingsMap = useAsyncMemo(...); // { [productId]: UnitMapping[] }
 * createUnitMappingsColumn(columnHelper, mappingsMap)
 */
export function createUnitMappingsColumn<T extends { id: string }>(
  columnHelper: ColumnHelper<T>,
  mappingsMap: Record<string, UnitMapping[]>,
  options?: {
    id?: string;
    header?: string;
    className?: string;
  },
) {
  return columnHelper.display({
    id: options?.id ?? "unitMappings",
    header: options?.header ?? "Unit Mappings",
    meta: { className: options?.className ?? "w-96 max-w-96" },
    cell: (info) => {
      const entity = info.row.original;
      const mappings = mappingsMap[entity.id] ?? [];
      return (
        <div className="w-full">
          <UnitMappingDisplay mappings={mappings} title="" />
        </div>
      );
    },
  });
}

// ============================================================================
// Inventory Entry Columns
// ============================================================================

interface InventoryEntryBase {
  id: string;
  amount: Amount;
}

/**
 * Creates a column that displays inventory entries with amounts and related entity pills.
 * Used in ProductList (shows locations) and LocationList (shows products).
 *
 * @example
 * // In ProductList - show locations for each inventory entry
 * createInventoryEntriesColumn(columnHelper, "inventoryEntry", LocationPillLink, "location", (e) => e.location)
 *
 * // In LocationList - show products for each inventory entry
 * createInventoryEntriesColumn(columnHelper, "inventoryEntries", ProductPillLink, "product", (e) => e.product)
 */
export function createInventoryEntriesColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
  TRelated extends { id: string; name: string },
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Pill: ComponentType<any>,
  pillPropName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRelatedEntity: (entry: any) => TRelated,
  options?: {
    header?: string;
    className?: string;
    /** Layout variant: 'stacked' shows amounts then pills, 'inline' shows amount+pill per row */
    layout?: "stacked" | "inline";
  },
) {
  const layout = options?.layout ?? "stacked";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return columnHelper.accessor((row) => row[accessor] as any[], {
    id: String(accessor),
    header: options?.header,
    enableSorting: false,
    meta: options?.className ? { className: options.className } : undefined,
    cell: (info) => {
      const entries = (info.getValue() ?? []) as InventoryEntryBase[];
      if (entries.length === 0) {
        return <NoneState />;
      }

      if (layout === "inline") {
        // Each entry on its own line with amount + pill
        return (
          <div className="space-y-0.5 text-xs">
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-1">
                <span className="text-muted-foreground">
                  {tryFormatAmount(entry.amount)}
                </span>
                <Pill {...{ [pillPropName]: getRelatedEntity(entry) }} />
              </div>
            ))}
          </div>
        );
      }

      // Stacked layout: amounts grouped, then pills grouped
      return (
        <SpacedContainer space={0} className="space-y-0.5">
          <div className="space-y-0.5 text-xs">
            {entries.map((entry) => (
              <div key={entry.id}>{tryFormatAmount(entry.amount)}</div>
            ))}
          </div>
          <EntityPillLinkList
            items={entries.map(getRelatedEntity)}
            Pill={Pill}
            pillPropName={pillPropName}
          />
        </SpacedContainer>
      );
    },
  });
}
