import { useEffect } from "react";
import { toast } from "sonner";
import { FormWrapper } from "~/app/_components/form-utils";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import type { EntityEditorForm } from "./editor-presentations";
import { getEntityEditorPresentation } from "./editor-presentations";
import type { EntityEditDialogProps } from "./entity-edit-dialog";
import type { EntityEditResultFor } from "./intent-types";
import type {
  EditableEntity,
  EntityEditOperation,
  EntityEditRecord,
  EntityEditRequest,
} from "./types";
import { useEntityEditSession } from "./use-entity-edit-session";

export function EntityEditDialogContent<E extends EditableEntity>({
  open,
  onOpenChange,
  request,
  onSuccess,
}: EntityEditDialogProps<E>) {
  const session = useEntityEditSession({
    ...request,
    surface: "dialog",
  } as unknown as EntityEditRequest<E>);
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
            onSuccess?.(result.result as EntityEditResultFor<E>);
          });
        }}
        isPending={session.isPending}
        error={error}
        onCancel={close}
        submitButtonText={presentation.submitLabel ?? "Create"}
      >
        <presentation.Fields
          form={session.form as unknown as EntityEditorForm}
          context={context}
          record={record}
        />
      </FormWrapper>
    </ResponsiveDialog>
  );
}
