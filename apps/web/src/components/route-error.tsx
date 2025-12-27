import {
  type ErrorComponentProps,
  Link,
  useRouter,
} from "@tanstack/react-router";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { getErrorMessage } from "~/lib/error-utils";

/**
 * Shared error component for route-level errors.
 * Use as `errorComponent` in route definitions.
 */
export function RouteErrorComponent({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const message = getErrorMessage(error);

  // Check if it's a not-found type error
  const isNotFound =
    message.toLowerCase().includes("not found") ||
    (error instanceof Error && error.message.includes("NOT_FOUND"));

  if (isNotFound) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center space-y-4 p-8">
        <AlertCircle className="h-12 w-12 text-muted-foreground" />
        <h2 className="font-semibold text-xl">Not Found</h2>
        <p className="text-center text-muted-foreground">
          The item you're looking for doesn't exist or has been deleted.
        </p>
        <Link to="/">
          <Button variant="outline">Go Home</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-[400px] flex-col items-center justify-center space-y-4 p-8">
      <AlertCircle className="h-12 w-12 text-destructive" />
      <h2 className="font-semibold text-xl">Something went wrong</h2>
      <p className="max-w-md text-center text-muted-foreground">{message}</p>
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
        <Link to="/">
          <Button variant="ghost">Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
