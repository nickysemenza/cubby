import type { DetectedItem } from "@cubby/schemas/ai";
import type { Amount } from "@cubby/schemas/codec";
import {
  type LocationId,
  locationId,
  type ProductId,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type { AllowedImageType } from "@cubby/schemas/image";
import type {
  InventorySessionResolution,
  InventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory";
import type { InfLocation } from "@cubby/schemas/location";
import {
  extractShortcodeFromScan,
  getMiscDisplayName,
  isMiscProduct,
} from "@cubby/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  Barcode,
  Camera,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Minus,
  PackagePlus,
  Plus,
  QrCode,
  Search,
  X,
} from "lucide-react";
import pluralize from "pluralize";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { z } from "zod";
import { DialogCompatibleCombobox } from "~/app/_components/combobox/combobox-dialog";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import {
  WithIngredientSearch,
  WithProductSearch,
} from "~/app/_components/combobox/with-search-hook";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import {
  getOptionalIngredientId,
  getProductId,
  requiredProductField,
} from "~/app/_components/form-fields";
import { ComboboxField } from "~/app/_components/form-utils";
import { formatCompactRelative } from "~/app/_components/HoverableTimestamp";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { useUpcLookup } from "~/app/_components/inventory/hooks";
import {
  BARCODE_FORMATS,
  PersistentScanner,
  QR_CODE_FORMATS,
} from "~/app/_components/inventory/persistent-scanner";
import { LocationBreadcrumb } from "~/app/_components/locations/location-breadcrumb";
import { LocationIcon } from "~/app/_components/locations/location-icons";
import { LocationTreeRow } from "~/app/_components/locations/location-tree-row";
import { useProductSearch } from "~/app/_components/products/use-product-search";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidate,
} from "~/lib/background-batch-polling";
import { getErrorMessage } from "~/lib/error-utils";
import {
  invalidateTRPCQueries,
  inventoryMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  productLookupMutationInvalidateKeys,
  productMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import {
  findLocationInTree,
  flattenAllLocations,
  flattenAuditableLocations,
  flattenPickerTree,
  getDirectChildLocations,
  getSessionRootCandidates,
  getUnknownChildLocations,
  isDescendantLocation,
  type SessionLocation,
} from "./session-utils";

type InventoryItem = InventoryWithLocationAndProductOut;

type ExpectedPhotoTarget =
  | {
      kind: "product";
      id: InventoryItem["product"]["id"];
      name: string;
      existingImageId?: string;
    }
  | {
      kind: "location";
      id: InfLocation["id"];
      name: string;
      existingImageId?: string;
    };

interface UndoAction {
  run: () => Promise<void>;
}

// Per-session-root display progress (confirmed checks + position), persisted to
// localStorage so it survives a reload or a tree-invalidating mutation. This is
// UX state ONLY — never a source of truth for a destructive write.
const AUDIT_SESSION_STORAGE_PREFIX = "cubby:audit-session:";

// One staged, uncommitted decision about an expected inventory row. Nothing is
// written to the DB until "Done" commits the whole resolved set at once.
type ItemResolution =
  | { kind: "verify" }
  | { kind: "adjust"; amount: Amount }
  | { kind: "remove" };

interface PersistedSessionProgress {
  // [inventoryId, resolution] pairs — Map isn't JSON-serializable.
  itemResolutions: [string, ItemResolution][];
  confirmedLocationIds: string[];
  currentIndex: number;
}

function loadSessionProgress(rootId: string): PersistedSessionProgress | null {
  try {
    const raw = localStorage.getItem(
      `${AUDIT_SESSION_STORAGE_PREFIX}${rootId}`,
    );
    return raw ? (JSON.parse(raw) as PersistedSessionProgress) : null;
  } catch {
    // localStorage unavailable (SSR / private mode / quota) — start fresh.
    return null;
  }
}

function saveSessionProgress(rootId: string, data: PersistedSessionProgress) {
  try {
    localStorage.setItem(
      `${AUDIT_SESSION_STORAGE_PREFIX}${rootId}`,
      JSON.stringify(data),
    );
  } catch {
    // best-effort; localStorage may be unavailable.
  }
}

/**
 * Inline recency hint for a location's last audit (`lastBulkInventory`):
 * `audited 3d` / `never audited`, tinted `warning` once it's gone stale (>30d)
 * so the oldest bins stand out. Full timestamp on hover via the title attr
 * (safe inside the list-row button, unlike a Tooltip trigger).
 */
function AuditedHint({
  at,
  className,
  label = "audited",
}: {
  at: Date | null;
  className?: string;
  label?: string;
}) {
  if (!at) {
    return (
      <span className={cn("text-muted-foreground/70", className)}>
        never {label}
      </span>
    );
  }
  const stale = Date.now() - at.getTime() > 30 * 86_400_000;
  return (
    <span
      title={`Last ${label} ${format(at, "yyyy-MM-dd HH:mm")}`}
      className={cn(
        stale ? "text-warning" : "text-muted-foreground/70",
        className,
      )}
    >
      {label} {formatCompactRelative(at)}
    </span>
  );
}

const manualAddSchema = z.object({
  product: requiredProductField,
  amount: z.object({
    value: z.number().positive(),
    unit: z.string().min(1),
  }),
});

type ManualAddValues = z.input<typeof manualAddSchema>;

function parseLocationIdFromInput(raw: string): LocationId | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];

  try {
    const url = new URL(trimmed);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) candidates.push(lastSegment);
  } catch {
    // Plain shortcode/UUID input is expected most of the time.
  }

  for (const candidate of candidates) {
    const parsed = locationId.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }

  return null;
}

