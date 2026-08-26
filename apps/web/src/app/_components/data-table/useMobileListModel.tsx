import type { Entity } from "@cubby/schemas/entity";
import type { RowData } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table";
import { isValidElement, type ReactNode, useMemo } from "react";
import { NoneValue } from "~/components/ui/none-value";
import { entities, isBrowserRoutedEntity } from "~/entities/entities";
import { extractEntityTitle } from "~/lib/entity-utils";
import type { MobileColumnMeta, MobileSlot } from "./columnHelpers";
import type {
  CubbyColumn as Column,
  CubbyTable as ITable,
  CubbyRow as Row,
} from "./table-features";

interface MobileCellMeta {
  mobile?: MobileColumnMeta;
}

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

function humanizeColumnId(colId: string): string {
  return colId
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

export function mobileColumnLabel<TItem extends RowData>(
  column: Column<TItem, unknown>,
): string {
  const meta = column.columnDef.meta as MobileCellMeta | undefined;
  const header = column.columnDef.header;
  if (meta?.mobile?.label) return meta.mobile.label;
  if (typeof header === "string" && header.trim().length > 0) return header;
  return humanizeColumnId(column.id);
}

/**
 * Whether a cell's raw value carries nothing worth a labeled spec row.
 *
 * The object case matters: the entity-link columns accessor to
 * `{ id, name }`, which is truthy even when both are null — so an unlinked
 * expense rendered a full `PRODUCT —` line, 30px of vertical space saying
 * there is no product.
 */
function isEmptyCellValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
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
  if (typeof node === "string") {
    const trimmed = node.trim();
    return trimmed === "" || trimmed === "—" || trimmed === "–";
  }
  if (typeof node === "number") return false;
  if (Array.isArray(node))
    return node.every((child) => isBlankNode(child, depth));
  if (isValidElement(node)) {
    if (node.type === NoneValue) return true;
    if (depth >= BLANK_WALK_DEPTH) return false;
    const { children } = node.props as { children?: ReactNode };
    if (children === undefined) return false;
    return isBlankNode(children, depth + 1);
  }
  return false;
}

function hasRenderableContent(content: ReactNode): boolean {
  return !isBlankNode(content);
}

