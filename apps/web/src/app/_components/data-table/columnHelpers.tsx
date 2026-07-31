import type { Amount } from "@cubby/schemas/codec";
import type { Entity } from "@cubby/schemas/entity";
import {
  type IngredientId,
  type LocationId,
  type ProductId,
  type ProjectId,
  type RecipeId,
  unsafeProductId,
  unsafeProjectId,
} from "@cubby/schemas/identifiers";
import { isDocumentFile } from "@cubby/schemas/image";
import type { LocationType } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import type { CellContext, ColumnHelper } from "@tanstack/react-table";
import { format } from "date-fns";
import { uniqBy } from "es-toolkit";
import { ChevronRight, Eye, ImageIcon, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Row } from "~/components/layout";
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
import type {
  EntityDetailParams,
  EntityDetailRoute,
} from "~/entities/entities";
import { entities } from "~/entities/entities";
import { multiSelectFilterFn, multiSelectFilterFnBy } from "~/entities/filters";
import { type BaseKind, gradedKinds } from "~/lib/conversion-coverage";
import { parsePlainDate } from "~/lib/plain-date";
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
  WithProjectSearch,
  WithRecipeSearch,
} from "../combobox/with-search-hook";
import { EntityInlineLink } from "../EntityInlineLink";
import { EntityInlineLinkList } from "../EntityInlineLinkList";
import { HoverableTimestamp } from "../HoverableTimestamp";
import { ImageThumbnail } from "../table/ImageThumbnail";
import { TableLink } from "../table/TableLink";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import {
  amountCellData,
  type ColumnCellData,
  entityCellData,
  numberCellData,
  selectCellData,
  specFromCellData,
  textCellData,
  timestampCellData,
} from "./cell-data";
import {
  EditableAmountCell,
  EditableCell,
  type FilterableComboboxItem,
} from "./editable-cell";
import { EditableEntityCell } from "./editable-entity-cell";
import type {
  InventoryEntryBase,
  InventoryRelatedEntity,
} from "./inventory-column-helpers";
import { InventoryEntriesCell } from "./inventory-entries-cell";
import { nameLabel } from "./name-label";

/** Configuration for inline column header filters */
export interface FilterConfig {
  placeholder: string;
  filterType?: "text" | "select" | "multiselect";
  options?: FilterableComboboxItem[];
  // Add matching-row hints from TanStack's client-side faceting. Off by
  // default because server-backed tables only hold their loaded pages.
  facetCount?: boolean;
}

/**
 * Options for a relation-presence header filter: pages map the selected value
 * ("has" | "none") to the entity's `*PresenceFilter` field, resolved server-side
 * as an exists / is-null condition. Clearing the filter means "any".
 */
// Lives in `entities/filters.ts` (dependency-free, so the vitest `unit` project
// can reach it — it can't resolve a `~/…` .tsx). Re-exported here because this
// is where every column def picks it up.
export { multiSelectFilterFn };

/** Multiselect filterFn for an entity-reference column, matching on its id. */
const projectRefFilterFn = multiSelectFilterFnBy(
  (v) => (v as { id?: string | null } | null)?.id ?? null,
);

/**
 * Sorts an entity-reference column ({id, name}) by name.
 *
 * REQUIRED on any column with an object accessor that allows sorting. TanStack's
 * `getAutoSortingFn` sees no string/Date and falls back to `sortingFns.basic`
 * (`a === b ? 0 : a > b ? 1 : -1`) — for two distinct objects BOTH comparisons
 * are false, so it returns -1 for every pair. That's an inconsistent
 * comparator, and Array.sort on one yields an arbitrary permutation, not an
 * unsorted list.
 *
 * Nulls last in both directions, matching the server's convention
 * (`buildOrderBy` in database-helpers/query.ts) so a client-sorted table and a
 * server-sorted one agree.
 */
function entityRefSortingFn(
  a: { getValue: (id: string) => unknown },
  b: { getValue: (id: string) => unknown },
  columnId: string,
): number {
  const nameOf = (row: { getValue: (id: string) => unknown }) =>
    (row.getValue(columnId) as { name?: string | null } | null)?.name ?? null;
  const left = nameOf(a);
  const right = nameOf(b);
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left.localeCompare(right);
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
  /**
   * Shorter label for the mobile spec grid's label gutter, which is much
   * narrower than a desktop header cell. Defaults to the column's own string
   * `header`; set this only where that would truncate (e.g. "Manufacturer").
   */
  label?: string;
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
    /**
     * Column-level copy/paste descriptor. Set by the column factories; read by
     * the range copy/paste engine (and adapted per-row into a single-cell
     * `CellClipboardSpec` via `specFromCellData`).
     */
    cellData?: ColumnCellData<TData>;
  }
}

