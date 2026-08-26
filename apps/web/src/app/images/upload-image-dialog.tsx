import { useQueryClient } from "@tanstack/react-query";
import { Link as LinkIcon, Upload } from "lucide-react";
import { useId, useState } from "react";
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
import { imageUpload } from "~/lib/image.functions";
import { invalidateQueryRoots, invalidatesFor } from "~/lib/query-keys";
import { useImageUpload } from "./use-image-upload";

/**
 * `/images` toolbar entry point: file picker (multiple) + URL import. Not
 * drag-drop — that fights row selection on the images table underneath.
 * PDFs are deliberately out of scope here (`ALLOWED_IMAGE_TYPES` excludes
 * them — image-only surfaces never accept PDFs, see packages/schemas/src/image.ts).
 */
export function UploadImageDialog() {
  const queryClient = useQueryClient();
  const urlInputId = useId();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const { uploadFiles, isUploading } = useImageUpload();

  // Single-shot mutation (unlike the multi-step file upload) — useActionMutation
  // fits: one call, one toast, one invalidation.
  const importFromUrl = useActionMutation({
    mutationFn: imageUpload.importFromUrl.mutationOptions,
    success: "Image imported.",
    invalidateKeys: invalidatesFor("image"),
    onSuccess: () => setUrl(""),
  });

  const handleFilesSelected = async (files: File[]) => {
    const uploaded = await uploadFiles(files);
    if (uploaded.length > 0) {
      invalidateQueryRoots(queryClient, invalidatesFor("image"));
      toast.success(
        `${uploaded.length} image${uploaded.length === 1 ? "" : "s"} uploaded.`,
      );
    }
  };

  const handleImportUrl = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    importFromUrl.mutate({ url: trimmed });
  };

  const busy = isUploading || importFromUrl.isPending;

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
