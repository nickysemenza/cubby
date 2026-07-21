import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { keyBy } from "es-toolkit";
import { Fragment, useMemo, useRef } from "react";
import { useAutoScroll } from "~/app/_components/hooks/use-auto-scroll";
import { Row } from "~/components/layout";
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
import { useBoardDnd } from "./use-board-dnd";
import {
  type BoardTaskFilters,
  useBoardMutations,
} from "./use-board-mutations";

/** A board column's fixed track width — keep in sync with the grid template below. */
const COLUMN_WIDTH = "18rem";

interface TaskBoardProps {
  tasks: TaskOut[];
  cols: BoardColsMode;
  /** Swimlane axis (only meaningful when `cols === "status"`); null = no lanes. */
  lane: BoardLaneMode | null;
  /**
   * The EXACT filters this surface passed to `chartData.queryOptions` — the
   * optimistic patch targets this same query key (share the constant/helper).
   */
  filters: BoardTaskFilters;
  /** Whether cards may show the project link (off when a single project owns the board). */
  showProjectOnCards: boolean;
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
  filters,
  showProjectOnCards,
}: TaskBoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useAutoScroll(scrollRef);

  const { moveTask } = useBoardMutations(filters);
  useBoardDnd({ moveTask });

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
    }),
    [taskById, showProjectOnCards, cols, lane, moveTask],
  );

  // Column header counts span every lane; project/trade columns count only
  // their visible (active) work, the Done column keeps its true total.
  const columnCounts = useMemo(
    () =>
      columns.map((c) => {
        const { totalCount, hiddenDoneCount } = cellTasks(tasks, c, null);
        return totalCount - hiddenDoneCount;
      }),
    [columns, tasks],
  );

  if (lanes) {
    return (
      <div ref={scrollRef} className="overflow-x-auto">
        <div
          className="grid min-w-max gap-2"
          style={{
            gridTemplateColumns: `10rem repeat(${columns.length}, ${COLUMN_WIDTH})`,
          }}
        >
          <div />
          {columns.map((column, i) => (
            <ColumnHeader
              key={axisKey(column)}
              column={column}
              count={columnCounts[i] ?? 0}
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
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="overflow-x-auto">
      <Row align="stretch" gap="sm" className="min-w-max pb-2">
        {columns.map((column) => (
          <BoardColumn
            key={axisKey(column)}
            tasks={tasks}
            column={column}
            cardProps={cardProps}
          />
        ))}
      </Row>
    </div>
  );
}
