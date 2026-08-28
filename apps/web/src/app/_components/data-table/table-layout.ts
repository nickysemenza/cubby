import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ColumnVisibilityState,
  RowData,
} from "@tanstack/react-table";
import { type Atom, batch, createAtom } from "@tanstack/store";
import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import { z } from "zod";

import type { CubbyColumnDef } from "./table-features";

const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 1200;

const columnVisibilitySchema = z.record(z.string(), z.boolean());
const columnSizingSchema = z.record(z.string(), z.number());
const storedTableLayoutSchema = z.object({
  version: z.literal(1).optional(),
  columnOrder: z.array(z.string()).optional(),
  columnPinning: z
    .object({
      start: z.array(z.string()).optional(),
      end: z.array(z.string()).optional(),
    })
    .optional(),
  columnVisibility: columnVisibilitySchema.optional(),
  columnSizing: columnSizingSchema.optional(),
});

/** Structural columns that always lead the desktop table in this order. */
const LOCKED_START_COLUMN_IDS = ["select", "image"] as const;
const lockedStartColumnIdSet = new Set<string>(LOCKED_START_COLUMN_IDS);

/**
 * Structural columns that always trail the desktop table.
 *
 * The row-actions menu is the one control that must stay findable in the same
 * place on every table, so it is not the user's to move: it is force-ordered
 * last, pinned to the `end` region (which also keeps it reachable on a
 * horizontally scrolled table) and appended AFTER any column the user pinned
 * there themselves. Left as an ordinary center column it was draggable, and one
 * drag — or one stale persisted layout — stranded it mid-table for good.
 */
const LOCKED_END_COLUMN_IDS = ["actions"] as const;
const lockedEndColumnIdSet = new Set<string>(LOCKED_END_COLUMN_IDS);

function isLockedStartColumnId(id: string) {
  return lockedStartColumnIdSet.has(id);
}

function isLockedEndColumnId(id: string) {
  return lockedEndColumnIdSet.has(id);
}

/** Either end's structural columns: never dragged, hidden, or re-pinned. */
export function isLockedColumnId(id: string) {
  return isLockedStartColumnId(id) || isLockedEndColumnId(id);
}

/**
 * Re-sorts an id list so the locked-end columns trail it, preserving the order
 * of everything else. The drag handlers reject a locked column as the drag
 * subject, but a drop onto empty space past it still appends after it — this is
 * what keeps that landing spot from outranking the actions menu.
 */
export function withLockedEndLast(ids: readonly string[]) {
  const locked = ids.filter(isLockedEndColumnId);
  return locked.length === 0
    ? [...ids]
    : [...ids.filter((id) => !isLockedEndColumnId(id)), ...locked];
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
    meta?: { surplus?: boolean; numeric?: boolean };
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
    (column) => !isLockedColumnId(column.id) && !column.getIsPinned?.(),
  );
  const explicit = candidates.find((column) => column.columnDef.meta?.surplus);
  if (explicit) return explicit.id;

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
 * Resolves the widths the browser should paint without mutating the persisted
 * TanStack sizing state. The configured column sizes remain the user's
 * deliberate layout; only available pane slack flows to the record-identity
 * column for this viewport.
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

type ColumnSizeBounds = Record<string, { min: number; max: number }>;

export interface CubbyTableLayoutV1 {
  version: 1;
  columnOrder: ColumnOrderState;
  columnPinning: ColumnPinningState;
  columnVisibility: ColumnVisibilityState;
  columnSizing: ColumnSizingState;
}

/** Source-controlled saved layouts replace every persisted layout slice. */
export interface CubbySavedTableLayout {
  columnOrder: string[];
  columnPinning: ColumnPinningState;
  columnVisibility: ColumnVisibilityState;
  columnSizing: ColumnSizingState;
}

interface CubbyTableLayoutAtoms {
  columnOrder: Atom<ColumnOrderState>;
  columnPinning: Atom<ColumnPinningState>;
  columnVisibility: Atom<ColumnVisibilityState>;
  columnSizing: Atom<ColumnSizingState>;
}

export interface CubbyTableLayoutController<TData extends RowData = RowData> {
  atoms: CubbyTableLayoutAtoms;
  /**
   * The table's stable identity — the same key that names its persisted
   * layout. Doubles as the scroll-restoration id so the pane's saved offset
   * survives a navigate-away/back without a second identity scheme. Undefined
   * for in-memory tables that opt out of persistence.
   */
  key: string | undefined;
  defaultLayout: CubbyTableLayoutV1;
  /** Definitions normalized to v9 numeric sizing at the platform boundary. */
  columns: CubbyColumnDef<TData>[];
  reset: () => void;
  applySavedLayout: (layout: CubbySavedTableLayout) => void;
}

