import type { ActorContext } from "@cubby/schemas/context";
import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import {
  attachableImageEntity,
  type createFileUploadInput,
  type getImageByIdSchema,
  type imageAttachExistingInput,
  type imageBrowserListInput,
  type importImageFromUrlSchema,
  type mcpAttachFileInput,
} from "@cubby/schemas/image";
import { type AppErrorReason, parseShortcode } from "@cubby/shared";
import type { z } from "zod";

import { imageUploadContract } from "~/contracts/image-upload.contract";
import { imageContract } from "~/contracts/image.contract";
import type { Database } from "~/server/db";
import {
  type EntityKernelContext,
  executeEntityAs,
} from "~/server/entity-kernel";
import { AppError, createAppError } from "~/server/errors/app-error";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  attachExistingImageToEntity,
  getImageHashIndex,
  getImagesByProjectIds,
  markImageUploaded,
  setImagePerceptualHashes,
} from "~/server/repo/image";
import { recordImageSightings } from "~/server/repo/image-sighting";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { publishImageMetadataExtraction } from "~/server/services/image-metadata-extraction.service";
import { scheduleImageProcessingJobs } from "~/server/services/image-processing.service";
import {
  attachFileToEntity,
  createFileUpload,
  cullPendingImageStorage,
  importImageFromUrl,
  initiateDocumentUpload,
  initiateImageUploadWithoutEntity,
} from "~/server/services/image-storage.service";

import {
  readImageAnalysis,
  recordImageAnalysis,
} from "./image-analysis.server";

export async function markImageUploadedWorkflow(
  db: Database,
  input: z.output<typeof getImageByIdSchema>,
) {
  const imageId = await resolveOrThrow(db, "image", input.id);
  const uploaded = await markImageUploaded(db, imageId);
  // Settings default disabled/paused, so rollout creates no automatic work
  // until the owner explicitly enables it. Durable jobs repair missed wakes.
  await scheduleImageProcessingJobs(db, {
    id: uploaded.id,
    kinds: ["describe_image", "subject_lift"],
    automatic: true,
  });
  await publishImageMetadataExtraction(
    db,
    imageId,
    uploaded.contentType,
    "image.markUploaded",
  );
  return uploaded;
}

/** Storage failures surface as one declared reason; `preserveAppError` keeps a
 * more specific reason the storage layer already chose. */
async function translateImageFailure<Output>(
  run: () => Promise<Output>,
  reason: AppErrorReason,
  message: string,
  preserveAppError = false,
): Promise<Output> {
  try {
    return await run();
  } catch (error) {
    if (preserveAppError && error instanceof AppError) throw error;
    throw createAppError(reason, message, error);
  }
}

const uploadReceipt = (result: {
  uploadUrl: string;
  imageId: string;
  key: string;
  url: string;
}) => ({
  uploadUrl: result.uploadUrl,
  imageId: result.imageId,
  key: result.key,
  url: result.url,
});

export const attachFileWorkflow = (
  db: Database,
  input: z.output<typeof mcpAttachFileInput>,
) =>
  translateImageFailure(
    () => attachFileToEntity(db, input),
    "IMAGE_UPLOAD_FAILED",
    "Failed to attach file",
    true,
  );

export const createFileUploadWorkflow = (
  db: Database,
  input: z.output<typeof createFileUploadInput>,
) =>
  translateImageFailure(
    () => createFileUpload(db, input),
    "IMAGE_UPLOAD_FAILED",
    "Failed to create file upload",
    true,
  );

export const attachExistingImageWorkflow = async (
  db: Database,
  actor: ActorContext,
  input: z.output<typeof imageAttachExistingInput>,
) => {
  const attach = await attachExistingImageToEntity(db, input, actor);
  return {
    imageId: input.imageId,
    targetId: input.targetId,
    reused: attach.reused,
  };
};

async function importImageFromUrlOperation(
  db: Database,
  input: z.output<typeof importImageFromUrlSchema>,
) {
  return translateImageFailure(
    async () => {
      const request = {
        sourceUrl: input.url,
        filenamePrefix: `${input.entityKind ?? "image"}-url-import`,
      };
      const result = await importImageFromUrl(db, request);
      if (!result) throw new Error("Failed to fetch image from URL");
      const filename =
        new URL(request.sourceUrl).pathname.split("/").pop() ||
        `${request.filenamePrefix}.jpg`;
      return {
        imageId: result.imageId,
        key: result.key,
        url: result.url,
        filename,
      };
    },
    "IMAGE_IMPORT_FAILED",
    "Failed to import image from URL",
  );
}

