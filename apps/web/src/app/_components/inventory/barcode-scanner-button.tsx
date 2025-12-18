"use client";

import { useState, useCallback } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Camera, X, Loader2 } from "lucide-react";
import dynamic from "next/dynamic";

// Dynamically import the scanner to avoid SSR issues
const BarcodeScanner = dynamic(
  () => import("react-qr-barcode-scanner").then((mod) => mod.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    ),
  },
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
              <div className="rounded border border-red-200 bg-red-50 p-4 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
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
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg">
                <BarcodeScanner
                  onUpdate={(_err, result) => {
                    if (result) {
                      handleScan(result.getText());
                    }
                  }}
                  onError={handleError}
                  facingMode="environment"
                />
              </div>
            )}

            <p className="text-muted-foreground text-center text-sm">
              Point your camera at a barcode to scan
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
