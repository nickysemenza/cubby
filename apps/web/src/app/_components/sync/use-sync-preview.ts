"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { SyncPreviewResult } from "~/schemas/sync";
import { useTRPC } from "~/trpc/react";

type SyncStatus = {
  total: number;
  actionNeeded: number;
  breakdown: {
    conflicts: number;
    appOnly: number;
    sheetOnly: number;
    renamed: number;
    moved: number;
  };
};

const extractSyncStatus = (preview: SyncPreviewResult): SyncStatus => {
  const loc = preview.locations;
  const inv = preview.inventory;

  const breakdown = {
    conflicts: loc.conflicts + inv.conflicts,
    appOnly: loc.appOnly + inv.appOnly,
    sheetOnly: loc.sheetOnly + inv.sheetOnly,
    renamed: loc.renamed + inv.renamed,
    moved: inv.moved,
  };

  const total =
    breakdown.conflicts +
    breakdown.appOnly +
    breakdown.sheetOnly +
    breakdown.renamed +
    breakdown.moved;

  const actionNeeded =
    breakdown.conflicts + breakdown.appOnly + breakdown.sheetOnly;

  return { total, actionNeeded, breakdown };
};

export const useSyncPreview = () => {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [previewResult, setPreviewResult] = useState<SyncPreviewResult | null>(
    null,
  );

  // Connection status query - lightweight check
  const connectionQuery = useQuery(
    api.googleSheets.getConnectionStatus.queryOptions(),
  );

  // Sync preview mutation
  const previewMutation = useMutation(
    api.googleSheets.syncPreview.mutationOptions({
      onSuccess: (result) => {
        setPreviewResult(result);
      },
    }),
  );

  // Fetch preview (can be called by badge on mount or manually)
  const fetchPreview = useCallback(() => {
    if (connectionQuery.data?.connected) {
      previewMutation.mutate();
    }
  }, [connectionQuery.data?.connected, previewMutation]);

  // Clear preview (after dialog closes)
  const clearPreview = useCallback(() => {
    setPreviewResult(null);
  }, []);

  // Invalidate and refetch (after sync applied)
  const invalidateAndRefetch = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: api.googleSheets.getConnectionStatus.queryKey(),
    });
    setPreviewResult(null);
    // Will refetch on next fetchPreview call
  }, [queryClient, api.googleSheets.getConnectionStatus]);

  // Derived status for badge
  const status: SyncStatus | null = previewResult
    ? extractSyncStatus(previewResult)
    : null;

  return {
    // Connection state
    isConfigured: connectionQuery.data?.configured ?? false,
    isConnected: connectionQuery.data?.connected ?? false,
    sheetName: connectionQuery.data?.sheetName ?? null,
    sheetId: connectionQuery.data?.sheetId ?? null,
    isLoadingConnection: connectionQuery.isLoading,

    // Preview state
    previewResult,
    status,
    isLoadingPreview: previewMutation.isPending,
    previewError: previewMutation.error,

    // Actions
    fetchPreview,
    clearPreview,
    invalidateAndRefetch,
  };
};
