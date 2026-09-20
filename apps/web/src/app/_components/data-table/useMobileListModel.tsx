import type { Entity } from "@cubby/schemas/entity";
import { humanize } from "@cubby/shared";
import { parseShortcode } from "@cubby/shared";
import type { CellData, RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import { isValidElement, type ReactNode, useMemo } from "react";
import { z } from "zod";

import { NoneValue } from "~/components/ui/none-value";
import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import { FieldProvenance } from "~/entities/field-provenance";
import { extractEntityTitle } from "~/lib/entity-utils";

import type { MobileColumnMeta, MobileSlot } from "./columnHelpers";
import { RelationFieldWorkbench } from "./relation-field-workbench";
import type {
  CubbyColumn as Column,
  CubbyTable as ITable,
  CubbyRow as Row,
} from "./table-features";

interface SlotValue {
  priority: number;
  value: ReactNode;
  interactive?: boolean;
  id: string;
  label: string;
}

export interface MobileMetaValue {
  id: string;
  label: string;
  value: ReactNode;
  interactive?: boolean;
}

export interface MobileListRowModel<TItem extends RowData> {
  row: Row<TItem>;
  title: string;
  subtitle?: ReactNode;
  imageSlot?: ReactNode;
  actionsContent?: ReactNode;
  rightValues: ReactNode[];
  rightValueInteractive: boolean[];
  metaValues: MobileMetaValue[];
  detailsHref?: string;
  /**
   * Whether the row renders a thumbnail gutter even with no image.
   *
   * Decided per LIST, not per row: in a list whose table has an image column,
   * every card reserves the 44px slot so every title starts on the same left
   * edge. A row-by-row decision put consecutive titles at two different x's,
   * which is what makes a long list unscannable. Lists with no image column
   * reserve nothing — there is no scan line to keep.
   */
  reserveImageSlot: boolean;
}

export function mobileColumnLabel<TItem extends RowData>(
  column: Column<TItem, unknown>,
): string {
  const meta = column.columnDef.meta;
  const header = column.columnDef.header;
  if (meta?.mobile?.label) return meta.mobile.label;
  if (isNonEmptyHeaderLabel(header)) return header;
  return humanize(column.id);
}

function isNonEmptyHeaderLabel<TItem extends RowData>(
  header: Column<TItem, unknown>["columnDef"]["header"],
): header is string {
  return typeof header === "string" && header.trim().length > 0;
}

function isObjectCellValue(value: CellData): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Whether a cell's raw value carries nothing worth a labeled spec row.
 *
 * The object case matters: the entity-link columns accessor to
 * `{ id, name }`, which is truthy even when both are null — so an unlinked
 * expense rendered a full `PRODUCT —` line, 30px of vertical space saying
 * there is no product.
 */
function isEmptyCellValue(value: CellData): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isObjectCellValue(value)) {
    return Object.values(value).every((v) => v === null || v === undefined);
  }
  return false;
}

/**
 * How deep the blank walk descends before giving up and calling a node
 * renderable. Bounded because a cell's element tree is caller-supplied and a
 * pathological one would otherwise be walked per cell, per row, per render.
 */
const BLANK_WALK_DEPTH = 4;

function isTextNode(node: ReactNode): node is string {
  return typeof node === "string";
}

function isNumericNode(node: ReactNode): node is number {
  return typeof node === "number";
}

/**
 * Whether a rendered cell says nothing — the em-dash "no value" placeholder,
 * an empty string, or `NoneValue`.
 *
 * The walk into children is what makes this useful: cells rarely return a bare
 * `<NoneValue />`, they return it wrapped (a tooltip, a link column's span, an
 * editable cell's display shell). A top-level-only check let those through, so
 * a card spent a full 30px labeled spec row stating that a field is empty —
 * which is the opposite of the card's job, and why a list of thousands fit two
 * records per screen. An element whose children prop is absent is treated as
 * renderable: its output is a component's business, not ours to guess.
 */
function isBlankNode(node: ReactNode, depth = 0): boolean {
  if (node === null || node === undefined || node === false || node === true) {
    return true;
  }
  if (isTextNode(node)) {
    const trimmed = node.trim();
    return trimmed === "" || trimmed === "—" || trimmed === "–";
  }
  if (isNumericNode(node)) return false;
  if (Array.isArray(node))
    return node.every((child) => isBlankNode(child, depth));
  if (isValidElement<{ children?: ReactNode }>(node)) {
    if (node.type === NoneValue) return true;
    if (depth >= BLANK_WALK_DEPTH) return false;
    const { children } = node.props;
    if (children === undefined) return false;
    return isBlankNode(children, depth + 1);
  }
  return false;
}

