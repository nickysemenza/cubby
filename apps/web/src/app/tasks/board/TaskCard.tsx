import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { useDraggable } from "@dnd-kit/core";
import { DotsSixVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsThreeVertical";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";

import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import { useEntityDisplayImage } from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
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
import { householdLocalDate } from "~/lib/household-date";
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
  /** The board calculates the current card-edge insertion marker. */
  dropEdge?: "top" | "bottom" | null;
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

function blockedByLabel(task: TaskOut, taskById: Record<string, TaskOut>) {
  const names = task.blockedByIds
    .map((id) => taskById[id]?.name)
    .filter((name): name is string => name != null);
  const unresolvedCount = task.blockedByIds.length - names.length;
  if (names.length === 0) {
    const noun = task.blockedByIds.length === 1 ? "task" : "tasks";
    return `Blocked by ${task.blockedByIds.length} ${noun}`;
  }
  const unresolved = unresolvedCount > 0 ? ` and ${unresolvedCount} more` : "";
  return `Blocked by ${names.join(", ")}${unresolved}`;
}

const taskProjectRef = (task: TaskOut) => ({
  entityType: "project" as const,
  entityId: task.projectId ?? "",
});

/**
 * A task as a board card: draggable whole-card (the browser suppresses the
 * click after a native drag, so no separate handle), clickable to open the
 * detail page, with an inline status quick-action that doubles as the
 * touch/mobile fallback. The surface stays neutral and uses shared tokens.
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
  dropEdge,
}: TaskCardProps) {
  const navigate = useNavigate();
  const projectImage = useEntityDisplayImage(taskProjectRef(task));

  // The Done column ranks by recency, not manually — its cards opt out of
  // being reorder targets (drops fall through to the cell as a status change).
  const rankDisabled = column.kind === "status" && column.status === "done";
  const { setNodeRef: setDropNodeRef, isOver } = useBoardCardDropTarget({
    column,
    lane,
    taskId: task.id,
    disabled: rankDisabled,
  });
  const {
    attributes,
    listeners,
    setNodeRef: setDragNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({
    id: `task-board:drag:${task.id}`,
    data: {
      taskBoardDrag: true,
      taskId: task.id,
      status: task.status,
      projectId: task.projectId,
      trade: task.trade,
    } satisfies TaskCardDragData,
  });
  const setNodeRef = (node: HTMLDivElement | null) => {
    setDragNodeRef(node);
    setDropNodeRef(node);
  };

  const open = () =>
    navigate({
      to: entities.task.routes.detail,
      params: entityDetailParams(task.id),
    });

  // A ranged task (dueDate + dueEndDate) is overdue only once its *end* passes
  // — a dueDate in the past with a dueEndDate still ahead means it's currently
  // in-window, not late.
  const effectiveDue = effectiveTaskDueDate(task);
  const overdue =
    task.dueDate != null &&
    task.status !== "done" &&
    effectiveDue != null &&
    effectiveDue < householdLocalDate();

  // Blocker names resolve best-effort from the board's loaded dataset — a
  // blocker that's a subtask or outside the current scope stays unnamed, so
  // the badge keys off blockedByIds (never disappears) and the tooltip
  // reports the unresolved remainder.
  const blockerLabel = blockedByLabel(task, taskById);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group relative block border border-[var(--border)] bg-card p-2 text-left transition-colors duration-100 hover:border-primary/50",
        isDragging && "opacity-40",
      )}
    >
      {isOver && dropEdge && (
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 h-0.5 bg-primary",
            dropEdge === "top" ? "top-0" : "bottom-0",
          )}
          aria-hidden
        />
      )}
      <Stack gap="snug">
        <Row align="start" justify="between" gap="tight">
          <Row align="start" gap="tight" className="min-w-0">
            <Button
              ref={setActivatorNodeRef}
              variant="ghost"
              size="icon-xs"
              className="mt-1 shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
              aria-label={`Drag ${task.name}`}
              {...attributes}
              {...listeners}
            >
              <DotsSixVerticalIcon className="size-3" />
            </Button>
            <button
              type="button"
              className="line-clamp-2 min-h-11 min-w-0 text-left text-sm font-medium underline-offset-2 hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-h-0"
              title={task.name}
              onClick={open}
            >
              {task.name}
            </button>
          </Row>
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
                <DotsThreeVerticalIcon />
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
                <VerbMenuItem
                  verb="delete"
                  onSelect={(e) => {
                    e.stopPropagation();
                    onRequestDelete(task);
                  }}
                />
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
          {showProject && task.projectId && (
            <span
              className="max-w-40 min-w-0"
              title={task.projectName ?? undefined}
            >
              <EntityInlineLink
                displayImage={projectImage}
                entity="project"
                truncate
                data={{
                  id: task.projectId,
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
                      <ProhibitIcon className="size-3" />
                      {task.blockedByIds.length}
                    </Badge>
                  </span>
                }
              />
              <TooltipContent>{blockerLabel}</TooltipContent>
            </Tooltip>
          )}
        </Row>
      </Stack>
    </div>
  );
}