/** Whether a row carries a real image, vs. the cell's placeholder glyph. */
function rowHasImage(original: unknown): boolean {
  if (!original || typeof original !== "object") return false;
  const row = original as {
    images?: unknown[];
    imageUrl?: string | null;
    product?: { images?: unknown[] };
  };
  if (Array.isArray(row.images) && row.images.length > 0) return true;
  if (typeof row.imageUrl === "string" && row.imageUrl.length > 0) return true;
  const nested = row.product?.images;
  return Array.isArray(nested) && nested.length > 0;
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
function resolveSlot(colId: string, meta?: MobileCellMeta): MobileSlot {
  if (colId === "image") return "image";
  if (colId === "actions") return "actions";
  if (colId === "name" || colId === "filename") return "title";
  if (meta?.mobile) return meta.mobile.slot ?? "meta";
  return "hidden";
}

function getPriority(
  meta: MobileCellMeta | undefined,
  fallback: number,
): number {
  return meta?.mobile?.priority ?? fallback;
}

export function useMobileListModel<TItem extends RowData>({
  table,
  entity,
  getDetailsHref,
  rowContentVersion,
}: {
  table: ITable<TItem>;
  entity?: Entity;
  /** Per-row canonical route for heterogeneous rosters. */
  getDetailsHref?: (item: TItem) => string | undefined;
  /** External cell-render state snapshot; see useTableConfig. */
  rowContentVersion?: unknown;
}): MobileListRowModel<TItem>[] {
  const rows = table.getRowModel().rows;
  const basePath =
    entity && isBrowserRoutedEntity(entity)
      ? entities[entity].basePath
      : undefined;
  // Per-list, not per-row: see `MobileListRowModel.reserveImageSlot`.
  const reserveImageSlot = mobileListShape(table).hasImage;

  return useMemo(
    () =>
      rows.map((row) => {
        let title = extractEntityTitle(row.original);
        // Mobile: drop the redundant " @ Location" suffix — the location is
        // already rendered as the row subtitle, and the suffix forces the
        // product name to truncate mid-word.
        if (entity === "inventory") {
          const product = (row.original as { product?: { name?: string } })
            .product;
          if (product?.name) title = product.name;
        }
        let imageSlot: ReactNode | undefined;
        let actionsContent: ReactNode | undefined;
        const subtitleCandidates: SlotValue[] = [];
        const trailingValues: SlotValue[] = [];
        const metaValues: SlotValue[] = [];

        for (const cell of row.getVisibleCells()) {
          const colId = cell.column.id;
          if (colId === "select") continue;

          const meta = cell.column.columnDef.meta as MobileCellMeta | undefined;
          const slot = resolveSlot(colId, meta);
          if (slot === "hidden") continue;

          // Skip empty raw values quickly to avoid rendering inert wrappers.
          // Only applies to accessor columns — `columnHelper.display()`
          // columns (the actions menu, the USDA-food cell) have no
          // accessorFn, so `getValue()` always resolves undefined and would
          // otherwise get skipped unconditionally, before ever rendering.
          // Those fall through to the post-render `hasRenderableContent`
          // check instead.
          if (cell.column.accessorFn) {
            const rawValue = cell.getValue();
            if (isEmptyCellValue(rawValue)) continue;
          }

          const rendered = flexRender(
            cell.column.columnDef.cell,
            cell.getContext(),
          );
          if (!hasRenderableContent(rendered)) continue;

          if (slot === "actions") {
            actionsContent = rendered;
            continue;
          }
          if (slot === "image") {
            // Only when the row HAS an image. The image cell renders a
            // placeholder glyph otherwise, which read as content while being
            // none — a 44px gutter of noise on every image-less row.
            if (rowHasImage(row.original)) imageSlot = rendered;
            continue;
          }
          if (slot === "title") {
            if (typeof rendered === "string" && rendered.trim().length > 0) {
              title = rendered;
            }
            continue;
          }

          const priority = getPriority(meta, 50);
          const interactive = meta?.mobile?.interactive;
          const label = mobileColumnLabel(cell.column);
          const entry: SlotValue = {
            priority,
            value: rendered,
            interactive,
            id: colId,
            label,
          };
          if (slot === "subtitle") {
            subtitleCandidates.push(entry);
            continue;
          }
          if (slot === "trailing") {
            trailingValues.push(entry);
            continue;
          }
          metaValues.push(entry);
        }

        subtitleCandidates.sort((a, b) => a.priority - b.priority);
        trailingValues.sort((a, b) => a.priority - b.priority);
        metaValues.sort((a, b) => a.priority - b.priority);

        // Nothing is capped — the row grows to fit instead. A fixed budget of
        // two meant expenses declared six values and rendered two, with no
        // way to tell which four were missing.
        //
        // The leading subtitle keeps its own prop (it reads as prose, not a
        // labeled spec value). ADDITIONAL subtitle candidates fall through to
        // the spec grid rather than being dropped — five entities declare two
        // and showed one, a drop nobody had counted.
        const [leadingSubtitle, ...extraSubtitles] = subtitleCandidates;
        const subtitle = leadingSubtitle?.value;

        // `trailing` stays on the identity line: it's the row's headline
        // number, and right-aligned tabular-nums is what makes it scan as a
        // column down the list. Everything else gets a label.
        const rightValues = trailingValues.map((item) => item.value);
        const rightValueInteractive = trailingValues.map(
          (item) => !!item.interactive,
        );
        const specValues: MobileMetaValue[] = [
          ...extraSubtitles,
          ...metaValues,
        ].map(({ id, label, value, interactive }) => ({
          id,
          label,
          value,
          interactive,
        }));

        const rowData = row.original as Record<string, unknown>;
        // Detail routes are keyed on the PUBLIC id. A row without a shortcode
        // (image, usda-food) simply gets no details link rather than a uuid URL
        // that no longer resolves.
        const shortcode = rowData.id as string | undefined;
        const detailsHref =
          getDetailsHref?.(row.original) ??
          (basePath && shortcode ? `/${basePath}/${shortcode}` : undefined);

        return {
          row,
          // Keep the external render dependency in the memoized model itself:
          // mobile cards store ReactNodes, so they must be rebuilt even when
          // TanStack keeps the same rows reference.
          rowContentVersion,
          title,
          subtitle,
          imageSlot,
          actionsContent,
          rightValues,
          rightValueInteractive,
          metaValues: specValues,
          detailsHref,
          reserveImageSlot,
        };
      }),
    [
      basePath,
      entity,
      getDetailsHref,
      reserveImageSlot,
      rowContentVersion,
      rows,
    ],
  );
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
export function estimateMobileRowHeight(
  model?: Pick<
    MobileListRowModel<Record<string, unknown>>,
    | "subtitle"
    | "rightValues"
    | "rightValueInteractive"
    | "metaValues"
    | "imageSlot"
    | "reserveImageSlot"
  >,
): number {
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

/**
 * The shape a table's mobile rows will take, for the loading skeleton — so it
 * renders the right number of lines and the list doesn't jump when real rows
 * replace it.
 */
export function mobileListShape<TItem extends RowData>(
  table: ITable<TItem>,
): {
  metaLines: number;
  hasImage: boolean;
} {
  let metaCols = 0;
  let subtitleCols = 0;
  let hasImage = false;
  for (const column of table.getVisibleLeafColumns()) {
    const meta = column.columnDef.meta as MobileCellMeta | undefined;
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
