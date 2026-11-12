import type { Amount } from "@cubby/schemas/codec";
import {
  type Entity,
  type EntityRef,
  entityRefKey,
} from "@cubby/schemas/entity";
import type { EntityFieldProvenance } from "@cubby/schemas/entity-fields";
import {
  entityMembership,
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { entityRoster } from "@cubby/schemas/entity-roster";
import { fieldEnvelope, fieldValueOf } from "@cubby/schemas/field-envelope";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import { locationType } from "@cubby/schemas/location";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import type { QueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { RowData } from "@tanstack/react-table";
import { cn } from "cn";
import { uniqBy } from "es-toolkit";
import { Fragment, type ReactNode, useContext } from "react";
import { z } from "zod";

import {
  EntityActionRowMenuItems,
  type EntityActionSubject,
} from "~/entity/actions/entity-actions";
import {
  EntityRefLink,
  EntityRouteLink,
} from "~/entity/components/entity-ref-link";
import {
  RecordEmoji,
  recordEmojiOf,
  recordGlyphOf,
} from "~/entity/components/record-emoji";
import { ListRefLink } from "~/entity/components/ref-link/list";
import type { EntityDetailParams, EntityDetailRoute } from "~/entity/entities";
import {
  browserEntityDetailLink,
  entityLabel,
  entityPluralLabel,
  isBrowserRoutedEntity,
} from "~/entity/entities";
import { readRecordField } from "~/entity/entity-references";
import { ImageChainPopover } from "~/entity/fields/explanation/image-chain";
import { fieldResolutionFor } from "~/entity/fields/field-resolution";
import { multiSelectFilterFn } from "~/entity/filters";
import { rowDisplayCover } from "~/entity/model/row-display-cover";
import { readPathValue } from "~/entity/read-path";
import {
  fieldSuggestionBasisFromRecord,
  savedRecordShortcode,
} from "~/entity/suggestions/field-suggestion";
import { suggestTargetsFor } from "~/entity/suggestions/suggestion-targets";
import { Row } from "~/ui/layout";
import { MoreMenuTrigger } from "~/ui/navigation/more-menu-trigger";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/ui/primitives/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/ui/primitives/tooltip";
import { EnumPill } from "~/ui/text/enum-pill";
import { tryFormatAmount } from "~/ui/text/format-amount";
import { NoneValue } from "~/ui/text/none-value";
import { CurrencyValue } from "~/ui/values/currency-value";
import { renderScalarValue } from "~/ui/values/scalar-value";

import type { UnitMappingDisplay } from "../../features/units/unit-mapping-display";
import type { ComboboxItem } from "../../ui/combobox/combobox-types";
import type {
  CellClipboardSpec,
  CellJsonValue,
} from "../../ui/data-table/cell-clipboard";
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
} from "../../ui/data-table/cell-data";
import { rowDensity, RowLinesContext } from "../../ui/data-table/density";
import { nameLabel } from "../../ui/data-table/name-label";
import type {
  CubbyCellContext as CellContext,
  CubbyColumnDef,
  CubbyColumnHelper as ColumnHelper,
} from "../../ui/data-table/table-features";
import type { ColumnExplanation } from "../../ui/data-table/table-meta";
import {
  attachCubbyColumnMeta,
  type FilterConfig,
  type MobileColumnMeta,
} from "../../ui/data-table/table-meta";
import { isOpenDeadline } from "../display/entity-display";
import { useEntityDisplayImage } from "../entity-media/entity-display-images";
import { serverTreeChildCount } from "../hooks/use-server-tree-children";
import { buildRecordComboboxItem } from "../picker/combobox-builders";
import { referenceEntitySearch } from "../picker/reference-entity-search";
import type { SearchProviderProps } from "../picker/with-search-hook";
import {
  EditableAmountCell,
  EditableCell,
  type PickerOption,
} from "./editable-cell";
import { EditableEntityCell } from "./editable-entity-cell";
import { ImageThumbnail } from "./image-thumbnail";
import { RowQuickAction } from "./row-quick-action";

const optionalBooleanSchema = z.boolean().nullish();

type UnitMapping = Parameters<typeof UnitMappingDisplay>[0]["mappings"][number];

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
  return (row) => browserEntityDetailLink(entity, String(row.id));
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

/**
 * The title with its declared kind tag and second line. Single rows put the
 * tag after the title and drop it on a narrow pane; two-line rows draw the
 * tag and the second line's values, joined by " · ", under the title.
 */
function IdentityLines({
  children,
  kindTag,
  secondLine,
}: {
  children: ReactNode;
  kindTag: ReactNode;
  secondLine: readonly { key: string; node: ReactNode }[];
}) {
  const lines = useContext(RowLinesContext);
  if (lines === "double") {
    const parts = [
      ...(kindTag ? [{ key: "kind", node: kindTag }] : []),
      ...secondLine,
    ];
    return (
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="min-w-0 truncate font-medium">{children}</span>
        {parts.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
            {parts.map((part, index) => (
              <Fragment key={part.key}>
                {index > 0 ? <span aria-hidden>·</span> : null}
                <span className="min-w-0 shrink truncate">{part.node}</span>
              </Fragment>
            ))}
          </span>
        ) : null}
      </span>
    );
  }
  if (!kindTag) return children;
  return (
    <Row align="center" gap="xs" className="min-w-0">
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 [[data-table-narrow]_&]:hidden">{kindTag}</span>
    </Row>
  );
}

