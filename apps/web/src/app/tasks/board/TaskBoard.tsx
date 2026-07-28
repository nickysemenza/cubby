import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { keyBy } from "es-toolkit";
import { Fragment, useMemo, useRef, useState } from "react";
import { useAutoScroll } from "~/app/_components/hooks/use-auto-scroll";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { Row } from "~/components/layout";
import { cn } from "~/lib/utils";
import { CreateTaskDialog } from "../create-task-dialog";
import {
  axisColorChip,
  axisKey,
  axisLabel,
  BoardCell,
  BoardColumn,
  type CardRenderProps,
  ColumnHeader,
} from "./BoardColumn";
import type { BoardColsMode, BoardLaneMode } from "./board-model";
import { buildColumns, buildLanes, cellTasks } from "./board-model";
import type { TaskCreatePreset } from "./board-types";
import { useBoardDnd } from "./use-board-dnd";
import {
  type BoardCacheTarget,
  useBoardMutations,
} from "./use-board-mutations";

/** A board column's fixed track width — keep in sync with the grid template below. */
const COLUMN_WIDTH = "16rem";
/** The swimlane label track width (grid template's first column). */
const LANE_LABEL_WIDTH = "8rem";

/**
 * Default vertical bound for the standalone `/tasks?view=board` page: nav bar
 * + page header + the view switcher and board-controls rows above it. The
 * project detail embed (a card section, less chrome above it) passes a
 * shorter fixed bound instead — see its `TaskBoard` usage.
 */
const DEFAULT_MAX_HEIGHT = "max-h-[calc(100dvh-18rem)]";

interface TaskBoardProps {
  tasks: TaskOut[];
  cols: BoardColsMode;
  /** Swimlane axis (only meaningful when `cols === "status"`); null = no lanes. */
  lane: BoardLaneMode | null;
  /**
   * Which cache the optimistic patch targets, with the EXACT input this
   * surface passed to its own `chartData`/`board` `queryOptions` call (share
   * the constant/helper) — see `BoardCacheTarget`.
   */
  cacheTarget: BoardCacheTarget;
  /** Whether cards may show the project link (off when a single project owns the board). */
  showProjectOnCards: boolean;
  /**
   * Tailwind max-height class bounding the board's vertical scroll region —
   * column headers stay pinned (`sticky top-0`) while cards scroll beneath.
   * Optional; defaults to a bound sized for the standalone board page.
   */
  maxHeightClassName?: string;
  /**
   * The server's true done-task count, for a caller whose `tasks` only
   * carries a capped slice of done work (see `TasksBoardView` / `task.board`'s
   * `doneCount`). Omitted by callers passing the complete task set (e.g. the
   * project detail embed), which keeps today's exact locally-computed count.
   */
  doneCountOverride?: number;
}

/**
 * The shared board core, used by both `/tasks?view=board` and the project
 * detail embed. Renders columns (status/project/trade) with optional project or
 * trade swimlanes; one drag fires one optimistic `task.update`.
 */
