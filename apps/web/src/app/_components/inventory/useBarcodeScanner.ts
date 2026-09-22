/**
 * useBarcodeScanner - Core hook for camera-based barcode scanning.
 *
 * Uses the `barcode-detector` package (ZXing-C++ WASM polyfill) for fast
 * barcode detection via the standard W3C BarcodeDetector API.
 *
 * Manages camera lifecycle (getUserMedia), detection loop (requestAnimationFrame),
 * and cleanup. Consumers provide a <video> element ref and receive scan callbacks.
 *
 * Lock-on speed comes from doing *less* per frame: detection is throttled to
 * ~11 Hz and runs on a small crop of the reticle region (see `scan-roi.ts`)
 * rather than the whole 720p frame.
 */

import { BarcodeDetector } from "barcode-detector/ponyfill";
import { useCallback, useEffect, useRef, useState } from "react";

import { getErrorMessage } from "~/lib/error-utils";

import {
  centerBoxRect,
  computeScanRoi,
  pickMostCentralDetection,
  type Rect,
  shouldDetectNow,
  type VideoObjectFit,
} from "./scan-roi";

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

/** QR labels plus every linear product-code format Cubby accepts. */
export const UNIVERSAL_SCAN_FORMATS: BarcodeFormat[] = [
  ...BARCODE_FORMATS,
  ...QR_CODE_FORMATS,
];

type ScannerStatus = "loading" | "scanning" | "error" | "permission_denied";

/** Reticle used when the consumer renders no guide element to measure. */
const FALLBACK_RETICLE_WIDTH_FRACTION = 0.85;
const FALLBACK_RETICLE_HEIGHT_FRACTION = 0.4;

interface UseBarcodeSccannerOptions {
  onScan: (barcode: string) => void;
  onError?: (error: string) => void;
  enabled?: boolean;
  formats: BarcodeFormat[];
  debounceMs?: number;
  /**
   * The on-screen reticle element. Detection crops to this box (mapped back
   * through the video's `object-fit`), so what the user frames is what gets
   * decoded. Omit to crop a centered fallback box.
   */
  reticleRef?: React.RefObject<HTMLElement | null>;
  /** `object-fit` applied to the `<video>`. Default `"cover"`. */
  objectFit?: VideoObjectFit;
}

/**
 * Source-frame rect to crop for detection: measures the live reticle against
 * the live video box, then maps it through `object-fit`. Returns null when the
 * video isn't measurable yet — the caller falls back to the whole frame.
 */
function resolveScanRoi(
  video: HTMLVideoElement,
  reticle: HTMLElement | null,
  fit: VideoObjectFit,
): Rect | null {
  const videoRect = video.getBoundingClientRect();
  const display = { width: videoRect.width, height: videoRect.height };
  const reticleRect = reticle?.getBoundingClientRect();

  return computeScanRoi({
    source: { width: video.videoWidth, height: video.videoHeight },
    display,
    reticle:
      reticleRect && reticleRect.width > 0 && reticleRect.height > 0
        ? {
            x: reticleRect.left - videoRect.left,
            y: reticleRect.top - videoRect.top,
            width: reticleRect.width,
            height: reticleRect.height,
          }
        : centerBoxRect(
            display,
            FALLBACK_RETICLE_WIDTH_FRACTION,
            FALLBACK_RETICLE_HEIGHT_FRACTION,
          ),
    fit,
  });
}

interface UseBarcodeSccannerResult {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: ScannerStatus;
  errorMessage: string | null;
  torchAvailable: boolean;
  torchEnabled: boolean;
  toggleTorch: () => void;
  retry: () => void;
}

