import * as Sentry from "@sentry/tanstackstart-react";
import {
  type ErrorComponentProps,
  Link,
  useRouter,
} from "@tanstack/react-router";
import {
  AlertCircle,
  ChevronDown,
  LogIn,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { getAppErrorDetails, getErrorMessage } from "~/lib/error-utils";

type ErrorCategory = "auth" | "notFound" | "validation" | "network" | "generic";

const FRIENDLY_MESSAGES: Record<ErrorCategory, string> = {
  auth: "You need to sign in to view this page",
  notFound: "The item you're looking for doesn't exist or has been deleted",
  validation: "The request contained invalid data",
  network: "Unable to connect to the server. Please check your connection.",
  generic: "Something went wrong",
};

const categorizeError = (
  code: string | undefined,
  reason: string | undefined,
  message: string,
): ErrorCategory => {
  // Auth errors
  if (code === "UNAUTHORIZED" || reason === "UNAUTHORIZED") {
    return "auth";
  }

  // Not found errors
  if (
    code === "NOT_FOUND" ||
    reason?.includes("NOT_FOUND") ||
    message.toLowerCase().includes("not found")
  ) {
    return "notFound";
  }

  // Validation errors
  if (code === "BAD_REQUEST" || code === "PARSE_ERROR") {
    return "validation";
  }

  // Network errors
  if (
    message.toLowerCase().includes("network") ||
    message.toLowerCase().includes("fetch") ||
    message.toLowerCase().includes("connection")
  ) {
    return "network";
  }

  return "generic";
};

const getIcon = (category: ErrorCategory) => {
  switch (category) {
    case "network":
      return <WifiOff className="h-12 w-12 text-muted-foreground" />;
    case "notFound":
      return <AlertCircle className="h-12 w-12 text-muted-foreground" />;
    default:
      return <AlertCircle className="h-12 w-12 text-destructive" />;
  }
};

/**
 * Shared error component for route-level errors.
 * Use as `errorComponent` in route definitions.
 */
export function RouteErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const { code, reason, message } = getAppErrorDetails(error);
  const rawMessage = getErrorMessage(error);
  const category = categorizeError(code, reason, rawMessage);
  const friendlyMessage = FRIENDLY_MESSAGES[category];

  // Capture unexpected errors to Sentry (not auth/notFound which are expected)
  useEffect(() => {
    if (category === "generic" || category === "network") {
      Sentry.captureException(error);
    }
  }, [error, category]);

  // Get stack trace if available
  const stack = error instanceof Error ? error.stack : undefined;

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center space-y-4 p-8">
      {getIcon(category)}

      <h2 className="font-semibold text-xl">
        {category === "notFound" ? "Not Found" : "Something went wrong"}
      </h2>

      <p className="max-w-md text-center text-muted-foreground">
        {friendlyMessage}
      </p>

      {/* Auth-specific: Sign in button */}
      {category === "auth" && (
        <Button
          variant="default"
          render={
            <Link to="/auth/$authView" params={{ authView: "sign-in" }} />
          }
          nativeButton={false}
        >
          <LogIn className="mr-2 h-4 w-4" />
          Sign in
        </Button>
      )}

      {/* Action buttons for non-auth errors */}
      {category !== "auth" && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              reset?.();
              router.invalidate();
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Try Again
          </Button>
          <Button variant="ghost" render={<Link to="/" />} nativeButton={false}>
            Go Home
          </Button>
        </div>
      )}

      {/* Collapsible technical details */}
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground text-xs"
            />
          }
        >
          Technical Details
          <ChevronDown
            className={`ml-1 h-3 w-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 max-w-lg space-y-2 rounded-md border bg-muted/50 p-3 text-left font-mono text-xs">
            {code && (
              <div>
                <span className="text-muted-foreground">Code: </span>
                <span className="text-foreground">{code}</span>
              </div>
            )}
            {reason && (
              <div>
                <span className="text-muted-foreground">Reason: </span>
                <span className="text-foreground">{reason}</span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Message: </span>
              <span className="text-foreground">{message || rawMessage}</span>
            </div>
            {stack && (
              <details className="mt-2">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Stack trace
                </summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-2xs text-muted-foreground">
                  {stack}
                </pre>
              </details>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
