import type { Amount } from "@cubby/schemas/codec";
import type {
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { InventorySessionResolution } from "@cubby/schemas/inventory";
import type { InfLocation } from "@cubby/schemas/location";
import type { ProductQuantitySummariesOut } from "@cubby/schemas/product";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import pluralize from "pluralize";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";

import {
  useActionMutation,
  useEntityActionMutation,
} from "~/app/_components/hooks/useActionMutation";
import { LocationScanButton } from "~/app/_components/locations/location-scan-button";
import { QueuePassResumePrompt } from "~/app/_components/queue-pass/QueuePassProgress";
import { inventory } from "~/app/inventory/inventory.functions";
import { location } from "~/app/locations/location.functions";
import { product } from "~/app/products/product.functions";
import { showErrorToast } from "~/components/feedback/error-details";
import { Row, Stack } from "~/components/layout";
import { Button, buttonVariants } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyTitle,
} from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
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
  findParentLocation,
  flattenAuditableLocations,
  getUnknownChildLocations,
  type SessionLocation,
} from "./session-utils";
import { useSessionMutations } from "./useSessionMutations";
import { useSessionProgress } from "./useSessionProgress";

interface InventorySessionWorkbenchProps {
  initialParentShortcode?: LocationShortcode;
}

type SessionProgressState = ReturnType<typeof useSessionProgress>;
type SessionSummary = SessionProgressState["summary"];
type ResumeCandidate = SessionProgressState["resumeCandidate"];

interface InventorySessionContentProps {
  treeLoading: boolean;
  treeFailed: boolean;
  treeError: unknown;
  onRetryTree: () => void;
  treeLocations: InfLocation[];
  parent: InfLocation | null;
  locations: SessionLocation[];
  initialParentShortcode?: LocationShortcode;
  inventoryError: unknown;
  inventoryFailed: boolean;
  inventoryLoading: boolean;
  onRetryInventory: () => void;
  resumeCandidate: ResumeCandidate;
  startedAt: number | null;
  passComplete: boolean;
  skippedCount: number;
  summary: SessionSummary;
  onResume: () => void;
  onStartNew: () => void;
  onRevisitSkipped: () => void;
  onSelectLocation: (shortcode: LocationShortcode) => void;
  passLocations: SessionLocation[];
  currentIndex: number;
  currentLocation: SessionLocation | null;
  inventoryByLocation: Map<string, InventoryItem[]>;
  itemResolutions: Map<string, ItemResolution>;
  completedLocationIds: ReadonlySet<string>;
  skippedLocationIds: ReadonlySet<string>;
  duplicateProductIds: Set<ProductShortcode>;
  quantitySummaries: ProductQuantitySummariesOut | undefined;
  unknownItems: InventoryItem[];
  unknownLocations: InfLocation[];
  atUnknownLocation: boolean;
  unknownReady: boolean;
  onJumpToLocation: (id: string) => boolean;
  onScanJump: (id: string) => void;
  onAdoptLocation: (location: Pick<InfLocation, "id" | "name">) => void;
  onAdjust: (item: InventoryItem, amount: Amount) => void;
  onRemove: (item: InventoryItem) => void;
  onRelocate: (item: InventoryItem) => void;
  onMoveTo: (item: InventoryItem) => void;
  onClearStaged: (item: InventoryItem) => void;
  onPullUnknown: (item: InventoryItem) => void;
  onMoveUnknownTo: (item: InventoryItem) => void;
  onPullUnknownLocation: (location: InfLocation) => void;
  onDone: () => void;
  onToggleSkip: () => void;
  unresolvedCount: number;
  donePending: boolean;
  onCloseMoveTarget: () => void;
  moveTarget: {
    item: InventoryItem;
    sourceLocationId: LocationShortcode;
    commit: "done" | "now";
  } | null;
  onConfirmMoveTo: (targetLocationId: LocationShortcode) => Promise<void>;
}