/** Image entity reads and writes go through the entity kernel. */
async function listImages(
  context: EntityKernelContext,
  input: z.output<typeof imageBrowserListInput>,
) {
  const result = await executeEntityAs(context, "list", {
    entity: "image",
    filters: input.filters,
    sort: input.sort,
    pagination: input.pagination,
    groupBy: input.groupBy,
  });
  return { items: result.items, meta: result.meta };
}

async function getImage(
  context: EntityKernelContext,
  id: string,
  missing: "error" | "null",
) {
  const result = await executeEntityAs(context, "get", {
    entity: "image",
    id,
    missing,
  });
  return result.item;
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

export const imageHandlers = implementOperationDomain(imageContract, {
  recordSightings: (context, input) =>
    recordImageSightings(context.db, input.items, context.actorContext),
  list: (context, input) => listImages(context, input),
  detail: (context, input) => getImage(context, input.id, "null"),
  analysis: (context, input) => readImageAnalysis(context, input.id),
  recordAnalysis: (context, input) =>
    recordImageAnalysis(context, input.id, input.analysis),
  update: async (context, input) => {
    // Update the stored row, then reload the enriched projection consumers render.
    await executeEntityAs(context, "update", {
      entity: "image",
      id: input.id,
      data: input.data,
    });
    const refreshed = await getImage(context, input.id, "error");
    if (refreshed === null)
      throw new Error("Updated image could not be reloaded");
    return refreshed;
  },
  attachExisting: (context, input) => {
    const parsed = parseShortcode(input.targetId);
    if (!attachableImageEntity.safeParse(parsed?.type).success)
      throw new Error(
        `${input.targetId} is not a gallery attachment target; expected ${attachableImageEntity.options.join(", ")}.`,
      );
    return attachExistingImageWorkflow(context.db, context.actorContext, input);
  },
  delete: async (context, input) => {
    const result = await executeEntityAs(context, "delete", {
      entity: "image",
      ids: input.ids,
    });
    return {
      deleted: result.deletedReferences.length,
      sideEffects: result.sideEffects,
    };
  },
  projectSummaries: async (context, input) => {
    const entityIds = await resolveAllOrThrow(
      context.db,
      "project",
      input.projectIds,
    );
    const imagesByEntityId = await getImagesByProjectIds(context.db, entityIds);
    return projectImageSummaries(input.projectIds, entityIds, imagesByEntityId);
  },
  hashIndex: (context) => getImageHashIndex(context.db),
  setPerceptualHashes: (context, input) =>
    setImagePerceptualHashes(context.db, input),
});

export const imageUploadHandlers = implementOperationDomain(
  imageUploadContract,
  {
    markUploaded: (context, input) =>
      markImageUploadedWorkflow(context.db, input),
    uploadImage: async (context, input) =>
      translateImageFailure(
        async () =>
          uploadReceipt(
            await initiateImageUploadWithoutEntity(context.db, input),
          ),
        "IMAGE_UPLOAD_FAILED",
        "Failed to initiate upload",
      ),
    uploadDocument: async (context, input) =>
      translateImageFailure(
        async () =>
          uploadReceipt(await initiateDocumentUpload(context.db, input)),
        "IMAGE_UPLOAD_FAILED",
        "Failed to initiate upload",
      ),
    importFromUrl: (context, input) =>
      importImageFromUrlOperation(context.db, input),
    cullPendingImages: (context, input) =>
      translateImageFailure(
        () => cullPendingImageStorage(context.db, input.olderThanHours),
        "IMAGE_CULL_FAILED",
        "Failed to cull pending images",
      ),
    createFileUpload: (context, input) =>
      createFileUploadWorkflow(context.db, input),
    attachFile: (context, input) => {
      const parsed = parseShortcode(input.entityId);
      const attachable = attachableImageEntity.safeParse(parsed?.type);
      if (!attachable.success)
        throw new Error(
          `${input.entityId} names a ${parsed?.type ?? "unknown"}; files attach to a ${attachableImageEntity.options.join(", ")}.`,
        );
      return attachFileWorkflow(context.db, {
        ...input,
        entityKind: attachable.data,
      });
    },
  },
);
