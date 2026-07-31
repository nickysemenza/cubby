import type { Amount } from "@cubby/schemas/codec";
import { isDocumentFile } from "@cubby/schemas/image";
import type { InfLocation } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightLeft,
  Check,
  FolderInput,
  Minus,
  PackagePlus,
  Plus,
  SkipForward,
  SlidersHorizontal,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";
import { match } from "ts-pattern";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { LocationBreadcrumb } from "~/app/_components/locations/location-breadcrumb";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { Spinner } from "~/components/ui/spinner";
import { entities, entityDetailParams } from "~/entities/entities";
import { cn } from "~/lib/utils";
import {
  locationTypeNoun,
  type SessionLocation,
  sessionBreadcrumbSegments,
} from "../session-utils";
import { AuditedHint } from "./AuditedHint";
import { SessionCaptureActions } from "./SessionCaptureActions";
import type { InventoryItem, ItemResolution } from "./types";
import { UnknownTray } from "./UnknownTray";

export function LocationReviewPane({
  parent,
  location,
  items,
  unknownItems,
  unknownLocations,
  inventoryByLocation,
  itemResolutions,
  duplicateProductIds,
  onAdjust,
  onRemove,
  onRelocate,
  onMoveTo,
  onClearStaged,
  onPullUnknown,
  onMoveUnknownTo,
  onPullUnknownLocation,
  onDone,
  onToggleSkip,
  unresolvedCount,
  donePending,
  unknownReady,
  locationCompleted,
  locationSkipped,
  isUnknownLocation,
}: {
  parent: InfLocation;
  location: SessionLocation;
  items: InventoryItem[];
  unknownItems: InventoryItem[];
  unknownLocations: InfLocation[];
  // Direct inventory keyed by location id — powers the child/Unknown-location
  // contents previews without a second query.
  inventoryByLocation: Map<string, InventoryItem[]>;
  itemResolutions: Map<string, ItemResolution>;
  // string, not ProductId: brands strip across tRPC outputs (CLAUDE.md), so the
  // findDuplicates query data's id — and item.product.id it's matched against —
  // are both plain strings here.
  duplicateProductIds: Set<string>;
  onAdjust: (item: InventoryItem, amount: Amount) => void;
  onRemove: (item: InventoryItem) => void;
  onRelocate: (item: InventoryItem) => void;
  onMoveTo: (item: InventoryItem) => void;
  /** Drop a staged change and return the row to assumed-present. */
  onClearStaged: (item: InventoryItem) => void;
  onPullUnknown: (item: InventoryItem) => void;
  onMoveUnknownTo: (item: InventoryItem) => void;
  onPullUnknownLocation: (location: InfLocation) => void;
  onDone: () => void;
  onToggleSkip: () => void;
  unresolvedCount: number;
  donePending: boolean;
  unknownReady: boolean;
  locationCompleted: boolean;
  locationSkipped: boolean;
  /** True when the bin being recounted *is* the global Unknown (the drain). */
  isUnknownLocation: boolean;
}) {
  const locationNoun = locationTypeNoun(location.type);
  const breadcrumbSegments = sessionBreadcrumbSegments(parent, location.id);
  const [addOpen, setAddOpen] = useState(false);
  // Recounting Unknown itself: its tray would just mirror the expected rows and
  // "Move to Unknown" would be a no-op, so both drop out. "Move somewhere else"
  // stays — that's how a row leaves Unknown.
  const unknownCount = isUnknownLocation
    ? 0
    : unknownItems.length + unknownLocations.length;

  return (
    <Stack gap="sm" className="min-w-0">
      <div className="sticky top-12 z-20 min-w-0 border-b bg-background/95 py-2 backdrop-blur md:static md:border-b-0 md:bg-transparent md:py-0">
        <Row align="center" gap="sm" className="min-w-0">
          <h2 className="min-w-0 flex-1 truncate font-heading font-semibold text-xl">
            <Link
              to={entities.location.routes.detail}
              params={entityDetailParams(location.id)}
              className="underline decoration-border/70 decoration-dotted underline-offset-4 transition-colors hover:text-primary hover:decoration-primary hover:decoration-solid"
            >
              {location.name}
            </Link>
          </h2>
          {locationSkipped && (
            <Badge variant="slate" className="shrink-0">
              skipped
            </Badge>
          )}
        </Row>
        {breadcrumbSegments.length > 0 && (
          <LocationBreadcrumb
            segments={breadcrumbSegments}
            showHome
            linkable
            compact
            activeHighlight
            className="mt-1 max-w-full justify-start text-xs"
          />
        )}
      </div>

      <LocationContextStrip key={location.id} location={location} />

      <Button
        type="button"
        variant="outline"
        className="min-h-12 w-full justify-start px-4"
        onClick={() => setAddOpen(true)}
      >
        <PackagePlus />
        Add something here
        {unknownCount > 0 && (
          <Badge variant="outline" className="ml-auto">
            {unknownCount} in Unknown
          </Badge>
        )}
      </Button>

      <section className="border-[var(--border)] border-t pt-4">
        <Row align="center" justify="between" className="mb-2">
          <h3 className="font-medium text-sm">Expected contents</h3>
          <Description size="xs">{items.length} tracked</Description>
        </Row>
        {items.length === 0 ? (
          <Description>No tracked contents in this {locationNoun}.</Description>
        ) : (
          <Stack gap="sm">
            {items.map((item) => (
              <ExpectedItemReviewRow
                key={item.id}
                item={item}
                resolution={itemResolutions.get(item.id)}
                isDuplicate={duplicateProductIds.has(item.product.id)}
                onAdjust={(amount) => onAdjust(item, amount)}
                onRemove={() => onRemove(item)}
                onRelocate={() => onRelocate(item)}
                onMoveTo={() => onMoveTo(item)}
                onClearStaged={() => onClearStaged(item)}
                completed={locationCompleted}
                unknownReady={unknownReady}
                isUnknownLocation={isUnknownLocation}
              />
            ))}
          </Stack>
        )}
      </section>

      <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border border-[var(--border)] bg-card p-2 md:bottom-4">
        <Row gap="sm" align="center">
          <Button
            type="button"
            className="min-h-12 flex-1"
            disabled={locationCompleted || donePending}
            onClick={onDone}
          >
            {donePending ? <Spinner /> : <Check className="size-4" />}
            {locationCompleted
              ? "Saved this pass"
              : unresolvedCount > 0
                ? `Finish — rest are present (${unresolvedCount})`
                : "Save recount"}
          </Button>
          {/* An unreachable bin must not strand the pass: skipping settles it
              locally (no verifiedAt, no lastBulkInventory) and it stays in the
              list to come back to. */}
          {!locationCompleted && (
            <Button
              type="button"
              variant={locationSkipped ? "secondary" : "outline"}
              className="min-h-12 shrink-0"
              onClick={onToggleSkip}
            >
              {locationSkipped ? <Undo2 /> : <SkipForward />}
              {locationSkipped ? "Unskip" : "Skip"}
            </Button>
          )}
        </Row>
      </div>

      <Sheet open={addOpen} onOpenChange={setAddOpen}>
        <SheetContent side="bottom" className="flex max-h-[90dvh] flex-col p-0">
          <SheetHeader className="border-b p-4">
            <SheetTitle>Add something here</SheetTitle>
            <SheetDescription>
              {isUnknownLocation
                ? "Add a new item to Unknown."
                : "Add a new item or pull something out of Unknown."}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 overflow-auto p-4">
            <Stack gap="lg">
              <SessionCaptureActions location={location} />
              {!isUnknownLocation && (
                <section className="border-[var(--border)] border-t pt-4">
                  <Row align="center" justify="between" className="mb-4">
                    <h3 className="font-medium text-sm">From Unknown</h3>
                    <Badge variant="outline">{unknownCount}</Badge>
                  </Row>
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
                </section>
              )}
            </Stack>
          </div>
        </SheetContent>
      </Sheet>
    </Stack>
  );
}

