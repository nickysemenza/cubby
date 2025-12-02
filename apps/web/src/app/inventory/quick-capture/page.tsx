import { Suspense } from "react";
import QuickCaptureForm from "./quick-capture-form";

interface QuickCapturePageProps {
  searchParams: Promise<{ locationId?: string }>;
}

export default async function QuickCapturePage({
  searchParams,
}: QuickCapturePageProps) {
  const params = await searchParams;

  return (
    <div className="container mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Quick Inventory Capture</h1>
        <p className="text-muted-foreground">
          Rapidly add items to your inventory. Select a location and start
          adding products - new products are created automatically with minimal
          details. Use the <strong>Unique</strong> toggle for one-of-a-kind
          items.
        </p>
      </div>
      <Suspense fallback={<div>Loading...</div>}>
        <QuickCaptureForm initialLocationId={params.locationId} />
      </Suspense>
    </div>
  );
}
