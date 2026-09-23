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
  useMemo,
  useRef,
} from "react";

import { isInspectableFieldProvenance } from "~/entities/field-provenance";

import { CELL_RAIL_SLOT_PX } from "./cell-frame";
import {
  materializeCubbyColumns,
  type CubbyColumnCollection,
  type CubbyColumnDef,
} from "./table-features";
import type { CubbyColumnMeta, EntityColumnRole } from "./table-meta";

type MaterializedColumnDef<TData extends RowData> = CubbyColumnDef<
  TData,
  CellData
>;

const MIN_COLUMN_WIDTH = 48;

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
 * of everything else. The drag handlers reject a locked column as the drag
 * subject, but a drop onto empty space past it still appends after it — this is
 * what keeps that landing spot from outranking the actions menu.
 */
export function withLockedEndLast(
  ids: readonly string[],
  lockedEndIds: ReadonlySet<string>,
) {
  const locked = ids.filter((id) => lockedEndIds.has(id));
  return locked.length === 0
    ? [...ids]
    : [...ids.filter((id) => !lockedEndIds.has(id)), ...locked];
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

type TableWidthColumn = {
  id: string;
  getSize: () => number;
  getIsPinned?: () => false | "start" | "end";
  columnDef: {
    header?: unknown;
    maxSize?: number;
    meta?: {
      entityColumnRole?: EntityColumnRole;
      surplus?: boolean;
      numeric?: boolean;
      cellData?: { kind: string };
    };
  };
};

/** Cell kinds whose content has a natural fixed width; slack never widens them. */
const FIXED_WIDTH_KINDS = new Set([
  "boolean",
  "date",
  "number",
  "currency",
  "amount",
  "select",
]);

/**
 * Columns that can use extra width: record identity and free text or
 * relation labels that otherwise truncate. Quantities, dates, and status
 * pills gain nothing from slack but distance from their neighbours.
 */
function isFlexibleColumn(column: TableWidthColumn) {
  if (isLockedColumn(column) || column.getIsPinned?.()) return false;
  const meta = column.columnDef.meta;
  if (meta?.surplus || meta?.entityColumnRole === "identity") return true;
  if (meta?.numeric) return false;
  const kind = meta?.cellData?.kind;
  if (kind !== undefined && FIXED_WIDTH_KINDS.has(kind)) return false;
  return isNonEmptyColumnHeader(column.columnDef.header);
}

/** Trailing gutter width variable; it takes whatever the columns cannot use. */
const SPACER_WIDTH_VARIABLE: ColumnWidthVariable = "--cubby-column-spacer";
export const spacerWidthValue = `var(${SPACER_WIDTH_VARIABLE}, 0px)`;

/**
 * Resolves the widths the browser should paint without mutating TanStack's own
 * column-sizing state. A user's deliberate resize remains the source of truth
 * (`userSized` never receives slack). Pane slack is shared across the flexible
 * columns in proportion to their configured width, each capped at its
 * `maxSize`; what no column can use goes to the trailing spacer.
 *
 * Regression: all slack used to go to one column past its maxSize, so a
 * three-column table (Product Categories) painted a 1200px name beside
 * crammed facts.
 */
export function resolvedTableColumnWidths(
  columns: readonly TableWidthColumn[],
  availableWidth: number,
  userSized: ReadonlySet<string> = new Set(),
) {
  const widths: Record<string, number> = {};
  for (const column of columns) {
    widths[column.id] = column.getSize();
  }
  const configuredWidth = Object.values(widths).reduce(
    (total, width) => total + width,
    0,
  );
  let remaining = Math.floor(availableWidth - configuredWidth);
  let pool = columns.filter(
    (column) => isFlexibleColumn(column) && !userSized.has(column.id),
  );
  while (remaining > 0 && pool.length > 0) {
    const totalWeight = pool.reduce((total, column) => {
      return total + column.getSize();
    }, 0);
    let distributed = 0;
    const open: TableWidthColumn[] = [];
    for (const column of pool) {
      const share = Math.floor((remaining * column.getSize()) / totalWeight);
      const room =
        (column.columnDef.maxSize ?? Number.POSITIVE_INFINITY) -
        (widths[column.id] ?? 0);
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
  return { widths, spacer: Math.max(0, remaining) };
}

export function columnWidthVariables(
  columns: readonly TableWidthColumn[],
  availableWidth = 0,
  userSized?: ReadonlySet<string>,
): CSSProperties {
  const { widths, spacer } = resolvedTableColumnWidths(
    columns,
    availableWidth,
    userSized,
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

/**
 * Width for a column that declares none, from what its cells hold, so an
 * undeclared manifest column no longer inherits TanStack's blind 150px.
 */
function defaultColumnSize(meta: CubbyColumnMeta | undefined) {
  if (meta?.entityColumnRole === "identity") return 280;
  const kind = meta?.cellData?.kind;
  if (kind === "boolean") return 72;
  if (kind === "date") return 120;
  if (meta?.numeric || kind === "number" || kind === "currency") return 104;
  if (kind === "amount") return 112;
  if (kind === "select") return 136;
  if (kind?.startsWith("entity:")) return 184;
  return 176;
}

/**
 * Width the cell rail needs for this column's always-visible affordances
 * (explanation, relation workbench, suggestion mark). Added on top of the
 * value's width so a decorated column can never crush its value.
 */
export function columnRailWidth(meta: CubbyColumnMeta | undefined) {
  let slots = 0;
  if (meta?.explanation) slots += 1;
  if (
    !meta?.provenanceWorkbenchHandled &&
    isInspectableFieldProvenance(meta?.provenance)
  ) {
    slots += 1;
  }
  if (meta?.suggest) slots += 1;
  return slots * CELL_RAIL_SLOT_PX;
}

function normalizedColumnSize<TData extends RowData>(
  definition: MaterializedColumnDef<TData>,
  className: string,
) {
  const declared = definition.size ?? tailwindWidth(className, "w");
  const role = definition.meta?.entityColumnRole;
  if (role === "image") {
    const fixed = declared ?? 64;
    return { size: fixed, minSize: fixed, maxSize: fixed };
  }
  const rail = isLockedRole(role) ? 0 : columnRailWidth(definition.meta);
  const size = (declared ?? defaultColumnSize(definition.meta)) + rail;
  const minSize =
    definition.minSize ??
    tailwindWidth(className, "min-w") ??
    Math.min(size, MIN_COLUMN_WIDTH + rail);
  const maxSize =
    definition.maxSize ??
    tailwindWidth(className, "max-w") ??
    Math.max(size * 2, minSize);
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
