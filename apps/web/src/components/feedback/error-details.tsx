import { Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";
import { getAppErrorDetails, type UnparsedError } from "~/lib/error-utils";

import { openErrorDetailsDialog } from "./error-details-store";

/** Whether `error` carries anything beyond its message worth surfacing. */
function hasErrorDetails(error: UnparsedError): boolean {
  const detail = getAppErrorDetails(error);
  return !!(detail.diagnostics || detail.requestId);
}

/**
 * The operation/entity/stage line, causes list, View in Sentry / Open Workers
 * Observability links, Copy details button, and Ray ID line — the content
 * shared by the inline `<details>` block and the technical-details dialog.
 * No border/background/max-height of its own: callers supply that chrome (the
 * inline block keeps its bordered scroll box; the dialog supplies its own).
 */
export function ErrorDetailsBody({ error }: { error: unknown }) {
  const [copied, setCopied] = useState(false);
  const detail = getAppErrorDetails(error);
  const diagnostics = detail.diagnostics;
  let causePath = "";
  const causes = diagnostics?.causes.map((cause) => {
    causePath += `/${JSON.stringify(cause)}`;
    return { cause, path: causePath };
  });
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs break-words">
      {diagnostics && (
        <div className="font-mono">
          {[
            diagnostics.operation,
            diagnostics.entity,
            diagnostics.module,
            diagnostics.stage,
          ]
            .filter(Boolean)
            .join(" / ")}
        </div>
      )}
      {causes?.map(({ cause, path }) => (
        <div key={path}>
          <span className="font-mono">
            {cause.name}
            {cause.code ? ` (${cause.code})` : ""}
            {cause.status ? ` [${cause.status}]` : ""}:{" "}
          </span>
          {cause.message}
        </div>
      ))}
      {diagnostics?.truncated && (
        <p>Additional details are available in server diagnostics.</p>
      )}
      {detail.requestId && (
        <div className="font-mono">Request ID: {detail.requestId}</div>
      )}
      {diagnostics?.sentryEventId && (
        <div className="font-mono">
          Sentry event: {diagnostics.sentryEventId}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {diagnostics?.sentryUrl && (
          <a
            className="text-cobalt inline-flex min-h-9 items-center gap-1 underline"
            href={diagnostics.sentryUrl}
            target="_blank"
            rel="noreferrer"
          >
            View in Sentry <ExternalLink className="size-3" />
          </a>
        )}
        {diagnostics?.cloudflareUrl && (
          <a
            className="text-cobalt inline-flex min-h-9 items-center gap-1 underline"
            href={diagnostics.cloudflareUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open Workers Observability <ExternalLink className="size-3" />
          </a>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            if (await copyText(JSON.stringify(detail, null, 2)))
              setCopied(true);
            else toast.error("Could not copy error details");
          }}
        >
          <Copy className="size-3" />
          <span aria-live="polite">{copied ? "Copied" : "Copy details"}</span>
        </Button>
      </div>
      {diagnostics?.cfRayId && (
        <p>
          Search Cloudflare for Ray ID{" "}
          <span className="font-mono">{diagnostics.cfRayId}</span>.
        </p>
      )}
    </div>
  );
}

export function ErrorDetails({ error }: { error: unknown }) {
  if (!hasErrorDetails(error)) return null;
  return (
    <details className="w-full min-w-0 text-xs">
      <summary className="min-h-9 cursor-pointer py-2 text-muted-foreground focus-visible:outline-ring">
        Technical details
      </summary>
      <div className="max-h-[60dvh] overflow-y-auto border border-border bg-muted/50 p-3">
        <ErrorDetailsBody error={error} />
      </div>
    </details>
  );
}

/**
 * Keys a toast to what the user sees plus the server's error code (NOT
 * requestId — each retry gets a fresh request id, and re-keying on it would
 * defeat the dedupe this id exists for) so repeated failures of the same kind
 * update one toast in place instead of stacking duplicates.
 */
export function errorToastId(error: UnparsedError, message?: string): string {
  const detail = getAppErrorDetails(error);
  return `error-toast:${detail.code ?? ""}:${message ?? detail.message}`;
}

export function showErrorToast(error: UnparsedError, message?: string) {
  const detail = getAppErrorDetails(error);
  const title = message ?? detail.message;
  const id = errorToastId(error, message);
  if (!hasErrorDetails(error)) {
    toast.error(title, { id });
    return;
  }
  toast.error(title, {
    id,
    action: {
      label: "Details",
      onClick: () => {
        openErrorDetailsDialog(error);
      },
    },
  });
}