function hasRenderableContent(content: ReactNode): boolean {
  return !isBlankNode(content);
}

const mobileImageRowSchema = z.object({
  // The server-resolved list contract (own or borrowed photos) — every
  // `displayImages` manifest entity's list row carries this.
  displayImages: z.array(z.unknown()).optional(),
  // Non-list shapes (purchase products, kit components, project tools) still
  // carry their own `images[]`, so this stays alongside `displayImages`.
  images: z.array(z.unknown()).optional(),
  imageUrl: z.string().nullish(),
  product: z.object({ images: z.array(z.unknown()).optional() }).optional(),
});

const inventoryMobileRowSchema = z.object({
  product: z.object({ name: z.string().optional() }).optional(),
});

const mobileRouteRowSchema = z.object({ id: z.string().optional() });
const mobileTitleSchema = z.string().trim().min(1);

function mobileTitleText(rendered: ReactNode, rawValue: CellData) {
  const renderedTitle = mobileTitleSchema.safeParse(rendered);
  if (renderedTitle.success) return renderedTitle.data;
  const accessorTitle = mobileTitleSchema.safeParse(rawValue);
  return accessorTitle.success ? accessorTitle.data : undefined;
}

/** Whether a row carries a real image, vs. the cell's placeholder glyph. */
function rowHasImage(original: RowData): boolean {
  const parsed = mobileImageRowSchema.safeParse(original);
  if (!parsed.success) return false;
  const row = parsed.data;
  if (Array.isArray(row.displayImages) && row.displayImages.length > 0) {
    return true;
  }
  if (Array.isArray(row.images) && row.images.length > 0) return true;
  if (row.imageUrl && row.imageUrl.length > 0) return true;
  const nested = row.product?.images;
  return Array.isArray(nested) && nested.length > 0;
}

function inventoryProductName(original: RowData): string | undefined {
  const parsed = inventoryMobileRowSchema.safeParse(original);
  return parsed.success ? parsed.data.product?.name : undefined;
}

function mobileShortcode(original: RowData): string | undefined {
  const parsed = mobileRouteRowSchema.safeParse(original);
  return parsed.success ? parsed.data.id : undefined;
}

/**
 * Which part of the card a column renders into.
 *
 * A mobile row is opt-IN: a column with no `mobile` config is hidden. It used
 * to default to "meta", so every column an entity had never thought about got
 * crammed in as a value — a full desktop cell squeezed into ~90px, truncating
 * to fragments like "whole pea" and "P…" that carry less than showing nothing.
 * Declaring `mobile` at all (even just `{ interactive: true }`) opts a column in.
 *
 * This used to consult a `DEFAULT_HIDDEN_COLUMN_IDS` deny-list FIRST, which
 * outranked the opt-in — so two columns whose authors did ask for a slot
 * (productlist's `food`, locationlist's `inventoryEntries`) could never render
 * no matter what they declared. Under opt-in the deny-list is redundant by
 * construction: anything not asked for is already hidden, and a column that
 * wants to opt out says `slot: "hidden"`.
 */
function resolveSlot(
  colId: string,
  meta?: { mobile?: MobileColumnMeta },
): MobileSlot {
  if (colId === "image") return "image";
  if (colId === "actions") return "actions";
  if (colId === "name" || colId === "filename") return "title";
  if (meta?.mobile) return meta.mobile.slot ?? "meta";
  return "hidden";
}

function getPriority(
  meta: { mobile?: MobileColumnMeta } | undefined,
  fallback: number,
): number {
  return meta?.mobile?.priority ?? fallback;
}

