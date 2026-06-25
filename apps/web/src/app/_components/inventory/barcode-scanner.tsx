import { ScannerStatusOverlay } from "./scanner-status-overlay";
import { BARCODE_FORMATS, useBarcodeScanner } from "./useBarcodeScanner";

interface BarcodeScannerProps {
  onScan: (barcode: string) => void;
  onError?: (error: string) => void;
}

export function BarcodeScanner({ onScan, onError }: BarcodeScannerProps) {
  const { videoRef, status, errorMessage, retry } = useBarcodeScanner({
    onScan,
    onError,
    formats: BARCODE_FORMATS,
  });

  return (
    <div className="relative min-h-[300px] overflow-hidden rounded-lg bg-black">
      <video
        ref={videoRef}
        className="min-h-[300px] w-full object-cover"
        playsInline
        muted
      />

      {status === "loading" && <ScannerStatusOverlay status="loading" />}

      {status === "error" && (
        <ScannerStatusOverlay
          status="error"
          errorMessage={errorMessage}
          onRetry={retry}
          retryLabel="Try Again"
        />
      )}

      {status === "permission_denied" && (
        <ScannerStatusOverlay status="permission-denied" onRetry={retry} />
      )}
    </div>
  );
}
