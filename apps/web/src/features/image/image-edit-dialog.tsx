import type { ImageWithEntity } from "@cubby/schemas/image";
import { useState } from "react";

import { useImageUpdateMutation } from "~/entity/hooks/use-update-mutation";
import { image as imageOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { Overlay } from "~/ui/overlays/overlay";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";

const SOURCE_OPTIONS: readonly PickerOption[] = [
  { value: "own", label: "Our photo" },
  { value: "catalog", label: "Catalog" },
  { value: "unknown", label: "Unknown" },
];

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
  const save = async () => {
    const next = filename.trim();
    if (!next) return;
    await update.mutateAsync({
      id: record.id,
      data: {
        filename: next,
        source,
        sourceName: sourceName.trim() || null,
        sourcePageUrl: sourcePageUrl.trim() || null,
        sourceAssetUrl: sourceAssetUrl.trim() || null,
      },
    });
    onClose();
  };
  return (
    <Overlay
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit image"
      onCancel={onClose}
      primary={{
        label: "Save changes",
        pending: update.isPending,
        onClick: save,
      }}
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
          <Picker
            mode="choose"
            className="w-full"
            inputId="image-source"
            label="Source"
            options={SOURCE_OPTIONS}
            value={source}
            onValueChange={(value) =>
              setSource(
                value === "own" || value === "catalog" ? value : "unknown",
              )
            }
          />
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
    </Overlay>
  );
}
