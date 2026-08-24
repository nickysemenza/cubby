import type { TaskOut } from "@cubby/schemas/project";
import { format, parseISO } from "date-fns";
import { keyBy } from "es-toolkit";
import { useState } from "react";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useTRPC } from "~/integrations/trpc/react";
import { invalidatesFor } from "~/lib/query-keys";
import type { BoardColumnKey } from "./board/board-types";
import { TaskCard } from "./board/TaskCard";
import { TaskDeleteDialog } from "./board/TaskDeleteDialog";

type TaskAgendaGroup = { day: string; tasks: TaskOut[] };

/**
 * One section per `dueDate` (the task's OWN start, never the range it
 * spans) — unlike `groupItemsByDay`'s calendar rows, a ranged task is NOT
 * repeated under every day it covers. `TaskCard` already prints the full
 * `dueDate → dueEndDate` range inline, so a multi-week task appearing once
 * under its start date loses nothing; repeating it under every day would
 * turn a 90-day maintenance task into 90 duplicate rows.
 */
export function groupTasksByDueDate(
  tasks: readonly TaskOut[],
): TaskAgendaGroup[] {
  const byDay = new Map<string, TaskOut[]>();
  for (const task of tasks) {
    if (!task.dueDate) continue;
    const group = byDay.get(task.dueDate);
    if (group) group.push(task);
    else byDay.set(task.dueDate, [task]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayTasks]) => ({
      day,
      tasks: [...dayTasks].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

/**
 * The phone form of the Timeline's Gantt: chronological ruled rows instead of
 * a horizontal bar chart, one section per due date — the same "breakpoint
 * decides, both trees render" move `TaskBoard`'s `BoardAgenda` and the
 * calendar's `CalendarAgenda` make. Reuses `TaskCard` (through the same
 * `TaskDeleteDialog` the board uses) so a row can't drift from how the board
 * renders the identical task.
 *
 * Status changes and deletes here are plain mutate-and-invalidate (no
 * optimistic cache patch) — this view has no `task.board`/`task.chartData`
 * cache to patch (see `useBoardMutations`' two supported sources), and a
 * refetch-driven update is an acceptable trade for a read-first fallback
 * view.
 */
export function TasksAgenda({ tasks }: { tasks: TaskOut[] }) {
  const api = useTRPC();
  const [pendingDelete, setPendingDelete] = useState<TaskOut | null>(null);
  const groups = groupTasksByDueDate(tasks);
  // Best-effort blocker-name resolution — only from tasks THIS agenda has
  // loaded (the dated subset), same fallback TaskCard already has for a
  // blocker outside its known set (see its `unresolvedBlockerCount`).
  const taskById = keyBy(tasks, (t) => t.id);

  const setStatus = useActionMutation({
    entity: "task",
    operation: "update",
    intent: "status",
    mutationFn: api.task.update.mutationOptions,
    invalidateKeys: invalidatesFor("task"),
  });
  const remove = useActionMutation({
    entity: "task",
    operation: "delete",
    intent: "delete",
    mutationFn: api.task.delete.mutationOptions,
    invalidateKeys: invalidatesFor("task"),
    onSuccess: () => setPendingDelete(null),
  });

  if (groups.length === 0) return null;

  return (
    <>
      <div className="border">
        {groups.map((group) => (
          <section key={group.day}>
            <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b bg-muted px-2 py-1 font-mono text-2xs uppercase tracking-wider">
              <span>{format(parseISO(group.day), "EEE MMM d")}</span>
              <span className="ml-auto text-slate tabular-nums">
                {group.tasks.length}
              </span>
            </h3>
            <div className="space-y-2 p-2">
              {group.tasks.map((task) => {
                const column: BoardColumnKey = {
                  kind: "status",
                  status: task.status,
                };
                return (
                  <TaskCard
                    key={task.id}
                    task={task}
                    column={column}
                    lane={null}
                    taskById={taskById}
                    showProject
                    showTrade
                    showStatus
                    onSetStatus={(status) =>
                      setStatus.mutate({ id: task.id, data: { status } })
                    }
                    onRequestDelete={setPendingDelete}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <TaskDeleteDialog
        task={pendingDelete}
        isDeleting={remove.isPending}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={async () => {
          if (pendingDelete)
            await remove.mutateAsync({ ids: [pendingDelete.id] });
        }}
      />
    </>
  );
}
