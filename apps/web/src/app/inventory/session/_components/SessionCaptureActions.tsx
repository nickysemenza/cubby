import type { DetectedItem } from "@cubby/schemas/ai";
import type {
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { ALLOWED_IMAGE_TYPES } from "@cubby/schemas/image";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { Barcode, Camera, ImagePlus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import { AiProvenance } from "~/app/_components/ai/ai-proposal-card";
import { AiProposalList } from "~/app/_components/ai/ai-proposal-list";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import {
  getProductShortcode,
  requiredProductField,
} from "~/app/_components/form-fields";
import { ComboboxField } from "~/app/_components/form-utils";
import { useEntityActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  AmountFieldGroup,
  DEFAULT_AMOUNT_UNIT,
} from "~/app/_components/inventory/amount-field-group";
import { LocationSweep } from "~/app/_components/inventory/location-sweep/LocationSweepSheet";
import { useLocationPhotoCapture } from "~/app/_components/locations/use-location-photo-capture";
import { useUpcAwareCreate } from "~/app/_components/products/use-upc-aware-create";
import { product } from "~/app/products/product.functions";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { focusOnMount } from "~/hooks/focus-on-mount";
import { ai } from "~/lib/ai.functions";
import { getErrorMessage } from "~/lib/error-utils";
import { imageUpload } from "~/lib/image.functions";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

import type { SessionLocation } from "../session-utils";
import { useSessionMutations } from "../useSessionMutations";

/**
 * A detected item's identity for the proposal list. The detection has no id of
 * its own — it is model output, not a record — so the row is keyed by the
 * fields that distinguish two sightings on the same shelf.
 */
const suggestionKey = (item: DetectedItem) =>
  `${item.name}|${item.manufacturer}|${item.estimatedQuantity}|${item.unit}|${item.evidence}`;

const manualAddSchema = z.object({
  product: requiredProductField,
  amount: z.object({
    value: z.number().positive(),
    unit: z.string().min(1),
  }),
});

type ManualAddValues = z.input<typeof manualAddSchema>;

const imageContentTypeSchema = z.enum(ALLOWED_IMAGE_TYPES);
const inventoryCreateMutationOptions = entityMutationOptionsFactory(
  "inventory",
  "create",
);

export function SessionCaptureActions({
  location,
}: {
  location: SessionLocation;
}) {
  const { invalidate } = useSessionMutations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scanner, setScanner] = useState<"barcode" | null>(null);
  // Continuous multi-add feedback: a running tally plus the last few scans, so a
  // grocery haul can be ripped through without watching the list below. Both are
  // component-local and reset when the scanner sheet closes.
  const [suggestions, setSuggestions] = useState<DetectedItem[]>([]);
  const [suggestionProductOverrides, setSuggestionProductOverrides] = useState<
    Record<number, ComboboxItem<ProductShortcode> | null>
  >({});
  const [detection, setDetection] = useState<{
    model: string;
    cacheStatus: "hit" | "miss";
    analyzedAt: Date;
  } | null>(null);
  // Photo-as-identity: snap an unlabeled object, then name it.
  const addPhotoInputRef = useRef<HTMLInputElement>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoName, setPhotoName] = useState("");

  // Scan follow-up: a brand-new UPC product lands with no ingredient link
  // (invisible to recipe costing) and often with a placeholder name and no
  // price, so after the add we surface a non-blocking sheet to fix those while
  // the item is still in hand. The scan/inventory flow already completed — this
  // never blocks the continuous loop.

  // Given a mutation result this also polls its background work (e.g. the AI
  // description enqueued by attaching a photo) so the UI self-heals once it
  // drains.
  const invalidateCapture = () => invalidate({ watch: true });

  const uploadImage = useMutation(imageUpload.uploadImage.mutationOptions());
  // Location photos go through the shared capture hook rather than a local
  // upload→attach pair: it also invalidates `location.makeTree`, which this
  // workbench reads for every stop's `imageCount`. The old local path only
  // invalidated `location.list`, so a photo taken here left the sidebar's
  // photo count stale until the pass was remounted.
  const { capture: captureLocationPhoto } = useLocationPhotoCapture();
  const detectItems = useMutation(
    ai.detectInventoryItems.mutationOptions({
      onSuccess: (data) => {
        setSuggestions(data.items);
        setDetection({
          model: data.cache.model,
          cacheStatus: data.cache.status,
          analyzedAt: data.analyzedAt,
        });
        setSuggestionProductOverrides(
          Object.fromEntries(
            data.items.map((item, index) => [
              index,
              item.matchedProduct
                ? {
                    id: item.matchedProduct.id,
                    name: item.matchedProduct.name,
                  }
                : null,
            ]),
          ),
        );
      },
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
  const approveDetectedItem = useMutation(
    ai.approveDetectedInventoryItem.mutationOptions({
      onSuccess: (data) => {
        invalidate({ watch: true });
        toast.success(
          savedWithBackgroundWork(
            data.sideEffects,
            `${data.createdProduct ? "Created and added" : "Added"} ${data.productName}`,
          ),
        );
      },
    }),
  );
  const createInventory = useMutation(
    entityMutationOptionsFactory(
      "inventory",
      "create",
    )({
      onSuccess: () => invalidate({ watch: true }),
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
  const quickCreateProduct = useMutation(product.quickCreate.mutationOptions());
  const updateProduct = useMutation(
    entityMutationOptionsFactory("product", "update")(),
  );
  const handleFile = async (file: File) => {
    try {
      await captureLocationPhoto(location.id, file);
      invalidateCapture();
      toast.success("Photo attached and description updated.");
    } catch (error) {
      toast.error(`Photo failed: ${getErrorMessage(error)}`);
    }
  };

  const indexOfSuggestion = (id: string) =>
    suggestions.findIndex((item) => suggestionKey(item) === id);

  const removeSuggestion = (index: number) => {
    if (index < 0) return;
    setSuggestions((prev) => prev.filter((_, i) => i !== index));
    setSuggestionProductOverrides((prev) =>
      Object.fromEntries(
        Object.entries(prev).flatMap(([key, value]) => {
          const oldIndex = Number(key);
          if (oldIndex === index) return [];
          return [[oldIndex > index ? oldIndex - 1 : oldIndex, value]];
        }),
      ),
    );
  };

  // Rejects on failure rather than swallowing: `AiProposalList` removes the
  // row the moment it is approved and puts it back if the write throws, and it
  // can only do that if the failure reaches it.
  const addSuggestion = async (id: string) => {
    const index = indexOfSuggestion(id);
    const item = suggestions[index];
    if (!item) return;
    const { matchedProduct: _matchedProduct, ...detectedItem } = item;
    const override = suggestionProductOverrides[index];
    const productId = override?.id ?? item.matchedProduct?.id;
    try {
      await approveDetectedItem.mutateAsync({
        locationId: location.id,
        item: detectedItem,
        productId,
      });
    } catch (error) {
      toast.error(`Could not add suggestion: ${getErrorMessage(error)}`);
      throw error;
    }
    removeSuggestion(index);
  };

  // Photo-as-identity: add an unlabeled object from a photo + a short name as a
  // lightweight `misc:` product (no schema change — reuses the misc convention):
  // upload the image → quickCreate the product → attach the image → add one each.
  const photoIdentityPending =
    uploadImage.isPending ||
    quickCreateProduct.isPending ||
    updateProduct.isPending ||
    createInventory.isPending;

  const submitPhotoIdentity = async () => {
    const file = pendingPhoto;
    const name = photoName.trim();
    if (!file || !name) return;
    try {
      const contentType = imageContentTypeSchema.safeParse(file.type);
      if (!contentType.success) {
        toast.error(`Unsupported image type: ${file.type}`);
        return;
      }
      const init = await uploadImage.mutateAsync({
        filename: file.name,
        contentType: contentType.data,
        size: file.size,
        entityType: "PRODUCT",
      });
      const put = await fetch(init.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error("Image upload failed");
      const product = await quickCreateProduct.mutateAsync({
        name: `misc: ${name}`,
      });
      await updateProduct.mutateAsync({
        id: product.id,
        data: { pendingImageIds: [init.imageId] },
      });
      const created = await createInventory.mutateAsync({
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
      });
      toast.success(
        savedWithBackgroundWork(created.sideEffects, `Added ${name}`),
      );
      setPendingPhoto(null);
      setPhotoName("");
    } catch (error) {
      toast.error(`Add failed: ${getErrorMessage(error)}`);
    }
  };

  return (
    <>
      <Stack gap="sm">
        <Description size="xs">
          Scan, search, or photograph a new item.
        </Description>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFile(file);
            event.target.value = "";
          }}
        />
        <input
          ref={addPhotoInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              setPendingPhoto(file);
              setPhotoName("");
            }
            event.target.value = "";
          }}
        />
        <Stack gap="sm">
          <Row align="end" gap="sm" wrap className="min-w-0">
            <ManualAdd locationId={location.id} />
            {/* No `shrink-0`: it pinned this row to its max-content width, so
                the four capture buttons ran off a phone's right edge instead
                of wrapping. */}
            <Row gap="sm" wrap>
              <Button
                type="button"
                variant="outline"
                className="min-h-12 md:min-h-10"
                onClick={() => fileInputRef.current?.click()}
              >
                <Camera className="size-4" />
                Photo
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-12 md:min-h-10"
                onClick={() => setScanner("barcode")}
              >
                <Barcode className="size-4" />
                Barcode
              </Button>
              <VerbButton
                verb="detect"
                size="default"
                pending={detectItems.isPending}
                disabledReason={
                  location.imageCount === 0
                    ? "Photograph this location first"
                    : undefined
                }
                className="min-h-12 md:min-h-10"
                onClick={() => detectItems.mutate({ locationId: location.id })}
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-12 md:min-h-10"
                onClick={() => addPhotoInputRef.current?.click()}
                title="Add an unlabeled item from a photo"
              >
                <ImagePlus className="size-4" />
                Photo item
              </Button>
            </Row>
          </Row>
          {/* Visible, not only the button's `title`: this sheet is opened on a
              phone, where no tooltip can ever open. */}
          {location.imageCount === 0 && (
            <Description size="xs">
              Photograph this location to detect what is in it.
            </Description>
          )}
          {suggestions.length > 0 && (
            <AiProposalList
              heading="Detected items"
              provenance={
                detection ? (
                  <AiProvenance
                    model={detection.model}
                    analyzedAt={detection.analyzedAt}
                    cacheStatus={detection.cacheStatus}
                  />
                ) : undefined
              }
              rows={suggestions.map((item, index) => ({
                id: suggestionKey(item),
                title: item.name,
                meta: [
                  `${item.estimatedQuantity} ${item.unit}`,
                  item.matchedProduct?.category?.name ?? null,
                  item.isMisc ? "misc" : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                confidence: item.confidence,
                reasoning: item.evidence,
                aside: (
                  <SuggestionProductOverride
                    item={item}
                    value={suggestionProductOverrides[index] ?? null}
                    onChange={(value) =>
                      setSuggestionProductOverrides((prev) => ({
                        ...prev,
                        [index]: value,
                      }))
                    }
                  />
                ),
              }))}
              pending={approveDetectedItem.isPending}
              onAccept={(id) => addSuggestion(id)}
              onReject={(id) => removeSuggestion(indexOfSuggestion(id))}
            />
          )}
        </Stack>
      </Stack>
      <Sheet
        open={scanner === "barcode"}
        onOpenChange={(open) => {
          if (!open) setScanner(null);
        }}
      >
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>Sweep {location.name}</SheetTitle>
            <SheetDescription>
              New items are stocked here, things already here are confirmed, and
              anything living elsewhere collects for one decision at the end.
            </SheetDescription>
          </SheetHeader>
          {/*
            The same sweep the location page mounts. The recount owns the
            surrounding pass; the sweep owns what one scan means.
          */}
          {scanner === "barcode" && (
            <LocationSweep
              locationId={location.id}
              locationName={location.name}
              hasItems={(location.location.directItemCount ?? 0) > 0}
              onSettled={() => invalidate({ watch: true })}
            />
          )}
        </SheetContent>
      </Sheet>
      <Sheet
        open={pendingPhoto !== null}
        onOpenChange={(open) => {
          if (!open && !photoIdentityPending) {
            setPendingPhoto(null);
            setPhotoName("");
          }
        }}
      >
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>Name this item</SheetTitle>
            <SheetDescription>
              Adds one each to {location.name} as a misc item with this photo.
            </SheetDescription>
          </SheetHeader>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPhotoIdentity();
            }}
          >
            <Input
              value={photoName}
              onChange={(event) => setPhotoName(event.target.value)}
              placeholder="e.g. blue tarp clamp"
              ref={focusOnMount}
              disabled={photoIdentityPending}
            />
            <Button
              type="submit"
              className="shrink-0"
              disabled={!photoName.trim() || photoIdentityPending}
            >
              {photoIdentityPending ? <Spinner /> : <Plus className="size-4" />}
              Add
            </Button>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}

function SuggestionProductOverride({
  item,
  value,
  onChange,
}: {
  item: DetectedItem;
  value: ComboboxItem<ProductShortcode> | null;
  onChange: (value: ComboboxItem<ProductShortcode> | null) => void;
}) {
  return (
    <WithEntitySearch entity="product" intent="stock">
      {({ items, onSearchChange, isLoading, onOpenChange }) => (
        <SuggestionProductCombobox
          itemName={item.name}
          items={items}
          onSearchChange={onSearchChange}
          isLoading={isLoading}
          onOpenChange={onOpenChange}
          value={value}
          onChange={onChange}
        />
      )}
    </WithEntitySearch>
  );
}

function SuggestionProductCombobox({
  itemName,
  items,
  onSearchChange,
  isLoading,
  onOpenChange,
  value,
  onChange,
}: {
  itemName: string;
  items: ComboboxItem<ProductShortcode>[];
  onSearchChange: (query: string) => void;
  isLoading: boolean;
  onOpenChange: (open: boolean) => void;
  value: ComboboxItem<ProductShortcode> | null;
  onChange: (value: ComboboxItem<ProductShortcode> | null) => void;
}) {
  useEffect(() => {
    onSearchChange(itemName);
  }, [itemName, onSearchChange]);

  return (
    <EntityPicker
      entity="product"
      label="product"
      items={items}
      onSearchChange={onSearchChange}
      isLoading={isLoading}
      onOpenChange={onOpenChange}
      value={value}
      setValue={onChange}
    />
  );
}

function ManualAdd({ locationId }: { locationId: LocationShortcode }) {
  const form = useForm<ManualAddValues>({
    resolver: zodResolver(manualAddSchema),
    defaultValues: {
      product: undefined,
      amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
    },
  });
  const createInventory = useEntityActionMutation({
    entity: "inventory",
    operation: "create",
    mutationFn: inventoryCreateMutationOptions,
    success: (data) => savedWithBackgroundWork(data.sideEffects, "Added item"),
    onSuccess: () => {
      form.reset({
        product: undefined,
        amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
      });
    },
  });

  // Name-only quick-create for unbarcoded garage items: skip the generic
  // create dialog (manufacturer required) and use the quickCreate endpoint,
  // which defaults the manufacturer. The created product is selected
  // straight into the picker.
  const quickCreateProduct = useMutation(
    product.quickCreate.mutationOptions({
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
  const quickCreateMutateRef = useRef(quickCreateProduct.mutateAsync);
  quickCreateMutateRef.current = quickCreateProduct.mutateAsync;
  const handleQuickCreate = useCallback(
    async (name: string): Promise<ComboboxItem<ProductShortcode>> => {
      const created = await quickCreateMutateRef.current({ name });
      return {
        id: created.id,
        name: `${created.name} (${created.manufacturer})`,
      };
    },
    [],
  );
  // Paste a UPC into "Manual add" to create from the UPC cascade; a plain name
  // still name-only quick-creates.
  const onCreateNew = useUpcAwareCreate(handleQuickCreate);

  return (
    <Row
      as="form"
      align="end"
      gap="sm"
      wrap
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit((values) =>
          createInventory.mutate({
            productId: getProductShortcode(values.product),
            locationId,
            amount: values.amount,
          }),
        )(event);
      }}
      className="min-w-0 flex-1"
    >
      <div className="min-w-56 flex-1">
        <WithEntitySearch entity="product" intent="stock">
          {({ items, onSearchChange, isLoading, onOpenChange }) => (
            <ComboboxField
              form={form}
              name="product"
              label="Manual add"
              items={items}
              onSearchChange={onSearchChange}
              isLoading={isLoading}
              onCreateNew={onCreateNew}
              onOpenChange={onOpenChange}
              entity="product"
            />
          )}
        </WithEntitySearch>
      </div>
      <div className="w-44 shrink-0">
        <AmountFieldGroup
          form={form}
          valuePath="amount.value"
          unitPath="amount.unit"
          compact
        />
      </div>
      <Button
        type="submit"
        className="min-h-12 shrink-0 px-4 md:min-h-10" /* tight: mobile touch target */
        disabled={createInventory.isPending}
      >
        <Plus className="size-4" />
        <span className="hidden sm:inline">Add item</span>
        <span className="sm:hidden">Add</span>
      </Button>
    </Row>
  );
}
