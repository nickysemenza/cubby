import { closestCenter } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import type {
  CellData,
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ColumnVisibilityState,
  RowData,
} from "@tanstack/react-table";
import {
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { z } from "zod";

import {
  createDndAnnouncements,
  cubbyDndScreenReaderInstructions,
} from "~/ui/dnd/accessibility";
import { useCubbyDndSensors } from "~/ui/dnd/sensors";

import { CELL_RAIL_SLOT_PX } from "./cell-frame";
import {
  materializeCubbyColumns,
  type CubbyColumnCollection,
  type CubbyColumnDef,
  type CubbyTable,
} from "./table-features";
import type { CubbyColumnMeta, EntityColumnRole } from "./table-meta";

type MaterializedColumnDef<TData extends RowData> = CubbyColumnDef<
  TData,
  CellData
>;

/** A count's "#" header over "12" paints about 33px. */
export const MIN_COLUMN_WIDTH = 32;

/** Structural roles that always lead the desktop table in this order. */
const LOCKED_START_COLUMN_ROLES: readonly EntityColumnRole[] = [
  "selection",
  "image",
];

/**
 * Structural columns that always trail the desktop table.
 *
 * The row-actions menu is the one control that must stay findable in the same
 * place on every table, so it is not the user's to move: it is force-ordered
 * last, pinned to the `end` region (which also keeps it reachable on a
 * horizontally scrolled table) and appended AFTER any column the user pinned
 * there themselves. Left as an ordinary center column it was draggable, and one
 * drag stranded it mid-table for good.
 */
const LOCKED_END_COLUMN_ROLES: readonly EntityColumnRole[] = ["action"];

type RoleBearingColumn = {
  id: string;
  columnDef: { meta?: { entityColumnRole?: EntityColumnRole } };
};

function isLockedRole(role: EntityColumnRole | undefined) {
  return (
    role != null &&
    (LOCKED_START_COLUMN_ROLES.includes(role) ||
      LOCKED_END_COLUMN_ROLES.includes(role))
  );
}

/** Either end's structural columns: never dragged, hidden, or re-pinned. */
export function isLockedColumn(column: RoleBearingColumn) {
  return isLockedRole(column.columnDef.meta?.entityColumnRole);
}

/**
 * Re-sorts an id list so the locked-end columns trail it, preserving the order
 * of everything else. A placement appends to its region, and a saved view's
 * layout is hand-written — this keeps either from outranking the actions menu.
 */
function withLockedEndLast<TData extends RowData>(
  table: CubbyTable<TData>,
  ids: readonly string[],
) {
  const lockedEnd = new Set(
    table
      .getAllLeafColumns()
      .filter((column) => {
        const role = column.columnDef.meta?.entityColumnRole;
        return role != null && LOCKED_END_COLUMN_ROLES.includes(role);
      })
      .map((column) => column.id),
  );
  return [
    ...ids.filter((id) => !lockedEnd.has(id)),
    ...ids.filter((id) => lockedEnd.has(id)),
  ];
}

export const columnRegionSchema = z.enum(["start", "center", "end"]);
export type ColumnRegion = z.infer<typeof columnRegionSchema>;

export function columnRegion(column: {
  getIsPinned: () => false | "start" | "end";
}): ColumnRegion {
  return column.getIsPinned() || "center";
}

/**
 * One user change to the live column layout.
 *
 * - `reorder`: move `id` onto `over`'s slot inside their shared region (header
 *   drag, move earlier/later). A cross-region pair is rejected.
 * - `place`: put `id` in `region` — onto `over`'s slot when given (customizer
 *   drag), else at the end of a pinned region (pin) or back in its own
 *   `columnOrder` slot among the unpinned columns (unpin).
 */
export type ColumnMove =
  | { kind: "reorder"; id: string; over: string }
  | { kind: "place"; id: string; region: ColumnRegion; over?: string };

/**
 * Each region's columns in display order. Pinned regions follow
 * `columnPinning`, the center follows `columnOrder` — the same sources the
 * header renders from, so every surface lists one order.
 */
export function columnsByRegion<TData extends RowData>(
  table: CubbyTable<TData>,
) {
  return {
    start: table.getStartLeafColumns(),
    center: table.getCenterLeafColumns(),
    end: table.getEndLeafColumns(),
  };
}

/**
 * `ids` with `id` moved onto `over`'s slot: `arrayMove` within one region,
 * otherwise inserted before `over`, or appended when there is none.
 */
function placed(
  ids: readonly string[],
  id: string,
  over: string | undefined,
  sameRegion: boolean,
) {
  if (sameRegion && over !== undefined && ids.includes(id)) {
    return arrayMove([...ids], ids.indexOf(id), ids.indexOf(over));
  }
  const rest = ids.filter((item) => item !== id);
  const index = over === undefined ? -1 : rest.indexOf(over);
  rest.splice(index < 0 ? rest.length : index, 0, id);
  return rest;
}

/** The move's columns and regions, or nothing when the policy rejects it. */
function allowedMove<TData extends RowData>(
  table: CubbyTable<TData>,
  move: ColumnMove,
) {
  const column = table.getColumn(move.id);
  const target =
    move.over === undefined ? undefined : table.getColumn(move.over);
  if (!column || isLockedColumn(column) || move.id === move.over) return;
  if (target && isLockedColumn(target)) return;
  if (move.kind === "reorder" && !target) return;
  const region = columnRegion(column);
  const landing = move.kind === "place" ? move.region : region;
  if (target && columnRegion(target) !== landing) return;
  return { column, target, region, landing };
}

/**
 * The single writer of user column-layout changes. Locked structural columns
 * are never the subject or the target of a move, and the locked-end columns
 * stay last in the `end` region.
 *
 * A pinned region's order lives only in `columnPinning`; the center's lives in
 * `columnOrder`, which keeps a pinned column's center slot so unpinning returns
 * it there. Regression: a pinned reorder was once read back from
 * `columnOrder`, so the Columns dialog disagreed with the header and the next
 * placement reverted it. A same-region move uses `arrayMove`, which is where
 * dnd-kit's sortable preview shows the dragged column landing.
 */
export function moveColumn<TData extends RowData>(
  table: CubbyTable<TData>,
  move: ColumnMove,
) {
  const resolved = allowedMove(table, move);
  if (!resolved) return;
  const { column, target, region, landing } = resolved;
  const pinning = table.state.columnPinning;
  const pins = { start: pinning.start ?? [], end: pinning.end ?? [] };
  const sameRegion = region === landing;
  if (!sameRegion && region !== "center") {
    pins[region] = pins[region].filter((id) => id !== column.id);
  }
  if (landing !== "center") {
    pins[landing] = placed(pins[landing], column.id, target?.id, sameRegion);
  } else if (target) {
    const order = table.getAllLeafColumns().map(({ id }) => id);
    table.setColumnOrder(placed(order, column.id, target.id, sameRegion));
  }
  if (sameRegion && region === "center") return;
  table.setColumnPinning({
    start: pins.start,
    end: withLockedEndLast(table, pins.end),
  });
}

/**
 * `DndContext` props shared by the header and the customizer, which keep their
 * own drag strategies but announce and sense drags the same way.
 */
export function useColumnLayoutDndProps(targetNoun: string) {
  const sensors = useCubbyDndSensors({ touchDelay: 150, touchTolerance: 5 });
  // dnd-kit's default `DndDescribedBy-<n>` id comes from a module-level counter
  // that advances differently on the server and the client, so every sortable
  // handle's `aria-describedby` hydration-mismatches. `useId` is tree-stable
  // across SSR and hydration; dnd-kit uses a provided `id` verbatim.
  const id = `DndDescribedBy-${useId()}`;
  return {
    id,
    sensors,
    collisionDetection: closestCenter,
    accessibility: {
      container: globalThis.document?.body,
      screenReaderInstructions: cubbyDndScreenReaderInstructions,
      announcements: createDndAnnouncements({
        item: (column) => `${column} column`,
        target: (column) => `${column} ${targetNoun}`,
      }),
    },
  };
}

/**
 * Replaces the live layout wholesale: Restore default, or a saved view's
 * declared layout (`DataTableViews`).
 */
export function applyColumnLayout<TData extends RowData>(
  table: CubbyTable<TData>,
  layout: CubbyDefaultTableLayout,
) {
  table.setColumnOrder(withLockedEndLast(table, layout.columnOrder));
  table.setColumnPinning({
    start: layout.columnPinning.start ?? [],
    end: withLockedEndLast(table, layout.columnPinning.end ?? []),
  });
  table.setColumnVisibility(layout.columnVisibility);
  table.setColumnSizing(layout.columnSizing);
}

function columnIdHash(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Collision-resistant CSS custom property shared by every column surface. */
type ColumnWidthVariable = `--cubby-column-${string}`;

function columnWidthVariable(id: string): ColumnWidthVariable {
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  return `--cubby-column-${readable}-${columnIdHash(id)}`;
}

function isNonEmptyColumnHeader(header: unknown): header is string {
  return typeof header === "string" && header.trim().length > 0;
}

export function columnWidthValue(id: string) {
  return `var(${columnWidthVariable(id)})`;
}

/** Sticky insets share the same painted widths as cells. */
export function columnOffsetValue(
  columns: readonly { id: string; getSize: () => number }[],
  id: string,
  side: "start" | "end",
) {
  const index = columns.findIndex((column) => column.id === id);
  const preceding =
    side === "start" ? columns.slice(0, index) : columns.slice(index + 1);
  return preceding.length === 0
    ? "0px"
    : `calc(${preceding.map((column) => columnWidthValue(column.id)).join(" + ")})`;
}

type TableWidthColumn = {
  id: string;
  getSize: () => number;
  getIsPinned?: () => false | "start" | "end";
  columnDef: {
    header?: unknown;
    maxSize?: number;
    meta?: {
      entityColumnRole?: EntityColumnRole;
      numeric?: boolean;
      mono?: boolean;
      linksTo?: string;
      cellData?: { kind: string };
    };
  };
};

/** Cell kinds whose content has a natural fixed width; slack never widens them. */
const FIXED_WIDTH_KINDS = new Set([
  "boolean",
  "date",
  "timestamp",
  "number",
  "currency",
  "amount",
  "select",
]);

/**
 * Only the record identity uses pane slack, up to its 240px fit. Widening a
 * fact column only moves it away from its neighbours.
 */
function isFlexibleColumn(column: TableWidthColumn) {
  if (isLockedColumn(column) || column.getIsPinned?.()) return false;
  return column.columnDef.meta?.entityColumnRole === "identity";
}

/**
 * The widest a fitted column paints, by what it holds: a record title stops
 * at 240px, free text at 160px, a status pill or a column of links to one
 * entity (whose names wrap to two lines) at 120px and a code at 96px;
 * clipped values spill over on hover (`useCellSpill`).
 * Quantities, money and dates keep their natural width. A person's resize
 * still reaches `maxSize`.
 */
const IDENTITY_FIT_MAX = 240;
const TEXT_FIT_MAX = 160;
const SELECT_FIT_MAX = 120;
const LINK_FIT_MAX = 120;
const CODE_FIT_MAX = 96;

function kindFitMax(meta: TableWidthColumn["columnDef"]["meta"]) {
  if (meta?.entityColumnRole === "identity") return IDENTITY_FIT_MAX;
  const kind = meta?.cellData?.kind;
  if (meta?.numeric || (kind !== undefined && FIXED_WIDTH_KINDS.has(kind)))
    return kind === "select" ? SELECT_FIT_MAX : Number.POSITIVE_INFINITY;
  if (meta?.mono) return CODE_FIT_MAX;
  if (meta?.linksTo) return LINK_FIT_MAX;
  return TEXT_FIT_MAX;
}

function columnFitMax(column: TableWidthColumn) {
  return Math.min(
    column.columnDef.maxSize ?? Number.POSITIVE_INFINITY,
    kindFitMax(column.columnDef.meta),
  );
}

/** Trailing gutter width variable; it takes whatever the columns cannot use. */
const SPACER_WIDTH_VARIABLE: ColumnWidthVariable = "--cubby-column-spacer";
export const spacerWidthValue = `var(${SPACER_WIDTH_VARIABLE}, 0px)`;

/**
 * Shares `slack` across `candidates` in proportion to configured width, each
 * column capped at its fit maximum; returns what no column could take.
 */
function distributeSlack(
  widths: Record<string, number>,
  candidates: readonly TableWidthColumn[],
  slack: number,
) {
  let remaining = slack;
  let pool = candidates;
  while (remaining > 0 && pool.length > 0) {
    const totalWeight = pool.reduce((total, column) => {
      return total + column.getSize();
    }, 0);
    let distributed = 0;
    const open: TableWidthColumn[] = [];
    for (const column of pool) {
      const share = Math.floor((remaining * column.getSize()) / totalWeight);
      const room = columnFitMax(column) - (widths[column.id] ?? 0);
      const grant = Math.max(0, Math.min(share, room));
      widths[column.id] = (widths[column.id] ?? 0) + grant;
      distributed += grant;
      if (grant === share) open.push(column);
    }
    remaining -= distributed;
    // Nothing capped this round: the floor remainder is sub-pixel noise.
    if (open.length === pool.length || distributed === 0) break;
    pool = open;
  }
  return remaining;
}

/**
 * Resolves the widths the browser should paint without mutating TanStack's own
 * column-sizing state. A user's deliberate resize remains the source of truth
 * (`userSized` and pinned columns never receive slack). A measured width
 * stops at the column's fit maximum. Pane slack goes only to the record
 * identity, up to its 240px fit; the rest goes to the trailing spacer.
 *
 * Regressions: all slack used to go to one column past its maxSize, so a
 * three-column table (Product Categories) painted a 1200px name beside
 * crammed facts; spreading slack evenly then widened every free-text column
 * while the title it exists for stayed truncated; a 560px title then pushed
 * the facts beside it off the pane; and a reference column grew to one long
 * sampled name, painting a 290px column of dashes.
 */
export function resolvedTableColumnWidths(
  columns: readonly TableWidthColumn[],
  availableWidth: number,
  userSized: ReadonlySet<string> = new Set(),
  measured: Readonly<Record<string, number>> = {},
) {
  const widths: Record<string, number> = {};
  for (const column of columns) {
    const fit = measured[column.id];
    widths[column.id] =
      !isLockedColumn(column) && !userSized.has(column.id) && fit !== undefined
        ? Math.min(fit, columnFitMax(column))
        : column.getSize();
  }
  const configuredWidth = Object.values(widths).reduce(
    (total, width) => total + width,
    0,
  );
  const flexible = columns.filter(
    (column) => isFlexibleColumn(column) && !userSized.has(column.id),
  );
  const remaining = distributeSlack(
    widths,
    flexible,
    Math.floor(availableWidth - configuredWidth),
  );
  return { widths, spacer: Math.max(0, remaining) };
}

export function columnWidthVariables(
  columns: readonly TableWidthColumn[],
  availableWidth = 0,
  userSized?: ReadonlySet<string>,
  measured?: Readonly<Record<string, number>>,
): CSSProperties {
  const { widths, spacer } = resolvedTableColumnWidths(
    columns,
    availableWidth,
    userSized,
    measured,
  );
  const variables: CSSProperties &
    Partial<Record<ColumnWidthVariable, string>> = {};
  for (const column of columns) {
    variables[columnWidthVariable(column.id)] =
      `${widths[column.id] ?? column.getSize()}px`;
  }
  variables[SPACER_WIDTH_VARIABLE] = `${spacer}px`;
  return variables;
}

type ColumnDescriptor = { id: string; role?: EntityColumnRole };

function columnDescriptorsFromDefs<TData extends RowData>(
  columns: MaterializedColumnDef<TData>[],
): ColumnDescriptor[] {
  const result: ColumnDescriptor[] = [];
  const visit = (defs: MaterializedColumnDef<TData>[]) => {
    for (const def of defs) {
      if ("columns" in def && Array.isArray(def.columns)) {
        visit(def.columns);
        continue;
      }
      const accessorKey =
        "accessorKey" in def && def.accessorKey != null
          ? String(def.accessorKey)
          : undefined;
      const id =
        def.id ??
        accessorKey?.replaceAll(".", "_") ??
        (isNonEmptyColumnHeader(def.header) ? def.header : undefined);
      if (id) result.push({ id, role: def.meta?.entityColumnRole });
    }
  };
  visit(columns);
  return [
    ...new Map(
      result.map((descriptor) => [descriptor.id, descriptor]),
    ).values(),
  ];
}

function tailwindWidth(className: string, prefix: "w" | "min-w" | "max-w") {
  const escaped = prefix.replace("-", "\\-");
  const arbitrary = className.match(
    new RegExp(`(?:^|\\s)${escaped}-\\[(\\d+)px\\](?:\\s|$)`),
  )?.[1];
  if (arbitrary) return Number(arbitrary);
  const scale = className.match(
    new RegExp(`(?:^|\\s)${escaped}-(\\d+)(?:\\s|$)`),
  )?.[1];
  return scale ? Number(scale) * 4 : undefined;
}

/** Every plain-date column that declares no width of its own. */
const DATE_COLUMN_WIDTH = 72;

/** Above this, a long header clamps rather than widening its column. */
const HEADER_FIT_MAX = 160;

/**
 * Width for a column that declares none, from what its cells hold, so an
 * undeclared manifest column no longer inherits TanStack's blind 150px.
 * Tuned against the 1440px list sweep: a status pill or Yes/No fits, while
 * free text and relation labels truncate with their full value in a title.
 */
function defaultColumnSize(meta: CubbyColumnMeta | undefined) {
  if (meta?.entityColumnRole === "identity") return IDENTITY_FIT_MAX;
  const kind = meta?.cellData?.kind;
  if (kind === "boolean") return 56;
  // Dates and instants stack the day over its compact distance; the longest
  // line, "’24 · 11mo ago", paints about 64px.
  if (kind === "timestamp") return 72;
  if (kind === "date") return DATE_COLUMN_WIDTH;
  if (meta?.numeric || kind === "number" || kind === "currency") return 72;
  if (kind === "amount") return 72;
  if (kind === "select") return 104;
  if (kind?.startsWith("entity:")) return TEXT_FIT_MAX;
  return 160;
}

/**
 * The width a header label needs, estimated from the 12px medium header face
 * (~6.5px per character) plus cell padding; the sort arrow and source icon
 * overlay the header until it is sorted or hovered. Labels wrap to two
 * lines, so the widest line is the longest word or about half the label:
 * "Itemization coverage" no longer sets the width of its pill column.
 */
function headerFitWidth(label: string) {
  const longestWord = Math.max(
    ...label.split(/\s+/).map((word) => word.length),
  );
  const line = Math.max(longestWord, Math.ceil(label.length * 0.55));
  return Math.min(Math.ceil(line * 6.5) + 8, HEADER_FIT_MAX);
}

/**
 * Width the cell rail reserves for this column's always-visible affordance,
 * an actionable suggestion mark, on top of the value's width. The
 * explanation and relation-workbench controls overlay the active row's cell
 * (`CellFrame overlay`) and reserve nothing.
 */
export function columnRailWidth(meta: CubbyColumnMeta | undefined) {
  return meta?.suggest ? CELL_RAIL_SLOT_PX : 0;
}

function normalizedColumnSize<TData extends RowData>(
  definition: MaterializedColumnDef<TData>,
  className: string,
) {
  // Symbolic manifest width buckets describe text, while measurements retain
  // their natural width. Explicit numeric definitions and user resizing win.
  const kind = definition.meta?.cellData?.kind;
  const measurement = kind === "amount" || kind === "currency";
  const declared =
    definition.size ??
    (measurement ? undefined : tailwindWidth(className, "w"));
  const role = definition.meta?.entityColumnRole;
  if (role === "image") {
    // Image preview owns provenance work; only the explanation occupies a rail.
    const fixed = declared ?? 32;
    return { size: fixed, minSize: fixed, maxSize: fixed };
  }
  const rail = isLockedRole(role) ? 0 : columnRailWidth(definition.meta);
  const size =
    declared !== undefined
      ? declared + rail
      : Math.max(
          defaultColumnSize(definition.meta) + rail,
          isNonEmptyColumnHeader(definition.header)
            ? headerFitWidth(definition.meta?.shortHeader ?? definition.header)
            : 0,
        );
  const minSize =
    definition.minSize ??
    tailwindWidth(className, "min-w") ??
    Math.min(size, MIN_COLUMN_WIDTH + rail);
  // At least the identity fit, so a narrow default (a 72px stacked date)
  // never clips the one-line form it paints outside a desktop row; each
  // kind's fit cap still bounds what measurement may claim.
  const maxSize =
    definition.maxSize ??
    tailwindWidth(className, "max-w") ??
    Math.max(size * 2, minSize, IDENTITY_FIT_MAX);
  return { size, minSize, maxSize };
}

/**
 * Imports the old Tailwind width vocabulary once at the deep-module boundary.
 * v9 numeric sizes then own rendering, sticky offsets, and resizing.
 */
function normalizeColumnDefinitions<TData extends RowData>(
  columns: MaterializedColumnDef<TData>[],
): MaterializedColumnDef<TData>[] {
  return columns.map((definition) => {
    if ("columns" in definition && Array.isArray(definition.columns)) {
      return {
        ...definition,
        columns: normalizeColumnDefinitions(definition.columns),
      };
    }
    const className = definition.meta?.className ?? "";
    const role = definition.meta?.entityColumnRole;
    const normalized = {
      ...definition,
      ...normalizedColumnSize(definition, className),
    };
    if (isLockedRole(role)) {
      Object.assign(normalized, {
        enablePinning: false,
        enableHiding: false,
        enableCellSelection: false,
      });
    }
    // Image is a structural identity strip, not a data column. Keep it exactly
    // as wide as its declared thumbnail cell so a stray resize cannot leave an
    // empty gutter between the dedicated image and the record name.
    if (role === "image") {
      Object.assign(normalized, { enableResizing: false });
    }
    return normalized;
  });
}

/** The in-session-only column layout every Cubby table seeds `initialState` from. */
export interface CubbyDefaultTableLayout {
  columnOrder: ColumnOrderState;
  columnPinning: ColumnPinningState;
  columnVisibility: ColumnVisibilityState;
  columnSizing: ColumnSizingState;
}

function computeDefaultLayout(
  descriptors: readonly ColumnDescriptor[],
  initialColumnVisibility: ColumnVisibilityState,
): CubbyDefaultTableLayout {
  const idsForRole = (role: EntityColumnRole) =>
    descriptors
      .filter((descriptor) => descriptor.role === role)
      .map((descriptor) => descriptor.id);
  const lockedStart = LOCKED_START_COLUMN_ROLES.flatMap(idsForRole);
  const lockedEnd = LOCKED_END_COLUMN_ROLES.flatMap(idsForRole);
  const lockedIds = new Set([...lockedStart, ...lockedEnd]);
  const columnIds = descriptors.map(({ id }) => id);
  const rest = columnIds.filter((id) => !lockedIds.has(id));
  const qualityIndex = rest.indexOf("dataQuality");
  if (qualityIndex >= 0) {
    rest.splice(qualityIndex, 1);
    const identityIndex = descriptors.findIndex(
      (descriptor) => descriptor.role === "identity",
    );
    const identityID = descriptors[identityIndex]?.id;
    rest.splice(
      identityID ? Math.max(0, rest.indexOf(identityID) + 1) : 0,
      0,
      "dataQuality",
    );
  }
  const columnVisibility: ColumnVisibilityState = {};
  for (const id of columnIds) {
    columnVisibility[id] =
      lockedIds.has(id) || initialColumnVisibility[id] !== false;
  }
  return {
    columnOrder: [...lockedStart, ...rest, ...lockedEnd],
    columnPinning: { start: lockedStart, end: lockedEnd },
    columnVisibility,
    // Nothing here is persisted anymore; a resize simply becomes TanStack's own
    // uncontrolled `columnSizing` state after mount, seeded by each column's
    // `size`/`minSize`/`maxSize` (set above), not by an explicit map.
    columnSizing: {},
  };
}

export interface UseTableColumnLayoutResult<TData extends RowData> {
  /** Definitions normalized to v9 numeric sizing at the platform boundary. */
  columns: MaterializedColumnDef<TData>[];
  /** Seeds `initialState` and answers "is this table customized right now?". */
  defaultLayout: CubbyDefaultTableLayout;
}

/**
 * Slim, in-session-only column layout: normalizes column definitions and
 * computes the locked-column default order/pinning/visibility every Cubby
 * table seeds `initialState` from. Carries no state of its own — TanStack
 * Table (v9's own `columnOrder`/`columnPinning`/`columnSizing` state) owns
 * everything after mount, and a caller that needs to read or drive visibility
 * live lifts its own `useState` seeded from `defaultLayout.columnVisibility`.
 */
export function useTableColumnLayout<TData extends RowData>({
  columns,
  initialColumnVisibility = {},
}: {
  columns: CubbyColumnCollection<TData>;
  initialColumnVisibility?: ColumnVisibilityState;
}): UseTableColumnLayoutResult<TData> {
  const normalizedColumns = useMemo(
    () => normalizeColumnDefinitions(materializeCubbyColumns(columns)),
    [columns],
  );
  const columnDescriptors = useMemo(
    () => columnDescriptorsFromDefs(normalizedColumns),
    [normalizedColumns],
  );
  const definitionKey = columnDescriptors
    .map(({ id, role }) => `${id}:${role ?? ""}`)
    .join("");
  const visibilityKey = JSON.stringify(initialColumnVisibility);
  // Fresh column-def arrays are common; their stable signatures are the
  // intended inputs, not their referential identities.
  const defaultLayout = useMemo(
    () => computeDefaultLayout(columnDescriptors, initialColumnVisibility),
    // oxlint-disable-next-line react/exhaustive-deps -- signatures stand in for fresh values
    [definitionKey, visibilityKey],
  );
  return { columns: normalizedColumns, defaultLayout };
}

/**
 * Reveals contextual columns once when a table enters a new worklist. The
 * reveal runs against whatever visibility state is current, so a previously
 * hidden column is visible on arrival; subsequent user toggles remain
 * authoritative until a different context is activated.
 */
export function useRevealTableColumnsOnce(
  setColumnVisibility: Dispatch<SetStateAction<ColumnVisibilityState>>,
  reveal?: { key: string; visibility: ColumnVisibilityState },
) {
  const revealedKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!reveal) {
      revealedKeyRef.current = undefined;
      return;
    }
    if (revealedKeyRef.current === reveal.key) return;
    revealedKeyRef.current = reveal.key;
    setColumnVisibility((current) => ({ ...current, ...reveal.visibility }));
  }, [reveal, setColumnVisibility]);
}

/** Whether the table's current in-session layout differs from its computed default. */
export function isTableLayoutCustomized(
  current: {
    columnOrder: ColumnOrderState;
    columnPinning: ColumnPinningState;
    columnVisibility: ColumnVisibilityState;
    columnSizing: ColumnSizingState;
  },
  defaults: CubbyDefaultTableLayout | undefined,
): boolean {
  if (!defaults) return false;
  if (Object.keys(current.columnSizing).length > 0) return true;
  if (
    JSON.stringify(current.columnOrder) !== JSON.stringify(defaults.columnOrder)
  ) {
    return true;
  }
  if (
    JSON.stringify(current.columnPinning) !==
    JSON.stringify(defaults.columnPinning)
  ) {
    return true;
  }
  // Visibility state is sparse (unset id = visible), so a fair comparison
  // reads both sides through the same "unset counts as visible" rule instead
  // of a raw deep-equal, which would flag e.g. `{}` vs `{foo: true}` as
  // different even though they render identically.
  return defaults.columnOrder.some(
    (id) =>
      (current.columnVisibility[id] !== false) !==
      (defaults.columnVisibility[id] !== false),
  );
}
