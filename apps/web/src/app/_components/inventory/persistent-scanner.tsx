/**
 * PersistentScanner - Always-on barcode scanner for mobile-first scanning.
 *
 * Features:
 * - Camera starts immediately on mount via getUserMedia
 * - Full-width viewfinder with horizontal barcode guide overlay
 * - Animated scan line for visual feedback
 * - Green flash + confirmation beep on successful scan
 * - Running tally and recently-scanned chips for a continuous multi-add sweep
 * - Torch (flashlight) toggle button
 * - Camera permission recovery with helpful instructions
 *
 * Uses barcode-detector (ZXing-C++ WASM) for fast detection, cropped to the
 * guide box below (the hook measures it — see useBarcodeScanner/scan-roi).
 */

import { FlashlightIcon } from "@phosphor-icons/react/dist/csr/Flashlight";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";

import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { ScannerStatusOverlay } from "./scanner-status-overlay";
import {
  type BarcodeFormat,
  QR_CODE_FORMATS,
  UNIVERSAL_SCAN_FORMATS,
  useBarcodeScanner,
  useScanBeep,
} from "./useBarcodeScanner";

export { QR_CODE_FORMATS, UNIVERSAL_SCAN_FORMATS };

/** One recently-scanned item, shown as a chip under the viewfinder. */
export interface ScanFeedbackEntry {
  /** Stable per scan — the same code can legitimately be added twice. */
  key: string;
  /** Product name once resolved, else the raw code. */
  label: string;
  /**
   * `confirmed` is a sweep outcome, not a lesser `added`: the row was already
   * on this shelf and only its `verifiedAt` moved. `queued` means the product
   * lives elsewhere and a decision is waiting at the end of the sweep.
   */
  status: "pending" | "added" | "confirmed" | "queued" | "failed";
}

const NO_RECENT_SCANS: readonly ScanFeedbackEntry[] = [];

/** Chip tone per outcome. Quiet for "nothing changed", warning for "needs you". */
const SCAN_CHIP_VARIANT = {
  pending: "outline",
  added: "positive",
  confirmed: "slate",
  queued: "warning",
  failed: "destructive",
} as const satisfies Record<ScanFeedbackEntry["status"], string>;

export interface PersistentScannerProps {
  onScan: (barcode: string) => void;
  onError?: (error: string) => void;
  enabled?: boolean;
  formatsToSupport: BarcodeFormat[];
  scanHintText: string;
  /**
   * Same-code debounce (ms). This is the accept gate — flash, beep and the
   * consumer's `onScan` all fire once per accepted read.
   */
  debounceMs?: number;
  /**
   * Running session tally for the viewfinder HUD, preformatted by the caller.
   *
   * A string rather than a count because the scanner does not know what its
   * consumer is tallying — the sweep reads two kinds of thing and the old
   * `addedCount` badge said "added" for a number that already included
   * confirmations. Empty hides the badge.
   */
  hudText?: string;
  /** Newest-first recently-scanned chips (the caller caps the length). */
  recentScans?: readonly ScanFeedbackEntry[];
}

export interface PersistentScannerPort {
  readonly Scanner: ComponentType<PersistentScannerProps>;
  readonly formats: PersistentScannerProps["formatsToSupport"];
}

export const productionPersistentScannerPort: PersistentScannerPort = {
  Scanner: PersistentScanner,
  formats: UNIVERSAL_SCAN_FORMATS,
};

const reticleClassName = (
  hasQr: boolean,
  hasLinearBarcode: boolean,
  scanFlash: boolean,
): string => {
  const size =
    hasQr && hasLinearBarcode
      ? "h-44 w-[85%]"
      : hasQr
        ? "size-48"
        : "h-28 w-[85%]";
  return cn(
    "rounded-lg border-2 shadow-[var(--shadow-scan-scrim)] transition-colors duration-150",
    size,
    scanFlash
      ? "border-positive shadow-[var(--shadow-scan-flash)]"
      : "border-white/60",
  );
};

