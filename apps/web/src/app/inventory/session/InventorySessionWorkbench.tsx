import type { Amount } from "@cubby/schemas/codec";
import type { LocationShortcode } from "@cubby/schemas/identifiers";
import type { InventorySessionResolution } from "@cubby/schemas/inventory";
import type { InfLocation } from "@cubby/schemas/location";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, ListChecks, RotateCcw } from "lucide-react";
import pluralize from "pluralize";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { LocationScanButton } from "~/app/_components/locations/location-scan-button";
import { Row, Stack } from "~/components/layout";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { useTRPC } from "~/integrations/trpc/react";
import { getErrorMessage } from "~/lib/error-utils";
import { LocationReviewPane } from "./_components/LocationReviewPane";
import { MoveToDialog } from "./_components/MoveToDialog";
import { ParentPicker } from "./_components/ParentPicker";
import {
  LocationWorkbenchSidebar,
  MobileLocationSwitcher,
} from "./_components/SessionLocationList";
import type {
  InventoryItem,
  ItemResolution,
  UndoAction,
} from "./_components/types";
import {
  findLocationInTree,
  findLocationInTreeByShortcode,
  flattenAuditableLocations,
  getUnknownChildLocations,
} from "./session-utils";
import { useSessionMutations } from "./useSessionMutations";
import { useSessionProgress } from "./useSessionProgress";

interface InventorySessionWorkbenchProps {
  initialParentShortcode?: LocationShortcode;
}

