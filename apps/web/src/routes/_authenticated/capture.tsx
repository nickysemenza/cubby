import { createFileRoute } from "@tanstack/react-router";
import { InventoryCaptureWorkspace } from "~/app/inventory/capture/InventoryCaptureWorkspace";
import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { Skeleton } from "~/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/capture")({
  component: CapturePage,
  pendingComponent: CapturePagePending,
  errorComponent: RouteErrorComponent,
  head: () => ({ meta: [{ title: "Scan a shelf | cubby" }] }),
});

function CapturePage() {
  return <InventoryCaptureWorkspace mode="photo" />;
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
