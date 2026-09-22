import type { ImageId, LedgerPartyId } from "@cubby/schemas/identifiers";
/**
 * Derives an Image's capture fields (`capturedAt`, `captureLocation`,
 * `capturedByPartyId`, ...) from its `ImageSighting` rows and, failing that,
 * embedded EXIF. See "Derivation" in
 * docs/plans/image-provenance-and-devices.md.
 *
 * `deriveImageCapture` is pure — no DB access, no clock reads beyond what is
 * passed in — so it is exhaustively unit-testable. `deriveAndStoreImageCapture`
 * is the thin transactional shell: load the image and its live sightings,
 * call the pure function, write the result back. Every ImageSighting
 * create/update/delete calls the shell inside its own write transaction (see
 * `repo/image-sighting.ts`), so an image's derived fields are never stale
 * relative to its own sightings for longer than that one transaction.
 */
import type {
  ImageCaptureAttribution,
  ImageCaptureLocation,
  ImageProvenanceEvidence,
} from "@cubby/schemas/image-capture-fields";
import type {
  ImageSightingCamera,
  ImageSightingMatchKind,
  ImageSightingSourceType,
} from "@cubby/schemas/image-sighting-fields";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  getImageCaptureState,
  getImageEmbeddedMetadataForCapture,
  getLiveSightingsForCapture,
  setImageCaptureState,
} from "~/server/repo/image";

/** `ImageSource` isn't exported as a standalone type; this mirrors
 * `imageSourceValues` in `18-image.entity.ts`. Not exported — nothing outside
 * this file constructs a bare source value; every external caller goes
 * through `DeriveImageCaptureCurrent`/`DeriveImageCaptureResult`. */
type DerivedImageSource = "own" | "catalog" | "unknown" | "screenshot";

export interface DeriveImageCaptureSighting {
  ledgerPartyId: LedgerPartyId;
  sourceType: ImageSightingSourceType;
  matchKind: ImageSightingMatchKind;
  hashDistance: number | null;
  aspectGate: boolean | null;
  mediaSubtypes: readonly string[];
  originalFilename: string | null;
  location: ImageCaptureLocation | null;
  placeName: string | null;
  camera: ImageSightingCamera | null;
  capturedAt: Date | null;
  capturedAtOffsetMinutes: number | null;
  addedAt: Date | null;
}

export interface DeriveImageCaptureExif {
  capturedAt: Date | null;
  capturedAtOffsetMinutes: number | null;
  location: ImageCaptureLocation | null;
  camera: ImageSightingCamera | null;
}

export interface DeriveImageCaptureCurrent {
  source: DerivedImageSource;
  captureAttribution: ImageCaptureAttribution;
  capturedAt: Date | null;
  capturedAtOffsetMinutes: number | null;
  captureLocation: ImageCaptureLocation | null;
  capturePlaceName: string | null;
  captureDeviceLabel: string | null;
  capturedByPartyId: LedgerPartyId | null;
  provenanceEvidence: ImageProvenanceEvidence | null;
}

export interface DeriveImageCaptureInput {
  image: DeriveImageCaptureCurrent;
  sightings: readonly DeriveImageCaptureSighting[];
  exif: DeriveImageCaptureExif | null;
}

export interface DeriveImageCaptureResult {
  source: DerivedImageSource;
  captureAttribution: ImageCaptureAttribution;
  capturedAt: Date | null;
  capturedAtOffsetMinutes: number | null;
  captureLocation: ImageCaptureLocation | null;
  capturePlaceName: string | null;
  captureDeviceLabel: string | null;
  capturedByPartyId: LedgerPartyId | null;
  provenanceEvidence: ImageProvenanceEvidence | null;
}

const HEIC_RAW_FILENAME = /\.(heic|heif|raw|cr2|cr3|nef|arw|dng)$/i;
const SCREENSHOT_SUBTYPE = /screenshot/i;

