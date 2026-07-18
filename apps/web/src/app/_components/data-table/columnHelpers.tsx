import type { Amount } from "@cubby/schemas/codec";
import type { Entity } from "@cubby/schemas/entity";
import type {
  IngredientId,
  LocationId,
  ProductId,
  RecipeId,
} from "@cubby/schemas/identifiers";
import { isDocumentFile } from "@cubby/schemas/image";
import type { LocationType } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import type { CellContext, ColumnHelper } from "@tanstack/react-table";
import { uniqBy } from "es-toolkit";
import { Eye, ImageIcon, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { NoneValue } from "~/components/ui/none-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { entities } from "~/entities/entities";
import type { EntityDetailRoute } from "~/entities/types";
import { cn, formatCurrency } from "~/lib/utils";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
  buildProductComboboxItem,
  buildRecipeComboboxItem,
} from "../combobox/combobox-builders";
import type { ComboboxItem } from "../combobox/combobox-types";
import type { WithEntitySearchProps } from "../combobox/with-search-hook";
import {
  WithIngredientSearch,
  WithLocationSearch,
  WithProductSearch,
  WithRecipeSearch,
} from "../combobox/with-search-hook";
import { EntityInlineLink } from "../EntityInlineLink";
import { EntityInlineLinkList } from "../EntityInlineLinkList";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { ImageThumbnail } from "../table/ImageThumbnail";
import { TableLink } from "../table/TableLink";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import type { CellClipboardSpec } from "./cell-clipboard";
import {
  EditableAmountCell,
  EditableCell,
  type FilterableComboboxItem,
} from "./editable-cell";
import { EditableEntityCell } from "./editable-entity-cell";
import { InventoryEntriesCell } from "./inventory-entries-cell";

/** Configuration for inline column header filters */
export interface FilterConfig {
  placeholder: string;
  filterType?: "text" | "select";
  options?: FilterableComboboxItem[];
  // Append a `(count)` of matching rows to each select option. Off by default:
  // the count comes from TanStack's client-side faceting, which only sees the
  // current page — meaningless (and misleading) on server-paginated tables.
  // Opt in only for tables that load their full dataset client-side.
  facetCount?: boolean;
}

/**
 * Options for a relation-presence header filter: pages map the selected value
 * ("has" | "none") to the entity's `*PresenceFilter` field, resolved server-side
 * as an exists / is-null condition. Clearing the filter means "any".
 */
export function presenceFilterOptions(label: string): FilterableComboboxItem[] {
  return [
    { value: "has", label: `Has ${label}` },
    { value: "none", label: "(none)" },
  ];
}

// --- Cell clipboard spec builders ------------------------------------------
// Kinds: primitives are "<columnId>:<type>" (paste stays within the column);
// entity cells are "entity:<name>" (a copied location pastes into any
// location-picker cell across tables). Builders throw on invalid pastes —
// cell-clipboard surfaces the message as a toast — and resolve with the saved
// value for the cell's optimistic display.

function textCellClipboard(
  kindKey: string,
  value: string | null,
  save: (v: string | null) => Promise<void>,
): CellClipboardSpec {
  return {
    kindKey,
    getCopyPayload: () =>
      value == null || value === "" ? null : { text: value, json: value },
    onPasteValue: async ({ json, text }) => {
      const raw = typeof json === "string" ? json : (text ?? "");
      const next = raw.trim() === "" ? null : raw.trim();
      await save(next);
      return next;
    },
  };
}

function numberCellClipboard(
  kindKey: string,
  value: number | null,
  save: (v: number | null) => Promise<void>,
): CellClipboardSpec {
  return {
    kindKey,
    getCopyPayload: () =>
      value == null ? null : { text: String(value), json: value },
    onPasteValue: async ({ json, text }) => {
      const num =
        typeof json === "number"
          ? json
          : Number.parseFloat((text ?? "").replace(/[^0-9.-]/g, ""));
      if (Number.isNaN(num)) {
        throw new Error("Pasted value is not a number");
      }
      await save(num);
      return num;
    },
  };
}

