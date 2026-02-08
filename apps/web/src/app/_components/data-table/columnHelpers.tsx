import type { Amount } from "@cubby/schemas/codec";
import type { Entity } from "@cubby/schemas/entity";
import type { LocationType } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import type { CellContext, ColumnHelper } from "@tanstack/react-table";
import { Eye, ImageIcon, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
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
import type { EntityDetailRoute } from "~/entities/types";
import { cn, formatCurrency } from "~/lib/utils";
import { EntityPillLink } from "../EntityPill";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { tryFormatAmount } from "../inventory/format-amount";
import { NoneState } from "../NoneState";
import { TruncatedList } from "../TruncatedList";
import { ImageThumbnail } from "../table/ImageThumbnail";
import { TableLink } from "../table/TableLink";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import {
  EditableAmountCell,
  EditableCell,
  type FilterableComboboxItem,
} from "./editable-cell";

/** Configuration for inline column header filters */
export interface FilterConfig {
  placeholder: string;
  filterType?: "text" | "select";
  options?: FilterableComboboxItem[];
}

export type MobileSlot =
  | "title"
  | "subtitle"
  | "meta"
  | "trailing"
  | "image"
  | "actions"
  | "hidden";

export interface MobileColumnMeta {
  slot?: MobileSlot;
  /** Lower values are rendered first within a slot */
  priority?: number;
}

// Extend TanStack Table's meta type to include our custom properties
declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    /** New mobile projection metadata (preferred) */
    mobile?: MobileColumnMeta;
    /** @deprecated Use `mobile.slot` instead */
    mobileCategory?: "hero" | "compact" | "medium" | "wide";
    /** @deprecated Use `mobile: { slot: "hidden" }` instead */
    mobileHidden?: boolean;
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
 * Creates a standard name column that links to the detail page.
 * Optionally supports inline editing when `editable` option is provided.
 */
export function createNameColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  fieldName: keyof T = "name" as keyof T,
  options?: {
    /** Filter configuration for inline header filter */
    filterConfig?: FilterConfig;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: string, row: T) => Promise<void>;
    };
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
  },
) {
  const config = {
    id: String(fieldName),
    enableSorting: true,
    meta: {
      className: "min-w-0 w-40 max-w-56",
      filterConfig: options?.filterConfig,
      mobile: options?.mobile ?? { slot: "title", priority: 0 },
    },
    cell: (info: CellContext<T, T[keyof T]>) => {
      const value = String(info.getValue());

      // If editable, show EditableCell instead of link
      if (options?.editable) {
        return (
          <EditableCell
            value={value}
            onSave={(newVal) =>
              options.editable!.onSave(newVal ?? "", info.row.original)
            }
            config={{ type: "text" }}
            renderValue={(v) => (
              <Tooltip>
                <TooltipTrigger render={<span className="block truncate" />}>
                  <TableLink
                    to={entities[entity].routes.detail}
                    params={{ id: String(info.row.original.id) }}
                  >
                    {v ?? ""}
                  </TableLink>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  {v ?? ""}
                </TooltipContent>
              </Tooltip>
            )}
          />
        );
      }

      return (
        <Tooltip>
          <TooltipTrigger render={<span className="block truncate" />}>
            <TableLink
              to={entities[entity].routes.detail}
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
    meta: {
      mobile: { slot: "hidden" },
    },
    cell: (info) => {
      const value = info.getValue();
      return value ? <HoverableTimestamp timestamp={value} /> : <NoneState />;
    },
  });
}

/**
 * Creates an image column that displays the first image thumbnail
 */
export function createImageColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  options?: {
    /** Custom accessor when row doesn't have standard `images` array */
    getImages?: (
      row: T,
    ) => Array<{ id: string; url: string; filename?: string }>;
    /** Custom className for the column (default: "px-0 py-0 h-px") */
    className?: string;
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
  },
) {
  const getImages =
    options?.getImages ??
    ((row: T) => (row as unknown as ImageRow).images ?? []);

  return columnHelper.accessor((row) => getImages(row), {
    id: "image",
    header: () => <ImageIcon className="h-3 w-3 text-muted-foreground" />,
    enableSorting: false,
    // h-px trick: setting height:1px on td makes h-full work on children
    // overflow-hidden prevents image from expanding the row
    meta: {
      className: cn("h-px overflow-hidden px-0 py-0", options?.className),
      mobile: options?.mobile ?? { slot: "image", priority: -10 },
    },
    cell: (info) => (
      <ImageThumbnail
        images={info.getValue() ?? []}
        alt="Image"
        lazyPreview={true}
      />
    ),
  });
}

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
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
  },
) {
  return columnHelper.accessor(
    (row) => row[accessor] as { id: string; name: string }[],
    {
      id: String(accessor),
      header: options?.header,
      enableSorting: false,
      meta: {
        className: options?.className
          ? `${options.className} overflow-hidden`
          : undefined,
        mobile: options?.mobile,
      },
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

type UnitMapping = Parameters<typeof UnitMappingDisplay>[0]["mappings"][number];

/**
 * Creates a column that displays unit mappings for an entity.
 * Requires a pre-computed mappingsMap that maps entity IDs to their unit mappings.
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
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
  },
) {
  const layout = options?.layout ?? "inline";

  return columnHelper.accessor((row) => row[accessor] as TEntry[], {
    id: String(accessor),
    header:
      options?.header ?? (entity === "location" ? "Locations" : "Products"),
    enableSorting: false,
    meta: {
      className: options?.className ?? "min-w-0 w-40 max-w-56",
      mobile: options?.mobile,
    },
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
      const relatedEntities = entries
        .map((entry) => getRelatedEntity(entry) as never)
        .filter(Boolean);
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

interface ActionsColumnOptions<T> {
  /** Additional actions to render after "View Details" */
  extraActions?: (row: T) => ReactNode;
}

/**
 * Creates a standard actions column with a dropdown menu.
 * Includes "View Details" link by default, with optional extra actions.
 */
export function createActionsColumn<T extends { id: string | number }>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  options?: ActionsColumnOptions<T>,
) {
  return createActionsColumnBase(
    columnHelper,
    (row) => ({
      to: entities[entity].routes.detail,
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
  ) => { to: EntityDetailRoute; params: { id: string } } | null,
  extraActions?: (row: T) => ReactNode,
) {
  return columnHelper.display({
    id: "actions",
    header: "",
    enableSorting: false,
    meta: {
      className: "w-10",
      mobile: { slot: "actions", priority: 100 },
    },
    cell: (info) => {
      const row = info.row.original;
      const linkProps = getLinkProps(row);

      return (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon" className="h-8 w-8" />}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {linkProps && (
              <DropdownMenuItem
                render={<Link to={linkProps.to} params={linkProps.params} />}
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

/**
 * Creates a simple text column with optional inline editing.
 */
export function createTextColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options?: {
    header?: string;
    placeholder?: string;
    className?: string;
    mobileCategory?: "hero" | "compact" | "medium" | "wide";
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: string | null, row: T) => Promise<void>;
    };
  },
) {
  return columnHelper.accessor((row) => row[accessor] as string | null, {
    id: String(accessor),
    header: options?.header,
    meta: {
      className: options?.className,
      mobileCategory: options?.mobileCategory,
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
    },
    cell: (info) => {
      const value = info.getValue();

      if (options?.editable) {
        return (
          <EditableCell
            value={value}
            onSave={(newVal) =>
              options.editable!.onSave(newVal, info.row.original)
            }
            config={{ type: "text", placeholder: options?.placeholder }}
            renderValue={(v) => (v ? v : <NoneState />)}
          />
        );
      }

      return value ?? <NoneState />;
    },
  });
}

/**
 * Creates a column that displays a currency value with proper formatting.
 * Optionally supports inline editing when `editable` option is provided.
 */
export function createCurrencyColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options?: {
    header?: string;
    className?: string;
    mobile?: MobileColumnMeta;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: number | null, row: T) => Promise<void>;
    };
  },
) {
  return columnHelper.accessor((row) => row[accessor] as number | null, {
    id: String(accessor),
    header: options?.header,
    meta: {
      className: options?.className,
      mobile: options?.mobile,
    },
    cell: (info) => {
      const val = info.getValue();

      if (options?.editable) {
        return (
          <EditableCell
            value={val}
            onSave={(newVal) =>
              options.editable!.onSave(newVal, info.row.original)
            }
            config={{ type: "currency" }}
            renderValue={(v) =>
              v !== null ? formatCurrency(v) : <NoneState />
            }
          />
        );
      }

      if (val === null || val === undefined) return <NoneState />;
      return formatCurrency(val);
    },
  });
}

// Entity-specific single data types (nullable)
type SingleEntityColumnData =
  | { entity: "ingredient"; data: { name: string; id: string } | null }
  | {
      entity: "product";
      data: { name: string; id: string; manufacturer: string } | null;
    }
  | { entity: "recipe"; data: { name: string; id: string } | null }
  | {
      entity: "location";
      data: { name: string; id: string; type: LocationType } | null;
    }
  | {
      entity: "usda-food";
      data: { fdc_id: number; description: string } | null;
    };

/**
 * Creates a column that displays a single related entity as a pill link.
 * Shows NoneState when the entity is null/undefined.
 */
export function createSingleEntityPillColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
  TEntity extends SingleEntityColumnData["entity"],
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  entity: TEntity,
  options?: {
    header?: string;
    className?: string;
    compact?: boolean;
    mobileCategory?: "hero" | "compact" | "medium" | "wide";
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
  },
) {
  const compact = options?.compact ?? true;

  return columnHelper.accessor(
    (row) =>
      row[accessor] as Extract<
        SingleEntityColumnData,
        { entity: TEntity }
      >["data"],
    {
      id: String(accessor),
      header: options?.header,
      enableSorting: false,
      meta: {
        className: options?.className,
        mobileCategory: options?.mobileCategory,
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
      },
      cell: (info) => {
        const item = info.getValue();
        if (!item) return <NoneState />;
        return (
          <EntityPillLink
            entity={entity}
            data={item as never}
            compact={compact}
          />
        );
      },
    },
  );
}

/**
 * Creates a column with a select-based inline filter.
 * Optionally supports inline editing when `editable` option is provided.
 */
export function createFilterableSelectColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options: {
    header?: string;
    placeholder: string;
    selectOptions: FilterableComboboxItem[];
    renderCell: (value: T[K]) => ReactNode;
    className?: string;
    mobile?: MobileColumnMeta;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: T[K], row: T) => Promise<void>;
    };
  },
) {
  return columnHelper.accessor((row) => row[accessor], {
    id: String(accessor),
    header: options.header,
    meta: {
      className: options.className,
      mobile: options.mobile,
      filterConfig: {
        placeholder: options.placeholder,
        filterType: "select",
        options: options.selectOptions,
      },
    },
    cell: (info) => {
      const value = info.getValue() as T[K];

      if (options.editable) {
        return (
          <EditableCell
            value={value as string | null}
            onSave={(newVal) =>
              options.editable!.onSave(newVal as T[K], info.row.original)
            }
            config={{
              type: "select",
              options: options.selectOptions,
              placeholder: options.placeholder,
            }}
            renderValue={(v) => options.renderCell(v as T[K])}
          />
        );
      }

      return options.renderCell(value);
    },
  });
}