const unchanged = (
  current: DeriveImageCaptureCurrent,
): DeriveImageCaptureResult => ({
  source: current.source,
  captureAttribution: current.captureAttribution,
  capturedAt: current.capturedAt,
  capturedAtOffsetMinutes: current.capturedAtOffsetMinutes,
  captureLocation: current.captureLocation,
  capturePlaceName: current.capturePlaceName,
  captureDeviceLabel: current.captureDeviceLabel,
  capturedByPartyId: current.capturedByPartyId,
  provenanceEvidence: current.provenanceEvidence,
});

/**
 * "Strong" evidence for capturer attribution: an import commit's own sighting
 * (the reporting device just uploaded the bytes, so its library membership is
 * certain), or a library-scan match close enough on perceptual hash to trust
 * — distance ≤ 2 outright, or 3–6 when the aspect ratio also gates. Every
 * strong sighting must additionally come from a genuine on-device library
 * (`sourceType: "userLibrary"`) — a cloud-shared or iTunes-synced copy proves
 * the asset reached the account, not that this member took the photo.
 */
const isStrongSighting = (sighting: DeriveImageCaptureSighting): boolean =>
  sighting.sourceType === "userLibrary" &&
  (sighting.matchKind === "import" ||
    (sighting.hashDistance !== null &&
      sighting.hashDistance <= 2 &&
      sighting.hashDistance >= 0) ||
    (sighting.hashDistance !== null &&
      sighting.hashDistance >= 3 &&
      sighting.hashDistance <= 6 &&
      sighting.aspectGate === true));

const isHeicOrRaw = (filename: string | null): boolean =>
  filename !== null && HEIC_RAW_FILENAME.test(filename);

/** Within one party's strong sightings, the single sighting used to populate
 * the image's capture fields — richest evidence first, earliest capture and
 * earliest library-add as tiebreakers so a party's FIRST copy of a shared
 * photo wins over a later resave. */
const bestSighting = (
  sightings: readonly DeriveImageCaptureSighting[],
): DeriveImageCaptureSighting =>
  [...sightings].sort((a, b) => {
    const location = Number(b.location !== null) - Number(a.location !== null);
    if (location !== 0) return location;
    const camera = Number(b.camera !== null) - Number(a.camera !== null);
    if (camera !== 0) return camera;
    const filename =
      Number(isHeicOrRaw(b.originalFilename)) -
      Number(isHeicOrRaw(a.originalFilename));
    if (filename !== 0) return filename;
    const captured = compareNullableDatesAscending(a.capturedAt, b.capturedAt);
    if (captured !== 0) return captured;
    return compareNullableDatesAscending(a.addedAt, b.addedAt);
  })[0]!;

/** `null` sorts last — a sighting with no timestamp can't win an "earliest"
 * comparison against one that has one. */
function compareNullableDatesAscending(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.getTime() - b.getTime();
}

/** Score a party's representative sighting against the field: `deriveImageCapture`
 * computes this once per party and picks the unique maximum. */
const scoreRepresentative = (
  representative: DeriveImageCaptureSighting,
  allRepresentatives: readonly DeriveImageCaptureSighting[],
): number => {
  let score = 0;
  if (representative.location !== null) score += 3;
  if (representative.camera !== null) score += 2;
  if (isHeicOrRaw(representative.originalFilename)) score += 1;
  const earliestCapture = allRepresentatives.reduce<Date | null>(
    (earliest, item) =>
      compareNullableDatesAscending(item.capturedAt, earliest) < 0
        ? item.capturedAt
        : earliest,
    representative.capturedAt,
  );
  if (
    representative.capturedAt !== null &&
    earliestCapture !== null &&
    representative.capturedAt.getTime() === earliestCapture.getTime()
  )
    score += 1;
  const earliestAdded = allRepresentatives.reduce<Date | null>(
    (earliest, item) =>
      compareNullableDatesAscending(item.addedAt, earliest) < 0
        ? item.addedAt
        : earliest,
    representative.addedAt,
  );
  if (
    representative.addedAt !== null &&
    earliestAdded !== null &&
    representative.addedAt.getTime() === earliestAdded.getTime()
  )
    score += 1;
  return score;
};

