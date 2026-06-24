/**
 * Placeholder component for visualization loading and empty states.
 * Reduces boilerplate across visualization components.
 */
export function VisualizationPlaceholder({
  message,
  subMessage,
  height = 400,
}: {
  message: string;
  subMessage?: string;
  height?: number;
}) {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-[var(--border-chunky)] text-muted-foreground"
      style={{ height }}
    >
      <div className="text-center">
        <p>{message}</p>
        {subMessage && <p className="mt-1 text-sm">{subMessage}</p>}
      </div>
    </div>
  );
}
