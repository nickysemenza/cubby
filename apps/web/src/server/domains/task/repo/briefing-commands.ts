import type { ReportCommand } from "@cubby/schemas/entity-report";
import type { TaskShortcode } from "@cubby/schemas/identifiers";
import type { TaskStatus } from "@cubby/schemas/task-fields";

/**
 * Done on a briefing row: the same status write as the task's declared
 * `complete` quick action, through `entity.mutate` (a declared user command in
 * `entity-mutation.contract.ts`). Spelled as the operation request rather than
 * through `operationCommandRequest`: importing that contract here pulls the
 * kernel bindings into the repository program. Free of database imports so
 * preview fixtures build the exact command.
 */
export const completeTaskCommand = (id: TaskShortcode): ReportCommand => ({
  id: "complete",
  label: "Done",
  prominent: true,
  confirm: null,
  request: {
    kind: "operation",
    operation: "entity.mutate",
    body: {
      action: "update",
      entity: "task",
      id,
      data: { status: "done" satisfies TaskStatus },
    },
  },
});
