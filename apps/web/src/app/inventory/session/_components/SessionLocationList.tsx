import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InfLocation } from "@cubby/schemas/location";
import pluralize from "pluralize";
import { useState } from "react";
import { LocationTreeRow } from "~/app/_components/locations/location-tree-row";
import { passCounts } from "~/app/_components/queue-pass/queue-pass";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { cn } from "~/lib/utils";
import { locationTypeNoun, type SessionLocation } from "../session-utils";
import { QrJumpButton } from "./QrJumpButton";
import type { InventoryItem, ItemResolution } from "./types";

type SessionLocationListProps = {
  parent: InfLocation;
  locations: SessionLocation[];
  currentId: LocationShortcode | null;
  inventoryByLocation: Map<string, InventoryItem[]>;
  itemResolutions: Map<string, ItemResolution>;
  completedLocationIds: ReadonlySet<string>;
  /** Deferred this pass — settled for progress, but nothing was written. */
  skippedLocationIds: ReadonlySet<string>;
  onSelect: (locationId: LocationShortcode) => void;
  onScanJump: (locationId: string) => void;
  /** Re-parent a scanned stray bin into the location being recounted. */
  onAdoptLocation: (location: InfLocation) => void;
  parentLocation: InfLocation;
  /** The bin being recounted, which a scanned bin is classified against. */
  currentLocation: InfLocation | null;
};

/**
 * Shared body for the session location navigator: header (title, progress, QR
 * jump) + an outstanding-first list with confirmed/total badges.
 * Rendered both in the desktop sidebar Card and inside the mobile bottom Sheet
 * so there is a single implementation of "what's left / jump to a location".
 */
function SessionLocationList({
  parent,
  locations,
  currentId,
  inventoryByLocation,
  itemResolutions,
  completedLocationIds,
  skippedLocationIds,
  onSelect,
  onScanJump,
  onAdoptLocation,
  parentLocation,
  currentLocation,
}: SessionLocationListProps) {
  const [showCompleted, setShowCompleted] = useState(false);
  // Skipped locations stay in the outstanding list on purpose — the whole point
  // is that they're easy to come back to.
  const visible = showCompleted
    ? locations
    : locations.filter((location) => !completedLocationIds.has(location.id));
  const { completed, skipped } = passCounts(locations, {
    completed: completedLocationIds,
    skipped: skippedLocationIds,
  });

  return (
    <>
      <Stack gap="sm" className="shrink-0 border-b p-4">
        <Row align="center" justify="between" gap="sm">
          <div className="min-w-0">
            <CardTitle>{parent.name}</CardTitle>
            <Description>
              {completed} complete / {locations.length} locations
              {skipped > 0 ? ` · ${skipped} skipped` : ""}
            </Description>
          </div>
          <QrJumpButton
            parent={parentLocation}
            current={currentLocation}
            onJump={onScanJump}
            onAdopt={onAdoptLocation}
          />
        </Row>
        {completed > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setShowCompleted((value) => !value)}
          >
            {showCompleted ? "Hide completed" : `Show completed (${completed})`}
          </Button>
        )}
      </Stack>
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.map((location) => {
          const items = inventoryByLocation.get(location.id) ?? [];
          const completedThisPass = completedLocationIds.has(location.id);
          const skippedThisPass =
            !completedThisPass && skippedLocationIds.has(location.id);
          const confirmed = items.filter((item) =>
            itemResolutions.has(item.id),
          ).length;
          return (
            <button
              key={location.id}
              type="button"
              onClick={() => onSelect(location.id)}
              className={cn(
                "w-full border-[var(--border)] border-b py-1.5 pr-2 text-left transition-colors hover:bg-muted" /* tight: compact session tree row */,
                currentId === location.id && "bg-primary/5",
              )}
            >
              <LocationTreeRow
                location={location}
                depth={location.depth}
                compact
                primaryMeta={locationTypeNoun(location.type)}
                secondaryMeta={pluralize("tracked item", items.length, true)}
                trailing={
                  skippedThisPass ? (
                    <Badge variant="slate">skipped</Badge>
                  ) : (
                    <Badge
                      variant={completedThisPass ? "secondary" : "outline"}
                    >
                      {completedThisPass
                        ? `${items.length}/${items.length}`
                        : `${confirmed}/${items.length}`}
                    </Badge>
                  )
                }
              />
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Desktop-only sticky sidebar (the mobile equivalent is MobileLocationSwitcher). */
export function LocationWorkbenchSidebar(props: SessionLocationListProps) {
  return (
    <Card className="hidden overflow-hidden lg:sticky lg:top-20 lg:flex lg:h-[calc(100dvh-6rem)] lg:flex-col">
      <SessionLocationList {...props} />
    </Card>
  );
}

/**
 * Mobile (`<lg`) counterpart to the sidebar: a sticky header chip showing
 * "parent · position · done count" that opens the SessionLocationList in a
 * bottom Sheet, restoring "what's left / jump to a bin" on the phone.
 */
export function MobileLocationSwitcher({
  currentIndex,
  ...listProps
}: SessionLocationListProps & { currentIndex: number }) {
  const [open, setOpen] = useState(false);
  const {
    parent,
    locations,
    onSelect,
    onScanJump,
    completedLocationIds,
    skippedLocationIds,
  } = listProps;
  const { completed, skipped } = passCounts(locations, {
    completed: completedLocationIds,
    skipped: skippedLocationIds,
  });

  return (
    <div className="sticky top-0 z-20 bg-background pb-2 lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-between gap-2 rounded border bg-card px-4 py-2 text-left"
        >
          <span
            className="min-w-0 truncate font-medium text-sm"
            title={parent.name}
          >
            {parent.name}
          </span>
          <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
            {currentIndex + 1} / {locations.length} · {completed} done
            {skipped > 0 ? ` · ${skipped} skipped` : ""}
          </span>
        </button>
        <SheetContent side="bottom" className="flex max-h-[80dvh] flex-col p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Session locations</SheetTitle>
            <SheetDescription>
              Jump to a location in this audit session
            </SheetDescription>
          </SheetHeader>
          <SessionLocationList
            {...listProps}
            onSelect={(id) => {
              onSelect(id);
              setOpen(false);
            }}
            onScanJump={(id) => {
              // Scanning a location QR from the sheet jumps behind it; close so
              // the result (review pane) is visible, matching tap-to-select.
              onScanJump(id);
              setOpen(false);
            }}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