export function InventorySessionWorkbench({
  initialParentShortcode,
}: InventorySessionWorkbenchProps) {
  const api = useTRPC();
  const navigate = useNavigate();
  const ensureUnknownStarted = useRef(false);

  const { data: tree, isLoading: treeLoading } = useQuery(
    api.location.makeTree.queryOptions(),
  );
  const ensureUnknown = useMutation(
    api.location.ensureGlobalUnknown.mutationOptions(),
  );

  useEffect(() => {
    if (ensureUnknownStarted.current) return;
    ensureUnknownStarted.current = true;
    ensureUnknown.mutate(undefined, {
      onError: (error) =>
        toast.error(`Could not create Unknown: ${getErrorMessage(error)}`),
    });
  }, [ensureUnknown]);

  const parent = useMemo(
    () => findLocationInTreeByShortcode(tree, initialParentShortcode),
    [tree, initialParentShortcode],
  );
  const sessionLocations = useMemo(
    () => (parent ? flattenAuditableLocations(parent) : []),
    [parent],
  );

  const rootId = parent?.id ?? null;

  const {
    startedAt,
    currentIndex,
    setCurrentIndex,
    itemResolutions,
    setItemResolutions,
    completedLocationIds,
    skippedLocationIds,
    summary,
    resumeCandidate,
    resumePass,
    startNewPass,
    recordLocationComplete,
    toggleLocationSkipped,
    clearSkippedLocations,
  } = useSessionProgress(rootId, sessionLocations);

  const currentLocation = sessionLocations[currentIndex] ?? null;
  const unknownLocation = ensureUnknown.data ?? null;
  const unknownTreeLocation = useMemo(
    () => findLocationInTree(tree, unknownLocation?.id) ?? unknownLocation,
    [tree, unknownLocation],
  );
  const unknownChildLocations = getUnknownChildLocations(unknownTreeLocation);

  const locationIds = useMemo(() => {
    const ids = sessionLocations.map((loc) => loc.id);
    if (unknownLocation) ids.push(unknownLocation.id);
    // Also fetch the direct contents of locations parked under Unknown so their
    // tray rows can show a contents preview (they aren't session descendants).
    for (const loc of unknownChildLocations) ids.push(loc.id);
    return ids;
  }, [sessionLocations, unknownLocation, unknownChildLocations]);

  // Stock only: a recount is a walk-over-and-count exercise and a fixture is
  // not a thing you can count. This MUST match the snapshot predicate inside
  // `reconcileLocationSession`, or the stale guard compares two different
  // populations and every commit throws INVENTORY_STALE.
  const inventoryQuery = useQuery({
    ...api.inventory.getByLocationIds.queryOptions({
      locationIds,
      placement: "stock",
    }),
    enabled: locationIds.length > 0,
  });

  // Products flagged as duplicate-unique (expected once, but present in >1
  // location) — badged inline so a recount can catch the stray copy.
  const duplicateQuery = useQuery(
    api.inventory.findDuplicates.queryOptions({}),
  );
  const duplicateProductIds = useMemo(
    () => new Set((duplicateQuery.data ?? []).map((p) => p.id)),
    [duplicateQuery.data],
  );

  const inventoryByLocation = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    for (const item of inventoryQuery.data ?? []) {
      const rows = map.get(item.location.id) ?? [];
      rows.push(item);
      map.set(item.location.id, rows);
    }
    return map;
  }, [inventoryQuery.data]);

  const currentItems = currentLocation
    ? (inventoryByLocation.get(currentLocation.id) ?? [])
    : [];
  const unknownItems = unknownLocation
    ? (inventoryByLocation.get(unknownLocation.id) ?? [])
    : [];
  // Recounting Unknown itself is the drain (relocate each row to where it
  // belongs). Its expected rows and its "From Unknown" tray would be the same
  // list, so the review pane collapses the Unknown-specific affordances.
  const atUnknownLocation =
    !!unknownLocation && currentLocation?.id === unknownLocation.id;

  const { sessionInvalidateKeys, invalidate } = useSessionMutations();

  // reconcile is a documented useActionMutation carve-out (variables-driven
  // setState in onSuccess), so it keeps this shared invalidator inline.
  const invalidateSession = useCallback(
    (result?: unknown) => invalidate({ result, watch: true }),
    [invalidate],
  );

  const bulkMove = useActionMutation({
    mutationFn: api.inventory.bulkMove.mutationOptions,
    invalidateKeys: sessionInvalidateKeys,
  });
  const updateLocation = useActionMutation({
    mutationFn: api.location.update.mutationOptions,
    invalidateKeys: sessionInvalidateKeys,
  });
  // Advance to the next location that still needs attention. "Settled" is saved
  // *or* skipped, so a deferred bin isn't handed straight back.
  const advanceToOutstanding = (settled: ReadonlySet<string>) => {
    setCurrentIndex((idx) => {
      const after = sessionLocations.findIndex(
        (location, index) => index > idx && !settled.has(location.id),
      );
      if (after >= 0) return after;
      const wrapped = sessionLocations.findIndex(
        (location) => !settled.has(location.id),
      );
      return wrapped >= 0 ? wrapped : idx;
    });
  };

  // "Done" commits the staged diff for the current bin. On success the committed
  // resolutions leave the staged map (read from `variables`, so it's never the
  // stale closure) and we advance to the next bin.
  const reconcile = useMutation(
    api.inventory.reconcileSession.mutationOptions({
      onSuccess: (data, variables) => {
        invalidateSession(data);
        setItemResolutions((prev) => {
          const next = new Map(prev);
          for (const r of variables.resolutions)
            next.delete(r.inventoryEntryId);
          return next;
        });
        recordLocationComplete(variables.locationId, variables.resolutions);
        advanceToOutstanding(
          new Set([
            ...completedLocationIds,
            ...skippedLocationIds,
            variables.locationId,
          ]),
        );
        toast.success("Bin recount saved.");
      },
      onError: (error) => {
        void inventoryQuery.refetch();
        toast.error(getErrorMessage(error));
      },
    }),
  );

  const runUndo = async (action: UndoAction) => {
    try {
      await action.run();
      toast.success("Undone.");
    } catch (error) {
      toast.error(`Undo failed: ${getErrorMessage(error)}`);
    }
  };

  // Offer undo via a bottom toast (sonner) with an Undo action, instead of a
  // top-sticky bar that pushed the review pane down and needed a scroll to reach.
  const pushUndo = (action: UndoAction, successMessage: string) => {
    toast.success(successMessage, {
      action: { label: "Undo", onClick: () => void runUndo(action) },
    });
  };

  const moveItem = async ({
    item,
    sourceLocationId,
    targetLocationId,
    success,
  }: {
    item: InventoryItem;
    sourceLocationId: LocationShortcode;
    targetLocationId: LocationShortcode;
    success: string;
  }) => {
    const result = await bulkMove.mutateAsync({
      sourceLocationId,
      targetLocationId,
      items: [{ inventoryEntryId: item.id, quantity: item.amount }],
    });
    // A merge into an existing same-product entry at the target hard-deletes
    // the source entry, so `item.id` can be stale after the move — the entry
    // that now holds the moved quantity is the one in `result.items`. Undo
    // must reverse by that id (moving `item.amount` back is a partial move
    // out of the merged entry).
    const movedId = result.items[0]?.id ?? item.id;
    // If the destination is the bin we're recounting, the item is now
    // physically here — stage it verified so the local pass summary treats it
    // as an explicit addition, and remember the ids so undo can un-stage.
    const stagedIds: string[] = [];
    if (currentLocation && targetLocationId === currentLocation.id) {
      for (const moved of result.items) {
        if (moved.location.id === currentLocation.id) {
          setItemResolution(moved.id, { kind: "verify" });
          stagedIds.push(moved.id);
        }
      }
    }
    pushUndo(
      {
        run: async () => {
          await bulkMove.mutateAsync({
            sourceLocationId: targetLocationId,
            targetLocationId: sourceLocationId,
            items: [{ inventoryEntryId: movedId, quantity: item.amount }],
          });
          for (const id of stagedIds) setItemResolution(id, null);
        },
      },
      success,
    );
  };

  const stageMoveToUnknown = (item: InventoryItem) => {
    if (!currentLocation || !unknownLocation) return;
    setItemResolution(item.id, {
      kind: "relocate",
      targetLocationId: unknownLocation.id,
      targetLocationName: "Unknown",
    });
  };

  const pullFromUnknown = async (item: InventoryItem) => {
    if (!currentLocation || !unknownLocation) return;
    await moveItem({
      item,
      sourceLocationId: unknownLocation.id,
      targetLocationId: currentLocation.id,
      success: `Moved ${item.product.name} into ${currentLocation.name}.`,
    });
  };

  const pullLocationFromUnknown = async (location: InfLocation) => {
    if (!currentLocation || !unknownLocation) return;
    await updateLocation.mutateAsync({
      id: location.id,
      data: { parentId: currentLocation.id },
    });
    pushUndo(
      {
        run: async () => {
          await updateLocation.mutateAsync({
            id: location.id,
            data: { parentId: unknownLocation.id },
          });
        },
      },
      `Moved ${location.name} into ${currentLocation.name}.`,
    );
  };

  // "Move to…" dialog: the item being relocated to an arbitrary location plus
  // the bin it's leaving (the current bin for expected rows, Unknown for tray
  // rows). The move itself reuses moveItem, so verify-staging + undo are shared.
  const [moveTarget, setMoveTarget] = useState<{
    item: InventoryItem;
    sourceLocationId: LocationShortcode;
    commit: "done" | "now";
  } | null>(null);

  const openMoveTo = (
    item: InventoryItem,
    sourceLocationId: LocationShortcode,
    commit: "done" | "now",
  ) => setMoveTarget({ item, sourceLocationId, commit });

  const confirmMoveTo = async (targetLocationId: LocationShortcode) => {
    if (!moveTarget) return;
    const target = findLocationInTree(tree, targetLocationId);
    if (moveTarget.commit === "done") {
      setItemResolution(moveTarget.item.id, {
        kind: "relocate",
        targetLocationId,
        targetLocationName: target?.name ?? "another location",
      });
      return;
    }
    await moveItem({
      item: moveTarget.item,
      sourceLocationId: moveTarget.sourceLocationId,
      targetLocationId,
      success: `Moved ${moveTarget.item.product.name} to ${target?.name ?? "location"}.`,
    });
  };

  const setItemResolution = (id: string, res: ItemResolution | null) =>
    setItemResolutions((prev) => {
      const next = new Map(prev);
      if (res === null) next.delete(id);
      else next.set(id, res);
      return next;
    });

  // Expected-row exceptions are staged. Finish fills untouched rows with
  // `verify` and applies the complete set atomically; capture/Unknown additions
  // remain explicit immediate writes.
  const stageAdjust = (item: InventoryItem, amount: Amount) =>
    setItemResolution(item.id, { kind: "adjust", amount });
  const stageRemove = (item: InventoryItem) =>
    setItemResolution(item.id, { kind: "remove" });

  const unresolvedCount = currentItems.filter(
    (i) => !itemResolutions.has(i.id),
  ).length;

  const handleDone = () => {
    if (!currentLocation) return;
    const resolutions: InventorySessionResolution[] = [];
    for (const item of currentItems) {
      const r = itemResolutions.get(item.id) ?? { kind: "verify" as const };
      // Exhaustive match so a new resolution kind can't silently default to verify.
      resolutions.push(
        match(r)
          .with({ kind: "adjust" }, ({ amount }) => ({
            kind: "adjust" as const,
            inventoryEntryId: item.id,
            amount,
          }))
          .with({ kind: "remove" }, () => ({
            kind: "remove" as const,
            inventoryEntryId: item.id,
          }))
          .with({ kind: "verify" }, () => ({
            kind: "verify" as const,
            inventoryEntryId: item.id,
          }))
          .with({ kind: "relocate" }, ({ targetLocationId }) => ({
            kind: "relocate" as const,
            inventoryEntryId: item.id,
            targetLocationId,
          }))
          .exhaustive(),
      );
    }
    reconcile.mutate({
      locationId: currentLocation.id,
      expectedInventoryEntryIds: currentItems.map((item) => item.id),
      snapshotUpdatedAt: currentItems.reduce<Date | null>(
        (latest, item) =>
          latest === null || item.updatedAt > latest ? item.updatedAt : latest,
        null,
      ),
      resolutions,
    });
  };

  // Skipping is purely local: it settles the location for this pass's progress
  // without any server write (no verifiedAt, no lastBulkInventory), and it can
  // be undone by coming back and saving — or unskipping — the location.
  const handleToggleSkip = () => {
    if (!currentLocation) return;
    const wasSkipped = skippedLocationIds.has(currentLocation.id);
    toggleLocationSkipped(currentLocation.id);
    if (wasSkipped) return;
    advanceToOutstanding(
      new Set([
        ...completedLocationIds,
        ...skippedLocationIds,
        currentLocation.id,
      ]),
    );
    toast.success(
      `Skipped ${currentLocation.name} — come back to it any time.`,
    );
  };

  const revisitSkipped = () => {
    clearSkippedLocations();
    const next = sessionLocations.findIndex(
      (location) => !completedLocationIds.has(location.id),
    );
    if (next >= 0) setCurrentIndex(next);
  };

  const selectParent = (shortcode: LocationShortcode) => {
    void navigate({
      to: "/inventory/session",
      search: { parent: shortcode },
    });
  };

  const jumpToLocation = (locationId: string) => {
    const index = sessionLocations.findIndex((loc) => loc.id === locationId);
    if (index >= 0) {
      setCurrentIndex(index);
      return true;
    }
    return false;
  };

  if (treeLoading) {
    return (
      <Row align="center" justify="center" className="min-h-80">
        <Spinner />
      </Row>
    );
  }

  if (!parent) {
    return (
      <ParentPicker
        locations={tree ?? []}
        initialParentShortcode={initialParentShortcode}
        onSelect={selectParent}
      />
    );
  }

  if (sessionLocations.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No auditable locations under {parent.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <Description>
            Add shelves, bins, drawers, cabinets, boxes, crates, carts, tables,
            or bags under this location before starting a session.
          </Description>
        </CardContent>
      </Card>
    );
  }

  if (resumeCandidate) {
    return (
      <ResumeSessionPrompt
        parentName={parent.name}
        startedAt={resumeCandidate.startedAt}
        completedCount={resumeCandidate.completedCount}
        skippedCount={resumeCandidate.skippedCount}
        totalCount={sessionLocations.length}
        onResume={resumePass}
        onStartNew={startNewPass}
      />
    );
  }

  if (startedAt === null || inventoryQuery.isLoading) {
    return (
      <Row align="center" justify="center" className="min-h-80">
        <Spinner />
      </Row>
    );
  }

  // A skipped location settles the pass too — otherwise one unreachable bin
  // keeps the summary out of reach forever.
  const skippedInCurrentTree = sessionLocations.filter((location) =>
    skippedLocationIds.has(location.id),
  ).length;
  const settledInCurrentTree = sessionLocations.filter(
    (location) =>
      completedLocationIds.has(location.id) ||
      skippedLocationIds.has(location.id),
  ).length;
  const passComplete = settledInCurrentTree >= sessionLocations.length;
  if (passComplete) {
    return (
      <SessionComplete
        parent={parent}
        startedAt={startedAt}
        summary={summary}
        skippedCount={skippedInCurrentTree}
        onStartNew={startNewPass}
        onRevisitSkipped={revisitSkipped}
        onSelectLocation={selectParent}
      />
    );
  }

  return (
    <Stack
      gap="md"
      className="min-w-0 pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-0"
    >
      <MobileLocationSwitcher
        parent={parent}
        locations={sessionLocations}
        currentId={currentLocation?.id ?? null}
        currentIndex={currentIndex}
        inventoryByLocation={inventoryByLocation}
        itemResolutions={itemResolutions}
        completedLocationIds={completedLocationIds}
        skippedLocationIds={skippedLocationIds}
        onSelect={(id) => jumpToLocation(id)}
        onScanJump={(id) => {
          if (!jumpToLocation(id)) {
            toast.error("That location is not in this session.");
          }
        }}
        parentLocation={parent}
      />

      <div className="grid min-h-[calc(100dvh-10rem)] min-w-0 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
        <LocationWorkbenchSidebar
          parent={parent}
          locations={sessionLocations}
          currentId={currentLocation?.id ?? null}
          inventoryByLocation={inventoryByLocation}
          itemResolutions={itemResolutions}
          completedLocationIds={completedLocationIds}
          skippedLocationIds={skippedLocationIds}
          onSelect={(id) => jumpToLocation(id)}
          onScanJump={(id) => {
            if (!jumpToLocation(id)) {
              toast.error("That location is not in this session.");
            }
          }}
          parentLocation={parent}
        />

        {currentLocation && (
          <LocationReviewPane
            parent={parent}
            location={currentLocation}
            items={currentItems}
            unknownItems={unknownItems}
            unknownLocations={unknownChildLocations}
            inventoryByLocation={inventoryByLocation}
            itemResolutions={itemResolutions}
            duplicateProductIds={duplicateProductIds}
            onAdjust={stageAdjust}
            onRemove={stageRemove}
            onRelocate={stageMoveToUnknown}
            onMoveTo={(item) => openMoveTo(item, currentLocation.id, "done")}
            onClearStaged={(item) => setItemResolution(item.id, null)}
            onPullUnknown={pullFromUnknown}
            onMoveUnknownTo={(item) => {
              if (unknownLocation) openMoveTo(item, unknownLocation.id, "now");
            }}
            onPullUnknownLocation={pullLocationFromUnknown}
            onDone={handleDone}
            onToggleSkip={handleToggleSkip}
            unresolvedCount={unresolvedCount}
            donePending={reconcile.isPending}
            locationCompleted={completedLocationIds.has(currentLocation.id)}
            locationSkipped={skippedLocationIds.has(currentLocation.id)}
            isUnknownLocation={atUnknownLocation}
            unknownReady={!!unknownLocation}
          />
        )}
      </div>

      {moveTarget && (
        <MoveToDialog
          open
          onOpenChange={(next) => {
            if (!next) setMoveTarget(null);
          }}
          title={moveTarget.item.product.name}
          sourceLocationId={moveTarget.sourceLocationId}
          commit={moveTarget.commit}
          onConfirm={confirmMoveTo}
        />
      )}
    </Stack>
  );
}

