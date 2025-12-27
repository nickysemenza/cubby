"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Check, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { useSyncPreview } from "./use-sync-preview";
import { SyncDialog } from "./sync-dialog";

export const SyncStatusBadge = () => {
  const {
    isConfigured,
    isConnected,
    isLoadingConnection,
    isLoadingPreview,
    status,
    previewResult,
    previewError,
    fetchPreview,
    invalidateAndRefetch,
  } = useSyncPreview();

  const [dialogOpen, setDialogOpen] = useState(false);

  // Fetch preview on mount when connected
  useEffect(() => {
    if (isConnected && !status && !isLoadingPreview) {
      fetchPreview();
    }
  }, [isConnected, status, isLoadingPreview, fetchPreview]);

  // Don't render if not configured
  if (!isConfigured && !isLoadingConnection) {
    return null;
  }

  // Loading connection status
  if (isLoadingConnection) {
    return (
      <Button variant="ghost" size="sm" disabled className="h-8 px-2">
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  // Not connected - show warning that links to settings
  if (!isConnected) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              render={<Link href="/settings/integrations" />}
              nativeButton={false}
            />
          }
        >
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>
          <p>Google Sheet not connected</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Loading preview
  if (isLoadingPreview) {
    return (
      <Button variant="ghost" size="sm" disabled className="h-8 px-2">
        <RefreshCw className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  // Error state
  if (previewError) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={fetchPreview}
            />
          }
        >
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>
          <p>Could not check sync status. Click to retry.</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // No status yet (initial state before first fetch completes)
  if (!status) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2"
        onClick={fetchPreview}
      >
        <RefreshCw className="h-4 w-4 text-muted-foreground" />
      </Button>
    );
  }

  // Build tooltip content
  const tooltipParts: string[] = [];
  if (status.breakdown.conflicts > 0) {
    tooltipParts.push(
      `${status.breakdown.conflicts} conflict${status.breakdown.conflicts > 1 ? "s" : ""}`,
    );
  }
  if (status.breakdown.appOnly > 0) {
    tooltipParts.push(`${status.breakdown.appOnly} app-only`);
  }
  if (status.breakdown.sheetOnly > 0) {
    tooltipParts.push(`${status.breakdown.sheetOnly} sheet-only`);
  }
  if (status.breakdown.renamed > 0) {
    tooltipParts.push(`${status.breakdown.renamed} renamed`);
  }
  if (status.breakdown.moved > 0) {
    tooltipParts.push(`${status.breakdown.moved} moved`);
  }

  const tooltipText =
    tooltipParts.length > 0
      ? `${tooltipParts.join(", ")} — Click to sync`
      : "Everything in sync";

  // Determine badge color and content
  const inSync = status.total === 0;
  const hasActionNeeded = status.actionNeeded > 0;

  const handleClick = () => {
    setDialogOpen(true);
  };

  const handleDialogClose = () => {
    setDialogOpen(false);
  };

  const handleSyncComplete = () => {
    invalidateAndRefetch();
    // Refetch after a brief delay to get fresh status
    setTimeout(() => {
      fetchPreview();
    }, 500);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 px-2 font-medium",
                inSync && "text-muted-foreground",
                !inSync &&
                  !hasActionNeeded &&
                  "text-green-600 dark:text-green-400",
                hasActionNeeded && "text-orange-600 dark:text-orange-400",
              )}
              onClick={handleClick}
            />
          }
        >
          {inSync ? (
            <Check className="h-4 w-4" />
          ) : hasActionNeeded ? (
            <span className="flex items-center gap-1 text-sm">
              {status.total}
              <span className="text-muted-foreground">·</span>
              {status.actionNeeded}
            </span>
          ) : (
            <span className="text-sm">{status.total}</span>
          )}
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>

      <SyncDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        previewResult={previewResult}
        onClose={handleDialogClose}
        onSyncComplete={handleSyncComplete}
      />
    </>
  );
};
