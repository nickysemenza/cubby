/**
 * PersistentScanner - Always-on barcode scanner for mobile-first scanning.
 *
 * Features:
 * - Camera starts immediately on mount
 * - Full-width viewfinder with scan frame overlay
 * - Torch (flashlight) toggle button
 * - Audio feedback on successful scan
 * - 30fps for faster recognition
 */

import {
  Html5Qrcode,
  Html5QrcodeScannerState,
  Html5QrcodeSupportedFormats,
} from "html5-qrcode";
import { Flashlight, FlashlightOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";

export const BARCODE_FORMATS = [
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.CODE_128, // Added for non-UPC products
];

export const QR_CODE_FORMATS = [Html5QrcodeSupportedFormats.QR_CODE];

// Global counter to ensure unique IDs across strict mode remounts
let scannerIdCounter = 0;

interface PersistentScannerProps {
  onScan: (barcode: string) => void;
  onError?: (error: string) => void;
  enabled?: boolean;
  formatsToSupport: Html5QrcodeSupportedFormats[];
  scanHintText: string;
}

export function PersistentScanner({
  onScan,
  onError,
  enabled = true,
  formatsToSupport,
  scanHintText,
}: PersistentScannerProps) {
  const [containerId] = useState(
    () => `persistent-scanner-${++scannerIdCounter}`,
  );
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const lastScanRef = useRef<string | null>(null);
  const lastScanTimeRef = useRef<number>(0);

  // Debounce scans (prevent rapid duplicate scans)
  const handleScan = useCallback(
    (barcode: string) => {
      const now = Date.now();
      // Ignore if same barcode within 2 seconds
      if (
        barcode === lastScanRef.current &&
        now - lastScanTimeRef.current < 2000
      ) {
        return;
      }

      lastScanRef.current = barcode;
      lastScanTimeRef.current = now;

      onScan(barcode);
    },
    [onScan],
  );

  // Toggle torch
  const toggleTorch = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner || !torchAvailable) return;

    try {
      const track = scanner.getRunningTrackCameraCapabilities();
      if (track?.torchFeature()?.isSupported()) {
        const newState = !torchEnabled;
        await track.torchFeature().apply(newState);
        setTorchEnabled(newState);
      }
    } catch (err) {
      console.error("Torch toggle failed:", err);
    }
  }, [torchEnabled, torchAvailable]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const startScanner = async () => {
      const container = document.getElementById(containerId);
      if (!container || cancelled) return;

      const scanner = new Html5Qrcode(containerId, {
        formatsToSupport,
        verbose: false,
      });

      if (cancelled) return;
      scannerRef.current = scanner;

      try {
        // Get available cameras
        const cameras = await Html5Qrcode.getCameras();
        if (cameras.length === 0) {
          throw new Error("No cameras found");
        }

        // Prefer back camera
        const backCamera = cameras.find(
          (c) =>
            c.label.toLowerCase().includes("back") ||
            c.label.toLowerCase().includes("rear") ||
            c.label.toLowerCase().includes("environment"),
        );
        const cameraId = backCamera?.id ?? cameras[0].id;

        await scanner.start(
          cameraId,
          {
            fps: 30, // Increased from 20 for faster recognition
            disableFlip: true,
            aspectRatio: 1.0, // Square viewfinder works better on mobile
          },
          (decodedText) => {
            if (cancelled) return;
            handleScan(decodedText);
          },
          () => {
            // Ignore scan failures
          },
        );

        if (!cancelled) {
          setIsLoading(false);
          setError(null);

          // Check if torch is available
          try {
            const track = scanner.getRunningTrackCameraCapabilities();
            if (track?.torchFeature()?.isSupported()) {
              setTorchAvailable(true);
            }
          } catch {
            // Torch not available
          }
        }
      } catch (err) {
        console.error("Scanner start error:", err);
        if (!cancelled) {
          setIsLoading(false);
          const message = err instanceof Error ? err.message : String(err);
          setError(message || "Failed to start scanner");
          onError?.(message || "Failed to start scanner");
        }
      }
    };

    // Small delay to ensure DOM is ready
    const timeoutId = setTimeout(startScanner, 100);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      const currentScanner = scannerRef.current;
      if (currentScanner) {
        try {
          const state = currentScanner.getState();
          if (
            state === Html5QrcodeScannerState.SCANNING ||
            state === Html5QrcodeScannerState.PAUSED
          ) {
            currentScanner.stop().catch(() => {});
          }
        } catch {
          // Ignore
        }
        scannerRef.current = null;
      }
    };
  }, [containerId, enabled, handleScan, onError, formatsToSupport]);

  if (!enabled) {
    return null;
  }

  return (
    <div className="relative w-full">
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80">
          <div className="flex flex-col items-center gap-2 text-white">
            <Spinner size="lg" />
            <span className="text-sm">Starting camera...</span>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-4">
          <div className="rounded-lg bg-destructive/90 p-4 text-center text-white">
            <p className="font-medium">Camera Error</p>
            <p className="mt-1 text-sm opacity-90">{error}</p>
          </div>
        </div>
      )}

      {/* Scanner container */}
      <div
        id={containerId}
        className="[&>video]:!h-full [&>video]:!w-full aspect-square w-full overflow-hidden rounded-lg bg-black [&>video]:object-cover"
      />

      {/* Scan frame overlay */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-48 w-48 rounded-lg border-2 border-white/60 shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]" />
      </div>

      {/* Torch button */}
      {torchAvailable && !isLoading && !error && (
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
      {!isLoading && !error && (
        <div className="absolute inset-x-0 bottom-3 text-center">
          <span className="rounded-full bg-black/60 px-3 py-1 text-sm text-white">
            {scanHintText}
          </span>
        </div>
      )}
    </div>
  );
}
