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

import { CameraOff, Flashlight, FlashlightOff, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
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
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80">
          <div className="flex flex-col items-center gap-2 text-white">
            <Spinner size="lg" />
            <span className="text-sm">Starting camera...</span>
          </div>
        </div>
      )}

      {/* Error state */}
      {status === "error" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-4">
          <div className="flex flex-col items-center gap-3 rounded-lg bg-destructive/90 p-4 text-center text-white">
            <CameraOff className="h-8 w-8 opacity-80" />
            <div>
              <p className="font-medium">Camera Error</p>
              <p className="mt-1 text-sm opacity-90">{errorMessage}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={retry}
              className="gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Try Again
            </Button>
          </div>
        </div>
      )}

      {/* Permission denied state */}
      {status === "permission_denied" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-4">
          <div className="flex max-w-xs flex-col items-center gap-3 rounded-lg bg-card p-5 text-center shadow-lg">
            <CameraOff className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium text-foreground">
                Camera access needed
              </p>
              <p className="mt-1.5 text-muted-foreground text-sm">
                To scan barcodes, allow camera access in{" "}
                <span className="font-medium text-foreground">
                  Settings &gt; Safari &gt; Camera
                </span>
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={retry}
              className="gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </div>
      )}

      {/* Viewfinder overlay — only when scanning */}
      {status === "scanning" && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
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
        </div>
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
          <span
            className={`rounded-full px-3 py-1 text-sm transition-colors duration-150 ${
              scanFlash
                ? "bg-positive text-primary-foreground"
                : "bg-black/60 text-white"
            }`}
          >
            {scanFlash ? "Scanned!" : scanHintText}
          </span>
        </div>
      )}
    </div>
  );
}
