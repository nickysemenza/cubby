import type { Amount } from "@cubby/schemas/codec";
import type { DisplayImageSummary } from "@cubby/schemas/display-images";
import type { Entity, EntityRef } from "@cubby/schemas/entity";
import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  type LocationShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import { locationType, type LocationType } from "@cubby/schemas/location";
import type { ProductPricingOut } from "@cubby/schemas/product";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { Link } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { uniqBy } from "es-toolkit";
import type { ReactNode } from "react";
import { z } from "zod";

import {
  EntityActionRowMenuItems,
  type EntityActionSubject,
} from "~/app/_components/actions/entity-actions";
import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
} from "~/app/_components/ai/field-suggestion";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { renderScalarValue } from "~/components/common/scalar-value";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { EnumPill } from "~/components/ui/enum-pill";
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
import {
  entities,
  entityLabel,
  entityPluralLabel,
  isBrowserRoutedEntity,
} from "~/entities/entities";
import { multiSelectFilterFn } from "~/entities/filters";
import { type BaseKind, gradedKinds } from "~/lib/conversion-coverage";
import { colorizeSelectOptions } from "~/lib/select-options";
import { cn, formatCurrency } from "~/lib/utils";

import {
  buildLocationComboboxItem,
  buildProductComboboxItem,
  buildRecordComboboxItem,
} from "../combobox/combobox-builders";
import type { ComboboxItem } from "../combobox/combobox-types";
import {
  useEntityListSource,
  type EntitySearchEntity,
  type SearchProviderProps,
} from "../combobox/with-search-hook";
import { useEntityDisplayImage } from "../entity-media/entity-display-images";
import { EntityInlineLink } from "../EntityInlineLink";
import { EntityInlineLinkList } from "../EntityInlineLinkList";
import { ImageThumbnail } from "../table/ImageThumbnail";
import { TableLink } from "../table/TableLink";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import type { CellClipboardSpec, CellJsonValue } from "./cell-clipboard";
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
import {
  InventoryEntriesCell,
  type InventoryEntriesCellProps,
} from "./inventory-entries-cell";
import { nameLabel } from "./name-label";
import type {
  CubbyCellContext as CellContext,
  CubbyColumnDef,
  CubbyColumnHelper as ColumnHelper,
} from "./table-features";
import {
  attachCubbyColumnMeta,
  type FilterConfig,
  type MobileColumnMeta,
} from "./table-meta";

export type { FilterConfig, MobileColumnMeta, MobileSlot } from "./table-meta";

export { multiSelectFilterFn };