function selectCellClipboard(
  kindKey: string,
  value: string | null,
  selectOptions: FilterableComboboxItem[],
  save: (v: string) => Promise<void>,
): CellClipboardSpec {
  return {
    kindKey,
    getCopyPayload: () => {
      if (value == null || value === "") return null;
      const opt = selectOptions.find((o) => o.value === value);
      return { text: opt?.label ?? value, json: value };
    },
    onPasteValue: async ({ json, text }) => {
      const candidate = typeof json === "string" ? json : (text ?? "").trim();
      const opt =
        selectOptions.find((o) => o.value === candidate) ??
        selectOptions.find(
          (o) => o.label.toLowerCase() === candidate.toLowerCase(),
        );
      if (!opt || opt.value === "") {
        throw new Error(`"${candidate}" is not a valid option here`);
      }
      await save(opt.value);
      return opt.value;
    },
  };
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
  /**
   * The rendered cell contains an interactive control (e.g. an
   * `EditableEntityCell`/`EditableCell` edit-trigger or a quick-edit pencil
   * button). When set, and the cell lands in the mobile card's meta/trailing
   * right-values bucket, the card skips the truncating `text-2xs` wrapper so
   * the control isn't clipped or cramped below a usable tap target. Set this
   * on columns whose cell renders an editor — don't rely on DOM sniffing.
   */
  interactive?: boolean;
}

// Extend TanStack Table's meta type to include our custom properties
declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    mobile?: MobileColumnMeta;
    className?: string;
    /** Right-align + tabular figures for numeric/quantity columns. */
    numeric?: boolean;
    /**
     * Mono font for code-like data cells (UPCs, timestamps, ids) without the
     * numeric right-align. Names/descriptions stay sans for scanability.
     */
    mono?: boolean;
    /** Filter configuration for inline header filter */
    filterConfig?: FilterConfig;
  }
}

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
    contentType?: string;
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
    /**
     * Override the column width class. Defaults to `w-64` (16rem). The fixed
     * table layout IGNORES `min-width` on cells (only `width` counts), so a
     * `min-w-*` floor does nothing — an explicit width is the only lever. At
     * `w-64` the name still grows to absorb leftover space on sparse tables
     * (fixed layout distributes surplus across width-bearing columns) but holds
     * a readable 16rem on dense tables (many columns) instead of collapsing to a
     * few characters; the table scrolls horizontally for the rest.
     */
    className?: string;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: string, row: T) => Promise<void>;
    };
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
  },
) {
  const entityConfig = entities[entity];
  const config = {
    id: String(fieldName),
    enableSorting: true,
    meta: {
      className: options?.className ?? "w-64",
      filterConfig: options?.filterConfig,
      mobile: options?.mobile ?? { slot: "title", priority: 0 },
    },
    footer: (info: {
      table: {
        getFilteredRowModel: () => { rows: unknown[] };
        options: { meta?: { serverTotals?: { totalCount: number } } };
      };
    }) => {
      // Prefer the server's full-filtered-set count — client rows only cover
      // the loaded pages on server-paginated/infinite tables.
      const count =
        info.table.options.meta?.serverTotals?.totalCount ??
        info.table.getFilteredRowModel().rows.length;
      return `${count} ${count === 1 ? entityConfig.label.toLowerCase() : entityConfig.pluralLabel.toLowerCase()}`;
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
            clipboard={textCellClipboard(
              `${String(fieldName)}:text`,
              value,
              (v) => options.editable!.onSave(v ?? "", info.row.original),
            )}
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
    header: "Created",
    meta: {
      // Relative timestamps are short ("5 months ago"); without a cap the
      // fixed-layout table hands this column an equal share of leftover width.
      className: "w-32",
      mono: true,
      mobile: { slot: "hidden" },
    },
    cell: (info) => {
      const value = info.getValue();
      return value ? <HoverableTimestamp timestamp={value} /> : <NoneValue />;
    },
  });
}

/**
 * Creates an image column that displays the first image thumbnail
 */