interface BaseRow {
  id: string | number;
  // The public id. Absent on `image` rows (the one entity `createNameColumn`
  // links that stays keyed on its uuid) and on rows from an entity whose
  // schema hasn't grown a `shortcode` yet — `nameColumnParams` below falls
  // back to `id` in both cases rather than mislabeling a uuid as one.
  shortcode?: string;
  // Nullable: `meal.name` is optional (an unnamed meal is identified by its
  // date). Widened from `string` so such entities can use these factories at
  // all — see `emptyLabel` on createNameColumn.
  name?: string | null;
  createdAt?: string | Date;
}

/**
 * `TableLink` params for an entity's own row — `{ id }` for `image` (the one
 * `createNameColumn` entity with no shortcode route), `{ shortcode }`
 * everywhere else. Falls back to the row's `id` when `shortcode` is absent
 * (an entity whose schema hasn't grown one yet) rather than a hard crash;
 * that fallback produces a dead link, same as before this entity gains one.
 */
function nameColumnParams(
  entity: Entity,
  row: BaseRow,
): { id: string } | { shortcode: string } {
  if (entity === "image") return { id: String(row.id) };
  return { shortcode: row.shortcode ?? String(row.id) };
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
     * `min-w-*` floor does nothing — an explicit width is the only lever.
     * `w-64` holds a readable 16rem on dense tables (many columns) instead of
     * collapsing to a few characters. On a table with room to spare it also
     * grows: leftover width is distributed across the sized columns in
     * proportion to their widths, so this reads as a *share* as much as a size.
     */
    className?: string;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: string, row: T) => Promise<void>;
    };
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
    /**
     * Override the header label. Defaults to the field name (TanStack's
     * column-id fallback), which reads fine as "NAME" on an index page but not
     * in a table embedded under another entity — there the entity itself is the
     * label ("Task", "Expense").
     */
    header?: string;
    /**
     * Extra content rendered inline after the name (e.g. a subtask-count
     * badge) — return `undefined`/`null` for rows with nothing to show.
     */
    nameSuffix?: (row: T) => ReactNode;
    /**
     * Extra content rendered inline BEFORE the name — a brand mark or avatar that
     * identifies the row at a glance (the vendor roster's logo glyph).
     *
     * Separate from `nameSuffix` because leading and trailing content mean
     * different things: a suffix is a secondary affordance about the row, a prefix
     * is part of how you recognize it. Putting a logo in `nameSuffix` reads
     * backwards. Return `undefined`/`null` for rows with nothing to show.
     */
    namePrefix?: (row: T) => ReactNode;
    /**
     * Render a tree expand/collapse affordance: a depth-proportional left
     * indent plus a chevron toggle on rows that `getCanExpand()` (a fixed-width
     * spacer keeps leaf names aligned). Only meaningful when the table wires
     * `getSubRows`/`getExpandedRowModel`; inert (byte-identical output) when
     * unset, so every non-tree entity table renders exactly as before.
     */
    expandable?: boolean;
    /**
     * Label to render when the row's name is null/empty. The entity stays
     * clickable and readable (see the "entity names are always readable and
     * always clickable" rule) instead of showing a blank link — or, before
     * this existed, the literal string "null".
     */
    emptyLabel?: (row: T) => string;
  },
) {
  const entityConfig = entities[entity];
  const cellData = textCellData<T>(
    "text",
    (row) => {
      const raw = row[fieldName];
      return raw == null ? null : String(raw);
    },
    options?.editable
      ? (row, v) => options.editable!.onSave(v ?? "", row)
      : undefined,
  );
  const config = {
    id: String(fieldName),
    enableSorting: true,
    meta: {
      className: options?.className ?? "w-64",
      filterConfig: options?.filterConfig,
      mobile: options?.mobile ?? { slot: "title", priority: 0 },
      cellData,
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
      // NOT `String(info.getValue())` — that renders a null name as the literal
      // text "null", in the cell, the tooltip, AND the link. `stored` and
      // `value` must stay distinct; see nameLabel's doc.
      const { stored, label: value } = nameLabel(
        info.getValue(),
        info.row.original,
        options?.emptyLabel,
      );
      const suffix = options?.nameSuffix?.(info.row.original);
      const prefix = options?.namePrefix?.(info.row.original);
      // Only wrap when a prefix or suffix is actually present — every other
      // entity's name column renders exactly as before (no extra markup).
      const wrapWithSuffix = (nameEl: ReactNode) =>
        prefix || suffix ? (
          <Row align="center" gap="xs" className="min-w-0">
            {prefix}
            <span className="min-w-0 flex-1 truncate">{nameEl}</span>
            {suffix}
          </Row>
        ) : (
          nameEl
        );

      // Tree affordance: depth indent + chevron toggle. Only applied when the
      // `expandable` option is set (opt-in per table), so non-tree tables emit
      // no extra markup. The indent is data-driven (row.depth), so an inline
      // style is correct here — like the chart bars — not a spacing class.
      const row = info.row;
      const wrapExpandable = (content: ReactNode) => {
        if (!options?.expandable) return content;
        const expanded = row.getIsExpanded();
        return (
          <Row
            align="center"
            gap="xs"
            className="min-w-0"
            style={{ paddingLeft: `${row.depth * 1.25}rem` }}
          >
            {row.getCanExpand() ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-expanded={expanded}
                aria-label={expanded ? "Collapse" : "Expand"}
                // Toggle only — stop the click from bubbling to the row's
                // onRowClick (which opens the preview sheet), matching how the
                // in-cell actions menu / editable links fence their clicks.
                onClick={(e) => {
                  e.stopPropagation();
                  row.getToggleExpandedHandler()();
                }}
              >
                <ChevronRight
                  className={cn(
                    "transition-transform",
                    expanded && "rotate-90",
                  )}
                />
              </Button>
            ) : (
              // Equal-width spacer so leaf names align under parent names.
              <span aria-hidden className="size-6 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{content}</span>
          </Row>
        );
      };

      // If editable, show EditableCell instead of link
      if (options?.editable) {
        return wrapExpandable(
          <EditableCell
            // The EDITOR gets the stored value, not the fallback — prefilling
            // it with a derived label would silently persist that label as a
            // real name on the next save.
            value={stored}
            onSave={(newVal) =>
              options.editable!.onSave(newVal ?? "", info.row.original)
            }
            clipboard={specFromCellData(cellData, info.row.original)}
            config={{ type: "text" }}
            trigger="pencil"
            renderValue={(v) =>
              wrapWithSuffix(
                <Tooltip>
                  <TooltipTrigger render={<span className="block truncate" />}>
                    <TableLink
                      to={entities[entity].routes.detail}
                      params={nameColumnParams(entity, info.row.original)}
                    >
                      {v || value}
                    </TableLink>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    {v || value}
                  </TooltipContent>
                </Tooltip>,
              )
            }
          />,
        );
      }

      return wrapExpandable(
        wrapWithSuffix(
          <Tooltip>
            <TooltipTrigger render={<span className="block truncate" />}>
              <TableLink
                to={entities[entity].routes.detail}
                params={nameColumnParams(entity, info.row.original)}
              >
                {value}
              </TableLink>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              {value}
            </TooltipContent>
          </Tooltip>,
        ),
      );
    },
  };

  // Otherwise TanStack falls back to the column id ("name"), which is what
  // every index page wants.
  const header =
    options?.header ?? (fieldName === "filename" ? "Filename" : undefined);

  return columnHelper.accessor(
    (row) => row[fieldName],
    header ? { ...config, header } : config,
  );
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
      // Copy-only: the display is relative ("5 months ago") but the copy
      // payload is the ISO date-time, which pastes usefully into a spreadsheet.
      cellData: timestampCellData<T>((row) => row.createdAt),
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
    header: () => <ImageIcon className="size-3 text-muted-foreground" />,
    enableSorting: false,
    // h-px trick: setting height:1px on td makes h-full work on children
    // overflow-hidden prevents image from expanding the row. w-16 (not w-10):
    // a select-combobox header filter renders in this column and needs room
    // for more than a bare chevron — widening the shared default affects
    // every entity's image column, which is fine (they're all this narrow
    // for the same "just a thumbnail" reason).
    meta: {
      className: cn("h-px w-16 overflow-hidden px-0 py-0", options?.className),
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
export function createUnitMappingsColumn<
  // `ingredient.naKinds` is the coverage opt-out; optional so the ingredient
  // list (whose rows ARE the ingredient) and any future caller still fit.
  T extends { id: string; ingredient?: { naKinds?: BaseKind[] | null } | null },
>(
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
            // Grade against the linked ingredient's applicable kinds, same as
            // the Problems panel and the enrichment workbench. Without this the
            // list graded against all four BASE_KINDS and disagreed with both —
            // an ingredient that opted out of `volume` read worse here than on
            // the page you'd go to act on it.
            kinds={gradedKinds(entity.ingredient?.naKinds)}
          />
        </div>
      );
    },
  });
}

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
export function createActionsColumn<
  T extends { id: string | number; shortcode?: string },