interface BaseRow {
  id: string | number;
  // Nullable: `meal.name` is optional (an unnamed meal is identified by its
  // date). Widened from `string` so such entities can use these factories at
  // all — see `emptyLabel` on createNameColumn.
  name?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

function nameColumnParams(row: BaseRow) {
  return { shortcode: String(row.id) };
}

type EntityRowLink = {
  to: EntityDetailRoute;
  params: EntityDetailParams | { id: string };
};

export type RowLinkResolver<T> = (row: T) => EntityRowLink | null;

function resolveNameValue<T extends BaseRow>(
  fieldName: keyof T,
  getValue?: (row: T) => string | null,
) {
  if (getValue) return getValue;
  return (row: T) => {
    const raw = row[fieldName];
    return raw == null ? null : String(raw);
  };
}

const defaultRowLink = <T extends BaseRow>(
  entity: Entity,
): RowLinkResolver<T> => {
  if (!isBrowserRoutedEntity(entity)) return () => null;
  const to = entities[entity].routes.detail;
  return (row) => ({
    to,
    params:
      entity === "usda-food" ? { id: String(row.id) } : nameColumnParams(row),
  });
};

/** A row that genuinely carries its own images. `images` is REQUIRED: when it
 *  was optional, any row type without the field satisfied this shape, and
 *  `rowImages` silently returned `[]` forever. */
interface ImageRow {
  images: Array<{
    id: string;
    url: string;
    filename: string;
    contentType?: string;
  }>;
}

/**
 * The plain accessor for rows that own their images — everything but PDF
 * manuals, which share the images relation.
 *
 * Name it explicitly at a `createImageColumn` call site; that mention is the
 * assertion that this row really has `images`. It used to be the factory's
 * default, reached through an `as unknown as ImageRow` cast, so an entity with
 * no images field (ingredient) compiled fine and rendered the placeholder icon
 * on every row forever with nothing to catch it.
 */
export const rowImages = <T extends ImageRow>(row: T) =>
  row.images.filter(
    (img) =>
      img.contentType === undefined ||
      isDisplayableImageFile({ ...img, contentType: img.contentType }),
  );

export function createNameColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  fieldName?: keyof T,
  options?: {
    filterConfig?: FilterConfig;
    /**
     * Override the column width class. Defaults to `w-64` (16rem). The fixed
     * table layout IGNORES `min-width` on cells (only `width` counts), so a
     * `min-w-*` floor does nothing — an explicit width is the only lever.
     * `w-64` holds a readable 16rem on dense tables (many columns) instead of
     * collapsing to a few characters. On a table with room to spare the
     * shared layout contract gives this identity column the surplus, rather
     * than proportionally inflating every measurement column.
     */
    className?: string;
    editable?: {
      onSave: (newValue: string, row: T) => Promise<void>;
      /** Stored edit value when the visible identity is a computed title. */
      getValue?: (row: T) => string | null;
    };
    mobile?: MobileColumnMeta;
    header?: string;
    nameSuffix?: (row: T) => ReactNode;
    namePrefix?: (row: T) => ReactNode;
    expandable?: boolean;
    emptyLabel?: (row: T) => string;
    rowLink?: RowLinkResolver<T>;
    /** Manifest title projection when it is not a literal row `name` key. */
    getValue?: (row: T) => string | null;
    /** Preserve the manifest read-projection id for sorting/filter ownership. */
    id?: string;
    enableSorting?: boolean;
  },
) {
  const resolvedFieldName = fieldName ?? "name";
  const nameValue = resolveNameValue(resolvedFieldName, options?.getValue);
  const singularLabel = entityLabel(entity).toLowerCase();
  const pluralLabel = entityPluralLabel(entity).toLowerCase();
  const rowLink = options?.rowLink ?? defaultRowLink<T>(entity);
  const editable = options?.editable;
  const cellData = textCellData<T>(
    "text",
    nameValue,
    editable ? (row, v) => editable.onSave(v ?? "", row) : undefined,
  );
  const config = {
    id: options?.id ?? String(resolvedFieldName),
    enableSorting: options?.enableSorting ?? true,
    meta: attachCubbyColumnMeta({
      className: options?.className ?? "w-64",
      entityColumnRole: "identity",
      surplus: true,
      filterConfig: options?.filterConfig,
      mobile: options?.mobile ?? { slot: "title", priority: 0 },
      cellData,
    }),
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
      return `${count} ${count === 1 ? singularLabel : pluralLabel}`;
    },
    cell: (info: CellContext<T, string>) => {
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
          <TableLink to={link.to} params={link.params} variant="identity">
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
                <CaretRightIcon
                  className={cn(
                    "transition-transform",
                    expanded && "rotate-90",
                  )}
                />
              </Button>
            ) : row.depth > 0 ? (
              // Nested leaves keep the disclosure lane so their indentation
              // remains visually subordinate to the expandable parent. A
              // top-level leaf has no tree relationship to signal, so it must
              // start at the cell edge instead of carrying a dead 24px gutter.
              <span aria-hidden className="size-6 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate">{content}</span>
          </Row>
        );
      };

      if (editable) {
        const editValue = editable.getValue?.(info.row.original) ?? stored;
        return wrapExpandable(
          <EditableCell
            // The EDITOR gets the stored value, not the fallback — prefilling
            // it with a derived label would silently persist that label as a
            // real name on the next save.
            value={editValue}
            onSave={(newVal) =>
              editable.onSave(newVal ?? "", info.row.original)
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

  const header =
    options?.header ??
    (resolvedFieldName === "filename" ? "Filename" : undefined);

  return header === undefined
    ? columnHelper.accessor(nameValue, config)
    : columnHelper.accessor(nameValue, { ...config, header });
}

export function createCreatedAtColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
) {
  return columnHelper.accessor((row) => row.createdAt, {
    id: "createdAt",
    header: "Created",
    meta: attachCubbyColumnMeta({
      entityColumnRole: "fact",
      // Relative timestamps are short ("5 months ago"); without a cap the
      // fixed-layout table hands this column an equal share of leftover width.
      className: "w-32",
      mobile: { slot: "hidden" },
      // Copy-only: the display is relative ("5 months ago") but the copy
      // payload is the ISO date-time, which pastes usefully into a spreadsheet.
      cellData: timestampCellData<T>((row) => row.createdAt),
    }),
    cell: (info) => {
      const value = info.getValue();
      return renderScalarValue(
        value
          ? { kind: "timestamp", raw: value }
          : { kind: "empty", raw: null },
      );
    },
  });
}

export function createUpdatedAtColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
) {
  return columnHelper.accessor((row) => row.updatedAt, {
    id: "updatedAt",
    header: "Updated",
    meta: attachCubbyColumnMeta({
      entityColumnRole: "fact",
      className: "w-32",
      mobile: { slot: "hidden" },
      cellData: timestampCellData<T>((row) => row.updatedAt),
    }),
    cell: (info) => {
      const value = info.getValue();
      return renderScalarValue(
        value
          ? { kind: "timestamp", raw: value }
          : { kind: "empty", raw: null },
      );
    },
  });
}

interface CreateImageColumnOptions<T> {
  /** Entity type for colored placeholder icon when no image */
  entity: Entity;
  /** Field-key id when an entity declares an images column. */
  id?: string;
  /** How this row resolves its thumbnail. Defaults to `row.displayImages` —
   *  the server-resolved list contract (own gallery/cover, or a borrowed
   *  entity's photos) that every `displayImages` manifest entity's list row
   *  carries. Pass `getImages` only for a table of a non-list shape whose rows
   *  still carry their own `images[]` (purchase products, kit components,
   *  project tools) — name `rowImages` at the call site for those, or a
   *  cascade resolver when the row borrows a linked entity's cover. */
  getImages?: (row: T) => Array<{ id: string; url: string; filename?: string }>;
  /** Custom className for the column (default: "px-0 py-0 h-px") */
  className?: string;
  /** Mobile projection metadata override */
  mobile?: MobileColumnMeta;
  /** Origin of a projected thumbnail; null marks an ordinary local image. */
  provenance?: EntityFieldProvenance | null;
}

/** A row carrying the server-resolved `displayImages` list contract — the
 *  default `getImages` source. */
interface DisplayImagesRow {
  displayImages: DisplayImageSummary[];
}

/**
 * Runtime twin of `DisplayImagesRow` for a table whose row type is narrower
 * than the rows it actually receives (the expense list's `ColumnHelper` is
 * typed to `ExpenseOut` so it can share column factories with the project
 * page's embedded expense table). A predicate, not an assertion: the guard
 * scripts forbid asserting into a branded-id shape.
 */
