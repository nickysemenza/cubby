import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import {
  imageBrowserDeleteInput,
  imageBrowserDeleteOut,
  imageBrowserListInput,
  imageBrowserListOut,
  imageBrowserUpdateInput,
  type ImageWithEntity,
} from "@cubby/schemas/image";
import type { z } from "zod";

import { imageUploadContract } from "~/contracts/image-upload.contract";
import { imageContract } from "~/contracts/image.contract";
import {
  type EntityKernelContext,
  executeEntity,
} from "~/server/entity-kernel";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getImagesByProjectIds } from "~/server/repo/image";
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
  list: {
    run: (context, input) => productionImageBrowserPorts.list(context, input),
  },
  detail: {
    run: (context, input) =>
      productionImageBrowserPorts.get(context, input.id, "null"),
  },
  update: async (context, input) => {
    return updateImageThenReload(productionImageBrowserPorts, context, input);
  },
  delete: (context, input) =>
    productionImageBrowserPorts.delete(context, input),
  projectSummaries: {
    run: (context, input) =>
      loadProjectImageSummaries(context, input.projectIds),
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
