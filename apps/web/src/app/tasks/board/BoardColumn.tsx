import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { TRADE_LABELS } from "@cubby/schemas/project";
import { Plus } from "lucide-react";
import { useMemo, useRef } from "react";
import { match } from "ts-pattern";
import { getTradeColor } from "~/app/projects/charts/gantt/trade-colors";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { getStatusChartColor } from "~/lib/status-colors";
import { cn } from "~/lib/utils";
import { TASK_STATUS_LABELS } from "../task-options";
import { cellTasks } from "./board-model";
import {
  type BoardColumnKey,
  type BoardLaneKey,
  isQuickAddEligible,
  type TaskCreatePreset,
  taskCreatePreset,
} from "./board-types";
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

/** Column header: accent chip + label + true count + optional quick-add. */
export function ColumnHeader({
  column,
  count,
  onQuickAdd,
  className,
}: {
  column: BoardColumnKey;
  count: number;
  /** Opens the create-task dialog preset to this column's axis. Omitted (or
   * the Done status column) renders no quick-add button. */
  onQuickAdd?: (preset: TaskCreatePreset) => void;
  className?: string;
}) {
  const showQuickAdd = onQuickAdd != null && isQuickAddEligible(column);
  return (
    <Row
      align="center"
      justify="between"
      gap="sm"
      className={cn("px-1", className)}
    >
      <Row align="center" gap="tight" className="min-w-0">
        {axisColorChip(column)}
        <span className="truncate font-medium text-sm">
          {axisLabel(column)}
        </span>
      </Row>
      <Row align="center" gap="tight" className="shrink-0">
        <span className="text-muted-foreground text-xs tabular-nums">
          {count}
        </span>
        {showQuickAdd && (
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            aria-label={`Add task to ${axisLabel(column)}`}
            onClick={() => onQuickAdd(taskCreatePreset(column, null))}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </Row>
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
  onQuickAdd,
  className,
}: {
  tasks: TaskOut[];
  column: BoardColumnKey;
  lane: BoardLaneKey | null;
  cardProps: CardRenderProps;
  /** Opens the create-task dialog preset to this cell (column, plus the
   * lane's axis when swimlanes are on). Omitted (or the Done status column)
   * renders no quick-add affordance in the empty state. */
  onQuickAdd?: (preset: TaskCreatePreset) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isOver = useBoardDropTarget({ ref, column, lane });
  const { cards, totalCount, hiddenDoneCount } = useMemo(
    () => cellTasks(tasks, column, lane),
    [tasks, column, lane],
  );
  const quickAddEligible = onQuickAdd != null && isQuickAddEligible(column);

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
        {cards.length === 0 &&
          (quickAddEligible ? (
            <button
              type="button"
              onClick={() => onQuickAdd(taskCreatePreset(column, lane))}
              className="flex min-h-16 w-full items-center justify-center border border-muted-foreground/30 border-dashed p-2 text-muted-foreground text-xs transition-colors hover:border-muted-foreground/50 hover:text-foreground"
            >
              No tasks — click to add
            </button>
          ) : (
            <p className="flex min-h-16 items-center justify-center border border-muted-foreground/20 border-dashed p-2 text-muted-foreground text-xs">
              No tasks
            </p>
          ))}
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
  onQuickAdd,
}: {
  tasks: TaskOut[];
  column: BoardColumnKey;
  cardProps: CardRenderProps;
  onQuickAdd?: (preset: TaskCreatePreset) => void;
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
    // the card stack. `align="stretch"` on the parent Row stretches this
    // column to the board's bounded height; the header stays put while the
    // cell scrolls independently underneath it.
    <div className="flex w-64 shrink-0 flex-col gap-2 overflow-hidden">
      <ColumnHeader column={column} count={count} onQuickAdd={onQuickAdd} />
      <BoardCell
        tasks={tasks}
        column={column}
        lane={null}
        cardProps={cardProps}
        onQuickAdd={onQuickAdd}
        className="flex-1 overflow-y-auto"
      />
    </div>
  );
}
