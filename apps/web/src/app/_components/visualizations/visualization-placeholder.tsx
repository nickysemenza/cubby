/**
 * Placeholder component for visualization loading and empty states.
 * Reduces boilerplate across visualization components.
 */
export function VisualizationPlaceholder({
  message,
  subMessage,
  height = 400,
  onRetry,
  retryLabel = "Try again",
}: {
  message: string;
  subMessage?: string;
  height?: number;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      className="flex items-center justify-center border border-[var(--border)] text-muted-foreground"
      style={{ height }}
    >
      <div className="text-center">
        <p>{message}</p>
        {subMessage && <p className="mt-1 text-sm">{subMessage}</p>}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 inline-flex min-h-11 items-center border border-[var(--border)] px-3 text-foreground text-sm hover:bg-muted"
          >
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
