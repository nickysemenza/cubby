import { useEffect } from "react";
import { toast } from "sonner";
import { FormWrapper } from "~/app/_components/form-utils";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import type { EntityEditorForm } from "./editor-presentations";
import { getEntityEditorPresentation } from "./editor-presentations";
import type { EntityEditResultFor } from "./intent-types";
import type {
  EditableEntity,
  EntityEditOperation,
  EntityEditRecord,
  EntityEditRequest,
} from "./types";
import { useEntityEditSession } from "./use-entity-edit-session";

type SupportedEntityEditDialogRequest =
  | (Omit<EntityEditRequest<"meal", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"task", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"expense", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"project", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"vendor", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<EntityEditRequest<"purchase", "create", "capture">, "surface"> & {
      intent: "capture";
    })
  | (Omit<
      EntityEditRequest<"financialAccount", "create", "capture">,
      "surface"
    > & { intent: "capture" })
  | (Omit<
      EntityEditRequest<"financialAccount", "update", "full">,
      "surface"
    > & { intent: "full" })
  | (Omit<
      EntityEditRequest<"financialTransaction", "create", "capture">,
      "surface"
    > & { intent: "capture" })
  | (Omit<
      EntityEditRequest<"financialTransaction", "update", "full">,
      "surface"
    > & { intent: "full" })
  | (Omit<EntityEditRequest<"wish", "create", "full">, "surface"> & {
      intent: "full";
    })
  | (Omit<EntityEditRequest<"wish", "update", "full">, "surface"> & {
      intent: "full";
    });

export type EntityEditDialogRequest<
  E extends EditableEntity = SupportedEntityEditDialogRequest["entity"],
> = Extract<SupportedEntityEditDialogRequest, { entity: E }>;

export function EntityEditDialog<E extends EditableEntity>({
  open,
  onOpenChange,
  request,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: EntityEditDialogRequest<E>;
  onSuccess?: (result: EntityEditResultFor<E>) => void;
}) {
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
  const error = session.issues.find((issue) => !issue.field)?.message;

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
