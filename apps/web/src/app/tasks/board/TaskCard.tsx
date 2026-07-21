import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import type { TaskOut, TaskStatus } from "@cubby/schemas/project";
import { taskStatusValues } from "@cubby/schemas/project";
import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import { Ban, EllipsisVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { todayPlain } from "~/app/projects/charts/gantt/gantt-date";
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
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { TASK_STATUS_LABELS, taskStatusBadgeVariant } from "../task-options";
import type { TaskCardDragData } from "./board-types";

interface TaskCardProps {
  task: TaskOut;
  /** Full loaded dataset keyed by id — resolves blocked-by names for the tooltip. */
  taskById: Record<string, TaskOut>;
  /** Show the project link (hidden when the project is redundant with a column/lane). */
  showProject: boolean;
  /** Show the trade badge (hidden in trade-columns mode — the column already says it). */
  showTrade: boolean;
  /** Show the status badge (project/trade-columns modes — no status column says it). */
  showStatus: boolean;
  onSetStatus: (status: TaskStatus) => void;
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
  taskById,
  showProject,
  showTrade,
  showStatus,
  onSetStatus,
}: TaskCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const navigate = useNavigate();

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

  const open = () => navigate({ to: "/tasks/$id", params: { id: task.id } });

  const overdue =
    task.dueDate != null &&
    task.status !== "done" &&
    task.dueDate < todayPlain();

  const blockedByNames = task.blockedByIds
    .map((id) => taskById[id]?.name)
    .filter((name): name is string => name != null);

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
        "group block cursor-grab border border-[var(--border)] bg-card p-2 text-left transition-colors hover:border-primary/50 active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <Stack gap="snug">
        <Row align="start" justify="between" gap="tight">
          <span className="line-clamp-2 font-medium text-sm">{task.name}</span>
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
                    aria-label="Change status"
                    onClick={(e) => e.stopPropagation()}
                  />
                }
              >
                <EllipsisVertical className="size-4" />
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
              {formatDue(task.dueDate)}
            </span>
          )}
          {showStatus && (
            <Badge variant={taskStatusBadgeVariant[task.status]}>
              {TASK_STATUS_LABELS[task.status]}
            </Badge>
          )}
          {showTrade && <TradeBadge trade={task.trade} />}
          {showProject && task.projectId && (
            // biome-ignore lint/a11y/noStaticElementInteractions: bare stopPropagation guard so a card click doesn't fire when the inner link is used
            <span onClick={(e) => e.stopPropagation()}>
              <EntityInlineLink
                entity="project"
                compact
                data={{ id: task.projectId, name: task.projectName ?? "" }}
              />
            </span>
          )}
          {blockedByNames.length > 0 && (
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
              <TooltipContent>
                Blocked by {blockedByNames.join(", ")}
              </TooltipContent>
            </Tooltip>
          )}
        </Row>
      </Stack>
    </div>
  );
}