/** Whether the current layout differs from the source-controlled default. */
export function isTableLayoutCustomized(
  current: Partial<CubbyTableLayoutV1>,
  defaults: CubbyTableLayoutV1 | undefined,
): boolean {
  if (!defaults) return false;
  const normalizedDefaults = normalizeTableLayout(undefined, defaults);
  return (
    JSON.stringify(normalizeTableLayout(current, normalizedDefaults)) !==
    JSON.stringify(normalizedDefaults)
  );
}

interface TableLayoutOptions<TData extends RowData> {
  /** Undefined creates an in-memory layout for tables that opt out of persistence. */
  key?: string;
  columns: CubbyColumnDef<TData>[];
  initialColumnVisibility?: ColumnVisibilityState;
  /** Legacy suffixes without the `table-columns:` / `table-sizes:` prefix. */
  legacyVisibilityKey?: string;
  legacySizingKey?: string;
}

interface LayoutStore {
  atoms: CubbyTableLayoutAtoms;
  defaultLayout: CubbyTableLayoutV1;
  hydrated: boolean;
  suppressPersistence: boolean;
  key?: string;
  legacyVisibilityKey?: string;
  legacySizingKey?: string;
}

const stores = new Map<string, LayoutStore>();

const storageKey = (key: string) => `table-layout:v1:${key}`;
const legacyVisibilityStorageKey = (key: string) => `table-columns:${key}`;
const legacySizingStorageKey = (key: string) => `table-sizes:${key}`;

