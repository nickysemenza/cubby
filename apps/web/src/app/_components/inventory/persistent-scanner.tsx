/**
 * PersistentScanner - Always-on barcode scanner for mobile-first scanning.
 *
 * Features:
 * - Camera starts immediately on mount via getUserMedia
 * - Full-width viewfinder with horizontal barcode guide overlay
 * - Animated scan line for visual feedback
 * - Green flash on successful scan
 * - Torch (flashlight) toggle button
 * - Camera permission recovery with helpful instructions
 *
 * Uses barcode-detector (ZXing-C++ WASM) for fast detection.
 */

import { Flashlight, FlashlightOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Row } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { ScannerStatusOverlay } from "./scanner-status-overlay";
import {
  BARCODE_FORMATS,
  type BarcodeFormat,
  QR_CODE_FORMATS,
  useBarcodeScanner,
} from "./useBarcodeScanner";

export { BARCODE_FORMATS, QR_CODE_FORMATS };

interface PersistentScannerProps {
  onScan: (barcode: string) => void;
  onError?: (error: string) => void;
  enabled?: boolean;
  formatsToSupport: BarcodeFormat[];
  scanHintText: string;
}

export function PersistentScanner({
  onScan,
  onError,
  enabled = true,
  formatsToSupport,
  scanHintText,
}: PersistentScannerProps) {
  const [scanFlash, setScanFlash] = useState(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleScan = useCallback(
    (barcode: string) => {
      // Trigger visual flash
      setScanFlash(true);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setScanFlash(false), 300);

      onScan(barcode);
    },
    [onScan],
  );

  // Clean up flash timeout on unmount
  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  const {
    videoRef,
    status,
    errorMessage,
    torchAvailable,
    torchEnabled,
    toggleTorch,
    retry,
  } = useBarcodeScanner({
    onScan: handleScan,
    onError,
    enabled,
    formats: formatsToSupport,
  });

  if (!enabled) {
    return null;
  }

  const isQrMode = formatsToSupport.includes("qr_code");

  return (
    <div className="relative w-full overflow-hidden rounded-lg bg-black">
      {/* Video element — camera feed */}
      <video
        ref={videoRef}
        className="aspect-[4/3] w-full object-cover"
        playsInline
        muted
      />

      {/* Loading overlay */}
      {status === "loading" && (
        <ScannerStatusOverlay status="loading" message="Starting camera..." />
      )}

      {/* Error state */}
      {status === "error" && (
        <ScannerStatusOverlay
          status="error"
          errorMessage={errorMessage}
          onRetry={retry}
          retryLabel="Try Again"
        />
      )}

      {/* Permission denied state */}
      {status === "permission_denied" && (
        <ScannerStatusOverlay status="permission-denied" onRetry={retry} />
      )}

      {/* Viewfinder overlay — only when scanning */}
      {status === "scanning" && (
        <Row
          align="center"
          justify="center"
          className="pointer-events-none absolute inset-0"
        >
          {/* Darkened edges around the guide */}
          {isQrMode ? (
            /* Square guide for QR codes */
            <div
              className={`h-48 w-48 rounded-lg border-2 shadow-[var(--shadow-scan-scrim)] transition-colors duration-150 ${
                scanFlash
                  ? "border-positive shadow-[var(--shadow-scan-flash)]"
                  : "border-white/60"
              }`}
            />
          ) : (
            /* Wide horizontal guide for barcodes */
            <div
              className={`h-28 w-[85%] rounded-lg border-2 shadow-[var(--shadow-scan-scrim)] transition-colors duration-150 ${
                scanFlash
                  ? "border-positive shadow-[var(--shadow-scan-flash)]"
                  : "border-white/60"
              }`}
            />
          )}
        </Row>
      )}

      {/* Torch button */}
      {torchAvailable && status === "scanning" && (
        <Button
          variant={torchEnabled ? "default" : "secondary"}
          size="icon"
          className="absolute top-3 right-3 h-10 w-10 rounded-full shadow-lg"
          onClick={toggleTorch}
          aria-label={
            torchEnabled ? "Turn off flashlight" : "Turn on flashlight"
          }
        >
          {torchEnabled ? (
            <Flashlight className="h-5 w-5" />
          ) : (
            <FlashlightOff className="h-5 w-5" />
          )}
        </Button>
      )}

      {/* Scan hint */}
      {status === "scanning" && (
        <div className="absolute inset-x-0 bottom-3 text-center">
          <Badge
            className={cn(
              "h-auto border-transparent px-2 py-1 text-sm transition-colors duration-150",
              // HUD overlay over the live camera feed — deliberate high-contrast
              // fills, not ledger paper tints.
              scanFlash
                ? "bg-positive text-primary-foreground"
                : "bg-black/60 text-white",
            )}
          >
            {scanFlash ? "Scanned!" : scanHintText}
          </Badge>
        </div>
      )}
    </div>
  );
}
