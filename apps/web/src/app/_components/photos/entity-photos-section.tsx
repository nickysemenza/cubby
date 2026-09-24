import type { GalleryEntity } from "@cubby/schemas/entity-manifest";
import type { ImageOut } from "@cubby/schemas/image";
import { CameraPlusIcon as ImagePlus } from "@phosphor-icons/react/dist/csr/CameraPlus";
import { useRef } from "react";
import { toast } from "sonner";

import { showErrorToast } from "~/components/feedback/error-details";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  entityMutationOptionsFactory,
  type EntityMutationTransport,
  type EntityMutationVariables,
} from "~/entities/entity-contracts";
import type { imageUpload } from "~/lib/image.functions";

import EntityImageList from "../EntityImageList";
import { useActionMutation } from "../hooks/useActionMutation";
import { useEntityPhotoCapture } from "./use-entity-photo-capture";

type GalleryUpdateVariables<E extends GalleryEntity> = EntityMutationVariables<
  E,
  "update"
>;

interface EntityPhotosSectionProps<E extends GalleryEntity> {
  entity: E;
  id: GalleryUpdateVariables<E>["id"];
  images: ImageOut[];
  /** Injectable transport seams for tests; production keeps the real ones. */
  transport?: EntityMutationTransport;
  uploadImageOperation?: typeof imageUpload.uploadImage;
}

/**
 * A reusable "Photos" detail section for a gallery entity whose detail page
 * edits inline rather than through a full edit form (meal, task, planting —
 * see `entity-edit-dialog-content.tsx` for the create-time equivalent).
 *
 * Modeled on `LocationPhotoAction`: a hidden multi-select file input (no
 * `capture` attribute, so iOS offers camera *or* library) behind an "Add
 * photos" button. Files upload through `useEntityPhotoCapture` one at a time,
 * `asCover: false` — a batch keeps its pick order rather than each file
 * briefly becoming the cover.
 *
 * Sequential on purpose, not `Promise.all`: `associatePendingImages` has no
 * on-conflict clause, so two attaches racing the same (entity, imageId)
 * partial unique index would fail one of them, and a batch failing partway
 * must leave every already-attached photo attached (`entry-form.tsx` runs
 * the identical policy for its own photo batch) — stop and toast on the
 * first failure, keep what already landed.
 */
export function EntityPhotosSection<E extends GalleryEntity>({
  entity,
  id,
  images,
  transport,
  uploadImageOperation,
}: EntityPhotosSectionProps<E>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { capture, isCapturing } = useEntityPhotoCapture(entity, {
    transport,
    uploadImageOperation,
  });
  const remove = useActionMutation({
    mutationFn: entityMutationOptionsFactory(entity, "update", transport),
    success: "Photo removed",
  });

  const addPhotos = async (files: File[]) => {
    for (const file of files) {
      try {
        // Sequential by design — see the doc comment above.
        await capture(id, file, { asCover: false });
      } catch (error) {
        showErrorToast(error, "Photo failed");
        return;
      }
    }
    toast.success(files.length > 1 ? "Photos added." : "Photo added.");
  };

  return (
    <Stack gap="md">
      <EntityImageList
        images={images}
        showViewAllButton={false}
        onRemove={(imageId) =>
          // SAFETY: every gallery entity's generated update schema accepts
          // `{ id, data: { removeImageIds } }` — the per-entity shapes only
          // differ in fields this section never sets.
          remove.mutate({
            id,
            data: { removeImageIds: [imageId] },
          } as GalleryUpdateVariables<E>)
        }
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Choose photos"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void addPhotos(files);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isCapturing}
        onClick={() => inputRef.current?.click()}
      >
        {isCapturing ? <Spinner className="size-4" /> : <ImagePlus />}
        Add photos
      </Button>
    </Stack>
  );
}

export type { EntityPhotosSectionProps };
