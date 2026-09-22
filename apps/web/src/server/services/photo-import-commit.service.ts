import type { ActorContext } from "@cubby/schemas/context";
import type { ImageId, UserId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ImageSightingReportFields } from "@cubby/schemas/image-sighting";

import type {
  PhotoImportCommitInput,
  PhotoImportCommitResult,
} from "~/contracts/photo-import.contract";
import { deferPublications } from "~/server/background-tasks/publish";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";
import {
  resolveImportSightingContext,
  setImageOwnDeviceSource,
  upsertImageSightingInTransaction,
} from "~/server/repo/image-sighting";
import {
  activateImportImages,
  getImportImageRows,
  lockImportImageRows,
  type ImportImageRow,
  persistLocalImageAnalysis,
  withPhotoImportTransaction,
} from "~/server/repo/photo-import";
import { inspectImageFile } from "~/server/services/image-integrity";
import {
  buildImageMetadataExtractionTasks,
  isImageContentType,
} from "~/server/services/image-metadata-extraction.service";
import {
  refreshProjectionsForEvent,
  runMutationSideEffectsForEntities,
  type MutationSideEffectEvent,
} from "~/server/services/mutation-side-effects";
import { finalizeImportedImages } from "~/server/services/photo-import-finalize.service";
import { getS3Object } from "~/server/utils/s3";

/** A staged image's bytes/dimensions checked against its row, independent of any caller-specific payload. */
export interface StagedImageIntegrityItem {
  imageId: string;
  sha256: string;
  width: number;
  height: number;
}

export interface VerifiedStagedImage {
  row: ImportImageRow;
  integrity: Awaited<ReturnType<typeof inspectImageFile>>;
}

interface VerifiedImportImage extends VerifiedStagedImage {
  analysis: PhotoImportCommitInput["images"][number]["analysis"] | null;
  /** `library` blocks from every item resolving to this image — usually 0 or
   * 1, but never assumed unique (see `photoImportCommitInputSchema`'s
   * `library` field comment). */
  sightings: ImageSightingReportFields[];
  /** True when any item resolving to this image attests `photoLibrary` or
   * `camera` provenance — computed from the original items, not `analysis`
   * above, which is nulled out for a reused UPLOADED row. */
  ownDeviceProvenance: boolean;
}

/** True when a commit item's local analysis attests the photo came from this
 * device's own camera or library — the two `provenance.source` values that
 * mean "we took or already had this", as opposed to `files` (picked from
 * somewhere else) or `serverLazy` (server-side, no local device at all). */
const isOwnDeviceProvenance = (
  source: PhotoImportCommitInput["images"][number]["analysis"]["provenance"]["source"],
): boolean => source === "photoLibrary" || source === "camera";

export interface PhotoImportRouteCommitResult {
  createdDestinations: PhotoImportCommitResult["createdDestinations"];
  sideEffectEvents: MutationSideEffectEvent[];
}

/**
 * Transaction-bound manifest executor. It validates the entire route/create plan before `apply`
 * writes anything. Implementations call repository adapters on `context.db`; that handle is bound
 * to the import's one outer transaction.
 */
export interface PhotoImportRouteAdapter {
  validate(
    context: EntityKernelContext,
    input: PhotoImportCommitInput,
    imagesByCode: ReadonlyMap<string, ImportImageRow>,
  ): Promise<void>;
  apply(
    context: EntityKernelContext,
    input: PhotoImportCommitInput,
    imagesByCode: ReadonlyMap<string, ImportImageRow>,
  ): Promise<PhotoImportRouteCommitResult>;
}

