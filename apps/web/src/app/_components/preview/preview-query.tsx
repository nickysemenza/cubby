import { type ReactNode, useEffect } from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";

import { PreviewDeleted, PreviewLoading } from "./manifest-card";

type PreviewRefetchResult = object;

export function PreviewQuery<T>({
  query,
  label,
  children,
  onUnavailable,
}: {
  query: {
    data: T | undefined;
    isLoading: boolean;
    isError: boolean;
    error?: unknown;
    refetch: () => Promise<PreviewRefetchResult>;
  };
  label: string;
  children: (data: NonNullable<T>) => ReactNode;
  /** Clear record-owned controls when a previously loaded preview disappears. */
  onUnavailable?: (record: undefined) => void;
}) {
  useEffect(() => {
    if (!query.data) onUnavailable?.(undefined);
  }, [onUnavailable, query.data]);

  if (query.isLoading) return <PreviewLoading />;
  if (query.isError && !query.data) {
    return (
      <ErrorDisplay
        error={query.error}
        title={label}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <PreviewDeleted label={label} />;
  return children(query.data);
}
