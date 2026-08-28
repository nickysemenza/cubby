import { useEffect } from "react";
import { toast } from "sonner";

import { FormWrapper } from "~/app/_components/form-utils";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";

import { getEntityEditorPresentation } from "./editor-presentations";
import type { EntityEditDialogProps } from "./entity-edit-dialog";
import type { EditableEntity, RuntimeEntityEditRequest } from "./types";
import type { EntityEditIssue } from "./types";
import { useEntityEditSession } from "./use-entity-edit-session";

/** Field issues belong beside controls; dialog banners keep lifecycle context. */
export function entityEditBannerIssues(
  issues: readonly EntityEditIssue[],
): string[] {
  return issues.filter((issue) => !issue.field).map((issue) => issue.message);
}

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
  const resetSession = session.reset;
  const presentation = getEntityEditorPresentation<E>(request);
  const context = request.context ?? {};
  const record = request.record;
  // Field-scoped issues render beside their control via the session's RHF
  // errors; everything else — the headline plus one line per lifecycle blocker
  // — belongs in the banner.
  const error = entityEditBannerIssues(session.issues);

  useEffect(() => {
    if (open) resetSession();
  }, [open, resetSession]);

  const close = () => {
    resetSession();
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
            if (!result.result) {
              throw new Error(
                `${request.entity} ${request.operation} returned no entity result.`,
              );
            }
            toast.success(presentation.successMessage(result.result));
            close();
            onSuccess?.(result.result);
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
