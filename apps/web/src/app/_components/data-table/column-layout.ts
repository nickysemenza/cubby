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

import {
  materializeCubbyColumns,
  type CubbyColumnCollection,
  type CubbyColumnDef,
} from "./table-features";
import type { EntityColumnRole } from "./table-meta";

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

/** Either end's structural columns: never dragged, hidden, or re-pinned. */
export function isLockedColumn(column: RoleBearingColumn) {
  const role = column.columnDef.meta?.entityColumnRole;
  return (
    role != null &&
    (LOCKED_START_COLUMN_ROLES.includes(role) ||
      LOCKED_END_COLUMN_ROLES.includes(role))
  );
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
    meta?: {
      entityColumnRole?: EntityColumnRole;
      surplus?: boolean;
      numeric?: boolean;
    };
  };
};

/**
 * Pick one readable, unpinned column to absorb desktop table surplus.
 *
 * Fixed table layout otherwise shares extra space across every sized column,
 * which makes quantities and timestamps balloon while record names still
 * truncate. Factories can nominate identity explicitly; the fallback makes
 * hand-authored entity tables safe without another per-route width roster.
 */
export function tableSurplusColumnId(
  columns: readonly TableWidthColumn[],
): string | undefined {
  const candidates = columns.filter(
    (column) => !isLockedColumn(column) && !column.getIsPinned?.(),
  );
  const explicit = candidates.find((column) => column.columnDef.meta?.surplus);
  if (explicit) return explicit.id;

  const identity = candidates.find(
    (column) => column.columnDef.meta?.entityColumnRole === "identity",
  );
  if (identity) return identity.id;

  const conventional = candidates.find((column) =>
    ["name", "title", "product", "filename"].includes(column.id),
  );
  if (conventional) return conventional.id;

  return candidates.find(
    (column) =>
      !column.columnDef.meta?.numeric &&
      isNonEmptyColumnHeader(column.columnDef.header),
  )?.id;
}

/**
 * Resolves the widths the browser should paint without mutating TanStack's own
 * column-sizing state. A user's deliberate resize remains the source of truth;
 * only available pane slack flows to the record-identity column for this
 * viewport.
 */
export function resolvedTableColumnWidths(
  columns: readonly TableWidthColumn[],
  availableWidth: number,
) {
  const widths: Record<string, number> = {};
  for (const column of columns) {
    widths[column.id] = column.getSize();
  }
  const surplusId = tableSurplusColumnId(columns);
  if (!surplusId || availableWidth <= 0) return widths;

  const configuredWidth = Object.values(widths).reduce(
    (total, width) => total + width,
    0,
  );
  if (availableWidth <= configuredWidth) return widths;

  widths[surplusId] =
    (widths[surplusId] ?? 0) + availableWidth - configuredWidth;
  return widths;
}

export function columnWidthVariables(
  columns: readonly TableWidthColumn[],
  availableWidth = 0,
): CSSProperties {
  const widths = resolvedTableColumnWidths(columns, availableWidth);
  const variables: CSSProperties &
    Partial<Record<ColumnWidthVariable, string>> = {};
  for (const column of columns) {
    variables[columnWidthVariable(column.id)] =
      `${widths[column.id] ?? column.getSize()}px`;
  }
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

function normalizedColumnSize<TData extends RowData>(
  definition: MaterializedColumnDef<TData>,
  className: string,
) {
  const size = definition.size ?? tailwindWidth(className, "w");
  const fixedImageSize =
    definition.meta?.entityColumnRole === "image" ? (size ?? 64) : undefined;
  const normalizedSize = fixedImageSize ?? size;
  const minSize =
    fixedImageSize ??
    definition.minSize ??
    tailwindWidth(className, "min-w") ??
    (normalizedSize != null
      ? Math.min(normalizedSize, MIN_COLUMN_WIDTH)
      : undefined);
  const maxSize =
    fixedImageSize ??
    definition.maxSize ??
    tailwindWidth(className, "max-w") ??
    (normalizedSize != null
      ? Math.max(normalizedSize * 2, minSize ?? MIN_COLUMN_WIDTH)
      : undefined);
  return { size: normalizedSize, minSize, maxSize };
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
    // Image is a structural identity strip, not a data column. Keep it exactly
    // as wide as its declared thumbnail cell so a stray resize cannot leave an
    // empty gutter between the dedicated image and the record name.
    const {
      size: normalizedSize,
      minSize,
      maxSize,
    } = normalizedColumnSize(definition, className);
    const fixedImageSize =
      definition.meta?.entityColumnRole === "image"
        ? normalizedSize
        : undefined;
    const role = definition.meta?.entityColumnRole;
    const locked =
      role != null &&
      (LOCKED_START_COLUMN_ROLES.includes(role) ||
        LOCKED_END_COLUMN_ROLES.includes(role));
    const normalized = {
      ...definition,
    };
    if (locked) {
      Object.assign(normalized, {
        enablePinning: false,
        enableHiding: false,
        enableCellSelection: false,
      });
    }
    if (fixedImageSize != null) {
      Object.assign(normalized, { enableResizing: false });
    }
    if (normalizedSize != null) {
      Object.assign(normalized, { size: normalizedSize });
    }
    if (minSize != null) {
      Object.assign(normalized, { minSize });
    }
    if (maxSize != null) {
      Object.assign(normalized, { maxSize });
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
