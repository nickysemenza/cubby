import { Link } from "@tanstack/react-router";
import type { CellContext, ColumnHelper } from "@tanstack/react-table";
import { Eye, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import type { Amount } from "~/codec/codec";
import { SpacedContainer } from "~/components/layout/spaced-container";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
import type { LocationType } from "~/schemas/location";
import { EntityPillLink } from "../EntityPill";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { tryFormatAmount } from "../inventory/format-amount";
import { NoneState } from "../NoneState";
import { TruncatedList } from "../TruncatedList";
import { ImageThumbnail } from "../table/ImageThumbnail";
import { TableLink } from "../table/TableLink";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";

/** Configuration for inline column header filters */
export interface FilterConfig {
  placeholder: string;
  filterType?: "text" | "select";
  options?: Array<{ value: string; label: string }>;
}

// Extend TanStack Table's meta type to include our custom properties
declare module "@tanstack/react-table" {
  // biome-ignore lint/correctness/noUnusedVariables: required for module augmentation
  interface ColumnMeta<TData, TValue> {
    mobileCategory?: "hero" | "compact" | "medium" | "wide";
    className?: string;
    /** Filter configuration for inline header filter */
    filterConfig?: FilterConfig;
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
  options?: {
    /** Filter configuration for inline header filter */
    filterConfig?: FilterConfig;
  },
) {
  const config = {
    id: String(fieldName),
    enableSorting: true,
    meta: {
      className: "min-w-0 w-40 max-w-56",
      filterConfig: options?.filterConfig,
    },
    cell: (info: CellContext<T, T[keyof T]>) => {
      const value = String(info.getValue());
      return (
        <Tooltip>
          <TooltipTrigger render={<span className="block truncate" />}>
            <TableLink
              to={`/${entities[entity].basePath}/$id` as "/products/$id"}
              params={{ id: String(info.row.original.id) }}
            >
              {value}
            </TableLink>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            {value}
          </TooltipContent>
        </Tooltip>
      );
    },
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
      <ImageThumbnail
        size="sm"
        images={info.getValue() ?? []}
        alt={headerText}
      />
    ),
  });
}

// ============================================================================
// Entity Relationship Columns
// ============================================================================

// Entity-specific data types for columns
type EntityColumnData =
  | { entity: "ingredient"; items: { name: string; id: string }[] }
  | {
      entity: "product";
      items: { name: string; id: string; manufacturer: string }[];
    }
  | { entity: "recipe"; items: { name: string; id: string }[] }
  | {
      entity: "location";
      items: { name: string; id: string; type: LocationType }[];
    };

/**
 * Creates a column that displays a list of related entities as pill links.
 *
 * @example
 * // For displaying location children
 * createEntityPillColumn(columnHelper, "children", "location")
 *
 * // For displaying products linked to an ingredient
 * createEntityPillColumn(columnHelper, "product", "product", { className: "w-48" })
 */