export function InventorySessionWorkbench({
  initialParentShortcode,
}: InventorySessionWorkbenchProps) {
  const navigate = useNavigate();
  const ensureUnknownStarted = useRef(false);

  const treeQuery = useQuery(location.makeTree.queryOptions());
  const { data: tree, isLoading: treeLoading } = treeQuery;
  const ensureUnknown = useMutation(
    location.ensureGlobalUnknown.mutationOptions({
      onError: (error) => showErrorToast(error, "Could not create Unknown"),
    }),
  );

  useEffect(() => {
    if (ensureUnknownStarted.current) return;
    ensureUnknownStarted.current = true;
    ensureUnknown.mutate(undefined);
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
    stops: passLocations,
    current: currentLocation,
    complete: passComplete,
    jumpToId,
    counts,
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

  const unknownLocation = ensureUnknown.data ?? null;
  const unknownTreeLocation = useMemo(
    () => findLocationInTree(tree, unknownLocation?.id) ?? unknownLocation,
    [tree, unknownLocation],
  );
  const unknownChildLocations = getUnknownChildLocations(unknownTreeLocation);

  const sessionLocationIdList = useMemo(
    () => sessionLocations.map((loc) => loc.id),
    [sessionLocations],
  );
  // The Unknown tray's scope arrives later than the session's: Unknown comes
  // from the `ensureGlobalUnknown` mutation, and its parked children from the
  // tree refetch that follows. It is a separate query so that arrival never
  // re-keys the session's own inventory — one combined key flipped the
  // workbench back to its loading spinner, unmounting the review pane and
  // closing a row's just-opened "Change" sheet mid-tap.
  const trayLocationIds = useMemo(() => {
    const sessionIds = new Set(sessionLocationIdList);
    const ids: LocationShortcode[] = [];
    if (unknownLocation) ids.push(unknownLocation.id);
    // Also fetch the direct contents of locations parked under Unknown so their
    // tray rows can show a contents preview (they aren't session descendants).
    for (const loc of unknownChildLocations) ids.push(loc.id);
    // Recounting Unknown itself already reads it through the session query.
    return ids.filter((id) => !sessionIds.has(id));
  }, [sessionLocationIdList, unknownLocation, unknownChildLocations]);

  // Stock only: a recount is a walk-over-and-count exercise and a fixture is
  // not a thing you can count. This MUST match the snapshot predicate inside
  // `reconcileLocationSession`, or the stale guard compares two different
  // populations and every commit throws INVENTORY_STALE.
  const inventoryQuery = useQuery({
    ...inventory.getByLocationIds.queryOptions({
      locationIds: sessionLocationIdList,
      placement: "stock",
    }),
    enabled: sessionLocationIdList.length > 0,
  });
  const trayInventoryQuery = useQuery({
    ...inventory.getByLocationIds.queryOptions({
      locationIds: trayLocationIds,
      placement: "stock",
    }),
    enabled: trayLocationIds.length > 0,
  });
  const snapshotInput = currentLocation
    ? { locationId: currentLocation.id, placement: "stock" as const }
    : undefined;
  const snapshotPolicy = snapshotInput
    ? inventory.locationSnapshot.policy(snapshotInput)
    : undefined;
  const currentSnapshotQuery = useQuery({
    queryKey: snapshotInput
      ? inventory.locationSnapshot.queryKey(snapshotInput)
      : ["inventory", "locationSnapshot", "no-current-location"],
    queryFn: snapshotInput
      ? ({ signal }) =>
          inventory.locationSnapshot.call(snapshotInput, { signal })
      : skipToken,
    meta: snapshotPolicy?.meta,
    ...snapshotPolicy?.freshness,
  });

  // Products flagged as duplicate-unique (expected once, but present in >1
  // location) — badged inline so a recount can catch the stray copy.
  const duplicateQuery = useQuery(inventory.findDuplicates.queryOptions({}));
  const duplicateProductIds = useMemo(
    () => new Set((duplicateQuery.data ?? []).map((p) => p.id)),
    [duplicateQuery.data],
  );

  const inventoryByLocation = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    for (const item of [
      ...(inventoryQuery.data ?? []),
      ...(trayInventoryQuery.data ?? []),
    ]) {
      const rows = map.get(item.location.id) ?? [];
      rows.push(item);
      map.set(item.location.id, rows);
    }
    return map;
  }, [inventoryQuery.data, trayInventoryQuery.data]);

  // One request for the complete pass, not a product-list page or a request per
  // expected row. Unknown's holding tray is deliberately outside this set.
  const sessionProductIds = useMemo(
    () => [
      ...new Set((inventoryQuery.data ?? []).map((item) => item.product.id)),
    ],
    [inventoryQuery.data],
  );
  const quantitySummariesQuery = useQuery({
    ...product.quantitySummaries.queryOptions({ ids: sessionProductIds }),
    enabled: sessionProductIds.length > 0,
    // A pass is a point-in-time review. Keep its ledger comparison stable while
    // the pass itself writes recount adjustments.
    staleTime: Infinity,
  });

  const currentItems = currentSnapshotQuery.data?.items ?? [];
  const unknownItems = unknownLocation
    ? (inventoryByLocation.get(unknownLocation.id) ?? [])
    : [];
  // Recounting Unknown itself is the drain (relocate each row to where it
  // belongs). Its expected rows and its "From Unknown" tray would be the same
  // list, so the review pane collapses the Unknown-specific affordances.
  const atUnknownLocation =
    !!unknownLocation && currentLocation?.id === unknownLocation.id;

  const { invalidate } = useSessionMutations();

  const bulkMove = useActionMutation({
    mutationFn: inventory.bulkMove.mutationOptions,
  });
  const updateLocation = useEntityActionMutation({
    mutationFn: entityMutationOptionsFactory("location", "update"),
    entity: "location",
    operation: "update",
    // A location write's own ripple does not reach the session's inventory
    // panes; the audit session reads both sides of the bin, so it settles with
    // the shared session invalidator (which also polls any enqueued batches).
    onSuccess: () => invalidate({ watch: true }),
  });
  // "Done" commits the staged diff for the current bin. On success the committed
  // resolutions leave the staged map (read from `variables`, so it's never the
  // stale closure) and we advance to the next bin.
  const reconcile = useMutation(
    inventory.reconcileSession.mutationOptions({
      onSuccess: (_data, variables) => {
        invalidate({ watch: true });
        setItemResolutions((prev) => {
          const next = new Map(prev);
          for (const r of variables.resolutions)
            next.delete(r.inventoryEntryId);
          return next;
        });
        // Settles the bin and moves to the next one outstanding.
        recordLocationComplete(variables.locationId, variables.resolutions);
        toast.success("Bin recount saved.");
      },
      onError: (error) => {
        void inventoryQuery.refetch();
        void trayInventoryQuery.refetch();
        void currentSnapshotQuery.refetch();
        showErrorToast(error);
      },
    }),
  );

  const runUndo = async (action: UndoAction) => {
    try {
      await action.run();
      toast.success("Undone.");
    } catch {
      // SILENT: action.run() always resolves through a useActionMutation /
      // useEntityActionMutation mutation (bulkMove, updateLocation), whose
      // own onError already showErrorToast'd this failure.
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

  /**
   * Re-parent a location into the bin being recounted.
   *
   * Undo restores the parent it actually had. The Unknown-tray version this
   * generalizes always put it back in Unknown, which is only right when Unknown
   * is where it came from — wrong the moment a bin is adopted from anywhere
   * else.
   */
  const adoptLocation = async (location: Pick<InfLocation, "id" | "name">) => {
    if (!currentLocation) return;
    const previousParent = findParentLocation(tree, location.id);
    await updateLocation.mutateAsync({
      id: location.id,
      data: { parentId: currentLocation.id },
    });
    pushUndo(
      {
        run: async () => {
          if (!previousParent) {
            toast.error(`Nothing to restore ${location.name} to.`);
            return;
          }
          await updateLocation.mutateAsync({
            id: location.id,
            data: { parentId: previousParent.id },
          });
        },
      },
      // Pass membership is frozen when the scope is set, so an adopted bin
      // cannot join the queue mid-pass. Say so rather than let it look lost.
      `Moved ${location.name} into ${currentLocation.name}. It'll be a stop next pass.`,
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
    if (!currentSnapshotQuery.data) {
      toast.error("The inventory snapshot is still loading. Try again.");
      return;
    }
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
      snapshotToken: currentSnapshotQuery.data.snapshotToken,
      resolutions,
    });
  };

  // Skipping is purely local: it settles the location for this pass's progress
  // without any server write (no verifiedAt, no lastBulkInventory), and it can
  // be undone by coming back and saving — or unskipping — the location.
  const handleToggleSkip = () => {
    if (!currentLocation) return;
    const wasSkipped = skippedLocationIds.has(currentLocation.id);
    // Settling advances; un-skipping puts the cursor back on the bin.
    toggleLocationSkipped(currentLocation.id);
    if (wasSkipped) return;
    toast.success(
      `Skipped ${currentLocation.name} — come back to it any time.`,
    );
  };

  // Clears every deferral and lands on the first bin that is outstanding again.
  const revisitSkipped = clearSkippedLocations;

  const selectParent = (shortcode: LocationShortcode) => {
    void navigate({
      to: "/inventory/session",
      search: { parent: shortcode },
    });
  };

  // Resolved by the pass, against the queue the cursor actually indexes.
  const jumpToLocation = jumpToId;

  return (
    <InventorySessionContent
      treeLoading={treeLoading}
      treeFailed={treeQuery.isError}
      treeError={treeQuery.isError ? treeQuery.error : null}
      onRetryTree={() => void treeQuery.refetch()}
      treeLocations={tree ?? []}
      parent={parent}
      locations={sessionLocations}
      initialParentShortcode={initialParentShortcode}
      inventoryError={inventoryQuery.error ?? trayInventoryQuery.error}
      inventoryFailed={inventoryQuery.isError || trayInventoryQuery.isError}
      inventoryLoading={inventoryQuery.isLoading}
      onRetryInventory={() => {
        void inventoryQuery.refetch();
        void trayInventoryQuery.refetch();
      }}
      resumeCandidate={resumeCandidate}
      startedAt={startedAt}
      passComplete={passComplete}
      skippedCount={counts.skipped}
      summary={summary}
      onResume={resumePass}
      onStartNew={startNewPass}
      onRevisitSkipped={revisitSkipped}
      onSelectLocation={selectParent}
      passLocations={passLocations}
      currentIndex={currentIndex}
      currentLocation={currentLocation}
      inventoryByLocation={inventoryByLocation}
      itemResolutions={itemResolutions}
      completedLocationIds={completedLocationIds}
      skippedLocationIds={skippedLocationIds}
      duplicateProductIds={duplicateProductIds}
      quantitySummaries={quantitySummariesQuery.data}
      unknownItems={unknownItems}
      unknownLocations={unknownChildLocations}
      atUnknownLocation={atUnknownLocation}
      unknownReady={!!unknownLocation}
      onJumpToLocation={jumpToLocation}
      onScanJump={(id) => {
        if (!jumpToLocation(id)) {
          toast.error("That location is not in this session.");
        }
      }}
      onAdoptLocation={adoptLocation}
      onAdjust={stageAdjust}
      onRemove={stageRemove}
      onRelocate={stageMoveToUnknown}
      onMoveTo={(item) => {
        if (currentLocation) openMoveTo(item, currentLocation.id, "done");
      }}
      onClearStaged={(item) => setItemResolution(item.id, null)}
      onPullUnknown={pullFromUnknown}
      onMoveUnknownTo={(item) => {
        if (unknownLocation) openMoveTo(item, unknownLocation.id, "now");
      }}
      onPullUnknownLocation={adoptLocation}
      onDone={handleDone}
      onToggleSkip={handleToggleSkip}
      unresolvedCount={unresolvedCount}
      donePending={reconcile.isPending}
      onCloseMoveTarget={() => setMoveTarget(null)}
      moveTarget={moveTarget}
      onConfirmMoveTo={confirmMoveTo}
    />
  );
}

function InventorySessionContent(props: InventorySessionContentProps) {
  const {
    treeLoading,
    treeFailed,
    treeError,
    onRetryTree,
    treeLocations,
    parent,
    locations,
    initialParentShortcode,
    inventoryError,
    inventoryFailed,
    inventoryLoading,
    onRetryInventory,
    resumeCandidate,
    startedAt,
    passComplete,
    skippedCount,
    summary,
    onResume,
    onStartNew,
    onRevisitSkipped,
    onSelectLocation,
  } = props;
  if (treeLoading) {
    return (
      <Row align="center" justify="center" className="min-h-80">
        <Spinner />
      </Row>
    );
  }

  // The location tree names the frozen session scope. Do not turn a failed
  // tree into an empty picker, because choosing or resuming then would present
  // a recount against an unknown set of physical locations.
  if (treeFailed) {
    return (
      <InventorySessionLoadError
        title="Couldn't load locations for a recount"
        detail={getErrorMessage(treeError)}
        onRetry={onRetryTree}
      />
    );
  }

  if (!parent) {
    return (
      <ParentPicker
        locations={treeLocations}
        initialParentShortcode={initialParentShortcode}
        onSelect={onSelectLocation}
      />
    );
  }

  if (locations.length === 0) {
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

  // Expected inventory is the recount snapshot. A missing response must not
  // read as an empty bin: saving that state would falsely confirm a location.
  if (inventoryFailed) {
    return (
      <InventorySessionLoadError
        title={`Couldn't load inventory for ${parent.name}`}
        detail={getErrorMessage(inventoryError)}
        onRetry={onRetryInventory}
      />
    );
  }

  if (resumeCandidate) {
    return (
      <QueuePassResumePrompt
        candidate={{
          ...resumeCandidate,
          // A pass stored before totalCount was persisted reports 0; the live
          // tree is the better answer in that case.
          totalCount: resumeCandidate.totalCount || locations.length,
        }}
        title={`Resume ${parent.name} recount?`}
        itemNoun="locations"
        detail="Staged choices are still waiting on this device."
        resumeLabel="Resume recount"
        startOverLabel="Start new recount"
        onResume={onResume}
        onStartNew={onStartNew}
      />
    );
  }

  if (startedAt === null || inventoryLoading) {
    return (
      <Row align="center" justify="center" className="min-h-80">
        <Spinner />
      </Row>
    );
  }

  if (passComplete) {
    return (
      <SessionComplete
        parent={parent}
        startedAt={startedAt}
        summary={summary}
        skippedCount={skippedCount}
        onStartNew={onStartNew}
        onRevisitSkipped={onRevisitSkipped}
        onSelectLocation={onSelectLocation}
      />
    );
  }

  return <InventorySessionActive {...props} parent={parent} />;
}

function InventorySessionActive({
  parent,
  passLocations,
  currentIndex,
  currentLocation,
  inventoryByLocation,
  itemResolutions,
  completedLocationIds,
  skippedLocationIds,
  duplicateProductIds,
  quantitySummaries,
  unknownItems,
  unknownLocations,
  atUnknownLocation,
  unknownReady,
  onJumpToLocation,
  onScanJump,
  onAdoptLocation,
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
  onCloseMoveTarget,
  moveTarget,
  onConfirmMoveTo,
}: InventorySessionContentProps & { parent: InfLocation }) {
  return (
    <Stack
      gap="md"
      className="min-w-0 pb-[calc(var(--app-chrome-bottom)+1rem)] md:pb-0"
    >
      <MobileLocationSwitcher
        parent={parent}
        locations={passLocations}
        currentId={currentLocation?.id ?? null}
        currentIndex={currentIndex}
        inventoryByLocation={inventoryByLocation}
        itemResolutions={itemResolutions}
        completedLocationIds={completedLocationIds}
        skippedLocationIds={skippedLocationIds}
        onSelect={onJumpToLocation}
        onScanJump={onScanJump}
        parentLocation={parent}
        currentLocation={currentLocation?.location ?? null}
        onAdoptLocation={onAdoptLocation}
      />

      <div className="grid min-h-[calc(100dvh-10rem)] min-w-0 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
        <LocationWorkbenchSidebar
          parent={parent}
          locations={passLocations}
          currentId={currentLocation?.id ?? null}
          inventoryByLocation={inventoryByLocation}
          itemResolutions={itemResolutions}
          completedLocationIds={completedLocationIds}
          skippedLocationIds={skippedLocationIds}
          onSelect={onJumpToLocation}
          onScanJump={onScanJump}
          parentLocation={parent}
          currentLocation={currentLocation?.location ?? null}
          onAdoptLocation={onAdoptLocation}
        />

        {currentLocation && (
          <LocationReviewPane
            parent={parent}
            location={currentLocation}
            items={inventoryByLocation.get(currentLocation.id) ?? []}
            quantitySummaries={quantitySummaries}
            unknownItems={unknownItems}
            unknownLocations={unknownLocations}
            inventoryByLocation={inventoryByLocation}
            itemResolutions={itemResolutions}
            duplicateProductIds={duplicateProductIds}
            onAdjust={onAdjust}
            onRemove={onRemove}
            onRelocate={onRelocate}
            onMoveTo={onMoveTo}
            onClearStaged={onClearStaged}
            onPullUnknown={onPullUnknown}
            onMoveUnknownTo={onMoveUnknownTo}
            onPullUnknownLocation={onPullUnknownLocation}
            onDone={onDone}
            onToggleSkip={onToggleSkip}
            unresolvedCount={unresolvedCount}
            donePending={donePending}
            locationCompleted={completedLocationIds.has(currentLocation.id)}
            locationSkipped={skippedLocationIds.has(currentLocation.id)}
            isUnknownLocation={atUnknownLocation}
            unknownReady={unknownReady}
          />
        )}
      </div>

      {moveTarget && (
        <MoveToDialog
          open
          onOpenChange={(next) => {
            if (!next) onCloseMoveTarget();
          }}
          title={moveTarget.item.product.name}
          sourceLocationId={moveTarget.sourceLocationId}
          commit={moveTarget.commit}
          onConfirm={onConfirmMoveTo}
        />
      )}
    </Stack>
  );
}

function InventorySessionLoadError({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <Empty role="alert" className="min-h-80">
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{detail}</EmptyDescription>
      <EmptyActions>
        <Button
          type="button"
          variant="outline"
          className="min-h-12 md:min-h-10"
          onClick={onRetry}
        >
          Retry
        </Button>
      </EmptyActions>
    </Empty>
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
          <CheckCircleIcon className="size-6 text-positive" />
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
                <ListChecksIcon />
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
              <ArrowCounterClockwiseIcon />
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