export function TaskBoard({
  tasks,
  cols,
  lane,
  cacheTarget,
  showProjectOnCards,
  maxHeightClassName = DEFAULT_MAX_HEIGHT,
  doneCountOverride,
}: TaskBoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useAutoScroll(scrollRef);

  const { moveTask, reorderTasks, deleteTask, isDeleting } =
    useBoardMutations(cacheTarget);
  useBoardDnd({ tasks, moveTask, reorderTasks });

  // One hoisted quick-add dialog (not one per column/cell) — the "+" in a
  // column header or an empty cell sets this, which mounts the dialog fresh
  // with that click's preset; closing unmounts it, so the next click always
  // gets a clean form (CreateTaskDialog's `useForm` only reads its defaults
  // once, on mount).
  const [pendingPreset, setPendingPreset] = useState<TaskCreatePreset | null>(
    null,
  );

  // Hoisted for the same reason as the quick-add dialog above, plus one of its
  // own: the optimistic delete drops the card out of `cellTasks`, so a dialog
  // owned by the card would unmount before the mutation settles.
  const [pendingDelete, setPendingDelete] = useState<TaskOut | null>(null);

  const columns = useMemo(() => buildColumns(tasks, cols), [tasks, cols]);
  const lanes = useMemo(
    () => (lane ? buildLanes(tasks, lane) : null),
    [tasks, lane],
  );
  const taskById = useMemo(() => keyBy(tasks, (t) => t.id), [tasks]);

  const cardProps: CardRenderProps = useMemo(
    () => ({
      taskById,
      // A project link is redundant when the column or lane already is the project.
      showProject:
        showProjectOnCards && cols !== "project" && lane !== "project",
      // A trade badge is redundant when the column or lane already is the trade.
      showTrade: cols !== "trade" && lane !== "trade",
      // Without status columns, the card itself must say where the work stands.
      showStatus: cols !== "status",
      onSetStatus: (taskId: TaskOut["id"], status: TaskStatus) =>
        moveTask(taskId, { status }),
      onRequestDelete: setPendingDelete,
    }),
    [taskById, showProjectOnCards, cols, lane, moveTask],
  );

  // Column header counts span every lane; project/trade columns count only
  // their visible (active) work, the Done column keeps its true total —
  // overridden by `doneCountOverride` when `tasks` only carries a capped
  // slice of done work (see `TaskBoardProps.doneCountOverride`).
  const columnCounts = useMemo(
    () =>
      columns.map((c) => {
        const { totalCount, hiddenDoneCount } = cellTasks(tasks, c, null);
        if (
          c.kind === "status" &&
          c.status === "done" &&
          doneCountOverride !== undefined
        ) {
          return doneCountOverride;
        }
        return totalCount - hiddenDoneCount;
      }),
    [columns, tasks, doneCountOverride],
  );

  // Sticky header cells: opaque paper background so cards scroll under them
  // cleanly, pinned to the top of the shared vertical scroll region below.
  const stickyHeaderClassName = "sticky top-0 z-10 bg-background";

  // Trade/project columns only exist for axis values with active work — a
  // filtered-to-nothing search (or a trade-columns board with no active
  // tasks at all) can leave zero columns, which would otherwise render a
  // blank board with no explanation.
  const board =
    columns.length === 0 ? (
      <p className="flex min-h-32 items-center justify-center border border-muted-foreground/20 border-dashed p-4 text-muted-foreground text-sm">
        No tasks to show
      </p>
    ) : lanes ? (
      <div ref={scrollRef} className="overflow-x-auto">
        <div
          className={cn(
            "grid min-w-max gap-2 overflow-y-auto",
            maxHeightClassName,
          )}
          style={{
            gridTemplateColumns: `${LANE_LABEL_WIDTH} repeat(${columns.length}, ${COLUMN_WIDTH})`,
          }}
        >
          <div className={stickyHeaderClassName} />
          {columns.map((column, i) => (
            <ColumnHeader
              key={axisKey(column)}
              column={column}
              count={columnCounts[i] ?? 0}
              onQuickAdd={setPendingPreset}
              className={stickyHeaderClassName}
            />
          ))}
          {lanes.map((laneKey) => (
            <Fragment key={axisKey(laneKey)}>
              <Row align="center" gap="tight" className="min-w-0 pt-1">
                {axisColorChip(laneKey)}
                <span className="truncate font-medium text-muted-foreground text-sm">
                  {axisLabel(laneKey)}
                </span>
              </Row>
              {columns.map((column) => (
                <BoardCell
                  key={axisKey(column)}
                  tasks={tasks}
                  column={column}
                  lane={laneKey}
                  cardProps={cardProps}
                  onQuickAdd={setPendingPreset}
                  // Each cell scrolls independently so one busy lane×column
                  // intersection doesn't stretch the whole shared grid row.
                  className="max-h-64 overflow-y-auto"
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    ) : (
      <div ref={scrollRef} className="overflow-x-auto">
        <Row
          align="stretch"
          gap="sm"
          className={cn("min-w-max overflow-y-hidden pb-2", maxHeightClassName)}
        >
          {columns.map((column) => (
            <BoardColumn
              key={axisKey(column)}
              tasks={tasks}
              column={column}
              cardProps={cardProps}
              onQuickAdd={setPendingPreset}
              doneCountOverride={doneCountOverride}
            />
          ))}
        </Row>
      </div>
    );

  return (
    <>
      {board}
      {pendingPreset && (
        <CreateTaskDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingPreset(null);
          }}
          presetStatus={pendingPreset.status}
          presetProjectId={pendingPreset.projectId}
          presetTrade={pendingPreset.trade}
        />
      )}
      {pendingDelete && (
        <BulkActionDialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
          items={[{ id: pendingDelete.id, name: pendingDelete.name }]}
          itemNoun="Task"
          action="Delete"
          variant="destructive"
          pendingLabel="Deleting..."
          description={`${
            pendingDelete.subtaskCount > 0
              ? `This also deletes ${pendingDelete.subtaskCount} subtask${pendingDelete.subtaskCount === 1 ? "" : "s"}, and removes`
              : "This also removes"
          } the task from any dependency chains. This action cannot be undone.`}
          renderItem={(item) => item.name}
          onSubmit={async () => {
            await deleteTask(pendingDelete.id);
            setPendingDelete(null);
          }}
          isPending={isDeleting}
        />
      )}
    </>
  );
}
