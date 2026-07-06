import type { Amount } from "@cubby/schemas/codec";
import type { AllowedImageType } from "@cubby/schemas/image";
import type { InfLocation } from "@cubby/schemas/location";
import { getMiscDisplayName, isMiscProduct } from "@cubby/shared";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightLeft,
  Camera,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  FolderInput,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { LocationBreadcrumb } from "~/app/_components/locations/location-breadcrumb";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import {
  locationTypeNoun,
  type SessionLocation,
  sessionBreadcrumbSegments,
} from "../session-utils";
import { useSessionMutations } from "../useSessionMutations";
import { AuditedHint } from "./AuditedHint";
import { LocationContentsPreview } from "./LocationContentsPreview";
import { QrJumpButton } from "./QrJumpButton";
import { SessionCaptureActions } from "./SessionCaptureActions";
import type {
  ExpectedPhotoTarget,
  InventoryItem,
  ItemResolution,
} from "./types";
import { UnknownTray } from "./UnknownTray";

export function LocationReviewPane({
  parent,
  location,
  position,
  items,
  childLocations,
  unknownItems,
  unknownLocations,
  inventoryByLocation,
  itemResolutions,
  confirmedLocationIds,
  duplicateProductIds,
  onToggleVerify,
  onAdjust,
  onRemove,
  onRelocate,
  onMoveTo,
  onConfirmLocation,
  onMoveLocationMissing,
  onPullUnknown,
  onMoveUnknownTo,
  onPullUnknownLocation,
  onPrevious,
  onNext,
  onDone,
  onYesToAll,
  unresolvedCount,
  donePending,
  onJumpByScan,
  canPrevious,
  canNext,
  previousName,
  nextName,
  unknownReady,
}: {
  parent: InfLocation;
  location: SessionLocation;
  position: { index: number; total: number };
  items: InventoryItem[];
  childLocations: InfLocation[];
  unknownItems: InventoryItem[];
  unknownLocations: InfLocation[];
  // Direct inventory keyed by location id — powers the child/Unknown-location
  // contents previews without a second query.
  inventoryByLocation: Map<string, InventoryItem[]>;
  itemResolutions: Map<string, ItemResolution>;
  confirmedLocationIds: Set<string>;
  // string, not ProductId: brands strip across tRPC outputs (CLAUDE.md), so the
  // findDuplicates query data's id — and item.product.id it's matched against —
  // are both plain strings here.
  duplicateProductIds: Set<string>;
  onToggleVerify: (item: InventoryItem) => void;
  onAdjust: (item: InventoryItem, amount: Amount) => void;
  onRemove: (item: InventoryItem) => void;
  onRelocate: (item: InventoryItem) => void;
  onMoveTo: (item: InventoryItem) => void;
  onConfirmLocation: (locationId: string) => void;
  onMoveLocationMissing: (location: InfLocation) => void;
  onPullUnknown: (item: InventoryItem) => void;
  onMoveUnknownTo: (item: InventoryItem) => void;
  onPullUnknownLocation: (location: InfLocation) => void;
  onPrevious: () => void;
  onNext: () => void;
  onDone: () => void;
  onYesToAll: () => void;
  unresolvedCount: number;
  donePending: boolean;
  onJumpByScan: (locationId: string) => void;
  canPrevious: boolean;
  canNext: boolean;
  previousName?: string;
  nextName?: string;
  unknownReady: boolean;
}) {
  const api = useTRPC();
  const { invalidate } = useSessionMutations();
  const locationNoun = locationTypeNoun(location.type);
  const locationImages = location.location.images;
  const breadcrumbSegments = sessionBreadcrumbSegments(parent, location.id);
  const isSessionRoot = location.id === parent.id;
  const expectedPhotoInputRef = useRef<HTMLInputElement>(null);
  const expectedPhotoTargetRef = useRef<ExpectedPhotoTarget | null>(null);
  const [expectedPhotoTarget, setExpectedPhotoTarget] =
    useState<ExpectedPhotoTarget | null>(null);
  const uploadExpectedImage = useMutation(
    api.image.uploadImage.mutationOptions(),
  );
  const updateExpectedProduct = useMutation(
    api.product.update.mutationOptions(),
  );
  const updateExpectedLocation = useMutation(
    api.location.update.mutationOptions(),
  );
  const expectedPhotoPending =
    uploadExpectedImage.isPending ||
    updateExpectedProduct.isPending ||
    updateExpectedLocation.isPending;

  const invalidateExpectedPhotoQueries = () =>
    invalidate({ includeProductLookup: true, watch: false });

  const openExpectedPhotoPicker = (target: ExpectedPhotoTarget) => {
    expectedPhotoTargetRef.current = target;
    setExpectedPhotoTarget(target);
    expectedPhotoInputRef.current?.click();
  };

  const handleExpectedPhoto = async (file: File) => {
    const target = expectedPhotoTargetRef.current;
    if (!target) return;

    try {
      const init = await uploadExpectedImage.mutateAsync({
        filename: file.name,
        contentType: file.type as AllowedImageType,
        size: file.size,
        entityType: target.kind === "product" ? "PRODUCT" : "LOCATION",
      });
      const put = await fetch(init.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error("Image upload failed");

      const imageData = {
        pendingImageIds: [init.imageId],
        removeImageIds: target.existingImageId
          ? [target.existingImageId]
          : undefined,
      };

      if (target.kind === "product") {
        await updateExpectedProduct.mutateAsync({
          id: target.id,
          data: imageData,
        });
      } else {
        await updateExpectedLocation.mutateAsync({
          id: target.id,
          data: imageData,
        });
      }

      invalidateExpectedPhotoQueries();
      toast.success(
        `${target.existingImageId ? "Replaced" : "Added"} photo for ${target.name}.`,
      );
    } catch (error) {
      toast.error(`Photo failed: ${getErrorMessage(error)}`);
    } finally {
      expectedPhotoTargetRef.current = null;
      setExpectedPhotoTarget(null);
    }
  };

  return (
    <Stack gap="sm" className="min-w-0">
      <input
        ref={expectedPhotoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        aria-label={
          expectedPhotoTarget
            ? `Upload photo for ${expectedPhotoTarget.name}`
            : "Upload expected content photo"
        }
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void handleExpectedPhoto(file);
          } else {
            expectedPhotoTargetRef.current = null;
            setExpectedPhotoTarget(null);
          }
          event.target.value = "";
        }}
      />
      <div className="sticky top-12 z-20 min-w-0 border-b bg-background/95 py-2 backdrop-blur md:static md:border-b-0 md:bg-transparent md:py-0">
        <Row align="baseline" gap="sm" className="min-w-0">
          <h2 className="min-w-0 flex-1 truncate font-heading font-semibold text-xl">
            <Link
              to="/locations/$id"
              params={{ id: location.id }}
              className="underline decoration-border/70 decoration-dotted underline-offset-4 transition-colors hover:text-primary hover:decoration-primary hover:decoration-solid"
            >
              {location.name}
            </Link>
          </h2>
          <AuditedHint
            at={location.lastBulkInventory}
            className="shrink-0 text-2xs"
          />
          <Description size="xs" className="shrink-0">
            {position.index + 1}/{position.total}
          </Description>
        </Row>
        {breadcrumbSegments.length > 0 ? (
          <LocationBreadcrumb
            segments={breadcrumbSegments}
            showHome
            linkable
            compact
            activeHighlight
            className="mt-1 max-w-full justify-start text-xs"
          />
        ) : isSessionRoot && position.total > 1 ? (
          <Description size="2xs" className="mt-1">
            Session root · includes descendants
          </Description>
        ) : null}
      </div>

      <Card>
        <CardContent className="p-2 lg:p-4">
          <div
            className={cn(
              "grid gap-4 lg:items-start",
              locationImages.length > 0
                ? "lg:grid-cols-[minmax(220px,320px)_minmax(0,1fr)_auto]"
                : "lg:grid-cols-[minmax(0,1fr)_auto]",
            )}
          >
            {locationImages.length > 0 && (
              <div className="min-w-0">
                <Image
                  src={locationImages[0]?.url}
                  alt={`${location.name} photo`}
                  displayWidth={360}
                  className="aspect-[4/3] w-full border border-[var(--border)] object-cover"
                />
                {locationImages.length > 1 && (
                  <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                    {locationImages.slice(1, 5).map((image) => (
                      <Image
                        key={image.id}
                        src={image.url}
                        alt={`${location.name} photo`}
                        displayWidth={96}
                        className="h-14 w-20 shrink-0 border border-[var(--border)] object-cover"
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
            <Stack gap="sm" className="min-w-0">
              {location.aiDescription ? (
                <Description className="max-w-5xl text-base leading-relaxed">
                  {location.aiDescription}
                </Description>
              ) : (
                <Description>
                  No AI description yet. Add a photo to compute one.
                </Description>
              )}
              <Row gap="sm" wrap>
                <Badge variant="outline">{location.imageCount} photos</Badge>
                <Badge
                  variant={location.lastBulkInventory ? "secondary" : "outline"}
                >
                  {location.lastBulkInventory
                    ? "complete before"
                    : "not audited"}
                </Badge>
              </Row>
            </Stack>
            <div className="flex justify-start lg:justify-end">
              <QrJumpButton parent={parent} onJump={onJumpByScan} manualEntry />
            </div>
          </div>
        </CardContent>
      </Card>

      <SessionCaptureActions location={location} />

      <Card size="sm">
        <CardHeader>
          <CardTitle>Expected contents</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 && childLocations.length === 0 ? (
            <Description>
              No tracked contents in this {locationNoun} yet.
            </Description>
          ) : (
            <Stack gap="sm">
              {childLocations.map((child) => (
                <ExpectedLocationReviewRow
                  key={child.id}
                  location={child}
                  previewItems={inventoryByLocation.get(child.id) ?? []}
                  confirmed={confirmedLocationIds.has(child.id)}
                  onConfirm={() => onConfirmLocation(child.id)}
                  onMissing={() => onMoveLocationMissing(child)}
                  onPhoto={() =>
                    openExpectedPhotoPicker({
                      kind: "location",
                      id: child.id,
                      name: child.name,
                      existingImageId: child.images[0]?.id,
                    })
                  }
                  photoPending={expectedPhotoPending}
                />
              ))}
              {items.map((item) => (
                <ExpectedItemReviewRow
                  key={item.id}
                  item={item}
                  resolution={itemResolutions.get(item.id)}
                  isDuplicate={duplicateProductIds.has(item.product.id)}
                  onToggleVerify={() => onToggleVerify(item)}
                  onAdjust={(amount) => onAdjust(item, amount)}
                  onRemove={() => onRemove(item)}
                  onRelocate={() => onRelocate(item)}
                  onMoveTo={() => onMoveTo(item)}
                  onPhoto={() =>
                    openExpectedPhotoPicker({
                      kind: "product",
                      id: item.product.id,
                      name: item.product.name,
                      existingImageId: item.product.images[0]?.id,
                    })
                  }
                  photoPending={expectedPhotoPending}
                />
              ))}
            </Stack>
          )}
        </CardContent>
      </Card>

      <UnknownTray
        items={unknownItems}
        locations={unknownLocations}
        inventoryByLocation={inventoryByLocation}
        currentLocationName={location.name}
        onMoveIn={onPullUnknown}
        onMoveTo={onMoveUnknownTo}
        onMoveLocationIn={onPullUnknownLocation}
        disabled={!unknownReady}
      />

      <Stack
        gap="sm"
        className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border border-[var(--border)] bg-card p-2 md:bottom-4"
      >
        {unresolvedCount > 0 && (
          <Button
            type="button"
            variant="outline"
            className="min-h-12"
            onClick={onYesToAll}
          >
            <CheckCheck className="h-4 w-4" />
            Yes to all remaining ({unresolvedCount})
          </Button>
        )}
        <Row align="stretch" gap="sm">
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-12 max-w-28 flex-col items-start gap-0 py-1"
            onClick={onPrevious}
            disabled={!canPrevious}
            aria-label={previousName ? `Previous: ${previousName}` : "Previous"}
          >
            <span className="flex items-center gap-1 font-medium text-xs">
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </span>
            <span className="w-full truncate text-left text-2xs text-muted-foreground">
              {canPrevious ? (previousName ?? "—") : "Start"}
            </span>
          </Button>
          <Button
            type="button"
            className="min-h-12 flex-1"
            disabled={unresolvedCount > 0 || donePending}
            onClick={onDone}
          >
            {donePending ? <Spinner /> : <Check className="h-4 w-4" />}
            {unresolvedCount > 0 ? `${unresolvedCount} left` : "Done"}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-12 max-w-28 flex-col items-end gap-0 py-1"
            onClick={onNext}
            disabled={!canNext}
            aria-label={nextName ? `Next: ${nextName}` : "Next"}
          >
            <span className="flex items-center gap-1 font-medium text-xs">
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
            <span className="w-full truncate text-right text-2xs text-muted-foreground">
              {canNext ? (nextName ?? "—") : "End"}
            </span>
          </Button>
        </Row>
      </Stack>
    </Stack>
  );
}

function ExpectedItemReviewRow({
  item,
  resolution,
  onToggleVerify,
  onAdjust,
  onRemove,
  onRelocate,
  onMoveTo,
  onPhoto,
  photoPending,
  isDuplicate,
}: {
  item: InventoryItem;
  resolution: ItemResolution | undefined;
  isDuplicate: boolean;
  onToggleVerify: () => void;
  onAdjust: (amount: Amount) => void;
  onRemove: () => void;
  onRelocate: () => void;
  onMoveTo: () => void;
  onPhoto: () => void;
  photoPending: boolean;
}) {
  const staged = resolution?.kind;
  const amount =
    resolution?.kind === "adjust" ? resolution.amount : item.amount;
  // Strip the `misc:` prefix off photo-as-identity / misc placeholder products.
  const displayName = isMiscProduct(item.product.name)
    ? getMiscDisplayName(item.product.name)
    : item.product.name;
  // Step by ±1 without rounding, so weight/length amounts keep their precision
  // (2.5 → 3.5, not 4). Floor at 1 — recounting to zero means the item is gone,
  // which is the "Remove" action (soft-delete), not a phantom 0-qty adjust.
  const bump = (delta: number) => {
    const next = Math.max(1, amount.value + delta);
    // No-op at the floor: don't turn a verified item into an identical "adjust"
    // (which would drop its confirmed state and force a needless recompute).
    if (next === amount.value) return;
    onAdjust({ ...amount, value: next });
  };

  return (
    <div
      className={cn(
        "border border-[var(--border)] border-l-4 border-l-warning/60 bg-background p-2",
        staged === "verify" && "border-l-positive/60 bg-positive/5",
        staged === "adjust" && "border-l-primary/60 bg-primary/5",
        staged === "remove" && "border-l-destructive/60 bg-destructive/5",
      )}
    >
      <Row align="center" gap="sm" className="min-w-0">
        <Image
          src={item.product.images[0]?.url}
          alt={item.product.name}
          displayWidth={128}
          className="h-14 w-14 shrink-0 border border-[var(--border)] object-cover"
        />
        <div className="min-w-0 flex-1">
          <Row align="center" gap="sm">
            <span className="truncate font-medium text-sm">{displayName}</span>
            {staged === "verify" && (
              <Badge variant="secondary">confirmed</Badge>
            )}
            {staged === "adjust" && <Badge>adjusted</Badge>}
            {staged === "remove" && (
              <Badge variant="destructive">removing</Badge>
            )}
            {isDuplicate && <Badge variant="outline">duplicate</Badge>}
          </Row>
          <Row align="center" gap="sm">
            <Description size="xs" className="truncate">
              {tryFormatAmount(amount)}
            </Description>
            {item.verifiedAt && (
              <AuditedHint
                at={item.verifiedAt}
                label="verified"
                className="shrink-0 text-2xs"
              />
            )}
          </Row>
        </div>
      </Row>
      <Row align="center" justify="between" gap="sm" className="mt-2">
        {/* Stepper. Floor at 1 — recounting to zero is the Remove (No) action. */}
        <Row align="center" gap="xs" className="shrink-0">
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 shrink-0"
            onClick={() => bump(-1)}
            disabled={staged === "remove"}
            aria-label="Decrease quantity"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <span className="w-7 text-center font-mono text-sm tabular-nums">
            {amount.value}
          </span>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 shrink-0"
            onClick={() => bump(1)}
            disabled={staged === "remove"}
            aria-label="Increase quantity"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </Row>
        <Row gap="xs" wrap className="justify-end">
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 shrink-0"
            onClick={onRelocate}
            aria-label="Move to Unknown"
            title="Move to Unknown"
          >
            <ArrowRightLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 shrink-0"
            onClick={onMoveTo}
            aria-label="Move to another location"
            title="Move to another location"
          >
            <FolderInput className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 shrink-0"
            onClick={onPhoto}
            disabled={photoPending}
            aria-label="Add photo"
            title="Add photo"
          >
            {photoPending ? <Spinner /> : <Camera className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 shrink-0 border-positive/40 bg-positive/10 text-positive hover:bg-positive/20 hover:text-positive"
            onClick={onToggleVerify}
            aria-pressed={staged === "verify"}
            aria-label="Confirm present"
            title="Confirm present"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-10 w-10 shrink-0"
            onClick={onRemove}
            aria-label="Mark removed"
            title="Mark removed"
          >
            <X className="h-4 w-4" />
          </Button>
        </Row>
      </Row>
    </div>
  );
}

function ExpectedLocationReviewRow({
  location,
  previewItems,
  confirmed,
  onConfirm,
  onMissing,
  onPhoto,
  photoPending,
}: {
  location: InfLocation;
  previewItems: InventoryItem[];
  confirmed: boolean;
  onConfirm: () => void;
  onMissing: () => void;
  onPhoto: () => void;
  photoPending: boolean;
}) {
  return (
    <div
      className={cn(
        "border border-[var(--border)] border-l-4 border-l-primary/60 bg-primary/5 p-2",
        confirmed && "border-positive/40 bg-positive/5",
      )}
    >
      <Row align="baseline" gap="xs" wrap>
        <EntityInlineLink
          entity="location"
          data={{
            id: location.id,
            name: location.name,
            type: location.type,
          }}
        />
        {confirmed && <Badge variant="secondary">confirmed</Badge>}
      </Row>
      <Row align="center" justify="between" gap="sm" className="mt-2">
        <Row align="center" gap="sm" className="min-w-0">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
            {location.images[0]?.url ? (
              <Image
                src={location.images[0].url}
                alt={location.name}
                displayWidth={128}
                className="h-full w-full object-cover"
              />
            ) : (
              <LocationIcon type={location.type} size={26} />
            )}
          </div>
          <Description size="xs" className="truncate">
            {location.children?.length ?? 0} loc ·{" "}
            {location.totalItemCount ?? 0}{" "}
            {(location.totalItemCount ?? 0) === 1 ? "item" : "items"}
          </Description>
        </Row>
        <Row gap="xs" className="shrink-0">
          <Button
            type="button"
            variant="outline"
            className="h-11 w-10 shrink-0"
            onClick={onPhoto}
            disabled={photoPending}
            aria-label="Add photo"
            title="Add photo"
          >
            {photoPending ? <Spinner /> : <Camera className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-10 shrink-0 border-positive/40 bg-positive/10 text-positive hover:bg-positive/20 hover:text-positive"
            onClick={onConfirm}
            aria-label="Confirm present"
            title="Confirm present"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11 w-10 shrink-0"
            onClick={onMissing}
            aria-label="Mark missing"
            title="Mark missing"
          >
            <X className="h-4 w-4" />
          </Button>
        </Row>
      </Row>
      <LocationContentsPreview items={previewItems} />
    </div>
  );
}
