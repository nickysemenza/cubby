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
} from "lucide-react";
import {
  type CSVImportResult,
  type CSVImportResultItem,
} from "~/schemas/inventory";
import { queryKeys } from "~/lib/query-keys";
import { ValueChange } from "../value-change";

// Helper to get action styles
const getActionStyles = (action: CSVImportResultItem["action"]) => {
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
  }
};

type SyncMode = "push" | "pull";

export function GoogleSheetsSync() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [showPreview, setShowPreview] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>("pull");
  const [previewResult, setPreviewResult] = useState<CSVImportResult | null>(
    null,
  );
  const [completedResult, setCompletedResult] =
    useState<CSVImportResult | null>(null);
  const [pushRowCount, setPushRowCount] = useState<number | null>(null);

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
        setPushRowCount(result.rowCount);
        setCompletedResult(previewResult);
        setPreviewResult(null);
        queryClient.invalidateQueries({
          queryKey: api.googleSheets.getConnectionStatus.queryKey(),
        });
        toast.success(`Pushed ${result.rowCount} items to Google Sheet`);
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
        toast.success(
          `Import complete: ${result.created} created, ${result.moved} moved, ${result.updated} updated`,
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
    setPushRowCount(null);
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
          asChild
          title={`Open "${status.sheetName}" in Google Sheets`}
        >
          <a
            href={`https://docs.google.com/spreadsheets/d/${status.sheetId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
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
                  ? `Successfully pushed ${pushRowCount} items to the sheet.`
                  : "Changes have been applied to your inventory."
                : isPushMode
                  ? `Review what will be written to "${status.sheetName}".`
                  : `Review the changes that will be made from "${status.sheetName}".`}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-hidden">
            {/* Summary counts */}
            {currentResult && (
              <div
                className={`mb-4 grid gap-2 text-sm ${isPushMode ? "grid-cols-4" : "grid-cols-6"}`}
              >
                <SummaryCard
                  count={currentResult.created}
                  label={isPushMode ? "Add" : "Create"}
                  color="green"
                />
                {!isPushMode && (
                  <SummaryCard
                    count={currentResult.moved}
                    label="Move"
                    color="yellow"
                  />
                )}
                <SummaryCard
                  count={currentResult.updated}
                  label="Update"
                  color="blue"
                />
                {isPushMode && (
                  <SummaryCard
                    count={currentResult.removed ?? 0}
                    label="Remove"
                    color="orange"
                  />
                )}
                {!isPushMode && (
                  <SummaryCard
                    count={currentResult.productOnly}
                    label="Product"
                    color="purple"
                  />
                )}
                <SummaryCard
                  count={currentResult.skipped}
                  label="No change"
                  color="gray"
                />
                {!isPushMode && (
                  <SummaryCard
                    count={currentResult.errors}
                    label="Error"
                    color="red"
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
                      ? `Successfully pushed ${pushRowCount} items`
                      : `Successfully imported ${completedResult.created + completedResult.moved + completedResult.updated} items`}
                  </span>
                </div>
              </div>
            )}

            {/* Items table */}
            {(currentResult?.items.length ?? 0) > 0 && (
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
                    {currentResult!.items.map((item, i) => {
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
                          <td className="p-2">{item.productName}</td>
                          <td className="p-2">
                            {item.locationPath ? (
                              <div>{item.locationPath}</div>
                            ) : (
                              <span className="text-muted-foreground italic">
                                No location
                              </span>
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

            {/* Empty state */}
            {currentResult?.items.length === 0 && (
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
                    (previewResult.created === 0 &&
                      previewResult.moved === 0 &&
                      previewResult.updated === 0 &&
                      previewResult.productOnly === 0 &&
                      (previewResult.removed ?? 0) === 0)
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
}: {
  count: number;
  label: string;
  color: "green" | "yellow" | "blue" | "purple" | "gray" | "red" | "orange";
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
  };

  return (
    <div className={`rounded border p-2 text-center ${colorClasses[color]}`}>
      <div className="text-lg font-bold">{count}</div>
      <div className="text-xs opacity-70">{label}</div>
    </div>
  );
}
