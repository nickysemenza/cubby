import type { EntityImage } from "@cubby/schemas/entity";
import { ALLOWED_IMAGE_TYPES } from "@cubby/schemas/image";
import { useMutation } from "@tanstack/react-query";
import { Camera, ChevronLeft, ChevronRight, Link, Star, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { FileDropField } from "~/components/file-upload/FileDropField";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getErrorMessage } from "~/lib/error-utils";
import { imageUpload } from "~/lib/image.functions";
import { cn } from "~/lib/utils";

import { PhotoGrid, type PhotoGridImage } from "./photos/photo-grid";
import { PhotoViewer } from "./photos/photo-viewer";

const imageContentTypeSchema = z.enum(ALLOWED_IMAGE_TYPES);

export interface PendingImage {
  id: string;
  url: string;
  filename: string;
  key: string;
  /** Product-only attachment role, selected before this pending image attaches. */
  purpose?: "item" | "label";
}

interface UploadDraft {
  id: string;
  file: File;
  url: string;
  filename: string;
  state: "uploading" | "failed";
  error?: string;
}

const EMPTY_IMAGES: PendingImage[] = [];
const ACCEPTED_IMAGE_TYPES = ALLOWED_IMAGE_TYPES.join(",");

type PreviewSelection = { group: "draft" | "pending" | "existing"; id: string };

function PendingPhotoPreview({
  viewing,
  setViewing,
  groups,
}: {
  viewing: PreviewSelection | null;
  setViewing: (selection: PreviewSelection | null) => void;
  groups: Record<PreviewSelection["group"], PhotoGridImage[]>;
}) {
  if (!viewing) return null;
  const images = groups[viewing.group];
  const index = images.findIndex((image) => image.id === viewing.id);
  return (
    <PhotoViewer
      images={images}
      index={index < 0 ? null : index}
      onOpenChange={(open) => {
        if (!open) setViewing(null);
      }}
      onIndexChange={(index) => {
        const image = images[index];
        if (image) setViewing({ ...viewing, id: image.id });
      }}
      detailLink={
        viewing.group === "existing"
          ? (image) => ({ shortcode: image.id })
          : undefined
      }
    />
  );
}

interface PendingImageUploadProps {
  entityType: EntityImage;
  onImagesChange?: (images: PendingImage[]) => void;
  existingImages?: PendingImage[];
  onExistingImagesRemove?: (removedImageIds: string[]) => void;
  /** Product-only explicit role corrections for already-attached photos. */
  onExistingImagesPurposeChange?: (
    purposes: Record<string, "item" | "label">,
  ) => void;
  // Report the full display order of the remaining existing images after a
  // reorder (first = cover). Reorder controls render only when provided.
  onExistingImagesReorder?: (orderedImageIds: string[]) => void;
  className?: string;
  // When set, automatically import this URL once (e.g. an image found by the
  // recipe scraper). Re-imports only when the value changes to a new URL.
  autoImportUrl?: string | null;
  /** Injectable transport seam for UI tests; production keeps the real operations. */
  operations?: Pick<typeof imageUpload, "uploadImage" | "importFromUrl">;
}

