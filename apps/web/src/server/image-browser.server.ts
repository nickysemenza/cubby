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

import { image } from "~/entities/image.functions";
import { imageUpload } from "~/lib/image.functions";
import {
  type EntityKernelContext,
  executeEntity,
} from "~/server/entity-kernel";
import {
  implementOperationDomain,
  type OperationExecutionAdapter,
} from "~/server/operation-domain.server";
import { getImagesByProjectIds } from "~/server/repo/image";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";
import {
  cleanupUnreferencedImagesWorkflow,
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
    return { deleted: result.deleted, sideEffects: result.sideEffects };
  },
} satisfies ImageBrowserPorts;

export function createImageHandlers(
  portOverrides: Partial<ImageBrowserPorts> = {},
  adapter?: OperationExecutionAdapter,
) {
  const ports = { ...productionImageBrowserPorts, ...portOverrides };
  return implementOperationDomain(
    image,
    {
      list: {
        readPolicy: "strong",
        run: (context, input) => ports.list(context, input),
      },
      detail: {
        readPolicy: "strong",
        run: (context, input) => ports.get(context, input.id, "null"),
      },
      update: async (context, input) => {
        await ports.update(context, input);
        const refreshed = await ports.get(context, input.id, "error");
        if (refreshed === null) {
          throw new Error("Updated image could not be reloaded");
        }
        return refreshed;
      },
      delete: (context, input) => ports.delete(context, input),
      projectSummaries: {
        readPolicy: "strong",
        run: async (context, input) => {
          const entityIds = await resolveAllOrThrow(
            context.db,
            "project",
            input.projectIds,
          );
          const shortcodeByEntityId = new Map<string, ProjectShortcode>(
            entityIds.map((entityId, index) => {
              const shortcode = input.projectIds[index];
              if (!shortcode) {
                throw new Error(
                  "Project resolution changed result cardinality",
                );
              }
              return [entityId, shortcode];
            }),
          );
          const imagesByEntityId = await getImagesByProjectIds(
            context.db,
            entityIds,
          );
          return Object.fromEntries(
            Object.entries(imagesByEntityId).flatMap(([entityId, images]) => {
              const shortcode = shortcodeByEntityId.get(entityId);
              return shortcode ? [[shortcode, images]] : [];
            }),
          );
        },
      },
    },
    adapter,
  );
}

export const imageHandlers = implementOperationDomain(image, {
  list: {
    readPolicy: "strong",
    run: (context, input) => productionImageBrowserPorts.list(context, input),
  },
  detail: {
    readPolicy: "strong",
    run: (context, input) =>
      productionImageBrowserPorts.get(context, input.id, "null"),
  },
  update: async (context, input) => {
    await productionImageBrowserPorts.update(context, input);
    const refreshed = await productionImageBrowserPorts.get(
      context,
      input.id,
      "error",
    );
    if (refreshed === null) {
      throw new Error("Updated image could not be reloaded");
    }
    return refreshed;
  },
  delete: (context, input) =>
    productionImageBrowserPorts.delete(context, input),
  projectSummaries: {
    readPolicy: "strong",
    run: async (context, input) => {
      const entityIds = await resolveAllOrThrow(
        context.db,
        "project",
        input.projectIds,
      );
      const shortcodeByEntityId = new Map<string, ProjectShortcode>(
        input.projectIds.map((shortcode, index) => [
          entityIds[index]!,
          shortcode,
        ]),
      );
      const imagesByEntityId = await getImagesByProjectIds(
        context.db,
        entityIds,
      );
      return Object.fromEntries(
        Object.entries(imagesByEntityId).flatMap(([entityId, images]) => {
          const shortcode = shortcodeByEntityId.get(entityId);
          return shortcode ? [[shortcode, images]] : [];
        }),
      );
    },
  },
});

export const imageUploadHandlers = implementOperationDomain(imageUpload, {
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
  cleanupUnreferencedImages: (context) =>
    cleanupUnreferencedImagesWorkflow(context.db),
});
