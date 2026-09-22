/**
 * Filename/dimension heuristics that guess an `Image`'s `source` when nothing
 * stronger is available, plus a `capturedAt` seed from an on-device
 * `photo-local-analysis` result. Pure — no DB access — so every rule is
 * table-driven and unit-tested directly; `classifyImageProvenance`
 * (`image-provenance-classify.service.ts`) is the transactional shell that
 * selects candidate rows and writes the result back.
 *
 * `source`/`provenanceEvidence` isn't exported as a standalone type here for
 * the same reason `image-capture-derivation.ts` mirrors `imageSourceValues`
 * rather than importing it: the entity-definitions module is generator-only,
 * not a stable import surface for services.
 */

/** Mirrors `imageSourceValues` in `18-image.entity.ts`. */
type HeuristicImageSource = "own" | "catalog" | "unknown" | "screenshot";

interface ImageProvenanceEvidenceHeuristic {
  basis: "filename";
  ruleId: string;
}

export interface FilenameProvenanceInput {
  filename: string | null;
  sourceAssetUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface FilenameProvenanceResult {
  source: HeuristicImageSource;
  provenanceEvidence: ImageProvenanceEvidenceHeuristic;
}

interface FilenameProvenanceRule {
  ruleId: string;
  source: HeuristicImageSource;
  test: (input: FilenameProvenanceInput) => boolean;
}

// A legacy iOS uploader re-encoded every photo library upload to this exact
// name at a fixed long edge before `Image.source` existed — the one
// filename-only signal strong enough to call `own` outright.
const LEGACY_UPLOADER_DIMENSION = 2048;
const LEGACY_UPLOADER_FILENAME = /^photo\.jpe?g$/i;

// Native camera-roll naming conventions: iOS (`IMG_1234.HEIC`), classic
// digital cameras (`DSC_1234.JPG`, `DSCN1234.JPG`), and Google/Pixel
// (`PXL_20240101_120000.jpg`).
const IOS_CAMERA_FILENAME = /^IMG_\d{4}/i;
const DSLR_CAMERA_FILENAME = /^DSC/i;
const PIXEL_CAMERA_FILENAME = /^PXL_/i;

// Vendor/catalog image filenames carry their serving dimensions or a CDN
// resize marker; a `sourceAssetUrl` on the row is the same fact restated —
// the image was fetched from somewhere, not captured by the household.
const CATALOG_DIMENSION_SUFFIX = /-\d{2,5}x\d{2,5}(?:[_.-]|$)/i;
const CATALOG_DIMENSION_EXTENSION = /\d{2,5}x\d{2,5}\.(jpe?g|webp|png)$/i;
const CATALOG_AMAZON_SL_MARKER = /_SL\d+_/i;

const SCREENSHOT_FILENAME_PREFIX = /^Screenshot[ _]/i;
// Native-resolution pixel dimensions of common iPhone/iPad/Mac screens
// (portrait, unscaled) — a screenshot carries these exactly; a photo almost
// never does, since a captured photo's aspect ratio and pixel count come
// from the camera sensor, not the display.
const COMMON_SCREEN_DIMENSIONS: ReadonlyArray<readonly [number, number]> = [
  [750, 1334], // iPhone SE/8 and earlier @2x
  [828, 1792], // iPhone 11/XR
  [1080, 1920], // Android/generic FHD
  [1125, 2436], // iPhone X/XS/11 Pro
  [1170, 2532], // iPhone 12/13
  [1179, 2556], // iPhone 15/16
  [1242, 2688], // iPhone XS Max/11 Pro Max
  [1284, 2778], // iPhone 12/13 Pro Max
  [1290, 2796], // iPhone 15/16 Pro Max
  [1536, 2048], // iPad (9.7"/10.2") @2x
  [1620, 2160], // iPad Air/10th gen @2x
  [1640, 2360], // iPad Air (M2)
  [1668, 2388], // iPad Pro 11"
  [2048, 2732], // iPad Pro 12.9"
  [1512, 982], // MacBook Pro 14" native points @2x-ish
  [2560, 1600], // MacBook Air 13"
  [2880, 1800], // MacBook Pro 15"
  [3024, 1964], // MacBook Pro 14" (2021+)
  [3456, 2234], // MacBook Pro 16" (2021+)
];

const matchesCommonScreenDimensions = (
  width: number | null,
  height: number | null,
): boolean => {
  if (width === null || height === null) return false;
  return COMMON_SCREEN_DIMENSIONS.some(
    ([a, b]) => (width === a && height === b) || (width === b && height === a),
  );
};

/**
 * Ordered, first-match-wins, most-specific-evidence first. Filename-anchored
 * rules (an exact prefix or an exact legacy-uploader filename+dimension
 * pair) run before the dimension-only screenshot fallback, so a photo that
 * happens to share a common screen resolution (e.g. the legacy uploader's
 * fixed 2048px long edge lands near an iPad's) is still read by its stronger
 * filename evidence first.
 */
const FILENAME_PROVENANCE_RULES: readonly FilenameProvenanceRule[] = [
  {
    ruleId: "legacy-uploader-photo-jpeg",
    source: "own",
    test: ({ filename, width, height }) =>
      filename !== null &&
      LEGACY_UPLOADER_FILENAME.test(filename) &&
      (width === LEGACY_UPLOADER_DIMENSION ||
        height === LEGACY_UPLOADER_DIMENSION),
  },
  {
    ruleId: "camera-filename-ios",
    source: "own",
    test: ({ filename }) =>
      filename !== null && IOS_CAMERA_FILENAME.test(filename),
  },
  {
    ruleId: "camera-filename-dslr",
    source: "own",
    test: ({ filename }) =>
      filename !== null && DSLR_CAMERA_FILENAME.test(filename),
  },
  {
    ruleId: "camera-filename-pixel",
    source: "own",
    test: ({ filename }) =>
      filename !== null && PIXEL_CAMERA_FILENAME.test(filename),
  },
  {
    ruleId: "screenshot-filename-prefix",
    source: "screenshot",
    test: ({ filename }) =>
      filename !== null && SCREENSHOT_FILENAME_PREFIX.test(filename),
  },
  {
    ruleId: "catalog-source-asset-url",
    source: "catalog",
    test: ({ sourceAssetUrl }) =>
      sourceAssetUrl !== null && sourceAssetUrl.trim().length > 0,
  },
  {
    ruleId: "catalog-dimension-suffix",
    source: "catalog",
    test: ({ filename }) =>
      filename !== null && CATALOG_DIMENSION_SUFFIX.test(filename),
  },
  {
    ruleId: "catalog-amazon-sl-marker",
    source: "catalog",
    test: ({ filename }) =>
      filename !== null && CATALOG_AMAZON_SL_MARKER.test(filename),
  },
  {
    ruleId: "catalog-dimension-extension",
    source: "catalog",
    test: ({ filename }) =>
      filename !== null && CATALOG_DIMENSION_EXTENSION.test(filename),
  },
  // Broadest, dimension-only signal — last, so a filename-anchored rule
  // above always gets first refusal.
  {
    ruleId: "screenshot-common-dimensions",
    source: "screenshot",
    test: ({ width, height }) => matchesCommonScreenDimensions(width, height),
  },
];

/** Every declared rule id, in evaluation order — for a dry-run's per-rule counts. */
export const filenameProvenanceRuleIds: readonly string[] =
  FILENAME_PROVENANCE_RULES.map((rule) => rule.ruleId);

/**
 * The pure filename/dimension classification. Returns `null` when no rule
 * matches — the row is left `source = unknown` for a stronger signal
 * (a sighting, EXIF, or a future rule) to classify later.
 */
export function classifyImageProvenanceFromFilename(
  input: FilenameProvenanceInput,
): FilenameProvenanceResult | null {
  const rule = FILENAME_PROVENANCE_RULES.find((candidate) =>
    candidate.test(input),
  );
  if (!rule) return null;
  return {
    source: rule.source,
    provenanceEvidence: { basis: "filename", ruleId: rule.ruleId },
  };
}

/**
 * Seed `capturedAt` from an on-device analysis result, only when the image
 * has none of its own. Pure: the caller resolves the newest
 * `AiAnalysis(feature="photo-local-analysis")` row and passes its
 * `capturedAt` in.
 */
export function seedCapturedAtFromAnalysis(
  currentCapturedAt: Date | null,
  analysisCapturedAt: Date | null,
): { capturedAt: Date; provenanceEvidence: { basis: "analysis" } } | null {
  if (currentCapturedAt !== null) return null;
  if (analysisCapturedAt === null) return null;
  return {
    capturedAt: analysisCapturedAt,
    provenanceEvidence: { basis: "analysis" },
  };
}
