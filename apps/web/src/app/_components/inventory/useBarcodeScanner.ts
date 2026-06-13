/**
 * useBarcodeScanner - Core hook for camera-based barcode scanning.
 *
 * Uses the `barcode-detector` package (ZXing-C++ WASM polyfill) for fast
 * barcode detection via the standard W3C BarcodeDetector API.
 *
 * Manages camera lifecycle (getUserMedia), detection loop (requestAnimationFrame),
 * and cleanup. Consumers provide a <video> element ref and receive scan callbacks.
 */

import { BarcodeDetector } from "barcode-detector/ponyfill";
import { useCallback, useEffect, useRef, useState } from "react";
import { getErrorMessage } from "~/lib/error-utils";

/** Barcode format strings supported by the BarcodeDetector API */
export type BarcodeFormat =
  | "upc_a"
  | "upc_e"
  | "ean_13"
  | "ean_8"
  | "code_128"
  | "qr_code";

export const BARCODE_FORMATS: BarcodeFormat[] = [
  "upc_a",
  "upc_e",
  "ean_13",
  "ean_8",
  "code_128",
];

export const QR_CODE_FORMATS: BarcodeFormat[] = ["qr_code"];

type ScannerStatus = "loading" | "scanning" | "error" | "permission_denied";

interface UseBarcodeSccannerOptions {
  /** Called when a barcode is detected */
  onScan: (barcode: string) => void;
  /** Called on error */
  onError?: (error: string) => void;
  /** Whether the scanner is active */
  enabled?: boolean;
  /** Barcode formats to detect */
  formats: BarcodeFormat[];
  /** Debounce time for same barcode (ms). Default: 2000 */
  debounceMs?: number;
}

interface UseBarcodeSccannerResult {
  /** Ref to attach to the <video> element */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Current scanner status */
  status: ScannerStatus;
  /** Error message if status is "error" or "permission_denied" */
  errorMessage: string | null;
  /** Whether torch/flashlight is available */
  torchAvailable: boolean;
  /** Whether torch is currently on */
  torchEnabled: boolean;
  /** Toggle torch on/off */
  toggleTorch: () => void;
  /** Retry camera access after permission denial */
  retry: () => void;
}

export function useBarcodeScanner({
  onScan,
  onError,
  enabled = true,
  formats,
  debounceMs = 2000,
}: UseBarcodeSccannerOptions): UseBarcodeSccannerResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectorRef = useRef<InstanceType<typeof BarcodeDetector> | null>(null);

  const [status, setStatus] = useState<ScannerStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const lastScanRef = useRef<string | null>(null);
  const lastScanTimeRef = useRef(0);

  // Stable refs to avoid re-running the effect when callbacks/formats change
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const formatsRef = useRef(formats);
  formatsRef.current = formats;

  const toggleTorch = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !torchAvailable) return;

    const track = stream.getVideoTracks()[0];
    if (!track) return;

    const newState = !torchEnabled;
    // @ts-expect-error -- applyConstraints torch is not in the TS types
    track.applyConstraints({ advanced: [{ torch: newState }] }).then(
      () => setTorchEnabled(newState),
      () => {},
    );
  }, [torchAvailable, torchEnabled]);

  const retry = useCallback(() => {
    setStatus("loading");
    setErrorMessage(null);
    setRetryCount((c) => c + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount forces camera restart on retry()
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        streamRef.current = stream;

        // Check torch support
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          const capabilities = videoTrack.getCapabilities?.();
          // @ts-expect-error -- torch not in TS types
          if (capabilities?.torch) {
            setTorchAvailable(true);
          }
        }

        // Attach stream to video element
        const video = videoRef.current;
        if (!video || cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        video.srcObject = stream;
        await video.play();

        if (cancelled) return;

        // Create detector
        const detector = new BarcodeDetector({ formats: formatsRef.current });
        detectorRef.current = detector;

        setStatus("scanning");
        setErrorMessage(null);

        // Detection loop
        const detectFrame = async () => {
          if (cancelled || !video || video.readyState < 2) {
            if (!cancelled) {
              rafRef.current = requestAnimationFrame(detectFrame);
            }
            return;
          }

          try {
            const results = await detector.detect(video);
            if (results.length > 0 && !cancelled) {
              const barcode = results[0]!.rawValue;
              const now = Date.now();

              // Debounce same barcode
              if (
                barcode !== lastScanRef.current ||
                now - lastScanTimeRef.current >= debounceMs
              ) {
                lastScanRef.current = barcode;
                lastScanTimeRef.current = now;
                onScanRef.current(barcode);
              }
            }
          } catch {
            // Detection can fail on individual frames — ignore
          }

          if (!cancelled) {
            rafRef.current = requestAnimationFrame(detectFrame);
          }
        };

        rafRef.current = requestAnimationFrame(detectFrame);
      } catch (err) {
        if (cancelled) return;

        const isPermissionDenied =
          err instanceof DOMException &&
          (err.name === "NotAllowedError" ||
            err.name === "PermissionDeniedError");

        if (isPermissionDenied) {
          setStatus("permission_denied");
          setErrorMessage("Camera access was denied");
        } else {
          setStatus("error");
          const message = getErrorMessage(err);
          setErrorMessage(message);
          onErrorRef.current?.(message);
        }
      }
    };

    startCamera();

    return () => {
      cancelled = true;

      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }

      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
      }

      detectorRef.current = null;
      setTorchAvailable(false);
      setTorchEnabled(false);
    };
    // retryCount is intentionally included to force camera restart on retry
  }, [enabled, debounceMs, retryCount]);

  return {
    videoRef,
    status,
    errorMessage,
    torchAvailable,
    torchEnabled,
    toggleTorch,
    retry,
  };
}