function locationTypeNoun(type: string): string {
  return type.replaceAll("-", " ");
}

function locationPathFromRoot(
  root: InfLocation,
  locationId: string,
): InfLocation[] {
  if (root.id === locationId) return [root];

  for (const child of root.children ?? []) {
    const childPath = locationPathFromRoot(child, locationId);
    if (childPath.length > 0) return [root, ...childPath];
  }

  return [];
}

function sessionBreadcrumbSegments(parent: InfLocation, locationId: string) {
  return locationPathFromRoot(parent, locationId).map((location) => ({
    id: location.id,
    name: location.name,
    type: location.type,
  }));
}

interface InventorySessionWorkbenchProps {
  initialParentId?: LocationId;
}

export function InventorySessionWorkbench({
  initialParentId,
}: InventorySessionWorkbenchProps) {
  const api = useTRPC();
  const queryClient = useQueryClient();
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

  const [currentIndex, setCurrentIndex] = useState(0);
  // Staged decisions for expected inventory rows, keyed by (globally-unique)
  // inventory id — committed atomically on "Done", persisted to localStorage.
  const [itemResolutions, setItemResolutions] = useState<
    Map<string, ItemResolution>
  >(() => new Map());
  // Child-location acknowledgments (client-only — no DB write on Done).
  const [confirmedLocationIds, setConfirmedLocationIds] = useState<Set<string>>(
    () => new Set(),
  );

  const rootId = parent?.id ?? null;

  // Initialize per session ROOT, keyed on rootId (NOT sessionLocations): a tree
  // refetch — e.g. the invalidation after editing a location's photo or a
  // quantity — must not wipe confirmed checks or currentIndex. Prior progress is
  // rehydrated from localStorage so it also survives a reload.
  const lastRootId = useRef<string | null>(null);
  useEffect(() => {
    if (rootId === lastRootId.current) return;
    lastRootId.current = rootId;
    if (!rootId || sessionLocations.length === 0) {
      setCurrentIndex(0);
      setItemResolutions(new Map());
      setConfirmedLocationIds(new Set());
      return;
    }
    const restored = loadSessionProgress(rootId);
    const firstIncomplete = sessionLocations.findIndex(
      (loc) => !loc.lastBulkInventory,
    );
    setItemResolutions(new Map(restored?.itemResolutions ?? []));
    setConfirmedLocationIds(new Set(restored?.confirmedLocationIds ?? []));
    setCurrentIndex(
      restored
        ? Math.min(
            Math.max(restored.currentIndex, 0),
            sessionLocations.length - 1,
          )
        : firstIncomplete >= 0
          ? firstIncomplete
          : 0,
    );
  }, [rootId, sessionLocations]);

  // Persist progress per root (UX resume only — see the storage-helper note).
  useEffect(() => {
    if (!rootId) return;
    saveSessionProgress(rootId, {
      itemResolutions: [...itemResolutions],
      confirmedLocationIds: [...confirmedLocationIds],
      currentIndex,
    });
  }, [rootId, itemResolutions, confirmedLocationIds, currentIndex]);

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
    return ids;
  }, [sessionLocations, unknownLocation]);

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

  const invalidateSession = useCallback(
    (result?: unknown) => {
      const keys = [
        ...inventoryMutationInvalidateKeys,
        ...locationMutationInvalidateKeys,
      ];
      invalidateTRPCQueries(queryClient, keys);
      void watchBatchesAndInvalidate({
        queryClient,
        result,
        invalidateKeys: keys,
        fetchBatchStatus: makeBatchStatusFetcher(queryClient, api),
      });
    },
    [queryClient, api],
  );

  const bulkMove = useMutation(
    api.inventory.bulkMove.mutationOptions({
      onSuccess: invalidateSession,
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
  const updateLocation = useMutation(
    api.location.update.mutationOptions({
      onSuccess: invalidateSession,
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
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
    await bulkMove.mutateAsync({
      sourceLocationId,
      targetLocationId,
      items: [{ inventoryEntryId: item.id, quantity: item.amount }],
    });
    pushUndo(
      {
        run: async () => {
          await bulkMove.mutateAsync({
            sourceLocationId: targetLocationId,
            targetLocationId: sourceLocationId,
            items: [{ inventoryEntryId: item.id, quantity: item.amount }],
          });
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
            itemResolutions={itemResolutions}
            confirmedLocationIds={confirmedLocationIds}
            duplicateProductIds={duplicateProductIds}
            onToggleVerify={toggleVerify}
            onAdjust={stageAdjust}
            onRemove={stageRemove}
            onRelocate={moveToUnknown}
            onConfirmLocation={(locationId) => confirmLocation(locationId)}
            onMoveLocationMissing={moveLocationToUnknown}
            onPullUnknown={pullFromUnknown}
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
    </Stack>
  );
}

function ParentPicker({
  locations,
  initialParentId,
  onSelect,
}: {
  locations: InfLocation[];
  initialParentId?: LocationId;
  onSelect: (locationId: LocationId) => void;
}) {
  const candidateIds = useMemo(
    () =>
      new Set(
        getSessionRootCandidates(flattenAllLocations(locations)).map(
          (location) => location.id,
        ),
      ),
    [locations],
  );
  const defaultExpandedIds = useMemo(
    () =>
      new Set(
        locations
          .filter((location) => candidateIds.has(location.id))
          .map((location) => location.id),
      ),
    [candidateIds, locations],
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => defaultExpandedIds,
  );
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    setExpandedIds(defaultExpandedIds);
  }, [defaultExpandedIds]);

  const candidates = flattenPickerTree(locations, candidateIds, {
    expandedIds,
    searchTerm,
  });
  const searching = searchTerm.trim().length > 0;

  const toggleExpanded = (locationId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(locationId)) {
        next.delete(locationId);
      } else {
        next.add(locationId);
      }
      return next;
    });
  };

  return (
    <Stack gap="md" className="min-w-0">
      {initialParentId && (
        <Card>
          <CardContent className="p-4">
            <Description>
              That parent location could not be found. Choose a location to
              start a session.
            </Description>
          </CardContent>
        </Card>
      )}
      <Card className="overflow-hidden">
        <CardHeader className="border-b p-4">
          <CardTitle>Choose session root</CardTitle>
          <Description>
            Start at any location with contents. The session includes that
            location and all nested descendants.
          </Description>
          <div className="relative pt-2">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search location tree..."
              className="pl-9" /* tight: clears absolute search icon */
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {candidates.length === 0 ? (
            <Description className="p-4">
              No matching session roots.
            </Description>
          ) : null}
          {candidates.map(({ location, depth, hasCandidateChildren }) => {
            const sessionCount = flattenAuditableLocations(location).length;
            const expanded = expandedIds.has(location.id) || searching;
            return (
              // biome-ignore lint/a11y/useSemanticElements: This row contains a separate expand button, so it cannot be a native button.
              <div
                key={location.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(location.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(location.id);
                  }
                }}
                className="w-full border-[var(--border)] border-b bg-card py-2 pr-3 text-left transition-colors last:border-b-0 hover:bg-muted" /* tight: compact tree picker row */
              >
                <LocationTreeRow
                  location={location}
                  depth={depth}
                  compact
                  primaryMeta={locationTypeNoun(location.type)}
                  secondaryMeta={`${pluralize("location", sessionCount, true)} in session · ${pluralize("tracked item", location.totalItemCount ?? 0, true)}`}
                  leading={
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpanded(location.id);
                      }}
                      className={cn(
                        "flex h-5 w-5 items-center justify-center transition-transform",
                        !hasCandidateChildren && "invisible",
                        expanded && "rotate-90",
                      )}
                      aria-label={
                        expanded
                          ? `Collapse ${location.name}`
                          : `Expand ${location.name}`
                      }
                      disabled={!hasCandidateChildren || searching}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  }
                  trailing={
                    <Badge variant="outline">
                      {formatChildCount(location.children?.length ?? 0)}
                    </Badge>
                  }
                />
              </div>
            );
          })}
        </CardContent>
      </Card>
    </Stack>
  );
}

