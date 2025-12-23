"use client";

import { useState } from "react";
import Link from "next/link";
import { useTRPC } from "~/trpc/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  ArrowUpFromLine,
  ArrowDownToLine,
  Loader2,
  ExternalLink,
  Settings,
  Plus,
  ArrowRightLeft,
  RefreshCw,
  AlertCircle,
  Package,
  CheckCircle2,
  Trash2,
  Pencil,
} from "lucide-react";
import {
  type CSVImportResult,
  type CSVImportResultItem,
} from "~/schemas/inventory";
import {
  type LocationCSVImportResult,
  type LocationCSVImportResultItem,
} from "~/schemas/location";
import { queryKeys } from "~/lib/query-keys";

// Combined sync result type (matches router output)
interface CombinedSyncResult {
  inventory: CSVImportResult;
  locations: LocationCSVImportResult;
}
import { ValueChange } from "../value-change";
import { NoneState } from "../NoneState";
import { entities } from "~/entities/entities";

// Action types that can be filtered
type ActionType = CSVImportResultItem["action"];
type LocationActionType = LocationCSVImportResultItem["action"];

// Helper to get action styles
const getActionStyles = (
  action: CSVImportResultItem["action"] | LocationActionType,
) => {
  switch (action) {
    case "created":
      return {
        bg: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
        icon: <Plus className="h-3 w-3" />,
        label: "Add",
      };
    case "moved":
      return {
        bg: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
        icon: <ArrowRightLeft className="h-3 w-3" />,
        label: "Move",
      };
    case "updated":
      return {
        bg: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
        icon: <RefreshCw className="h-3 w-3" />,
        label: "Update",
      };
    case "skipped":
      return {
        bg: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
        icon: null,
        label: "No change",
      };
    case "error":
      return {
        bg: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
        icon: <AlertCircle className="h-3 w-3" />,
        label: "Error",
      };
    case "product_only":
      return {
        bg: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
        icon: <Package className="h-3 w-3" />,
        label: "Product",
      };
    case "removed":
      return {
        bg: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
        icon: <Trash2 className="h-3 w-3" />,
        label: "Remove",
      };
    case "renamed":
      return {
        bg: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
        icon: <Pencil className="h-3 w-3" />,
        label: "Rename",
      };
  }
};

type SyncMode = "push" | "pull";

// Default hidden action types (skipped is hidden by default)
const DEFAULT_HIDDEN_ACTIONS: Set<ActionType> = new Set(["skipped"]);

