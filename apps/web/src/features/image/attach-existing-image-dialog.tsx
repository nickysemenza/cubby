import { galleryEntities } from "@cubby/schemas/entity-roster";
import {
  attachableImageEntity,
  attachmentRoleForEntity,
} from "@cubby/schemas/image";
import { getErrorMessage, parseShortcode } from "@cubby/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { entityLabel } from "~/entity/entities";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { buildSearchHitComboboxItem } from "~/entity/picker/combobox-builders";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { image as imageOperations } from "~/integrations/tanstack-query/domains/image";
import { search } from "~/integrations/tanstack-query/domains/search";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import type { ComboboxItem } from "~/ui/combobox/combobox-types";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { Overlay } from "~/ui/overlays/overlay";
import { Label } from "~/ui/primitives/label";

const PURPOSE_OPTIONS: readonly PickerOption[] = [
  { value: "item", label: "Item photo" },
  { value: "label", label: "Label or tag" },
];

export function AttachExistingImageDialog({
  image,
  onClose,
  findTargets = search.find,
}: {
  image: ImageWithEntity;
  onClose: () => void;
  /** The target search; a test injects an in-memory transport. */
  findTargets?: typeof search.find;
}) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ComboboxItem | null>(null);
  const [purpose, setPurpose] = useState<"item" | "label">("item");
  const queryClient = useQueryClient();
  const attachedIds = new Set(image.associations.map((item) => item.entityId));
  const targetSearch = useQuery({
    ...findTargets.queryOptions({
      query: query.trim() || "_",
      entityKinds: image.contentType.startsWith("image/")
        ? [...attachableImageEntity.options]
        : [...galleryEntities],
      limit: 10,
    }),
    enabled: query.trim().length > 0,
  });
  const targetItems = (targetSearch.data ?? [])
    .filter((hit) => !attachedIds.has(hit.id))
    .map((hit) => {
      const item = buildSearchHitComboboxItem(hit, hit.entityKind);
      // A mixed-entity roster names each row's kind.
      return { ...item, detail: item.detail ?? entityLabel(hit.entityKind) };
    });
  const attach = useMutation(
    imageOperations.attachExisting.mutationOptions({
      onSuccess: async (result) => {
        void invalidateOperationTags(queryClient, ripple.image);
        toast.success(
          result.reused ? "Image was already attached." : "Image attached.",
        );
        onClose();
      },
    }),
  );
  const targetId = target?.id ?? "";
  const targetKind = attachableImageEntity.safeParse(
    parseShortcode(targetId)?.type,
  );
  const role = targetKind.success
    ? attachmentRoleForEntity(targetKind.data)
    : undefined;
  const isProduct = targetKind.success && targetKind.data === "product";

  return (
    <Overlay
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Attach to record"
      description="Search a record by name or shortcode. Choosing a Vendor or Cookbook replaces its logo or cover."
      onCancel={onClose}
      error={attach.error ? getErrorMessage(attach.error) : null}
      primary={{
        label:
          role === "logo"
            ? "Replace logo"
            : role === "cover"
              ? "Replace cover"
              : "Attach",
        pending: attach.isPending,
        disabled: !target || !role,
        onClick: async () => {
          await attach.mutateAsync({
            imageId: image.id,
            targetId,
            role,
            purpose: isProduct ? purpose : undefined,
          });
        },
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="existing-image-target">Record</Label>
        <Picker
          inputId="existing-image-target"
          label="Record"
          placeholder="Search by name, GDE-3FX7, PRJ-…"
          items={targetItems}
          value={target}
          setValue={setTarget}
          onSearchChange={setQuery}
          isLoading={targetSearch.isFetching}
          clearable
        />
        {isProduct && (
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
      </div>
    </Overlay>
  );
}

type ImageWithEntity = DetailRecordOf<"image">;
