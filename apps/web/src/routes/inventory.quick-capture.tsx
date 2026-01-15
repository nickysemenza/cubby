import { createFileRoute } from "@tanstack/react-router";
import QuickCaptureForm from "~/app/inventory/quick-capture/quick-capture-form";
import { PageWrapper } from "~/components/layout/page-wrapper";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

export const Route = createFileRoute("/inventory/quick-capture")({
  component: QuickCapturePage,
});

function QuickCapturePage() {
  return (
    <PageWrapper>
      <Card>
        <CardHeader>
          <CardTitle>Quick Capture</CardTitle>
          <CardDescription>
            Quickly add inventory items by scanning barcodes
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QuickCaptureForm />
        </CardContent>
      </Card>
    </PageWrapper>
  );
}
