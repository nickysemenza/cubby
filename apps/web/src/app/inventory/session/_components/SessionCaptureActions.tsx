import type { DetectedItem } from "@cubby/schemas/ai";
import {
  type LocationId,
  type ProductId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type { AllowedImageType } from "@cubby/schemas/image";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Barcode,
  Camera,
  Check,
  ImagePlus,
  PackagePlus,
  Plus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DialogCompatibleCombobox } from "~/app/_components/combobox/combobox-dialog";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import {
  WithIngredientSearch,
  WithProductSearch,
} from "~/app/_components/combobox/with-search-hook";
import {
  getOptionalIngredientId,
  getProductId,
  requiredProductField,
} from "~/app/_components/form-fields";
import { ComboboxField } from "~/app/_components/form-utils";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { useUpcLookup } from "~/app/_components/inventory/hooks";
import {
  BARCODE_FORMATS,
  PersistentScanner,
} from "~/app/_components/inventory/persistent-scanner";
import { useProductSearch } from "~/app/_components/products/use-product-search";
import { useUpcAwareCreate } from "~/app/_components/products/use-upc-aware-create";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
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
import { getErrorMessage } from "~/lib/error-utils";
import {
  invalidateTRPCQueries,
  inventoryMutationInvalidateKeys,
  productMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { useTRPC } from "~/trpc/react";
import type { SessionLocation } from "../session-utils";
import { useSessionMutations } from "../useSessionMutations";

const manualAddSchema = z.object({
  product: requiredProductField,
  amount: z.object({
    value: z.number().positive(),
    unit: z.string().min(1),
  }),
});

type ManualAddValues = z.input<typeof manualAddSchema>;

export function SessionCaptureActions({
  location,
}: {
  location: SessionLocation;
}) {
  const api = useTRPC();
  const { invalidate } = useSessionMutations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scanner, setScanner] = useState<"barcode" | null>(null);
  // Dedup: the scanner stays open for a continuous sweep, so the same barcode
  // held in frame fires onScan repeatedly — ignore re-reads of the same code
  // within a short window so one item isn't added many times.
  const lastBarcodeRef = useRef<{ code: string; at: number } | null>(null);
  const [suggestions, setSuggestions] = useState<DetectedItem[]>([]);
  const [suggestionProductOverrides, setSuggestionProductOverrides] = useState<
    Record<number, ComboboxItem | null>
  >({});
  const [detectionCacheStatus, setDetectionCacheStatus] = useState<
    "hit" | "miss" | null
  >(null);
  // Photo-as-identity: snap an unlabeled object, then name it.
  const addPhotoInputRef = useRef<HTMLInputElement>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoName, setPhotoName] = useState("");

  // Scan-created product ingredient link: a brand-new UPC product lands with no
  // ingredient link (invisible to recipe costing), so after a scan *creates* one
  // we surface a non-blocking follow-up sheet to link an ingredient. The scan/
  // inventory flow already completed — this never blocks the continuous loop.
  const [pendingLinkProduct, setPendingLinkProduct] = useState<{
    id: ProductId;
    name: string;
  } | null>(null);
  const [linkIngredient, setLinkIngredient] = useState<ComboboxItem | null>(
    null,
  );

  // Distinct from the outer session invalidator: this one also refreshes the
  // product-lookup caches and, given a mutation result, polls its background
  // work (e.g. the AI description enqueued by attaching a photo) so the UI
  // self-heals once it drains.
  const invalidateCapture = (result?: unknown) =>
    invalidate({ includeProductLookup: true, result, watch: true });

  const uploadImage = useMutation(api.image.uploadImage.mutationOptions());
  const updateLocation = useMutation(
    api.location.update.mutationOptions({
      onSuccess: (data) => {
        invalidateCapture(data);
        toast.success("Photo attached and description updated.");
      },
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
  const detectItems = useMutation(
    api.ai.detectInventoryItems.mutationOptions({
      onSuccess: (data) => {
        setSuggestions(data.items);
        setDetectionCacheStatus(data.cache.status);
        setSuggestionProductOverrides(
          Object.fromEntries(
            data.items.map((item, index) => [
              index,
              item.matchedProduct
                ? { id: item.matchedProduct.id, name: item.matchedProduct.name }
                : null,
            ]),
          ),
        );
      },
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
  const approveDetectedItem = useMutation(
    api.ai.approveDetectedInventoryItem.mutationOptions({
      onSuccess: (data) => {
        invalidateCapture(data);
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
    api.inventory.create.mutationOptions({
      onSuccess: invalidateCapture,
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
  const quickCreateProduct = useMutation(
    api.product.quickCreate.mutationOptions(),
  );
  const updateProduct = useMutation(api.product.update.mutationOptions());
  const { lookupUpc, isPending: upcPending } = useUpcLookup();

  const handleFile = async (file: File) => {
    try {
      const init = await uploadImage.mutateAsync({
        filename: file.name,
        contentType: file.type as AllowedImageType,
        size: file.size,
        entityType: "LOCATION",
      });
      const put = await fetch(init.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error("Image upload failed");
      await updateLocation.mutateAsync({
        id: location.id,
        data: { pendingImageIds: [init.imageId] },
      });
    } catch (error) {
      toast.error(`Photo failed: ${getErrorMessage(error)}`);
    }
  };

  const removeSuggestion = (index: number) => {
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

  const addSuggestion = async (item: DetectedItem, index: number) => {
    const { matchedProduct: _matchedProduct, ...detectedItem } = item;
    const override = suggestionProductOverrides[index];
    const productId = override
      ? unsafeProductId(override.id)
      : (item.matchedProduct?.id ?? undefined);
    try {
      await approveDetectedItem.mutateAsync({
        locationId: location.id,
        item: detectedItem,
        productId,
      });
      removeSuggestion(index);
    } catch (error) {
      toast.error(`Could not add suggestion: ${getErrorMessage(error)}`);
    }
  };

  const handleBarcode = async (barcode: string) => {
    const product = await lookupUpc(barcode);
    if (!product) return;
    const inventory = await createInventory.mutateAsync({
      productId: product.id,
      locationId: location.id,
      amount: { value: 1, unit: "each" },
    });
    toast.success(
      savedWithBackgroundWork(inventory.sideEffects, `Added ${product.name}`),
    );
    // A brand-new product has no ingredient link yet, so it won't cost in any
    // recipe until one is added. Surface a non-blocking follow-up sheet — the
    // add above already succeeded, so this never stalls the continuous scan loop.
    if (product.created) {
      setLinkIngredient(null);
      setPendingLinkProduct({
        id: product.id,
        name: product.name,
      });
    }
  };

  const submitIngredientLink = async () => {
    const target = pendingLinkProduct;
    const ingredientId = getOptionalIngredientId(linkIngredient);
    if (!target || !ingredientId) return;
    try {
      await updateProduct.mutateAsync({
        id: target.id,
        data: { ingredientId },
      });
      toast.success(`Linked ${target.name} to ${linkIngredient?.name}`);
      setPendingLinkProduct(null);
      setLinkIngredient(null);
    } catch (error) {
      toast.error(`Link failed: ${getErrorMessage(error)}`);
    }
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
      const init = await uploadImage.mutateAsync({
        filename: file.name,
        contentType: file.type as AllowedImageType,
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
        amount: { value: 1, unit: "each" },
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
    <Card className="overflow-visible">
      <CardContent className="p-4 lg:p-6">
        <Stack gap="sm">
          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_18rem] 2xl:items-start">
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
            <ManualAdd locationId={location.id} />
            <div className="grid grid-cols-3 gap-2 2xl:grid-cols-1">
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                onClick={() => fileInputRef.current?.click()}
              >
                <Camera className="h-4 w-4" />
                Photo
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                onClick={() => setScanner("barcode")}
              >
                <Barcode className="h-4 w-4" />
                Barcode
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                onClick={() => detectItems.mutate({ locationId: location.id })}
                disabled={detectItems.isPending || location.imageCount === 0}
              >
                {detectItems.isPending ? <Spinner /> : <PackagePlus />}
                Detect
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                onClick={() => addPhotoInputRef.current?.click()}
                title="Add an unlabeled item from a photo"
              >
                <ImagePlus className="h-4 w-4" />
                Photo item
              </Button>
            </div>
          </div>
          {suggestions.length > 0 && (
            <Stack gap="sm">
              <Description>
                AI suggestions
                {detectionCacheStatus ? ` · cache ${detectionCacheStatus}` : ""}
              </Description>
              {suggestions.map((item, index) => (
                <Row
                  key={`${item.name}-${index}`}
                  align="start"
                  gap="sm"
                  wrap
                  className="border border-[var(--border)] p-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-sm">
                      {item.name}
                    </div>
                    <Description size="xs">
                      {item.estimatedQuantity} {item.unit} · {item.confidence}
                      {item.category ? ` · ${item.category}` : ""}
                      {item.isMisc ? " · misc" : ""}
                    </Description>
                    <Description size="xs">{item.evidence}</Description>
                  </div>
                  <div className="min-w-48 flex-1">
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
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addSuggestion(item, index)}
                    disabled={approveDetectedItem.isPending}
                  >
                    <Check className="h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeSuggestion(index)}
                  >
                    <X className="h-4 w-4" />
                    Reject
                  </Button>
                </Row>
              ))}
            </Stack>
          )}
        </Stack>
      </CardContent>
      <Sheet
        open={scanner === "barcode"}
        onOpenChange={(open) => {
          if (!open) {
            setScanner(null);
            lastBarcodeRef.current = null;
          }
        }}
      >
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>Scan barcode</SheetTitle>
            <SheetDescription>
              Adds one each to {location.name}.
            </SheetDescription>
          </SheetHeader>
          <PersistentScanner
            onScan={(barcode) => {
              const now = Date.now();
              const last = lastBarcodeRef.current;
              if (last && last.code === barcode && now - last.at < 2500) return;
              lastBarcodeRef.current = { code: barcode, at: now };
              void handleBarcode(barcode);
            }}
            enabled={!upcPending && scanner === "barcode"}
            formatsToSupport={BARCODE_FORMATS}
            scanHintText="Point at barcode"
          />
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
              // biome-ignore lint/a11y/noAutofocus: focus the only field in a just-opened sheet
              autoFocus
              disabled={photoIdentityPending}
            />
            <Button
              type="submit"
              className="shrink-0"
              disabled={!photoName.trim() || photoIdentityPending}
            >
              {photoIdentityPending ? (
                <Spinner />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Add
            </Button>
          </form>
        </SheetContent>
      </Sheet>

      {/* Scan-created product → optional ingredient link (non-blocking). */}
      <Sheet
        open={pendingLinkProduct !== null}
        onOpenChange={(open) => {
          if (!open && !updateProduct.isPending) {
            setPendingLinkProduct(null);
            setLinkIngredient(null);
          }
        }}
      >
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>New product added — link an ingredient?</SheetTitle>
            <SheetDescription>
              {pendingLinkProduct?.name} is new. Linking an ingredient lets it
              count toward recipe costing. Skip to keep scanning.
            </SheetDescription>
          </SheetHeader>
          <WithIngredientSearch>
            {({
              items,
              onSearchChange,
              isLoading,
              onCreateNew,
              onOpenChange,
            }) => (
              <Row gap="sm" align="center">
                <div className="min-w-0 flex-1">
                  <DialogCompatibleCombobox
                    label="ingredient"
                    items={items}
                    onSearchChange={onSearchChange}
                    isLoading={isLoading}
                    value={linkIngredient}
                    setValue={setLinkIngredient}
                    onCreateNew={onCreateNew}
                    onOpenChange={onOpenChange}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="shrink-0"
                  disabled={updateProduct.isPending}
                  onClick={() => {
                    setPendingLinkProduct(null);
                    setLinkIngredient(null);
                  }}
                >
                  Skip
                </Button>
                <Button
                  type="button"
                  className="shrink-0"
                  disabled={!linkIngredient || updateProduct.isPending}
                  onClick={() => void submitIngredientLink()}
                >
                  {updateProduct.isPending ? (
                    <Spinner />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Link
                </Button>
              </Row>
            )}
          </WithIngredientSearch>
        </SheetContent>
      </Sheet>
    </Card>
  );
}

function SuggestionProductOverride({
  item,
  value,
  onChange,
}: {
  item: DetectedItem;
  value: ComboboxItem | null;
  onChange: (value: ComboboxItem | null) => void;
}) {
  const { items, onSearchChange, isLoading } = useProductSearch();

  useEffect(() => {
    onSearchChange(item.name);
  }, [item.name, onSearchChange]);

  return (
    <DialogCompatibleCombobox
      label="product"
      items={items}
      onSearchChange={onSearchChange}
      isLoading={isLoading}
      value={value}
      setValue={onChange}
    />
  );
}

function ManualAdd({ locationId }: { locationId: LocationId }) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const form = useForm<ManualAddValues>({
    resolver: zodResolver(manualAddSchema),
    defaultValues: {
      product: undefined,
      amount: { value: 1, unit: "each" },
    },
  });
  const createInventory = useActionMutation({
    mutationFn: api.inventory.create.mutationOptions,
    success: (data) => savedWithBackgroundWork(data.sideEffects, "Added item"),
    invalidateKeys: inventoryMutationInvalidateKeys,
    onSuccess: () => {
      form.reset({ product: undefined, amount: { value: 1, unit: "each" } });
    },
  });

  // Name-only quick-create for unbarcoded garage items: skip the full ProductForm
  // (manufacturer required) and use the quickCreate endpoint, which defaults the
  // manufacturer. The created product is selected straight into the picker.
  const quickCreateProduct = useMutation(
    api.product.quickCreate.mutationOptions({
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
  const quickCreateMutateRef = useRef(quickCreateProduct.mutateAsync);
  quickCreateMutateRef.current = quickCreateProduct.mutateAsync;
  const handleQuickCreate = useCallback(
    async (name: string): Promise<ComboboxItem> => {
      const created = await quickCreateMutateRef.current({ name });
      invalidateTRPCQueries(queryClient, productMutationInvalidateKeys);
      return {
        id: created.id,
        name: `${created.name} (${created.manufacturer})`,
      };
    },
    [queryClient],
  );
  // Paste a UPC into "Manual add" to create from the UPC cascade; a plain name
  // still name-only quick-creates.
  const onCreateNew = useUpcAwareCreate(handleQuickCreate);

  return (
    <Stack
      as="form"
      gap="sm"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit((values) =>
          createInventory.mutate({
            productId: getProductId(values.product),
            locationId,
            amount: values.amount,
          }),
        )(event);
      }}
      className="border border-[var(--border)] p-3" /* tight: dense manual add panel */
    >
      <div className="min-w-0">
        <WithProductSearch>
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
            />
          )}
        </WithProductSearch>
      </div>
      <div className="grid min-w-0 items-end gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
        <AmountFieldGroup
          form={form}
          valuePath="amount.value"
          unitPath="amount.unit"
          compact
        />
        <Button
          type="submit"
          className="min-h-10 shrink-0 self-end px-3 sm:min-h-12 sm:px-4" /* tight: mobile manual add button */
          disabled={createInventory.isPending}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Add item</span>
          <span className="sm:hidden">Add</span>
        </Button>
      </div>
    </Stack>
  );
}