export interface PhotoImportCommitPorts {
  getImages: typeof getImportImageRows;
  lockImages: typeof lockImportImageRows;
  getObject: typeof getS3Object;
  inspect: typeof inspectImageFile;
  activateImages: typeof activateImportImages;
  persistAnalysis: typeof persistLocalImageAnalysis;
  withTransaction: typeof withPhotoImportTransaction;
  refreshProjection: typeof refreshProjectionsForEvent;
  runSideEffects: typeof runMutationSideEffectsForEntities;
  /** Injectable so a unit test can stub the DB writes `applyImportProvenance`
   * makes directly (outside every other port's mediation) without a real
   * transaction-bound Drizzle client. */
  applyProvenance: typeof applyImportProvenance;
}

export const productionPhotoImportCommitPorts: PhotoImportCommitPorts = {
  getImages: getImportImageRows,
  lockImages: lockImportImageRows,
  getObject: getS3Object,
  inspect: inspectImageFile,
  activateImages: activateImportImages,
  persistAnalysis: persistLocalImageAnalysis,
  withTransaction: withPhotoImportTransaction,
  refreshProjection: refreshProjectionsForEvent,
  applyProvenance: applyImportProvenance,
  runSideEffects: runMutationSideEffectsForEntities,
};

type PhotoImportItem = PhotoImportCommitInput["images"][number];

const analysesMatch = (
  left: PhotoImportItem["analysis"],
  right: PhotoImportItem["analysis"],
): boolean => JSON.stringify(left) === JSON.stringify(right);

const verifyUploadedStagedImage = (
  row: ImportImageRow,
  imageId: string,
  reuseAllowed: boolean,
): VerifiedStagedImage => {
  if (
    !row.sha256 ||
    row.renderStatus !== "verified" ||
    row.storageStatus !== "available"
  ) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Existing image ${imageId} is not available for reuse`,
    );
  }
  if (!reuseAllowed) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Existing image ${imageId} was not approved for reuse`,
    );
  }
  return {
    row,
    integrity: {
      contentType: row.contentType,
      width: row.width,
      height: row.height,
      detectedContentType: row.contentType,
      sha256: row.sha256,
      renderStatus: "verified",
      storageStatus: "available",
      verifiedAt: new Date(),
    },
  };
};

const verifyPendingStagedImage = async (
  row: ImportImageRow,
  imageId: string,
  candidates: StagedImageIntegrityItem[],
  ports: PhotoImportCommitPorts,
): Promise<VerifiedStagedImage> => {
  const item = candidates[0];
  if (!item) throw new Error(`Validated image ${imageId} has no selection`);
  if (
    candidates.some(
      (candidate) =>
        candidate.sha256 !== item.sha256 ||
        candidate.width !== item.width ||
        candidate.height !== item.height,
    )
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Staged image ${imageId} has conflicting local analysis`,
    );
  }
  const response = await ports.getObject(row.key);
  if (!response.ok) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Staged bytes for ${imageId} are unavailable`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== row.size) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Staged bytes for ${imageId} changed size`,
    );
  }
  const integrity = await ports.inspect(bytes, row.contentType);
  // ImageIO reports display-oriented dimensions while the lightweight server inspector
  // deliberately reports raw encoded dimensions. Exact bytes can therefore legitimately
  // present the same width/height pair in the opposite order for EXIF/HEIF rotation.
  const dimensionsMatch =
    (integrity.width === item.width && integrity.height === item.height) ||
    (integrity.width === item.height && integrity.height === item.width);
  if (integrity.sha256 !== item.sha256 || !dimensionsMatch) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Staged bytes for ${imageId} do not match their local analysis`,
    );
  }
  return {
    row,
    integrity: { ...integrity, width: item.width, height: item.height },
  };
};

/**
 * Verify a flat set of staged/reused image selections against their rows:
 * bytes and dimensions for a fresh PENDING upload, availability (plus
 * `reuseAllowed`) for an already-UPLOADED exact-hash reuse. Shared by the
 * manifest commit path (which layers its own per-destination duplicate-
 * decision and analysis-consistency checks on top, see `verifyCommitImages`)
 * and the photo-inventory finalize path, which has no destination or
 * decision concept and always allows reuse of an exact-hash match `stage`
 * already returned.
 */
