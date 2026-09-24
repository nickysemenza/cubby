/**
 * One-shot product-barcode scan that fills a form field.
 *
 * The counterpart to {@link LocationScanButton}: same sheet-plus-camera shape,
 * but it closes on the first accepted read instead of staying open for a sweep.
 * Both sit on `PersistentScanner`, so there is exactly one camera stack in the
 * app — reticle ROI, torch, beep, and same-code debounce included.
 */

import { CameraIcon } from "@phosphor-icons/react/dist/csr/Camera";
import { useState } from "react";

import { Button } from "~/components/ui/button";

import { BARCODE_FORMATS } from "./persistent-scanner";
import { ScanSheet } from "./scan-sheet";

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
        <CameraIcon className="size-4" />
      </Button>
      <ScanSheet
        open={open}
        onOpenChange={setOpen}
        title="Scan barcode"
        description="The first code read fills this row's product."
        formats={BARCODE_FORMATS}
        scanHintText="Point at a product barcode"
        // The raw string, unnarrowed: this field is fed by `useUpcLookup`,
        // which is UPC-only. Routing it through the shared scan helpers would
        // silently start accepting ISBNs and `PRD-` labels here.
        onScan={(value) => {
          onScan(value);
          setOpen(false);
        }}
        manualEntry={{
          ariaLabel: "Enter a product barcode",
          placeholder: "Can't scan? Type a barcode",
          submitLabel: "Use",
        }}
      />
    </>
  );
}
