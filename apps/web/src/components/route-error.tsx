import { ArrowClockwiseIcon as RefreshCw } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react/dist/csr/CaretDown";
import { SignInIcon as LogIn } from "@phosphor-icons/react/dist/csr/SignIn";
import { WarningCircleIcon as AlertCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { WifiSlashIcon as WifiOff } from "@phosphor-icons/react/dist/csr/WifiSlash";
import * as Sentry from "@sentry/tanstackstart-react";
import {
  type ErrorComponentProps,
  Link,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorDetails } from "~/components/feedback/error-details";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { StartOperationError } from "~/integrations/tanstack-query/start-transport";
import { sentryEventUrl } from "~/lib/error-diagnostics";
import {
  getAppErrorDetails,
  getErrorMessage,
  isDynamicImportError,
  isSupersededViewTransitionError,
} from "~/lib/error-utils";

type ErrorCategory =
  | "auth"
  | "notFound"
  | "validation"
  | "network"
  | "staleBuild"
  | "navigation"
  | "generic";

const FRIENDLY_MESSAGES = {
  auth: "You need to sign in to view this page",
  notFound: "The item you're looking for doesn't exist or has been deleted",
  validation: "The request contained invalid data",
  network: "Unable to connect to the server. Please check your connection.",
  staleBuild:
    "Cubby couldn't load this version of the page. Reload to update the app.",
  navigation: "Navigation was interrupted. Reload the app to continue.",
  generic: "Something went wrong",
} satisfies Record<ErrorCategory, string>;

const categorizeError = (
  code: string | undefined,
  reason: string | undefined,
  message: string,
  error: Error,
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

  if (isDynamicImportError(error)) return "staleBuild";
  if (isSupersededViewTransitionError(error)) return "navigation";

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
      return <WifiOff className="size-12 text-muted-foreground" />;
    case "notFound":
      return <AlertCircle className="size-12 text-muted-foreground" />;
    default:
      return <AlertCircle className="size-12 text-destructive" />;
  }
};

/**
 * Shared error component for route-level errors.
 * Use as `errorComponent` in route definitions.
 */
export function RouteErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sentryEventId, setSentryEventId] = useState<string>();

  const { code, reason, message, diagnostics } = getAppErrorDetails(error);
  const rawMessage = getErrorMessage(error);
  const category = categorizeError(code, reason, rawMessage, error);
  const friendlyMessage = FRIENDLY_MESSAGES[category];
  const requestId =
    error instanceof StartOperationError ? error.requestId : undefined;

  useEffect(() => {
    if (
      error instanceof StartOperationError ||
      diagnostics?.origin === "server"
    )
      return;
    if (
      category === "generic" ||
      category === "network" ||
      category === "staleBuild"
    ) {
      const eventId = Sentry.captureException(
        error,
        requestId ? { tags: { request_id: requestId } } : undefined,
      );
      setSentryEventId(eventId);
    }
  }, [error, category, requestId, diagnostics?.origin]);

  const stack = error instanceof Error ? error.stack : undefined;

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center space-y-4 p-6">
      {getIcon(category)}

      <h2 className="text-xl font-semibold">
        {category === "notFound"
          ? "Not found"
          : category === "staleBuild"
            ? "App update required"
            : "Something went wrong"}
      </h2>

      <p className="max-w-md text-center text-muted-foreground">
        {diagnostics ? message : friendlyMessage}
      </p>

      {category === "auth" && (
        <Button
          variant="default"
          render={
            <Link to="/auth/$authView" params={{ authView: "sign-in" }} />
          }
          nativeButton={false}
        >
          <LogIn className="mr-2 size-4" />
          Sign in
        </Button>
      )}

      {category !== "auth" && (
        <Row gap="sm" className="flex-wrap justify-center">
          <Button
            variant="outline"
            onClick={() => {
              if (category === "staleBuild" || category === "navigation") {
                window.location.reload();
              } else {
                reset?.();
                router.invalidate();
              }
            }}
          >
            <RefreshCw className="mr-2 size-4" />
            {category === "staleBuild" || category === "navigation"
              ? "Reload app"
              : "Try again"}
          </Button>
          <Button variant="ghost" render={<Link to="/" />} nativeButton={false}>
            Go home
          </Button>
        </Row>
      )}

      <ErrorDetails error={error} />
      {!diagnostics && (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-muted-foreground"
              />
            }
          >
            Technical details
            <ChevronDown
              className={`ml-1 size-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Stack
              gap="sm"
              className="mt-2 w-[min(60rem,calc(100vw-2rem))] border border-[var(--border)] bg-muted/50 p-4 text-left font-mono text-sm leading-6 break-words"
            >
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
              {requestId && (
                <div>
                  {/* "Request ID", not "Trace ID": this is an OTel trace id in
                    dev but a Cloudflare ray id in prod — different systems,
                    different formats, so a generic label is the honest one. */}
                  <span className="text-muted-foreground">Request ID: </span>
                  <span className="text-foreground">{requestId}</span>
                </div>
              )}
              {sentryEventId && (
                <div>
                  <span className="text-muted-foreground">Sentry: </span>
                  <a
                    href={sentryEventUrl(sentryEventId)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-cobalt hover:text-cobalt-hover underline underline-offset-2"
                  >
                    View event {sentryEventId}
                  </a>
                </div>
              )}
              {stack && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    Stack trace
                  </summary>
                  <pre className="mt-1 max-h-96 overflow-auto text-xs whitespace-pre-wrap text-muted-foreground">
                    {stack}
                  </pre>
                </details>
              )}
            </Stack>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