function formatChildCount(count: number) {
  return count === 1 ? "1 child" : `${count} children`;
}

type SessionLocationListProps = {
  parent: InfLocation;
  locations: SessionLocation[];
  currentId: LocationId | null;
  inventoryByLocation: Map<string, InventoryItem[]>;
  itemResolutions: Map<string, ItemResolution>;
  onSelect: (locationId: LocationId) => void;
  onScanJump: (locationId: string) => void;
  parentLocation: InfLocation;
};

/**
 * Shared body for the session location navigator: header (title, progress, QR
 * jump, filter) + scrollable list of locations with confirmed/total badges.
 * Rendered both in the desktop sidebar Card and inside the mobile bottom Sheet
 * so there is a single implementation of "what's left / jump to a location".
 */
function SessionLocationList({
  parent,
  locations,
  currentId,
  inventoryByLocation,
  itemResolutions,
  onSelect,
  onScanJump,
  parentLocation,
}: SessionLocationListProps) {
  const [filter, setFilter] = useState<"all" | "incomplete" | "empty">("all");
  const visible = locations.filter((location) => {
    if (filter === "incomplete") return !location.lastBulkInventory;
    if (filter === "empty") {
      return (inventoryByLocation.get(location.id)?.length ?? 0) === 0;
    }
    return true;
  });
  const completed = locations.filter((loc) => loc.lastBulkInventory).length;

  return (
    <>
      <Stack gap="sm" className="shrink-0 border-b p-4">
        <Row align="center" justify="between" gap="sm">
          <div className="min-w-0">
            <CardTitle>{parent.name}</CardTitle>
            <Description>
              {completed} complete / {locations.length} locations
            </Description>
          </div>
          <QrJumpButton parent={parentLocation} onJump={onScanJump} />
        </Row>
        <Row gap="sm" wrap>
          {(["all", "incomplete", "empty"] as const).map((key) => (
            <Button
              key={key}
              type="button"
              variant={filter === key ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(key)}
            >
              {key}
            </Button>
          ))}
        </Row>
      </Stack>
      <div className="min-h-0 flex-1 overflow-auto">
        {visible.map((location) => {
          const items = inventoryByLocation.get(location.id) ?? [];
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
                secondaryMeta={
                  <>
                    {items.length > 0 &&
                      `${pluralize("tracked item", items.length, true)} · `}
                    <AuditedHint at={location.lastBulkInventory} />
                  </>
                }
                trailing={
                  <Badge
                    variant={
                      location.lastBulkInventory ? "secondary" : "outline"
                    }
                  >
                    {confirmed}/{items.length}
                  </Badge>
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
function LocationWorkbenchSidebar(props: SessionLocationListProps) {
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
function MobileLocationSwitcher({
  currentIndex,
  ...listProps
}: SessionLocationListProps & { currentIndex: number }) {
  const [open, setOpen] = useState(false);
  const { parent, locations, onSelect, onScanJump } = listProps;
  const completed = locations.filter((loc) => loc.lastBulkInventory).length;

  return (
    <div className="sticky top-0 z-20 bg-background pb-2 lg:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-between gap-2 rounded border bg-card px-4 py-2 text-left"
        >
          <span className="min-w-0 truncate font-medium text-sm">
            {parent.name}
          </span>
          <span className="shrink-0 font-mono text-2xs text-muted-foreground uppercase tabular-nums">
            {currentIndex + 1} / {locations.length} · {completed} done
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

function LocationReviewPane({
  parent,
  location,
  position,
  items,
  childLocations,
  unknownItems,
  unknownLocations,
  itemResolutions,
  confirmedLocationIds,
  duplicateProductIds,
  onToggleVerify,
  onAdjust,
  onRemove,
  onRelocate,
  onConfirmLocation,
  onMoveLocationMissing,
  onPullUnknown,
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
  onConfirmLocation: (locationId: string) => void;
  onMoveLocationMissing: (location: InfLocation) => void;
  onPullUnknown: (item: InventoryItem) => void;
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
  const queryClient = useQueryClient();
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

  const invalidateExpectedPhotoQueries = () => {
    invalidateTRPCQueries(queryClient, inventoryMutationInvalidateKeys);
    invalidateTRPCQueries(queryClient, locationMutationInvalidateKeys);
    invalidateTRPCQueries(queryClient, productLookupMutationInvalidateKeys);
  };

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
            {location.name}
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
        currentLocationName={location.name}
        onMoveIn={onPullUnknown}
        onMoveLocationIn={onPullUnknownLocation}
        disabled={!unknownReady}
      />

      <Stack
        gap="sm"
        className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 border border-[var(--border)] bg-card p-2 shadow-[var(--shadow-chunky)] md:bottom-4"
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
        <Row gap="xs" className="shrink-0">
          <Button
            type="button"
            variant="outline"
            className="h-10 w-10 shrink-0"
            onClick={onRelocate}
            aria-label="Relocate to Unknown"
            title="Relocate to Unknown"
          >
            <ArrowRightLeft className="h-4 w-4" />
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
  confirmed,
  onConfirm,
  onMissing,
  onPhoto,
  photoPending,
}: {
  location: InfLocation;
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
    </div>
  );
}

function UnknownTray({
  items,
  locations,
  currentLocationName,
  onMoveIn,
  onMoveLocationIn,
  disabled,
}: {
  items: InventoryItem[];
  locations: InfLocation[];
  currentLocationName: string;
  onMoveIn: (item: InventoryItem) => void;
  onMoveLocationIn: (location: InfLocation) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = items.filter((item) =>
    item.product.name.toLowerCase().includes(query.toLowerCase()),
  );
  const filteredLocations = locations.filter((location) =>
    location.name.toLowerCase().includes(query.toLowerCase()),
  );
  const totalUnknownCount = items.length + locations.length;

  return (
    <Card size="sm">
      <CardHeader>
        <Row align="center" justify="between">
          <CardTitle>Unknown</CardTitle>
          <Badge variant="outline">{totalUnknownCount}</Badge>
        </Row>
      </CardHeader>
      <CardContent>
        <Stack gap="sm">
          <label className="flex min-h-12 items-center gap-2 border border-[var(--border)] px-4">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search unknown"
              className="min-w-0 flex-1 bg-transparent outline-none"
            />
          </label>
          {filtered.length === 0 && filteredLocations.length === 0 ? (
            <Description>No Unknown contents match.</Description>
          ) : (
            <Stack gap="sm" className="max-h-80 overflow-auto">
              {filteredLocations.map((location) => (
                <div
                  key={location.id}
                  className={cn(
                    "border border-[var(--border)] border-l-4 border-l-primary/60 bg-primary/5 p-2",
                    disabled && "opacity-50",
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
                  </Row>
                  <Row
                    align="center"
                    justify="between"
                    gap="sm"
                    className="mt-2"
                  >
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
                        {(location.totalItemCount ?? 0) === 1
                          ? "item"
                          : "items"}
                      </Description>
                    </Row>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-10 shrink-0"
                      disabled={disabled}
                      title={`Move into ${currentLocationName}`}
                      aria-label={`Move into ${currentLocationName}`}
                      onClick={() => onMoveLocationIn(location)}
                    >
                      <ArrowDownToLine className="h-4 w-4" />
                    </Button>
                  </Row>
                </div>
              ))}
              {filtered.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "border border-[var(--border)] border-l-4 border-l-warning/60 bg-background p-2",
                    disabled && "opacity-50",
                  )}
                >
                  <Row align="baseline" gap="xs" wrap>
                    <EntityInlineLink entity="product" data={item.product} />
                  </Row>
                  <Row
                    align="center"
                    justify="between"
                    gap="sm"
                    className="mt-2"
                  >
                    <Row align="center" gap="sm" className="min-w-0">
                      <Image
                        src={item.product.images[0]?.url}
                        alt={item.product.name}
                        displayWidth={128}
                        className="h-16 w-16 shrink-0 border border-[var(--border)] object-cover"
                      />
                      <Description size="xs" className="truncate">
                        {tryFormatAmount(item.amount)}
                      </Description>
                    </Row>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-10 shrink-0"
                      disabled={disabled}
                      title={`Move into ${currentLocationName}`}
                      aria-label={`Move into ${currentLocationName}`}
                      onClick={() => onMoveIn(item)}
                    >
                      <ArrowDownToLine className="h-4 w-4" />
                    </Button>
                  </Row>
                </div>
              ))}
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

function SessionCaptureActions({ location }: { location: SessionLocation }) {
  const api = useTRPC();
  const queryClient = useQueryClient();
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
  const invalidateCapture = (result?: unknown) => {
    const keys = [
      ...inventoryMutationInvalidateKeys,
      ...locationMutationInvalidateKeys,
      ...productLookupMutationInvalidateKeys,
    ];
    invalidateTRPCQueries(queryClient, keys);
    void watchBatchesAndInvalidate({
      queryClient,
      result,
      invalidateKeys: keys,
      fetchBatchStatus: makeBatchStatusFetcher(queryClient, api),
    });
  };

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
  const createInventory = useMutation(
    api.inventory.create.mutationOptions({
      onSuccess: (data) => {
        invalidateTRPCQueries(queryClient, inventoryMutationInvalidateKeys);
        form.reset({ product: undefined, amount: { value: 1, unit: "each" } });
        toast.success(savedWithBackgroundWork(data.sideEffects, "Added item"));
      },
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );

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
              onCreateNew={handleQuickCreate}
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

function QrJumpButton({
  parent,
  onJump,
  manualEntry = false,
}: {
  parent: InfLocation;
  onJump: (locationId: string) => void;
  manualEntry?: boolean;
}) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [isResolving, setIsResolving] = useState(false);

  const jumpToLocation = (targetId: string, label?: string) => {
    if (!isDescendantLocation(parent, targetId)) {
      // Out-of-root scan: not in this session, but offer to audit it directly
      // (a fresh session rooted there) instead of a dead end.
      toast(`${label ?? "That location"} is outside this session.`, {
        action: {
          label: "Audit it",
          onClick: () => {
            setOpen(false);
            setManualValue("");
            void navigate({
              to: "/inventory/session",
              search: { parentId: unsafeLocationId(targetId) },
            });
          },
        },
      });
      return false;
    }
    onJump(targetId);
    setOpen(false);
    setManualValue("");
    return true;
  };

  const handleLocationInput = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const parsed = extractShortcodeFromScan(raw);
    if (!parsed) {
      const id = parseLocationIdFromInput(trimmed);
      if (!id) {
        toast.error("Enter a location shortcode or UUID.");
        return;
      }
      jumpToLocation(id);
      return;
    }

    if (parsed.type !== "location") {
      toast.error("Not a location code.");
      return;
    }

    setIsResolving(true);
    try {
      const location = await queryClient.fetchQuery(
        api.location.getByShortcode.queryOptions({
          shortcode: parsed.shortcode,
        }),
      );
      if (!location) {
        toast.error("No location found for that shortcode.");
        return;
      }
      jumpToLocation(location.id, location.name);
    } catch (error) {
      toast.error(`Location lookup failed: ${getErrorMessage(error)}`);
    } finally {
      setIsResolving(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {manualEntry && (
        <form
          className="hidden items-center gap-1 lg:flex"
          onSubmit={(event) => {
            event.preventDefault();
            void handleLocationInput(manualValue);
          }}
        >
          <Input
            value={manualValue}
            onChange={(event) => setManualValue(event.target.value)}
            placeholder="Shortcode / UUID"
            className="h-9 w-44 text-xs"
            aria-label="Paste location shortcode or UUID"
          />
          <Button
            type="submit"
            variant="outline"
            className="min-h-9 px-3 text-xs" /* tight: desktop jump form */
            disabled={isResolving || manualValue.trim().length === 0}
          >
            Jump
          </Button>
        </form>
      )}
      <Button
        type="button"
        variant="outline"
        className="min-h-12 px-4"
        onClick={() => setOpen(true)}
      >
        <QrCode className="h-4 w-4" />
        Scan location
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>Scan location QR</SheetTitle>
            <SheetDescription>
              Jump to a location in this session.
            </SheetDescription>
          </SheetHeader>
          <PersistentScanner
            onScan={(value) => void handleLocationInput(value)}
            formatsToSupport={QR_CODE_FORMATS}
            scanHintText="Point at location QR code"
          />
          <Row
            as="form"
            align="center"
            gap="sm"
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleLocationInput(manualValue);
            }}
          >
            <Input
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
              placeholder="Can't scan? Shortcode / UUID"
              className="h-9 flex-1 text-xs"
              aria-label="Enter location shortcode or UUID"
            />
            <Button
              type="submit"
              variant="outline"
              className="min-h-9 px-3 text-xs" /* tight: manual jump fallback */
              disabled={isResolving || manualValue.trim().length === 0}
            >
              Jump
            </Button>
          </Row>
        </SheetContent>
      </Sheet>
    </div>
  );
}
