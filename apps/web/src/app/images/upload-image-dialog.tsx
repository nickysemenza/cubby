import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { UploadIcon as Upload } from "@phosphor-icons/react/dist/csr/Upload";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { FileDropField } from "~/components/file-upload/FileDropField";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { imageUpload } from "~/lib/image.functions";

import { PhotoGrid } from "../_components/photos/photo-grid";
import { PhotoViewer } from "../_components/photos/photo-viewer";
import { type UploadedImage, useImageUpload } from "./use-image-upload";

/**
 * `/images` toolbar entry point: file picker (multiple) + URL import. Not
 * drag-drop — that fights row selection on the images table underneath.
 * PDFs are deliberately out of scope here (`ALLOWED_IMAGE_TYPES` excludes
 * them — image-only surfaces never accept PDFs, see packages/schemas/src/image.ts).
 */
interface UploadImageDialogProps {
  /** Injectable transport seam for UI tests; production uses imageUpload. */
  operations?: Pick<
    typeof imageUpload,
    "uploadImage" | "markUploaded" | "importFromUrl"
  >;
}

type UploadDraft = {
  id: string;
  file: File;
  url: string;
  filename: string;
  state: "uploading" | "failed";
  uploadedImage?: UploadedImage;
};

export function UploadImageDialog({
  operations = imageUpload,
}: UploadImageDialogProps) {
  const queryClient = useQueryClient();
  const urlInputId = useId();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const { uploadFile, isUploading } = useImageUpload(operations);
  const [drafts, setDrafts] = useState<UploadDraft[]>([]);
  const [viewingDraftIndex, setViewingDraftIndex] = useState<number | null>(
    null,
  );
  const inFlightDraftIdsRef = useRef(new Set<string>());
  const removedDraftIdsRef = useRef(new Set<string>());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  useEffect(
    () => () => {
      for (const draft of draftsRef.current) URL.revokeObjectURL(draft.url);
    },
    [],
  );

  // Single-shot mutation (unlike the multi-step file upload) — useActionMutation
  // fits: one call, one toast, one invalidation.
  const importFromUrl = useActionMutation({
    mutationFn: operations.importFromUrl.mutationOptions,
    success: "Image imported.",
    onSuccess: () => setUrl(""),
  });

  const uploadDraft = async (draft: UploadDraft) => {
    if (removedDraftIdsRef.current.has(draft.id)) return;
    if (inFlightDraftIdsRef.current.has(draft.id)) return;
    inFlightDraftIdsRef.current.add(draft.id);
    setDrafts((items) =>
      items.map((item) =>
        item.id === draft.id ? { ...item, state: "uploading" as const } : item,
      ),
    );
    try {
      const result = await uploadFile(draft.file, draft.uploadedImage);
      if (result.state === "complete") {
        if (removedDraftIdsRef.current.has(draft.id)) return;
        setDrafts((items) => {
          const completed = items.find((item) => item.id === draft.id);
          if (completed) URL.revokeObjectURL(completed.url);
          return items.filter((item) => item.id !== draft.id);
        });
        void invalidateOperationTags(queryClient, ripple.image);
        toast.success(`${result.image.filename} uploaded.`);
        return;
      }
      if (result.state === "in-flight") return;
      setDrafts((items) =>
        items.map((item) =>
          item.id === draft.id
            ? {
                ...item,
                state: "failed" as const,
                uploadedImage: result.uploadedImage,
              }
            : item,
        ),
      );
    } finally {
      inFlightDraftIdsRef.current.delete(draft.id);
    }
  };

  const handleFilesSelected = async (files: File[]) => {
    const newDrafts: UploadDraft[] = files.map((file, index) => ({
      id: `${file.name}-${Date.now()}-${index}`,
      file,
      url: URL.createObjectURL(file),
      filename: file.name,
      state: "uploading",
    }));
    setDrafts((items) => [...items, ...newDrafts]);
    for (const draft of newDrafts) await uploadDraft(draft);
  };

  const removeDraft = (id: string) => {
    removedDraftIdsRef.current.add(id);
    setViewingDraftIndex(null);
    setDrafts((items) => {
      const draft = items.find((item) => item.id === id);
      if (draft) URL.revokeObjectURL(draft.url);
      return items.filter((item) => item.id !== id);
    });
  };

  const handleImportUrl = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    importFromUrl.mutate({ url: trimmed });
  };

  const busy =
    isUploading ||
    importFromUrl.isPending ||
    drafts.some((draft) => draft.state === "uploading");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <Upload className="size-3.5" />
            Upload
          </Button>
        }
      />
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Upload images</DialogTitle>
          <DialogDescription>
            Add one or more image files, or import from a URL.
          </DialogDescription>
        </DialogHeader>
        <Stack gap="md">
          <Stack gap="xs">
            <Label>From your device</Label>
            <FileDropField
              accept="image/*"
              label="Choose images"
              description="JPEG, PNG, GIF, WebP, or HEIC"
              mode="compact"
              multiple
              onFilesAdded={(files) => void handleFilesSelected(files)}
              disabled={busy}
            />
            {drafts.length > 0 ? (
              <PhotoGrid
                images={drafts}
                className="mt-2"
                onSelect={(_draft, index) => setViewingDraftIndex(index)}
                renderOverlay={(draft) => (
                  <div className="absolute inset-x-1 bottom-1 z-20 flex items-center justify-between gap-1 rounded bg-background/90 p-1 text-xs">
                    <span>
                      {draft.state === "uploading"
                        ? "Uploading…"
                        : "Upload failed"}
                    </span>
                    <div className="flex gap-1">
                      {draft.state === "failed" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => void uploadDraft(draft)}
                          disabled={busy}
                        >
                          Retry
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="size-6"
                        aria-label={`Remove ${draft.filename}`}
                        onClick={() => removeDraft(draft.id)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
              />
            ) : null}
            <PhotoViewer
              images={drafts}
              index={viewingDraftIndex}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) setViewingDraftIndex(null);
              }}
              onIndexChange={setViewingDraftIndex}
            />
          </Stack>
          <Stack gap="xs">
            <Label htmlFor={urlInputId}>From a URL</Label>
            <Row gap="sm">
              <Input
                id={urlInputId}
                type="url"
                placeholder="https://example.com/photo.jpg"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleImportUrl();
                  }
                }}
                disabled={busy}
                className="flex-1"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={handleImportUrl}
                disabled={busy || !url.trim()}
              >
                <LinkIcon className="size-3.5" />
                Import
              </Button>
            </Row>
          </Stack>
        </Stack>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