export function GoogleSheetsSync() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [showPreview, setShowPreview] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>("pull");
  const [previewResult, setPreviewResult] = useState<CombinedSyncResult | null>(
    null,
  );
  const [completedResult, setCompletedResult] =
    useState<CombinedSyncResult | null>(null);
  const [pushRowCounts, setPushRowCounts] = useState<{
    inventory: number;
    locations: number;
  } | null>(null);
  // Track which action types are hidden (skipped is hidden by default)
  const [hiddenActions, setHiddenActions] = useState<Set<ActionType>>(
    () => new Set(DEFAULT_HIDDEN_ACTIONS),
  );

  // Toggle visibility of an action type
  const toggleActionVisibility = (action: ActionType) => {
    setHiddenActions((prev) => {
      const next = new Set(prev);
      if (next.has(action)) {
        next.delete(action);
      } else {
        next.add(action);
      }
      return next;
    });
  };

  // Get connection status
  const { data: status, isLoading } = useQuery(
    api.googleSheets.getConnectionStatus.queryOptions(),
  );

  // Push preview mutation
  const pushPreviewMutation = useMutation(
    api.googleSheets.previewPush.mutationOptions({
      onSuccess: (result) => {
        setPreviewResult(result);
        setCompletedResult(null);
        setSyncMode("push");
        setShowPreview(true);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  // Push to sheet mutation
  const pushMutation = useMutation(
    api.googleSheets.pushToSheet.mutationOptions({
      onSuccess: (result) => {
        setPushRowCounts({
          inventory: result.inventoryRowCount,
          locations: result.locationRowCount,
        });
        setCompletedResult(previewResult);
        setPreviewResult(null);
        queryClient.invalidateQueries({
          queryKey: api.googleSheets.getConnectionStatus.queryKey(),
        });
        const totalRows = result.inventoryRowCount + result.locationRowCount;
        toast.success(`Pushed ${totalRows} items to Google Sheet`);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  // Pull from sheet (preview) mutation
  const pullPreviewMutation = useMutation(
    api.googleSheets.pullFromSheet.mutationOptions({
      onSuccess: (result) => {
        setPreviewResult(result);
        setCompletedResult(null);
        setSyncMode("pull");
        setShowPreview(true);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  // Apply pull mutation
  const applyPullMutation = useMutation(
    api.googleSheets.applyPull.mutationOptions({
      onSuccess: (result) => {
        setCompletedResult(result);
        setPreviewResult(null);
        queryClient.invalidateQueries({
          queryKey: queryKeys.inventoryItem.list,
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.product.list });
        queryClient.invalidateQueries({ queryKey: queryKeys.location.list });
        queryClient.invalidateQueries({
          queryKey: api.googleSheets.getConnectionStatus.queryKey(),
        });
        const inv = result.inventory;
        toast.success(
          `Import complete: ${inv.created} created, ${inv.moved} moved, ${inv.updated} updated`,
        );
      },
      onError: (error) => {
        toast.error(error.message);
      },
    }),
  );

  const handlePush = () => {
    pushPreviewMutation.mutate();
  };

  const handlePull = () => {
    pullPreviewMutation.mutate();
  };

  const handleApply = () => {
    if (syncMode === "push") {
      pushMutation.mutate();
    } else {
      applyPullMutation.mutate();
    }
  };

  const handleClose = () => {
    setShowPreview(false);
    setPreviewResult(null);
    setCompletedResult(null);
    setPushRowCounts(null);
    setHiddenActions(new Set(DEFAULT_HIDDEN_ACTIONS));
  };

  // Don't render if not configured or loading
  if (isLoading || !status?.configured) {
    return null;
  }

  // Show connect prompt if not connected
  if (!status.connected) {
    return (
      <Link href="/settings/integrations">
        <Button variant="outline" size="sm">
          <Settings className="h-3 w-3" />
          Connect Google Sheet
        </Button>
      </Link>
    );
  }

  const isPreviewingPush = pushPreviewMutation.isPending;
  const isPreviewingPull = pullPreviewMutation.isPending;
  const isApplying = pushMutation.isPending || applyPullMutation.isPending;

  const currentResult = previewResult ?? completedResult;
  const isPushMode = syncMode === "push";

  return (
    <>
      {/* Sync buttons */}
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={handlePush}
          disabled={isPreviewingPush || isPreviewingPull}
          title="Export inventory to Google Sheet"
        >
          {isPreviewingPush ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ArrowUpFromLine className="h-3 w-3" />
          )}
          Push
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handlePull}
          disabled={isPreviewingPush || isPreviewingPull}
          title="Import from Google Sheet"
        >
          {isPreviewingPull ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ArrowDownToLine className="h-3 w-3" />
          )}
          Pull
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title={`Open "${status.sheetName}" in Google Sheets`}
          render={
            <a
              href={`https://docs.google.com/spreadsheets/d/${status.sheetId}`}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <ExternalLink className="h-3 w-3" />
        </Button>
      </div>

      {/* Preview/Result Dialog */}
      {/* Note: !important needed to override DialogContent's sm:max-w-lg default */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="flex max-h-[90vh] !w-[95vw] !max-w-[95vw] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              {completedResult
                ? isPushMode
                  ? "Push Complete"
                  : "Import Complete"
                : isPushMode
                  ? "Preview Push to Google Sheet"
                  : "Preview Import from Google Sheet"}
            </DialogTitle>
            <DialogDescription>
              {completedResult
                ? isPushMode
                  ? `Successfully pushed ${(pushRowCounts?.inventory ?? 0) + (pushRowCounts?.locations ?? 0)} items to the sheet.`
                  : "Changes have been applied to your inventory."
                : isPushMode
                  ? `Review what will be written to "${status.sheetName}".`
                  : `Review the changes that will be made from "${status.sheetName}".`}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-hidden">
            {/* Inventory section */}
            {currentResult && (
              <h3 className="mb-2 text-sm font-medium">Inventory</h3>
            )}
            {/* Summary counts - click to toggle visibility */}
            {currentResult && (
              <div className="mb-4 flex flex-wrap gap-1.5 text-sm">
                <SummaryCard
                  count={currentResult.inventory.created}
                  label={isPushMode ? "Add" : "Create"}
                  color="green"
                  isHidden={hiddenActions.has("created")}
                  onClick={() => toggleActionVisibility("created")}
                />
                {!isPushMode && (
                  <SummaryCard
                    count={currentResult.inventory.moved}
                    label="Move"
                    color="yellow"
                    isHidden={hiddenActions.has("moved")}
                    onClick={() => toggleActionVisibility("moved")}
                  />
                )}
                <SummaryCard
                  count={currentResult.inventory.updated}
                  label="Update"
                  color="blue"
                  isHidden={hiddenActions.has("updated")}
                  onClick={() => toggleActionVisibility("updated")}
                />
                <SummaryCard
                  count={currentResult.inventory.renamed ?? 0}
                  label="Rename"
                  color="cyan"
                  isHidden={hiddenActions.has("renamed")}
                  onClick={() => toggleActionVisibility("renamed")}
                />
                <SummaryCard
                  count={currentResult.inventory.removed ?? 0}
                  label="Remove"
                  color="orange"
                  isHidden={hiddenActions.has("removed")}
                  onClick={() => toggleActionVisibility("removed")}
                />
                {!isPushMode && (
                  <SummaryCard
                    count={currentResult.inventory.productOnly}
                    label="Product"
                    color="purple"
                    isHidden={hiddenActions.has("product_only")}
                    onClick={() => toggleActionVisibility("product_only")}
                  />
                )}
                <SummaryCard
                  count={currentResult.inventory.skipped}
                  label="No change"
                  color="gray"
                  isHidden={hiddenActions.has("skipped")}
                  onClick={() => toggleActionVisibility("skipped")}
                />
                {!isPushMode && (
                  <SummaryCard
                    count={currentResult.inventory.errors}
                    label="Error"
                    color="red"
                    isHidden={hiddenActions.has("error")}
                    onClick={() => toggleActionVisibility("error")}
                  />
                )}
              </div>
            )}

            {/* Success message */}
            {completedResult && (
              <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
                <div className="flex items-center gap-2 text-green-700 dark:text-green-300">
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="font-medium">
                    {isPushMode
                      ? `Successfully pushed ${(pushRowCounts?.inventory ?? 0) + (pushRowCounts?.locations ?? 0)} items`
                      : `Successfully imported ${completedResult.inventory.created + completedResult.inventory.moved + completedResult.inventory.updated} items`}
                  </span>
                </div>
              </div>
            )}

            {/* Items table */}
            {(currentResult?.inventory.items.length ?? 0) > 0 && (
              <div className="max-h-[60vh] overflow-y-auto rounded border">
                <table className="w-full text-sm">
                  <thead className="bg-muted sticky top-0">
                    <tr>
                      <th className="w-24 p-2 text-left">Action</th>
                      <th className="p-2 text-left">Product</th>
                      <th className="p-2 text-left">Location</th>
                      <th className="p-2 text-left">Changes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentResult!.inventory.items
                      .filter((item) => !hiddenActions.has(item.action))
                      .map((item, i) => {
                        const styles = getActionStyles(item.action);
                        return (
                          <tr key={i} className="border-t">
                            <td className="p-2">
                              <span
                                className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${styles.bg}`}
                              >
                                {styles.icon}
                                {styles.label}
                              </span>
                            </td>
                            <td className="p-2">
                              {item.action === "renamed" && item.renamedFrom ? (
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-muted-foreground text-sm line-through">
                                    {item.renamedFrom}
                                  </span>
                                  {item.productId ? (
                                    <Link
                                      href={`/${entities.product.basePath}/${item.productId}`}
                                      className="text-primary hover:underline"
                                    >
                                      {item.productName}
                                    </Link>
                                  ) : (
                                    item.productName
                                  )}
                                </div>
                              ) : item.productId ? (
                                <Link
                                  href={`/${entities.product.basePath}/${item.productId}`}
                                  className="text-primary hover:underline"
                                >
                                  {item.productName}
                                </Link>
                              ) : (
                                item.productName
                              )}
                            </td>
                            <td className="p-2">
                              {item.locationName ? (
                                item.locationId ? (
                                  <Link
                                    href={`/${entities.location.basePath}/${item.locationId}`}
                                    className="text-primary hover:underline"
                                  >
                                    {item.locationName}
                                  </Link>
                                ) : (
                                  <div>{item.locationName}</div>
                                )
                              ) : (
                                <NoneState />
                              )}
                            </td>
                            <td className="p-2">
                              {item.fieldChanges &&
                              item.fieldChanges.length > 0 ? (
                                <div className="space-y-0.5">
                                  {item.fieldChanges.map((change, j) => (
                                    <div key={j}>
                                      <ValueChange
                                        label={change.field}
                                        from={change.from}
                                        to={change.to}
                                      />
                                    </div>
                                  ))}
                                </div>
                              ) : item.message ? (
                                <span className="text-muted-foreground text-xs">
                                  {item.message}
                                </span>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Locations section */}
            {currentResult &&
              (currentResult.locations.items.length > 0 ||
                currentResult.locations.created > 0 ||
                currentResult.locations.updated > 0 ||
                (currentResult.locations.removed ?? 0) > 0) && (
                <>
                  <h3 className="mt-4 mb-2 text-sm font-medium">Locations</h3>
                  {/* Location summary counts */}
                  <div className="mb-4 grid grid-cols-4 gap-2 text-sm">
                    <SummaryCard
                      count={currentResult.locations.created}
                      label={isPushMode ? "Add" : "Create"}
                      color="green"
                      isHidden={hiddenActions.has("created")}
                      onClick={() => toggleActionVisibility("created")}
                    />
                    <SummaryCard
                      count={currentResult.locations.updated}
                      label="Update"
                      color="blue"
                      isHidden={hiddenActions.has("updated")}
                      onClick={() => toggleActionVisibility("updated")}
                    />
                    {isPushMode && (
                      <SummaryCard
                        count={currentResult.locations.removed ?? 0}
                        label="Remove"
                        color="orange"
                        isHidden={hiddenActions.has("removed")}
                        onClick={() => toggleActionVisibility("removed")}
                      />
                    )}
                    <SummaryCard
                      count={currentResult.locations.skipped}
                      label="No change"
                      color="gray"
                      isHidden={hiddenActions.has("skipped")}
                      onClick={() => toggleActionVisibility("skipped")}
                    />
                  </div>

                  {/* Locations table */}
                  {currentResult.locations.items.filter(
                    (item) => !hiddenActions.has(item.action),
                  ).length > 0 && (
                    <div className="max-h-[30vh] overflow-y-auto rounded border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted sticky top-0">
                          <tr>
                            <th className="w-24 p-2 text-left">Action</th>
                            <th className="p-2 text-left">Location</th>
                            <th className="p-2 text-left">Changes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentResult.locations.items
                            .filter((item) => !hiddenActions.has(item.action))
                            .map((item, i) => {
                              const styles = getActionStyles(item.action);
                              return (
                                <tr key={i} className="border-t">
                                  <td className="p-2">
                                    <span
                                      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${styles.bg}`}
                                    >
                                      {styles.icon}
                                      {styles.label}
                                    </span>
                                  </td>
                                  <td className="p-2">
                                    {item.locationId ? (
                                      <Link
                                        href={`/${entities.location.basePath}/${item.locationId}`}
                                        className="text-primary hover:underline"
                                      >
                                        {item.locationName}
                                      </Link>
                                    ) : (
                                      item.locationName
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {item.fieldChanges &&
                                    item.fieldChanges.length > 0 ? (
                                      <div className="space-y-0.5">
                                        {item.fieldChanges.map((change, j) => (
                                          <div key={j}>
                                            <ValueChange
                                              label={change.field}
                                              from={change.from}
                                              to={change.to}
                                            />
                                          </div>
                                        ))}
                                      </div>
                                    ) : item.message ? (
                                      <span className="text-muted-foreground text-xs">
                                        {item.message}
                                      </span>
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}

            {/* Empty state */}
            {currentResult?.inventory.items.length === 0 &&
              currentResult?.locations.items.length === 0 && (
                <div className="text-muted-foreground py-8 text-center">
                  {isPushMode
                    ? "No changes to make. The sheet is already up to date."
                    : "No changes to make. The sheet may be empty or all items are unchanged."}
                </div>
              )}
          </div>

          <DialogFooter>
            {completedResult ? (
              <Button onClick={handleClose}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  onClick={handleApply}
                  disabled={
                    isApplying ||
                    !previewResult ||
                    (previewResult.inventory.created === 0 &&
                      previewResult.inventory.moved === 0 &&
                      previewResult.inventory.updated === 0 &&
                      previewResult.inventory.productOnly === 0 &&
                      (previewResult.inventory.removed ?? 0) === 0 &&
                      (previewResult.inventory.renamed ?? 0) === 0 &&
                      previewResult.locations.created === 0 &&
                      previewResult.locations.updated === 0 &&
                      (previewResult.locations.removed ?? 0) === 0)
                  }
                >
                  {isApplying ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {isPushMode ? "Pushing..." : "Applying..."}
                    </>
                  ) : isPushMode ? (
                    "Push to Sheet"
                  ) : (
                    "Apply Changes"
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SummaryCard({
  count,
  label,
  color,
  isHidden,
  onClick,
}: {
  count: number;
  label: string;
  color:
    | "green"
    | "yellow"
    | "blue"
    | "purple"
    | "gray"
    | "red"
    | "orange"
    | "cyan";
  isHidden?: boolean;
  onClick?: () => void;
}) {
  const colorClasses = {
    green: "bg-green-50 text-green-600 dark:bg-green-950 dark:text-green-400",
    yellow:
      "bg-yellow-50 text-yellow-600 dark:bg-yellow-950 dark:text-yellow-400",
    blue: "bg-blue-50 text-blue-600 dark:bg-blue-950 dark:text-blue-400",
    purple:
      "bg-purple-50 text-purple-600 dark:bg-purple-950 dark:text-purple-400",
    gray: "bg-gray-50 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    red: "bg-red-50 text-red-600 dark:bg-red-950 dark:text-red-400",
    orange:
      "bg-orange-50 text-orange-600 dark:bg-orange-950 dark:text-orange-400",
    cyan: "bg-cyan-50 text-cyan-600 dark:bg-cyan-950 dark:text-cyan-400",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-3 py-1.5 text-center transition-opacity ${colorClasses[color]} ${
        onClick ? "cursor-pointer hover:ring-2 hover:ring-offset-1" : ""
      } ${isHidden ? "opacity-40" : ""}`}
      title={
        onClick
          ? isHidden
            ? `Show ${label.toLowerCase()} items`
            : `Hide ${label.toLowerCase()} items`
          : undefined
      }
    >
      <div className="text-base font-bold">{count}</div>
      <div className="text-xs opacity-70">{label}</div>
    </button>
  );
}