const ScannerStatus = ({
  status,
  errorMessage,
  retry,
}: Pick<
  ReturnType<typeof useBarcodeScanner>,
  "status" | "errorMessage" | "retry"
>) => {
  if (status === "loading")
    return (
      <ScannerStatusOverlay status="loading" message="Starting camera..." />
    );
  if (status === "error")
    return (
      <ScannerStatusOverlay
        status="error"
        errorMessage={errorMessage}
        onRetry={retry}
        retryLabel="Try Again"
      />
    );
  return status === "permission_denied" ? (
    <ScannerStatusOverlay status="permission-denied" onRetry={retry} />
  ) : null;
};

export function PersistentScanner({
  onScan,
  onError,
  enabled = true,
  formatsToSupport,
  scanHintText,
  debounceMs,
  hudText = "",
  recentScans = NO_RECENT_SCANS,
}: PersistentScannerProps) {
  const [scanFlash, setScanFlash] = useState(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reticleRef = useRef<HTMLDivElement | null>(null);
  const beep = useScanBeep(enabled);

  const handleScan = useCallback(
    (barcode: string) => {
      // Accepted read (the hook already debounced the repeated decodes of a
      // barcode held in frame) — flash and blip once, then hand it up.
      setScanFlash(true);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setScanFlash(false), 300);
      beep();

      onScan(barcode);
    },
    [onScan, beep],
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
    debounceMs,
    reticleRef,
  });

  if (!enabled) {
    return null;
  }

  const hasQr = formatsToSupport.includes("qr_code");
  const hasLinearBarcode = formatsToSupport.some(
    (format) => format !== "qr_code",
  );

  return (
    <Stack gap="sm">
      <div className="relative aspect-[4/3] max-h-[min(60dvh,28rem)] w-full overflow-hidden bg-black md:aspect-[4/3] md:max-h-none md:rounded-lg">
        {/* Video element — camera feed */}
        <video
          ref={videoRef}
          className="h-full w-full object-cover md:aspect-[4/3] md:h-auto"
          playsInline
          muted
        />

        <ScannerStatus
          status={status}
          errorMessage={errorMessage}
          retry={retry}
        />

        {/*
          Viewfinder overlay — only when scanning. The guide element is also the
          detection ROI: `reticleRef` is what the hook measures, so the crop and
          the box the user aims with can never drift apart.
        */}
        {status === "scanning" && (
          <Row
            align="center"
            justify="center"
            className="pointer-events-none absolute inset-0"
          >
            {/* Darkened edges around the guide */}
            <div
              ref={reticleRef}
              className={reticleClassName(hasQr, hasLinearBarcode, scanFlash)}
            />
          </Row>
        )}

        {/* Session tally — eyes-free confirmation that the sweep is landing */}
        {status === "scanning" && hudText !== "" && (
          <Badge className="absolute top-3 left-3 h-auto border-transparent bg-black/60 px-2 py-1 text-sm text-white">
            {hudText}
          </Badge>
        )}

        {/* Torch button */}
        {torchAvailable && status === "scanning" && (
          <Button
            variant={torchEnabled ? "default" : "secondary"}
            size="icon"
            className="absolute top-3 right-3 size-10 rounded-full ring-1 ring-border"
            onClick={toggleTorch}
            aria-label={
              torchEnabled ? "Turn off flashlight" : "Turn on flashlight"
            }
          >
            <FlashlightIcon
              className="size-5"
              weight={torchEnabled ? "fill" : "regular"}
            />
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

      {/* Recently scanned — newest first, so a haul can be ripped through
          without watching the form below the sheet. */}
      {recentScans.length > 0 && (
        <Row gap="xs" wrap align="center" className="min-w-0">
          {recentScans.map((entry) => (
            <Badge
              key={entry.key}
              variant={SCAN_CHIP_VARIANT[entry.status]}
              className="max-w-44 font-sans tracking-normal normal-case"
              title={entry.label}
            >
              <span className="min-w-0 truncate">{entry.label}</span>
            </Badge>
          ))}
        </Row>
      )}
    </Stack>
  );
}