export function createImageColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  options: {
    /** Entity type for colored placeholder icon when no image */
    entity: Entity;
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
  // PDF manuals share the images relation — keep them out of thumbnails.
  const getImages =
    options.getImages ??
    ((row: T) =>
      ((row as unknown as ImageRow).images ?? []).filter(
        (img) =>
          img.contentType === undefined ||
          !isDocumentFile({ contentType: img.contentType }),
      ));
  const { entity } = options;

  return columnHelper.accessor((row) => getImages(row), {
    id: "image",
    header: () => <ImageIcon className="h-3 w-3 text-muted-foreground" />,
    enableSorting: false,
    // h-px trick: setting height:1px on td makes h-full work on children
    // overflow-hidden prevents image from expanding the row
    meta: {
      className: cn("h-px w-10 overflow-hidden px-0 py-0", options?.className),
      mobile: options?.mobile ?? { slot: "image", priority: -10 },
    },
    cell: (info) => (
      <ImageThumbnail
        images={info.getValue() ?? []}
        alt="Image"
        lazyPreview={true}
        entity={entity}
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
 * Creates a column that displays a list of related entities as inline links.
 */
export function createEntityInlineLinkColumn<
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
    filterConfig?: FilterConfig;
    enableSorting?: boolean;
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
      enableSorting: options?.enableSorting ?? false,
      meta: {
        className: options?.className
          ? `${options.className} overflow-hidden`
          : undefined,
        filterConfig: options?.filterConfig,
        mobile: options?.mobile,
      },
      cell: (info) => {
        let items = info.getValue() ?? [];
        if (options?.dedupe) {
          items = uniqBy(items, (item) => item.id);
        }
        return (
          <EntityInlineLinkList
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
    enableSorting?: boolean;
    /** Show compact view (no grid) - defaults to true for table columns */
    compact?: boolean;
  },
) {
  const compact = options?.compact ?? true;
  return columnHelper.display({
    id: options?.id ?? "unitMappings",
    header: options?.header ?? "Unit Mappings",
    enableSorting: options?.enableSorting ?? false,
    meta: {
      className:
        options?.className ?? (compact ? "min-w-0 w-32" : "w-96 max-w-96"),
    },
    cell: (info) => {
      const entity = info.row.original;
      const mappings = mappingsMap[entity.id] ?? [];
      return (
        <div className="w-full">
          <UnitMappingDisplay
            mappings={mappings}
            title=""
            compact={compact}
            showTier={compact}
          />
        </div>
      );
    },
  });
}

export interface InventoryEntryBase {
  id: string;
  amount: Amount;
  // Optional related entities - either location (in ProductList) or product (in LocationList)
  location?: { id: string; name: string; type: LocationType };
  product?: { id: string; name: string; manufacturer: string };
}

// Discriminated union for inventory column entity types
export type InventoryRelatedEntity =
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
    id?: string;
    header?: string;
    className?: string;
    enableSorting?: boolean;
    /** Layout variant: 'stacked' shows amounts then links, 'inline' shows amount+link per row */
    layout?: "stacked" | "inline";
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
    /** Filter configuration for inline header filter (e.g. presence filter) */
    filterConfig?: FilterConfig;
    /**
     * When set, rows with entries get a hover-revealed pencil that opens a
     * quick-edit surface (e.g. the per-entry inventory dialog). A pencil
     * affordance rather than a whole-cell click target: the entry links inside
     * the cell must stay navigable, and interactive-inside-interactive nesting
     * is invalid.
     */
    onQuickEdit?: (row: T) => void;
    /**
     * Inline edit + clipboard on the 0/1-entry cases: an `EditableEntityCell`
     * (pencil trigger) lets you move the single entry's location, or create a
     * new entry at a picked location when there are none. Only meaningful for
     * entity === "location" + layout === "inline" — ignored otherwise (e.g.
     * LocationList's Products column, or the "stacked" layout).
     */
    inlineEdit?: {
      /** WithLocationSearch — injected so unit tests can stub it. */
      SearchProvider: (props: WithEntitySearchProps<LocationId>) => ReactNode;
      onMoveEntry: (entry: TEntry, locationId: LocationId) => Promise<void>;
      onCreateEntry: (row: T, locationId: LocationId) => Promise<void>;
    };
  },
) {
  const layout = options?.layout ?? "inline";

  return columnHelper.accessor((row) => row[accessor] as TEntry[], {
    id: options?.id ?? String(accessor),
    header:
      options?.header ?? (entity === "location" ? "Locations" : "Products"),
    enableSorting: options?.enableSorting ?? false,
    meta: {
      className: options?.className ?? "min-w-0 w-40 max-w-56",
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
    },
    cell: (info) => (
      <InventoryEntriesCell
        entries={info.getValue() ?? []}
        entity={entity}
        getRelatedEntity={getRelatedEntity as never}
        layout={layout}
        row={info.row.original}
        onQuickEdit={options?.onQuickEdit}
        inlineEdit={
          entity === "location" && layout === "inline"
            ? options?.inlineEdit
            : undefined
        }
      />
    ),
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
            // icon-sm (24px) + the cell's 4px vertical padding = the 28px
            // compact row exactly; anything larger stretches every row and
            // silently defeats the density ladder.
            render={<Button variant="ghost" size="icon-sm" />}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </DropdownMenuTrigger>
          {/* The mobile card's row is a click-through to the detail page —
              without this, an item click (React's synthetic events bubble
              through the portal's React-tree parent, not just the real DOM)
              falls through to the row's onClick and navigates away instead
              of running the action. */}
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
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
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /** Override the default display (e.g. muted/truncated notes). */
    renderValue?: (value: string | null) => ReactNode;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: string | null, row: T) => Promise<void>;
    };
  },
) {
  const renderValue =
    options?.renderValue ?? ((v: string | null) => (v ? v : <NoneValue />));

  return columnHelper.accessor((row) => row[accessor] as string | null, {
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
            value={value}
            onSave={(newVal) =>
              options.editable!.onSave(newVal, info.row.original)
            }
            clipboard={textCellClipboard(
              `${String(accessor)}:text`,
              value,
              (v) => options.editable!.onSave(v, info.row.original),
            )}
            config={{ type: "text", placeholder: options?.placeholder }}
            renderValue={renderValue}
          />
        );
      }

      return renderValue(value);
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
    /**
     * Render 0 as the muted dash instead of "$0.00" (default true — a zero
     * price/cost in cubby means "unset", not "free"). Pass false for columns
     * where zero is a real value.
     */
    zeroAsEmpty?: boolean;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: number | null, row: T) => Promise<void>;
    };
  },
) {
  const zeroAsEmpty = options?.zeroAsEmpty ?? true;
  const isEmpty = (v: number | null | undefined): v is null | undefined | 0 =>
    v === null || v === undefined || (zeroAsEmpty && v === 0);
  return columnHelper.accessor((row) => row[accessor] as number | null, {
    id: String(accessor),
    header: options?.header,
    meta: {
      numeric: true,
      className: options?.className ?? "w-20",
      mobile: options?.mobile,
    },
    footer: (info) => {
      // Prefer the server's full-filtered-set aggregate — the client only
      // holds loaded pages, so a row reduction under-reports.
      const serverSum =
        info.table.options.meta?.serverTotals?.sums?.[info.column.id];
      const total =
        serverSum ??
        info.table.getFilteredRowModel().rows.reduce((acc, row) => {
          const val = row.getValue<number | null>(info.column.id);
          return val != null ? acc + val : acc;
        }, 0);
      if (total === 0) return null;
      return (
        <span className="font-mono text-positive tabular-nums">
          {formatCurrency(total)}
        </span>
      );
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
            clipboard={numberCellClipboard(
              `${String(accessor)}:currency`,
              val,
              (v) => options.editable!.onSave(v, info.row.original),
            )}
            config={{ type: "currency" }}
            renderValue={(v) =>
              isEmpty(v) ? (
                <NoneValue />
              ) : (
                <span className="text-positive">{formatCurrency(v)}</span>
              )
            }
          />
        );
      }

      if (isEmpty(val)) return <NoneValue />;
      return <span className="text-positive">{formatCurrency(val)}</span>;
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

// Branded id per pickable relation entity (usda-food has no picker).
type SingleEntityIdMap = {
  ingredient: IngredientId;
  product: ProductId;
  recipe: RecipeId;
  location: LocationId;
};

// entity → async search provider + row-summary → ComboboxItem builder, for the
// inline entity editor. The `as never` on SearchProvider erases the per-entity
// branding so the values coexist in one record; call sites re-narrow via
// SingleEntityIdMap.
const entityPickers = {
  ingredient: {
    SearchProvider: WithIngredientSearch as never,
    buildItem: buildIngredientComboboxItem as never,
  },
  product: {
    SearchProvider: WithProductSearch as never,
    buildItem: buildProductComboboxItem as never,
  },
  recipe: {
    SearchProvider: WithRecipeSearch as never,
    buildItem: buildRecipeComboboxItem as never,
  },
  location: {
    SearchProvider: WithLocationSearch as never,
    buildItem: buildLocationComboboxItem as never,
  },
} satisfies Record<keyof SingleEntityIdMap, unknown>;

/**
 * Clipboard spec for entity-picker cells. `entity:<name>` kinds deliberately
 * paste across tables (a location copied on the Locations page pastes into
 * any location cell). Text paste is rejected — id resolution by name would be
 * guesswork; server-side validation still applies to the pasted id.
 */
export function entityCellClipboard(
  entity: string,
  item: ComboboxItem | null,
  save: (id: never) => Promise<void>,
): CellClipboardSpec {
  return {
    kindKey: `entity:${entity}`,
    getCopyPayload: () =>
      item ? { text: item.name, json: { id: item.id, name: item.name } } : null,
    onPasteValue: async ({ json }) => {
      const pasted = json as { id?: unknown; name?: unknown } | undefined;
      if (
        !pasted ||
        typeof pasted.id !== "string" ||
        typeof pasted.name !== "string"
      ) {
        throw new Error(`Paste a ${entity} cell here`);
      }
      await save(pasted.id as never);
      return { id: pasted.id, name: pasted.name };
    },
  };
}

interface SingleEntityEditableConfig<T, TId extends string> {
  onSave: (newId: TId | null, row: T) => Promise<void>;
  /** Allow saving null (clear the relation). */
  clearable?: boolean;
  /** Hide rows from the dropdown (e.g. a location can't be its own parent). */
  filterItems?: (item: ComboboxItem<TId>, row: T) => boolean;
}

/**
 * Creates a column that displays a single related entity as an inline link.
 * Shows NoneValue when the entity is null/undefined.
 * Optionally supports inline editing (async entity picker) via `editable` —
 * available for every entity except `usda-food` (no generic picker).
 */
export function createSingleEntityInlineLinkColumn<
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
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    enableSorting?: boolean;
    editable?: TEntity extends keyof SingleEntityIdMap
      ? SingleEntityEditableConfig<T, SingleEntityIdMap[TEntity]>
      : never;
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
      enableSorting: options?.enableSorting ?? false,
      meta: {
        className: options?.className,
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
      },
      cell: (info) => {
        const item = info.getValue();
        const editable = options?.editable as
          | SingleEntityEditableConfig<T, string>
          | undefined;

        if (editable && entity !== "usda-food") {
          const picker = entityPickers[entity as keyof SingleEntityIdMap];
          const buildItem = picker.buildItem as (
            data: NonNullable<typeof item>,
          ) => ComboboxItem;
          const row = info.row.original;
          const current = item ? buildItem(item) : null;
          return (
            <EditableEntityCell
              value={current}
              label={entity}
              clearable={editable.clearable}
              filterItems={
                editable.filterItems
                  ? (ci) => editable.filterItems!(ci, row)
                  : undefined
              }
              onSave={(newId) => editable.onSave(newId, row)}
              clipboard={entityCellClipboard(entity, current, (id) =>
                editable.onSave(id, row),
              )}
              SearchProvider={picker.SearchProvider}
              renderValue={(v) => {
                if (!v) return <NoneValue />;
                // Keep the real inline link while the display matches the row
                // data; a transient optimistic value renders as plain text
                // until the invalidated query restores the relation summary.
                // ("id" in item is a type guard only — usda-food, the one
                // id-less member, can't reach the editable branch.)
                if (item && "id" in item && v.id === item.id) {
                  return (
                    <EntityInlineLink
                      entity={entity}
                      data={item as never}
                      compact={compact}
                    />
                  );
                }
                return <span className="truncate">{v.name}</span>;
              }}
            />
          );
        }

        if (!item) return <NoneValue />;
        return (
          <EntityInlineLink
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
            clipboard={selectCellClipboard(
              `${String(accessor)}:select`,
              (value as string | null) ?? null,
              options.selectOptions,
              (v) => options.editable!.onSave(v as T[K], info.row.original),
            )}
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
 * Shows NoneValue when the value is null/undefined.
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
        mono: variant === "mono",
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
              clipboard={textCellClipboard(
                `${String(accessor)}:text`,
                value !== null && value !== undefined ? String(value) : null,
                (v) => options.editable!.onSave(v, info.row.original),
              )}
              config={{ type: "text" }}
              renderValue={(v) => {
                if (v === null || v === undefined || v === "") {
                  return <NoneValue />;
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

        if (value === null || value === undefined) return <NoneValue />;
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
  const fallback = options?.fallback ?? <NoneValue />;

  return columnHelper.accessor((row) => row[accessor] as string | Date | null, {
    id: String(accessor),
    header: options?.header,
    meta: {
      className: options?.className,
      mono: true,
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
    className?: string;
    onSave: (newAmount: Amount, row: T) => Promise<void>;
    /** Get unit mappings for price display (optional) */
    getUnitMappings?: (row: T) => UnitMapping[];
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
    /** Wrap the display-mode content (e.g. keep a detail-page link). */
    renderDisplay?: (content: ReactNode, row: T) => ReactNode;
  },
) {
  return columnHelper.accessor((row) => row[accessor] as Amount, {
    id: String(accessor),
    header: options.header ?? "Amount",
    meta: {
      numeric: true,
      className: cn("w-40", options.className),
      mobile: options.mobile,
    },
    cell: (info) => {
      const amount = info.getValue();
      const row = info.row.original;
      const unitMappings = options.getUnitMappings?.(row);

      const saveAmount = async (next: Amount) => {
        await options.onSave(next, row);
        return next;
      };

      return (
        <EditableAmountCell
          amount={amount}
          unitMappings={unitMappings}
          onSave={(newAmount) => options.onSave(newAmount, row)}
          clipboard={{
            kindKey: `${String(accessor)}:amount`,
            getCopyPayload: () => ({
              text: `${amount.value} ${amount.unit}`.trim(),
              json: { value: amount.value, unit: amount.unit },
            }),
            onPasteValue: async ({ json, text }) => {
              const typed = json as
                | { value?: unknown; unit?: unknown }
                | undefined;
              if (typed && typeof typed.value === "number") {
                return saveAmount({
                  value: typed.value,
                  unit: typeof typed.unit === "string" ? typed.unit : "",
                });
              }
              // Text like "5 each" / "2.5 lb" / bare "3".
              const match = (text ?? "")
                .trim()
                .match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/);
              const parsedValue = match?.[1]
                ? Number.parseFloat(match[1])
                : Number.NaN;
              if (!match || Number.isNaN(parsedValue)) {
                throw new Error("Pasted value is not an amount");
              }
              return saveAmount({
                value: parsedValue,
                unit: (match[2] ?? "").trim(),
              });
            },
          }}
          renderDisplay={
            options.renderDisplay
              ? (content) => options.renderDisplay!(content, row)
              : undefined
          }
        />
      );
    },
  });
}
