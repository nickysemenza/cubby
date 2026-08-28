import type { ProjectShortcode } from "@cubby/schemas/identifiers";

import { image } from "~/entities/image.functions";
import { imageUpload } from "~/lib/image.functions";
import { executeEntity } from "~/server/entity-kernel";
import { implementOperationDomain } from "~/server/operation-domain.server";
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

export const imageHandlers = implementOperationDomain(image, {
  list: {
    readPolicy: "strong",
    run: async (context, input) => {
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
  },
  detail: {
    readPolicy: "strong",
    run: async (context, input) => {
      const result = await executeEntity(context, {
        action: "get",
        entity: "image",
        id: input.id,
        missing: "null",
      });
      if (result.action !== "get") {
        throw new Error("Image detail returned the wrong entity action");
      }
      return result.item;
    },
  },
  update: async (context, input) => {
    const updated = await executeEntity(context, {
      action: "update",
      entity: "image",
      id: input.id,
      data: input.data,
    });
    if (updated.action !== "update") {
      throw new Error("Image update returned the wrong entity action");
    }
    const refreshed = await executeEntity(context, {
      action: "get",
      entity: "image",
      id: input.id,
      missing: "error",
    });
    if (refreshed.action !== "get" || refreshed.item === null) {
      throw new Error("Updated image could not be reloaded");
    }
    return refreshed.item;
  },
  delete: async (context, input) => {
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
