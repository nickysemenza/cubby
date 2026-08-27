import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { PreviewDeleted, PreviewLoading } from "./manifest-card";

export function PreviewQuery<T>({
  query,
  label,
  children,
}: {
  query: {
    data: T | undefined;
    isLoading: boolean;
    isError: boolean;
    refetch: () => unknown;
  };
  label: string;
  children: (data: NonNullable<T>) => ReactNode;
}) {
  if (query.isLoading) return <PreviewLoading />;
  if (query.isError && !query.data) {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-muted-foreground text-sm">
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
