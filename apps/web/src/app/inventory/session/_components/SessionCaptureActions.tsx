import type { DetectedItem } from "@cubby/schemas/ai";
import type {
  LocationShortcode,
  ProductShortcode,
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
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import {
  WithIngredientSearch,
  WithProductSearch,
} from "~/app/_components/combobox/with-search-hook";
import {
  getOptionalIngredientId,
  getProductShortcode,
  requiredProductField,
} from "~/app/_components/form-fields";
import { ComboboxField } from "~/app/_components/form-utils";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import {
  AmountFieldGroup,
  DEFAULT_AMOUNT_UNIT,
} from "~/app/_components/inventory/amount-field-group";
import { useUpcLookup } from "~/app/_components/inventory/hooks";
import {
  BARCODE_FORMATS,
  PersistentScanner,
  type ScanFeedbackEntry,
} from "~/app/_components/inventory/persistent-scanner";
import { useLocationPhotoCapture } from "~/app/_components/locations/use-location-photo-capture";
import { useUpcAwareCreate } from "~/app/_components/products/use-upc-aware-create";
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
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import {
  invalidateTRPCQueries,
  inventoryMutationInvalidateKeys,
  productMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
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

/** How many recently-scanned chips the viewfinder shows (newest first). */
const RECENT_SCAN_LIMIT = 5;

/**
 * `Product 012345678905` — the placeholder name the UPC cascade falls back to
 * when neither USDA nor the UPC worker knows the code (see
 * product-orchestration.service). A scan that lands one of these (or an
 * unspecified manufacturer) is worth a quick rename while the item is in hand.
 */
const PLACEHOLDER_PRODUCT_NAME = /^Product \d+$/;

/**
 * A just-scanned product that could use a moment of curation: a name, a price,
 * or an ingredient link. Never blocks the scan loop — the item is already added.
 */
interface ScanFollowUp {
  id: ProductShortcode;
  name: string;
  /** Placeholder name or unspecified manufacturer. */
  needsName: boolean;
  /** No price ⇒ no cost basis for recipe costing. */
  needsPrice: boolean;
}

export function SessionCaptureActions({
  location,
}: {
  location: SessionLocation;
}) {
  const api = useTRPC();
  const { invalidate } = useSessionMutations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scanner, setScanner] = useState<"barcode" | null>(null);
  // Continuous multi-add feedback: a running tally plus the last few scans, so a
  // grocery haul can be ripped through without watching the list below. Both are
  // component-local and reset when the scanner sheet closes.
  const [scanTally, setScanTally] = useState(0);
  const [recentScans, setRecentScans] = useState<ScanFeedbackEntry[]>([]);
  const [suggestions, setSuggestions] = useState<DetectedItem[]>([]);
  const [suggestionProductOverrides, setSuggestionProductOverrides] = useState<
    Record<number, ComboboxItem<ProductShortcode> | null>
  >({});
  const [detectionCacheStatus, setDetectionCacheStatus] = useState<
    "hit" | "miss" | null
  >(null);
  // Photo-as-identity: snap an unlabeled object, then name it.
  const addPhotoInputRef = useRef<HTMLInputElement>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoName, setPhotoName] = useState("");

  // Scan follow-up: a brand-new UPC product lands with no ingredient link
  // (invisible to recipe costing) and often with a placeholder name and no
  // price, so after the add we surface a non-blocking sheet to fix those while
  // the item is still in hand. The scan/inventory flow already completed — this
  // never blocks the continuous loop.
  const [scanFollowUp, setScanFollowUp] = useState<ScanFollowUp | null>(null);
  const [followUpName, setFollowUpName] = useState("");
  const [followUpPrice, setFollowUpPrice] = useState("");
  const [linkIngredient, setLinkIngredient] = useState<ComboboxItem | null>(
    null,
  );

  // Distinct from the outer session invalidator: this one also refreshes the
  // product-lookup caches and, given a mutation result, polls its background
  // work (e.g. the AI description enqueued by attaching a photo) so the UI
  // self-heals once it drains.
  const invalidateCapture = (result?: unknown) =>
    invalidate({ includeProductLookup: true, result, watch: true });

  const closeScanFollowUp = () => {
    setScanFollowUp(null);
    setFollowUpName("");
    setFollowUpPrice("");
    setLinkIngredient(null);
  };

  const uploadImage = useMutation(api.image.uploadImage.mutationOptions());
  // Location photos go through the shared capture hook rather than a local
  // upload→attach pair: it also invalidates `location.makeTree`, which this
  // workbench reads for every stop's `imageCount`. The old local path only
  // invalidated `location.list`, so a photo taken here left the sidebar's
  // photo count stale until the pass was remounted.
  const { capture: captureLocationPhoto } = useLocationPhotoCapture();
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
  const saveScanFollowUp = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    success: "Product details saved",
    invalidateKeys: productMutationInvalidateKeys,
    onSuccess: (data) => {
      invalidateCapture(data);
      closeScanFollowUp();
    },
  });
  const { lookupUpc } = useUpcLookup();

  const handleFile = async (file: File) => {
    try {
      await captureLocationPhoto(location.id, file);
      invalidateCapture();
      toast.success("Photo attached and description updated.");
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
    const productId = override?.id ?? item.matchedProduct?.id;
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
    // The chip goes up immediately (as the raw code) and is relabelled once the
    // UPC resolves, so the sweep always shows what the camera just took.
    const scanKey = `${barcode}-${Date.now()}`;
    setRecentScans((prev) =>
      [
        { key: scanKey, label: barcode, status: "pending" as const },
        ...prev,
      ].slice(0, RECENT_SCAN_LIMIT),
    );
    const updateScanChip = (patch: Partial<Omit<ScanFeedbackEntry, "key">>) =>
      setRecentScans((prev) =>
        prev.map((entry) =>
          entry.key === scanKey ? { ...entry, ...patch } : entry,
        ),
      );

    const product = await lookupUpc(barcode);
    if (!product) {
      updateScanChip({ status: "failed" });
      return;
    }
    updateScanChip({ label: product.name });

    try {
      const inventory = await createInventory.mutateAsync({
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
      });
      updateScanChip({ status: "added" });
      setScanTally((count) => count + 1);
      toast.success(
        savedWithBackgroundWork(inventory.sideEffects, `Added ${product.name}`),
      );
    } catch {
      // createInventory already toasts the error.
      updateScanChip({ status: "failed" });
      return;
    }

    // A brand-new product has no ingredient link yet (so it won't cost in any
    // recipe) and the UPC cascade may have left it with a placeholder name and
    // no price. Surface a non-blocking follow-up sheet — the add above already
    // succeeded, so this never stalls the continuous scan loop.
    const needsName =
      PLACEHOLDER_PRODUCT_NAME.test(product.name) ||
      isUnspecifiedManufacturer(product.manufacturer);
    if (product.created || needsName) {
      setLinkIngredient(null);
      setFollowUpName(product.name);
      setFollowUpPrice("");
      setScanFollowUp({
        id: product.id,
        name: product.name,
        needsName,
        needsPrice: product.pricing.effectivePrice == null,
      });
    }
  };

  const followUpPriceValue = Number.parseFloat(followUpPrice);
  const followUpNamePatch =
    scanFollowUp?.needsName &&
    followUpName.trim().length > 0 &&
    followUpName.trim() !== scanFollowUp.name
      ? followUpName.trim()
      : undefined;
  const followUpPricePatch =
    scanFollowUp?.needsPrice &&
    Number.isFinite(followUpPriceValue) &&
    followUpPriceValue > 0
      ? followUpPriceValue
      : undefined;
  const followUpIngredientPatch = getOptionalIngredientId(linkIngredient);
  const hasFollowUpChanges =
    followUpNamePatch !== undefined ||
    followUpPricePatch !== undefined ||
    followUpIngredientPatch !== undefined;

  const submitScanFollowUp = () => {
    if (!scanFollowUp || !hasFollowUpChanges) return;
    saveScanFollowUp.mutate({
      id: scanFollowUp.id,
      data: {
        ...(followUpNamePatch !== undefined && { name: followUpNamePatch }),
        ...(followUpPricePatch !== undefined && { price: followUpPricePatch }),
        ...(followUpIngredientPatch !== undefined && {
          ingredientId: followUpIngredientPatch,
        }),
      },
    });
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
            <Row gap="sm" wrap className="shrink-0">
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
              <Button
                type="button"
                variant="outline"
                className="min-h-12 md:min-h-10"
                onClick={() => detectItems.mutate({ locationId: location.id })}
                disabled={detectItems.isPending || location.imageCount === 0}
              >
                {detectItems.isPending ? <Spinner /> : <PackagePlus />}
                Detect
              </Button>
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
          {suggestions.length > 0 && (
            <Stack gap="sm">
              <Description>
                AI suggestions
                {detectionCacheStatus ? ` · cache ${detectionCacheStatus}` : ""}
              </Description>
              {suggestions.map((item, index) => (
                <Row
                  key={`${item.name}-${item.manufacturer}-${item.estimatedQuantity}-${item.unit}-${item.evidence}`}
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
                    <Check className="size-4" />
                    Approve
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeSuggestion(index)}
                  >
                    <X className="size-4" />
                    Reject
                  </Button>
                </Row>
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
      <Sheet
        open={scanner === "barcode"}
        onOpenChange={(open) => {
          if (!open) {
            setScanner(null);
            setScanTally(0);
            setRecentScans([]);
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
          {/*
            The scanner stays live through the whole sweep — tearing the camera
            down while a lookup is in flight costs a full getUserMedia restart
            per item. Repeat reads of a code held in frame are the scanner's own
            job: `debounceMs` is the single accept gate (flash + beep + add).
          */}
          <PersistentScanner
            onScan={(barcode) => void handleBarcode(barcode)}
            enabled={scanner === "barcode"}
            formatsToSupport={BARCODE_FORMATS}
            scanHintText="Point at barcode"
            debounceMs={2500}
            addedCount={scanTally}
            recentScans={recentScans}
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
              autoFocus
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

      {/* Scanned product → optional name / price / ingredient (non-blocking). */}
      <Sheet
        open={scanFollowUp !== null}
        onOpenChange={(open) => {
          if (!open && !saveScanFollowUp.isPending) closeScanFollowUp();
        }}
      >
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>
              {scanFollowUp?.needsName
                ? "Scanned item needs a name"
                : "New product added"}
            </SheetTitle>
            <SheetDescription>
              {scanFollowUp?.name} was added to {location.name}. Fill in what
              you know — a name and price make it usable, an ingredient link
              lets it count toward recipe costing. Skip to keep scanning.
            </SheetDescription>
          </SheetHeader>
          <Stack gap="sm">
            {scanFollowUp?.needsName && (
              <Input
                value={followUpName}
                onChange={(event) => setFollowUpName(event.target.value)}
                onFocus={(event) => event.target.select()}
                placeholder="Product name"
                aria-label="Product name"
                autoFocus
                disabled={saveScanFollowUp.isPending}
              />
            )}
            {scanFollowUp?.needsPrice && (
              <Input
                value={followUpPrice}
                onChange={(event) => setFollowUpPrice(event.target.value)}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                placeholder="Price per each ($)"
                aria-label="Price per each in dollars"
                disabled={saveScanFollowUp.isPending}
              />
            )}
            <WithIngredientSearch>
              {({
                items,
                onSearchChange,
                isLoading,
                onCreateNew,
                onOpenChange,
              }) => (
                <EntityPicker
                  entity="ingredient"
                  label="ingredient"
                  items={items}
                  onSearchChange={onSearchChange}
                  isLoading={isLoading}
                  value={linkIngredient}
                  setValue={setLinkIngredient}
                  onCreateNew={onCreateNew}
                  onOpenChange={onOpenChange}
                />
              )}
            </WithIngredientSearch>
            <Row gap="sm" justify="end">
              <Button
                type="button"
                variant="ghost"
                className="min-h-12 shrink-0 md:min-h-10"
                disabled={saveScanFollowUp.isPending}
                onClick={closeScanFollowUp}
              >
                Skip
              </Button>
              <Button
                type="button"
                className="min-h-12 shrink-0 md:min-h-10"
                disabled={!hasFollowUpChanges || saveScanFollowUp.isPending}
                onClick={submitScanFollowUp}
              >
                {saveScanFollowUp.isPending ? (
                  <Spinner />
                ) : (
                  <Check className="size-4" />
                )}
                Save
              </Button>
            </Row>
          </Stack>
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
    <WithProductSearch>
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
    </WithProductSearch>
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
  const api = useTRPC();
  const queryClient = useQueryClient();
  const form = useForm<ManualAddValues>({
    resolver: zodResolver(manualAddSchema),
    defaultValues: {
      product: undefined,
      amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
    },
  });
  const createInventory = useActionMutation({
    mutationFn: api.inventory.create.mutationOptions,
    success: (data) => savedWithBackgroundWork(data.sideEffects, "Added item"),
    invalidateKeys: inventoryMutationInvalidateKeys,
    onSuccess: () => {
      form.reset({
        product: undefined,
        amount: { value: 1, unit: DEFAULT_AMOUNT_UNIT },
      });
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
    async (name: string): Promise<ComboboxItem<ProductShortcode>> => {
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
              entity="product"
            />
          )}
        </WithProductSearch>
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
