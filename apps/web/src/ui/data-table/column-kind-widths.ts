import type { ColumnPriority } from "@cubby/schemas/entity-definitions/definition";

/**
 * A table pane narrower than this steps every kinded column to its narrow
 * width and drops low-priority columns; 912px content panes are first-class.
 */
const NARROW_TABLE_WIDTH = 1100;

export type ColumnKind =
  | "text"
  | "progress"
  | "state"
  | "activity"
  | "date"
  | "money";

/**
 * Widths belong to the column kind, never the entity: `[full, narrow]` px.
 * State and progress (`CONTENT_KINDS`) always take their kind's width and fit
 * their content up to it; a longer reason or progress note ends in an
 * ellipsis. Dates, ages and money fit their content (`NATURAL_KINDS`): the
 * kind width is where they start, never a cap. The record identity takes
 * whatever the pane leaves (`column-layout.ts`).
 */
const COLUMN_KIND_WIDTHS = {
  text: [220, 104],
  progress: [200, 160],
  state: [200, 188],
  activity: [56, 48],
  date: [88, 64],
  money: [88, 72],
} as const satisfies Record<ColumnKind, readonly [number, number]>;

const CONTENT_KINDS: ReadonlySet<ColumnKind> = new Set(["progress", "state"]);
const NATURAL_KINDS: ReadonlySet<ColumnKind> = new Set([
  "activity",
  "date",
  "money",
]);

type KindedMeta = {
  entityColumnRole?: string;
  widthKind?: ColumnKind;
  prose?: boolean;
  code?: boolean;
  linksTo?: string;
  cellData?: { kind: string };
};

/**
 * A column's kind from its shared renderer and cell kind. The identity keeps
 * its own fit and pane slack (`column-layout.ts`).
 */
export function columnKindOf(meta: KindedMeta | undefined): ColumnKind | null {
  // A narrow text cap held a 120px title at 104px on a 912px pane.
  if (meta?.entityColumnRole === "identity") return null;
  if (meta?.widthKind) return meta.widthKind;
  const kind = meta?.cellData?.kind;
  if (kind === "timestamp") return "activity";
  if (kind === "date") return "date";
  if (kind === "currency" || kind === "amount") return "money";
  if (kind === "text" && !meta?.prose && !meta?.code && !meta?.linksTo)
    return "text";
  return null;
}

/** A kinded column's starting width, and the most a measured value may claim. */
export function columnKindWidth(kind: ColumnKind, narrow: boolean) {
  const [full, small] = COLUMN_KIND_WIDTHS[kind];
  const size = narrow ? small : full;
  return {
    size,
    // A date or amount clipped to "1w agc" says less than a wider column.
    fitMax: NATURAL_KINDS.has(kind) ? Number.POSITIVE_INFINITY : size,
  };
}

/**
 * Whether a column takes its kind's width at this pane width: state and
 * progress always do; other kinds only on a narrow pane, so a full-width
 * pane fits their measured content as before.
 */
export const columnUsesKindWidth = (kind: ColumnKind, narrow: boolean) =>
  narrow || CONTENT_KINDS.has(kind);

/** Whether a pane is narrow; an unmeasured pane (0) draws full widths. */
export const isNarrowTable = (availableWidth: number) =>
  availableWidth > 0 && availableWidth < NARROW_TABLE_WIDTH;

type PriorityColumn = {
  id: string;
  width: number;
  priority: ColumnPriority;
  /** A locked, identity or member-revealed column never drops. */
  kept: boolean;
};

/**
 * The columns a pane leaves out instead of truncating every column: on a
 * narrow pane every optional column, then at any width default columns from
 * the trailing end while the rest still overflow. Essential columns never
 * drop; an unmeasured pane drops nothing.
 */
export function priorityDroppedColumns(
  columns: readonly PriorityColumn[],
  availableWidth: number,
): ReadonlySet<string> {
  const dropped = new Set<string>();
  if (availableWidth <= 0) return dropped;
  if (isNarrowTable(availableWidth))
    for (const column of columns)
      if (!column.kept && column.priority === "optional")
        dropped.add(column.id);
  let total = columns
    .filter((column) => !dropped.has(column.id))
    .reduce((sum, column) => sum + column.width, 0);
  for (const column of [...columns].reverse()) {
    if (total <= availableWidth) break;
    if (column.kept || column.priority !== "default" || dropped.has(column.id))
      continue;
    dropped.add(column.id);
    total -= column.width;
  }
  return dropped;
}