/**
 * Creates a column that displays a value as a link to an external/internal page.
 * Shows NoneState when the value is null/undefined.
 * Optionally supports inline editing when `editable` option is provided.
 */
export function createExternalLinkColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  linkTo: string,
  options?: {
    header?: string;
    /** Name of the route param to use (default: "code") */
    paramName?: string;
    variant?: "mono" | "default";
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: string | null, row: T) => Promise<void>;
    };
  },
) {
  const paramName = options?.paramName ?? "code";
  const variant = options?.variant ?? "mono";

  return columnHelper.accessor(
    (row) => row[accessor] as string | number | null,
    {
      id: String(accessor),
      header: options?.header,
      meta: {
        className: options?.className,
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
      },
      cell: (info) => {
        const value = info.getValue();

        if (options?.editable) {
          return (
            <EditableCell
              value={
                value !== null && value !== undefined ? String(value) : null
              }
              onSave={(newVal) =>
                options.editable!.onSave(newVal, info.row.original)
              }
              config={{ type: "text" }}
              renderValue={(v) => {
                if (v === null || v === undefined || v === "") {
                  return <NoneState />;
                }
                return (
                  <TableLink
                    to={linkTo as "/usda/upc/$code"}
                    params={{ [paramName]: String(v) } as { code: string }}
                    variant={variant}
                  >
                    {v}
                  </TableLink>
                );
              }}
            />
          );
        }

        if (value === null || value === undefined) return <NoneState />;
        return (
          <TableLink
            to={linkTo as "/usda/upc/$code"}
            params={{ [paramName]: String(value) } as { code: string }}
            variant={variant}
          >
            {value}
          </TableLink>
        );
      },
    },
  );
}