export async function verifyStagedImages(
  db: Database,
  items: readonly StagedImageIntegrityItem[],
  options: { reuseAllowed: boolean },
  ports: PhotoImportCommitPorts,
): Promise<VerifiedStagedImage[]> {
  const itemsByCode = new Map<string, StagedImageIntegrityItem[]>();
  for (const item of items) {
    const bucket = itemsByCode.get(item.imageId);
    if (bucket) bucket.push(item);
    else itemsByCode.set(item.imageId, [item]);
  }
  const codes = [...itemsByCode.keys()];
  const rows = await ports.getImages(db, codes);
  const byCode = new Map(rows.map((row) => [row.shortcode, row]));
  if (byCode.size !== codes.length) {
    throw createAppError(
      "REFERENCED_RECORD_MISSING",
      "One or more staged images are unavailable",
    );
  }

  const verified: VerifiedStagedImage[] = [];
  for (const [imageId, candidates] of itemsByCode) {
    const row = byCode.get(imageId);
    if (!row) {
      throw createAppError(
        "REFERENCED_RECORD_MISSING",
        `Staged image ${imageId} is unavailable`,
      );
    }
    if (row.status === "UPLOADED") {
      verified.push(
        verifyUploadedStagedImage(row, imageId, options.reuseAllowed),
      );
      continue;
    }
    if (row.status !== "PENDING") {
      throw createAppError(
        "IMAGE_PRECONDITION_FAILED",
        `Staged image ${imageId} is not pending`,
      );
    }
    verified.push(
      await verifyPendingStagedImage(row, imageId, candidates, ports),
    );
  }
  return verified;
}

/**
 * Commit-specific wrapper: adapts commit's per-destination items into the
 * shared shape, then layers commit's own invariants back on top of the
 * generic verification — a selected photo may appear only once, every
 * destination sharing a reused (already-UPLOADED) image must have agreed to
 * reuse it, and duplicate destinations for one staged image must submit the
 * same local analysis.
 */
async function verifyCommitImages(
  context: EntityKernelContext,
  input: PhotoImportCommitInput,
  ports: PhotoImportCommitPorts,
): Promise<VerifiedImportImage[]> {
  const clientIDs = input.images.map((item) => item.clientId);
  if (new Set(clientIDs).size !== clientIDs.length) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A selected photo may appear only once in a photo import",
    );
  }
  const itemsByImageId = new Map<string, PhotoImportItem[]>();
  for (const item of input.images) {
    const bucket = itemsByImageId.get(item.imageId);
    if (bucket) bucket.push(item);
    else itemsByImageId.set(item.imageId, [item]);
  }
  const staged = await verifyStagedImages(
    context.db,
    input.images.map((item) => ({
      imageId: item.imageId,
      sha256: item.analysis.sha256,
      width: item.analysis.width,
      height: item.analysis.height,
    })),
    { reuseAllowed: true },
    ports,
  );
  return staged.map(({ row, integrity }): VerifiedImportImage => {
    const candidates = itemsByImageId.get(row.shortcode) ?? [];
    if (row.status === "UPLOADED") {
      if (candidates.some((item) => item.duplicateDecision !== "reuse")) {
        throw createAppError(
          "IMAGE_PRECONDITION_FAILED",
          `Existing image ${row.shortcode} was not approved for reuse`,
        );
      }
      const exactItems = candidates.filter(
        (item) => row.sha256 === item.analysis.sha256,
      );
      const exactAnalysis = exactItems[0]?.analysis ?? null;
      if (
        exactAnalysis &&
        exactItems.some((item) => !analysesMatch(item.analysis, exactAnalysis))
      ) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Reused image ${row.shortcode} has conflicting exact-match analysis`,
        );
      }
      // A reused active image is already durable. It receives associations only;
      // local analysis belongs to newly staged rows in this commit — but every
      // library block still becomes a sighting (the partner-copy case).
      return {
        row,
        integrity,
        analysis: null,
        sightings: candidates.flatMap((c) => (c.library ? [c.library] : [])),
        ownDeviceProvenance: candidates.some((c) =>
          isOwnDeviceProvenance(c.analysis.provenance.source),
        ),
      };
    }
    const item = candidates[0];
    if (!item) {
      throw new Error(`Validated image ${row.shortcode} has no selection`);
    }
    if (
      candidates.some(
        (candidate) => !analysesMatch(candidate.analysis, item.analysis),
      )
    ) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Staged image ${row.shortcode} has conflicting local analysis`,
      );
    }
    return {
      row,
      integrity,
      analysis: item.analysis,
      sightings: candidates.flatMap((c) => (c.library ? [c.library] : [])),
      ownDeviceProvenance: candidates.some((c) =>
        isOwnDeviceProvenance(c.analysis.provenance.source),
      ),
    };
  });
}