export const hasDisplayImages = <T extends BaseRow>(
  row: T,
): row is T & DisplayImagesRow =>
  "displayImages" in row && Array.isArray(row.displayImages);

type ImageColumnDef<T extends BaseRow> = CubbyColumnDef<
  T,
  Array<{ id: string; url: string; filename?: string }>
>;

export function createImageColumn<T extends BaseRow & DisplayImagesRow>(
  columnHelper: ColumnHelper<T>,
  options: CreateImageColumnOptions<T>,
): ImageColumnDef<T>;
export function createImageColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  options: CreateImageColumnOptions<T> & {
    getImages: (
      row: T,
    ) => Array<{ id: string; url: string; filename?: string }>;
  },
): ImageColumnDef<T>;
export function createImageColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  options: CreateImageColumnOptions<T>,
) {
  const { entity } = options;
  // Only the first overload (`T extends DisplayImagesRow`) omits `getImages`,
  // so every row reaching the default actually carries `displayImages` — the
  // implementation signature just can't say so, hence the runtime predicate.
  const getImages =
    options.getImages ??
    ((row: T) => (hasDisplayImages(row) ? row.displayImages : []));

  return columnHelper.accessor((row) => getImages(row), {
    id: options.id ?? "image",
    header: () => <ImageIcon className="size-3 text-muted-foreground" />,
    enableSorting: false,
    enableHiding: false,
    enablePinning: false,
    enableCellSelection: false,
    // h-px trick: setting height:1px on td makes h-full work on children
    // overflow-hidden prevents image from expanding the row. The 40px lane
    // holds a 24px cover with breathing room while remaining subordinate to
    // the adjacent identity link.
    meta: {
      provenance: options.provenance,
      entityColumnRole: "image",
      className: cn("h-px w-10 overflow-hidden px-0 py-0", options?.className),
      mobile: options?.mobile ?? { slot: "image", priority: -10 },
    },
    // Reads `row.original` rather than `info.getValue()` — deliberately, and it
    // is load-bearing whenever `getImages` closes over separately-fetched data
    // (projects hydrate theirs from the project-image Start projection, not from the
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

// A single relation summary is the source shape for both a lone inline link
// and a collection of links. Keeping these schemas singular prevents the two
// renderers from silently accepting different projections for the same entity.
const ingredientInlineSchema = z.object({ id: z.string(), name: z.string() });
const productInlineSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
});
const recipeInlineSchema = z.object({ id: z.string(), name: z.string() });
const locationInlineSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: locationType.nullable(),
});
const usdaFoodInlineSchema = z.object({
  fdc_id: z.number(),
  foodInfo: z.object({ description: z.string().nullable() }),
});

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

type EntityColumnItems<TEntity extends EntityColumnData["entity"]> = Extract<
  EntityColumnData,
  { entity: TEntity }
>["items"];

type KeysRendering<T, TValue> = {
  [K in keyof T]-?: NonNullable<T[K]> extends TValue ? K : never;
}[keyof T];

function renderEntityInlineItems<TValue>(
  entity: EntityColumnData["entity"],
  value: TValue,
  dedupe: boolean,
) {
  const renderCollection = singleEntityAdapters[entity].renderCollection;
  if (!renderCollection) {
    throw new Error(`${entity} does not support collection links`);
  }
  return renderCollection(value, dedupe);
}

function entityInlineItemRefs(
  entity: EntityColumnData["entity"],
  value: unknown,
): EntityRef[] {
  const items = (() => {
    switch (entity) {
      case "ingredient":
        return z.array(ingredientInlineSchema).parse(value);
      case "product":
        return z.array(productInlineSchema).parse(value);
      case "recipe":
        return z.array(recipeInlineSchema).parse(value);
      case "location":
        return z.array(locationInlineSchema).parse(value);
    }
  })();
  return items.map((item) => ({ entityType: entity, entityId: item.id }));
}

