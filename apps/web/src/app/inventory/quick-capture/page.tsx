import { Suspense } from "react";
import QuickCaptureForm from "./quick-capture-form";

export default function QuickCapturePage() {
  return (
    <div className="container mx-auto py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Quick Inventory Capture</h1>
        <p className="text-muted-foreground">
          Rapidly add items to your inventory. Select a location and start
          adding products - new products are created automatically with minimal
          details.
        </p>
      </div>
      <Suspense fallback={<div>Loading...</div>}>
        <QuickCaptureForm />
      </Suspense>
    </div>
  );
}
