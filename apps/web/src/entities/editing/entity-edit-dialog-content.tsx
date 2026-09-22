import { entityImageOf, type ImageEntity } from "@cubby/schemas/entity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { getErrorMessage } from "@cubby/shared";
import { isEqual } from "es-toolkit";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { z } from "zod";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
} from "~/app/_components/ai/field-suggestion";
import { FieldSuggestionProvider } from "~/app/_components/ai/field-suggestion-provider";
import { FormWrapper } from "~/app/_components/form-utils";
import {
  PendingImageUpload,
  type PendingImage,
} from "~/app/_components/PendingImageUpload";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import type { UnparsedError } from "~/lib/error-utils";

import { entityEditRegistry } from "./definitions";
import {
  type EntityEditorPresentation,
  getEntityEditorPresentation,
} from "./editor-presentations";
import type { EntityEditDialogProps } from "./entity-edit-dialog";
import { isResolvedEntityEdit, resolveEntityEdit } from "./kernel";
import type {
  EditableEntity,
  EntityEditRecord,
  RuntimeEntityEditRequest,
} from "./types";
import type { EntityEditIssue } from "./types";
import {
  type EntityEditSession,
  useEntityEditSession,
} from "./use-entity-edit-session";

/** Field issues belong beside controls; dialog banners keep lifecycle context. */
export function entityEditBannerIssues(
  issues: readonly EntityEditIssue[],
): string[] {
  return issues.filter((issue) => !issue.field).map((issue) => issue.message);
}

type ImagePurpose = NonNullable<PendingImage["purpose"]>;
type ImagePurposes = Record<string, ImagePurpose>;
const NO_PURPOSES: ImagePurposes = {};
const NO_IMAGES: readonly PendingImage[] = [];
const NO_FIELDS: readonly string[] = [];
/**
 * A gallery entity's `record.images` in the shape the upload block edits. A
 * product image carries `purpose: null` for "no explicit role", which the
 * block spells as an absent `purpose`.
 */
const recordImagesSchema = z
  .array(
    z
      .object({
        id: z.string(),
        url: z.string(),
        filename: z.string(),
        key: z.string(),
        purpose: z.enum(["item", "label"]).nullish(),
      })
      .transform(({ purpose, ...image }): PendingImage =>
        purpose ? { ...image, purpose } : image,
      ),
  )
  .catch([]);

/**
 * The write-only image instructions the gallery block feeds the form. An
 * explicit role correction on an already-attached image rides
 * `pendingImageIds` on purpose: the repository accepts an active attachment
 * there and applies its `pendingImagePurposes` value without detaching or
 * reordering it (the contract `useImageState` documents).
 */
function imageFieldValues(
  pendingImages: readonly PendingImage[],
  existingPurposes: ImagePurposes,
  withPurposes: boolean,
) {
  const pendingImageIds = [
    ...pendingImages.map((image) => image.id),
    ...(withPurposes ? Object.keys(existingPurposes) : []),
  ];
  const pendingImagePurposes = { ...existingPurposes };
  for (const image of pendingImages) {
    if (image.purpose) pendingImagePurposes[image.id] = image.purpose;
  }
  return { pendingImageIds, pendingImagePurposes };
}

/** Keeps a structurally-equal value referentially stable across renders. */
function useStableValue<T>(value: T): T {
  const last = useRef(value);
  if (!isEqual(last.current, value)) last.current = value;
  return last.current;
}

/**
 * The image block plus the presentation's `media` extension. A component of
 * its own (rather than inline in the shell) so the hook is called from one
 * fixed place in the tree: the presentation is a module constant or a cached
 * generic, so `media`'s presence never changes for a mounted dialog and its
 * own hooks keep their order. Exported for its unit test only; the dialog
 * shell below is its one production mount.
 */
