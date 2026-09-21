import { entityImageOf, type ImageEntity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { useEffect } from "react";
import { toast } from "sonner";

import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
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
  mutationPort,
}: EntityEditDialogProps<E>) {
  const sessionRequest: RuntimeEntityEditRequest<E> = {
    ...request,
    surface: "dialog",
  };
  const session = useEntityEditSession(sessionRequest, { mutationPort });
  const resetSession = session.reset;
  const presentation = getEntityEditorPresentation<E>(request);
  const context = request.context ?? {};
  const record = request.record;
  const resolved = resolveEntityEdit(entityEditRegistry, sessionRequest);
  const intentFields = isResolvedEntityEdit(resolved)
    ? resolved.intentDefinition.fields
    : [];
  // An intent whose active field roster includes `pendingImageIds` gets the
  // generic photo-capture field below the presentation's own fields; no
  // per-entity Fields component knows about images. An update roster that
  // also carries `removeImageIds` / `imageOrder` lets the existing gallery be
  // trimmed / reordered; the `imageOrder` field is seeded from `record.images`
  // and only reaches the payload when the order changed (`definitions.ts`).
  const showPendingImageUpload = intentFields.includes("pendingImageIds");
  const showImageRemoval =
    request.operation === "update" && intentFields.includes("removeImageIds");
  const showImageReorder =
    request.operation === "update" && intentFields.includes("imageOrder");
  // SAFETY: only reached for an update whose record is a gallery entity's own
  // read shape — the one shape in this generic dialog that carries an
  // `images` array.
  const existingImages =
    showImageRemoval || showImageReorder
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
      size={presentation.size ?? "md"}
      bodyMode="form"
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
        footerMode="dialog"
      >
        <FieldSuggestionProvider
          // SAFETY: `EditableEntity` (this dialog's `E`) excludes only
          // image/usda-food/cookbook, and every entity with the standard
          // create/update editing surface carries a shortcode prefix.
          entity={request.entity as ShortcodeEntity}
          mode={request.operation === "create" ? "create" : "edit"}
          fieldKeys={intentFields}
          record={record}
        >
          <presentation.Fields
            form={session.form}
            context={context}
            record={record}
          />
        </FieldSuggestionProvider>
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
            onExistingImagesReorder={
              showImageReorder
                ? (orderedImageIds) =>
                    session.form.setValue("imageOrder", orderedImageIds, {
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