export function createEntityInlineLinkColumn<
  TEntity extends EntityColumnData["entity"],
  T extends object,
  K extends KeysRendering<T, EntityColumnItems<TEntity>>,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  entity: TEntity,
  options?: {
    header?: string;
    className?: string;
    filterConfig?: FilterConfig;
    enableSorting?: boolean;
    dedupe?: boolean;
    mobile?: MobileColumnMeta;
    provenance?: EntityFieldProvenance;
  },
) {
  return columnHelper.accessor((row: T) => row[accessor], {
    id: String(accessor),
    header: options?.header ?? entityLabel(entity),
    enableSorting: options?.enableSorting ?? false,
    meta: attachCubbyColumnMeta<T>({
      className: options?.className
        ? `${options.className} overflow-hidden`
        : undefined,
      filterConfig: options?.filterConfig,
      mobile: options?.mobile,
      provenance: options?.provenance,
      entityRefs: (row) => entityInlineItemRefs(entity, row[accessor]),
    }),
    cell: (info) =>
      renderEntityInlineItems(
        entity,
        info.getValue() ?? [],
        options?.dedupe ?? false,
      ),
  });
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

export function createInventoryEntriesColumn<
  TEntry extends InventoryEntryBase,
  TEntity extends InventoryRelatedEntity["entity"],
  K extends PropertyKey,
  T extends Record<K, TEntry[]>,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  entity: TEntity,
  getRelatedEntity: InventoryEntriesCellProps<
    T,
    TEntry,
    TEntity
  >["getRelatedEntity"],
  options?: {
    id?: string;
    header?: string;
    className?: string;
    enableSorting?: boolean;
    layout?: "stacked" | "inline";
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    provenance?: EntityFieldProvenance;
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
      /** `useEntityListSource("location", ...)` — injected so unit tests can stub it. */
      SearchProvider: (
        props: SearchProviderProps<LocationShortcode>,
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

  return columnHelper.accessor((row: T) => row[accessor], {
    id: options?.id ?? String(accessor),
    header:
      options?.header ?? (entity === "location" ? "Locations" : "Products"),
    enableSorting: options?.enableSorting ?? false,
    meta: attachCubbyColumnMeta<T>({
      className: options?.className ?? "min-w-0 w-40 max-w-56",
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
      provenance: options?.provenance,
      entityRefs: (row) =>
        row[accessor].flatMap((entry) => {
          const related = getRelatedEntity(entry);
          return related ? [{ entityType: entity, entityId: related.id }] : [];
        }),
    }),
    cell: (info) => (
      <InventoryEntriesCell<T, TEntry, TEntity>
        entries={info.getValue() ?? []}
        entity={entity}
        getRelatedEntity={getRelatedEntity}
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
  extraActions?: (row: T) => ReactNode;
  /**
   * Per-row detail link, for rows that aren't all `entity`. Keep it the same
   * resolver the name column got, or "View details" opens something other than
   * the row the user clicked.
   */
  rowLink?: RowLinkResolver<T>;
  /**
   * What each row is *about*, when that is a different record — an inventory
   * entry is about its product. Its entity's actions then appear in this row's
   * menu, which is how "Add to inventory" is reachable from a shelf without
   * the inventory table re-declaring a product verb.
   *
   * The table must also pass `subjectEntity` to `RTable`, or nothing publishes
   * that entity's actions for this column to find.
   */
  subject?: (row: T) => EntityActionSubject | null;
}

export function createActionsColumn<T extends { id: string | number }>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  options?: ActionsColumnOptions<T>,
) {
  const extraActions = options?.extraActions;
  return createActionsColumnBase(
    columnHelper,
    options?.rowLink ?? defaultRowLink<T>(entity),
    // Registered actions lead, the surface's own hand-wired ones follow: the
    // same shape the selection bar has (generic first, `extraActions`' trailing
    // Delete last), and the only order that keeps the destructive item at the
    // bottom of the menu. Renders nothing until a surface publishes an
    // `EntityActionsProvider` for this entity, so a table that never mounts one
    // has the menu it always had.
    (row) => (
      <>
        <EntityActionRowMenuItems
          entity={entity}
          row={row}
          subject={options?.subject?.(row)}
        />
        {extraActions?.(row)}
      </>
    ),
  );
}

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
      entityColumnRole: "action",
      mobile: { slot: "actions", priority: 100 },
    },
    cell: (info) => {
      const row = info.row.original;
      const linkProps = getLinkProps(row);
      return (
        <DropdownMenu>
          <DropdownMenuTrigger
            // icon-sm (28px) fits inside the 32px row; anything larger
            // stretches every row and the virtualizer's fixed row height.
            render={<Button variant="ghost" size="icon-sm" />}
            onClick={(e) => e.stopPropagation()}
          >
            <DotsThreeIcon className="size-3.5" />
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
                <EyeIcon />
                View details
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
 * Shared plumbing for ordinary accessor columns. Factories keep ownership of
 * their value conversion and editor configuration, while this helper keeps the
 * table contract in one place: the accessor is also the clipboard value,
 * metadata always receives the same cell data, and an editable column uses the
 * very same descriptor for its single-cell clipboard target.
 *
 * Specialized columns deliberately stay outside this helper. Currency has a
 * footer, amounts have their own editor, and relationship columns have a
 * separate optimistic entity state machine.
 */
function createEditableAccessorColumn<
  T extends RowData,
  TValue,
  TSaved extends CellJsonValue | null | void,
>(
  columnHelper: ColumnHelper<T>,
  valueFor: (row: T) => TValue,
  options: {
    id: string;
    header?: string;
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    cellData: ColumnCellData<T, TSaved>;
    enableSorting?: boolean;
    mono?: boolean;
    numeric?: boolean;
    renderValue: (value: TValue, row: T) => ReactNode;
    renderEditable?: (
      value: TValue,
      row: T,
      clipboard: CellClipboardSpec<TSaved>,
    ) => ReactNode;
  },
) {
  return columnHelper.accessor(valueFor, {
    id: options.id,
    header: options.header,
    enableSorting: options.enableSorting,
    meta: attachCubbyColumnMeta({
      className: options.className,
      mobile: options.mobile,
      filterConfig: options.filterConfig,
      mono: options.mono,
      numeric: options.numeric,
      cellData: options.cellData,
    }),
    cell: (info: CellContext<T, TValue>) => {
      const row = info.row.original;
      const value = info.getValue();
      return options.renderEditable
        ? options.renderEditable(
            value,
            row,
            specFromCellData(options.cellData, row),
          )
        : options.renderValue(value, row);
    },
  });
}

export function createTextColumn<
  K extends PropertyKey,
  T extends Record<K, string | null | undefined>,
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
    trigger?: "wrap" | "pencil";
    editable?: {
      onSave: (newValue: string | null, row: T) => Promise<void>;
    };
  },
) {
  const renderValue =
    options?.renderValue ??
    ((v: string | null) =>
      renderScalarValue({ kind: "text", raw: v ?? "", label: v ?? "" }));
  const renderRow = (value: string | null, row: T) => renderValue(value, row);
  const editable = options?.editable;
  const textValue = (row: T): string | null => row[accessor] ?? null;

  const cellData = textCellData<T>(
    "text",
    textValue,
    editable ? (row, v) => editable.onSave(v, row) : undefined,
  );

  const definition = createEditableAccessorColumn(columnHelper, textValue, {
    id: String(accessor),
    header: options?.header,
    className: options?.className,
    mobile: options?.mobile,
    filterConfig: options?.filterConfig,
    cellData,
    renderValue: renderRow,
    renderEditable: editable
      ? (value, row, clipboard) => (
          <EditableCell
            value={value}
            onSave={(newValue) => editable.onSave(newValue, row)}
            clipboard={clipboard}
            config={{ type: "text", placeholder: options?.placeholder }}
            trigger={options?.trigger}
            renderValue={(value) => renderRow(value, row)}
          />
        )
      : undefined,
  });
  // Same reason as `createSelectColumn`: a client-side table resolves its
  // filterFn from the ROW value's type, so a string column handed an array
  // would silently match nothing. (Vendor is a text column with a picklist.)
  if (options?.filterConfig?.filterType === "multiselect") {
    Object.assign(definition, { filterFn: multiSelectFilterFn });
  }
  return definition;
}

export function createCurrencyColumn<
  K extends PropertyKey,
  T extends Record<K, number | null | undefined>,
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
    editable?: {
      onSave: (newValue: number | null, row: T) => Promise<void>;
    };
  },
) {
  const zeroAsEmpty = options?.zeroAsEmpty ?? false;
  const decimals = options?.decimals;
  const signedTone = options?.signedTone ?? false;
  const editable = options?.editable;
  const isEmpty = (v: number | null | undefined): v is null | undefined | 0 =>
    v === null || v === undefined || (zeroAsEmpty && v === 0);
  // Flat green by default; sign-tinted columns leave positive spend neutral and
  // green only the credits, so a refund never reads as spend.
  const toneClass = (v: number) =>
    signedTone ? (v < 0 ? "text-positive" : "font-medium") : "text-positive";
  const cellData = numberCellData<T>(
    "currency",
    (row) => row[accessor] ?? null,
    editable ? (row, v) => editable.onSave(v, row) : undefined,
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
  return columnHelper.accessor((row: T) => row[accessor] ?? null, {
    id: String(accessor),
    header: options?.header,
    meta: attachCubbyColumnMeta({
      numeric: true,
      className: cn(options?.className ?? defaultClassName, "truncate"),
      mobile: options?.mobile,
      cellData,
    }),
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
        <span className={cn("tabular-nums", toneClass(total))}>
          {formatCurrency(total, decimals)}
        </span>
      );
    },
    cell: (info) => {
      const val = info.getValue() ?? null;

      if (editable) {
        return (
          <EditableCell
            value={val}
            onSave={(newVal) => editable.onSave(newVal, info.row.original)}
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
      data: {
        fdc_id: number;
        foodInfo: { description: string | null };
      } | null;
    };

type EditableSingleEntity = Exclude<
  SingleEntityColumnData["entity"],
  "usda-food"
>;

type SingleEntityData<TEntity extends SingleEntityColumnData["entity"]> =
  Extract<SingleEntityColumnData, { entity: TEntity }>["data"];

type CanonicalSingleEntityLinkProps =
  | {
      entity: "ingredient";
      data: NonNullable<SingleEntityData<"ingredient">>;
    }
  | {
      entity: "product";
      data: NonNullable<SingleEntityData<"product">>;
    }
  | {
      entity: "recipe";
      data: NonNullable<SingleEntityData<"recipe">>;
    }
  | {
      entity: "location";
      data: NonNullable<SingleEntityData<"location">>;
    }
  | {
      entity: "usda-food";
      data: NonNullable<SingleEntityData<"usda-food">>;
    };

function CanonicalSingleEntityLink({
  entity,
  data,
}: CanonicalSingleEntityLinkProps) {
  const displayImage = useEntityDisplayImage({
    entityType: entity,
    entityId: "id" in data ? data.id : "",
  });
  if (entity === "usda-food") {
    return (
      <EntityInlineLink
        displayImage={null}
        entity="usda-food"
        data={data}
        truncate
      />
    );
  }
  return (
    <EntityInlineLink
      displayImage={displayImage}
      entity={entity}
      data={data}
      truncate
    />
  );
}

type SingleEntityAdapter = {
  /** Validates a row's relation summary once before constructing its UI data. */
  parse: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Runtime projections cross the table boundary here and this function consumes them directly with the target schema.
    value: unknown,
  ) => { item: ComboboxItem<string> | null; link: ReactNode } | null;
  /** A collection parser derived from this adapter's singular schema. */
  renderCollection?: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Collections use the same runtime schema boundary and deliberately reject malformed items.
    value: unknown,
    dedupe: boolean,
  ) => ReactNode;
  SearchProvider?: (props: SearchProviderProps<string>) => ReactNode;
};

function defineSingleEntityAdapter<TData>(
  schema: z.ZodType<TData>,
  options: {
    buildItem?: (data: TData) => ComboboxItem<string>;
    renderLink: (data: TData) => ReactNode;
    renderCollection?: (items: TData[]) => ReactNode;
    collectionId?: (item: TData) => string;
    SearchProvider?: (props: SearchProviderProps<string>) => ReactNode;
  },
): SingleEntityAdapter {
  const collectionSchema = z.array(schema);
  return {
    SearchProvider: options.SearchProvider,
    parse: (value) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return null;
      return {
        item: options.buildItem?.(parsed.data) ?? null,
        link: options.renderLink(parsed.data),
      };
    },
    renderCollection: options.renderCollection
      ? (value, dedupe) => {
          const items = collectionSchema.parse(value);
          return options.renderCollection?.(
            dedupe && options.collectionId
              ? uniqBy(items, options.collectionId)
              : items,
          );
        }
      : undefined,
  };
}

/**
 * One entity's `SearchProvider`: a `useEntityListSource(entity, ...)` call
 * wrapped in the render-prop shape `SingleEntityAdapter.SearchProvider`
 * expects, so each adapter below can name its own target without repeating
 * the dialog/children plumbing.
 */
function inlineSearchProvider<E extends EntitySearchEntity>(
  entity: E,
): (props: SearchProviderProps<string>) => ReactNode {
  return function InlineSearchProvider(props) {
    const { dialog, ...search } = useEntityListSource(entity, {
      scope: props.scope,
    });
    return (
      <>
        {dialog}
        {props.children(search)}
      </>
    );
  };
}

/**
 * The complete relation-picker roster. Each entry owns the schema for its
 * projected value, the item converter used by editable cells, its real inline
 * link, and (when this relation can be edited) the deferred search provider.
 * Keeping these together prevents a newly supported target from gaining only
 * one of display, clipboard conversion, or search.
 */
const singleEntityAdapters = {
  ingredient: defineSingleEntityAdapter(ingredientInlineSchema, {
    buildItem: (data) => buildRecordComboboxItem("ingredient", data),
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="ingredient" data={data} />
    ),
    renderCollection: (items) => (
      <EntityInlineLinkList
        entity="ingredient"
        items={items}
        maxItems={1}
        compact
        resolveImages={false}
      />
    ),
    collectionId: (item) => item.id,
    SearchProvider: inlineSearchProvider("ingredient"),
  }),
  product: defineSingleEntityAdapter(productInlineSchema, {
    buildItem: (data) =>
      buildProductComboboxItem({
        ...data,
        id: parseShortcodeFor("product", data.id),
      }),
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="product" data={data} />
    ),
    renderCollection: (items) => (
      <EntityInlineLinkList
        entity="product"
        items={items}
        maxItems={1}
        compact
        resolveImages={false}
      />
    ),
    collectionId: (item) => item.id,
    SearchProvider: inlineSearchProvider("product"),
  }),
  recipe: defineSingleEntityAdapter(recipeInlineSchema, {
    buildItem: (data) => buildRecordComboboxItem("recipe", data),
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="recipe" data={data} />
    ),
    renderCollection: (items) => (
      <EntityInlineLinkList
        entity="recipe"
        items={items}
        maxItems={1}
        compact
        resolveImages={false}
      />
    ),
    collectionId: (item) => item.id,
    SearchProvider: inlineSearchProvider("recipe"),
  }),
  location: defineSingleEntityAdapter(locationInlineSchema, {
    buildItem: (data) =>
      buildLocationComboboxItem({
        ...data,
        id: parseShortcodeFor("location", data.id),
      }),
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="location" data={data} />
    ),
    renderCollection: (items) => (
      <EntityInlineLinkList
        entity="location"
        items={items}
        maxItems={1}
        compact
        resolveImages={false}
      />
    ),
    collectionId: (item) => item.id,
    SearchProvider: inlineSearchProvider("location"),
  }),
  "usda-food": defineSingleEntityAdapter(usdaFoodInlineSchema, {
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="usda-food" data={data} />
    ),
  }),
} satisfies Record<SingleEntityColumnData["entity"], SingleEntityAdapter>;

