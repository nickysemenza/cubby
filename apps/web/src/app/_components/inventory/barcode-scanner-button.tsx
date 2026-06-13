import { Camera, X } from "lucide-react";
import { useCallback, useState } from "react";
import { ColoredAlert } from "~/components/common/colored-alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { BarcodeScanner } from "./barcode-scanner";

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
    (result: string) => {
      onScan(result);
      setIsOpen(false);
    },
    [onScan],
  );

  const handleError = useCallback((err: string) => {
    console.error("Barcode scanner error:", err);
    setError(err || "Failed to access camera");
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
        <DialogContent size="md">
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
              isOpen && (
                <BarcodeScanner onScan={handleScan} onError={handleError} />
              )
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
