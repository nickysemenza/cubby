import {
  Html5Qrcode,
  Html5QrcodeScannerState,
  Html5QrcodeSupportedFormats,
} from "html5-qrcode";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "~/components/ui/spinner";

const SUPPORTED_FORMATS = [
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.UPC_EAN_EXTENSION,
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
];

// Global counter to ensure unique IDs across strict mode remounts
let scannerIdCounter = 0;

interface BarcodeScannerProps {
  onScan: (barcode: string) => void;
  onError?: (error: string) => void;
}

export function BarcodeScanner({ onScan, onError }: BarcodeScannerProps) {
  const [containerId] = useState(() => `barcode-scanner-${++scannerIdCounter}`);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const hasScannedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const startScanner = async () => {
      const container = document.getElementById(containerId);
      if (!container || cancelled) return;

      const scanner = new Html5Qrcode(containerId, {
        formatsToSupport: SUPPORTED_FORMATS,
        verbose: false,
      });

      if (cancelled) return;
      scannerRef.current = scanner;

      try {
        // Get available cameras first
        const cameras = await Html5Qrcode.getCameras();
        if (cameras.length === 0) {
          throw new Error("No cameras found");
        }

        // Prefer back camera if available, otherwise use first camera
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
            fps: 20,
            disableFlip: true,
          },
          (decodedText) => {
            if (hasScannedRef.current || cancelled) return;
            hasScannedRef.current = true;
            onScan(decodedText);
          },
          () => {
            // Ignore scan failures
          },
        );
        if (!cancelled) {
          setIsLoading(false);
        }
      } catch (err) {
        console.error("Scanner start error:", err);
        if (!cancelled) {
          setIsLoading(false);
          const message = err instanceof Error ? err.message : String(err);
          onError?.(message || "Failed to start scanner");
        }
      }
    };

    // Small delay to ensure DOM is ready
    const timeoutId = setTimeout(startScanner, 50);

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
  }, [containerId, onScan, onError]);

  return (
    <div className="relative min-h-[300px]">
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <Spinner size="lg" />
        </div>
      )}
      <div
        id={containerId}
        className="[&>video]:!w-full min-h-[300px] w-full overflow-hidden rounded-lg"
      />
    </div>
  );
}