function parseSingleEntity(
  entity: SingleEntityColumnData["entity"],
  data: Exclude<SingleEntityColumnData["data"], null>,
) {
  return singleEntityAdapters[entity].parse(data);
}

function buildSingleEntityItem(
  entity: EditableSingleEntity,
  data: Exclude<SingleEntityColumnData["data"], null>,
) {
  return parseSingleEntity(entity, data)?.item ?? null;
}

function renderSingleEntityLink(
  entity: SingleEntityColumnData["entity"],
  data: Exclude<SingleEntityColumnData["data"], null>,
) {
  return parseSingleEntity(entity, data)?.link ?? <NoneValue />;
}

/**
 * Clipboard spec for entity-picker cells. `entity:<name>` kinds deliberately
 * paste across tables (a location copied on the Locations page pastes into
 * any location cell). Text paste is rejected — id resolution by name would be
 * guesswork; server-side validation still applies to the pasted id.
 */
interface SingleEntityEditableConfig<T> {
  onSave: (newId: string | null, row: T) => Promise<void>;
  clearable?: boolean;
  filterItems?: (item: ComboboxItem<string>, row: T) => boolean;
  /**
   * Per-row gate. A false row falls through to the read-only render rather
   * than getting an editor that would fail on save — for a table whose rows
   * come from more than one source, where only some are backed by a writable
   * record. Defaults to editable.
   */
  isEditable?: (row: T) => boolean;
  /** When the owning field's `control.suggest` exists — the row's own entity
   * and the manifest field key this column edits (not the referenced
   * `TEntity`). Basis is built from `row` per cell, queried only while its
   * editor is open. */
  suggest?: { entity: ShortcodeEntity; field: string };
}

