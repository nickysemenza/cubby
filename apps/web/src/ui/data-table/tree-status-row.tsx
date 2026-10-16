import { getAppErrorDetails } from "~/lib/error-utils";
import { openErrorDetailsDialog } from "~/ui/feedback/error-details-store";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";

import type { ServerTreeChildStatus } from "../hooks/use-server-tree-children";

/**
 * An expanded parent's children read, drawn after its loaded children: the
 * first page loading, a failed read (or failed deferred group) with Retry, or
 * Load more while the server reports more matching children. One line, so it
 * fits the desktop table's fixed row height.
 */
export function TreeStatusRow({ status }: { status: ServerTreeChildStatus }) {
  if (status.kind === "loading")
    return (
      <output className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground">
        <Spinner size="sm" />
        Loading nested rows…
      </output>
    );
  if (status.kind === "error") {
    const { message, diagnostics, requestId } = getAppErrorDetails(
      status.error,
    );
    return (
      <span role="alert" className="flex min-h-9 min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-destructive"
        />
        <span className="min-w-0 truncate text-sm">
          Couldn't load nested rows.{" "}
          <span className="text-muted-foreground">{message}</span>
        </span>
        {diagnostics || requestId ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              openErrorDetailsDialog(status.error);
            }}
          >
            Technical details
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            status.retry();
          }}
        >
          Retry
        </Button>
      </span>
    );
  }
  return (
    <span className="flex min-h-9 items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        disabled={status.loading}
        onClick={(event) => {
          event.stopPropagation();
          status.loadMore();
        }}
      >
        {status.loading ? <Spinner size="sm" aria-hidden="true" /> : null}
        Load more
      </Button>
      <span className="text-xs text-muted-foreground">
        {status.remaining} more
      </span>
    </span>
  );
}