export function EntityEditorImages<E extends EditableEntity>({
  entity,
  operation,
  presentation,
  session,
  record,
  withRemoval,
  withReorder,
  withPurposes,
}: {
  entity: E;
  operation: "create" | "update";
  presentation: EntityEditorPresentation<E>;
  session: EntityEditSession<E>;
  record?: EntityEditRecord;
  withRemoval: boolean;
  withReorder: boolean;
  withPurposes: boolean;
}) {
  const [pendingImages, setPendingImages] =
    useState<readonly PendingImage[]>(NO_IMAGES);
  const [existingPurposes, setExistingPurposes] =
    useState<ImagePurposes>(NO_PURPOSES);
  const form = session.form;
  // This block owns `pendingImageIds`/`removeImageIds` primarily, but a
  // presentation's `media` extension (product's manuals dropzone) may also
  // contribute ids to the same shared fields (documents ride the same
  // gallery-attachment wire shape). Each writer reads the field's current
  // value and replaces only the slice it previously wrote — tracked in
  // `ownIds` — so the two writers merge instead of clobbering each other.
  const ownPendingImageIds = useRef<readonly string[]>([]);
  const ownRemovedImageIds = useRef<readonly string[]>([]);
  const mergeIntoSharedIdField = useCallback(
    (
      fieldKey: "pendingImageIds" | "removeImageIds",
      owned: RefObject<readonly string[]>,
      nextOwnIds: readonly string[],
    ) => {
      const current = z
        .array(z.string())
        .catch([])
        .parse(form.getValues(fieldKey));
      const foreign = current.filter((id) => !owned.current.includes(id));
      owned.current = nextOwnIds;
      form.setValue(fieldKey, [...new Set([...foreign, ...nextOwnIds])], {
        shouldDirty: true,
      });
    },
    [form],
  );
  const sync = useCallback(
    (images: readonly PendingImage[], purposes: ImagePurposes) => {
      const values = imageFieldValues(images, purposes, withPurposes);
      mergeIntoSharedIdField(
        "pendingImageIds",
        ownPendingImageIds,
        values.pendingImageIds,
      );
      if (withPurposes) {
        form.setValue("pendingImagePurposes", values.pendingImagePurposes, {
          shouldDirty: true,
        });
      }
    },
    [form, withPurposes, mergeIntoSharedIdField],
  );
  // The record's own gallery only matters for an update; a create has none.
  const recordImages = useStableValue(
    operation === "update" ? recordImagesSchema.parse(record?.images) : [],
  );
  const media = presentation.media?.({
    form,
    record,
    pendingImages,
    existingImages: recordImages,
  });
  const extra = useStableValue(media?.extraExistingImages ?? NO_IMAGES);
  // `PendingImageUpload` re-seeds its gallery whenever this prop's identity
  // changes, so the merged list must only change when its contents do.
  const existingImages = useMemo(() => {
    const seen = new Set(recordImages.map((image) => image.id));
    return [
      ...recordImages,
      ...extra.filter((image) => {
        if (seen.has(image.id)) return false;
        seen.add(image.id);
        return true;
      }),
    ];
  }, [recordImages, extra]);

  return (
    <>
      <PendingImageUpload
        // SAFETY: the shell mounts this block only when the resolved intent's
        // field roster carries `pendingImageIds`, which only an image-bearing
        // entity declares.
        entityType={entityImageOf(entity as ImageEntity)}
        existingImages={existingImages}
        onImagesChange={(images) => {
          setPendingImages(images);
          sync(images, existingPurposes);
        }}
        onExistingImagesRemove={
          withRemoval
            ? (removedImageIds) =>
                mergeIntoSharedIdField(
                  "removeImageIds",
                  ownRemovedImageIds,
                  removedImageIds,
                )
            : undefined
        }
        onExistingImagesPurposeChange={
          withPurposes
            ? (purposes) => {
                setExistingPurposes(purposes);
                sync(pendingImages, purposes);
              }
            : undefined
        }
        onExistingImagesReorder={
          withReorder
            ? (orderedImageIds) =>
                form.setValue("imageOrder", orderedImageIds, {
                  shouldDirty: true,
                })
            : undefined
        }
      />
      {media?.actions}
      {media?.documents}
    </>
  );
}

/**
 * Basis values a suggest target needs that this intent does not render — a
 * record-only evidence field (product `classificationEvidence`) has no form
 * path to watch, so its value comes off the record for the mount. `undefined`
 * when every basis key is a rendered field (the provider watches them all).
 */