export function createSingleEntityInlineLinkColumn<
  TEntity extends SingleEntityColumnData["entity"],
  K extends PropertyKey,
  T extends Record<K, SingleEntityData<TEntity>>,
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
    provenance?: EntityFieldProvenance;
    editable?: TEntity extends EditableSingleEntity
      ? SingleEntityEditableConfig<T>
      : never;
  },
) {
  const editableConfig = options?.editable;
  const valueFor = (row: T): SingleEntityColumnData["data"] => row[accessor];
  // usda-food has no generic picker, so it's never copy/pasteable here.
  const cellData =
    entity === "usda-food"
      ? undefined
      : entityCellData<T, string>(
          entity,
          (value) => parseShortcodeFor(entity, value),
          (row) => {
            const item = valueFor(row);
            if (!item) return null;
            return buildSingleEntityItem(entity, item);
          },
          editableConfig
            ? (row, id) => editableConfig.onSave(id, row)
            : undefined,
          editableConfig?.clearable
            ? (row) => editableConfig.onSave(null, row)
            : undefined,
        );

  return columnHelper.accessor(valueFor, {
    id: String(accessor),
    header: options?.header ?? entityLabel(entity),
    enableSorting: options?.enableSorting ?? false,
    meta: attachCubbyColumnMeta({
      className: options?.className,
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
      provenance: options?.provenance,
      cellData,
      entityRefs: (row) => {
        const item = valueFor(row);
        return entity === "usda-food" || !item || !("id" in item)
          ? []
          : [{ entityType: entity, entityId: item.id }];
      },
    }),
    cell: (info) => {
      const item = info.getValue();
      const editable = options?.editable;

      if (
        editable &&
        entity !== "usda-food" &&
        (editable.isEditable?.(info.row.original) ?? true)
      ) {
        const SearchProvider = singleEntityAdapters[entity].SearchProvider;
        if (!SearchProvider) return <NoneValue />;
        const row = info.row.original;
        const current = item ? buildSingleEntityItem(entity, item) : null;
        const suggestConfig = editable.suggest;
        const suggest = suggestConfig
          ? {
              basisMode: "provided" as const,
              entity: suggestConfig.entity,
              targets: [suggestConfig.field],
              basis: fieldSuggestionBasisFromRecord(
                suggestConfig.entity,
                suggestTargetsFor(suggestConfig.entity, [suggestConfig.field]),
                row,
              ),
            }
          : undefined;
        return (
          <EditableEntityCell
            value={current}
            label={entity}
            clearable={editable.clearable}
            trigger="pencil"
            filterItems={
              editable.filterItems
                ? (candidate) => editable.filterItems?.(candidate, row) ?? true
                : undefined
            }
            onSave={(newId) => editable.onSave(newId, row)}
            clipboard={cellData ? specFromCellData(cellData, row) : undefined}
            suggest={suggest}
            SearchProvider={SearchProvider}
            renderValue={(v) => {
              if (!v) return <NoneValue />;
              // Keep the real inline link while the display matches the row
              // data; a transient optimistic value renders as plain text
              // until the invalidated query restores the relation summary.
              // (`id in item` is a type guard only — usda-food, the one
              // id-less member, can't reach the editable branch.)
              const currentItem = item
                ? buildSingleEntityItem(entity, item)
                : null;
              const currentId = currentItem?.id ?? null;
              if (item && v.id === currentId) {
                return renderSingleEntityLink(entity, item);
              }
              return <span className="truncate">{v.name}</span>;
            }}
          />
        );
      }

      if (!item) return <NoneValue />;
      return renderSingleEntityLink(entity, item);
    },
  });
}

