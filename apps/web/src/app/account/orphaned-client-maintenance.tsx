import { ErrorDisplay } from "~/components/feedback/error-display";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";

export function OrphanedClientMaintenance({
  count,
  error,
  isCleaning,
  onCleanup,
  onRetry,
}: {
  count: number | undefined;
  error: unknown;
  isCleaning: boolean;
  onCleanup: () => void;
  onRetry: () => void;
}) {
  if (error) {
    return (
      <Stack gap="sm">
        <ErrorDisplay error={error} />
        <div>
          <Button variant="outline" onClick={onRetry}>
            Retry abandoned registrations
          </Button>
        </div>
      </Stack>
    );
  }

  if (!count) return null;

  return (
    <Row align="center" gap="sm" wrap>
      <span className="text-muted-foreground text-xs">
        {count} abandoned registration{count === 1 ? "" : "s"} — connect
        attempts that never reached the consent screen.
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={isCleaning}
        onClick={onCleanup}
      >
        {isCleaning ? "Cleaning up…" : "Clean up"}
      </Button>
    </Row>
  );
}
