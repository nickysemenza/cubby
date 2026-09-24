import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import {
  imageBrowserDeleteInput,
  imageBrowserDeleteOut,
  imageBrowserListInput,
  imageBrowserListOut,
  imageBrowserUpdateInput,
  imageAttachExistingInput,
  type ImageWithEntity,
} from "@cubby/schemas/image";
import type { z } from "zod";

import { imageUploadContract } from "~/contracts/image-upload.contract";
import { imageContract } from "~/contracts/image.contract";
import type { LocalPhotoAnalysis } from "~/contracts/photo-import.contract";
import {
  type EntityKernelContext,
  executeEntity,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getImageHashIndex,
  getImagesByProjectIds,
  setImagePerceptualHashes,
  attachExistingImageToEntity,
} from "~/server/repo/image";
import { upsertImageSightingPage } from "~/server/repo/image-sighting";
import {
  getLocalImageAnalysis,
  getImportImageRows,
  persistLocalImageAnalysis,
  type ImportImageRow,
} from "~/server/repo/photo-import";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";
import {
  cullPendingImagesWorkflow,
  importImageFromUrlWorkflow,
  initiateDocumentUploadWorkflow,
  initiateImageUploadWorkflow,
  markImageUploadedWorkflow,
} from "~/server/workflows/image.server";

type ImageListInput = z.output<typeof imageBrowserListInput>;
type ImageListOutput = z.output<typeof imageBrowserListOut>;
type ImageUpdateInput = z.output<typeof imageBrowserUpdateInput>;
type ImageDeleteInput = z.output<typeof imageBrowserDeleteInput>;
type ImageDeleteOutput = z.output<typeof imageBrowserDeleteOut>;
type ImageAttachExistingInput = z.output<typeof imageAttachExistingInput>;

export interface ImageBrowserPorts {
  list(
    context: EntityKernelContext,
    input: ImageListInput,
  ): Promise<ImageListOutput>;
  get(
    context: EntityKernelContext,
    id: string,
    missing: "error" | "null",
  ): Promise<ImageWithEntity | null>;
  update(context: EntityKernelContext, input: ImageUpdateInput): Promise<void>;
  delete(
    context: EntityKernelContext,
    input: ImageDeleteInput,
  ): Promise<ImageDeleteOutput>;
}

const productionImageBrowserPorts = {
  async list(context, input) {
    const result = await executeEntity(context, {
      action: "list",
      entity: "image",
      filters: input.filters,
      sort: input.sort,
      pagination: input.pagination,
      groupBy: input.groupBy,
    });
    if (result.action !== "list") {
      throw new Error("Image list returned the wrong entity action");
    }
    return { items: result.items, meta: result.meta };
  },
  async get(context, id, missing) {
    const result = await executeEntity(context, {
      action: "get",
      entity: "image",
      id,
      missing,
    });
    if (result.action !== "get") {
      throw new Error("Image detail returned the wrong entity action");
    }
    return result.item;
  },
  async update(context, input) {
    const result = await executeEntity(context, {
      action: "update",
      entity: "image",
      id: input.id,
      data: input.data,
    });
    if (result.action !== "update") {
      throw new Error("Image update returned the wrong entity action");
    }
  },
  async delete(context, input) {
    const result = await executeEntity(context, {
      action: "delete",
      entity: "image",
      ids: input.ids,
    });
    if (result.action !== "delete") {
      throw new Error("Image delete returned the wrong entity action");
    }
    return {
      deleted: result.deletedReferences.length,
      sideEffects: result.sideEffects,
    };
  },
} satisfies ImageBrowserPorts;

/** Update the stored row, then reload the enriched projection consumers render. */
export async function updateImageThenReload<TContext>(
  ports: {
    update(context: TContext, input: ImageUpdateInput): Promise<void>;
    get(
      context: TContext,
      id: string,
      missing: "error" | "null",
    ): Promise<ImageWithEntity | null>;
  },
  context: TContext,
  input: ImageUpdateInput,
): Promise<ImageWithEntity> {
  await ports.update(context, input);
  const refreshed = await ports.get(context, input.id, "error");
  if (refreshed === null)
    throw new Error("Updated image could not be reloaded");
  return refreshed;
}

/**
 * Read + backfill ports for the diagnostics tab's persisted-analysis round
 * trip. Kept separate from {@link ImageBrowserPorts} because these resolve
 * through the import row (uuid, status, sha256), not the entity kernel.
 */
export interface ImagePhotoAnalysisPorts {
  getImportRow(
    context: EntityKernelContext,
    id: string,
  ): Promise<ImportImageRow | null>;
  getAnalysis(
    context: EntityKernelContext,
    imageId: string,
  ): Promise<LocalPhotoAnalysis | null>;
  persistAnalysis(
    context: EntityKernelContext,
    imageId: string,
    analysis: LocalPhotoAnalysis,
    analysisVersion: number,
    sha256: string,
  ): Promise<void>;
}

export const productionImagePhotoAnalysisPorts: ImagePhotoAnalysisPorts = {
  async getImportRow(context, id) {
    const [row] = await getImportImageRows(context.db, [id]);
    return row ?? null;
  },
  getAnalysis: (context, imageId) => getLocalImageAnalysis(context.db, imageId),
  persistAnalysis: (context, imageId, analysis, analysisVersion, sha256) =>
    persistLocalImageAnalysis(
      context.db,
      imageId,
      analysis,
      analysisVersion,
      sha256,
    ),
};

