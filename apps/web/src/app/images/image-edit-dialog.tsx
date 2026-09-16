import type { ImageWithEntity } from "@cubby/schemas/image";
import { useState } from "react";

import { useImageUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { Button } from "~/components/ui/button";
import { DialogFooter } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { image as imageOperations } from "~/entities/image.functions";

/**
 * Image has no kernel update contract, so its Edit action renames through
 * the image operation directly; the filename is the one editable field.
 */
export function ImageEditDialog({
  record,
  onClose,
}: {
  record: ImageWithEntity;
  onClose: () => void;
}) {
  const [filename, setFilename] = useState(record.filename);
  const update = useImageUpdateMutation({
    mutationFn: () => imageOperations.update.mutationOptions(),
  });
  const save = () => {
    const next = filename.trim();
    if (!next) return;
    void update
      .mutateAsync({ id: record.id, data: { filename: next } })
      .then(onClose);
  };
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit image"
      footer={
        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={update.isPending}>
            Save changes
          </Button>
        </DialogFooter>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="image-filename">Filename</Label>
        <Input
          id="image-filename"
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
        />
      </div>
    </ResponsiveDialog>
  );
}
