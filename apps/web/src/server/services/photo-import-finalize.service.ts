import {
  imageId as parseImageId,
  type ImageId,
} from "@cubby/schemas/identifiers";

import type { PhotoImportCommitInput } from "~/contracts/photo-import.contract";
import type { Database } from "~/server/db";
import {
  activateImportImages,
  persistLocalImageAnalysis,
} from "~/server/repo/photo-import";

type ActivationEntry = Parameters<typeof activateImportImages>[1][number];

/** One image row queued for activation, with the integrity snapshot the UPDATE writes. */
type PendingImageActivation = ActivationEntry;

interface PendingImageAnalysis {
  imageId: string;
  analysis: PhotoImportCommitInput["images"][number]["analysis"];
}

interface FinalizeImportedImagesHooks {
  /** Seam for post-activation enrichment (EXIF, sightings, ...); not yet wired by any caller. */
  afterActivate?: (ctx: {
    txDb: Database;
    imageIds: ImageId[];
  }) => Promise<void>;
}

interface FinalizeImportedImagesPorts {
  activateImages: typeof activateImportImages;
  persistAnalysis: typeof persistLocalImageAnalysis;
}

const productionFinalizeImportedImagesPorts: FinalizeImportedImagesPorts = {
  activateImages: activateImportImages,
  persistAnalysis: persistLocalImageAnalysis,
};

export interface FinalizeImportedImagesInput {
  pending: readonly PendingImageActivation[];
  analyses: readonly PendingImageAnalysis[];
  hooks?: FinalizeImportedImagesHooks;
  ports?: FinalizeImportedImagesPorts;
}

export interface FinalizeImportedImagesResult {
  activatedImageIds: ImageId[];
}

/**
 * Shared activation seam for the photo-import commit path and the
 * photo-inventory finalize path: persist any local analyses, then activate
 * every row still PENDING as one final database operation.
 *
 * `pending` may include rows a previous attempt at the same chunk already
 * activated (a retry racing a partial commit). Those are excluded from both
 * the activation call and its count assertion below rather than failing the
 * idempotent replay.
 */
export async function finalizeImportedImages(
  txDb: Database,
  input: FinalizeImportedImagesInput,
): Promise<FinalizeImportedImagesResult> {
  const ports = input.ports ?? productionFinalizeImportedImagesPorts;
  for (const { imageId, analysis } of input.analyses) {
    await ports.persistAnalysis(
      txDb,
      imageId,
      analysis,
      analysis.analysisVersion,
      analysis.sha256,
    );
  }
  const stillPending = input.pending.filter(
    (entry) => entry.row.status === "PENDING",
  );
  const activatedCount = await ports.activateImages(txDb, stillPending);
  if (activatedCount !== stillPending.length) {
    throw new Error(
      `Photo import activated ${activatedCount} images; expected ${stillPending.length}`,
    );
  }
  const imageIds = stillPending.map((entry) =>
    parseImageId.parse(entry.row.id),
  );
  await input.hooks?.afterActivate?.({ txDb, imageIds });
  return { activatedImageIds: imageIds };
}
