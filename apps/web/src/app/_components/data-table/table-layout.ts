import type {
  ColumnOrderState,
  ColumnPinningState,
  ColumnSizingState,
  ColumnVisibilityState,
  RowData,
} from "@tanstack/react-table";
import { type Atom, batch, createAtom } from "@tanstack/store";
import { type CSSProperties, useEffect, useMemo, useRef } from "react";
import type { CubbyColumnDef } from "./table-features";

const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 1200;

/** Structural columns that always lead the desktop table in this order. */
const LOCKED_START_COLUMN_IDS = ["select", "image"] as const;
const lockedStartColumnIdSet = new Set<string>(LOCKED_START_COLUMN_IDS);

export function isLockedStartColumnId(id: string) {
  return lockedStartColumnIdSet.has(id);
}

function columnIdHash(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Collision-resistant CSS custom property shared by every column surface. */
function columnWidthVariable(id: string) {
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  return `--cubby-column-${readable}-${columnIdHash(id)}`;
}

export function columnWidthValue(id: string) {
  return `var(${columnWidthVariable(id)})`;
}

export function columnWidthVariables(
  columns: readonly { id: string; getSize: () => number }[],
): CSSProperties {
  return Object.fromEntries(
    columns.map((column) => [
      columnWidthVariable(column.id),
      `${column.getSize()}px`,
    ]),
  ) as CSSProperties;
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
  defaultLayout: CubbyTableLayoutV1;
  /** Definitions normalized to v9 numeric sizing at the platform boundary. */
  columns: CubbyColumnDef<TData>[];
  reset: () => void;
  applySavedLayout: (layout: CubbySavedTableLayout) => void;
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

function readObject(key: string): Record<string, unknown> | undefined {
  try {
    const raw = window.localStorage?.getItem(key);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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
  const requestedOrder = dedupeKnown(
    candidate?.columnOrder ?? [],
    known,
  ).filter((id) => !isLockedStartColumnId(id));
  const requestedSet = new Set(requestedOrder);
  const columnOrder = [
    ...lockedStart,
    ...requestedOrder,
    ...columnIds.filter(
      (id) => !isLockedStartColumnId(id) && !requestedSet.has(id),
    ),
  ];

  const requestedStart = dedupeKnown(
    candidate?.columnPinning?.start ?? [],
    known,
  ).filter((id) => !isLockedStartColumnId(id));
  const start = [...lockedStart, ...requestedStart];
  const startSet = new Set(start);
  const end = dedupeKnown(candidate?.columnPinning?.end ?? [], known).filter(
    (id) => !isLockedStartColumnId(id) && !startSet.has(id),
  );

  const columnVisibility: ColumnVisibilityState = {};
  for (const id of columnIds) {
    const requested = candidate?.columnVisibility?.[id];
    columnVisibility[id] = isLockedStartColumnId(id)
      ? true
      : typeof requested === "boolean"
        ? requested
        : defaults.columnVisibility[id] !== false;
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
        (typeof def.header === "string" ? def.header : undefined);
      if (id) result.push(id);
    }
  };
  visit(columns);
  return [...new Set(result)];
}

function columnSizeBoundsFromDefs<TData extends RowData>(
  columns: CubbyColumnDef<TData>[],
): ColumnSizeBounds {
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
        columns: normalizeColumnDefinitions(
          definition.columns as CubbyColumnDef<TData>[],
        ),
      };
    }
    const className = definition.meta?.className ?? "";
    const size = definition.size ?? tailwindWidth(className, "w");
    const minSize =
      definition.minSize ??
      tailwindWidth(className, "min-w") ??
      (size != null ? Math.min(size, MIN_COLUMN_WIDTH) : undefined);
    const maxSize =
      definition.maxSize ??
      tailwindWidth(className, "max-w") ??
      (size != null
        ? Math.max(size * 2, minSize ?? MIN_COLUMN_WIDTH)
        : undefined);
    const id = columnIdsFromDefs([definition])[0];
    const lockedStart = id != null && isLockedStartColumnId(id);
    return {
      ...definition,
      ...(lockedStart
        ? {
            enablePinning: false,
            enableHiding: false,
            enableCellSelection: false,
          }
        : {}),
      ...(size != null ? { size } : {}),
      ...(minSize != null ? { minSize } : {}),
      ...(maxSize != null ? { maxSize } : {}),
    };
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
    typeof window === "undefined"
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
    candidate = readObject(storageKey(store.key)) as
      | Partial<CubbyTableLayoutV1>
      | undefined;
  }
  if (!candidate) {
    const legacyVisibility = store.legacyVisibilityKey
      ? readObject(legacyVisibilityStorageKey(store.legacyVisibilityKey))
      : undefined;
    const legacySizing = store.legacySizingKey
      ? readObject(legacySizingStorageKey(store.legacySizingKey))
      : undefined;
    if (legacyVisibility || legacySizing) {
      candidate = {
        columnVisibility: legacyVisibility as ColumnVisibilityState | undefined,
        columnSizing: legacySizing as ColumnSizingState | undefined,
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: signatures stand in for fresh values
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
    [store, defaults, normalizedColumns, sizeBounds],
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