const cameraLabel = (camera: ImageSightingCamera | null): string | null => {
  if (!camera) return null;
  const label = [camera.make, camera.model].filter(Boolean).join(" ").trim();
  return label.length > 0 ? label : null;
};

/**
 * The pure derivation rule. Precedence across every writer of Image capture
 * evidence — including writers outside this function, such as `attach_files`'
 * `import-url` evidence — is `manual > sighting > import-url > exif > analysis
 * > filename`; this function only ever produces `sighting` or `exif`
 * evidence, so it must not downgrade evidence already ranked above the tier
 * it is about to write.
 */
export function deriveImageCapture(
  input: DeriveImageCaptureInput,
): DeriveImageCaptureResult {
  const { image: current, sightings, exif } = input;

  // 1. A manual confirmation is sticky — never recomputed.
  if (current.captureAttribution === "confirmed") return unchanged(current);

  // 2. A screenshot subtype on any sighting overrides `source` and clears
  // capture attribution: a screenshot has no photographer, camera, or GPS.
  const isScreenshot = sightings.some((sighting) =>
    sighting.mediaSubtypes.some((subtype) => SCREENSHOT_SUBTYPE.test(subtype)),
  );
  if (isScreenshot) {
    return {
      source: "screenshot",
      captureAttribution: "none",
      capturedAt: null,
      capturedAtOffsetMinutes: null,
      captureLocation: null,
      capturePlaceName: null,
      captureDeviceLabel: null,
      capturedByPartyId: null,
      provenanceEvidence: null,
    };
  }

  // 3. Strong sightings, grouped by reporting party.
  const strong = sightings.filter(isStrongSighting);
  if (strong.length > 0) {
    const byParty = new Map<LedgerPartyId, DeriveImageCaptureSighting[]>();
    for (const sighting of strong) {
      const group = byParty.get(sighting.ledgerPartyId);
      if (group) group.push(sighting);
      else byParty.set(sighting.ledgerPartyId, [sighting]);
    }
    const parties = [...byParty.keys()];
    const representatives = new Map(
      parties.map((party) => [party, bestSighting(byParty.get(party)!)]),
    );
    const allRepresentatives = [...representatives.values()];

    let winner: LedgerPartyId | null;
    if (parties.length === 1) {
      winner = parties[0]!;
    } else {
      const scored = parties.map((party) => ({
        party,
        score: scoreRepresentative(
          representatives.get(party)!,
          allRepresentatives,
        ),
      }));
      const maxScore = Math.max(...scored.map((entry) => entry.score));
      const atMax = scored.filter((entry) => entry.score === maxScore);
      winner = atMax.length === 1 ? atMax[0]!.party : null;
    }

    // Capture facts (when/where/what camera) are shown even when the
    // capturer is ambiguous — only WHO is unresolved, not the facts a
    // sighting itself carries. Facts come from the winner's representative
    // sighting when there is one, else the single best sighting overall.
    const factSource = winner
      ? representatives.get(winner)!
      : bestSighting(allRepresentatives);

    return {
      // A strong sighting in a member's own Photos library is the "camera
      // roll ⇒ ours" rule: the pixels are the household's, whatever the row
      // said before (a screenshot subtype already returned above; a manual
      // confirmation returned in rule 1).
      source: "own",
      captureAttribution: winner ? "derived" : "ambiguous",
      capturedAt: factSource.capturedAt,
      capturedAtOffsetMinutes: factSource.capturedAtOffsetMinutes,
      captureLocation: factSource.location,
      capturePlaceName: factSource.placeName,
      captureDeviceLabel: cameraLabel(factSource.camera),
      capturedByPartyId: winner,
      provenanceEvidence: { basis: "sighting" },
    };
  }

  // 4. No strong sightings. EXIF is the fallback, but it must not overwrite
  // stronger existing evidence (`import-url`, and eventually `analysis`).
  const currentBasis = current.provenanceEvidence?.basis ?? null;
  const outranksExif = currentBasis === "import-url";
  const hasExif =
    exif !== null &&
    (exif.capturedAt !== null ||
      exif.location !== null ||
      exif.camera !== null);
  if (hasExif && !outranksExif) {
    return {
      source: current.source,
      captureAttribution: "none",
      capturedAt: exif.capturedAt,
      capturedAtOffsetMinutes: exif.capturedAtOffsetMinutes,
      captureLocation: exif.location,
      capturePlaceName: null,
      captureDeviceLabel: cameraLabel(exif.camera),
      capturedByPartyId: null,
      provenanceEvidence: { basis: "exif" },
    };
  }

  // 5. No sightings, no usable EXIF (or EXIF was outranked). A "sighting"
  // basis is this function's own prior output — it exists only because a
  // strong sighting once produced it — so when that group is now empty
  // (its last sighting was just deleted or edited below the strong
  // threshold), the basis is retracted rather than left stale: the image
  // reverts to blank capture state, same as if it had never had one.
  // Any OTHER existing basis (manual/import-url/exif/analysis) was written
  // by something outside this function and is left exactly as it was.
  if (currentBasis === "sighting") {
    return {
      source: "own",
      captureAttribution: "none",
      capturedAt: null,
      capturedAtOffsetMinutes: null,
      captureLocation: null,
      capturePlaceName: null,
      captureDeviceLabel: null,
      capturedByPartyId: null,
      provenanceEvidence: null,
    };
  }
  const setsOwnSource = currentBasis === null || currentBasis === "filename";
  return {
    source: setsOwnSource ? "own" : current.source,
    captureAttribution: current.captureAttribution,
    capturedAt: current.capturedAt,
    capturedAtOffsetMinutes: current.capturedAtOffsetMinutes,
    captureLocation: current.captureLocation,
    capturePlaceName: current.capturePlaceName,
    captureDeviceLabel: current.captureDeviceLabel,
    capturedByPartyId: current.capturedByPartyId,
    provenanceEvidence: current.provenanceEvidence,
  };
}

