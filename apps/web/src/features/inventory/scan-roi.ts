/**
 * Pure scan-region geometry for the camera barcode scanner.
 *
 * The scanner decodes a crop of the camera frame instead of the whole frame
 * (much faster lock-on), so the crop has to land on exactly the region the user
 * sees inside the reticle. The `<video>` paints its intrinsic frame into its
 * display box with `object-fit`, which crops (cover) or letterboxes (contain) —
 * so a reticle rect measured in *display* pixels must be mapped back through
 * that transform to get the *source* rect to crop. Getting this wrong decodes a
 * region the user never aimed at.
 *
 * No React, no `~/` imports — this file is unit-tested by the vitest `unit`
 * project, which can't resolve the app alias.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The `object-fit` values the scanner viewfinder can use. */
export type VideoObjectFit = "cover" | "contain";

/**
 * Detection cadence (~11 Hz). Running the detector every animation frame is
 * pure waste — a barcode can't appear and vanish inside 90ms, and the freed CPU
 * makes each individual decode faster.
 */
const DETECTION_INTERVAL_MS = 90;

/** Below this the crop is too small to hold a decodable barcode. */
const MIN_ROI_PX = 16;

/** Throttle gate for the detection loop. `now`/`lastDetectAt` are rAF timestamps. */
export function shouldDetectNow(
  now: number,
  lastDetectAt: number,
  intervalMs: number = DETECTION_INTERVAL_MS,
): boolean {
  return now - lastDetectAt >= intervalMs;
}

/**
 * The scale `object-fit` applies to the source frame: `cover` takes the larger
 * axis ratio (fills the box, crops the overflow), `contain` the smaller
 * (fits inside the box, letterboxes the remainder). Returns 0 for a degenerate
 * source or display.
 */
export function objectFitScale(
  source: Size,
  display: Size,
  fit: VideoObjectFit,
): number {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    display.width <= 0 ||
    display.height <= 0
  ) {
    return 0;
  }
  const scaleX = display.width / source.width;
  const scaleY = display.height / source.height;
  return fit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
}

/**
 * Maps a rect in display space (relative to the video's own box, origin at its
 * top-left) into source-frame space. The painted frame is centered in the box,
 * so the offset is negative on the cropped axis under `cover` and positive on
 * the letterboxed axis under `contain`. Result is unclamped — see
 * {@link clampRectToSize}.
 */
export function mapDisplayRectToSource(
  displayRect: Rect,
  source: Size,
  display: Size,
  fit: VideoObjectFit,
): Rect {
  const scale = objectFitScale(source, display, fit);
  if (scale <= 0) return { x: 0, y: 0, width: 0, height: 0 };

  const offsetX = (display.width - source.width * scale) / 2;
  const offsetY = (display.height - source.height * scale) / 2;

  return {
    x: (displayRect.x - offsetX) / scale,
    y: (displayRect.y - offsetY) / scale,
    width: displayRect.width / scale,
    height: displayRect.height / scale,
  };
}

/**
 * Clamps a rect to integer pixels inside `size`. Both edges are clamped
 * independently so an ROI that hangs off an edge keeps the visible part in
 * place instead of sliding inward. A rect entirely outside comes back zero-size.
 */
export function clampRectToSize(rect: Rect, size: Size): Rect {
  const maxWidth = Math.floor(size.width);
  const maxHeight = Math.floor(size.height);
  if (maxWidth <= 0 || maxHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const left = Math.min(Math.max(0, Math.round(rect.x)), maxWidth);
  const top = Math.min(Math.max(0, Math.round(rect.y)), maxHeight);
  const right = Math.max(
    left,
    Math.min(maxWidth, Math.round(rect.x + rect.width)),
  );
  const bottom = Math.max(
    top,
    Math.min(maxHeight, Math.round(rect.y + rect.height)),
  );

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Grows a rect by `fraction` of its own size on every side. */
function expandRect(rect: Rect, fraction: number): Rect {
  const padX = rect.width * fraction;
  const padY = rect.height * fraction;
  return {
    x: rect.x - padX,
    y: rect.y - padY,
    width: rect.width + padX * 2,
    height: rect.height + padY * 2,
  };
}

/** A centered box covering the given fractions of a display box. */
export function centerBoxRect(
  display: Size,
  widthFraction: number,
  heightFraction: number,
): Rect {
  const width = display.width * widthFraction;
  const height = display.height * heightFraction;
  return {
    x: (display.width - width) / 2,
    y: (display.height - height) / 2,
    width,
    height,
  };
}

export interface ScanRoiInput {
  /** Intrinsic frame size (`video.videoWidth` / `videoHeight`). */
  source: Size;
  /** Rendered box of the `<video>` element. */
  display: Size;
  /** Reticle rect in display space, relative to the video's top-left. */
  reticle: Rect;
  /** `object-fit` applied to the `<video>`. Default `"cover"`. */
  fit?: VideoObjectFit;
  /** Slack around the reticle so a barcode grazing the guide still decodes. */
  padFraction?: number;
}

/**
 * The source-frame rect to crop for detection, or `null` when the video isn't
 * measurable yet or the reticle maps to something too small to decode (caller
 * falls back to whole-frame detection).
 */
export function computeScanRoi({
  source,
  display,
  reticle,
  fit = "cover",
  padFraction = 0.08,
}: ScanRoiInput): Rect | null {
  const mapped = mapDisplayRectToSource(
    expandRect(reticle, padFraction),
    source,
    display,
    fit,
  );
  if (mapped.width <= 0 || mapped.height <= 0) return null;

  const roi = clampRectToSize(mapped, source);
  if (roi.width < MIN_ROI_PX || roi.height < MIN_ROI_PX) return null;
  return roi;
}

/** Minimal shape of a `DetectedBarcode` this module needs. */
export interface DetectionLike {
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Picks the detection nearest the ROI center. A shelf sweep routinely catches a
 * neighbouring product's barcode at the edge of the crop; the user aims the
 * reticle at the one they mean, so center-most wins — `results[0]` is whatever
 * order the decoder happened to emit.
 *
 * Bounding boxes are in the same space as `roi` (the crop canvas).
 */
export function pickMostCentralDetection<T extends DetectionLike>(
  detections: readonly T[],
  roi: Size,
): T | null {
  const centerX = roi.width / 2;
  const centerY = roi.height / 2;

  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const detection of detections) {
    const box = detection.boundingBox;
    const distance = box
      ? (box.x + box.width / 2 - centerX) ** 2 +
        (box.y + box.height / 2 - centerY) ** 2
      : Number.POSITIVE_INFINITY;
    if (best === null || distance < bestDistance) {
      best = detection;
      bestDistance = distance;
    }
  }

  return best;
}
