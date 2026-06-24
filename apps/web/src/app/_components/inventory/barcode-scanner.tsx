import { CameraOff, RotateCcw } from "lucide-react";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
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

      {status === "loading" && (
        <Row
          align="center"
          justify="center"
          className="absolute inset-0 z-10 bg-background/80"
        >
          <Spinner size="lg" />
        </Row>
      )}

      {status === "error" && (
        <Row
          align="center"
          justify="center"
          className="absolute inset-0 z-10 bg-black/80 p-4"
        >
          <div className="flex flex-col items-center gap-4 rounded-lg bg-destructive/90 p-4 text-center text-white">
            <CameraOff className="h-8 w-8 opacity-80" />
            <div>
              <p className="font-medium">Camera Error</p>
              <p className="mt-1 text-sm opacity-90">{errorMessage}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={retry}
              className="gap-2"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Try Again
            </Button>
          </div>
        </Row>
      )}

      {status === "permission_denied" && (
        <Row
          align="center"
          justify="center"
          className="absolute inset-0 z-10 bg-black/80 p-4"
        >
          <div className="flex max-w-xs flex-col items-center gap-4 rounded-lg bg-card p-4 text-center shadow-lg">
            <CameraOff className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium text-foreground">
                Camera access needed
              </p>
              <p className="mt-2 text-muted-foreground text-sm">
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
              className="gap-2"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        </Row>
      )}
    </div>
  );
}
