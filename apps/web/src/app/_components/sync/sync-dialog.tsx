"use client";

import { useState } from "react";
import Link from "next/link";
import { useTRPC } from "~/trpc/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Loader2,
  Plus,
  ArrowRightLeft,
  AlertCircle,
  CheckCircle2,
  Pencil,
  GitCompare,
  MapPin,
} from "lucide-react";
import {
  type SyncState,
  type SyncResolution,
  type LocationSyncItem,
  type InventorySyncItem,
  type SyncPreviewResult,
} from "~/schemas/sync";
import { queryKeys } from "~/lib/query-keys";
import { ValueChange } from "../value-change";
import { NoneState } from "../NoneState";
import { entities } from "~/entities/entities";

// Convert resolution to which side is selected (for visual feedback)
const getSelectedSide = (
  resolution: SyncResolution | undefined,
): "from" | "to" | undefined => {
  if (resolution === "use_app") return "to";
  if (resolution === "use_sheet") return "from";
  return undefined;
};

// State styles and labels
const getSyncStateStyles = (state: SyncState) => {
  switch (state) {
    case "matched":
      return {
        bg: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
        icon: <CheckCircle2 className="h-3 w-3" />,
        label: "Matched",
      };
    case "conflict":
      return {
        bg: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
        icon: <GitCompare className="h-3 w-3" />,
        label: "Conflict",
      };
    case "app_only":
      return {
        bg: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
        icon: <Plus className="h-3 w-3" />,
        label: "App Only",
      };
    case "sheet_only":
      return {
        bg: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
        icon: <Plus className="h-3 w-3" />,
        label: "Sheet Only",
      };
    case "renamed":
      return {
        bg: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
        icon: <Pencil className="h-3 w-3" />,
        label: "Renamed",
      };
    case "moved":
      return {
        bg: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
        icon: <ArrowRightLeft className="h-3 w-3" />,
        label: "Moved",
      };
  }
};

// Resolution options based on state
const getResolutionOptions = (
  state: SyncState,
): { value: SyncResolution; label: string }[] => {
  switch (state) {
    case "matched":
      return [];
    case "conflict":
      return [
        { value: "use_app", label: "Use App Version" },
        { value: "use_sheet", label: "Use Sheet Version" },
      ];
    case "app_only":
      return [
        { value: "add_to_sheet", label: "Add to Sheet" },
        { value: "delete_from_app", label: "Delete from App" },
      ];
    case "sheet_only":
      return [
        { value: "add_to_app", label: "Add to App" },
        { value: "delete_from_sheet", label: "Delete from Sheet" },
      ];
    case "renamed":
      return [];
    case "moved":
      return [
        { value: "apply_move", label: "Apply Move" },
        { value: "use_app", label: "Keep App Location" },
        { value: "use_sheet", label: "Keep Sheet Location" },
      ];
  }
};

type HiddenStates = Set<SyncState>;
const DEFAULT_HIDDEN_STATES: HiddenStates = new Set(["matched"]);

const LOCATION_STATES: SyncState[] = [
  "matched",
  "conflict",
  "app_only",
  "sheet_only",
  "renamed",
];
const INVENTORY_STATES: SyncState[] = [...LOCATION_STATES, "moved"];

type LocationCounts = SyncPreviewResult["locations"];
type InventoryCounts = SyncPreviewResult["inventory"];

const getLocationCount = (counts: LocationCounts, state: SyncState): number => {
  switch (state) {
    case "matched":
      return counts.matched;
    case "conflict":
      return counts.conflicts;
    case "app_only":
      return counts.appOnly;
    case "sheet_only":
      return counts.sheetOnly;
    case "renamed":
      return counts.renamed;
    case "moved":
      return 0;
  }
};

const getInventoryCount = (
  counts: InventoryCounts,
  state: SyncState,
): number => {
  switch (state) {
    case "matched":
      return counts.matched;
    case "conflict":
      return counts.conflicts;
    case "app_only":
      return counts.appOnly;
    case "sheet_only":
      return counts.sheetOnly;
    case "renamed":
      return counts.renamed;
    case "moved":
      return counts.moved;
  }
};

type SyncDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  previewResult: SyncPreviewResult | null;
  onClose: () => void;
  onSyncComplete: () => void;
};

// Helper to extract initial resolutions from preview result
const extractInitialResolutions = (
  previewResult: SyncPreviewResult | null,
): {
  location: Record<string, SyncResolution>;
  inventory: Record<string, SyncResolution>;
} => {
  if (!previewResult) return { location: {}, inventory: {} };

  const location: Record<string, SyncResolution> = {};
  for (const item of previewResult.locations.items) {
    if (item.resolution) {
      location[item.key] = item.resolution;
    }
  }

  const inventory: Record<string, SyncResolution> = {};
  for (const item of previewResult.inventory.items) {
    if (item.resolution) {
      inventory[item.key] = item.resolution;
    }
  }

  return { location, inventory };
};

export const SyncDialog = ({
  open,
  onOpenChange,
  previewResult,
  onClose,
  onSyncComplete,
}: SyncDialogProps) => {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [isComplete, setIsComplete] = useState(false);

  // Initialize resolutions from preview result defaults
  const initialResolutions = extractInitialResolutions(previewResult);
  const [locationResolutions, setLocationResolutions] = useState<
    Record<string, SyncResolution>
  >(initialResolutions.location);
  const [inventoryResolutions, setInventoryResolutions] = useState<
    Record<string, SyncResolution>
  >(initialResolutions.inventory);
  const [hiddenStates, setHiddenStates] = useState<HiddenStates>(
    () => new Set(DEFAULT_HIDDEN_STATES),
  );

  // Reset resolutions when preview result changes (key-based reset)
  const previewKey = previewResult
    ? `${previewResult.locations.items.length}-${previewResult.inventory.items.length}`
    : null;

  // Use key to detect when we need to reinitialize
  const [lastPreviewKey, setLastPreviewKey] = useState<string | null>(null);
  if (previewKey !== lastPreviewKey && previewResult) {
    setLastPreviewKey(previewKey);
    const resolutions = extractInitialResolutions(previewResult);
    setLocationResolutions(resolutions.location);
    setInventoryResolutions(resolutions.inventory);
    setIsComplete(false);
  }

  // Reset hidden states when dialog closes (using key pattern)
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen && !open) {
    setWasOpen(false);
    setHiddenStates(new Set(DEFAULT_HIDDEN_STATES));
  } else if (!wasOpen && open) {
    setWasOpen(true);
  }

  const applySyncMutation = useMutation(
    api.googleSheets.applySync.mutationOptions({
      onSuccess: (result) => {
        if (result.success) {
          setIsComplete(true);
          queryClient.invalidateQueries({
            queryKey: queryKeys.inventoryItem.list,
          });
          queryClient.invalidateQueries({ queryKey: queryKeys.product.list });
          queryClient.invalidateQueries({ queryKey: queryKeys.location.list });

          const locTotal =
            result.locations.created +
            result.locations.updated +
            result.locations.deleted;
          const invTotal =
            result.inventory.created +
            result.inventory.updated +
            result.inventory.deleted +
            result.inventory.moved;

          toast.success(
            `Sync complete: ${locTotal + invTotal} items processed`,
          );
          onSyncComplete();
        } else {
          toast.error(
            `Sync failed: ${result.errorMessages.join(", ") || "Unknown error"}`,
          );
        }
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const handleApply = () => {
    applySyncMutation.mutate({
      locationResolutions,
      inventoryResolutions,
    });
  };

  const handleClose = () => {
    onClose();
    onOpenChange(false);
  };

  const toggleStateVisibility = (state: SyncState) => {
    setHiddenStates((prev) => {
      const next = new Set(prev);
      if (next.has(state)) {
        next.delete(state);
      } else {
        next.add(state);
      }
      return next;
    });
  };

  const updateLocationResolution = (
    key: string,
    resolution: SyncResolution,
  ) => {
    setLocationResolutions((prev) => ({ ...prev, [key]: resolution }));
  };

  const updateInventoryResolution = (
    key: string,
    resolution: SyncResolution,
  ) => {
    setInventoryResolutions((prev) => ({ ...prev, [key]: resolution }));
  };

  const hasUnresolvedConflicts = previewResult
    ? previewResult.locations.items.some(
        (item) => item.state === "conflict" && !locationResolutions[item.key],
      ) ||
      previewResult.inventory.items.some(
        (item) => item.state === "conflict" && !inventoryResolutions[item.key],
      )
    : false;

  const activeValidationErrors = previewResult
    ? previewResult.validationErrors.filter((err) => {
        if (err.entityType === "location" && err.itemKey) {
          return !locationResolutions[err.itemKey];
        }
        if (err.entityType === "inventory" && err.itemKey) {
          return !inventoryResolutions[err.itemKey];
        }
        return true;
      })
    : [];

  const canApply =
    previewResult &&
    !hasUnresolvedConflicts &&
    activeValidationErrors.length === 0;

  const isApplying = applySyncMutation.isPending;

  // Show loading state if no preview result yet
  if (!previewResult) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90vh] !w-[95vw] !max-w-[95vw] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Loading Sync Preview...</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] !w-[95vw] !max-w-[95vw] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {isComplete ? "Sync Complete" : "Sync Preview"}
          </DialogTitle>
          <DialogDescription>
            {isComplete
              ? "Changes have been applied successfully."
              : "Review and resolve differences between app and Google Sheet."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {activeValidationErrors.length > 0 && !isComplete && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950">
              <div className="mb-2 flex items-center gap-2 font-medium text-red-700 dark:text-red-300">
                <AlertCircle className="h-4 w-4" />
                Validation Errors
              </div>
              <ul className="list-inside list-disc space-y-1 text-sm text-red-600 dark:text-red-400">
                {activeValidationErrors.map((err, i) => (
                  <li key={i}>{err.message}</li>
                ))}
              </ul>
            </div>
          )}

          {isComplete && (
            <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
              <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                <CheckCircle2 className="h-4 w-4" />
                <span className="font-medium">Sync completed successfully</span>
              </div>
            </div>
          )}

          {previewResult.locations.items.length > 0 && (
            <>
              <h3 className="mb-2 text-sm font-medium">
                <MapPin className="mr-1 inline h-4 w-4" />
                Locations
              </h3>
              <div className="mb-4 flex flex-wrap gap-1.5 text-sm">
                {LOCATION_STATES.map((state) => (
                  <StateSummaryCard
                    key={state}
                    count={getLocationCount(previewResult.locations, state)}
                    state={state}
                    isHidden={hiddenStates.has(state)}
                    onClick={() => toggleStateVisibility(state)}
                  />
                ))}
              </div>

              <LocationSyncTable
                items={previewResult.locations.items}
                hiddenStates={hiddenStates}
                resolutions={locationResolutions}
                onResolutionChange={updateLocationResolution}
                isComplete={isComplete}
              />
            </>
          )}

          {previewResult.inventory.items.length > 0 && (
            <>
              <h3 className="mt-4 mb-2 text-sm font-medium">Inventory</h3>
              <div className="mb-4 flex flex-wrap gap-1.5 text-sm">
                {INVENTORY_STATES.map((state) => (
                  <StateSummaryCard
                    key={state}
                    count={getInventoryCount(previewResult.inventory, state)}
                    state={state}
                    isHidden={hiddenStates.has(state)}
                    onClick={() => toggleStateVisibility(state)}
                  />
                ))}
              </div>

              <InventorySyncTable
                items={previewResult.inventory.items}
                hiddenStates={hiddenStates}
                resolutions={inventoryResolutions}
                onResolutionChange={updateInventoryResolution}
                isComplete={isComplete}
              />
            </>
          )}

          {previewResult.locations.items.length === 0 &&
            previewResult.inventory.items.length === 0 && (
              <div className="text-muted-foreground py-8 text-center">
                Everything is in sync! No differences found.
              </div>
            )}
        </div>

        <DialogFooter>
          {isComplete ? (
            <Button onClick={handleClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleApply}
                disabled={isApplying || !canApply}
                title={
                  hasUnresolvedConflicts
                    ? "Resolve all conflicts first"
                    : activeValidationErrors.length > 0
                      ? "Fix validation errors first"
                      : undefined
                }
              >
                {isApplying ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Applying...
                  </>
                ) : (
                  "Apply Sync"
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// Sub-components

function StateSummaryCard({
  count,
  state,
  isHidden,
  onClick,
}: {
  count: number;
  state: SyncState;
  isHidden: boolean;
  onClick: () => void;
}) {
  const styles = getSyncStateStyles(state);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-3 py-1.5 text-center transition-opacity ${styles.bg} ${
        isHidden ? "opacity-40" : ""
      } cursor-pointer hover:ring-2 hover:ring-offset-1`}
      title={
        isHidden ? `Show ${styles.label} items` : `Hide ${styles.label} items`
      }
    >
      <div className="flex items-center justify-center gap-1 text-base font-bold">
        {styles.icon}
        {count}
      </div>
      <div className="text-xs opacity-70">{styles.label}</div>
    </button>
  );
}

const StateBadgeCell = ({ state }: { state: SyncState }) => {
  const styles = getSyncStateStyles(state);
  return (
    <td className="p-2">
      <span
        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${styles.bg}`}
      >
        {styles.icon}
        {styles.label}
      </span>
    </td>
  );
};

const DetailsCellContent = ({
  state,
  fieldDiffs,
  resolution,
}: {
  state: SyncState;
  fieldDiffs?: { field: string; from: unknown; to: unknown }[];
  resolution?: SyncResolution;
}) => {
  if (state === "conflict" && fieldDiffs) {
    return (
      <div className="space-y-0.5">
        {fieldDiffs.map((diff, j) => (
          <div key={j}>
            <ValueChange
              label={diff.field}
              from={diff.from}
              to={diff.to}
              showSyncLabels
              selectedSide={getSelectedSide(resolution)}
            />
          </div>
        ))}
      </div>
    );
  }
  if (state === "app_only") {
    return (
      <span className="text-muted-foreground text-xs">
        Exists in app, not in sheet
      </span>
    );
  }
  if (state === "sheet_only") {
    return (
      <span className="text-muted-foreground text-xs">
        Exists in sheet, not in app
      </span>
    );
  }
  return null;
};

const ResolutionCell = ({
  itemKey,
  state,
  resolution,
  onResolutionChange,
}: {
  itemKey: string;
  state: SyncState;
  resolution?: SyncResolution;
  onResolutionChange: (key: string, resolution: SyncResolution) => void;
}) => {
  const options = getResolutionOptions(state);
  if (options.length === 0) return <td className="p-2" />;

  return (
    <td className="p-2">
      <Select
        value={resolution ?? ""}
        onValueChange={(value) => {
          if (value) {
            onResolutionChange(itemKey, value as SyncResolution);
          }
        }}
      >
        <SelectTrigger className="h-8 w-full text-xs">
          <SelectValue placeholder="Choose..." />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </td>
  );
};

function LocationSyncTable({
  items,
  hiddenStates,
  resolutions,
  onResolutionChange,
  isComplete,
}: {
  items: LocationSyncItem[];
  hiddenStates: HiddenStates;
  resolutions: Record<string, SyncResolution>;
  onResolutionChange: (key: string, resolution: SyncResolution) => void;
  isComplete: boolean;
}) {
  const visibleItems = items.filter((item) => !hiddenStates.has(item.state));

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 rounded border">
      <table className="w-full text-sm">
        <thead className="bg-muted sticky top-0">
          <tr>
            <th className="w-28 p-2 text-left">State</th>
            <th className="p-2 text-left">Location</th>
            <th className="p-2 text-left">Details</th>
            {!isComplete && <th className="w-48 p-2 text-left">Resolution</th>}
          </tr>
        </thead>
        <tbody>
          {visibleItems.map((item) => (
            <tr key={item.key} className="border-t">
              <StateBadgeCell state={item.state} />
              <td className="p-2">
                {item.state === "renamed" && item.renamedFrom ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-muted-foreground text-sm line-through">
                      {item.renamedFrom}
                    </span>
                    <span>{item.renamedTo ?? item.appData?.locationName}</span>
                  </div>
                ) : item.appData?.locationId ? (
                  <Link
                    href={`/${entities.location.basePath}/${item.appData.locationId}`}
                    className="text-primary hover:underline"
                  >
                    {item.appData.locationName}
                  </Link>
                ) : item.sheetData ? (
                  item.sheetData.locationName
                ) : (
                  <NoneState />
                )}
              </td>
              <td className="p-2">
                <DetailsCellContent
                  state={item.state}
                  fieldDiffs={item.fieldDiffs}
                  resolution={resolutions[item.key]}
                />
              </td>
              {!isComplete && (
                <ResolutionCell
                  itemKey={item.key}
                  state={item.state}
                  resolution={resolutions[item.key]}
                  onResolutionChange={onResolutionChange}
                />
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventorySyncTable({
  items,
  hiddenStates,
  resolutions,
  onResolutionChange,
  isComplete,
}: {
  items: InventorySyncItem[];
  hiddenStates: HiddenStates;
  resolutions: Record<string, SyncResolution>;
  onResolutionChange: (key: string, resolution: SyncResolution) => void;
  isComplete: boolean;
}) {
  const visibleItems = items.filter((item) => !hiddenStates.has(item.state));

  if (visibleItems.length === 0) {
    return null;
  }

  return (
    <div className="rounded border">
      <table className="w-full text-sm">
        <thead className="bg-muted sticky top-0">
          <tr>
            <th className="w-28 p-2 text-left">State</th>
            <th className="p-2 text-left">Product</th>
            <th className="p-2 text-left">Location</th>
            <th className="p-2 text-left">Details</th>
            {!isComplete && <th className="w-48 p-2 text-left">Resolution</th>}
          </tr>
        </thead>
        <tbody>
          {visibleItems.map((item) => (
            <tr key={item.key} className="border-t">
              <StateBadgeCell state={item.state} />
              <td className="p-2">
                {item.state === "renamed" && item.renamedFrom ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-muted-foreground text-sm line-through">
                      {item.renamedFrom}
                    </span>
                    <span>{item.renamedTo ?? item.appData?.productName}</span>
                  </div>
                ) : item.appData?.productId ? (
                  <Link
                    href={`/${entities.product.basePath}/${item.appData.productId}`}
                    className="text-primary hover:underline"
                  >
                    {item.appData.productName}
                  </Link>
                ) : item.sheetData ? (
                  item.sheetData.productName
                ) : (
                  <NoneState />
                )}
              </td>
              <td className="p-2">
                {item.state === "moved" ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="text-muted-foreground text-sm line-through">
                      {item.movedFrom ?? "(none)"}
                    </span>
                    <span>{item.movedTo ?? "(none)"}</span>
                  </div>
                ) : item.appData?.locationId ? (
                  <Link
                    href={`/${entities.location.basePath}/${item.appData.locationId}`}
                    className="text-primary hover:underline"
                  >
                    {item.appData.locationName}
                  </Link>
                ) : item.appData?.locationName ? (
                  item.appData.locationName
                ) : item.sheetData?.locationName ? (
                  item.sheetData.locationName
                ) : (
                  <NoneState />
                )}
              </td>
              <td className="p-2">
                <DetailsCellContent
                  state={item.state}
                  fieldDiffs={item.fieldDiffs}
                  resolution={resolutions[item.key]}
                />
              </td>
              {!isComplete && (
                <ResolutionCell
                  itemKey={item.key}
                  state={item.state}
                  resolution={resolutions[item.key]}
                  onResolutionChange={onResolutionChange}
                />
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