export function staticSuggestionBasisFor(
  entity: ShortcodeEntity,
  intentFields: readonly string[],
  record: EntityEditRecord | undefined,
): Readonly<Record<string, string | null>> | undefined {
  if (!record) return undefined;
  const targets = suggestTargetsFor(entity, intentFields);
  const outside = targets.basisKeys.filter(
    (key) => !intentFields.includes(key),
  );
  if (outside.length === 0) return undefined;
  return fieldSuggestionBasisFromRecord(
    entity,
    { targets: targets.targets, basisKeys: outside },
    record,
  );
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
    : NO_FIELDS;
  // An intent whose active field roster includes `pendingImageIds` gets the
  // generic photo-capture field below the presentation's own fields; no
  // per-entity Fields component knows about images. An update roster that
  // also carries `removeImageIds` / `imageOrder` lets the existing gallery be
  // trimmed / reordered; the `imageOrder` field is seeded from `record.images`
  // and only reaches the payload when the order changed (`definitions.ts`).
  // A roster with `pendingImagePurposes` (attachment roles) sends the role
  // of each pending image and any role correction on an existing one.
  const showPendingImageUpload = intentFields.includes("pendingImageIds");
  const showImageRemoval =
    request.operation === "update" && intentFields.includes("removeImageIds");
  const showImageReorder =
    request.operation === "update" && intentFields.includes("imageOrder");
  const showImagePurposes = intentFields.includes("pendingImagePurposes");
  // SAFETY: `EditableEntity` (this dialog's `E`) excludes only
  // image/usda-food/cookbook, and every entity with the standard
  // create/update editing surface carries a shortcode prefix.
  const suggestionEntity = request.entity as ShortcodeEntity;
  const staticBasis = useMemo(
    () => staticSuggestionBasisFor(suggestionEntity, intentFields, record),
    [suggestionEntity, intentFields, record],
  );
  // A failure after the submit itself succeeded (the shell's own invariant,
  // a caller's `onSuccess`) still has to be seen; it joins the banner.
  const [shellError, setShellError] = useState<string | null>(null);
  // Field-scoped issues render beside their control via the session's RHF
  // errors; everything else — the headline plus one line per lifecycle blocker
  // — belongs in the banner.
  const error = [
    ...entityEditBannerIssues(session.issues),
    ...(shellError ? [shellError] : []),
  ];

  useEffect(() => {
    if (open) {
      resetSession();
      setShellError(null);
    }
  }, [open, resetSession]);

  const close = () => {
    resetSession();
    onOpenChange(false);
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && session.isPending) return;
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
          setShellError(null);
          void session
            .submit()
            .then((result) => {
              if (!result.ok) return;
              if (!result.changed) {
                close();
                return;
              }
              if (!result.result) {
                throw new Error(
                  `${request.entity} ${request.operation} returned no entity result.`,
                );
              }
              toast.success(presentation.successMessage(result.result));
              close();
              onSuccess?.(result.result);
            })
            .catch((error: UnparsedError) =>
              setShellError(getErrorMessage(error)),
            );
        }}
        isPending={session.isPending}
        error={error}
        onCancel={() => {
          if (!session.isPending) close();
        }}
        submitButtonText={presentation.submitLabel ?? "Create"}
        footerMode="dialog"
      >
        <FieldSuggestionProvider
          entity={suggestionEntity}
          mode={request.operation === "create" ? "create" : "edit"}
          fieldKeys={intentFields}
          staticBasis={staticBasis}
          record={record}
        >
          <presentation.Fields
            form={session.form}
            context={context}
            record={record}
          />
        </FieldSuggestionProvider>
        {showPendingImageUpload && (
          <EntityEditorImages
            entity={request.entity}
            operation={request.operation}
            presentation={presentation}
            session={session}
            record={record}
            withRemoval={showImageRemoval}
            withReorder={showImageReorder}
            withPurposes={showImagePurposes}
          />
        )}
      </FormWrapper>
    </ResponsiveDialog>
  );
}
