import type { TaskOut } from "@cubby/schemas/project";
import { useMemo } from "react";
import {
  OperationImpact,
  useOperationPreview,
} from "~/app/_components/impact/operation-impact";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";

/**
 * The single-task confirm-delete flow shared by every `TaskCard` host — the
 * board and its mobile/timeline fallbacks (`BoardAgenda`, the Timeline
 * agenda) all wire `TaskCard.onRequestDelete` to the same instance rather
 * than each hand-rolling the impact-preview + confirm dialog again.
 *
 * `task` is the pending delete (null renders nothing); the caller owns that
 * state because an optimistic delete unmounts the row that opened this
 * dialog, so the dialog can't own its own trigger.
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
  const previewInput = useMemo(
    () =>
      task
        ? {
            operation: "delete" as const,
            entity: "task" as const,
            ids: [task.id],
          }
        : null,
    [task],
  );
  const preview = useOperationPreview(previewInput, task !== null);

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
      blocked={preview.data?.canProceed === false}
    >
      <OperationImpact
        preview={preview.data}
        isLoading={preview.isLoading}
        isError={preview.isError}
        onRetry={() => void preview.refetch()}
      />
    </BulkActionDialog>
  );
}