export function useBarcodeScanner({
  onScan,
  onError,
  enabled = true,
  formats,
  debounceMs = 2000,
  reticleRef,
  objectFit = "cover",
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
  // Ref-to-the-ref: the reticle mounts after this render, so the element is read
  // live inside the detection loop rather than snapshotted here.
  const reticleRefRef = useRef(reticleRef);
  reticleRefRef.current = reticleRef;
  const objectFitRef = useRef(objectFit);
  objectFitRef.current = objectFit;

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

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            // 720p, not 1080p: the extra pixels cost frame time (and battery)
            // without helping a decoder that reads a cropped strip anyway.
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        streamRef.current = stream;

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
          const capabilities = videoTrack.getCapabilities?.();
          // @ts-expect-error -- torch not in TS types
          if (capabilities?.torch) {
            setTorchAvailable(true);
          }
        }

        const video = videoRef.current;
        if (!video || cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }

        video.srcObject = stream;
        await video.play();

        if (cancelled) return;

        const detector = new BarcodeDetector({ formats: formatsRef.current });
        detectorRef.current = detector;

        setStatus("scanning");
        setErrorMessage(null);

        // Reused crop canvas — one allocation for the camera's lifetime.
        let cropCanvas: HTMLCanvasElement | null = null;
        let cropContext: CanvasRenderingContext2D | null = null;
        let lastDetectAt = Number.NEGATIVE_INFINITY;

        /**
         * Detects on the reticle crop when the video is measurable, else on the
         * whole frame. Returns the results plus the space their bounding boxes
         * live in, so the most-central pick is measured against the same box.
         */
        const detectInReticle = async () => {
          const roi = resolveScanRoi(
            video,
            reticleRefRef.current?.current ?? null,
            objectFitRef.current,
          );

          if (roi) {
            cropCanvas ??= document.createElement("canvas");
            cropContext ??= cropCanvas.getContext("2d", {
              willReadFrequently: true,
            });

            if (cropContext) {
              if (cropCanvas.width !== roi.width) cropCanvas.width = roi.width;
              if (cropCanvas.height !== roi.height)
                cropCanvas.height = roi.height;
              cropContext.drawImage(
                video,
                roi.x,
                roi.y,
                roi.width,
                roi.height,
                0,
                0,
                roi.width,
                roi.height,
              );
              return {
                results: await detector.detect(cropCanvas),
                space: { width: roi.width, height: roi.height },
              };
            }
          }

          return {
            results: await detector.detect(video),
            space: { width: video.videoWidth, height: video.videoHeight },
          };
        };

        // Detection loop — throttled; rAF only paces the polling.
        const detectFrame = async (timestamp: number) => {
          if (
            cancelled ||
            !video ||
            video.readyState < 2 ||
            !shouldDetectNow(timestamp, lastDetectAt)
          ) {
            if (!cancelled) {
              rafRef.current = requestAnimationFrame(detectFrame);
            }
            return;
          }

          lastDetectAt = timestamp;

          try {
            const { results, space } = await detectInReticle();
            // Several barcodes in frame (a neighbouring product on the shelf):
            // the user aimed the reticle at one of them, so take the closest to
            // its center rather than whatever the decoder emitted first.
            const detected = pickMostCentralDetection(results, space);
            if (detected && !cancelled) {
              const barcode = detected.rawValue;
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
          }
          // SILENT: per-frame barcode detection can fail transiently at
          // ~11 Hz; the next animation frame retries, so surfacing every
          // miss would spam the user while pointing the camera around.
          catch {}

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

/** Confirmation blip: short, quiet, and high enough to cut through a store. */
const BEEP_FREQUENCY_HZ = 1180;
const BEEP_PEAK_GAIN = 0.18;
const BEEP_DURATION_S = 0.11;

type AudioContextCtor = typeof AudioContext;

/**
 * A checkout-counter blip for a confirmed scan. iOS has no `navigator.vibrate`,
 * so audio is the only eyes-free confirmation available.
 *
 * Autoplay policy: iOS Safari only lets an AudioContext *start* from a user
 * gesture; one created cold stays `suspended`. So priming runs on mount (the
 * scanner is opened by a tap, which usually still counts) and again on every
 * pointer/touch while the scanner is open, until the context reports
 * `running` — a listener that primes once could miss, leaving a whole hands-off
 * sweep silent. `beep()` is a no-op until the context is actually running, so
 * there's never an unhandled rejection or a retry loop on the scan path.
 *
 * Call it from the *accepted* scan path (post-dedupe), not per raw detection:
 * a barcode held in frame keeps decoding at ~11 Hz.
 */
export function useScanBeep(enabled = true): () => void {
  const contextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const prime = () => {
      const Ctor: AudioContextCtor | undefined =
        window.AudioContext ??
        // SAFETY: Safari exposes the same AudioContext constructor under this
        // vendor-prefixed property; the browser window is the effect's runtime.
        (window as { webkitAudioContext?: AudioContextCtor })
          .webkitAudioContext;
      if (!Ctor) return;
      contextRef.current ??= new Ctor();
      const context = contextRef.current;
      // Also re-arms after iOS suspends the context (call, interruption).
      if (context.state !== "running") {
        // SILENT: best-effort resume, retried on the next pointerdown/touchend
        // prime; a rejected resume here just means the beep stays silent.
        void context.resume().catch(() => {});
      }
    };

    prime();
    window.addEventListener("pointerdown", prime, { passive: true });
    window.addEventListener("touchend", prime, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", prime);
      window.removeEventListener("touchend", prime);
    };
  }, [enabled]);

  // Release the audio hardware when the scanner surface unmounts.
  useEffect(() => {
    return () => {
      // SILENT: teardown on unmount; nothing left to recover into if closing
      // the audio hardware fails.
      void contextRef.current?.close().catch(() => {});
      contextRef.current = null;
    };
  }, []);

  return useCallback(() => {
    const context = contextRef.current;
    if (context?.state !== "running") return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startedAt = context.currentTime;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(BEEP_FREQUENCY_HZ, startedAt);
    // Ramped, not gated — a square-edged gain change pops on iPhone speakers.
    gain.gain.setValueAtTime(0.0001, startedAt);
    gain.gain.exponentialRampToValueAtTime(BEEP_PEAK_GAIN, startedAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + BEEP_DURATION_S);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        gain.disconnect();
      },
      { once: true },
    );
    oscillator.start(startedAt);
    oscillator.stop(startedAt + BEEP_DURATION_S + 0.01);
  }, []);
}
