import type { Amount } from "@cubby/schemas/codec";
import type { AllowedImageType } from "@cubby/schemas/image";
import type { InfLocation } from "@cubby/schemas/location";
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
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { LocationBreadcrumb } from "~/app/_components/locations/location-breadcrumb";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import {
  locationTypeNoun,
  type SessionLocation,
  sessionBreadcrumbSegments,
} from "../session-utils";
import { useSessionMutations } from "../useSessionMutations";
import { AuditedHint } from "./AuditedHint";
import { QrJumpButton } from "./QrJumpButton";
import { ItemReviewCard, LocationReviewCard } from "./review-rows";
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
        <Row align="center" gap="sm" className="min-w-0">
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
          <div className="hidden shrink-0 md:flex">
            <QrJumpButton parent={parent} onJump={onJumpByScan} manualEntry />
          </div>
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

      <LocationContextStrip
        key={location.id}
        location={location}
        qrSlot={
          <QrJumpButton parent={parent} onJump={onJumpByScan} manualEntry />
        }
      />

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

      <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border border-[var(--border)] bg-card p-2 md:bottom-4">
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
          {unresolvedCount > 0 && (
            <Button
              type="button"
              variant="outline"
              className="min-h-12 shrink-0"
              onClick={onYesToAll}
              aria-label={`Yes to all remaining (${unresolvedCount})`}
            >
              <CheckCheck className="h-4 w-4" />
              <span className="hidden whitespace-nowrap sm:inline">
                Yes to all
              </span>
              <span>({unresolvedCount})</span>
            </Button>
          )}
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
      </div>
    </Stack>
  );
}

// Compact location context: a thumbnail + clamped AI description + badges. The
// thumbnail and "more" toggle both expand the full description and any extra
// photos. State is reset per location via a `key` on the call site.
function LocationContextStrip({
  location,
  qrSlot,
}: {
  location: SessionLocation;
  qrSlot: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const images = location.location.images;
  const hasImages = images.length > 0;

  return (
    <div className="border border-[var(--border)] p-2">
      <Row gap="sm" align="start" className="min-w-0">
        {hasImages && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="shrink-0"
            aria-label={expanded ? "Collapse details" : "Expand details"}
          >
            <Image
              src={images[0]?.url}
              alt={`${location.name} photo`}
              displayWidth={112}
              className="h-16 w-24 border border-[var(--border)] object-cover"
            />
          </button>
        )}
        <Stack gap="xs" className="min-w-0 flex-1">
          {location.aiDescription ? (
            <div className="min-w-0">
              <Description
                className={cn(
                  "text-sm leading-relaxed",
                  !expanded && "line-clamp-2",
                )}
              >
                {location.aiDescription}
              </Description>
              <button
                type="button"
                onClick={() => setExpanded((prev) => !prev)}
                className="text-primary text-xs hover:underline"
              >
                {expanded ? "Less" : "More"}
              </button>
            </div>
          ) : (
            <Description size="sm">
              No AI description yet. Add a photo to compute one.
            </Description>
          )}
          <Row gap="sm" wrap align="center">
            <Badge variant="outline">{location.imageCount} photos</Badge>
            <Badge
              variant={location.lastBulkInventory ? "secondary" : "outline"}
            >
              {location.lastBulkInventory ? "complete before" : "not audited"}
            </Badge>
          </Row>
        </Stack>
      </Row>
      {expanded && images.length > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {images.slice(1, 5).map((image) => (
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
      <div className="mt-2 md:hidden">{qrSlot}</div>
    </div>
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
    <ItemReviewCard
      product={item.product}
      amount={amount}
      verifiedAt={item.verifiedAt}
      className={cn(
        "border-l-warning/60 bg-background",
        staged === "verify" && "border-l-positive/60 bg-positive/5",
        staged === "adjust" && "border-l-primary/60 bg-primary/5",
        staged === "remove" && "border-l-destructive/60 bg-destructive/5",
      )}
      badges={
        <>
          {staged === "verify" && <Badge variant="secondary">confirmed</Badge>}
          {staged === "adjust" && <Badge>adjusted</Badge>}
          {staged === "remove" && <Badge variant="destructive">removing</Badge>}
          {isDuplicate && <Badge variant="outline">duplicate</Badge>}
        </>
      }
      controls={
        <>
          {/* Stepper. Floor at 1 — recounting to zero is the Remove (No) action. */}
          <Row align="center" gap="xs" className="shrink-0">
            <Button
              type="button"
              variant="outline"
              className="h-11 w-10 shrink-0"
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
              className="h-11 w-10 shrink-0"
              onClick={() => bump(1)}
              disabled={staged === "remove"}
              aria-label="Increase quantity"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </Row>
          <Row gap="xs" wrap className="shrink-0 justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11 w-10 shrink-0"
              onClick={onRelocate}
              aria-label="Move to Unknown"
              title="Move to Unknown"
            >
              <ArrowRightLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-10 shrink-0"
              onClick={onMoveTo}
              aria-label="Move to another location"
              title="Move to another location"
            >
              <FolderInput className="h-4 w-4" />
            </Button>
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
              className="h-11 w-10 shrink-0"
              onClick={onRemove}
              aria-label="Mark removed"
              title="Mark removed"
            >
              <X className="h-4 w-4" />
            </Button>
          </Row>
        </>
      }
    />
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
    <LocationReviewCard
      location={location}
      previewItems={previewItems}
      className={cn(
        "border-l-primary/60 bg-primary/5",
        confirmed && "border-positive/40 bg-positive/5",
      )}
      badge={confirmed && <Badge variant="secondary">confirmed</Badge>}
      actions={
        <>
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
        </>
      }
    />
  );
}