/**
 * The one way a small-enum / boolean value renders in a table cell: a quiet
 * tinted pill carrying the option's own label.
 *
 * Derived from the column's `selectOptions` roster, which already carries
 * `{ value, label, color }` for the filter control and the inline editor — so
 * the roster is the single source of both the wording and the tone, and a cell
 * cannot disagree with the dropdown that edits it. Before this, the same class
 * of value rendered five different ways across 35 columns (bare string, Badge
 * with a tone map, Badge with an inline ternary, dot + text, icon + text), and
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
  /** A measure that qualifies the status (a score), inside the same pill. */
  detail?: ReactNode,
): ReactNode {
  if (value == null || value === "") return <NoneValue />;
  const option = colorizeSelectOptions(options).find((o) => o.value === value);
  return (
    <EnumPill
      icon={option?.icon}
      color={option?.color ?? "var(--slate)"}
      description={option?.description}
    >
      {option?.label ?? value}
      {detail != null ? (
        <span className="ml-1 tabular-nums opacity-70">{detail}</span>
      ) : null}
    </EnumPill>
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
 * the old one) are visually identical. The pin marks the exception (a manual
 * override); the derived norm stays unmarked, and the tooltip names either
 * source. This is that cue;
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex items-center gap-1" />}
      >
        {pricing.source === "explicit" ? (
          <PushPinIcon
            aria-hidden
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : null}
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
  K extends PropertyKey,
  T extends Record<K, boolean | null | undefined>,
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
  const encode = (value: boolean | null | undefined): string | null =>
    value === true ? "true" : value === false ? "false" : null;
  const decode = (v: string | null): boolean | null =>
    v === "true" ? true : v === "false" ? false : null;

  const editable = options.editable;
  const save = editable
    ? (row: T, value: string | null) => editable.onSave(decode(value), row)
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

  return createEditableAccessorColumn(
    columnHelper,
    (row: T) => encode(row[accessor]),
    {
      id: String(accessor),
      header: options.header,
      enableSorting: false,
      className: options.className,
      mobile: options.mobile,
      filterConfig,
      cellData,
      renderValue: (value) => renderOptionCell(value, selectOptions),
      renderEditable: editable
        ? (value, row, clipboard) => (
            <EditableCell
              value={value}
              onSave={(nextValue) => editable.onSave(decode(nextValue), row)}
              clipboard={clipboard}
              config={{
                type: "select",
                options: selectOptions,
                placeholder: editorPlaceholder,
                // Only a column that names an undecided state can be cleared back
                // into it; elsewhere clearing would invent a null the field's
                // schema may not allow.
                clearable: options.undecided !== undefined,
              }}
              renderValue={(nextValue) =>
                renderOptionCell(nextValue, selectOptions)
              }
            />
          )
        : undefined,
    },
  );
}

export function createExternalLinkColumn<
  K extends PropertyKey,
  T extends Record<K, string | number | null | undefined>,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  linkTo: "/usda/$id",
  options?: {
    header?: string;
    variant?: "mono" | "default";
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    /**
     * Rewrite the stored value for display and for the route param — when the
     * canonical form is not the one a human reads. A barcode stores as GTIN-14
     * but is printed (and looked up) in its shortest encoding.
     */
    display?: (value: string) => string;
    editable?: {
      onSave: (newValue: string | null, row: T) => Promise<void>;
    };
  },
) {
  const variant = options?.variant ?? "mono";
  const display = options?.display ?? ((value: string) => value);
  const editable = options?.editable;

  const cellData = textCellData<T>(
    "text",
    (row) => {
      const value = row[accessor];
      return value !== null && value !== undefined ? String(value) : null;
    },
    editable ? (row, value) => editable.onSave(value, row) : undefined,
  );

  return columnHelper.accessor((row: T) => row[accessor], {
    id: String(accessor),
    header: options?.header,
    meta: attachCubbyColumnMeta({
      className: options?.className,
      mono: variant === "mono",
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
      cellData,
    }),
    cell: (info) => {
      const value = info.getValue();

      if (editable) {
        return (
          <EditableCell
            value={value !== null && value !== undefined ? String(value) : null}
            onSave={(newValue) => editable.onSave(newValue, info.row.original)}
            clipboard={specFromCellData(cellData, info.row.original)}
            config={{ type: "text" }}
            trigger="pencil"
            renderValue={(v) => {
              if (v === null || v === undefined || v === "") {
                return <NoneValue />;
              }
              const shown = display(String(v));
              return (
                <TableLink to={linkTo} params={{ id: shown }} variant={variant}>
                  {shown}
                </TableLink>
              );
            }}
          />
        );
      }

      if (value === null || value === undefined) return <NoneValue />;
      const shown = display(String(value));
      return (
        <TableLink to={linkTo} params={{ id: shown }} variant={variant}>
          {shown}
        </TableLink>
      );
    },
  });
}

