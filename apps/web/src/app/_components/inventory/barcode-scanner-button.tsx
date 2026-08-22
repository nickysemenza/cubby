/**
 * One-shot product-barcode scan that fills a form field.
 *
 * The counterpart to {@link LocationScanButton}: same sheet-plus-camera shape,
 * but it closes on the first accepted read instead of staying open for a sweep.
 * Both sit on `PersistentScanner`, so there is exactly one camera stack in the
 * app — reticle ROI, torch, beep, and same-code debounce included.
 */

import { Camera } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { BARCODE_FORMATS, PersistentScanner } from "./persistent-scanner";

export function BarcodeScannerButton({
  onScan,
  disabled,
  variant = "outline",
  size = "icon",
  className,
}: {
  onScan: (barcode: string) => void;
  disabled?: boolean;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "icon";
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={className}
        title="Scan barcode"
      >
        <Camera className="size-4" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="p-4" showCloseButton={false}>
          <SheetHeader className="p-0 pb-4">
            <SheetTitle>Scan barcode</SheetTitle>
            <SheetDescription>
              The first code read fills this row's product.
            </SheetDescription>
          </SheetHeader>
          <PersistentScanner
            onScan={(value) => {
              onScan(value);
              setOpen(false);
            }}
            formatsToSupport={BARCODE_FORMATS}
            scanHintText="Point at a product barcode"
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