>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  options?: ActionsColumnOptions<T>,
) {
  return createActionsColumnBase(
    columnHelper,
    (row) => ({
      to: entities[entity].routes.detail,
      params: nameColumnParams(entity, {
        id: row.id,
        shortcode: row.shortcode,
      }),
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
  getLinkProps: (row: T) => {
    to: EntityDetailRoute;
    // `{ id }` covers `image`, the one entity `EntityDetailRoute` includes
    // that isn't shortcode-routed.
    params: EntityDetailParams | { id: string };
  } | null,
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
            <MoreHorizontal className="size-3.5" />
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
                <Eye className="mr-2 size-3.5" />
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
    /**
     * Override the default display (e.g. muted/truncated notes). `row` is
     * there for displays that need a sibling field — the Order # cell pairs
     * its id with the row's vendor to build the "same order" link, since an
     * order id is only unique within a vendor.
     */
    renderValue?: (value: string | null, row: T) => ReactNode;
    /** Keep rich display content beside a dedicated pencil edit button. */
    trigger?: "wrap" | "pencil";
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: string | null, row: T) => Promise<void>;
    };
  },
) {
  const renderValue =
    options?.renderValue ?? ((v: string | null) => (v ? v : <NoneValue />));
  const renderRow = (value: string | null, row: T) => renderValue(value, row);

  const cellData = textCellData<T>(
    "text",
    (row) => row[accessor] as string | null,
    options?.editable
      ? (row, v) => options.editable!.onSave(v, row)
      : undefined,
  );

  return columnHelper.accessor((row) => row[accessor] as string | null, {
    id: String(accessor),
    header: options?.header,
    // Same reason as `createSelectColumn`: a client-side table resolves its
    // filterFn from the ROW value's type, so a string column handed an array
    // would silently match nothing. (Vendor is a text column with a picklist.)
    ...(options?.filterConfig?.filterType === "multiselect"
      ? { filterFn: multiSelectFilterFn }
      : {}),
    meta: {
      className: options?.className,
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
      cellData,
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
            clipboard={specFromCellData(cellData, info.row.original)}
            config={{ type: "text", placeholder: options?.placeholder }}
            trigger={options?.trigger}
            renderValue={(v) => renderRow(v, info.row.original)}
          />
        );
      }

      return renderRow(value, info.row.original);
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
    /** Fraction digits for the displayed value (default 2). Pass 0 for the
     * whole-dollar density the embedded project tables use. */
    decimals?: number;
    /**
     * Tint by sign instead of the flat positive green: a negative value
     * (a credit/contribution — money in) renders `text-positive`, a positive
     * value (spend) renders neutral. Default false keeps the flat-green look.
     */
    signedTone?: boolean;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: number | null, row: T) => Promise<void>;
    };
  },
) {
  const zeroAsEmpty = options?.zeroAsEmpty ?? true;
  const decimals = options?.decimals;
  const signedTone = options?.signedTone ?? false;
  const isEmpty = (v: number | null | undefined): v is null | undefined | 0 =>
    v === null || v === undefined || (zeroAsEmpty && v === 0);
  // Flat green by default; sign-tinted columns leave positive spend neutral and
  // green only the credits, so a refund never reads as spend.
  const toneClass = (v: number) =>
    signedTone ? (v < 0 ? "text-positive" : "font-medium") : "text-positive";
  const cellData = numberCellData<T>(
    "currency",
    (row) => row[accessor] as number | null,
    options?.editable
      ? (row, v) => options.editable!.onSave(v, row)
      : undefined,
  );
  return columnHelper.accessor((row) => row[accessor] as number | null, {
    id: String(accessor),
    header: options?.header,
    meta: {
      numeric: true,
      className: options?.className ?? "w-20",
      mobile: options?.mobile,
      cellData,
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
      // Honor signedTone: a net-positive total (spend) stays neutral, a
      // negative total (net credit) greens — matching the cell values above so
      // the footer never reads as the wrong sign.
      return (
        <span className={cn("font-mono tabular-nums", toneClass(total))}>
          {formatCurrency(total, decimals)}
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
            clipboard={specFromCellData(cellData, info.row.original)}
            config={{ type: "currency" }}
            renderValue={(v) =>
              isEmpty(v) ? (
                <NoneValue />
              ) : (
                <span className={toneClass(v)}>
                  {formatCurrency(v, decimals)}
                </span>
              )
            }
          />
        );
      }

      if (isEmpty(val)) return <NoneValue />;
      return (
        <span className={toneClass(val)}>{formatCurrency(val, decimals)}</span>
      );
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
 *
 * The name fills its column and truncates at the column edge (`truncate`), NOT
 * at `compact`'s fixed 8rem — every caller here declares an explicit width, and
 * clipping a name to 8rem inside a `w-64` column just wastes the column.
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
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    enableSorting?: boolean;
    editable?: TEntity extends keyof SingleEntityIdMap
      ? SingleEntityEditableConfig<T, SingleEntityIdMap[TEntity]>
      : never;
  },
) {
  const editableConfig = options?.editable as
    | SingleEntityEditableConfig<T, string>
    | undefined;
  // usda-food has no generic picker, so it's never copy/pasteable here.
  const cellData: ColumnCellData<T> | undefined =
    entity === "usda-food"
      ? undefined
      : entityCellData<T>(
          entity,
          (row) => {
            const item = row[accessor] as Extract<
              SingleEntityColumnData,
              { entity: TEntity }
            >["data"];
            if (!item) return null;
            const buildItem = entityPickers[entity as keyof SingleEntityIdMap]
              .buildItem as (data: NonNullable<typeof item>) => ComboboxItem;
            return buildItem(item);
          },
          editableConfig
            ? (row, id) => editableConfig.onSave(id, row)
            : undefined,
        );

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
        cellData,
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
              trigger="pencil"
              filterItems={
                editable.filterItems
                  ? (ci) => editable.filterItems!(ci, row)
                  : undefined
              }
              onSave={(newId) => editable.onSave(newId, row)}
              clipboard={cellData ? specFromCellData(cellData, row) : undefined}
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
                      truncate
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
          <EntityInlineLink entity={entity} data={item as never} truncate />
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
    /**
     * Override the derived filter control — pass `manifestFilterConfig(...)`
     * so a table that bypasses `useStandardColumns` (the embedded
     * project-detail tables) still gets the manifest's control type instead of
     * silently staying single-select.
     *
     * Pass `null` for **no filter control at all**. Omitting this prop derives
     * one from `selectOptions`, so a column that must not be filterable here
     * (because something else already owns that concept — e.g. the `/projects`
     * dashboard's server-side status/kind chips) has no other way to say so,
     * and would otherwise silently AND a second, client-side filter on top.
     */
    filterConfig?: FilterConfig | null;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: T[K], row: T) => Promise<void>;
    };
  },
) {
  const cellData = selectCellData<T>(
    (row) => (row[accessor] as string | null) ?? null,
    options.selectOptions,
    options.editable
      ? (row, v) => options.editable!.onSave(v as T[K], row)
      : undefined,
  );
  // `null` is an explicit opt-out (no control); `undefined` derives one.
  const filterConfig: FilterConfig | undefined =
    options.filterConfig === null
      ? undefined
      : (options.filterConfig ?? {
          placeholder: options.placeholder,
          filterType: "select",
          options: options.selectOptions,
        });
  return columnHelper.accessor((row) => row[accessor], {
    id: String(accessor),
    header: options.header,
    // Client-side tables resolve a filterFn from the ROW value's type, so a
    // string column handed an array would silently match nothing.
    ...(filterConfig?.filterType === "multiselect"
      ? { filterFn: multiSelectFilterFn }
      : {}),
    meta: {
      className: options.className,
      mobile: options.mobile,
      filterConfig,
      cellData,
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
            clipboard={specFromCellData(cellData, info.row.original)}
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

  const cellData = textCellData<T>(
    "text",
    (row) => {
      const v = row[accessor] as string | number | null;
      return v !== null && v !== undefined ? String(v) : null;
    },
    options?.editable
      ? (row, v) => options.editable!.onSave(v, row)
      : undefined,
  );

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
        cellData,
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
              clipboard={specFromCellData(cellData, info.row.original)}
              config={{ type: "text" }}
              trigger="pencil"
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
      // Copy-only ISO date-time (see createCreatedAtColumn).
      cellData: timestampCellData<T>(
        (row) => row[accessor] as string | Date | null,
      ),
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
  const cellData = amountCellData<T>(
    (row) => row[accessor] as Amount,
    (row, amount) => options.onSave(amount, row),
  );
  return columnHelper.accessor((row) => row[accessor] as Amount, {
    id: String(accessor),
    header: options.header ?? "Amount",
    meta: {
      numeric: true,
      className: cn("w-40", options.className),
      mobile: options.mobile,
      cellData,
    },
    cell: (info) => {
      const amount = info.getValue();
      const row = info.row.original;
      const unitMappings = options.getUnitMappings?.(row);

      return (
        <EditableAmountCell
          amount={amount}
          unitMappings={unitMappings}
          onSave={(newAmount) => options.onSave(newAmount, row)}
          clipboard={specFromCellData(cellData, row)}
          trigger={options.renderDisplay ? "pencil" : "wrap"}
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

/**
 * Creates a column for a plain "YYYY-MM-DD" calendar date (task `dueDate`,
 * expense `date`) — an absolute "MMM d, yyyy", not the relative "5m ago" of
 * {@link createTimestampColumn} (which is for full timestamps and reads oddly
 * for a date that can be in the future). Read-only by default; pass
 * `editable` for an inline `EditableCell` date-picker.
 */
export function createPlainDateColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options?: {
    header?: string;
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /** Enable inline editing */
    editable?: {
      onSave: (newValue: string | null, row: T) => Promise<void>;
    };
    /**
     * Render a value DERIVED from the row instead of the raw `row[accessor]`
     * — e.g. a computed effective date where `accessor` is a manual override
     * column. The inline editor (when `editable` is set) still opens on and
     * saves to the raw `row[accessor]`; only the closed-cell display is
     * overridden, so editing never silently freezes a computed value into a
     * permanent override. `muted` renders the value as `text-muted-foreground`
     * (e.g. to mark a value as computed rather than explicitly set) — the repo's
     * 3-level text hierarchy, not a new opacity tier.
     */
    displayValue?: (row: T) => { value: string | null; muted?: boolean };
  },
) {
  const renderValue = (value: string | null, muted?: boolean) =>
    value ? (
      <span className={muted ? "text-muted-foreground" : undefined}>
        {format(parsePlainDate(value), "MMM d, yyyy")}
      </span>
    ) : (
      <NoneValue />
    );

  // Copy the raw "YYYY-MM-DD" string; paste only when editable (kind "date").
  const cellData = textCellData<T>(
    "date",
    (row) => row[accessor] as string | null,
    options?.editable
      ? (row, v) => options.editable!.onSave(v, row)
      : undefined,
  );

  return columnHelper.accessor((row) => row[accessor] as string | null, {
    id: String(accessor),
    header: options?.header,
    meta: {
      className: options?.className ?? "w-28",
      mono: true,
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
      cellData,
    },
    cell: (info) => {
      const value = info.getValue();
      const row = info.row.original;
      const display = options?.displayValue?.(row);

      if (options?.editable) {
        return (
          <EditableCell
            value={value}
            onSave={(newVal) => options.editable!.onSave(newVal, row)}
            clipboard={specFromCellData(cellData, row)}
            config={{ type: "date" }}
            // EditableCell only calls renderValue in closed/display mode (never
            // while the editor is open), so substituting the row-derived
            // `display` for its passed-through arg is safe — the editor widget
            // still gets the raw `value`/`onSave` and is unaffected.
            //
            // The arg IS the optimistic post-save value though, so prefer it
            // when non-null: saving an override shows the new date immediately
            // instead of waiting for the refetch that recomputes `display`.
            // Clearing an override yields null, which correctly falls through
            // to the derived value the row will settle on.
            renderValue={(optimistic) =>
              renderValue(
                optimistic ?? display?.value ?? value,
                optimistic == null && display?.muted,
              )
            }
          />
        );
      }

      return renderValue(display?.value ?? value, display?.muted);
    },
  });
}

/** A row that carries a project reference as a flat id+name pair (not a
 * nested `{id,name}` object) — the task/expense list shape. */
interface ProjectRefRow {
  projectId: string | null;
  projectName: string | null;
  /** Public id, denormalized next to the name — the link target. */
  projectShortcode: string | null;
}

/**
 * Creates a column linking to a row's parent project (task
 * `projectId`/`projectName`, expense `projectId`/`projectName`). Unlike
 * {@link createSingleEntityInlineLinkColumn}, the source data is a flat
 * id+name pair rather than a nested relation object — that pair doesn't fit
 * `createSingleEntityInlineLinkColumn`'s single-object accessor shape (it
 * would need reshaping the row type), so this gets its own small `editable`
 * option instead of routing project through the generic single-entity helper.
 * Pass `editable` for an inline `EditableEntityCell` project picker
 * (`WithProjectSearch`); omit for the previous display-only behavior.
 */
export function createProjectLinkColumn<T extends ProjectRefRow>(
  columnHelper: ColumnHelper<T>,
  options?: {
    header?: string;
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /** Enable inline editing via an async project picker. `clearable` always
     * on — a task/expense's project is optional. */
    editable?: {
      onSave: (newProjectId: ProjectId | null, row: T) => Promise<void>;
    };
  },
) {
  const cellData = entityCellData<T>(
    "project",
    (row) =>
      row.projectId && row.projectName
        ? { id: row.projectId, name: row.projectName }
        : null,
    options?.editable
      ? (row, id) => options.editable!.onSave(unsafeProjectId(id), row)
      : undefined,
  );
  return columnHelper.accessor(
    (row) => ({ id: row.projectId, name: row.projectName }),
    {
      id: "project",
      header: options?.header ?? "Project",
      sortingFn: entityRefSortingFn,
      // Client-side tables (the embedded project-detail lists) filter this
      // column by project id. The accessor yields an object, which the default
      // stringifying comparison turns into "[object Object]" — so the roster
      // matched nothing and `(none)` never found an unassigned row.
      ...(options?.filterConfig?.filterType === "multiselect"
        ? { filterFn: projectRefFilterFn }
        : {}),
      meta: {
        className: options?.className,
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
        cellData,
      },
      cell: (info) => {
        const { id, name } = info.getValue();

        if (options?.editable) {
          const current: ComboboxItem<ProjectId> | null =
            id && name ? { id: unsafeProjectId(id), name } : null;
          const row = info.row.original;
          return (
            <EditableEntityCell
              value={current}
              label="project"
              clearable
              trigger="pencil"
              onSave={(newId) => options.editable!.onSave(newId, row)}
              clipboard={specFromCellData(cellData, row)}
              SearchProvider={WithProjectSearch}
              renderValue={(v) => {
                if (!v) return <NoneValue />;
                return (
                  // The combobox value carries the project's uuid; the row
                  // carries its public id, denormalized alongside `projectName`.
                  <TableLink
                    to="/projects/$shortcode"
                    params={{ shortcode: row.projectShortcode ?? "" }}
                    variant="muted"
                  >
                    {v.name}
                  </TableLink>
                );
              }}
            />
          );
        }

        if (!id || !name) return <NoneValue />;
        return (
          <EntityInlineLink entity="project" data={{ id, name }} truncate />
        );
      },
    },
  );
}

/** A row that carries a product reference as a flat id+name pair (not a
 * nested `{id,name}` object) — the expense list shape. */
interface ProductRefRow {
  productId: string | null;
  productName: string | null;
  productShortcode: string | null;
}

/** A task's product subject uses explicit field names so it cannot be confused
 * with an expense's purchased product in shared row types. */
interface SubjectProductRefRow {
  subjectProductId: string | null;
  subjectProductName: string | null;
  subjectProductShortcode: string | null;
}

/**
 * Creates a column linking to a row's associated product (expense
 * `productId`/`productName`). Mirrors {@link createProjectLinkColumn} — see
 * its doc comment for why this gets its own small `editable` option instead
 * of routing through the generic single-entity helper.
 * Pass `editable` for an inline `EditableEntityCell` product picker
 * (`WithProductSearch`); omit for the previous display-only behavior.
 */
export function createProductLinkColumn<T extends ProductRefRow>(
  columnHelper: ColumnHelper<T>,
  options?: {
    header?: string;
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /** Enable inline editing via an async product picker. `clearable` always
     * on — an expense's product is optional. */
    editable?: {
      onSave: (newProductId: ProductId | null, row: T) => Promise<void>;
    };
  },
) {
  const cellData = entityCellData<T>(
    "product",
    (row) =>
      row.productId && row.productName
        ? { id: row.productId, name: row.productName }
        : null,
    options?.editable
      ? (row, id) => options.editable!.onSave(unsafeProductId(id), row)
      : undefined,
  );
  return columnHelper.accessor(
    (row) => ({ id: row.productId, name: row.productName }),
    {
      id: "product",
      header: options?.header ?? "Product",
      sortingFn: entityRefSortingFn,
      meta: {
        className: options?.className,
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
        cellData,
      },
      cell: (info) => {
        const { id, name } = info.getValue();

        if (options?.editable) {
          const current: ComboboxItem<ProductId> | null =
            id && name ? { id: unsafeProductId(id), name } : null;
          const row = info.row.original;
          return (
            <EditableEntityCell
              value={current}
              label="product"
              clearable
              trigger="pencil"
              onSave={(newId) => options.editable!.onSave(newId, row)}
              clipboard={specFromCellData(cellData, row)}
              SearchProvider={WithProductSearch}
              renderValue={(v) => {
                if (!v) return <NoneValue />;
                return (
                  // The combobox value carries the product's uuid; the row
                  // carries its public id, denormalized alongside `productName`.
                  <TableLink
                    to="/products/$shortcode"
                    params={{ shortcode: row.productShortcode ?? "" }}
                    variant="muted"
                  >
                    {v.name}
                  </TableLink>
                );
              }}
            />
          );
        }

        if (!id || !name) return <NoneValue />;
        return (
          <EntityInlineLink entity="product" data={{ id, name }} truncate />
        );
      },
    },
  );
}

/**
 * Creates the task list's "For" column. This deliberately mirrors
 * {@link createProductLinkColumn}, while preserving the domain-specific
 * `subjectProduct*` field names all the way to the mutation boundary.
 */
export function createSubjectProductLinkColumn<T extends SubjectProductRefRow>(
  columnHelper: ColumnHelper<T>,
  options?: {
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    editable?: {
      onSave: (newProductId: ProductId | null, row: T) => Promise<void>;
    };
  },
) {
  const cellData = entityCellData<T>(
    "product",
    (row) =>
      row.subjectProductId && row.subjectProductName
        ? { id: row.subjectProductId, name: row.subjectProductName }
        : null,
    options?.editable
      ? (row, id) => options.editable!.onSave(unsafeProductId(id), row)
      : undefined,
  );

  return columnHelper.accessor(
    (row) => ({
      id: row.subjectProductId,
      name: row.subjectProductName,
    }),
    {
      id: "subjectProduct",
      header: "For",
      sortingFn: entityRefSortingFn,
      meta: {
        className: options?.className,
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
        cellData,
      },
      cell: (info) => {
        const { id, name } = info.getValue();

        if (options?.editable) {
          const current: ComboboxItem<ProductId> | null =
            id && name ? { id: unsafeProductId(id), name } : null;
          const row = info.row.original;
          return (
            <EditableEntityCell
              value={current}
              label="product"
              clearable
              trigger="pencil"
              onSave={(newId) => options.editable!.onSave(newId, row)}
              clipboard={specFromCellData(cellData, row)}
              SearchProvider={WithProductSearch}
              renderValue={(v) => {
                if (!v) return <NoneValue />;
                return (
                  // Task rows denormalize `subjectProductShortcode` next to
                  // `subjectProductName`, same as the project link above.
                  <TableLink
                    to="/products/$shortcode"
                    params={{ shortcode: row.subjectProductShortcode ?? "" }}
                    variant="muted"
                  >
                    {v.name}
                  </TableLink>
                );
              }}
            />
          );
        }

        if (!id || !name) return <NoneValue />;
        return (
          <EntityInlineLink entity="product" data={{ id, name }} truncate />
        );
      },
    },
  );
}