export function createEditableAmountColumn<
  K extends PropertyKey,
  T extends Record<K, Amount>,
>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options: {
    header?: string;
    className?: string;
    onSave: (newAmount: Amount, row: T) => Promise<void>;
    getUnitMappings?: (row: T) => UnitMapping[];
    mobile?: MobileColumnMeta;
    renderDisplay?: (content: ReactNode, row: T) => ReactNode;
    /**
     * Per-row gate — see {@link SingleEntityEditableConfig.isEditable}. A false
     * row renders the formatted amount as plain text. Defaults to editable.
     */
    isEditable?: (row: T) => boolean;
  },
) {
  const valueFor = (row: T) => row[accessor];
  const cellData = amountCellData<T>(valueFor, (row, amount) =>
    options.onSave(amount, row),
  );
  const renderDisplay = options.renderDisplay;
  return columnHelper.accessor(valueFor, {
    id: String(accessor),
    header: options.header ?? "Amount",
    meta: attachCubbyColumnMeta({
      numeric: true,
      className: cn("w-40", options.className),
      mobile: options.mobile,
      cellData,
    }),
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
          trigger={renderDisplay ? "pencil" : "wrap"}
          renderDisplay={
            renderDisplay ? (content) => renderDisplay(content, row) : undefined
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
  K extends PropertyKey,
  T extends Record<K, string | null | undefined>,
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
      clearable?: (row: T) => boolean;
      clearLabel?: string;
      clearDisabledReason?: string;
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
  const editable = options?.editable;
  const valueFor = (row: T): string | null => row[accessor] ?? null;
  const renderValue = (value: string | null, muted?: boolean) =>
    value ? (
      <span className={muted ? "text-muted-foreground" : undefined}>
        {renderScalarValue({ kind: "date", raw: value })}
      </span>
    ) : (
      <NoneValue />
    );

  // Copy the raw "YYYY-MM-DD" string; paste only when editable (kind "date").
  const cellData = dateCellData<T>(
    (row) => (options?.editValue ? options.editValue(row) : valueFor(row)),
    editable ? (row, value) => editable.onSave(value, row) : undefined,
  );

  return createEditableAccessorColumn(columnHelper, valueFor, {
    id: String(accessor),
    header: options?.header,
    className: options?.className ?? "w-28",
    mobile: options?.mobile,
    filterConfig: options?.filterConfig,
    cellData,
    renderValue: (value, row) => {
      const display = options?.displayValue?.(row);
      return renderValue(display?.value ?? value, display?.muted);
    },
    renderEditable: editable
      ? (value, row, clipboard) => {
          const display = options?.displayValue?.(row);
          const editableValue = options?.editValue
            ? options.editValue(row)
            : value;
          return (
            <EditableCell
              value={editableValue}
              onSave={(newValue) => editable.onSave(newValue, row)}
              clipboard={clipboard}
              config={{
                type: "date",
                clearable: editable.clearable?.(row),
                clearLabel: editable.clearLabel,
                clearDisabledReason:
                  editable.clearable?.(row) === false
                    ? editable.clearDisabledReason
                    : undefined,
              }}
              // EditableCell only calls renderValue in closed/display mode
              // (never while the editor is open), so substituting the
              // row-derived `display` is safe. The optimistic value still
              // wins after a save until the query refreshes the projection.
              renderValue={(optimistic) =>
                renderValue(
                  optimistic ?? display?.value ?? editableValue,
                  optimistic == null && display?.muted,
                )
              }
            />
          );
        }
      : undefined,
  });
}