/**
 * Loads the image and its live sightings, runs {@link deriveImageCapture},
 * and writes the result back — called inside the same transaction as every
 * `ImageSighting` create/update/delete.
 *
 * Reads and writes go through `repo/image.ts`'s
 * `getImageCaptureState`/`getLiveSightingsForCapture`/`setImageCaptureState`
 * rather than `~/server/db/schema`/`~/server/repo/database-helpers` directly
 * — services may not import either (see the `no-restricted-imports` lint
 * rule; "Services cannot access DB schema directly. Use repo functions
 * instead."). Those repo functions accept `Database | DrizzleTransaction`
 * directly, so this still resolves to one transaction-bound client whether
 * the caller passed a real `DrizzleTransaction` (every `repo/image-sighting.ts`
 * / `repo/device.ts` call site) or the photo-import commit's own transaction
 * wrapper's `Database` handle (`repo/photo-import.ts`'s
 * `withPhotoImportTransaction`).
 */
export async function deriveAndStoreImageCapture(
  tx: Database | DrizzleTransaction,
  imageId: ImageId,
): Promise<void> {
  const currentRow = await getImageCaptureState(tx, imageId);
  // The image was hard-deleted in the same transaction (e.g. cascaded from
  // a sighting delete that emptied it) — nothing to derive.
  if (!currentRow) return;

  const sightingRows = await getLiveSightingsForCapture(tx, imageId);
  const storedMetadata = await getImageEmbeddedMetadataForCapture(tx, imageId);

  const result = deriveImageCapture({
    image: currentRow,
    sightings: sightingRows,
    exif: storedMetadata && {
      capturedAt: storedMetadata.capturedAt
        ? new Date(storedMetadata.capturedAt)
        : null,
      capturedAtOffsetMinutes: storedMetadata.capturedAtOffsetMinutes,
      location: storedMetadata.location,
      camera: storedMetadata.camera,
    },
  });

  await setImageCaptureState(tx, imageId, result);
}
