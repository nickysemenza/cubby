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
 * State and progress keep their content (`CONTENT_KINDS`): they start at
 * their kind's width and a measured value may grow to the rendered-fit cap,
 * so a reason or a progress label does not truncate while a lower-priority
 * column could leave instead.
 */
const COLUMN_KIND_WIDTHS = {
  text: [220, 104],
  progress: [240, 140],
  state: [240, 136],
  activity: [72, 64],
  date: [88, 64],
  money: [88, 72],
} as const satisfies Record<ColumnKind, readonly [number, number]>;

const CONTENT_KINDS: ReadonlySet<ColumnKind> = new Set(["progress", "state"]);

type KindedMeta = {
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
  return {
    size: narrow ? small : full,
    // Narrow text truncates at its narrow width; a longer date, amount or
    // age may still reach the full width rather than clip.
    fitMax: CONTENT_KINDS.has(kind)
      ? CONTENT_FIT_MAX
      : narrow && kind === "text"
        ? small
        : full,
  };
}

/**
 * Whether a column takes its kind's width at this pane width: state and
 * progress always do; other kinds only on a narrow pane, so a full-width
 * pane fits their measured content as before.
 */
export const columnUsesKindWidth = (kind: ColumnKind, narrow: boolean) =>
  narrow || CONTENT_KINDS.has(kind);

/** The most a state reason or progress label claims before it truncates. */
const CONTENT_FIT_MAX = 320;

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
