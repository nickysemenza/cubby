import { type ReactNode, useEffect } from "react";

import { Button } from "~/components/ui/button";

import { PreviewDeleted, PreviewLoading } from "./manifest-card";

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
    refetch: () => unknown;
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
      <div className="space-y-2" role="alert">
        <p className="text-sm text-muted-foreground">
          {label} could not be loaded.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!query.data) return <PreviewDeleted label={label} />;
  return children(query.data as NonNullable<T>);
}