/** The device's local analysis for an image, or `null` if nothing is persisted. */
export async function readImageAnalysis(
  ports: Pick<ImagePhotoAnalysisPorts, "getImportRow" | "getAnalysis">,
  context: EntityKernelContext,
  id: string,
): Promise<LocalPhotoAnalysis | null> {
  const row = await ports.getImportRow(context, id);
  if (!row) return null;
  return ports.getAnalysis(context, row.id);
}

/**
 * Backfill a device-run analysis onto an already-uploaded image. Refuses when
 * the image isn't `UPLOADED` yet or the analysis was computed over different
 * bytes (`sha256` mismatch) — either means the analysis does not describe the
 * row it would be attached to.
 */
export async function recordImageAnalysis(
  ports: ImagePhotoAnalysisPorts,
  context: EntityKernelContext,
  id: string,
  analysis: LocalPhotoAnalysis,
): Promise<{ saved: boolean }> {
  const row = await ports.getImportRow(context, id);
  if (!row || row.status !== "UPLOADED" || row.sha256 !== analysis.sha256) {
    throw createAppError(
      "IMAGE_PRECONDITION_FAILED",
      `Image ${id} is not eligible for a local-analysis backfill`,
    );
  }
  await ports.persistAnalysis(
    context,
    row.id,
    analysis,
    analysis.analysisVersion,
    analysis.sha256,
  );
  return { saved: true };
}

/**
 * Keep the shortcode-facing projection aligned with the paired resolver result.
 * A zip is only valid when resolution preserves input cardinality.
 */
export function projectImageSummaries<TImage>(
  projectIds: readonly ProjectShortcode[],
  entityIds: readonly string[],
  imagesByEntityId: Readonly<Record<string, readonly TImage[]>>,
) {
  if (entityIds.length !== projectIds.length) {
    throw new Error("Project resolution changed result cardinality");
  }
  const shortcodeByEntityId = new Map<string, ProjectShortcode>(
    entityIds.map((entityId, index): [string, ProjectShortcode] => {
      const shortcode = projectIds[index];
      if (!shortcode) {
        throw new Error("Project resolution changed result cardinality");
      }
      return [entityId, shortcode];
    }),
  );
  const entries: [ProjectShortcode, TImage[]][] = [];
  for (const [entityId, images] of Object.entries(imagesByEntityId)) {
    const shortcode = shortcodeByEntityId.get(entityId);
    if (shortcode) entries.push([shortcode, [...images]]);
  }
  return Object.fromEntries(entries);
}

async function loadProjectImageSummaries(
  context: EntityKernelContext,
  projectIds: readonly ProjectShortcode[],
) {
  const entityIds = await resolveAllOrThrow(context.db, "project", projectIds);
  const imagesByEntityId = await getImagesByProjectIds(context.db, entityIds);
  return projectImageSummaries(projectIds, entityIds, imagesByEntityId);
}

export const imageHandlers = implementOperationDomain(imageContract, {
  bulkSightings: (context, input) =>
    upsertImageSightingPage(context.db, input.items, context.actorContext),
  list: {
    run: (context, input) => productionImageBrowserPorts.list(context, input),
  },
  detail: {
    run: (context, input) =>
      productionImageBrowserPorts.get(context, input.id, "null"),
  },
  analysis: {
    run: (context, input) =>
      readImageAnalysis(productionImagePhotoAnalysisPorts, context, input.id),
  },
  recordAnalysis: {
    run: (context, input) =>
      recordImageAnalysis(
        productionImagePhotoAnalysisPorts,
        context,
        input.id,
        input.analysis,
      ),
  },
  update: async (context, input) => {
    return updateImageThenReload(productionImageBrowserPorts, context, input);
  },
  attachExisting: async (context, input: ImageAttachExistingInput) => {
    const result = await attachExistingImageToEntity(
      context.db,
      input,
      context.actorContext,
    );
    return {
      imageId: input.imageId,
      targetId: input.targetId,
      reused: result.reused,
    };
  },
  delete: (context, input) =>
    productionImageBrowserPorts.delete(context, input),
  projectSummaries: {
    run: (context, input) =>
      loadProjectImageSummaries(context, input.projectIds),
  },
  hashIndex: {
    run: (context) => getImageHashIndex(context.db),
  },
  setPerceptualHashes: {
    run: (context, input) => setImagePerceptualHashes(context.db, input),
  },
});

export const imageUploadHandlers = implementOperationDomain(
  imageUploadContract,
  {
    markUploaded: (context, input) =>
      markImageUploadedWorkflow(context.db, input),
    uploadImage: (context, input) =>
      initiateImageUploadWorkflow(context.db, input),
    uploadDocument: (context, input) =>
      initiateDocumentUploadWorkflow(context.db, input),
    importFromUrl: (context, input) =>
      importImageFromUrlWorkflow(context.db, input),
    cullPendingImages: (context, input) =>
      cullPendingImagesWorkflow(context.db, input),
  },
);
