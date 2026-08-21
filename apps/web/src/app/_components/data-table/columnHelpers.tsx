import type { Amount } from "@cubby/schemas/codec";
import type { Entity } from "@cubby/schemas/entity";
import {
  type IngredientShortcode,
  type LocationShortcode,
  type ProductShortcode,
  type ProjectShortcode,
  type RecipeShortcode,
  unsafeProductShortcode,
  unsafeProjectShortcode,
} from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { LocationType } from "@cubby/schemas/location";
import type { ProductPricingOut } from "@cubby/schemas/product";
import { Link } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { format } from "date-fns";
import { uniqBy } from "es-toolkit";
import {
  ChevronRight,
  ClipboardCopy,
  Eye,
  ImageIcon,
  MoreHorizontal,
  Pin,
  Sigma,
} from "lucide-react";
import type { ReactNode } from "react";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { DotLabel } from "~/components/ui/dot-label";
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
import { copyShortcodes } from "~/lib/clipboard";
import { type BaseKind, gradedKinds } from "~/lib/conversion-coverage";
import { parsePlainDate } from "~/lib/plain-date";
import { cn, formatCurrency } from "~/lib/utils";
import {
  buildIngredientComboboxItem,
  buildLocationComboboxItem,
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
  dateCellData,
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
import type {
  CubbyCellContext as CellContext,
  CubbyColumnHelper as ColumnHelper,
} from "./table-features";
import type { FilterConfig, MobileColumnMeta } from "./table-meta";

export type { FilterConfig, MobileColumnMeta, MobileSlot } from "./table-meta";

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

interface BaseRow {
  id: string | number;
  // Nullable: `meal.name` is optional (an unnamed meal is identified by its
  // date). Widened from `string` so such entities can use these factories at
  // all — see `emptyLabel` on createNameColumn.
  name?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

/**
 * `TableLink` params for an entity's own row — `{ id }` for `image` and the
 * canonical public `{ shortcode: row.id }` route parameter everywhere else.
 */
function nameColumnParams(
  entity: Entity,
  row: BaseRow,
): { id: string } | { shortcode: string } {
  if (entity === "image") return { id: String(row.id) };
  return { shortcode: String(row.id) };
}

/** Where a row's name and its "View details" action point. */
type EntityRowLink = {
  to: EntityDetailRoute;
  // `{ id }` covers `image`, the one entity `EntityDetailRoute` includes that
  // isn't shortcode-routed.
  params: EntityDetailParams | { id: string };
};

/**
 * Resolve a row's detail link per row instead of from the table's own entity.
 *
 * For a table whose rows aren't all the same entity — global search, or a tree
 * whose children are a different entity than its parents (the wishlist's
 * candidate Products nested under a Wish). Returning null renders the name as
 * plain text, for the rare row that names nothing openable.
 */
export type RowLinkResolver<T> = (row: T) => EntityRowLink | null;

const defaultRowLink = <T extends BaseRow>(
  entity: Entity,
): RowLinkResolver<T> => {
  const to = entities[entity].routes.detail;
  return (row) => ({ to, params: nameColumnParams(entity, row) });
};

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
    /**
     * Per-row detail link, for a table whose rows aren't all `entity` (a tree
     * whose children are a different entity than its parents). Defaults to
     * `entity`'s detail route keyed by `row.id`.
     */
    rowLink?: RowLinkResolver<T>;
  },
) {
  const entityConfig = entities[entity];
  const rowLink = options?.rowLink ?? defaultRowLink<T>(entity);
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
      const link = rowLink(info.row.original);
      // A row that names nothing openable still has to be readable, so the
      // unlinked branch keeps the truncation and the full-name tooltip.
      const linkName = (label: ReactNode) =>
        link ? (
          <TableLink to={link.to} params={link.params}>
            {label}
          </TableLink>
        ) : (
          label
        );
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
                    {linkName(v || value)}
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
              {linkName(value)}
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

export function createUpdatedAtColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
) {
  return columnHelper.accessor((row) => row.updatedAt, {
    id: "updatedAt",
    header: "Updated",
    meta: {
      className: "w-32",
      mono: true,
      mobile: { slot: "hidden" },
      cellData: timestampCellData<T>((row) => row.updatedAt),
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
          isDisplayableImageFile({ ...img, contentType: img.contentType }),
      ));
  const { entity } = options;

  return columnHelper.accessor((row) => getImages(row), {
    id: "image",
    header: () => <ImageIcon className="size-3 text-muted-foreground" />,
    enableSorting: false,
    enableHiding: false,
    enablePinning: false,
    enableCellSelection: false,
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
    // Reads `row.original` rather than `info.getValue()` — deliberately, and it
    // is load-bearing whenever `getImages` closes over separately-fetched data
    // (projects hydrate theirs from `image.imagesByProjectIds`, not from the
    // list row). TanStack memoizes each accessor result into `row._valuesCache`
    // and only rebuilds the core row model when `data` changes, NOT when
    // `columns` change — so a rebuilt column def carrying a fresh closure still
    // reads the value cached on the very first render. That froze every project
    // thumbnail at the empty placeholder: the accessor returned the right image
    // when called directly, while `getValue()` kept handing back the `[]` from
    // before the images query resolved.
    cell: (info) => (
      <ImageThumbnail
        images={getImages(info.row.original)}
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
      items: { name: string; id: string; type: LocationType | null }[];
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
      SearchProvider: (
        props: WithEntitySearchProps<LocationShortcode>,
      ) => ReactNode;
      onMoveEntry: (
        entry: TEntry,
        locationId: LocationShortcode,
      ) => Promise<void>;
      onCreateEntry: (row: T, locationId: LocationShortcode) => Promise<void>;
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
  /** Additional actions to render after "View details" */
  extraActions?: (row: T) => ReactNode;
  /**
   * Per-row detail link, for rows that aren't all `entity`. Keep it the same
   * resolver the name column got, or "View details" opens something other than
   * the row the user clicked.
   */
  rowLink?: RowLinkResolver<T>;
}

/**
 * Creates a standard actions column with a dropdown menu.
 * Includes "View details" link by default, with optional extra actions.
 */
export function createActionsColumn<T extends { id: string | number }>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  options?: ActionsColumnOptions<T>,
) {
  return createActionsColumnBase(
    columnHelper,
    options?.rowLink ?? defaultRowLink<T>(entity),
    options?.extraActions,
  );
}

/**
 * Base implementation for actions columns.
 * Use `createActionsColumn` for standard entity tables.
 * Call this directly for polymorphic rows where entity type varies per row.
 */
export function createActionsColumnBase<T extends RowData>(
  columnHelper: ColumnHelper<T>,
  getLinkProps: RowLinkResolver<T>,
  extraActions?: (row: T) => ReactNode,
) {
  return columnHelper.display({
    id: "actions",
    header: "",
    enableSorting: false,
    enableHiding: false,
    enableCellSelection: false,
    size: 40,
    minSize: 40,
    maxSize: 72,
    meta: {
      mobile: { slot: "actions", priority: 100 },
    },
    cell: (info) => {
      const row = info.row.original;
      const linkProps = getLinkProps(row);
      // Read the code off the row's OWN link params rather than `row.id` + the
      // table's entity: that makes it right for polymorphic rows (global
      // search) and absent for `image` — the one entity routed by uuid — with
      // no second roster to keep in sync.
      const shortcode =
        linkProps && "shortcode" in linkProps.params
          ? linkProps.params.shortcode
          : null;

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
                <Eye />
                View details
              </DropdownMenuItem>
            )}
            {shortcode && (
              <DropdownMenuItem
                onClick={() => void copyShortcodes([shortcode])}
              >
                <ClipboardCopy />
                Copy {shortcode}
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
     * Render 0 as the muted dash instead of "$0.00". **Defaults false: the dash
     * means "we don't know", and zero is a known value.**
     *
     * This used to default true, on the theory that "a zero price/cost in cubby
     * means unset, not free". The schema says otherwise — `Expense.cost` books a
     * broken or gifted item as "cost 0 (never null: `cost IS NULL` is already
     * the Unclassified predicate)" (schema.ts, `expense.cost`) — so a genuine
     * $0 (a warranty replacement, a vendor's own $0.00 bundle component row) was
     * indistinguishable from a cost nobody ever recorded. Six of eleven call
     * sites had already passed `false` to escape it, the expense *detail* page
     * rendered the same field as `$0.00`, and the column footer summed the row
     * as 0 while the cell above claimed the value was unknown.
     *
     * Pass true only where zero genuinely encodes "not computable" — and prefer
     * fixing the source to return null instead, so the dash keeps meaning one
     * thing.
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
  const zeroAsEmpty = options?.zeroAsEmpty ?? false;
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
  // Widest realistic formatted value is "-$NNN,NNN.NN" (12 chars, JetBrains
  // Mono); w-20 (80px) clipped it mid-digit with no ellipsis and no way to
  // recover the real number short of opening the row (verified P0). w-32
  // (128px) is the smallest Tailwind step that fits.
  const defaultClassName = "w-32";
  // `truncate` adds the ellipsis the shared cell class doesn't: it clips with
  // `text-overflow: clip`, which silently drops digits with no visual signal.
  // A `title` on the rendered value is the hover backstop either way.
  const renderValue = (v: number | null | undefined) =>
    isEmpty(v) ? (
      <NoneValue />
    ) : (
      <span className={toneClass(v)} title={formatCurrency(v, decimals)}>
        {formatCurrency(v, decimals)}
      </span>
    );
  return columnHelper.accessor((row) => row[accessor] as number | null, {
    id: String(accessor),
    header: options?.header,
    meta: {
      numeric: true,
      className: cn(options?.className ?? defaultClassName, "truncate"),
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
            renderValue={renderValue}
          />
        );
      }

      return renderValue(val);
    },
  });
}

// Entity-specific single data types (nullable)
type SingleEntityColumnData =
  | { entity: "ingredient"; data: { name: string; id: string } | null }
  | {
      entity: "product";
      data: {
        name: string;
        id: string;
        manufacturer: string;
      } | null;
    }
  | { entity: "recipe"; data: { name: string; id: string } | null }
  | {
      entity: "location";
      data: { name: string; id: string; type: LocationType | null } | null;
    }
  | {
      entity: "usda-food";
      data: { fdc_id: number; description: string } | null;
    };

// Branded id per pickable relation entity (usda-food has no picker).
type SingleEntityIdMap = {
  ingredient: IngredientShortcode;
  product: ProductShortcode;
  recipe: RecipeShortcode;
  location: LocationShortcode;
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
    buildItem: ((product: {
      id: string;
      name: string;
      manufacturer: string;
    }) => ({
      id: unsafeProductShortcode(product.id),
      name: `${product.name} (${product.manufacturer})`,
    })) as never,
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
  /**
   * Per-row gate. A false row falls through to the read-only render rather
   * than getting an editor that would fail on save — for a table whose rows
   * come from more than one source, where only some are backed by a writable
   * record. Defaults to editable.
   */
  isEditable?: (row: T) => boolean;
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
          editableConfig?.clearable
            ? (row) => editableConfig.onSave(null, row)
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

        if (
          editable &&
          entity !== "usda-food" &&
          (editable.isEditable?.(info.row.original) ?? true)
        ) {
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
                // (`id in item` is a type guard only — usda-food, the one
                // id-less member, can't reach the editable branch.)
                const currentId = item && "id" in item ? item.id : null;
                if (item && v.id === currentId) {
                  return (
                    <EntityInlineLink
                      displayImage={undefined}
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
          <EntityInlineLink
            displayImage={undefined}
            entity={entity}
            data={item as never}
            truncate
          />
        );
      },
    },
  );
}

/**
 * The one way a small-enum / boolean value renders in a table cell: a quiet
 * colour dot plus the option's own label.
 *
 * Derived from the column's `selectOptions` roster, which already carries
 * `{ value, label, color }` for the filter control and the inline editor — so
 * the roster is the single source of both the wording and the tone, and a cell
 * cannot disagree with the dropdown that edits it. Before this, the same class
 * of value rendered five different ways across 35 columns (bare string, Badge
 * with a tone map, Badge with an inline ternary, DotLabel, icon + text), and
 * several columns printed the raw enum (`needs_data`, `UPLOADED`) because their
 * label lived only in the filter roster the cell never consulted.
 *
 * An unrecognised value falls back to printing itself rather than to `—`:
 * a value the roster forgot is a real stored value, and hiding it behind the
 * unknown-marker is how it would stay forgotten.
 */
export function renderOptionCell(
  value: string | null | undefined,
  options: readonly FilterableComboboxItem[],
): ReactNode {
  if (value == null || value === "") return <NoneValue />;
  const option = options.find((o) => o.value === value);
  return (
    <DotLabel icon={option?.icon} color={option?.color ?? "var(--slate)"}>
      {option?.label ?? value}
    </DotLabel>
  );
}

/**
 * `Product.pricing.source` in prose — the one place this ternary is spelled
 * out, so the detail-page caption and the cell tooltip (below) can't drift
 * apart on what "explicit" / "derived" / "none" mean to a reader.
 */
export function describeProductPricingSource(
  pricing: Pick<ProductPricingOut, "source" | "knownExpenseCount" | "partial">,
): string {
  switch (pricing.source) {
    case "explicit":
      return "Manual override";
    case "derived":
      return `Derived from ${pricing.knownExpenseCount} expense${pricing.knownExpenseCount === 1 ? "" : "s"}${pricing.partial ? " · partial history" : ""}`;
    case "none":
      return "No override or quantified purchase history";
  }
}

/**
 * `Product.price`'s `EditableCell` edits the manual override, but *displays*
 * `pricing.effectivePrice` — the override OR the Expense-derived fallback.
 * Both render as a plain number, so without a cue an override and a derived
 * price (and a cleared override that happens to land on the same digits as
 * the old one) are visually identical. The icon + tooltip here is that cue;
 * shared by the detail page and the list column so the two surfaces can't
 * disagree about what the cell means.
 */
export function renderProductPriceValue(
  pricing: Pick<
    ProductPricingOut,
    "effectivePrice" | "source" | "knownExpenseCount" | "partial"
  >,
): ReactNode {
  if (pricing.effectivePrice === null) return <NoneValue />;
  const Icon = pricing.source === "explicit" ? Pin : Sigma;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex items-center gap-1 text-positive" />
        }
      >
        <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        {formatCurrency(pricing.effectivePrice)}
      </TooltipTrigger>
      <TooltipContent side="top">
        {describeProductPricingSource(pricing)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Label for `Product.price`'s currency-clear control: names the state
 * clearing the override lands on, so the button reads as "go back to the
 * derived price" rather than an unlabelled "clear". Shared by the detail
 * page and the list column so a clear affordance can't say something
 * different on one surface than the other.
 */
export function productPriceClearLabel(
  pricing: Pick<ProductPricingOut, "derivedPrice">,
): string {
  return pricing.derivedPrice !== null
    ? `Revert to ${formatCurrency(pricing.derivedPrice)} (derived)`
    : "Clear override (no derived price on record)";
}

/**
 * A stored boolean rendered and edited like any other small enum.
 *
 * Booleans were the one column class with no factory, so all seven in the app
 * were hand-rolled — and each one picked its own answer for the false case:
 * plain text, a second Badge, or nothing at all. Rendering nothing is the
 * dangerous one, because `false` then looks exactly like "never decided".
 *
 * **Tri-state is the default reading.** `null` is "we don't know" and renders
 * `—`; `false` is a recorded decision and renders its own label. Pass
 * `undecided` to make null *selectable*, which a nullable column needs if a row
 * is ever to go back into an undecided worklist — `Product.stockTracked` is the
 * motivating case, where `null` is the backlog the saved view filters on.
 *
 * Encoded over the existing `select` machinery rather than a new cell kind:
 * paste compatibility is keyed on the base kind (`cell-clipboard-model.ts`), so reusing
 * `"select"` means a copied "Tracked" pastes into any boolean column, and
 * `selectCellData`'s label-or-value matching already accepts the human label as
 * text. A dedicated `"boolean"` kind would have been paste-incompatible with
 * every existing column for no gain.
 */
export function createBooleanColumn<
  T extends Record<string, unknown>,
  K extends keyof T,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options: {
    header?: string;
    placeholder?: string;
    /**
     * The two decided states, as a `{value: "true"|"false", label, color}` roster
     * — build it with `booleanCellOptions` (~/lib/select-options).
     *
     * A roster rather than a `labels` pair plus built-in tones, because "true" is
     * not always the good outcome: `FinancialAccount.provisional` is amber when
     * true and green when false, the inverse of the obvious default. Hardcoding
     * positive/slate here made that column's list cell disagree with its own
     * detail page, and silently turned a deliberately-amber "Planned" expense
     * green. Passing the roster means the column and every other surface that
     * renders the field read from one declaration.
     */
    trueFalseOptions: FilterableComboboxItem[];
    /**
     * Present ⇒ `null` is a real state the editor can return to: the picker
     * gains its clear affordance, its empty state reads with this label, and the
     * clear control is announced as "Clear <label>". Absent ⇒ null still renders
     * `—`, but the editor can only ever move away from it.
     */
    undecided?: { label: string };
    className?: string;
    mobile?: MobileColumnMeta;
    /** `null` opts out of a filter control entirely; omit to derive one. */
    filterConfig?: FilterConfig | null;
    editable?: {
      onSave: (newValue: boolean | null, row: T) => Promise<void>;
    };
  },
) {
  const selectOptions = options.trueFalseOptions;
  const filterPlaceholder = options.placeholder ?? "Set value...";
  // The editor's own empty state names the undecided state where there is one,
  // so clearing has a word attached rather than being an unlabelled ✗.
  const editorPlaceholder = options.undecided?.label ?? filterPlaceholder;
  const encode = (v: unknown): string | null =>
    v === true ? "true" : v === false ? "false" : null;
  const decode = (v: string | null): boolean | null =>
    v === "true" ? true : v === "false" ? false : null;

  const save = options.editable
    ? (row: T, v: string | null) => options.editable!.onSave(decode(v), row)
    : undefined;
  const cellData = selectCellData<T>(
    (row) => encode(row[accessor]),
    selectOptions,
    save,
  );
  const filterConfig: FilterConfig | undefined =
    options.filterConfig === null
      ? undefined
      : (options.filterConfig ?? {
          placeholder: filterPlaceholder,
          filterType: "select",
          options: selectOptions,
        });

  return columnHelper.accessor((row) => encode(row[accessor]), {
    id: String(accessor),
    header: options.header,
    enableSorting: false,
    meta: {
      className: options.className,
      mobile: options.mobile,
      filterConfig,
      cellData,
    },
    cell: (info) => {
      const value = info.getValue();

      if (options.editable) {
        return (
          <EditableCell
            value={value}
            onSave={(next) =>
              options.editable!.onSave(decode(next), info.row.original)
            }
            clipboard={specFromCellData(cellData, info.row.original)}
            config={{
              type: "select",
              options: selectOptions,
              placeholder: editorPlaceholder,
              // Only a column that names an undecided state can be cleared back
              // into it; elsewhere clearing would invent a null the field's
              // schema may not allow.
              clearable: options.undecided !== undefined,
            }}
            renderValue={(v) => renderOptionCell(v, selectOptions)}
          />
        );
      }

      return renderOptionCell(value, selectOptions);
    },
  });
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
    /**
     * Override the default dot + label render. Omit it — the default reads the
     * label and tone straight off `selectOptions`, which is what keeps a cell
     * and its editor in agreement.
     */
    renderCell?: (value: T[K]) => ReactNode;
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
  const renderCell =
    options.renderCell ??
    ((value: T[K]) =>
      renderOptionCell(value as string | null, options.selectOptions));
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
            renderValue={(v) => renderCell(v as T[K])}
          />
        );
      }

      return renderCell(value);
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
    getUnitMappings?: (row: T) => UnitMapping[];
    /** Mobile projection metadata override */
    mobile?: MobileColumnMeta;
    /** Wrap the display-mode content (e.g. keep a detail-page link). */
    renderDisplay?: (content: ReactNode, row: T) => ReactNode;
    /**
     * Per-row gate — see {@link SingleEntityEditableConfig.isEditable}. A false
     * row renders the formatted amount as plain text. Defaults to editable.
     */
    isEditable?: (row: T) => boolean;
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

      if (options.isEditable && !options.isEditable(row)) {
        const display = <span>{tryFormatAmount(amount)}</span>;
        return options.renderDisplay
          ? options.renderDisplay(display, row)
          : display;
      }

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
     * Override the value placed in the date editor. Use with `displayValue`
     * when a row's effective date can come from more than one direct field.
     */
    editValue?: (row: T) => string | null;
    /**
     * Render a value DERIVED from the row instead of the raw `row[accessor]`
     * — e.g. a computed effective date where `accessor` is a manual override
     * column. Unless `editValue` is also supplied, the inline editor still
     * opens on and saves to the raw `row[accessor]`; only the closed-cell
     * display is overridden, so editing never silently freezes a computed
     * value into a permanent override. `muted` renders the value as
     * `text-muted-foreground`
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
  const cellData = dateCellData<T>(
    (row) =>
      options?.editValue
        ? options.editValue(row)
        : (row[accessor] as string | null),
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
        const editableValue = options.editValue
          ? options.editValue(row)
          : value;
        return (
          <EditableCell
            value={editableValue}
            onSave={(newVal) => options.editable!.onSave(newVal, row)}
            clipboard={specFromCellData(cellData, row)}
            config={{ type: "date" }}
            // EditableCell only calls renderValue in closed/display mode (never
            // while the editor is open), so substituting the row-derived
            // `display` for its passed-through arg is safe — the editor widget
            // still gets the configured edit value/onSave and is unaffected.
            //
            // The arg IS the optimistic post-save value though, so prefer it
            // when non-null: saving an override shows the new date immediately
            // instead of waiting for the refetch that recomputes `display`.
            // Clearing an override yields null, which correctly falls through
            // to the derived value the row will settle on.
            renderValue={(optimistic) =>
              renderValue(
                optimistic ?? display?.value ?? editableValue,
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
 * nested `{id,name}` object) — the task/expense list shape. `projectId` is
 * the project's shortcode (per the project shortcode cutover), so it is
 * also the link target — no separate denormalized shortcode field. */
interface ProjectRefRow {
  projectId: string | null;
  projectName: string | null;
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
      onSave: (newProjectId: ProjectShortcode | null, row: T) => Promise<void>;
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
      ? (row, id) => options.editable!.onSave(unsafeProjectShortcode(id), row)
      : undefined,
    options?.editable
      ? (row) => options.editable!.onSave(null, row)
      : undefined,
  );
  return columnHelper.accessor(
    (row) => ({
      id: row.projectId,
      name: row.projectName,
    }),
    {
      id: "project",
      header: options?.header ?? "Project",
      sortFn: entityRefSortingFn,
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
          const current: ComboboxItem<ProjectShortcode> | null =
            id && name ? { id: unsafeProjectShortcode(id), name } : null;
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
                  // `row.projectId` is the project's shortcode (per the
                  // project shortcode cutover) — the same value the combobox
                  // carries, so it doubles as the link target.
                  <TableLink
                    to="/projects/$shortcode"
                    params={{ shortcode: row.projectId ?? "" }}
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
          <EntityInlineLink
            displayImage={undefined}
            entity="project"
            data={{ id, name }}
            truncate
          />
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
}

/** A task's product subject uses explicit field names so it cannot be confused
 * with an expense's purchased product in shared row types. */
interface SubjectProductRefRow {
  subjectProductId: string | null;
  subjectProductName: string | null;
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
      onSave: (newProductId: ProductShortcode | null, row: T) => Promise<void>;
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
      ? (row, id) => options.editable!.onSave(unsafeProductShortcode(id), row)
      : undefined,
    options?.editable
      ? (row) => options.editable!.onSave(null, row)
      : undefined,
  );
  return columnHelper.accessor(
    (row) => ({
      id: row.productId,
      name: row.productName,
    }),
    {
      id: "product",
      header: options?.header ?? "Product",
      sortFn: entityRefSortingFn,
      meta: {
        className: options?.className,
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
        cellData,
      },
      cell: (info) => {
        const { id, name } = info.getValue();

        if (options?.editable) {
          const current: ComboboxItem<ProductShortcode> | null =
            id && name ? { id: unsafeProductShortcode(id), name } : null;
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
              // The previewing link, not a bare `TableLink`: an editable cell
              // is where you most want the hovercard, since deciding whether
              // this is the RIGHT product is the reason you opened the picker.
              // Safe inside `EditableEntityCell` because its trigger is a
              // pencil, not the whole cell — the link stays navigable.
              renderValue={(v) =>
                v ? (
                  <EntityInlineLink
                    displayImage={undefined}
                    entity="product"
                    data={{ id: v.id, name: v.name }}
                    truncate
                  />
                ) : (
                  <NoneValue />
                )
              }
            />
          );
        }

        if (!id || !name) return <NoneValue />;
        return (
          <EntityInlineLink
            displayImage={undefined}
            entity="product"
            data={{ id, name }}
            truncate
          />
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
      onSave: (newProductId: ProductShortcode | null, row: T) => Promise<void>;
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
      ? (row, id) => options.editable!.onSave(unsafeProductShortcode(id), row)
      : undefined,
    options?.editable
      ? (row) => options.editable!.onSave(null, row)
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
      sortFn: entityRefSortingFn,
      meta: {
        className: options?.className,
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
        cellData,
      },
      cell: (info) => {
        const { id, name } = info.getValue();

        if (options?.editable) {
          const current: ComboboxItem<ProductShortcode> | null =
            id && name ? { id: unsafeProductShortcode(id), name } : null;
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
              // The previewing link, not a bare `TableLink`: an editable cell
              // is where you most want the hovercard, since deciding whether
              // this is the RIGHT product is the reason you opened the picker.
              // Safe inside `EditableEntityCell` because its trigger is a
              // pencil, not the whole cell — the link stays navigable.
              renderValue={(v) =>
                v ? (
                  <EntityInlineLink
                    displayImage={undefined}
                    entity="product"
                    data={{ id: v.id, name: v.name }}
                    truncate
                  />
                ) : (
                  <NoneValue />
                )
              }
            />
          );
        }

        if (!id || !name) return <NoneValue />;
        return (
          <EntityInlineLink
            displayImage={undefined}
            entity="product"
            data={{ id, name }}
            truncate
          />
        );
      },
    },
  );
}

/**
 * Creates a column linking to a row's parent entity of the SAME kind — a
 * task's `parentTaskId`/`parentTaskName`, or a project's
 * `parentProjectId`/`parentProjectName` (the WBS tree's "Parent" column).
 * Mirrors {@link createProjectLinkColumn}/{@link createProductLinkColumn} —
 * same flat id+name pair rather than a nested relation object — but unlike
 * those two, the field names and target entity vary per caller (task vs.
 * project), so this takes the id/name fields and entity explicitly instead
 * of hardcoding them. Read-only: none of the three call sites (the task
 * list, the project detail page's embedded task list, and the project
 * roster) support inline reparenting through this column.
 */
export function createParentLinkColumn<
  T extends Record<string, unknown>,
  TEntity extends "task" | "project",
>(
  columnHelper: ColumnHelper<T>,
  entity: TEntity,
  idField: keyof T,
  nameField: keyof T,
  options?: {
    id?: string;
    header?: string;
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
  },
) {
  const defaultId = entity === "task" ? "parentTask" : "parent";
  const defaultHeader = entity === "task" ? "Parent Task" : "Parent";
  return columnHelper.accessor(
    (row) => ({
      id: row[idField] as string | null,
      name: row[nameField] as string | null,
    }),
    {
      id: options?.id ?? defaultId,
      header: options?.header ?? defaultHeader,
      enableSorting: false,
      meta: {
        className: options?.className ?? "w-40",
        mobile: options?.mobile,
        filterConfig: options?.filterConfig,
      },
      cell: (info) => {
        const { id, name } = info.getValue();
        if (!id || !name) return <NoneValue />;
        return (
          <EntityInlineLink
            displayImage={undefined}
            entity={entity}
            data={{ id, name } as never}
            truncate
          />
        );
      },
    },
  );
}
