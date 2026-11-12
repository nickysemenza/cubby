import type { ColumnPriority } from "@cubby/schemas/entity-definitions/definition";

/**
 * A table pane narrower than this steps every kinded column to its narrow
 * width and drops low-priority columns; 912px content panes are first-class.
 */
export const NARROW_TABLE_WIDTH = 1100;

export type ColumnKind =
  | "text"
  | "progress"
  | "state"
  | "activity"
  | "date"
  | "money";

/**
 * Widths belong to the column kind, never the entity: `[full, narrow]` px;
 * `full` is the most a state or progress value claims on a narrow pane.
 * State and progress keep their content (`CONTENT_KINDS`): a narrow pane
 * starts them at the narrow width, and a measured value may still grow to
 * the full width, so a reason or a progress label never truncates while a
 * lower-priority column could leave instead.
 */
export const COLUMN_KIND_WIDTHS = {
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

/**
 * A kinded column's width on a narrow pane, and the most a measured value
 * may claim there. A full-width pane fits measured content instead.
 */
export function columnKindWidth(kind: ColumnKind) {
  const [full, small] = COLUMN_KIND_WIDTHS[kind];
  return { size: small, fitMax: CONTENT_KINDS.has(kind) ? full : small };
}

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
 * The columns a narrow pane leaves out: every optional column, then default
 * columns from the trailing end while the rest still overflow. Essential
 * columns never drop; a full-width pane drops nothing.
 */
export function priorityDroppedColumns(
  columns: readonly PriorityColumn[],
  availableWidth: number,
): ReadonlySet<string> {
  const dropped = new Set<string>();
  if (!isNarrowTable(availableWidth)) return dropped;
  for (const column of columns)
    if (!column.kept && column.priority === "optional") dropped.add(column.id);
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
