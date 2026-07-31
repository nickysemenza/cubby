import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import { Ban, EllipsisVertical, Trash } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { todayPlain } from "~/app/projects/charts/gantt/gantt-date";
import { formatDateRange } from "~/app/projects/project-formatting";
import { TradeBadge } from "~/app/projects/shared";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { entities, entityDetailParams } from "~/entities/entities";
import { effectiveTaskDueDate } from "~/lib/task-dates";
import { cn } from "~/lib/utils";
import { TASK_STATUS_LABELS, taskStatusBadgeVariant } from "../task-options";
import type {
  BoardColumnKey,
  BoardLaneKey,
  TaskCardDragData,
} from "./board-types";
import { useBoardCardDropTarget } from "./use-board-card-drop-target";

interface TaskCardProps {
  task: TaskOut;
  /** The cell this card lives in — the reorder drop target's coordinates. */
  column: BoardColumnKey;
  lane: BoardLaneKey | null;
  /** Full loaded dataset keyed by id — resolves blocked-by names for the tooltip. */
  taskById: Record<string, TaskOut>;
  /** Show the project link (hidden when the project is redundant with a column/lane). */
  showProject: boolean;
  /** Show the trade badge (hidden in trade-columns mode — the column already says it). */
  showTrade: boolean;
  /** Show the status badge (project/trade-columns modes — no status column says it). */
  showStatus: boolean;
  onSetStatus: (status: TaskStatus) => void;
  /**
   * Hands the task up to the board, which owns the confirm dialog. It can't
   * live here: the optimistic delete unmounts this card, and an open dialog
   * inside it would go with it mid-flight.
   */
  onRequestDelete: (task: TaskOut) => void;
}

/** "YYYY-MM-DD" -> "Mon d", parsed component-wise (no UTC day-shift). */
function formatDue(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  return format(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1), "MMM d");
}

/**
 * A task as a board card: draggable whole-card (the browser suppresses the
 * click after a native drag, so no separate handle), clickable to open the
 * detail page, with an inline status quick-action that doubles as the
 * touch/mobile fallback. Warm-Paper: square, matte, tokens only.
 */
export function TaskCard({
  task,
  column,
  lane,
  taskById,
  showProject,
  showTrade,
  showStatus,
  onSetStatus,
  onRequestDelete,
}: TaskCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const navigate = useNavigate();

  // The Done column ranks by recency, not manually — its cards opt out of
  // being reorder targets (drops fall through to the cell as a status change).
  const rankDisabled = column.kind === "status" && column.status === "done";
  const closestEdge = useBoardCardDropTarget({
    ref,
    column,
    lane,
    taskId: task.id,
    disabled: rankDisabled,
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return draggable({
      element,
      getInitialData: (): TaskCardDragData & Record<string, unknown> => ({
        taskBoardDrag: true,
        taskId: task.id,
        status: task.status,
        projectId: task.projectId,
        trade: task.trade,
      }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [task.id, task.status, task.projectId, task.trade]);

  const open = () =>
    navigate({
      to: entities.task.routes.detail,
      params: entityDetailParams(task.shortcode),
    });

  // A ranged task (dueDate + dueEndDate) is overdue only once its *end* passes
  // — a dueDate in the past with a dueEndDate still ahead means it's currently
  // in-window, not late.
  const effectiveDue = effectiveTaskDueDate(task);
  const overdue =
    task.dueDate != null &&
    task.status !== "done" &&
    effectiveDue != null &&
    effectiveDue < todayPlain();

  // Blocker names resolve best-effort from the board's loaded dataset — a
  // blocker that's a subtask or outside the current scope stays unnamed, so
  // the badge keys off blockedByIds (never disappears) and the tooltip
  // reports the unresolved remainder.
  const blockedByNames = task.blockedByIds
    .map((id) => taskById[id]?.name)
    .filter((name): name is string => name != null);
  const unresolvedBlockerCount =
    task.blockedByIds.length - blockedByNames.length;
  const blockedByLabel =
    blockedByNames.length === 0
      ? `Blocked by ${task.blockedByIds.length} ${task.blockedByIds.length === 1 ? "task" : "tasks"}`
      : `Blocked by ${blockedByNames.join(", ")}${unresolvedBlockerCount > 0 ? ` and ${unresolvedBlockerCount} more` : ""}`;

  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <button> can't wrap the nested project link + status menu; role="button" + onKeyDown keeps it operable.
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        "group relative block cursor-grab border border-[var(--border)] bg-card p-2 text-left transition-colors hover:border-primary/50 active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      {closestEdge && (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 h-0.5 bg-primary",
            closestEdge === "top" ? "top-0" : "bottom-0",
          )}
          aria-hidden
        />
      )}
      <Stack gap="snug">
        <Row align="start" justify="between" gap="tight">
          <span className="line-clamp-2 font-medium text-sm" title={task.name}>
            {task.name}
          </span>
          <Row align="center" gap="tight" className="shrink-0">
            {task.subtaskCount > 0 && (
              <Badge variant="outline">
                {task.doneSubtaskCount}/{task.subtaskCount}
              </Badge>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label="Task actions"
                    onClick={(e) => e.stopPropagation()}
                  />
                }
              >
                <EllipsisVertical />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Base UI requires labels inside a Group (crashes otherwise). */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Set status</DropdownMenuLabel>
                  {taskStatusValues.map((status) => (
                    <DropdownMenuItem
                      key={status}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSetStatus(status);
                      }}
                    >
                      <Badge variant={taskStatusBadgeVariant[status]}>
                        {TASK_STATUS_LABELS[status]}
                      </Badge>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
                {/* Outside the group on purpose — Delete isn't a status. */}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestDelete(task);
                  }}
                >
                  <Trash />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Row>
        </Row>

        <Row wrap align="center" gap="tight" className="text-muted-foreground">
          {task.dueDate && (
            <span
              className={cn(
                "font-mono text-2xs",
                overdue && "text-destructive",
              )}
            >
              {task.dueEndDate
                ? formatDateRange(task.dueDate, task.dueEndDate)
                : formatDue(task.dueDate)}
            </span>
          )}
          {showStatus && (
            <Badge variant={taskStatusBadgeVariant[task.status]}>
              {TASK_STATUS_LABELS[task.status]}
            </Badge>
          )}
          {showTrade && <TradeBadge trade={task.trade} />}
          {showProject && task.projectId && task.projectShortcode && (
            // biome-ignore lint/a11y/noStaticElementInteractions: bare stopPropagation guard so a card click doesn't fire when the inner link is used
            <span
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 max-w-40"
              title={task.projectName ?? undefined}
            >
              <EntityInlineLink
                entity="project"
                truncate
                data={{
                  id: task.projectId,
                  shortcode: task.projectShortcode,
                  name: task.projectName ?? "",
                }}
              />
            </span>
          )}
          {task.blockedByIds.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="cursor-help">
                    <Badge variant="outline">
                      <Ban className="size-3" />
                      {task.blockedByIds.length}
                    </Badge>
                  </span>
                }
              />
              <TooltipContent>{blockedByLabel}</TooltipContent>
            </Tooltip>
          )}
        </Row>
      </Stack>
    </div>
  );
}
