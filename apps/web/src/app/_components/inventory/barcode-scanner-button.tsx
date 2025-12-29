import { Camera, Loader2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";
import { ColoredAlert } from "~/components/common/colored-alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

// Type for barcode scan result (from @zxing/library)
interface BarcodeResult {
  getText(): string;
}

// Dynamically import the scanner to avoid SSR issues
const BarcodeScanner = lazy(() =>
  import("react-qr-barcode-scanner").then((mod) => ({
    default: mod.default as React.ComponentType<{
      onUpdate: (err: unknown, result?: BarcodeResult) => void;
      onError?: (err: string | DOMException) => void;
      facingMode?: string;
    }>,
  })),
);

const ScannerLoading = () => (
  <div className="flex h-64 items-center justify-center">
    <Loader2 className="h-8 w-8 animate-spin" />
  </div>
);

interface BarcodeScannerButtonProps {
  onScan: (barcode: string) => void;
  disabled?: boolean;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
}

export function BarcodeScannerButton({
  onScan,
  disabled,
  variant = "outline",
  size = "icon",
  className,
}: BarcodeScannerButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleScan = useCallback(
    (result: string | null) => {
      if (result) {
        onScan(result);
        setIsOpen(false);
      }
    },
    [onScan],
  );

  const handleError = useCallback((err: string | DOMException) => {
    console.error("Barcode scanner error:", err);
    const message = typeof err === "string" ? err : err.message;
    setError(message || "Failed to access camera");
  }, []);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={() => {
          setError(null);
          setIsOpen(true);
        }}
        disabled={disabled}
        className={className}
        title="Scan barcode"
      >
        <Camera className="h-4 w-4" />
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              Scan Barcode
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {error ? (
              <ColoredAlert variant="destructive">
                <p className="font-medium">Camera Error</p>
                <p className="text-sm">{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setError(null)}
                >
                  Try Again
                </Button>
              </ColoredAlert>
            ) : (
              <div className="overflow-hidden rounded-lg">
                <Suspense fallback={<ScannerLoading />}>
                  <BarcodeScanner
                    onUpdate={(_err: unknown, result?: BarcodeResult) => {
                      if (result) {
                        handleScan(result.getText());
                      }
                    }}
                    onError={handleError}
                    facingMode="environment"
                  />
                </Suspense>
              </div>
            )}

            <p className="text-center text-muted-foreground text-sm">
              Point your camera at a barcode to scan
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
