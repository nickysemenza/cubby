import { Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import { copyText } from "~/lib/clipboard";
import { getAppErrorDetails, type UnparsedError } from "~/lib/error-utils";

export function ErrorDetails({ error }: { error: unknown }) {
  const [copied, setCopied] = useState(false);
  const detail = getAppErrorDetails(error);
  const diagnostics = detail.diagnostics;
  let causePath = "";
  const causes = diagnostics?.causes.map((cause) => {
    causePath += `/${JSON.stringify(cause)}`;
    return { cause, path: causePath };
  });
  if (!diagnostics && !detail.requestId) return null;
  return (
    <details className="w-full min-w-0 text-xs">
      <summary className="min-h-9 cursor-pointer py-2 text-muted-foreground focus-visible:outline-ring">
        Technical details
      </summary>
      <div className="flex max-h-[60dvh] min-w-0 flex-col gap-2 overflow-y-auto border border-border bg-muted/50 p-3 break-words">
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
    </details>
  );
}

export function showErrorToast(error: UnparsedError, message?: string) {
  const detail = getAppErrorDetails(error);
  if (!detail.diagnostics && !detail.requestId) {
    toast.error(message ?? detail.message);
    return;
  }
  toast.error(message ?? detail.message, {
    action: {
      label: "Details",
      onClick: () => {
        toast.error(detail.message, {
          description: <ErrorDetails error={error} />,
          duration: Infinity,
          closeButton: true,
        });
      },
    },
  });
}
