import type { Amount } from "@cubby/schemas/codec";
import type { LocationId } from "@cubby/schemas/identifiers";
import type { InventorySessionResolution } from "@cubby/schemas/inventory";
import type { InfLocation } from "@cubby/schemas/location";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { Row, Stack } from "~/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { useTRPC } from "~/trpc/react";
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
  flattenAuditableLocations,
  getDirectChildLocations,
  getUnknownChildLocations,
} from "./session-utils";
import { useSessionMutations } from "./useSessionMutations";
import { useSessionProgress } from "./useSessionProgress";

interface InventorySessionWorkbenchProps {
  initialParentId?: LocationId;
}

export function InventorySessionWorkbench({
  initialParentId,
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
    () => findLocationInTree(tree, initialParentId),
    [tree, initialParentId],
  );
  const sessionLocations = useMemo(
    () => (parent ? flattenAuditableLocations(parent) : []),
    [parent],
  );

  const rootId = parent?.id ?? null;

  const {
    currentIndex,
    setCurrentIndex,
    itemResolutions,
    setItemResolutions,
    confirmedLocationIds,
    setConfirmedLocationIds,
  } = useSessionProgress(rootId, sessionLocations);

  const currentLocation = sessionLocations[currentIndex] ?? null;
  const unknownLocation = ensureUnknown.data ?? null;
  const unknownTreeLocation = useMemo(
    () => findLocationInTree(tree, unknownLocation?.id) ?? unknownLocation,
    [tree, unknownLocation],
  );
  const currentChildLocations = currentLocation
    ? getDirectChildLocations(currentLocation.location)
    : [];
  const unknownChildLocations = getUnknownChildLocations(unknownTreeLocation);

  const locationIds = useMemo(() => {
    const ids = sessionLocations.map((loc) => loc.id);
    if (unknownLocation) ids.push(unknownLocation.id);
    // Also fetch the direct contents of locations parked under Unknown so their
    // tray rows can show a contents preview (they aren't session descendants).
    for (const loc of unknownChildLocations) ids.push(loc.id);
    return ids;
  }, [sessionLocations, unknownLocation, unknownChildLocations]);

  const inventoryQuery = useQuery({
    ...api.inventory.getByLocationIds.queryOptions({ locationIds }),
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
        setCurrentIndex((idx) =>
          Math.min(sessionLocations.length - 1, idx + 1),
        );
        toast.success("Bin recount saved.");
      },
      onError: (error) => toast.error(getErrorMessage(error)),
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
    sourceLocationId: LocationId;
    targetLocationId: LocationId;
    success: string;
  }) => {
    const result = await bulkMove.mutateAsync({
      sourceLocationId,
      targetLocationId,
      items: [{ inventoryEntryId: item.id, quantity: item.amount }],
    });
    // If the destination is the bin we're recounting, the item is now
    // physically here — stage it verified (green) so it doesn't read as
    // unresolved and block the gate. Read the staged ids off the *result*
    // entries (a merge into an existing target entry changes the id), and
    // remember them so undo can un-stage.
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
            items: [{ inventoryEntryId: item.id, quantity: item.amount }],
          });
          for (const id of stagedIds) setItemResolution(id, null);
        },
      },
      success,
    );
  };

  const moveToUnknown = async (item: InventoryItem) => {
    if (!currentLocation || !unknownLocation) return;
    await moveItem({
      item,
      sourceLocationId: currentLocation.id,
      targetLocationId: unknownLocation.id,
      success: `Moved ${item.product.name} to Unknown.`,
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

  const moveLocationToUnknown = async (location: InfLocation) => {
    if (!currentLocation || !unknownLocation) return;
    await updateLocation.mutateAsync({
      id: location.id,
      data: { parentId: unknownLocation.id },
    });
    pushUndo(
      {
        run: async () => {
          await updateLocation.mutateAsync({
            id: location.id,
            data: { parentId: currentLocation.id },
          });
        },
      },
      `Moved ${location.name} to Unknown.`,
    );
  };

  const pullLocationFromUnknown = async (location: InfLocation) => {
    if (!currentLocation || !unknownLocation) return;
    await updateLocation.mutateAsync({
      id: location.id,
      data: { parentId: currentLocation.id },
    });
    // The child is now physically under this bin — acknowledge it (green) so the
    // gate doesn't demand a re-confirm for a location you just placed.
    confirmLocation(location.id);
    pushUndo(
      {
        run: async () => {
          await updateLocation.mutateAsync({
            id: location.id,
            data: { parentId: unknownLocation.id },
          });
          setConfirmedLocationIds((prev) => {
            const next = new Set(prev);
            next.delete(location.id);
            return next;
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
    sourceLocationId: LocationId;
  } | null>(null);

  const openMoveTo = (item: InventoryItem, sourceLocationId: LocationId) =>
    setMoveTarget({ item, sourceLocationId });

  const confirmMoveTo = async (targetLocationId: LocationId) => {
    if (!moveTarget) return;
    const target = findLocationInTree(tree, targetLocationId);
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

  const confirmLocation = (id: string) =>
    setConfirmedLocationIds((prev) => new Set(prev).add(id));

  // Staging (no DB write): confirm / adjust / remove. Relocate is the one live
  // action — it physically moves the item to Unknown now (undoable).
  const toggleVerify = (item: InventoryItem) =>
    setItemResolution(
      item.id,
      itemResolutions.get(item.id)?.kind === "verify"
        ? null
        : { kind: "verify" },
    );
  const stageAdjust = (item: InventoryItem, amount: Amount) =>
    setItemResolution(item.id, { kind: "adjust", amount });
  const stageRemove = (item: InventoryItem) =>
    setItemResolution(item.id, { kind: "remove" });

  // Gating: every expected item must have a staged resolution and every child
  // location must be acknowledged before the bin can be committed.
  const itemsUnresolvedCount = currentItems.filter(
    (i) => !itemResolutions.has(i.id),
  ).length;
  const locationsUnresolvedCount = currentChildLocations.filter(
    (l) => !confirmedLocationIds.has(l.id),
  ).length;
  const unresolvedCount = itemsUnresolvedCount + locationsUnresolvedCount;

  const yesToAllRemaining = () => {
    setItemResolutions((prev) => {
      const next = new Map(prev);
      for (const i of currentItems)
        if (!next.has(i.id)) next.set(i.id, { kind: "verify" });
      return next;
    });
    setConfirmedLocationIds((prev) => {
      const next = new Set(prev);
      for (const l of currentChildLocations) next.add(l.id);
      return next;
    });
  };

  const handleDone = () => {
    if (!currentLocation) return;
    const resolutions: InventorySessionResolution[] = [];
    for (const item of currentItems) {
      const r = itemResolutions.get(item.id);
      if (!r) continue;
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
          .exhaustive(),
      );
    }
    reconcile.mutate({ locationId: currentLocation.id, resolutions });
  };

  const selectParent = (locationId: LocationId) => {
    void navigate({
      to: "/inventory/session",
      search: { parentId: locationId },
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
        initialParentId={initialParentId}
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
            position={{ index: currentIndex, total: sessionLocations.length }}
            items={currentItems}
            childLocations={currentChildLocations}
            unknownItems={unknownItems}
            unknownLocations={unknownChildLocations}
            inventoryByLocation={inventoryByLocation}
            itemResolutions={itemResolutions}
            confirmedLocationIds={confirmedLocationIds}
            duplicateProductIds={duplicateProductIds}
            onToggleVerify={toggleVerify}
            onAdjust={stageAdjust}
            onRemove={stageRemove}
            onRelocate={moveToUnknown}
            onMoveTo={(item) => openMoveTo(item, currentLocation.id)}
            onConfirmLocation={(locationId) => confirmLocation(locationId)}
            onMoveLocationMissing={moveLocationToUnknown}
            onPullUnknown={pullFromUnknown}
            onMoveUnknownTo={(item) => {
              if (unknownLocation) openMoveTo(item, unknownLocation.id);
            }}
            onPullUnknownLocation={pullLocationFromUnknown}
            onPrevious={() => setCurrentIndex((idx) => Math.max(0, idx - 1))}
            onNext={() =>
              setCurrentIndex((idx) =>
                Math.min(sessionLocations.length - 1, idx + 1),
              )
            }
            onDone={handleDone}
            onYesToAll={yesToAllRemaining}
            unresolvedCount={unresolvedCount}
            donePending={reconcile.isPending}
            onJumpByScan={(id) => {
              if (!jumpToLocation(id)) {
                toast.error("That location is not in this session.");
              }
            }}
            canPrevious={currentIndex > 0}
            canNext={currentIndex < sessionLocations.length - 1}
            previousName={sessionLocations[currentIndex - 1]?.name}
            nextName={sessionLocations[currentIndex + 1]?.name}
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
          onConfirm={confirmMoveTo}
        />
      )}
    </Stack>
  );
}