/**
 * Two independent, best-effort provenance writes per verified image, both
 * inside the commit's own transaction:
 *
 * 1. When any item attests `photoLibrary`/`camera` provenance, the image is
 *    the member's own — `source: "own"`, `provenanceEvidence: { basis:
 *    "sighting" }`, guarded so a prior manual confirmation is never
 *    overwritten (mirrors `deriveImageCapture`'s "confirmed is sticky" rule).
 * 2. Every `library` block reported for the image is upserted as an
 *    `ImageSighting` with `matchKind: "import"`, which also re-derives the
 *    image's capture fields (`upsertImageSightingInTransaction` calls
 *    `deriveAndStoreImageCapture`).
 *
 * Both DB-touching steps live in `repo/image-sighting.ts` — this service may
 * not import `~/server/db/schema` or `~/server/repo/database-helpers`
 * directly (`no-restricted-imports`).
 */
async function applyImportProvenance(
  tx: Database | DrizzleTransaction,
  actorUserId: UserId,
  installationId: string | undefined,
  verified: readonly VerifiedImportImage[],
  actor: ActorContext,
): Promise<void> {
  for (const staged of verified) {
    if (staged.ownDeviceProvenance) {
      await setImageOwnDeviceSource(tx, parseEntityId("image", staged.row.id));
    }
  }
  if (verified.every((staged) => staged.sightings.length === 0)) return;
  const context = await resolveImportSightingContext(
    tx,
    installationId,
    actorUserId,
  );
  if (!context) return;
  for (const staged of verified) {
    const imageId: ImageId = parseEntityId("image", staged.row.id);
    for (const sighting of staged.sightings) {
      await upsertImageSightingInTransaction(
        tx,
        {
          imageId,
          ledgerPartyId: context.ledgerPartyId,
          deviceId: context.deviceId,
          assetKey: sighting.assetKey,
          cloudIdentifier: sighting.cloudIdentifier,
          localIdentifier: sighting.localIdentifier,
          sourceType: sighting.sourceType,
          mediaSubtypes: sighting.mediaSubtypes,
          originalFilename: sighting.originalFilename,
          pixelWidth: sighting.pixelWidth,
          pixelHeight: sighting.pixelHeight,
          hasAdjustments: sighting.hasAdjustments,
          capturedAt: sighting.capturedAt,
          capturedAtOffsetMinutes: sighting.capturedAtOffsetMinutes,
          addedAt: sighting.addedAt,
          location: sighting.location,
          placeName: sighting.placeName,
          camera: sighting.camera,
          matchKind: "import",
          hashDistance: sighting.hashDistance,
          aspectGate: sighting.aspectGate,
          observedAt: sighting.observedAt,
        },
        actor,
      );
    }
  }
}

