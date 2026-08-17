import type { TaskOut } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { Stack } from "~/components/layout";
import { axisColorChip, axisLabel, type CardRenderProps } from "./BoardColumn";
import { cellTasks } from "./board-model";
import type { BoardColumnKey } from "./board-types";
import { TaskCard } from "./TaskCard";

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
}: {
  tasks: TaskOut[];
  cardProps: CardRenderProps;
  /** See `TaskBoardProps.doneCountOverride` — the server's true Done count
   * when `tasks` only carries a capped slice of done work. */
  doneCountOverride?: number;
}) {
  const groups = taskStatusValues
    .map((status) => {
      const column: BoardColumnKey = { kind: "status", status };
      const { cards, totalCount } = cellTasks(tasks, column, null);
      const count =
        status === "done" && doneCountOverride !== undefined
          ? doneCountOverride
          : totalCount;
      return { column, cards, count };
    })
    // Empty statuses collapse away, mirroring CalendarAgenda's empty-day fold —
    // a phone screen has no room for five headers, four of them "No tasks".
    .filter((group) => group.count > 0);

  if (groups.length === 0) {
    return (
      <p className="flex min-h-16 items-center justify-center border border-muted-foreground/20 border-dashed p-4 text-muted-foreground text-sm">
        No tasks to show
      </p>
    );
  }

  return (
    <div className="border">
      {groups.map((group) => (
        <section key={group.column.status}>
          <h3 className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted px-2 py-1 font-mono text-2xs uppercase tracking-wider">
            {axisColorChip(group.column)}
            <span>{axisLabel(group.column)}</span>
            <span className="ml-auto text-slate tabular-nums">
              {group.count}
            </span>
          </h3>
          <Stack gap="snug" className="p-2">
            {group.cards.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                column={group.column}
                lane={null}
                taskById={cardProps.taskById}
                showProject={cardProps.showProject}
                showTrade={cardProps.showTrade}
                // The section header already names the status.
                showStatus={false}
                onSetStatus={(status) => cardProps.onSetStatus(task.id, status)}
                onRequestDelete={cardProps.onRequestDelete}
              />
            ))}
            {group.column.status === "done" &&
              group.count > group.cards.length && (
                <p className="px-1 text-2xs text-muted-foreground">
                  Showing {group.cards.length} of {group.count}.
                </p>
              )}
          </Stack>
        </section>
      ))}
    </div>
  );
}