function readStoredValue<Schema extends z.ZodTypeAny>(
  key: string,
  schema: Schema,
): z.output<Schema> | undefined {
  try {
    const raw = window.localStorage?.getItem(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readStoredLayout(
  key: string,
): Partial<CubbyTableLayoutV1> | undefined {
  const stored = readStoredValue(key, storedTableLayoutSchema);
  if (!stored) return undefined;
  return {
    version: stored.version,
    columnOrder: stored.columnOrder,
    columnPinning: stored.columnPinning
      ? {
          start: stored.columnPinning.start ?? [],
          end: stored.columnPinning.end ?? [],
        }
      : undefined,
    columnVisibility: stored.columnVisibility,
    columnSizing: stored.columnSizing,
  };
}

function dedupeKnown(ids: readonly string[], known: ReadonlySet<string>) {
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function normalizeTableLayout(
  candidate: Partial<CubbyTableLayoutV1> | undefined,
  defaults: CubbyTableLayoutV1,
  sizeBounds: ColumnSizeBounds = {},
): CubbyTableLayoutV1 {
  const columnIds = defaults.columnOrder;
  const known = new Set(columnIds);
  const lockedStart = LOCKED_START_COLUMN_IDS.filter((id) => known.has(id));
  const lockedEnd = LOCKED_END_COLUMN_IDS.filter((id) => known.has(id));
  const requestedOrder = dedupeKnown(
    candidate?.columnOrder ?? [],
    known,
  ).filter((id) => !isLockedColumnId(id));
  const requestedSet = new Set(requestedOrder);
  const columnOrder = [
    ...lockedStart,
    ...requestedOrder,
    ...columnIds.filter((id) => !isLockedColumnId(id) && !requestedSet.has(id)),
    ...lockedEnd,
  ];

  const requestedStart = dedupeKnown(
    candidate?.columnPinning?.start ?? [],
    known,
  ).filter((id) => !isLockedColumnId(id));
  const start = [...lockedStart, ...requestedStart];
  const startSet = new Set(start);
  const end = [
    ...dedupeKnown(candidate?.columnPinning?.end ?? [], known).filter(
      (id) => !isLockedColumnId(id) && !startSet.has(id),
    ),
    // Appended last so a user-pinned end column can never outrank it.
    ...lockedEnd,
  ];

  const columnVisibility: ColumnVisibilityState = {};
  for (const id of columnIds) {
    const requested = candidate?.columnVisibility?.[id];
    columnVisibility[id] = isLockedColumnId(id)
      ? true
      : (requested ?? defaults.columnVisibility[id] !== false);
  }

  const columnSizing: ColumnSizingState = {};
  for (const [id, width] of Object.entries(candidate?.columnSizing ?? {})) {
    if (!known.has(id) || !Number.isFinite(width)) continue;
    const bounds = sizeBounds[id];
    columnSizing[id] = Math.min(
      bounds?.max ?? MAX_COLUMN_WIDTH,
      Math.max(bounds?.min ?? MIN_COLUMN_WIDTH, Math.round(width)),
    );
  }

  return {
    version: 1,
    columnOrder,
    columnPinning: { start, end },
    columnVisibility,
    columnSizing,
  };
}

function columnIdsFromDefs<TData extends RowData>(
  columns: CubbyColumnDef<TData>[],
): string[] {
  const result: string[] = [];
  const visit = (defs: CubbyColumnDef<TData>[]) => {
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
      if (id) result.push(id);
    }
  };
  visit(columns);
  return [...new Set(result)];
}

function columnSizeBoundsFromDefs<TData extends RowData>(
  columns: CubbyColumnDef<TData>[],
) {
  const result: ColumnSizeBounds = {};
  const visit = (defs: CubbyColumnDef<TData>[]) => {
    for (const def of defs) {
      if ("columns" in def && Array.isArray(def.columns)) {
        visit(def.columns);
        continue;
      }
      const id = columnIdsFromDefs([def])[0];
      if (!id) continue;
      const min = def.minSize ?? MIN_COLUMN_WIDTH;
      result[id] = {
        min,
        max: Math.max(min, def.maxSize ?? MAX_COLUMN_WIDTH),
      };
    }
  };
  visit(columns);
  return result;
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
 * Imports the old Tailwind width vocabulary once at the deep-module boundary.
 * v9 numeric sizes then own rendering, sticky offsets, resizing, and storage.
 */
function normalizeColumnDefinitions<TData extends RowData>(
  columns: CubbyColumnDef<TData>[],
): CubbyColumnDef<TData>[] {
  return columns.map((definition) => {
    if ("columns" in definition && Array.isArray(definition.columns)) {
      return {
        ...definition,
        columns: normalizeColumnDefinitions(definition.columns),
      };
    }
    const className = definition.meta?.className ?? "";
    const id = columnIdsFromDefs([definition])[0];
    const size = definition.size ?? tailwindWidth(className, "w");
    // Image is a structural identity strip, not a data column. Keep it exactly
    // as wide as its declared thumbnail cell so a stale persisted resize cannot
    // leave an empty gutter between the dedicated image and the record name.
    const fixedImageSize = id === "image" ? (size ?? 64) : undefined;
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
    const locked = id != null && isLockedColumnId(id);
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

function snapshot(store: LayoutStore): CubbyTableLayoutV1 {
  return {
    version: 1,
    columnOrder: store.atoms.columnOrder.get(),
    columnPinning: store.atoms.columnPinning.get(),
    columnVisibility: store.atoms.columnVisibility.get(),
    columnSizing: store.atoms.columnSizing.get(),
  };
}

function replaceLayout(store: LayoutStore, layout: CubbyTableLayoutV1) {
  store.suppressPersistence = true;
  batch(() => {
    store.atoms.columnOrder.set(layout.columnOrder);
    store.atoms.columnPinning.set(layout.columnPinning);
    store.atoms.columnVisibility.set(layout.columnVisibility);
    store.atoms.columnSizing.set(layout.columnSizing);
  });
  store.suppressPersistence = false;
  persist(store);
}

function persist(store: LayoutStore) {
  if (
    !store.key ||
    !store.hydrated ||
    store.suppressPersistence ||
    !globalThis.window
  ) {
    return;
  }
  try {
    window.localStorage?.setItem(
      storageKey(store.key),
      JSON.stringify(snapshot(store)),
    );
  } catch {
    // Storage can be disabled or unavailable (private mode/test runtimes).
    // The external atoms remain the source of truth for this session.
  }
}

function createLayoutStore(
  key: string | undefined,
  defaults: CubbyTableLayoutV1,
  legacyVisibilityKey?: string,
  legacySizingKey?: string,
): LayoutStore {
  const store: LayoutStore = {
    atoms: {
      columnOrder: createAtom(defaults.columnOrder),
      columnPinning: createAtom(defaults.columnPinning),
      columnVisibility: createAtom(defaults.columnVisibility),
      columnSizing: createAtom(defaults.columnSizing),
    },
    defaultLayout: defaults,
    hydrated: false,
    suppressPersistence: false,
    key,
    legacyVisibilityKey,
    legacySizingKey,
  };
  for (const atom of Object.values(store.atoms)) {
    atom.subscribe(() => persist(store));
  }
  return store;
}

function hydrate(store: LayoutStore) {
  if (store.hydrated) return;
  let candidate: Partial<CubbyTableLayoutV1> | undefined;
  if (store.key) {
    candidate = readStoredLayout(storageKey(store.key));
  }
  if (!candidate) {
    const legacyVisibility = store.legacyVisibilityKey
      ? readStoredValue(
          legacyVisibilityStorageKey(store.legacyVisibilityKey),
          columnVisibilitySchema,
        )
      : undefined;
    const legacySizing = store.legacySizingKey
      ? readStoredValue(
          legacySizingStorageKey(store.legacySizingKey),
          columnSizingSchema,
        )
      : undefined;
    if (legacyVisibility || legacySizing) {
      candidate = {
        columnVisibility: legacyVisibility,
        columnSizing: legacySizing,
      };
    }
  }
  store.hydrated = true;
  replaceLayout(store, normalizeTableLayout(candidate, store.defaultLayout));
}

/**
 * The single layout interface used by every Cubby table. Persistence,
 * normalization, legacy import, and atom ownership stay behind this seam.
 */
export function useCubbyTableLayout<TData extends RowData>({
  key,
  columns,
  initialColumnVisibility = {},
  legacyVisibilityKey = key,
  legacySizingKey = key,
}: TableLayoutOptions<TData>): CubbyTableLayoutController<TData> {
  const normalizedColumns = useMemo(
    () => normalizeColumnDefinitions(columns),
    [columns],
  );
  const columnIds = useMemo(
    () => columnIdsFromDefs(normalizedColumns),
    [normalizedColumns],
  );
  const sizeBounds = useMemo(
    () => columnSizeBoundsFromDefs(normalizedColumns),
    [normalizedColumns],
  );
  const definitionKey = columnIds.join("\u001f");
  const sizeBoundsKey = JSON.stringify(sizeBounds);
  const visibilityKey = JSON.stringify(initialColumnVisibility);
  // Fresh column-def arrays are common; their stable signatures are the
  // intended inputs, not their referential identities.
  const defaults = useMemo<CubbyTableLayoutV1>(
    () =>
      normalizeTableLayout(
        undefined,
        {
          version: 1,
          columnOrder: columnIds,
          columnPinning: { start: [], end: [] },
          columnVisibility: initialColumnVisibility,
          columnSizing: {},
        },
        sizeBounds,
      ),
    // oxlint-disable-next-line react/exhaustive-deps -- signatures stand in for fresh values
    [definitionKey, visibilityKey, sizeBoundsKey],
  );

  const store = useMemo(() => {
    if (!key) {
      return createLayoutStore(undefined, defaults);
    }
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createLayoutStore(
      key,
      defaults,
      legacyVisibilityKey,
      legacySizingKey,
    );
    stores.set(key, created);
    return created;
  }, [key, defaults, legacyVisibilityKey, legacySizingKey]);

  useEffect(() => {
    store.defaultLayout = defaults;
    store.legacyVisibilityKey = legacyVisibilityKey;
    store.legacySizingKey = legacySizingKey;
    hydrate(store);
    const normalized = normalizeTableLayout(
      snapshot(store),
      defaults,
      sizeBounds,
    );
    const current = snapshot(store);
    if (JSON.stringify(current) !== JSON.stringify(normalized)) {
      replaceLayout(store, normalized);
    }
  }, [store, defaults, legacyVisibilityKey, legacySizingKey, sizeBounds]);

  return useMemo(
    () => ({
      atoms: store.atoms,
      key,
      defaultLayout: defaults,
      columns: normalizedColumns,
      reset: () => replaceLayout(store, defaults),
      applySavedLayout: (layout: CubbySavedTableLayout) =>
        replaceLayout(
          store,
          normalizeTableLayout(
            {
              version: 1,
              columnOrder: layout.columnOrder ?? defaults.columnOrder,
              columnPinning: {
                start: layout.columnPinning?.start ?? [],
                end: layout.columnPinning?.end ?? [],
              },
              columnVisibility: {
                ...defaults.columnVisibility,
                ...layout.columnVisibility,
              },
              columnSizing: layout.columnSizing ?? {},
            },
            defaults,
            sizeBounds,
          ),
        ),
    }),
    [store, key, defaults, normalizedColumns, sizeBounds],
  );
}

/**
 * Reveals contextual columns once when a table enters a new worklist. The
 * reveal runs after persisted layout hydration, so a previously hidden column
 * is visible on arrival; subsequent user toggles remain authoritative until a
 * different context is activated.
 */
export function useRevealTableColumnsOnce<TData extends RowData>(
  layout: CubbyTableLayoutController<TData>,
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
    const current = layout.atoms.columnVisibility.get();
    layout.atoms.columnVisibility.set({ ...current, ...reveal.visibility });
  }, [layout, reveal]);
}

/** Test-only reset for the module-global client store. */
export function clearTableLayoutStoresForTests() {
  stores.clear();
}