export function PendingImageUpload({
  entityType,
  onImagesChange,
  existingImages = EMPTY_IMAGES,
  onExistingImagesRemove,
  onExistingImagesPurposeChange,
  onExistingImagesReorder,
  className = "",
  autoImportUrl,
  operations = imageUpload,
}: PendingImageUploadProps) {
  const [uploadDrafts, setUploadDrafts] = useState<UploadDraft[]>([]);
  const uploading = uploadDrafts.some((draft) => draft.state === "uploading");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  const onImagesChangeRef = useRef(onImagesChange);
  onImagesChangeRef.current = onImagesChange;
  // Must seed from the prop: the sync guard below also starts at the prop, so
  // an empty initial value here would never be replaced until the prop's
  // IDENTITY changes (a refetch) — existing images would render as none.
  const [currentExistingImages, setCurrentExistingImages] =
    useState<PendingImage[]>(existingImages);
  const [removedExistingImageIds, setRemovedExistingImageIds] = useState<
    string[]
  >([]);
  const existingPurposeChangesRef = useRef<Record<string, "item" | "label">>(
    {},
  );

  const [imageUrl, setImageUrl] = useState("");
  const [source, setSource] = useState<"own" | "catalog" | "unknown">("own");
  const [purpose, setPurpose] = useState<"item" | "label">("item");
  const [importing, setImporting] = useState(false);

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const uploadDraftsRef = useRef(uploadDrafts);
  const abandonedDraftIdsRef = useRef(new Set<string>());
  const activeDraftIdsRef = useRef(new Set<string>());
  const [viewing, setViewing] = useState<PreviewSelection | null>(null);
  uploadDraftsRef.current = uploadDrafts;

  useEffect(
    () => () => {
      for (const draft of uploadDraftsRef.current) {
        URL.revokeObjectURL(draft.url);
      }
    },
    [],
  );

  // Every asynchronous source (scraper, URL, camera, file drop, paste) meets
  // at this one append/remove seam. Reading the ref before publishing the
  // state keeps completions composable instead of letting the last closure win.
  const replacePendingImages = useCallback(
    (update: (current: PendingImage[]) => PendingImage[]) => {
      const next = update(pendingImagesRef.current);
      pendingImagesRef.current = next;
      setPendingImages(next);
      onImagesChangeRef.current?.(next);
      return next;
    },
    [],
  );

  // Sync state from prop during render (React recommended pattern). A new
  // prop reference means the parent refetched — drop stale local removals too.
  const [prevExistingImages, setPrevExistingImages] = useState(existingImages);
  if (existingImages !== prevExistingImages) {
    setPrevExistingImages(existingImages);
    setCurrentExistingImages(existingImages);
    setRemovedExistingImageIds([]);
    existingPurposeChangesRef.current = {};
  }

  const uploadImageMutation = useMutation(
    operations.uploadImage.mutationOptions({
      onError: (error) => {
        toast.error(`Upload initialization failed: ${getErrorMessage(error)}`);
      },
    }),
  );

  const importFromUrlMutation = useMutation(
    operations.importFromUrl.mutationOptions({
      onError: (error) => {
        toast.error(`Import failed: ${getErrorMessage(error)}`);
      },
    }),
  );

  // Import an image from an explicit URL (shared by the manual input and the
  // scraper auto-import).
  const importUrl = useCallback(
    async (rawUrl: string, { silent = false }: { silent?: boolean } = {}) => {
      const trimmed = rawUrl.trim();
      if (!trimmed) return;

      try {
        const parsedUrl = new URL(trimmed);
        void parsedUrl;
      } catch {
        if (!silent) toast.error("Please enter a valid URL");
        return;
      }

      setImporting(true);
      try {
        const result = await importFromUrlMutation.mutateAsync({
          url: trimmed,
          entityType,
        });

        const newImage: PendingImage = {
          id: result.imageId,
          url: result.url,
          filename: result.filename,
          key: result.key,
          purpose: entityType === "PRODUCT" ? purpose : undefined,
        };

        replacePendingImages((current) => [...current, newImage]);
        setImageUrl("");
        toast.success("Photo added.");
      } catch (error) {
        toast.error(`Import failed: ${getErrorMessage(error)}`);
      } finally {
        setImporting(false);
      }
    },
    [entityType, importFromUrlMutation, purpose, replacePendingImages],
  );

  const handleImportFromUrl = useCallback(
    () => importUrl(imageUrl),
    [importUrl, imageUrl],
  );

  // Auto-import a scraper-provided image URL once per distinct value. Failures
  // are silent here — the recipe is the primary import; the image is best-effort.
  const [autoImported, setAutoImported] = useState<string | null>(null);
  useEffect(() => {
    if (autoImportUrl && autoImportUrl !== autoImported) {
      setAutoImported(autoImportUrl);
      void importUrl(autoImportUrl, { silent: true });
    }
  }, [autoImportUrl, autoImported, importUrl]);

  const uploadFile = useCallback(
    async (file: File): Promise<PendingImage> => {
      if (!file) {
        throw new Error("No file to upload");
      }

      const contentType = imageContentTypeSchema.safeParse(file.type);
      if (!contentType.success) {
        throw new Error(
          `Unsupported image type: ${file.type}. Allowed: JPEG, PNG, GIF, WebP, HEIC.`,
        );
      }

      const initResult = await uploadImageMutation.mutateAsync({
        filename: file.name,
        contentType: contentType.data,
        size: file.size,
        entityType,
        source,
      });

      const uploadResult = await fetch(initResult.uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        },
      });

      if (!uploadResult.ok) {
        const errorText = await uploadResult
          .text()
          .catch(() => "Unknown error");
        throw new Error(`Storage error (${uploadResult.status}): ${errorText}`);
      }

      return {
        id: initResult.imageId,
        url: initResult.url,
        filename: file.name,
        key: initResult.key,
        purpose: entityType === "PRODUCT" ? purpose : undefined,
      };
    },
    [entityType, purpose, source, uploadImageMutation],
  );

  const runUpload = useCallback(
    async (draftId: string, file: File) => {
      if (
        activeDraftIdsRef.current.has(draftId) ||
        abandonedDraftIdsRef.current.has(draftId)
      )
        return;
      activeDraftIdsRef.current.add(draftId);
      setUploadDrafts((drafts) =>
        drafts.map((draft) =>
          draft.id === draftId
            ? { ...draft, state: "uploading" as const, error: undefined }
            : draft,
        ),
      );
      try {
        const uploaded = await uploadFile(file);
        if (abandonedDraftIdsRef.current.has(draftId)) return;
        setUploadDrafts((drafts) => {
          const completed = drafts.find((draft) => draft.id === draftId);
          if (completed) URL.revokeObjectURL(completed.url);
          return drafts.filter((draft) => draft.id !== draftId);
        });
        replacePendingImages((current) =>
          current.some((image) => image.id === uploaded.id)
            ? current
            : [...current, uploaded],
        );
        toast.success("Photo added.");
      } catch (error) {
        const message = getErrorMessage(error);
        setUploadDrafts((drafts) =>
          drafts.map((draft) =>
            draft.id === draftId
              ? { ...draft, state: "failed" as const, error: message }
              : draft,
          ),
        );
        toast.error(`Upload failed: ${message}`);
      } finally {
        activeDraftIdsRef.current.delete(draftId);
      }
    },
    [replacePendingImages, uploadFile],
  );

  const beginUpload = useCallback(
    (file: File) => {
      const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`;
      const id = `${file.name}-${suffix}`;
      abandonedDraftIdsRef.current.delete(id);
      const draft: UploadDraft = {
        id,
        file,
        url: URL.createObjectURL(file),
        filename: file.name,
        state: "uploading",
      };
      setUploadDrafts((drafts) => [...drafts, draft]);
      void runUpload(id, file);
    },
    [runUpload],
  );

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (uploading || importing) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;

          e.preventDefault();

          const extension = item.type.split("/")[1] || "png";
          const namedFile = new File(
            [file],
            `pasted-image-${Date.now()}.${extension}`,
            { type: file.type },
          );

          beginUpload(namedFile);
          return;
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [beginUpload, uploading, importing]);

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        toast.error("Please select a file to upload");
        return;
      }

      beginUpload(file);

      if (cameraInputRef.current) {
        cameraInputRef.current.value = "";
      }
    },
    [beginUpload],
  );

  const handleSelectedImages = useCallback(
    (files: File[]) => {
      for (const file of files) beginUpload(file);
    },
    [beginUpload],
  );

  const removeUploadDraft = useCallback((draftId: string) => {
    abandonedDraftIdsRef.current.add(draftId);
    setUploadDrafts((drafts) => {
      const draft = drafts.find((item) => item.id === draftId);
      if (draft) URL.revokeObjectURL(draft.url);
      return drafts.filter((item) => item.id !== draftId);
    });
  }, []);

  const removeImage = useCallback(
    (imageId: string) => {
      replacePendingImages((current) =>
        current.filter((image) => image.id !== imageId),
      );
    },
    [replacePendingImages],
  );

  const removeExistingImage = useCallback(
    (imageId: string) => {
      const updatedRemovedIds = [...removedExistingImageIds, imageId];
      setRemovedExistingImageIds(updatedRemovedIds);

      const updatedExistingImages = currentExistingImages.filter(
        (img) => img.id !== imageId,
      );
      setCurrentExistingImages(updatedExistingImages);

      if (onExistingImagesRemove) {
        onExistingImagesRemove(updatedRemovedIds);
      }
    },
    [removedExistingImageIds, currentExistingImages, onExistingImagesRemove],
  );

  const setExistingImagePurpose = useCallback(
    (imageId: string, purpose: "item" | "label") => {
      setCurrentExistingImages((images) =>
        images.map((image) =>
          image.id === imageId ? { ...image, purpose } : image,
        ),
      );
      const next = {
        ...existingPurposeChangesRef.current,
        [imageId]: purpose,
      };
      existingPurposeChangesRef.current = next;
      onExistingImagesPurposeChange?.(next);
    },
    [onExistingImagesPurposeChange],
  );

  const moveExistingImage = useCallback(
    (imageId: string, target: "front" | "left" | "right") => {
      const idx = currentExistingImages.findIndex((img) => img.id === imageId);
      if (idx === -1) return;
      const next = [...currentExistingImages];
      const [moved] = next.splice(idx, 1);
      if (!moved) return;
      const to =
        target === "front"
          ? 0
          : target === "left"
            ? Math.max(0, idx - 1)
            : Math.min(next.length, idx + 1);
      next.splice(to, 0, moved);
      setCurrentExistingImages(next);
      onExistingImagesReorder?.(next.map((img) => img.id));
    },
    [currentExistingImages, onExistingImagesReorder],
  );

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <FileDropField
              accept={ACCEPTED_IMAGE_TYPES}
              label="Choose image"
              description="or drop it here"
              mode="compact"
              onFilesAdded={handleSelectedImages}
              multiple
              disabled={uploading || importing}
            />
          </div>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileUpload}
            disabled={uploading || importing}
            hidden
          />
          <Button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            disabled={uploading || importing}
          >
            <Camera className="mr-2 size-4" />
            Camera
          </Button>
        </div>
        <div className="flex gap-2">
          <Input
            type="url"
            placeholder="Paste image URL..."
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleImportFromUrl();
              }
            }}
            disabled={importing || uploading}
            className="flex-1"
          />
          <Button
            type="button"
            onClick={handleImportFromUrl}
            disabled={importing || uploading || !imageUrl.trim()}
          >
            <Link className="mr-2 size-4" />
            Import
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pending-image-source">Photo source</Label>
          <select
            className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
            id="pending-image-source"
            value={source}
            onChange={(event) =>
              setSource(
                event.target.value === "own" || event.target.value === "catalog"
                  ? event.target.value
                  : "unknown",
              )
            }
          >
            <option value="own">Our photo</option>
            <option value="catalog">Catalog image</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        {entityType === "PRODUCT" && (
          <div className="space-y-1">
            <Label htmlFor="pending-product-image-purpose">Attach as</Label>
            <select
              className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
              id="pending-product-image-purpose"
              value={purpose}
              onChange={(event) =>
                setPurpose(event.target.value === "label" ? "label" : "item")
              }
            >
              <option value="item">Item photo</option>
              <option value="label">Label photo</option>
            </select>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          You can also paste an image from your clipboard
        </p>
      </div>

      {(uploading || importing) && (
        <div className="py-2 text-center">
          <div className="mb-2">
            {importing ? "Importing..." : "Uploading..."}
          </div>
          <div className="mx-auto h-1 w-full max-w-md rounded-full bg-muted">
            <div
              className="h-1 animate-pulse rounded-full bg-primary"
              style={{ width: "100%" }}
            ></div>
          </div>
        </div>
      )}

      {uploadDrafts.length > 0 && (
        <div className="space-y-2">
          <Label>Uploading images</Label>
          <PhotoGrid
            images={uploadDrafts}
            onSelect={(image) => setViewing({ group: "draft", id: image.id })}
            renderOverlay={(draft) => (
              <div className="absolute inset-x-1 bottom-1 z-20 flex items-center justify-between gap-1 rounded bg-background/90 p-1 text-xs">
                {draft.state === "uploading" ? (
                  <span>Uploading…</span>
                ) : (
                  <span
                    className="truncate text-destructive"
                    title={draft.error}
                  >
                    Upload failed
                  </span>
                )}
                <div className="flex shrink-0 gap-1">
                  {draft.state === "failed" ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void runUpload(draft.id, draft.file)}
                    >
                      Retry
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-6"
                    aria-label={`Remove ${draft.filename}`}
                    onClick={() => removeUploadDraft(draft.id)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              </div>
            )}
          />
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="space-y-2">
          <Label>New images</Label>
          <PhotoGrid
            images={pendingImages}
            onSelect={(image) => setViewing({ group: "pending", id: image.id })}
            renderOverlay={(image) => (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute top-1 right-1 z-20 size-6 rounded-full p-1"
                onClick={() => removeImage(image.id)}
                aria-label={`Remove ${image.filename}`}
                title={`Remove ${image.filename}`}
              >
                <X className="size-4" />
              </Button>
            )}
          />
        </div>
      )}

      {currentExistingImages.length > 0 && (
        <div className="space-y-2">
          <Label>Existing images</Label>
          <PhotoGrid
            images={currentExistingImages}
            onSelect={(image) =>
              setViewing({ group: "existing", id: image.id })
            }
            renderOverlay={(image, index) => (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute top-1 right-1 z-20 size-6 rounded-full p-1"
                  aria-label={`Remove ${image.filename}`}
                  title={`Remove ${image.filename}`}
                  onClick={() => removeExistingImage(image.id)}
                >
                  <X className="size-4" />
                </Button>
                {onExistingImagesReorder && index === 0 && (
                  <span className="absolute bottom-1 left-1 z-20 rounded-sm bg-background/80 px-1 font-mono text-2xs text-foreground uppercase">
                    Cover
                  </span>
                )}
                {entityType === "PRODUCT" && (
                  <select
                    aria-label={`Attachment role for ${image.filename}`}
                    className="absolute inset-x-1 bottom-1 z-20 h-7 rounded-sm border border-input bg-background/90 px-1 text-xs"
                    value={image.purpose ?? "item"}
                    onChange={(event) =>
                      setExistingImagePurpose(
                        image.id,
                        event.target.value === "label" ? "label" : "item",
                      )
                    }
                  >
                    <option value="item">Item photo</option>
                    <option value="label">Label photo</option>
                  </select>
                )}
                {onExistingImagesReorder && index > 0 && (
                  <div className="absolute bottom-1 left-1 z-20 flex gap-1">
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-6 rounded-full p-1"
                      title="Make cover"
                      onClick={() => moveExistingImage(image.id, "front")}
                    >
                      <Star className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="size-6 rounded-full p-1"
                      title="Move earlier"
                      onClick={() => moveExistingImage(image.id, "left")}
                    >
                      <ChevronLeft className="size-4" />
                    </Button>
                    {index < currentExistingImages.length - 1 && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        className="size-6 rounded-full p-1"
                        title="Move later"
                        onClick={() => moveExistingImage(image.id, "right")}
                      >
                        <ChevronRight className="size-4" />
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          />
        </div>
      )}
      <PendingPhotoPreview
        viewing={viewing}
        setViewing={setViewing}
        groups={{
          draft: uploadDrafts,
          pending: pendingImages,
          existing: currentExistingImages,
        }}
      />
    </div>
  );
}
