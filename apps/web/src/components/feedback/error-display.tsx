import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { getAppErrorDetails } from "~/lib/error-utils";
import { cn } from "~/lib/utils";

import { ErrorDetails } from "./error-details";

interface ErrorDisplayProps {
  error: unknown;
  className?: string;
  /**
   * Names what failed to load: the headline reads "Couldn't load <title>."
   * and the raw error message becomes the secondary reason line. Omitted,
   * the raw message is the headline itself (a bare failed page/mutation,
   * where there is no narrower "this section" to name).
   */
  title?: string;
  /** Renders an outline `sm` Retry button wired to this handler. */
  onRetry?: () => void;
}

/**
 * A destructive dot, a plain-language line, and the error's own code/reason
 * in mono — the ledger's quiet way of marking a failed read. Callers that
 * already render their own retry control alongside this (most of the app)
 * simply omit `onRetry`.
 */
export function ErrorDisplay({
  error,
  className,
  title,
  onRetry,
}: ErrorDisplayProps) {
  const { code, reason, message } = getAppErrorDetails(error);

  if (code === "UNAUTHORIZED") {
    return (
      <div role="alert" className={cn("flex items-center gap-2.5", className)}>
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-destructive"
        />
        <div className="flex items-center gap-2 text-sm">
          <span>Please sign in to continue</span>
          <Button
            variant="link"
            size="sm"
            render={
              <Link to="/auth/$authView" params={{ authView: "sign-in" }} />
            }
            nativeButton={false}
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  const headline = title ? `Couldn't load ${title}.` : message;
  // Once `title` claims the headline, the raw message becomes the reason
  // line; without a title the message already is the headline, so only the
  // operation code/reason (if any) rides along.
  const reasonText = title ? message : undefined;
  const opId = reason || code;

  return (
    <div role="alert" className={cn("flex items-start gap-2.5", className)}>
      <span
        aria-hidden
        className="mt-1.5 size-2 shrink-0 rounded-full bg-destructive"
      />
      <div className="flex min-w-0 flex-col items-start gap-1">
        <span className="text-sm text-foreground">{headline}</span>
        {reasonText || opId ? (
          <span className="text-xs text-muted-foreground">
            {reasonText}
            {reasonText && opId ? " " : null}
            {opId ? <span className="font-mono">{opId}</span> : null}
          </span>
        ) : null}
        <ErrorDetails error={error} />
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}