// Compact location context: a thumbnail + clamped AI description + badges. The
// thumbnail and "more" toggle both expand the full description and any extra
// photos. State is reset per location via a `key` on the call site.
function LocationContextStrip({ location }: { location: SessionLocation }) {
  const [expanded, setExpanded] = useState(false);
  const images = location.location.images;
  const hasImages = images.length > 0;

  if (!hasImages && !location.aiDescription) {
    return null;
  }

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
          ) : null}
          <Description size="xs">{location.imageCount} photos</Description>
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
    </div>
  );
}

function ExpectedItemReviewRow({
  item,
  resolution,
  onAdjust,
  onRemove,
  onRelocate,
  onMoveTo,
  onClearStaged,
  isDuplicate,
  completed,
  unknownReady,
  isUnknownLocation,
}: {
  item: InventoryItem;
  resolution: ItemResolution | undefined;
  isDuplicate: boolean;
  onAdjust: (amount: Amount) => void;
  onRemove: () => void;
  onRelocate: () => void;
  onMoveTo: () => void;
  onClearStaged: () => void;
  completed: boolean;
  unknownReady: boolean;
  isUnknownLocation: boolean;
}) {
  const [actionsOpen, setActionsOpen] = useState(false);
  // While the field is focused it owns the text (so "1" → "" → "12" works);
  // null hands display back to the staged/expected amount.
  const [quantityDraft, setQuantityDraft] = useState<string | null>(null);
  const staged = resolution?.kind;
  const amount =
    resolution?.kind === "adjust" ? resolution.amount : item.amount;
  // Step by ±1 without rounding, so weight/length amounts keep their precision
  // (2.5 → 3.5, not 4). Floor at 1 — recounting to zero means the item is gone,
  // which is the "Remove" action (soft-delete), not a phantom 0-qty adjust.
  const setQuantity = (next: number) => {
    const clamped = Math.max(1, next);
    // No-op at the floor: don't turn a verified item into an identical "adjust"
    // (which would drop its confirmed state and force a needless recompute).
    if (clamped === amount.value) return;
    onAdjust({ ...amount, value: clamped });
  };
  const bump = (delta: number) => setQuantity(amount.value + delta);
  // Typed entry commits on blur/Enter. Same floor as the stepper; anything
  // unparseable (empty, letters, 0, negative) snaps back to the current count.
  const commitQuantityDraft = () => {
    if (quantityDraft === null) return;
    const parsed = Number(quantityDraft.trim());
    if (Number.isFinite(parsed) && parsed >= 1) setQuantity(parsed);
    setQuantityDraft(null);
  };

  const present = completed || staged === "verify" || staged === "adjust";
  const stateLabel = completed
    ? "saved this pass"
    : staged === "verify"
      ? "present"
      : staged === "adjust"
        ? "quantity adjusted"
        : staged === "remove"
          ? "will be removed"
          : resolution?.kind === "relocate"
            ? `moving to ${resolution.targetLocationName}`
            : "assumed present";

  return (
    <div
      className={cn(
        "flex items-stretch border border-[var(--border)] bg-background transition-colors",
        present && "border-positive/40 bg-positive/5",
        staged === "adjust" && "border-primary/40 bg-primary/5",
        staged === "remove" && "border-destructive/40 bg-destructive/5",
        staged === "relocate" && "border-primary/40 bg-primary/5",
      )}
    >
      <div className="flex min-h-16 min-w-0 flex-1 items-center gap-2 p-2">
        <Image
          src={item.product.images.find((img) => !isDocumentFile(img))?.url}
          alt=""
          displayWidth={96}
          className="size-12 shrink-0 border border-[var(--border)] object-cover"
        />
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-medium text-sm"
            title={item.product.name}
          >
            {item.product.name}
          </div>
          <Row align="baseline" gap="xs" wrap>
            <Description size="xs">{tryFormatAmount(amount)}</Description>
            <Description size="xs">{stateLabel}</Description>
            {item.verifiedAt && (
              <AuditedHint
                at={item.verifiedAt}
                label="verified"
                className="text-2xs"
              />
            )}
            {isDuplicate && <Badge variant="outline">duplicate</Badge>}
          </Row>
        </div>
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center border border-[var(--border)] text-muted-foreground",
            present && "border-positive/40 bg-positive/10 text-positive",
            staged === "remove" &&
              "border-destructive/40 bg-destructive/10 text-destructive",
          )}
          aria-hidden="true"
        >
          {staged === "remove" ? <X /> : <Check />}
        </span>
      </div>

      <Button
        type="button"
        variant="ghost"
        className="min-h-16 shrink-0 border-[var(--border)] border-l px-4"
        onClick={() => setActionsOpen(true)}
        disabled={completed}
        aria-label={`Change ${item.product.name}`}
      >
        <SlidersHorizontal />
        <span className="hidden sm:inline">Change</span>
      </Button>

      <Sheet open={actionsOpen} onOpenChange={setActionsOpen}>
        <SheetContent side="bottom" className="p-4">
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>{item.product.name}</SheetTitle>
            <SheetDescription>
              Adjust the count, move it, or remove it.
            </SheetDescription>
          </SheetHeader>
          <Stack gap="sm">
            <div className="border border-[var(--border)] p-4">
              <Row align="center" justify="between" gap="sm">
                <Stack gap="tight" className="min-w-0">
                  <Description>Quantity</Description>
                  <Description size="2xs">{amount.unit}</Description>
                </Stack>
                <Row align="center" gap="xs" className="shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-10 shrink-0"
                    onClick={() => bump(-1)}
                    aria-label="Decrease quantity"
                  >
                    <Minus className="size-4" />
                  </Button>
                  <Input
                    inputMode="numeric"
                    value={quantityDraft ?? String(amount.value)}
                    onChange={(event) => setQuantityDraft(event.target.value)}
                    onFocus={(event) => event.target.select()}
                    onBlur={commitQuantityDraft}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    className="h-11 w-16 shrink-0 text-center font-mono tabular-nums"
                    aria-label="Quantity"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-10 shrink-0"
                    onClick={() => bump(1)}
                    aria-label="Increase quantity"
                  >
                    <Plus className="size-4" />
                  </Button>
                </Row>
              </Row>
            </div>
            {resolution && (
              <Button
                type="button"
                variant="outline"
                className="min-h-12 w-full justify-start px-4"
                onClick={() => {
                  onClearStaged();
                  setQuantityDraft(null);
                  setActionsOpen(false);
                }}
              >
                <Undo2 />
                {match(resolution)
                  .with({ kind: "adjust" }, () => "Undo count change")
                  .with({ kind: "remove" }, () => "Keep as present")
                  .with({ kind: "relocate" }, () => "Keep here as present")
                  .with({ kind: "verify" }, () => "Clear present mark")
                  .exhaustive()}
              </Button>
            )}
            {!isUnknownLocation && (
              <Button
                type="button"
                variant="outline"
                className="min-h-12 w-full justify-start px-4"
                disabled={!unknownReady}
                onClick={() => {
                  onRelocate();
                  setActionsOpen(false);
                }}
              >
                <ArrowRightLeft />
                Move to Unknown
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-12 w-full justify-start px-4"
              onClick={() => {
                onMoveTo();
                setActionsOpen(false);
              }}
            >
              <FolderInput />
              Move somewhere else
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-12 w-full justify-start px-4"
              onClick={() => {
                onRemove();
                setActionsOpen(false);
              }}
            >
              <X />
              Remove from inventory
            </Button>
          </Stack>
        </SheetContent>
      </Sheet>
    </div>
  );
}