export function createEntityPillColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
  TEntity extends EntityColumnData["entity"],
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  entity: TEntity,
  options?: {
    header?: string;
    className?: string;
    /** Optional filter to deduplicate items */
    dedupe?: boolean;
  },
) {
  return columnHelper.accessor(
    (row) => row[accessor] as { id: string; name: string }[],
    {
      id: String(accessor),
      header: options?.header,
      enableSorting: false,
      meta: options?.className
        ? { className: `${options.className} overflow-hidden` }
        : undefined,
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
            entity={entity}
            items={items as never}
            maxItems={1}
            compact
          />
        );
      },
    },
  );
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
    /** Show compact view (no grid) - defaults to true for table columns */
    compact?: boolean;
  },
) {
  const compact = options?.compact ?? true;
  return columnHelper.display({
    id: options?.id ?? "unitMappings",
    header: options?.header ?? "Unit Mappings",
    meta: {
      className:
        options?.className ?? (compact ? "min-w-0 w-32" : "w-96 max-w-96"),
    },
    cell: (info) => {
      const entity = info.row.original;
      const mappings = mappingsMap[entity.id] ?? [];
      return (
        <div className="w-full">
          <UnitMappingDisplay mappings={mappings} title="" compact={compact} />
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
  // Optional related entities - either location (in ProductList) or product (in LocationList)
  location?: { id: string; name: string; type: LocationType };
  product?: { id: string; name: string; manufacturer: string };
}

// Discriminated union for inventory column entity types
type InventoryRelatedEntity =
  | {
      entity: "location";
      data: { id: string; name: string; type: LocationType };
    }
  | {
      entity: "product";
      data: { id: string; name: string; manufacturer: string };
    };

/**
 * Creates a column that displays inventory entries with amounts and related entity pills.
 * Used in ProductList (shows locations) and LocationList (shows products).
 *
 * @example
 * // In ProductList - show locations for each inventory entry
 * createInventoryEntriesColumn(columnHelper, "inventoryEntry", "location", (e) => e.location)
 *
 * // In LocationList - show products for each inventory entry
 * createInventoryEntriesColumn(columnHelper, "inventoryEntries", "product", (e) => e.product)
 */
export function createInventoryEntriesColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
  TEntry extends InventoryEntryBase,
  TEntity extends InventoryRelatedEntity["entity"],
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  entity: TEntity,
  getRelatedEntity: (
    entry: TEntry,
  ) => Extract<InventoryRelatedEntity, { entity: TEntity }>["data"] | undefined,
  options?: {
    header?: string;
    className?: string;
    /** Layout variant: 'stacked' shows amounts then pills, 'inline' shows amount+pill per row */
    layout?: "stacked" | "inline";
  },
) {
  const layout = options?.layout ?? "inline";

  return columnHelper.accessor((row) => row[accessor] as TEntry[], {
    id: String(accessor),
    header:
      options?.header ?? (entity === "location" ? "Locations" : "Products"),
    enableSorting: false,
    meta: { className: options?.className ?? "min-w-0 w-40 max-w-56" },
    cell: (info) => {
      const entries = info.getValue() ?? [];
      if (entries.length === 0) {
        return <NoneState />;
      }

      if (layout === "inline") {
        // Compact inline with truncation: show first entry + "+N more"
        const renderEntry = (entry: TEntry) => {
          const related = getRelatedEntity(entry);
          if (!related) return null;
          return (
            <span key={entry.id} className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">
                {tryFormatAmount(entry.amount)}
              </span>
              <span className="text-muted-foreground/50">@</span>
              <EntityPillLink entity={entity} data={related as never} compact />
            </span>
          );
        };

        return (
          <TruncatedList
            items={entries}
            maxItems={1}
            gap="gap-1"
            renderItem={(entry) => renderEntry(entry)}
            renderOverflowItem={(entry) => renderEntry(entry)}
          />
        );
      }

      // Stacked layout: amounts grouped, then pills grouped
      const relatedEntities = entries.map(getRelatedEntity).filter(Boolean);
      return (
        <SpacedContainer space={0} className="space-y-0.5">
          <div className="space-y-0.5 text-xs">
            {entries.map((entry) => (
              <div key={entry.id}>{tryFormatAmount(entry.amount)}</div>
            ))}
          </div>
          <EntityPillLinkList
            entity={entity}
            items={relatedEntities as never}
            compact
          />
        </SpacedContainer>
      );
    },
  });
}

// ============================================================================
// Actions Column
// ============================================================================

interface ActionsColumnOptions<T> {
  /** Additional actions to render after "View Details" */
  extraActions?: (row: T) => ReactNode;
}

/**
 * Creates a standard actions column with a dropdown menu.
 * Includes "View Details" link by default, with optional extra actions.
 *
 * @example
 * // Basic usage - just View Details
 * createActionsColumn(columnHelper, "product")
 *
 * // With extra actions (e.g., for inventory items)
 * createActionsColumn(columnHelper, "inventory-item", {
 *   extraActions: (item) => (
 *     <>
 *       <DropdownMenuItem onClick={() => handleMove(item)}>
 *         <ArrowRightLeft /> Move to...
 *       </DropdownMenuItem>
 *       <DropdownMenuItem onClick={() => handleDelete(item)}>
 *         <Trash /> Delete
 *       </DropdownMenuItem>
 *     </>
 *   ),
 * })
 */
export function createActionsColumn<T extends { id: string | number }>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  options?: ActionsColumnOptions<T>,
) {
  return createActionsColumnBase(
    columnHelper,
    (row) => ({
      to: `/${entities[entity].basePath}/$id`,
      params: { id: String(row.id) },
    }),
    options?.extraActions,
  );
}

/**
 * Base implementation for actions columns.
 * Use `createActionsColumn` for standard entity tables.
 * Call this directly for polymorphic rows where entity type varies per row.
 */
export function createActionsColumnBase<T>(
  columnHelper: ColumnHelper<T>,
  getLinkProps: (
    row: T,
  ) => { to: string; params: Record<string, string> } | null,
  extraActions?: (row: T) => ReactNode,
) {
  return columnHelper.display({
    id: "actions",
    header: "",
    enableSorting: false,
    meta: {
      className: "w-10",
    },
    cell: (info) => {
      const row = info.row.original;
      const linkProps = getLinkProps(row);

      return (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="h-8 w-8" />}
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {linkProps && (
              <DropdownMenuItem
                render={
                  <Link
                    to={linkProps.to as "/products/$id"}
                    params={linkProps.params}
                  />
                }
              >
                <Eye className="mr-2 h-4 w-4" />
                View Details
              </DropdownMenuItem>
            )}
            {extraActions?.(row)}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  });
}
