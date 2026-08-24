import type { TaskOut } from "@cubby/schemas/project";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";

/**
 * The single-task confirm-delete flow shared by every `TaskCard` host — the
 * board and its mobile/timeline fallbacks (`BoardAgenda`, the Timeline
 * agenda) all wire `TaskCard.onRequestDelete` to the same instance rather
 * than each hand-rolling the confirm dialog again.
 *
 * `task` is the pending delete (null renders nothing); the caller owns that
 * state because an optimistic delete unmounts the row that opened this
 * dialog, so the dialog can't own its own trigger.
 *
 * No impact preview: deletes are "attempt the mutation and read its
 * structured refusal" — the static description below covers the cascade, and
 * `onConfirm`'s rejection (surfaced by the caller) covers a refusal.
 */
export function TaskDeleteDialog({
  task,
  isDeleting,
  onOpenChange,
  onConfirm,
}: {
  task: TaskOut | null;
  isDeleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  if (!task) return null;

  return (
    <BulkActionDialog
      open
      onOpenChange={onOpenChange}
      items={[{ id: task.id, name: task.name }]}
      itemNoun="Task"
      action="Delete"
      variant="destructive"
      pendingLabel="Deleting..."
      description={`${
        task.subtaskCount > 0
          ? `This also deletes ${task.subtaskCount} subtask${task.subtaskCount === 1 ? "" : "s"}, and removes`
          : "This also removes"
      } the task from any dependency chains. This action cannot be undone.`}
      renderItem={(item) => item.name}
      onSubmit={onConfirm}
      isPending={isDeleting}
    />
  );
}
