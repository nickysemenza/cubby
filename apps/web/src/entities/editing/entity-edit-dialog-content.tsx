import { useEffect } from "react";
import { toast } from "sonner";
import { FormWrapper } from "~/app/_components/form-utils";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { getEntityEditorPresentation } from "./editor-presentations";
import type { EntityEditDialogProps } from "./entity-edit-dialog";
import type {
  EditableEntity,
  EntityEditOperation,
  EntityEditRecord,
  RuntimeEntityEditRequest,
} from "./types";
import { useEntityEditSession } from "./use-entity-edit-session";

export function EntityEditDialogContent<E extends EditableEntity>({
  open,
  onOpenChange,
  request,
  onSuccess,
}: EntityEditDialogProps<E>) {
  const sessionRequest: RuntimeEntityEditRequest<E> = {
    ...request,
    surface: "dialog",
  };
  const session = useEntityEditSession(sessionRequest);
  const presentation = getEntityEditorPresentation(
    request as {
      entity: string;
      operation: EntityEditOperation;
      intent: string;
    },
  );
  const context = request.context ?? {};
  const record = request.record as EntityEditRecord | undefined;
  // Field-scoped issues render beside their control via the session's RHF
  // errors; everything else — the headline plus one line per lifecycle blocker
  // — belongs in the banner.
  const error = session.issues
    .filter((issue) => !issue.field)
    .map((issue) => issue.message);

  useEffect(() => {
    if (open) session.reset();
  }, [open, session.reset]);

  const close = () => {
    session.reset();
    onOpenChange(false);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) session.reset();
        onOpenChange(next);
      }}
      title={presentation.title({ context, record })}
      description={presentation.description({ context, record })}
      size={presentation.size}
    >
      <FormWrapper
        form={session.form}
        onSubmit={() => {
          void session.submit().then((result) => {
            if (!result.ok) return;
            toast.success(presentation.successMessage(result.result));
            close();
            if (result.result) onSuccess?.(result.result);
          });
        }}
        isPending={session.isPending}
        error={error}
        onCancel={close}
        submitButtonText={presentation.submitLabel ?? "Create"}
      >
        <presentation.Fields
          form={session.form}
          context={context}
          record={record}
        />
      </FormWrapper>
    </ResponsiveDialog>
  );
}