// Slot routing stays centralized so desktop-only columns cannot leak into cards.
// eslint-disable-next-line complexity
function collectMobileSlots<TItem extends RowData>(
  row: Row<TItem>,
  entity: Entity | undefined,
) {
  let title = extractEntityTitle(row.original);
  if (entity === "inventory") {
    title = inventoryProductName(row.original) ?? title;
  }
  let imageSlot: ReactNode | undefined;
  let actionsContent: ReactNode | undefined;
  const subtitleCandidates: SlotValue[] = [];
  const trailingValues: SlotValue[] = [];
  const metaValues: SlotValue[] = [];

  for (const cell of row.getVisibleCells()) {
    const colId = cell.column.id;
    if (colId === "select") continue;
    const meta = cell.column.columnDef.meta;
    const slot = resolveSlot(colId, meta);
    if (slot === "hidden") continue;
    if (cell.column.accessorFn && isEmptyCellValue(cell.getValue())) continue;
    const rendered = flexRender(cell.column.columnDef.cell, cell.getContext());
    if (!hasRenderableContent(rendered)) continue;

    if (slot === "actions") {
      actionsContent = rendered;
      continue;
    }
    if (slot === "image") {
      if (rowHasImage(row.original)) imageSlot = rendered;
      continue;
    }
    if (slot === "title") {
      // Linked desktop identities render a component, but their accessor is
      // still the authoritative plain-text label for the mobile card.
      title = mobileTitleText(rendered, cell.getValue()) ?? title;
      continue;
    }

    const rowId = mobileShortcode(row.original);
    const parsed = rowId ? parseShortcode(rowId) : null;
    const inspectable = meta?.provenance?.sources.some(
      (source) => source.relation !== null,
    );
    const inspectedValue =
      meta?.provenance &&
      inspectable &&
      parsed &&
      !meta.provenanceWorkbenchHandled ? (
        <RelationFieldWorkbench
          sourceEntity={parsed.type}
          sourceId={parsed.shortcode}
          provenance={meta.provenance}
          summary={rendered}
        />
      ) : (
        rendered
      );
    const mobileValue = meta?.provenance ? (
      <span className="inline-flex max-w-full min-w-0 items-center gap-1">
        <span className="min-w-0 truncate">{inspectedValue}</span>
        <FieldProvenance
          provenance={meta.provenance}
          className="inline-flex max-w-36 shrink text-[0.625rem]"
        />
      </span>
    ) : (
      inspectedValue
    );
    const entry: SlotValue = {
      priority: getPriority(meta, 50),
      value: mobileValue,
      interactive: meta?.mobile?.interactive || inspectable,
      id: colId,
      label: mobileColumnLabel(cell.column),
    };
    if (slot === "subtitle") subtitleCandidates.push(entry);
    else if (slot === "trailing") trailingValues.push(entry);
    else metaValues.push(entry);
  }

  return {
    title,
    imageSlot,
    actionsContent,
    subtitleCandidates,
    trailingValues,
    metaValues,
  };
}

function projectMobileRow<TItem extends RowData>({
  row,
  entity,
  basePath,
  getDetailsHref,
  reserveImageSlot,
}: {
  row: Row<TItem>;
  entity: Entity | undefined;
  basePath: string | undefined;
  getDetailsHref: ((item: TItem) => string | undefined) | undefined;
  reserveImageSlot: boolean;
}): MobileListRowModel<TItem> {
  const slots = collectMobileSlots(row, entity);
  slots.subtitleCandidates.sort((a, b) => a.priority - b.priority);
  slots.trailingValues.sort((a, b) => a.priority - b.priority);
  slots.metaValues.sort((a, b) => a.priority - b.priority);
  const [leadingSubtitle, ...extraSubtitles] = slots.subtitleCandidates;
  const shortcode = mobileShortcode(row.original);
  const detailsHref =
    getDetailsHref?.(row.original) ??
    (basePath && shortcode ? `/${basePath}/${shortcode}` : undefined);

  return {
    row,
    title: slots.title,
    subtitle: leadingSubtitle?.value,
    imageSlot: slots.imageSlot,
    actionsContent: slots.actionsContent,
    rightValues: slots.trailingValues.map((item) => item.value),
    rightValueInteractive: slots.trailingValues.map(
      (item) => !!item.interactive,
    ),
    metaValues: [...extraSubtitles, ...slots.metaValues].map(
      ({ id, label, value, interactive }) => ({
        id,
        label,
        value,
        interactive,
      }),
    ),
    detailsHref,
    reserveImageSlot,
  };
}

