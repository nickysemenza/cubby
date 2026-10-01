import type { ImageWithEntity } from "@cubby/schemas/image";
import { useState } from "react";

import { useImageUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { DialogFormActions } from "~/components/ui/dialog-form-actions";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { image as imageOperations } from "~/integrations/tanstack-query/generated/catalog.gen";

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
  const [source, setSource] = useState(record.source ?? "unknown");
  const [sourceName, setSourceName] = useState(record.sourceName ?? "");
  const [sourcePageUrl, setSourcePageUrl] = useState(
    record.sourcePageUrl ?? "",
  );
  const [sourceAssetUrl, setSourceAssetUrl] = useState(
    record.sourceAssetUrl ?? "",
  );
  const update = useImageUpdateMutation({
    mutationFn: () => imageOperations.update.mutationOptions(),
  });
  const save = () => {
    const next = filename.trim();
    if (!next) return;
    void update
      .mutateAsync({
        id: record.id,
        data: {
          filename: next,
          source,
          sourceName: sourceName.trim() || null,
          sourcePageUrl: sourcePageUrl.trim() || null,
          sourceAssetUrl: sourceAssetUrl.trim() || null,
        },
      })
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
        <DialogFormActions
          onCancel={onClose}
          submitLabel="Save changes"
          pending={update.isPending}
          onSubmit={save}
        />
      }
    >
      <div className="space-y-3">
        <Label htmlFor="image-filename">Filename</Label>
        <Input
          id="image-filename"
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
        />
        <div className="space-y-2">
          <Label htmlFor="image-source">Source</Label>
          <NativeSelect
            className="w-full"
            id="image-source"
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
            <option value="catalog">Catalog</option>
            <option value="unknown">Unknown</option>
          </NativeSelect>
        </div>
        <div className="space-y-2">
          <Label htmlFor="image-source-name">Source name</Label>
          <Input
            id="image-source-name"
            value={sourceName}
            onChange={(event) => setSourceName(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="image-source-page">Source page URL</Label>
          <Input
            id="image-source-page"
            type="url"
            value={sourcePageUrl}
            onChange={(event) => setSourcePageUrl(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="image-source-asset">Source asset URL</Label>
          <Input
            id="image-source-asset"
            type="url"
            value={sourceAssetUrl}
            onChange={(event) => setSourceAssetUrl(event.target.value)}
          />
        </div>
      </div>
    </ResponsiveDialog>
  );
}
