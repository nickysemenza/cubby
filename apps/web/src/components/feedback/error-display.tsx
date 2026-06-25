import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { InkStamp } from "~/components/ui/ink-stamp";
import { getAppErrorDetails } from "~/lib/error-utils";
import { cn } from "~/lib/utils";

interface ErrorDisplayProps {
  error: unknown;
  className?: string;
}

/**
 * Stamped, not scary: errors read as a red ink stamp beside a plain-language
 * line, in a quiet card — the ledger's way of marking a failed entry.
 */
export function ErrorDisplay({ error, className }: ErrorDisplayProps) {
  const { code, reason, message } = getAppErrorDetails(error);

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-4 rounded-lg border border-[var(--border)] bg-card px-4 py-4 shadow-[var(--shadow-chunky-sm)]",
        className,
      )}
    >
      <InkStamp tone="red" className="shrink-0">
        {reason || code || "Error"}
      </InkStamp>
      {code === "UNAUTHORIZED" ? (
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
      ) : (
        <span className="min-w-0 text-sm">{message}</span>
      )}
    </div>
  );
}