function ResumeSessionPrompt({
  parentName,
  startedAt,
  completedCount,
  skippedCount,
  totalCount,
  onResume,
  onStartNew,
}: {
  parentName: string;
  startedAt: number;
  completedCount: number;
  skippedCount: number;
  totalCount: number;
  onResume: () => void;
  onStartNew: () => void;
}) {
  return (
    <Card className="mx-auto w-full max-w-xl">
      <CardHeader>
        <CardTitle>Resume {parentName} recount?</CardTitle>
      </CardHeader>
      <CardContent>
        <Stack gap="md">
          <Description>
            Started {formatDistanceToNow(startedAt, { addSuffix: true })}. You
            completed {completedCount} of {totalCount} locations
            {skippedCount > 0 ? ` (${skippedCount} skipped)` : ""}; staged
            choices are still waiting on this device.
          </Description>
          <Row gap="sm" wrap>
            <Button type="button" className="min-h-12" onClick={onResume}>
              Resume recount
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-12"
              onClick={onStartNew}
            >
              <RotateCcw />
              Start new recount
            </Button>
          </Row>
        </Stack>
      </CardContent>
    </Card>
  );
}

function SessionComplete({
  parent,
  startedAt,
  summary,
  skippedCount,
  onStartNew,
  onRevisitSkipped,
  onSelectLocation,
}: {
  parent: InfLocation;
  startedAt: number;
  summary: ReturnType<typeof useSessionProgress>["summary"];
  skippedCount: number;
  onStartNew: () => void;
  onRevisitSkipped: () => void;
  onSelectLocation: (shortcode: LocationShortcode) => void;
}) {
  const changes = summary.adjusted + summary.relocated + summary.removed;
  return (
    <Card className="mx-auto w-full max-w-2xl">
      <CardHeader>
        <Row align="center" gap="sm">
          <CheckCircle2 className="size-6 text-positive" />
          <div>
            <h2>
              <CardTitle>{parent.name} recount complete</CardTitle>
            </h2>
            <Description>
              Finished a pass started{" "}
              {formatDistanceToNow(startedAt, {
                addSuffix: true,
              })}
              .
            </Description>
          </div>
        </Row>
      </CardHeader>
      <CardContent>
        <Stack gap="md">
          <p className="text-sm">
            {pluralize("location", summary.locations, true)} saved ·{" "}
            {pluralize("item", summary.verified, true)} confirmed ·{" "}
            {pluralize("change", changes, true)} ({summary.adjusted} adjusted,{" "}
            {summary.relocated} relocated, {summary.removed} removed)
            {skippedCount > 0
              ? ` · ${pluralize("location", skippedCount, true)} skipped`
              : ""}
          </p>
          <Row gap="sm" wrap>
            {skippedCount > 0 && (
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                onClick={onRevisitSkipped}
              >
                <ListChecks />
                Revisit {pluralize("skipped location", skippedCount, true)}
              </Button>
            )}
            <LocationScanButton
              buttonLabel="Scan another location"
              sheetDescription="Start a new spot-check at the scanned location."
              onResolved={(_locationId, shortcode) => {
                if (shortcode) onSelectLocation(shortcode);
                return undefined;
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-12"
              onClick={onStartNew}
            >
              <RotateCcw />
              Recount {parent.name} again
            </Button>
            <Link
              to="/inventory"
              className={buttonVariants({
                variant: "outline",
                className: "min-h-12",
              })}
            >
              Back to inventory
            </Link>
          </Row>
        </Stack>
      </CardContent>
    </Card>
  );
}