export function useMobileListModel<TItem extends RowData>({
  table,
  entity,
  getDetailsHref,
  disableDetailsHref,
  rowContentVersion,
}: {
  table: ITable<TItem>;
  entity?: Entity;
  /** Per-row canonical route for heterogeneous rosters. */
  getDetailsHref?: (item: TItem) => string | undefined;
  /** Suppress both canonical and per-row links for specialist interactions. */
  disableDetailsHref?: boolean;
  /** External cell-render state snapshot; see useTableConfig. */
  rowContentVersion?: unknown;
}): MobileListRowModel<TItem>[] {
  const rows = table.getRowModel().rows;
  const basePath =
    !disableDetailsHref && entity && isBrowserRoutedEntity(entity)
      ? entities[entity].basePath
      : undefined;
  const resolvedGetDetailsHref = disableDetailsHref
    ? undefined
    : getDetailsHref;
  // Per-list, not per-row: see `MobileListRowModel.reserveImageSlot`.
  const reserveImageSlot = mobileListLayout(table).hasImage;

  return useMemo(() => {
    // Mobile models store rendered ReactNodes. Reading the external version in
    // this memo makes stateful cell renderers rebuild even when TanStack keeps
    // the same row objects.
    void rowContentVersion;
    return rows.map((row) =>
      projectMobileRow({
        row,
        entity,
        basePath,
        getDetailsHref: resolvedGetDetailsHref,
        reserveImageSlot,
      }),
    );
  }, [
    basePath,
    entity,
    resolvedGetDetailsHref,
    reserveImageSlot,
    rowContentVersion,
    rows,
  ]);
}

//
// Measured in the browser against real rows, not derived from the type scale:
// spec rows come out at 28-32px, not the ~16px a bare text line would suggest,
// because most values are chunky (badges, entity links). An expense with 5
// spec rows measures 226px total.
//   py-2 x2 (16) + title (~19) + hairline (1)        = 36
//   identity line                                     = 24
//   spec block: 2 + n*30 + (n-1)*4
//
// A row carrying an editable cell is taller by `TOUCH_ROW_EXTRA`: those
// controls are held at the 44pt phone floor (`min-h-11` with `-my-1` clawing
// back the row's own padding), which nets +6px over a read-only line.
const ROW_CHROME = 36;
const IDENTITY_LINE = 24;
const SPEC_ROW = 30;
const SPEC_GAP = 4;
const TOUCH_ROW_EXTRA = 6;

/** Height of one spec grid, or 0 when there is none. */
const specBlockHeight = (count: number, interactiveCount: number): number =>
  count
    ? 2 +
      count * SPEC_ROW +
      interactiveCount * TOUCH_ROW_EXTRA +
      (count - 1) * SPEC_GAP
    : 0;

/**
 * Per-row height estimate for the virtualizer.
 *
 * Estimated per row rather than as one constant: rows now range from ~55px
 * (search results, no spec values) to ~152px (a fully-populated expense), and
 * a flat guess that far off makes `getTotalSize()` lurch as measurements land
 * during a fast scroll. This knows an expense missing its project renders one
 * fewer line, so `measureElement` corrects by a few px instead of ~100.
 */
export function estimateMobileRowHeight(model?: MobileRowHeightInput): number {
  if (!model) return 56;
  const identity =
    model.subtitle || model.rightValues.length
      ? IDENTITY_LINE +
        (model.rightValueInteractive.some(Boolean) ? TOUCH_ROW_EXTRA * 2 : 0)
      : 0;
  const spec = specBlockHeight(
    model.metaValues.length,
    model.metaValues.filter((item) => item.interactive).length,
  );
  // Floor: the 44px thumbnail gutter (plus padding) sets a minimum a short row
  // can't undercut — reserved or filled, it occupies the same height.
  const hasThumbGutter = model.reserveImageSlot || Boolean(model.imageSlot);
  return Math.max(ROW_CHROME + identity + spec, hasThumbGutter ? 61 : 41);
}

type MobileRowHeightInput = Pick<
  MobileListRowModel<RowData>,
  | "subtitle"
  | "rightValues"
  | "rightValueInteractive"
  | "metaValues"
  | "imageSlot"
  | "reserveImageSlot"
>;

/**
 * The shape a table's mobile rows will take, for the loading skeleton — so it
 * renders the right number of lines and the list doesn't jump when real rows
 * replace it.
 */
export function mobileListLayout<TItem extends RowData>(table: ITable<TItem>) {
  let metaCols = 0;
  let subtitleCols = 0;
  let hasImage = false;
  for (const column of table.getVisibleLeafColumns()) {
    const meta = column.columnDef.meta;
    const slot = resolveSlot(column.id, meta);
    if (slot === "image") hasImage = true;
    else if (slot === "subtitle") subtitleCols += 1;
    else if (slot === "meta") metaCols += 1;
  }
  return {
    // Extra subtitles fall through to the spec grid — see the model above.
    metaLines: metaCols + Math.max(0, subtitleCols - 1),
    hasImage,
  };
}
