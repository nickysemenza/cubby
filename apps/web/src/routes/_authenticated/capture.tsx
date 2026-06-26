import { createFileRoute, Link } from "@tanstack/react-router";
import { ScanBarcode } from "lucide-react";
import { CaptureFlow } from "~/app/capture/capture-flow";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/capture")({
  component: CapturePage,
  pendingComponent: CapturePagePending,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: "Scan a shelf | cubby" }] }),
});

function CapturePage() {
  return (
    <Page
      variant="list"
      eyebrow="Beta"
      title="Scan a shelf"
      compact
      decoration="none"
      actions={
        <Button
          variant="outline"
          render={<Link to="/inventory/quick-capture" />}
          nativeButton={false}
        >
          <ScanBarcode className="mr-1 h-3.5 w-3.5" />
          Quick capture
        </Button>
      }
    >
      <CaptureFlow />
    </Page>
  );
}

function CapturePagePending() {
  return (
    <Page
      variant="list"
      eyebrow="Beta"
      title="Scan a shelf"
      compact
      decoration="none"
    >
      <Stack gap="lg">
        <Skeleton className="min-h-80 w-full rounded-none" />
        <Skeleton className="h-20 w-full rounded-none" />
      </Stack>
    </Page>
  );
}