export function createNameColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  entity: Entity,
  fieldName?: keyof T,
  options?: {
    filterConfig?: FilterConfig;
    /**
     * Override the column width class. Defaults to `w-60`, the identity's
     * 240px fit. The fixed table layout IGNORES `min-width` on cells (only
     * `width` counts), so a `min-w-*` floor does nothing — an explicit width
     * is the only lever. On a table with room to spare the identity is the
     * one column that takes the surplus, up to that fit.
     */
    className?: string;
    editable?: {
      onSave: (newValue: string, row: T) => Promise<void>;
      saveFields?: (
        row: T,
        values: import("~/ui/data-table/cell-data").PasteFieldValues,
      ) => Promise<void>;
      /** Stored edit value when the visible identity is a computed title. */
      getValue?: (row: T) => string | null;
    };
    mobile?: MobileColumnMeta;
    header?: string;
    nameSuffix?: (row: T) => ReactNode;
    namePrefix?: (row: T) => ReactNode;
    /** The declared kind tag, after the title on a full-width pane. */
    kindTag?: (row: T) => ReactNode;
    /** The declared second line's values by field; drawn under the title in two-line rows. */
    secondLine?: (row: T) => readonly { key: string; node: ReactNode }[];
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
  if (editable?.saveFields && cellData.applyPaste) {
    cellData.rowWrite = {
      field: options?.id ?? String(resolvedFieldName),
      save: editable.saveFields,
    };
  }
  const config = {
    id: options?.id ?? String(resolvedFieldName),
    enableSorting: options?.enableSorting ?? true,
    meta: attachCubbyColumnMeta({
      className: options?.className ?? "w-60",
      entityColumnRole: "identity",
      filterConfig: options?.filterConfig,
      mobile: options?.mobile ?? { slot: "title", priority: 0 },
      cellData,
    }),
    footer: (info: {
      table: {
        getFilteredRowModel: () => { rows: unknown[] };
        options: { meta?: { serverTotals?: { totalCount?: number } } };
      };
    }) => {
      // Prefer the server's full-filtered-set count — client rows only cover
      // the loaded pages on server-paginated/infinite tables.
      const population = info.table.options.meta?.serverTotals?.totalCount;
      const count = population ?? info.table.getFilteredRowModel().rows.length;
      return `${count} ${population === undefined ? "loaded " : ""}${count === 1 ? singularLabel : pluralLabel}`;
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
      // The record's emoji and option glyph lead the image column; only a
      // record that names another entity's glyph repeats it beside the name.
      const prefix = entityRoster[entity].recordIconEntityField ? (
        <RecordEmoji entity={entity} record={info.row.original} />
      ) : (
        options?.namePrefix?.(info.row.original)
      );
      const link = rowLink(info.row.original);
      // A row that names nothing openable still has to be readable, so the
      // unlinked branch keeps the truncation and the full-name tooltip.
      const linkName = (label: ReactNode) =>
        link ? (
          <span data-record-identity-link className="contents">
            {!options?.rowLink && typeof label === "string" ? (
              <EntityRefLink
                entity={entity}
                id={String(info.row.original.id)}
                name={label}
                bare
              />
            ) : (
              <EntityRouteLink
                to={link.to}
                params={link.params}
                tone="identity"
              >
                {label}
              </EntityRouteLink>
            )}
          </span>
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

      const withLines = (nameEl: ReactNode) =>
        options?.kindTag || options?.secondLine ? (
          <IdentityLines
            kindTag={options.kindTag?.(info.row.original)}
            secondLine={options.secondLine?.(info.row.original) ?? []}
          >
            {nameEl}
          </IdentityLines>
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
        // A server tree names how many nested rows match before they load.
        const childCount = serverTreeChildCount(row.original);
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
            {childCount > 0 ? (
              <span
                className="shrink-0 text-xs text-muted-foreground tabular-nums"
                aria-label={`${childCount} nested`}
              >
                {childCount}
              </span>
            ) : null}
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
              withLines(
                wrapWithSuffix(
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="block truncate" />}
                    >
                      {linkName(v || value)}
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      {v || value}
                    </TooltipContent>
                  </Tooltip>,
                ),
              )
            }
          />,
        );
      }

      return wrapExpandable(
        withLines(
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

const TIMESTAMP_HEADERS = { createdAt: "Created", updatedAt: "Updated" };

export function createTimestampColumn<T extends BaseRow>(
  columnHelper: ColumnHelper<T>,
  id: keyof typeof TIMESTAMP_HEADERS,
) {
  return columnHelper.accessor((row) => row[id], {
    id,
    header: TIMESTAMP_HEADERS[id],
    meta: attachCubbyColumnMeta({
      entityColumnRole: "fact",
      mobile: { slot: "hidden" },
      // Copy-only: the display is compact relative ("3mo") but the copy
      // payload is the ISO date-time, which pastes usefully into a spreadsheet.
      cellData: timestampCellData<T>((row) => row[id]),
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
  explanation?: ColumnExplanation;
  /** Entity type for colored placeholder icon when no image */
  entity?: Entity;
  /** Per-row placeholder entity for a table whose rows name different
   *  entities (the Work queue); takes precedence over `entity`. */
  rowEntity?: (row: T) => Entity | undefined;
  /** Field-key id when an entity declares an images column. */
  id?: string;
  /** Defaults to the canonical selected cover or full `displayImages` envelope: the server selects
   *  the row's own or borrowed cover. Supply `getImages` for non-entity display
   *  snapshots or an explicit media projection, not a retired entity slot. */
  getImages?: (row: T) => Array<{ id: string; url: string; filename?: string }>;
  /** The record a row is about, when the row carries no images of its own (a
   *  Suggestion, a recipe line): its cover comes from the table's batched
   *  display-image provider, and a ref-less row shows its entity's icon. */
  imageRef?: (row: T) => EntityRef | null;
  /** Custom className for the column (default: "px-0 py-0 h-px") */
  className?: string;
  /** Mobile projection metadata override */
  mobile?: MobileColumnMeta;
  /** Origin of a projected thumbnail; null marks an ordinary local image. */
  provenance?: EntityFieldProvenance | null;
}

type ImageColumnDef<T extends object> = CubbyColumnDef<
  T,
  Array<{ id: string; url: string; filename?: string }>
>;

/**
 * An entity whose list field is `images` gets its image column under that id,
 * everyone else under `image`. Every "does this table already have an image
 * column?" check must accept both, or the standard prepend adds a second one.
 */
export const isImageColumnId = (id: string | null | undefined): boolean =>
  id === "image" || id === "images";

export function createImageColumn<T extends object>(
  columnHelper: ColumnHelper<T>,
  options: CreateImageColumnOptions<T>,
): ImageColumnDef<T>;
export function createImageColumn<T extends object>(
  columnHelper: ColumnHelper<T>,
  options: CreateImageColumnOptions<T> & {
    getImages: (
      row: T,
    ) => Array<{ id: string; url: string; filename?: string }>;
  },
): ImageColumnDef<T>;
export function createImageColumn<T extends object>(
  columnHelper: ColumnHelper<T>,
  options: CreateImageColumnOptions<T> & {
    imageRef: (row: T) => EntityRef | null;
  },
): ImageColumnDef<T>;
export function createImageColumn<T extends object>(
  columnHelper: ColumnHelper<T>,
  options: CreateImageColumnOptions<T>,
) {
  const { entity } = options;
  const rowEntity = (row: T) => options.rowEntity?.(row) ?? entity;
  const getImages =
    options.getImages ??
    ((row: T) => {
      const { image } = rowDisplayCover(row);
      return image ? [image] : [];
    });

  return columnHelper.accessor((row) => getImages(row), {
    id: options.id ?? "image",
    // The structural divider occupies one pixel beside the full-height cover.
    size: rowDensity().row + 1,
    header: () => <ImageIcon className="size-3 text-muted-foreground" />,
    enableSorting: false,
    enableHiding: false,
    enablePinning: false,
    enableCellSelection: false,
    // h-px trick: setting height:1px on td makes h-full work on children
    // overflow-hidden prevents image from expanding the row. The cover fills
    // the row and opens its own display-image chain, so it takes no rail.
    meta: attachCubbyColumnMeta<T>({
      provenance: options.provenance,
      explanation: options.explanation,
      entityColumnRole: "image",
      entityRefs: options.imageRef
        ? (row: T) => {
            const ref = options.imageRef?.(row);
            return ref ? [ref] : [];
          }
        : undefined,
      className: cn("h-px w-8 overflow-hidden px-0 py-0", options?.className),
      mobile: options?.mobile ?? { slot: "image", priority: -10 },
    }),
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
    cell: (info) => {
      const ref = options.imageRef?.(info.row.original);
      const row = info.row.original;
      const markEntity = rowEntity(row);
      // A chosen emoji replaces the cover; an option glyph replaces the
      // generic type icon when there is no cover.
      const emoji = markEntity ? recordEmojiOf(markEntity, row) : null;
      const glyph =
        markEntity && !emoji ? recordGlyphOf(markEntity, row) : null;
      const thumbnail = ref ? (
        <RefImageThumbnail imageRef={ref} />
      ) : (
        <ImageThumbnail
          images={emoji ? [] : getImages(row)}
          alt="Image"
          entity={markEntity}
          fallback={
            markEntity && (emoji || glyph) ? (
              <RecordEmoji
                entity={markEntity}
                emoji={emoji}
                record={row}
                size={16}
              />
            ) : undefined
          }
        />
      );
      const imageEntity = ref?.entityKind ?? rowEntity(info.row.original);
      const imageId =
        ref?.entityId ??
        z.object({ id: z.string() }).safeParse(info.row.original).data?.id;
      return imageEntity && imageId ? (
        <ImageChainPopover entity={imageEntity} id={imageId}>
          {thumbnail}
        </ImageChainPopover>
      ) : (
        thumbnail
      );
    },
  });
}

function RefImageThumbnail({ imageRef }: { imageRef: EntityRef }) {
  const image = useEntityDisplayImage(imageRef);
  return (
    <ImageThumbnail
      images={
        image
          ? [
              {
                id: entityRefKey(imageRef.entityKind, imageRef.entityId),
                url: image.url,
              },
            ]
          : []
      }
      alt="Image"
      entity={imageRef.entityKind}
    />
  );
}

// A single relation summary is the source shape for both a lone inline link
// and a collection of links. Keeping these schemas singular prevents the two
// renderers from silently accepting different projections for the same entity.
const ingredientInlineSchema = z.object({ id: z.string(), name: z.string() });
const productInlineSchema = z.object({
  id: z.string(),
  name: z.string(),
  brandName: z.string().nullable().optional(),
  fields: z
    .record(z.string(), fieldEnvelope(z.unknown(), z.unknown()))
    .optional(),
});
const recipeInlineSchema = z.object({ id: z.string(), name: z.string() });
const locationInlineSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: locationType.nullable().optional(),
  fields: z
    .record(z.string(), fieldEnvelope(z.unknown(), z.unknown()))
    .optional(),
});
const usdaFoodInlineSchema = z.object({
  fdc_id: z.number(),
  foodInfo: z.object({ description: z.string().nullable() }),
});

type EntityColumnData =
  | { entity: "ingredient"; items: { name: string; id: string }[] }
  | {
      entity: "product";
      items: z.output<typeof productInlineSchema>[];
    }
  | { entity: "recipe"; items: { name: string; id: string }[] }
  | {
      entity: "location";
      items: z.output<typeof locationInlineSchema>[];
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
  return items.map((item) => ({ entityKind: entity, entityId: item.id }));
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
    columnGroup?: string;
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
      columnGroup: options?.columnGroup,
      className: options?.className
        ? `${options.className} overflow-hidden`
        : undefined,
      filterConfig: options?.filterConfig,
      mobile: options?.mobile,
      provenance: options?.provenance,
      linksTo: entity,
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
  /** The entity declares `list.quickActions`: the row's quick command leads. */
  quick?: boolean;
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
    options?.quick
      ? (row) => <RowQuickAction entity={entity} row={row} />
      : undefined,
  );
}

export function createActionsColumnBase<T extends RowData>(
  columnHelper: ColumnHelper<T>,
  getLinkProps: RowLinkResolver<T>,
  extraActions?: (row: T) => ReactNode,
  /** A command drawn before the row menu; the column widens to hold it. */
  leading?: (row: T) => ReactNode,
) {
  // One roster: the row's actions menu and its desktop right-click menu.
  const rowMenu = (row: T) => {
    const linkProps = getLinkProps(row);
    return (
      <>
        {linkProps && (
          <DropdownMenuItem
            render={<Link to={linkProps.to} params={linkProps.params} />}
          >
            <EyeIcon />
            View details
          </DropdownMenuItem>
        )}
        {extraActions?.(row)}
      </>
    );
  };
  return columnHelper.display({
    id: "actions",
    header: "",
    enableSorting: false,
    enableHiding: false,
    enableCellSelection: false,
    size: leading ? 104 : 40,
    minSize: leading ? 104 : 40,
    maxSize: leading ? 120 : 72,
    meta: attachCubbyColumnMeta<T>({
      entityColumnRole: "action",
      mobile: { slot: "actions", priority: 100 },
      rowMenu,
    }),
    cell: (info) => {
      const row = info.row.original;
      const menu = (
        <DropdownMenu>
          <MoreMenuTrigger
            aria-label="Row actions"
            size="icon-sm"
            onClick={(e) => e.stopPropagation()}
          />
          {/* The mobile card's row is a click-through to the detail page —
              without this, an item click (React's synthetic events bubble
              through the portal's React-tree parent, not just the real DOM)
              falls through to the row's onClick and navigates away instead
              of running the action. */}
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {rowMenu(row)}
          </DropdownMenuContent>
        </DropdownMenu>
      );
      return leading ? (
        <span className="flex items-center justify-end gap-1">
          {leading(row)}
          {menu}
        </span>
      ) : (
        menu
      );
    },
  });
}

/** Scalar adapters own projection and presentation; this assembly shares their
 * row descriptor between range operations and the rendered editor. Accessor
 * reads stay lazy so generated cells can intentionally re-read the original row.
 */
export function createEditableAccessorColumn<
  T extends RowData,
  TValue,
  TSaved extends CellJsonValue | null | void,
>(
  columnHelper: ColumnHelper<T>,
  valueFor: (row: T) => TValue,
  options: Pick<
    CubbyColumnDef<T, TValue>,
    "id" | "header" | "enableSorting" | "footer"
  > & {
    id: string;
    meta?: Omit<NonNullable<CubbyColumnDef<T, TValue>["meta"]>, "cellData">;
    cellData: ColumnCellData<T, TSaved> | undefined;
    renderValue: (row: T, value: () => TValue) => ReactNode;
    renderEditable?: (
      row: T,
      value: () => TValue,
      clipboard: CellClipboardSpec<TSaved>,
    ) => ReactNode;
  },
) {
  return columnHelper.accessor(valueFor, {
    id: options.id,
    header: options.header,
    enableSorting: options.enableSorting,
    footer: options.footer,
    meta: attachCubbyColumnMeta({
      ...options.meta,
      cellData: options.cellData,
    }),
    cell: (info: CellContext<T, TValue>) => {
      const row = info.row.original;
      const value = () => info.getValue();
      return options.renderEditable && options.cellData
        ? options.renderEditable(
            row,
            value,
            specFromCellData(options.cellData, row),
          )
        : options.renderValue(row, value);
    },
  });
}

export function createTextColumn<K extends PropertyKey, T extends object>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options?: {
    header?: string;
    placeholder?: string;
    className?: string;
    /** A code or identifier column: see `CubbyColumnMeta.code`. */
    code?: boolean;
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
      renderScalarValue(
        { kind: "text", raw: v ?? "", label: v ?? "" },
        "list",
      ));
  const renderRow = (value: string | null, row: T) => renderValue(value, row);
  const editable = options?.editable;
  const textValue = (row: T): string | null =>
    z
      .string()
      .nullish()
      .parse(readPathValue(row, String(accessor))) ?? null;

  const cellData = textCellData<T>(
    "text",
    textValue,
    editable ? (row, v) => editable.onSave(v, row) : undefined,
  );

  const definition = createEditableAccessorColumn(columnHelper, textValue, {
    id: String(accessor),
    header: options?.header,
    meta: {
      className: options?.className,
      code: options?.code,
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
    },
    cellData,
    renderValue: (row, value) => renderRow(value(), row),
    renderEditable: editable
      ? (row, value, clipboard) => (
          <EditableCell
            value={value()}
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

/** A string value drawn from a fixed option roster; read-only without `editable`. */
export function createSelectColumn<K extends PropertyKey, T extends object>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options: {
    options: PickerOption[];
    header?: string;
    className?: string;
    size?: number;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
    editable?: {
      onSave: (newValue: string | null, row: T) => Promise<void>;
    };
  },
) {
  const roster = options.options;
  const editable = options.editable;
  const selectValue = (row: T): string | null =>
    z
      .string()
      .nullish()
      .parse(readPathValue(row, String(accessor))) ?? null;
  const cellData = selectCellData<T>(
    selectValue,
    roster,
    editable ? (row, v) => editable.onSave(v, row) : undefined,
  );
  const definition = createEditableAccessorColumn(columnHelper, selectValue, {
    id: String(accessor),
    header: options.header,
    meta: {
      className: options.className,
      mobile: options.mobile,
      filterConfig: options.filterConfig,
    },
    cellData,
    renderValue: (_row, value) => renderOptionCell(value(), roster),
    renderEditable: editable
      ? (row, value, clipboard) => (
          <EditableCell
            value={value()}
            onSave={(newValue) => editable.onSave(newValue, row)}
            clipboard={clipboard}
            config={{ type: "select", options: roster }}
            renderValue={(value) => renderOptionCell(value, roster)}
          />
        )
      : undefined,
  });
  if (options.size !== undefined)
    Object.assign(definition, { size: options.size });
  // A client-side table resolves its filterFn from the ROW value's type, so a
  // string column handed an array of chosen options would match nothing.
  if (options.filterConfig?.filterType === "multiselect") {
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
  // Money reads in ink and `CurrencyValue` greens only credits; a sign-tinted
  // column also weights positive spend.
  const toneClass = (v: number) =>
    signedTone && v >= 0 ? "font-medium" : undefined;
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
      <CurrencyValue
        value={v}
        decimals={decimals}
        className={toneClass(v)}
        interactive={!editable}
      />
    );
  return createEditableAccessorColumn(
    columnHelper,
    (row: T) => row[accessor] ?? null,
    {
      id: String(accessor),
      header: options?.header,
      meta: {
        numeric: true,
        valueKind: "money",
        className: cn(options?.className ?? defaultClassName, "truncate"),
        mobile: options?.mobile,
      },
      cellData,
      footer: (info) => {
        // Only a server aggregate can represent the full filtered set.
        const total =
          info.table.options.meta?.serverTotals?.sums?.[info.column.id];
        if (total === undefined) return null;
        // Honor signedTone: a net-positive total (spend) stays neutral, a
        // negative total (net credit) greens — matching the cell values above so
        // the footer never reads as the wrong sign.
        return (
          <span className={cn("tabular-nums", toneClass(total))}>
            <CurrencyValue value={total} decimals={decimals} />
          </span>
        );
      },
      renderValue: (_row, value) => renderValue(value()),
      renderEditable: editable
        ? (row, value, clipboard) => (
            <EditableCell
              value={value()}
              onSave={(newValue) => editable.onSave(newValue, row)}
              clipboard={clipboard}
              config={{ type: "currency" }}
              renderValue={renderValue}
            />
          )
        : undefined,
    },
  );
}

type SingleEntityColumnData =
  | { entity: "ingredient"; data: { name: string; id: string } | null }
  | {
      entity: "product";
      data: z.output<typeof productInlineSchema> | null;
    }
  | { entity: "recipe"; data: { name: string; id: string } | null }
  | {
      entity: "location";
      data: z.output<typeof locationInlineSchema> | null;
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
    entityKind: entity,
    entityId: "id" in data ? data.id : "",
  });
  if (entity === "usda-food") {
    return <EntityRefLink entity="usda-food" data={data} />;
  }
  return (
    <EntityRefLink displayImage={displayImage} entity={entity} data={data} />
  );
}

const singleEntitySchemas = {
  ingredient: ingredientInlineSchema,
  product: productInlineSchema,
  recipe: recipeInlineSchema,
  location: locationInlineSchema,
  "usda-food": usdaFoodInlineSchema,
};

type SingleEntityAdapter = {
  /** Validates a row's relation summary once before constructing its UI data. */
  parse: (
    queryClient: QueryClient,
    value: unknown,
  ) => { item: ComboboxItem<string> | null; link: ReactNode } | null;
  /** A collection parser derived from this adapter's singular schema. */
  renderCollection?: (value: unknown, dedupe: boolean) => ReactNode;
  SearchProvider?: (props: SearchProviderProps<string>) => ReactNode;
};

function defineSingleEntityAdapter<TData>(
  schema: z.ZodType<TData>,
  options: {
    buildItem?: (queryClient: QueryClient, data: TData) => ComboboxItem<string>;
    renderLink: (data: TData) => ReactNode;
    renderCollection?: (items: TData[]) => ReactNode;
    collectionId?: (item: TData) => string;
    SearchProvider?: (props: SearchProviderProps<string>) => ReactNode;
  },
): SingleEntityAdapter {
  const collectionSchema = z.array(schema);
  return {
    SearchProvider: options.SearchProvider,
    parse: (queryClient, value) => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return null;
      return {
        item: options.buildItem?.(queryClient, parsed.data) ?? null,
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
 * The complete relation-picker roster. Each entry owns the schema for its
 * projected value, the item converter used by editable cells, its real inline
 * link, and (when this relation can be edited) the deferred search provider.
 * Keeping these together prevents a newly supported target from gaining only
 * one of display, clipboard conversion, or search.
 */
const singleEntityAdapters = {
  ingredient: defineSingleEntityAdapter(ingredientInlineSchema, {
    buildItem: (queryClient, data) =>
      buildRecordComboboxItem(queryClient, "ingredient", data),
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="ingredient" data={data} />
    ),
    renderCollection: (items) => (
      <ListRefLink
        entity="ingredient"
        items={items}
        maxItems={1}
        compact
        resolveImages={false}
      />
    ),
    collectionId: (item) => item.id,
    SearchProvider: referenceEntitySearch("ingredient"),
  }),
  product: defineSingleEntityAdapter(productInlineSchema, {
    buildItem: (queryClient, data) =>
      buildRecordComboboxItem(queryClient, "product", data),
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="product" data={data} />
    ),
    renderCollection: (items) => (
      <ListRefLink
        entity="product"
        items={items}
        maxItems={1}
        compact
        resolveImages={false}
      />
    ),
    collectionId: (item) => item.id,
    SearchProvider: referenceEntitySearch("product"),
  }),
  recipe: defineSingleEntityAdapter(recipeInlineSchema, {
    buildItem: (queryClient, data) =>
      buildRecordComboboxItem(queryClient, "recipe", data),
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="recipe" data={data} />
    ),
    renderCollection: (items) => (
      <ListRefLink
        entity="recipe"
        items={items}
        maxItems={1}
        compact
        resolveImages={false}
      />
    ),
    collectionId: (item) => item.id,
    SearchProvider: referenceEntitySearch("recipe"),
  }),
  location: defineSingleEntityAdapter(locationInlineSchema, {
    buildItem: (queryClient, data) =>
      buildRecordComboboxItem(queryClient, "location", data),
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="location" data={data} />
    ),
    renderCollection: (items) => (
      <ListRefLink
        entity="location"
        items={items}
        maxItems={1}
        compact
        resolveImages={false}
      />
    ),
    collectionId: (item) => item.id,
    SearchProvider: referenceEntitySearch("location"),
  }),
  "usda-food": defineSingleEntityAdapter(usdaFoodInlineSchema, {
    renderLink: (data) => (
      <CanonicalSingleEntityLink entity="usda-food" data={data} />
    ),
  }),
} satisfies Record<SingleEntityColumnData["entity"], SingleEntityAdapter>;

function parseSingleEntity(
  queryClient: QueryClient,
  entity: SingleEntityColumnData["entity"],
  data: Exclude<SingleEntityColumnData["data"], null>,
) {
  return singleEntityAdapters[entity].parse(queryClient, data);
}

function buildSingleEntityItem(
  queryClient: QueryClient,
  entity: EditableSingleEntity,
  data: Exclude<SingleEntityColumnData["data"], null>,
) {
  return parseSingleEntity(queryClient, entity, data)?.item ?? null;
}

function renderSingleEntityLink(
  queryClient: QueryClient,
  entity: SingleEntityColumnData["entity"],
  data: Exclude<SingleEntityColumnData["data"], null>,
) {
  return parseSingleEntity(queryClient, entity, data)?.link ?? <NoneValue />;
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

const hasShortcodes = entityMembership(shortcodeEntities);

export function createSingleEntityInlineLinkColumn<
  TEntity extends SingleEntityColumnData["entity"],
  K extends PropertyKey,
  T extends object,
>(
  queryClient: QueryClient,
  columnHelper: ColumnHelper<T>,
  accessor: K,
  entity: TEntity,
  options?: {
    columnGroup?: string;
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
  const valueFor = (row: T): SingleEntityColumnData["data"] => {
    const value = readPathValue(row, String(accessor));
    // Parse the declared entity: an identity-only sibling schema strips its content.
    const parsed = singleEntitySchemas[entity].safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  // An entity without shortcodes has no generic picker or reference, so it is
  // never copy/pasteable, editable or a counted reference here.
  const cellData = !hasShortcodes.has(entity)
    ? undefined
    : entityCellData<T, string>(
        entity,
        (value) => parseShortcodeFor(entity, value),
        (row) => {
          const item = valueFor(row);
          if (!item) return null;
          return buildSingleEntityItem(queryClient, entity, item);
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
      columnGroup: options?.columnGroup,
      className: options?.className,
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
      provenance: options?.provenance,
      cellData,
      linksTo: entity,
      entityRefs: (row) => {
        const item = valueFor(row);
        return !hasShortcodes.has(entity) || !item || !("id" in item)
          ? []
          : [{ entityKind: entity, entityId: item.id }];
      },
    }),
    cell: (info) => {
      const item = info.getValue();
      const editable = options?.editable;

      if (
        editable &&
        hasShortcodes.has(entity) &&
        (editable.isEditable?.(info.row.original) ?? true)
      ) {
        const SearchProvider = singleEntityAdapters[entity].SearchProvider;
        if (!SearchProvider) return <NoneValue />;
        const row = info.row.original;
        const current = item
          ? buildSingleEntityItem(queryClient, entity, item)
          : null;
        const suggestConfig = editable.suggest;
        const suggestRecordId = suggestConfig
          ? savedRecordShortcode(suggestConfig.entity, row)
          : undefined;
        const suggest = suggestConfig
          ? {
              ...(suggestRecordId && { entityId: suggestRecordId }),
              basisMode: "provided" as const,
              entity: suggestConfig.entity,
              targets: [suggestConfig.field],
              basis: fieldSuggestionBasisFromRecord(
                queryClient,
                suggestConfig.entity,
                suggestTargetsFor(queryClient, suggestConfig.entity, [
                  suggestConfig.field,
                ]),
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
              // (`id in item` is a type guard only — an id-less entity has no
              // shortcodes, so it can't reach the editable branch.)
              const currentItem = item
                ? buildSingleEntityItem(queryClient, entity, item)
                : null;
              const currentId = currentItem?.id ?? null;
              if (item && v.id === currentId) {
                return renderSingleEntityLink(queryClient, entity, item);
              }
              return <span className="truncate">{v.name}</span>;
            }}
          />
        );
      }

      if (!item) return <NoneValue />;
      return renderSingleEntityLink(queryClient, entity, item);
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
  options: readonly PickerOption[],
  /** A measure that qualifies the status (a score), inside the same pill. */
  detail?: ReactNode,
): ReactNode {
  if (value == null || value === "") return <NoneValue />;
  const option = options.find((o) => o.value === value);
  return (
    <EnumPill
      optionRole={option?.role}
      glyph={option?.glyph}
      value={value}
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
export function createBooleanColumn<K extends PropertyKey, T extends object>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options: {
    header?: string;
    placeholder?: string;
    /**
     * The two decided states, as a `{value: "true"|"false", label, color}` roster
     * — build it with `booleanCellOptions` (~/ui/combobox/select-options).
     *
     * A roster rather than a `labels` pair plus built-in tones, because "true" is
     * not always the good outcome: a planned Expense is amber rather than
     * green. Hardcoding
     * positive/slate here made that column's list cell disagree with its own
     * detail page, and silently turned a deliberately-amber "Planned" expense
     * green. Passing the roster means the column and every other surface that
     * renders the field read from one declaration.
     */
    trueFalseOptions: PickerOption[];
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
  // A row with a canonical field envelope displays the
  // effective value but edits the stored one, like generic entity fields; a
  // cell cleared to undecided therefore shows the inherited value again.
  const stored = (row: T): boolean | null => {
    const envelope = fieldResolutionFor(row, String(accessor));
    const value: unknown = envelope
      ? envelope.current.assignment?.kind === "value"
        ? envelope.current.assignment.value
        : null
      : readRecordField(row, String(accessor), optionalBooleanSchema);
    return typeof value === "boolean" ? value : null;
  };
  const effective = (row: T): boolean | null | undefined => {
    const resolution = fieldResolutionFor(row, String(accessor));
    if (!resolution) return stored(row);
    const value = fieldValueOf(resolution);
    return typeof value === "boolean" ? value : null;
  };
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
    (row) => encode(effective(row)),
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
    (row: T) => encode(effective(row)),
    {
      id: String(accessor),
      header: options.header,
      enableSorting: false,
      meta: {
        className: options.className,
        mobile: options.mobile,
        filterConfig,
      },
      cellData,
      renderValue: (_row, value) => renderOptionCell(value(), selectOptions),
      renderEditable: editable
        ? (row, value, clipboard) => (
            <EditableCell
              value={encode(stored(row))}
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
                renderOptionCell(
                  nextValue === encode(stored(row)) ? value() : nextValue,
                  selectOptions,
                )
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

  const renderValue = (value: string | number | null | undefined) => {
    if (value === null || value === undefined) return <NoneValue />;
    const shown = display(String(value));
    return (
      <EntityRouteLink to={linkTo} params={{ id: shown }} tone="mono">
        {shown}
      </EntityRouteLink>
    );
  };
  return createEditableAccessorColumn(columnHelper, (row: T) => row[accessor], {
    id: String(accessor),
    header: options?.header,
    meta: {
      className: options?.className,
      mono: true,
      code: true,
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
    },
    cellData,
    renderValue: (_row, value) => renderValue(value()),
    renderEditable: editable
      ? (row, value, clipboard) => {
          const raw = value();
          return (
            <EditableCell
              value={raw !== null && raw !== undefined ? String(raw) : null}
              onSave={(newValue) => editable.onSave(newValue, row)}
              clipboard={clipboard}
              config={{ type: "text" }}
              trigger="pencil"
              renderValue={(v) => (v === "" ? <NoneValue /> : renderValue(v))}
            />
          );
        }
      : undefined,
  });
}

export function createEditableAmountColumn<T extends object>(
  columnHelper: ColumnHelper<T>,
  accessor: (row: T) => Amount | null,
  options: {
    id: string;
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
  const valueFor = accessor;
  const cellData = {
    ...amountCellData<T>(valueFor, (row, amount) =>
      options.onSave(amount, row),
    ),
    canWrite: (row: T) => options.isEditable?.(row) !== false,
  };
  const renderDisplay = options.renderDisplay;
  return columnHelper.accessor(valueFor, {
    id: options.id,
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

      if (amount === null || options.isEditable?.(row) === false) {
        const display =
          amount === null ? (
            <NoneValue />
          ) : (
            <span>{tryFormatAmount(amount)}</span>
          );
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
export function createPlainDateColumn<K extends PropertyKey, T extends object>(
  columnHelper: ColumnHelper<T>,
  accessor: K,
  options?: {
    header?: string;
    className?: string;
    mobile?: MobileColumnMeta;
    filterConfig?: FilterConfig;
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
  const valueFor = (row: T): string | null =>
    z
      .string()
      .nullish()
      .parse(readPathValue(row, String(accessor))) ?? null;
  const renderValue = (value: string | null, row: T, muted?: boolean) =>
    value ? (
      <span className={muted ? "text-muted-foreground" : undefined}>
        {renderScalarValue({
          kind: "date",
          raw: value,
          due: isOpenDeadline(String(accessor), row),
        })}
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
    meta: {
      className: options?.className,
      mobile: options?.mobile,
      filterConfig: options?.filterConfig,
    },
    cellData,
    renderValue: (row, value) => {
      const display = options?.displayValue?.(row);
      return renderValue(display?.value ?? value(), row, display?.muted);
    },
    renderEditable: editable
      ? (row, value, clipboard) => {
          const display = options?.displayValue?.(row);
          const editableValue = options?.editValue
            ? options.editValue(row)
            : value();
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
                  row,
                  optimistic == null && display?.muted,
                )
              }
            />
          );
        }
      : undefined,
  });
}
