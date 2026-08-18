import type { TaskOut } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import {
  axisColorChip,
  axisLabel,
  BoardCell,
  type CardRenderProps,
} from "./BoardColumn";
import { cellTasks } from "./board-model";
import type { BoardColumnKey } from "./board-types";

/**
 * The phone form of the task board.
 *
 * `TaskBoard`'s horizontally-scrolling status/project/trade columns (each a
 * fixed 16rem track) are unusable at phone width — this trades that layout for
 * status-grouped vertical sections, the same "ruled rows, not sideways cards"
 * move `CalendarAgenda` makes for the month grid. Always grouped by STATUS
 * regardless of the desktop board's `cols`/`lane` mode: on a phone there's no
 * room for a second axis, and status is the one grouping every mode still
 * makes sense to fall back to.
 *
 * Reuses `TaskCard` directly (not a parallel row renderer), so a card can
 * never drift between the desktop board and this fallback — same drag handle,
 * quick-status menu, and delete action, just laid out in one column instead of
 * several.
 */
export function BoardAgenda({
  tasks,
  cardProps,
  doneCountOverride,
  showEmptyDropTargets,
}: {
  tasks: TaskOut[];
  cardProps: CardRenderProps;
  /** See `TaskBoardProps.doneCountOverride` — the server's true Done count
   * when `tasks` only carries a capped slice of done work. */
  doneCountOverride?: number;
  /** Empty statuses become compact targets only while a task is carried. */
  showEmptyDropTargets: boolean;
}) {
  const groups = taskStatusValues.map((status) => {
    const column: BoardColumnKey = { kind: "status", status };
    const { totalCount } = cellTasks(tasks, column, null);
    const count =
      status === "done" && doneCountOverride !== undefined
        ? doneCountOverride
        : totalCount;
    return { column, count };
  });

  const visibleGroups = showEmptyDropTargets
    ? groups
    : groups.filter((group) => group.count > 0);

  if (visibleGroups.length === 0) {
    return (
      <p className="flex min-h-32 items-center justify-center border border-muted-foreground/20 border-dashed p-4 text-muted-foreground text-sm">
        No tasks to show
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {visibleGroups.map((group) => (
        <section
          key={group.column.status}
          className="border border-border bg-card"
        >
          <h3 className="sticky top-0 z-10 flex items-center gap-2 border-b-2 border-b-foreground bg-card px-2 py-1 font-mono text-2xs uppercase tracking-wider">
            {axisColorChip(group.column)}
            <span>{axisLabel(group.column)}</span>
            <span className="ml-auto text-slate tabular-nums">
              {group.count}
            </span>
          </h3>
          <BoardCell
            tasks={tasks}
            column={group.column}
            lane={null}
            cardProps={{ ...cardProps, showStatus: false }}
            doneCountOverride={doneCountOverride}
            className="border-0 bg-transparent p-2"
          />
        </section>
      ))}
    </div>
  );
}
