import { entityImageOf, type ImageEntity } from "@cubby/schemas/entity";
import { useEffect } from "react";
import { toast } from "sonner";

import { FormWrapper } from "~/app/_components/form-utils";
import {
  PendingImageUpload,
  type PendingImage,
} from "~/app/_components/PendingImageUpload";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";

import { entityEditRegistry } from "./definitions";
import { getEntityEditorPresentation } from "./editor-presentations";
import type { EntityEditDialogProps } from "./entity-edit-dialog";
import { isResolvedEntityEdit, resolveEntityEdit } from "./kernel";
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
  // A create intent whose active field roster includes `pendingImageIds` gets
  // the generic photo-capture field for free, below the presentation's own
  // fields — no per-entity Fields component needs to know about it (meal and
  // task's capture dialogs are exactly this: see `editor-presentations.tsx`).
  const resolved = resolveEntityEdit(entityEditRegistry, sessionRequest);
  const intentFields = isResolvedEntityEdit(resolved)
    ? resolved.intentDefinition.fields
    : [];
  // A create *or* update intent whose active field roster includes
  // `pendingImageIds` gets the generic photo-capture field for free, below
  // the presentation's own fields — no per-entity Fields component needs to
  // know about it (meal and task's capture dialogs are exactly this: see
  // `editor-presentations.tsx`). An update that also carries
  // `removeImageIds` additionally lets the existing gallery be trimmed —
  // reordering stays a `full`-page-only affordance (no generic `imageOrder`
  // seeding from a record).
  const showPendingImageUpload = intentFields.includes("pendingImageIds");
  const showImageRemoval =
    request.operation === "update" && intentFields.includes("removeImageIds");
  // SAFETY: only reached when `showImageRemoval` is true, which only turns
  // true for an update whose record is a gallery entity's own read shape —
  // the one shape in this generic dialog that carries an `images` array.
  const existingImages = showImageRemoval
    ? ((record as { images?: PendingImage[] }).images ?? [])
    : [];
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
        {showPendingImageUpload && (
          <PendingImageUpload
            // SAFETY: `showPendingImageUpload` only turns true when the
            // resolved intent's field roster carries `pendingImageIds`, which
            // only an image-bearing entity declares.
            entityType={entityImageOf(request.entity as ImageEntity)}
            existingImages={existingImages}
            onImagesChange={(images) =>
              session.form.setValue(
                "pendingImageIds",
                images.map((image) => image.id),
                { shouldDirty: true },
              )
            }
            onExistingImagesRemove={
              showImageRemoval
                ? (removedImageIds) =>
                    session.form.setValue("removeImageIds", removedImageIds, {
                      shouldDirty: true,
                    })
                : undefined
            }
          />
        )}
      </FormWrapper>
    </ResponsiveDialog>
  );
}