export async function commitPhotoImport(
  context: EntityKernelContext,
  input: PhotoImportCommitInput,
  routeAdapter: PhotoImportRouteAdapter,
  ports: PhotoImportCommitPorts = productionPhotoImportCommitPorts,
): Promise<PhotoImportCommitResult> {
  // R2 is verified before the transaction. A rollback never removes staged bytes, so the caller
  // can correct its plan and explicitly resubmit without uploading again. A retry that races this
  // preflight is still safe: the transaction compares the locked row status with this snapshot
  // before any route write, so only one request can consume a PENDING image.
  const verified = await verifyCommitImages(context, input, ports);
  const imageCodes = [...new Set(input.images.map((item) => item.imageId))];
  let sideEffectEvents: MutationSideEffectEvent[] = [];
  const deferred = deferPublications();
  const result = await ports.withTransaction(
    context.db,
    async (transactionDb) => {
      // Lock all rows before validating or writing the route plan. The
      // preflight above intentionally remains outside the transaction so R2
      // failures never hold database locks.
      const lockedRows = await ports.lockImages(transactionDb, imageCodes);
      const lockedByCode = new Map(
        lockedRows.map((row) => [row.shortcode, row] as const),
      );
      if (lockedByCode.size !== imageCodes.length) {
        throw createAppError(
          "REFERENCED_RECORD_MISSING",
          "One or more staged images disappeared before commit",
        );
      }
      const lockedVerified = verified.map((entry) => {
        const locked = lockedByCode.get(entry.row.shortcode);
        if (!locked || locked.status !== entry.row.status) {
          throw createAppError(
            "IMAGE_PRECONDITION_FAILED",
            `Staged image ${entry.row.shortcode} changed while it was being committed`,
          );
        }
        return { ...entry, row: locked };
      });
      const imagesByCode = new Map(
        lockedVerified.map(({ row }) => [row.shortcode, row] as const),
      );
      const transactionContext = {
        ...context,
        db: transactionDb,
        readDb: transactionDb,
        services: {
          ...context.services,
          recipeCosting: context.services.recipeCosting.bindTo(
            transactionDb,
            deferred.publish,
          ),
        },
      };
      await routeAdapter.validate(transactionContext, input, imagesByCode);
      const applied = await routeAdapter.apply(
        transactionContext,
        input,
        imagesByCode,
      );
      sideEffectEvents = applied.sideEffectEvents;
      await ports.applyProvenance(
        transactionDb,
        transactionContext.actorContext.userId,
        input.deviceId,
        lockedVerified,
        transactionContext.actorContext,
      );
      for (const event of sideEffectEvents) {
        await ports.refreshProjection(transactionDb, event);
      }
      await finalizeImportedImages(transactionDb, {
        pending: lockedVerified.map(({ row, integrity }) => ({
          row,
          integrity,
        })),
        analyses: lockedVerified
          .filter(
            (
              staged,
            ): staged is typeof staged & {
              analysis: NonNullable<typeof staged.analysis>;
            } => staged.analysis != null,
          )
          .map((staged) => ({
            imageId: staged.row.id,
            analysis: staged.analysis,
          })),
        ports: {
          activateImages: ports.activateImages,
          persistAnalysis: ports.persistAnalysis,
        },
      });
      // Only freshly-staged rows (an `analysis` block; a reused UPLOADED row
      // was already extracted the first time it was committed) need the
      // wakeup — same "new row, new task" rule as every other finalize seam.
      const freshlyUploaded = lockedVerified.filter(
        ({ analysis }) => analysis !== null,
      );
      if (freshlyUploaded.length > 0) {
        await deferred.publish(
          transactionDb,
          buildImageMetadataExtractionTasks(
            freshlyUploaded
              .filter(({ row }) => isImageContentType(row.contentType))
              .map(({ row }) => parseEntityId("image", row.id)),
          ),
          { source: "photo-import.commit" },
        );
      }
      return {
        committedPhotoIds: imageCodes,
        createdDestinations: applied.createdDestinations,
        committedAt: new Date().toISOString(),
      } satisfies PhotoImportCommitResult;
    },
  );
  await deferred.flush(context.db);
  await ports.runSideEffects(context.db, sideEffectEvents, undefined, {
    projection: "skip",
  });
  return result;
}
