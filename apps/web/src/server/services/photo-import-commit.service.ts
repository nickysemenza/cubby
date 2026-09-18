import type {
  PhotoImportCommitInput,
  PhotoImportCommitResult,
} from "~/contracts/photo-import.contract";
import { deferPublications } from "~/server/background-tasks/publish";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";
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
  refreshProjectionsForEvent,
  runMutationSideEffectsForEntities,
  type MutationSideEffectEvent,
} from "~/server/services/mutation-side-effects";
import { getS3Object } from "~/server/utils/s3";

interface VerifiedImportImage {
  row: ImportImageRow;
  integrity: Awaited<ReturnType<typeof inspectImageFile>>;
  analysis: PhotoImportCommitInput["images"][number]["analysis"] | null;
}

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
  runSideEffects: runMutationSideEffectsForEntities,
};

type PhotoImportItem = PhotoImportCommitInput["images"][number];

const analysesMatch = (
  left: PhotoImportItem["analysis"],
  right: PhotoImportItem["analysis"],
): boolean => JSON.stringify(left) === JSON.stringify(right);

const verifyUploadedImage = async (
  row: ImportImageRow,
  imageId: string,
  items: PhotoImportItem[],
): Promise<VerifiedImportImage> => {
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
  if (items.some((item) => item.duplicateDecision !== "reuse")) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Existing image ${imageId} was not approved for reuse`,
    );
  }
  const exactItems = items.filter(
    (item) => row.sha256 === item.analysis.sha256,
  );
  const exactAnalysis = exactItems[0]?.analysis ?? null;
  if (
    exactAnalysis &&
    exactItems.some((item) => !analysesMatch(item.analysis, exactAnalysis))
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Reused image ${imageId} has conflicting exact-match analysis`,
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
    // A reused active image is already durable. It receives associations only;
    // local analysis belongs to newly staged rows in this commit.
    analysis: null,
  };
};

const verifyPendingImage = async (
  row: ImportImageRow,
  imageId: string,
  items: PhotoImportItem[],
  ports: PhotoImportCommitPorts,
): Promise<VerifiedImportImage> => {
  const item = items[0];
  if (!item) throw new Error(`Validated image ${imageId} has no selection`);
  if (
    items.some((candidate) => !analysesMatch(candidate.analysis, item.analysis))
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
  if (
    integrity.sha256 !== item.analysis.sha256 ||
    integrity.width !== item.analysis.width ||
    integrity.height !== item.analysis.height
  ) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Staged bytes for ${imageId} do not match their local analysis`,
    );
  }
  return { row, integrity, analysis: item.analysis };
};

async function verifyStagedImages(
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
  const itemsByCode = new Map<string, PhotoImportCommitInput["images"]>();
  for (const item of input.images) {
    const items = itemsByCode.get(item.imageId);
    if (items) items.push(item);
    else itemsByCode.set(item.imageId, [item]);
  }
  const codes = [...itemsByCode.keys()];
  const rows = await ports.getImages(context.db, codes);
  const byCode = new Map(rows.map((row) => [row.shortcode, row]));
  if (byCode.size !== codes.length) {
    throw createAppError(
      "REFERENCED_RECORD_MISSING",
      "One or more staged images are unavailable",
    );
  }

  const verified: VerifiedImportImage[] = [];
  for (const [imageId, items] of itemsByCode) {
    const row = byCode.get(imageId);
    if (!row) {
      throw createAppError(
        "REFERENCED_RECORD_MISSING",
        `Staged image ${imageId} is unavailable`,
      );
    }
    if (row.status === "UPLOADED") {
      verified.push(await verifyUploadedImage(row, imageId, items));
      continue;
    }
    if (row.status !== "PENDING") {
      throw createAppError(
        "IMAGE_PRECONDITION_FAILED",
        `Staged image ${imageId} is not pending`,
      );
    }
    verified.push(await verifyPendingImage(row, imageId, items, ports));
  }
  return verified;
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
  const verified = await verifyStagedImages(context, input, ports);
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
      for (const staged of lockedVerified) {
        if (staged.analysis) {
          await ports.persistAnalysis(
            transactionDb,
            staged.row.id,
            staged.analysis,
            staged.analysis.analysisVersion,
            staged.analysis.sha256,
          );
        }
      }
      for (const event of sideEffectEvents) {
        await ports.refreshProjection(transactionDb, event);
      }
      const pending = lockedVerified.filter(
        ({ row }) => row.status === "PENDING",
      );
      const activatedCount = await ports.activateImages(transactionDb, pending);
      if (activatedCount !== pending.length) {
        throw new Error(
          `Photo import activated ${activatedCount} images; expected ${pending.length}`,
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
