import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { useMemo, useRef } from "react";
import { match } from "ts-pattern";
import { getTradeColor } from "~/app/projects/charts/gantt/trade-colors";
import { Row, Stack } from "~/components/layout";
import { getStatusChartColor } from "~/lib/status-colors";
import { cn } from "~/lib/utils";
import { TASK_STATUS_LABELS } from "../task-options";
import { cellTasks } from "./board-model";
import type { BoardColumnKey, BoardLaneKey } from "./board-types";
import { TaskCard } from "./TaskCard";
import { useBoardDropTarget } from "./use-board-drop-target";

/** Shared per-card props threaded from the board down through columns to cells. */
export interface CardRenderProps {
  taskById: Record<string, TaskOut>;
  showProject: boolean;
  showTrade: boolean;
  showStatus: boolean;
  onSetStatus: (taskId: TaskOut["id"], status: TaskStatus) => void;
}

/** Stable React key for a column/lane key. */
export function axisKey(key: BoardColumnKey | BoardLaneKey): string {
  return match(key)
    .with({ kind: "status" }, (k) => `status:${k.status}`)
    .with({ kind: "project" }, (k) => `project:${k.projectId ?? "inbox"}`)
    .with({ kind: "trade" }, (k) => `trade:${k.trade}`)
    .exhaustive();
}

/** Human label for a column/lane key. */
export function axisLabel(key: BoardColumnKey | BoardLaneKey): string {
  return match(key)
    .with({ kind: "status" }, (k) => TASK_STATUS_LABELS[k.status])
    .with({ kind: "project" }, (k) => k.projectName)
    .with({ kind: "trade" }, (k) => TRADE_LABELS[k.trade])
    .exhaustive();
}

/** Column/lane accent color (status + trade tokens); null for project. */
function axisColor(key: BoardColumnKey | BoardLaneKey): string | null {
  return match(key)
    .with({ kind: "status" }, (k) => getStatusChartColor(k.status))
    .with({ kind: "trade" }, (k) => getTradeColor(k.trade))
    .with({ kind: "project" }, () => null)
    .exhaustive();
}

/** The small square accent chip for a column/lane, or null (project has none). */
export function axisColorChip(key: BoardColumnKey | BoardLaneKey) {
  const color = axisColor(key);
  return color ? (
    <span
      className="size-2 shrink-0"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  ) : null;
}

/** Column header: accent chip + label + true count. */
export function ColumnHeader({
  column,
  count,
}: {
  column: BoardColumnKey;
  count: number;
}) {
  return (
    <Row align="center" justify="between" gap="sm" className="px-1">
      <Row align="center" gap="tight" className="min-w-0">
        {axisColorChip(column)}
        <span className="truncate font-medium text-sm">
          {axisLabel(column)}
        </span>
      </Row>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {count}
      </span>
    </Row>
  );
}

/**
 * One drop-target cell: the cards for `column` × `lane`, derived-sorted, with a
 * min-height so an empty cell is still a target. The Done column caps its body
 * and shows a "showing N of M" footer.
 */
export function BoardCell({
  tasks,
  column,
  lane,
  cardProps,
  className,
}: {
  tasks: TaskOut[];
  column: BoardColumnKey;
  lane: BoardLaneKey | null;
  cardProps: CardRenderProps;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isOver = useBoardDropTarget({ ref, column, lane });
  const { cards, totalCount, hiddenDoneCount } = useMemo(
    () => cellTasks(tasks, column, lane),
    [tasks, column, lane],
  );

  return (
    <div
      ref={ref}
      className={cn(
        "min-h-16 bg-muted/30 p-1 transition-shadow",
        isOver && "ring-2 ring-primary ring-inset",
        className,
      )}
    >
      <Stack gap="snug">
        {cards.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            taskById={cardProps.taskById}
            showProject={cardProps.showProject}
            showTrade={cardProps.showTrade}
            showStatus={cardProps.showStatus}
            onSetStatus={(status) => cardProps.onSetStatus(task.id, status)}
          />
        ))}
        {hiddenDoneCount > 0 && (
          <p className="px-1 text-2xs text-muted-foreground">
            + {hiddenDoneCount} done
          </p>
        )}
        {totalCount - hiddenDoneCount > cards.length && (
          <p className="px-1 text-2xs text-muted-foreground">
            Showing {cards.length} of {totalCount}
          </p>
        )}
      </Stack>
    </div>
  );
}

/** A full column (header + single cell) — the no-swimlanes layout. */
export function BoardColumn({
  tasks,
  column,
  cardProps,
}: {
  tasks: TaskOut[];
  column: BoardColumnKey;
  cardProps: CardRenderProps;
}) {
  const count = useMemo(() => {
    // Header count = what the column represents: full history for the Done
    // column, active (visible) work for project/trade columns.
    const { totalCount, hiddenDoneCount } = cellTasks(tasks, column, null);
    return totalCount - hiddenDoneCount;
  }, [tasks, column]);
  return (
    // Raw flex-col (not Stack): the cell must flex-1 so the whole column
    // height — tallest column sets it — stays a valid drop target, not just
    // the card stack.
    <div className="flex w-72 shrink-0 flex-col gap-2">
      <ColumnHeader column={column} count={count} />
      <BoardCell
        tasks={tasks}
        column={column}
        lane={null}
        cardProps={cardProps}
        className="flex-1"
      />
    </div>
  );
}
