import { Link } from "@tanstack/react-router";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";

/**
 * Branded 404. Used as the root route's `notFoundComponent` and the router-wide
 * `defaultNotFoundComponent` (see router.tsx) so an unmatched URL *or* a
 * `notFound()` thrown from any route without its own handler (e.g. the
 * `_authenticated` subtree) lands on the same page instead of TanStack's
 * generic `<p>Not Found</p>`.
 */
export function RouteNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center space-y-6 p-4">
      <Row align="center" gap="sm">
        {/* Canonical logo asset — same source the nav uses, so the mark can't
            drift (the old inline copy had stale, hardcoded fill colors). */}
        <img src="/favicon.svg" alt="" className="size-12" />
        <h1 className="font-bold text-4xl">404</h1>
      </Row>
      <Stack gap="sm" className="text-center">
        <h2 className="font-semibold text-2xl">Page not found</h2>
        <p className="max-w-md text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
      </Stack>
      <Button render={<Link to="/" />} nativeButton={false}>
        Return home
      </Button>
    </div>
  );
}
