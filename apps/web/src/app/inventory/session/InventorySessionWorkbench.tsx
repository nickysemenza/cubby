import type { DetectedItem } from "@cubby/schemas/ai";
import type { Amount } from "@cubby/schemas/codec";
import {
  type LocationId,
  locationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type { AllowedImageType } from "@cubby/schemas/image";
import type { InventoryWithLocationAndProductOut } from "@cubby/schemas/inventory";
import type { InfLocation } from "@cubby/schemas/location";
import { extractShortcodeFromScan } from "@cubby/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Barcode,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Package,
  PackagePlus,
  Plus,
  QrCode,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DialogCompatibleCombobox } from "~/app/_components/combobox/combobox-dialog";
import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { WithProductSearch } from "~/app/_components/combobox/with-search-hook";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import {
  getProductId,
  requiredProductField,
} from "~/app/_components/form-fields";
import { ComboboxField } from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { useUpcLookup } from "~/app/_components/inventory/hooks";
import {
  BARCODE_FORMATS,
  PersistentScanner,
  QR_CODE_FORMATS,
} from "~/app/_components/inventory/persistent-scanner";
import {
  LocationBreadcrumb,
  locationToSegments,
} from "~/app/_components/locations/location-breadcrumb";
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
import { watchBatchesAndInvalidate } from "~/lib/background-batch-polling";
import { getErrorMessage } from "~/lib/error-utils";
import {
  invalidateTRPCQueries,
  inventoryMutationInvalidateKeys,
  locationMutationInvalidateKeys,
  productLookupMutationInvalidateKeys,
} from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import {
  confirmationKey,
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
  id: string;
  label: string;
  run: () => Promise<void>;
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

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ancestorSegments(location: InfLocation) {
  return locationToSegments(location).slice(0, -1);
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

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
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
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);

  useEffect(() => {
    if (sessionLocations.length === 0) {
      setCurrentIndex(0);
      return;
    }
    const firstIncomplete = sessionLocations.findIndex(
      (loc) => !loc.lastBulkInventory,
    );
    setCurrentIndex(firstIncomplete >= 0 ? firstIncomplete : 0);
    setConfirmedIds(new Set());
  }, [sessionLocations]);

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
        fetchBatchStatus: (batchId) =>
          queryClient
            .fetchQuery({
              ...api.backgroundJobs.getBatch.queryOptions({ batchId }),
              staleTime: 0,
            })
            .then((batch) => batch.status),
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
  const updateInventory = useMutation(
    api.inventory.update.mutationOptions({
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
  const touchLocation = useMutation(
    api.location.touchLastBulkInventory.mutationOptions({
      onSuccess: () => {
        invalidateSession();
        const noun = currentLocation
          ? locationTypeNoun(currentLocation.type)
          : "location";
        toast.success(`${sentenceCase(noun)} marked complete.`);
      },
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );

  const pushUndo = (action: UndoAction) =>
    setUndoStack((prev) => [action, ...prev].slice(0, 5));

  const runUndo = async (action: UndoAction) => {
    try {
      await action.run();
      setUndoStack((prev) => prev.filter((item) => item.id !== action.id));
      toast.success("Undone.");
    } catch (error) {
      toast.error(`Undo failed: ${getErrorMessage(error)}`);
    }
  };

  const moveItem = async ({
    item,
    sourceLocationId,
    targetLocationId,
    undoLabel,
    success,
  }: {
    item: InventoryItem;
    sourceLocationId: LocationId;
    targetLocationId: LocationId;
    undoLabel: string;
    success: string;
  }) => {
    await bulkMove.mutateAsync({
      sourceLocationId,
      targetLocationId,
      items: [{ inventoryEntryId: item.id, quantity: item.amount }],
    });
    pushUndo({
      id: crypto.randomUUID(),
      label: undoLabel,
      run: async () => {
        await bulkMove.mutateAsync({
          sourceLocationId: targetLocationId,
          targetLocationId: sourceLocationId,
          items: [{ inventoryEntryId: item.id, quantity: item.amount }],
        });
      },
    });
    toast.success(success);
  };

  const moveToUnknown = async (item: InventoryItem) => {
    if (!currentLocation || !unknownLocation) return;
    await moveItem({
      item,
      sourceLocationId: currentLocation.id,
      targetLocationId: unknownLocation.id,
      undoLabel: `Move ${item.product.name} back to ${currentLocation.name}`,
      success: `Moved ${item.product.name} to Unknown.`,
    });
  };

  const pullFromUnknown = async (item: InventoryItem) => {
    if (!currentLocation || !unknownLocation) return;
    await moveItem({
      item,
      sourceLocationId: unknownLocation.id,
      targetLocationId: currentLocation.id,
      undoLabel: `Move ${item.product.name} back to Unknown`,
      success: `Moved ${item.product.name} into ${currentLocation.name}.`,
    });
  };

  const moveLocationToUnknown = async (location: InfLocation) => {
    if (!currentLocation || !unknownLocation) return;
    await updateLocation.mutateAsync({
      id: location.id,
      data: { parentId: unknownLocation.id },
    });
    pushUndo({
      id: crypto.randomUUID(),
      label: `Move ${location.name} back to ${currentLocation.name}`,
      run: async () => {
        await updateLocation.mutateAsync({
          id: location.id,
          data: { parentId: currentLocation.id },
        });
      },
    });
    toast.success(`Moved ${location.name} to Unknown.`);
  };

  const pullLocationFromUnknown = async (location: InfLocation) => {
    if (!currentLocation || !unknownLocation) return;
    await updateLocation.mutateAsync({
      id: location.id,
      data: { parentId: currentLocation.id },
    });
    pushUndo({
      id: crypto.randomUUID(),
      label: `Move ${location.name} back to Unknown`,
      run: async () => {
        await updateLocation.mutateAsync({
          id: location.id,
          data: { parentId: unknownLocation.id },
        });
      },
    });
    toast.success(`Moved ${location.name} into ${currentLocation.name}.`);
  };

  const markConfirmed = (itemId: string) => {
    setConfirmedIds((prev) => new Set(prev).add(itemId));
  };

  const handleQuantityChange = async (item: InventoryItem, amount: Amount) => {
    await updateInventory.mutateAsync({
      id: item.id,
      data: { amount },
    });
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

  if (treeLoading || ensureUnknown.isPending) {
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
    <Stack gap="md" className="min-w-0 pb-24 md:pb-0">
      {undoStack.length > 0 && (
        <UndoBar action={undoStack[0]!} onUndo={runUndo} />
      )}

      <div className="grid min-h-[calc(100dvh-10rem)] min-w-0 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
        <LocationWorkbenchSidebar
          parent={parent}
          locations={sessionLocations}
          currentId={currentLocation?.id ?? null}
          inventoryByLocation={inventoryByLocation}
          confirmedIds={confirmedIds}
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
            confirmedIds={confirmedIds}
            onConfirm={(itemId) =>
              markConfirmed(confirmationKey("inventory", itemId))
            }
            onConfirmLocation={(locationId) =>
              markConfirmed(confirmationKey("location", locationId))
            }
            onMoveMissing={moveToUnknown}
            onMoveLocationMissing={moveLocationToUnknown}
            onPullUnknown={pullFromUnknown}
            onPullUnknownLocation={pullLocationFromUnknown}
            onQuantityChange={handleQuantityChange}
            onPrevious={() => setCurrentIndex((idx) => Math.max(0, idx - 1))}
            onNext={() =>
              setCurrentIndex((idx) =>
                Math.min(sessionLocations.length - 1, idx + 1),
              )
            }
            onMarkComplete={() =>
              touchLocation.mutate({ id: currentLocation.id })
            }
            onJumpByScan={(id) => {
              if (!jumpToLocation(id)) {
                toast.error("That location is not in this session.");
              }
            }}
            canPrevious={currentIndex > 0}
            canNext={currentIndex < sessionLocations.length - 1}
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
                  secondaryMeta={`${pluralize(sessionCount, "location")} in session · ${pluralize(location.totalItemCount ?? 0, "tracked item")}`}
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

function LocationWorkbenchSidebar({
  parent,
  locations,
  currentId,
  inventoryByLocation,
  confirmedIds,
  onSelect,
  onScanJump,
  parentLocation,
}: {
  parent: InfLocation;
  locations: SessionLocation[];
  currentId: LocationId | null;
  inventoryByLocation: Map<string, InventoryItem[]>;
  confirmedIds: Set<string>;
  onSelect: (locationId: LocationId) => void;
  onScanJump: (locationId: string) => void;
  parentLocation: InfLocation;
}) {
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
    <Card className="hidden overflow-hidden lg:sticky lg:top-20 lg:flex lg:h-[calc(100dvh-6rem)] lg:flex-col">
      <CardHeader className="shrink-0 border-b p-4">
        <Row align="center" justify="between" gap="sm">
          <div className="min-w-0">
            <CardTitle>{parent.name}</CardTitle>
            <Description>
              {completed} complete / {locations.length} locations
            </Description>
          </div>
          <QrJumpButton parent={parentLocation} onJump={onScanJump} />
        </Row>
        <Row gap="sm" wrap className="pt-2">
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
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto p-0">
        {visible.map((location) => {
          const items = inventoryByLocation.get(location.id) ?? [];
          const confirmed = items.filter((item) =>
            confirmedIds.has(confirmationKey("inventory", item.id)),
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
                  items.length > 0
                    ? pluralize(items.length, "tracked item")
                    : undefined
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
      </CardContent>
    </Card>
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
  confirmedIds,
  onConfirm,
  onConfirmLocation,
  onMoveMissing,
  onMoveLocationMissing,
  onPullUnknown,
  onPullUnknownLocation,
  onQuantityChange,
  onPrevious,
  onNext,
  onMarkComplete,
  onJumpByScan,
  canPrevious,
  canNext,
  unknownReady,
}: {
  parent: InfLocation;
  location: SessionLocation;
  position: { index: number; total: number };
  items: InventoryItem[];
  childLocations: InfLocation[];
  unknownItems: InventoryItem[];
  unknownLocations: InfLocation[];
  confirmedIds: Set<string>;
  onConfirm: (itemId: string) => void;
  onConfirmLocation: (locationId: string) => void;
  onMoveMissing: (item: InventoryItem) => void;
  onMoveLocationMissing: (location: InfLocation) => void;
  onPullUnknown: (item: InventoryItem) => void;
  onPullUnknownLocation: (location: InfLocation) => void;
  onQuantityChange: (item: InventoryItem, amount: Amount) => void;
  onPrevious: () => void;
  onNext: () => void;
  onMarkComplete: () => void;
  onJumpByScan: (locationId: string) => void;
  canPrevious: boolean;
  canNext: boolean;
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
    <Stack gap="md" className="min-w-0">
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
      <div className="sticky top-0 z-20 border-b bg-background/95 py-2 backdrop-blur md:static md:border-b-0 md:bg-transparent md:py-0">
        <Row align="center" justify="between" gap="sm">
          <Button
            type="button"
            variant="outline"
            className="min-h-12 px-4 lg:hidden"
            onClick={onPrevious}
            disabled={!canPrevious}
            aria-label="Previous location"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1 text-center md:text-left">
            <Description size="xs">
              {position.index + 1} of {position.total} in {parent.name}
            </Description>
            <h2 className="truncate font-heading font-semibold text-xl">
              {location.name}
            </h2>
            <Badge variant="outline" className="mt-1 md:hidden">
              Session: {parent.name} subtree
            </Badge>
            {breadcrumbSegments.length > 0 ? (
              <LocationBreadcrumb
                segments={breadcrumbSegments}
                showHome
                linkable
                compact
                activeHighlight
                className="mx-auto mt-1 max-w-full justify-center text-xs md:mx-0 md:justify-start"
              />
            ) : isSessionRoot && position.total > 1 ? (
              <Description size="2xs" className="mt-1">
                Session root · includes descendants
              </Description>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-12 px-4 lg:hidden"
            onClick={onNext}
            disabled={!canNext}
            aria-label="Next location"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Row>
      </div>

      <Card>
        <CardContent className="p-4 lg:p-6">
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

      <Card>
        <CardHeader className="p-4 pb-2">
          <CardTitle>Expected contents</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
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
                  confirmed={confirmedIds.has(
                    confirmationKey("location", child.id),
                  )}
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
                  confirmed={confirmedIds.has(
                    confirmationKey("inventory", item.id),
                  )}
                  onConfirm={() => onConfirm(item.id)}
                  onMissing={() => onMoveMissing(item)}
                  onQuantityChange={(amount) => onQuantityChange(item, amount)}
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

      <div className="sticky bottom-20 z-20 flex flex-col gap-2 border border-[var(--border)] bg-card p-2 shadow-[var(--shadow-chunky)] md:bottom-4 md:flex-row md:items-center md:justify-between">
        <Row gap="sm">
          <Button
            type="button"
            variant="outline"
            className="min-h-12 flex-1 px-4 md:flex-none"
            onClick={onPrevious}
            disabled={!canPrevious}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-12 flex-1 px-4 md:flex-none"
            onClick={onNext}
            disabled={!canNext}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Row>
        <Button
          type="button"
          className="min-h-12 px-4"
          onClick={onMarkComplete}
        >
          <Check className="h-4 w-4" />
          Mark {locationNoun} complete
        </Button>
      </div>
    </Stack>
  );
}

function ExpectedItemReviewRow({
  item,
  confirmed,
  onConfirm,
  onMissing,
  onQuantityChange,
  onPhoto,
  photoPending,
}: {
  item: InventoryItem;
  confirmed: boolean;
  onConfirm: () => void;
  onMissing: () => void;
  onQuantityChange: (amount: Amount) => void;
  onPhoto: () => void;
  photoPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const form = useForm<{ amount: Amount }>({
    defaultValues: { amount: item.amount },
  });

  useEffect(() => {
    form.reset({ amount: item.amount });
  }, [form, item.amount]);

  return (
    <div
      className={cn(
        "border border-[var(--border)] border-l-4 border-l-warning/60 bg-background p-3" /* tight: dense expected product row */,
        confirmed && "border-positive/40 bg-positive/5",
      )}
    >
      <div
        className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center" /* tight: dense expected product row */
      >
        <Row align="center" gap="sm" className="min-w-0">
          <div className="relative shrink-0">
            <Image
              src={item.product.images[0]?.url}
              alt={item.product.name}
              displayWidth={96}
              className="h-14 w-14 border border-[var(--border)] object-cover"
            />
            <span className="absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center border border-warning/40 bg-warning/15 text-warning">
              <Package className="h-3.5 w-3.5" />
            </span>
          </div>
          <Row align="center" gap="xs" wrap className="min-w-0 flex-1">
            <Badge variant="warning">
              <Package className="h-3 w-3" />
              Product
            </Badge>
            <EntityInlineLink entity="product" data={item.product} compact />
            <Description as="span" size="xs">
              {tryFormatAmount(item.amount)}
            </Description>
            <EntityInlineLink
              entity="inventory"
              data={{ id: item.id, name: "Inventory entry" }}
              compact
            />
            {confirmed && <Badge variant="secondary">confirmed</Badge>}
          </Row>
        </Row>
        {editing ? (
          <Stack gap="sm" className="lg:col-span-2">
            <AmountFieldGroup
              form={form}
              valuePath="amount.value"
              unitPath="amount.unit"
              compact
            />
            <Row gap="sm">
              <Button
                type="button"
                className="min-h-12 flex-1 lg:flex-none"
                onClick={() => {
                  onQuantityChange(form.getValues("amount"));
                  setEditing(false);
                }}
              >
                Save quantity
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-12"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </Row>
          </Stack>
        ) : (
          <div className="grid grid-cols-2 gap-2 lg:w-[28rem] lg:grid-cols-[auto_auto_1fr_1fr]">
            <Button
              type="button"
              variant="outline"
              className="min-h-12 text-sm lg:min-h-10"
              onClick={onPhoto}
              disabled={photoPending}
            >
              {photoPending ? <Spinner /> : <Camera className="h-4 w-4" />}
              Photo
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-12 lg:min-h-10"
              onClick={() => setEditing(true)}
            >
              Qty
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-12 border-positive/40 bg-positive/10 text-positive text-sm hover:bg-positive/20 hover:text-positive lg:min-h-10"
              onClick={onConfirm}
            >
              <Check className="h-4 w-4" />
              Yes
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-12 text-sm lg:min-h-10"
              onClick={onMissing}
            >
              <X className="h-4 w-4" />
              No
            </Button>
          </div>
        )}
      </div>
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
        "border border-[var(--border)] border-l-4 border-l-primary/60 bg-primary/5 p-3" /* tight: dense expected location row */,
        confirmed && "border-positive/40 bg-positive/5",
      )}
    >
      <div
        className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-center" /* tight: dense expected location row */
      >
        <Row align="center" gap="sm" className="min-w-0">
          <div className="relative flex h-14 w-14 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
            {location.images[0]?.url ? (
              <Image
                src={location.images[0].url}
                alt={location.name}
                displayWidth={96}
                className="h-full w-full object-cover"
              />
            ) : (
              <LocationIcon type={location.type} size={22} />
            )}
            <span className="absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center border border-primary/40 bg-background text-primary">
              <LocationIcon type={location.type} size={14} />
            </span>
          </div>
          <Row align="center" gap="xs" wrap className="min-w-0 flex-1">
            <Badge variant="default">
              <LocationIcon type={location.type} size={12} />
              Location
            </Badge>
            <EntityInlineLink
              entity="location"
              data={{
                id: location.id,
                name: location.name,
                type: location.type,
              }}
              compact
            />
            <Description as="span" size="xs">
              {location.children?.length ?? 0} child locations ·{" "}
              {location.totalItemCount ?? 0} tracked items
            </Description>
            {confirmed && <Badge variant="secondary">confirmed</Badge>}
          </Row>
        </Row>
        <div className="grid grid-cols-3 gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-12 text-sm lg:min-h-10"
            onClick={onPhoto}
            disabled={photoPending}
          >
            {photoPending ? <Spinner /> : <Camera className="h-4 w-4" />}
            Photo
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-12 border-positive/40 bg-positive/10 text-positive text-sm hover:bg-positive/20 hover:text-positive lg:min-h-10"
            onClick={onConfirm}
          >
            <Check className="h-4 w-4" />
            Yes
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-12 text-sm lg:min-h-10"
            onClick={onMissing}
          >
            <X className="h-4 w-4" />
            No
          </Button>
        </div>
      </div>
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
    <Card>
      <CardHeader className="p-4 pb-2">
        <Row align="center" justify="between">
          <CardTitle>Unknown</CardTitle>
          <Badge variant="outline">{totalUnknownCount}</Badge>
        </Row>
      </CardHeader>
      <CardContent className="p-4 pt-0">
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
              {filteredLocations.map((location) => {
                const ancestors = ancestorSegments(location);
                return (
                  <div
                    key={location.id}
                    className={cn(
                      "min-h-16 border border-[var(--border)] border-l-4 border-l-primary/60 bg-primary/5 p-3" /* tight: dense unknown location row */,
                      disabled && "opacity-50",
                    )}
                  >
                    <Row align="center" justify="between" gap="sm">
                      <Row align="center" gap="sm" className="min-w-0 flex-1">
                        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
                          {location.images[0]?.url ? (
                            <Image
                              src={location.images[0].url}
                              alt={location.name}
                              displayWidth={80}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <LocationIcon type={location.type} size={20} />
                          )}
                          <span className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center border border-primary/40 bg-background text-primary">
                            <LocationIcon type={location.type} size={12} />
                          </span>
                        </div>
                        <div className="min-w-0 space-y-1">
                          <Row align="center" gap="xs" wrap>
                            <Badge variant="default">
                              <LocationIcon type={location.type} size={12} />
                              Location
                            </Badge>
                            <EntityInlineLink
                              entity="location"
                              data={{
                                id: location.id,
                                name: location.name,
                                type: location.type,
                              }}
                              compact
                            />
                          </Row>
                          {ancestors.length > 0 && (
                            <LocationBreadcrumb segments={ancestors} compact />
                          )}
                          <Description size="xs">
                            {location.children?.length ?? 0} child locations ·{" "}
                            {location.totalItemCount ?? 0} tracked items
                          </Description>
                        </div>
                      </Row>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={disabled}
                        onClick={() => onMoveLocationIn(location)}
                      >
                        <span className="max-w-36 truncate">
                          Move into {currentLocationName}
                        </span>
                      </Button>
                    </Row>
                  </div>
                );
              })}
              {filtered.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    "min-h-16 border border-[var(--border)] border-l-4 border-l-warning/60 bg-background p-3" /* tight: dense unknown product row */,
                    disabled && "opacity-50",
                  )}
                >
                  <Row align="center" justify="between" gap="sm">
                    <Row align="center" gap="sm" className="min-w-0 flex-1">
                      <div className="relative shrink-0">
                        <Image
                          src={item.product.images[0]?.url}
                          alt={item.product.name}
                          displayWidth={80}
                          className="h-12 w-12 border border-[var(--border)] object-cover"
                        />
                        <span className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center border border-warning/40 bg-warning/15 text-warning">
                          <Package className="h-3 w-3" />
                        </span>
                      </div>
                      <div className="min-w-0 space-y-1">
                        <Row align="center" gap="xs" wrap>
                          <Badge variant="warning">
                            <Package className="h-3 w-3" />
                            Product
                          </Badge>
                          <EntityInlineLink
                            entity="product"
                            data={item.product}
                            compact
                          />
                        </Row>
                        <Row gap="sm" wrap>
                          <Description size="xs">
                            {tryFormatAmount(item.amount)}
                          </Description>
                          <EntityInlineLink
                            entity="inventory"
                            data={{ id: item.id, name: "Inventory entry" }}
                            compact
                          />
                        </Row>
                      </div>
                    </Row>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={disabled}
                      onClick={() => onMoveIn(item)}
                    >
                      <span className="max-w-36 truncate">
                        Move into {currentLocationName}
                      </span>
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
  const [suggestions, setSuggestions] = useState<DetectedItem[]>([]);
  const [suggestionProductOverrides, setSuggestionProductOverrides] = useState<
    Record<number, ComboboxItem | null>
  >({});
  const [detectionCacheStatus, setDetectionCacheStatus] = useState<
    "hit" | "miss" | null
  >(null);

  const invalidateSession = () => {
    invalidateTRPCQueries(queryClient, inventoryMutationInvalidateKeys);
    invalidateTRPCQueries(queryClient, locationMutationInvalidateKeys);
    invalidateTRPCQueries(queryClient, productLookupMutationInvalidateKeys);
  };

  const uploadImage = useMutation(api.image.uploadImage.mutationOptions());
  const updateLocation = useMutation(
    api.location.update.mutationOptions({
      onSuccess: () => {
        invalidateSession();
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
        invalidateSession();
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
      onSuccess: invalidateSession,
      onError: (error) => toast.error(getErrorMessage(error)),
    }),
  );
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
    const created = await createInventory.mutateAsync({
      productId: product.id,
      locationId: location.id,
      amount: { value: 1, unit: "each" },
    });
    toast.success(
      savedWithBackgroundWork(created.sideEffects, `Added ${product.name}`),
    );
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
        onOpenChange={(open) => !open && setScanner(null)}
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
              void handleBarcode(barcode);
              setScanner(null);
            }}
            enabled={!upcPending && scanner === "barcode"}
            formatsToSupport={BARCODE_FORMATS}
            scanHintText="Point at barcode"
          />
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
          {({
            items,
            onSearchChange,
            isLoading,
            onCreateNew,
            onOpenChange,
          }) => (
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
  const [open, setOpen] = useState(false);
  const [manualValue, setManualValue] = useState("");
  const [isResolving, setIsResolving] = useState(false);

  const jumpToLocation = (targetId: string) => {
    if (!isDescendantLocation(parent, targetId)) {
      toast.error("That location is outside this session.");
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
      jumpToLocation(location.id);
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
        </SheetContent>
      </Sheet>
    </div>
  );
}

function UndoBar({
  action,
  onUndo,
}: {
  action: UndoAction;
  onUndo: (action: UndoAction) => void;
}) {
  return (
    <Row
      align="center"
      justify="between"
      gap="sm"
      className="sticky top-2 z-30 border border-[var(--border)] bg-card p-2 shadow-[var(--shadow-chunky)]"
    >
      <span className="min-w-0 truncate text-sm">{action.label}</span>
      <Button
        type="button"
        variant="outline"
        className="min-h-12 px-4"
        onClick={() => onUndo(action)}
      >
        <RotateCcw className="h-4 w-4" />
        Undo
      </Button>
    </Row>
  );
}
