import { galleryEntities } from "@cubby/schemas/entity-manifest";
import type { ImageWithEntity } from "@cubby/schemas/image";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { DialogFooter } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ResponsiveDialog } from "~/components/ui/responsive-dialog";
import { image as imageOperations } from "~/entities/image.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { search } from "~/lib/search.functions";

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
      entityTypes: [...galleryEntities],
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
        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() =>
              void attach.mutateAsync({
                imageId: image.id,
                targetId: normalized,
                purpose: normalized.startsWith("PRD-") ? purpose : undefined,
              })
            }
            disabled={!normalized || duplicate || attach.isPending}
          >
            Attach
          </Button>
        </DialogFooter>
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
            <select
              className="h-9 w-full rounded-sm border border-input bg-background px-2 text-sm"
              id="existing-image-purpose"
              value={purpose}
              onChange={(event) =>
                setPurpose(event.target.value === "label" ? "label" : "item")
              }
            >
              <option value="item">Item photo</option>
              <option value="label">Label or tag</option>
            </select>
          </>
        )}
        {targetSearch.data && targetSearch.data.length > 0 && (
          <div className="divide-y divide-border overflow-hidden rounded-sm border border-border">
            {targetSearch.data
              .filter((result) => !attachedIds.has(result.id))
              .map((result) => (
                <button
                  className="flex w-full flex-col items-start px-2 py-1.5 text-left hover:bg-muted"
                  key={`${result.entityType}:${result.id}`}
                  type="button"
                  onClick={() => setTargetId(result.id)}
                >
                  <span className="font-medium">{result.title}</span>
                  <span className="text-2xs text-muted-foreground">
                    {result.id} · {result.entityType}
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
        {attach.error && (
          <p className="text-xs text-destructive">
            {attach.error instanceof Error
              ? attach.error.message
              : "The image could not be attached."}
          </p>
        )}
      </div>
    </ResponsiveDialog>
  );
}