/**
 * Creates a timestamp column with HoverableTimestamp display.
 * Generalization of createCreatedAtColumn for any timestamp field.
 */
export function createTimestampColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options?: {
    header?: string;
    fallback?: ReactNode;
    className?: string;
    mobile?: MobileColumnMeta;
  },
) {
  const fallback = options?.fallback ?? <NoneState />;

  return columnHelper.accessor((row) => row[accessor] as string | Date | null, {
    id: String(accessor),
    header: options?.header,
    meta: {
      className: options?.className,
      mobile: options?.mobile,
    },
    cell: (info) => {
      const value = info.getValue();
      return value ? <HoverableTimestamp timestamp={value} /> : fallback;
    },
  });
}

/**
 * Creates a column for editing inventory amounts (value + unit).
 * Displays amount using tryFormatAmount, inline editing with two inputs.
 */
export function createEditableAmountColumn<T extends Record<string, unknown>>(
  columnHelper: ColumnHelper<T>,
  accessor: keyof T,
  options: {
    header?: string;
    onSave: (newAmount: Amount, row: T) => Promise<void>;
    /** Get unit mappings for price display (optional) */
    getUnitMappings?: (row: T) => UnitMapping[];
  },
) {
  return columnHelper.accessor((row) => row[accessor] as Amount, {
    id: String(accessor),
    header: options.header ?? "Amount",
    cell: (info) => {
      const amount = info.getValue();
      const row = info.row.original;
      const unitMappings = options.getUnitMappings?.(row);

      return (
        <EditableAmountCell
          amount={amount}
          unitMappings={unitMappings}
          onSave={(newAmount) => options.onSave(newAmount, row)}
        />
      );
    },
  });
}
