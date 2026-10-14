import { galleryEntities } from "@cubby/schemas/entity-manifest";
import type { ImageWithEntity } from "@cubby/schemas/image";
import { getErrorMessage } from "@cubby/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  image as imageOperations,
  search,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { DialogFormActions } from "~/ui/primitives/dialog-form-actions";
import { Input } from "~/ui/primitives/input";
import { Label } from "~/ui/primitives/label";
import { ResponsiveDialog } from "~/ui/primitives/responsive-dialog";

const PURPOSE_OPTIONS: readonly PickerOption[] = [
  { value: "item", label: "Item photo" },
  { value: "label", label: "Label or tag" },
];

export function AttachExistingImageDialog({
  image,
  onClose,
}: {
  image: ImageWithEntity;
  onClose: () => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [purpose, setPurpose] = useState<"item" | "label">("item");
  const queryClient = useQueryClient();
  const attachedIds = new Set(image.associations.map((item) => item.entityId));
  const targetSearch = useQuery({
    ...search.find.queryOptions({
      query: targetId.trim() || "_",
      entityKinds: [...galleryEntities],
      limit: 10,
    }),
    enabled: targetId.trim().length > 0,
  });
  const attach = useMutation(
    imageOperations.attachExisting.mutationOptions({
      onSuccess: async (result) => {
        await invalidateOperationTags(queryClient, ripple.image);
        toast.success(
          result.reused ? "Image was already attached." : "Image attached.",
        );
        onClose();
      },
    }),
  );
  const normalized = targetId.trim().toUpperCase();
  const duplicate = attachedIds.has(normalized);

  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Attach to record"
      description="Enter any live gallery record shortcode. Garden entries use GDE- codes."
      footer={
        <DialogFormActions
          onCancel={onClose}
          submitLabel="Attach"
          pending={attach.isPending}
          submitDisabled={!normalized || duplicate}
          error={attach.error ? getErrorMessage(attach.error) : null}
          onSubmit={() =>
            void attach.mutateAsync({
              imageId: image.id,
              targetId: normalized,
              purpose: normalized.startsWith("PRD-") ? purpose : undefined,
            })
          }
        />
      }
    >
      <div className="space-y-2">
        <Label htmlFor="existing-image-target">Record shortcode</Label>
        <Input
          id="existing-image-target"
          placeholder="GDE-3FX7, REC-… or PRJ-…"
          value={targetId}
          onChange={(event) => setTargetId(event.target.value)}
          aria-invalid={duplicate}
        />
        {normalized.startsWith("PRD-") && (
          <>
            <Label htmlFor="existing-image-purpose">Product image use</Label>
            <Picker
              mode="choose"
              label="Product image use"
              inputId="existing-image-purpose"
              options={PURPOSE_OPTIONS}
              value={purpose}
              onValueChange={(value) =>
                setPurpose(value === "label" ? "label" : "item")
              }
            />
          </>
        )}
        {targetSearch.data && targetSearch.data.length > 0 && (
          <div className="divide-y divide-border overflow-hidden rounded-sm border border-border">
            {targetSearch.data
              .filter((result) => !attachedIds.has(result.id))
              .map((result) => (
                <button
                  className="flex w-full flex-col items-start px-2 py-1.5 text-left hover:bg-muted"
                  key={`${result.entityKind}:${result.id}`}
                  type="button"
                  onClick={() => setTargetId(result.id)}
                >
                  <span className="font-medium">{result.title}</span>
                  <span className="text-2xs text-muted-foreground">
                    {result.entityKind}
                    {result.subtitle ? ` · ${result.subtitle}` : ""}
                  </span>
                </button>
              ))}
          </div>
        )}
        {duplicate && (
          <p className="text-xs text-destructive">
            This image is already attached to that record.
          </p>
        )}
      </div>
    </ResponsiveDialog>
  );
}
