import type { ProjectShortcode } from "@cubby/schemas/identifiers";
import {
  imageBrowserDeleteInput,
  imageBrowserDeleteOut,
  imageBrowserListInput,
  imageBrowserListOut,
  imageBrowserUpdateInput,
  imageWithEntitySchema,
  projectImageSummariesInput,
  projectImageSummariesOut,
} from "@cubby/schemas/image";
import { z } from "zod";
import { executeEntity } from "~/server/entity-kernel";
import { getImagesByProjectIds } from "~/server/repo/image";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  cleanupUnreferencedImagesWorkflow,
  cullPendingImagesWorkflow,
  imageWorkflowSchemas,
  importImageFromUrlWorkflow,
  initiateDocumentUploadWorkflow,
  initiateImageUploadWorkflow,
  markImageUploadedWorkflow,
} from "~/server/workflows/image.server";

type SchemaPair = { input: z.ZodType; output: z.ZodType };
const run = <S extends SchemaPair>(o: {
  operation: string;
  schemas: S;
  data: z.input<S["input"]>;
  request: StartOperationRequest;
  workflow: (
    db: Parameters<Parameters<typeof runStartOperation>[0]["run"]>[0]["db"],
    input: z.output<S["input"]>,
  ) => Promise<unknown>;
}) =>
  runStartOperation<S["input"], z.output<S["output"]>>({
    operation: o.operation,
    type: "mutation",
    input: o.data,
    inputSchema: o.schemas.input,
    outputSchema: o.schemas.output as z.ZodType<z.output<S["output"]>>,
    request: o.request,
    run: (context, input) => o.workflow(context.db, input),
  });
const schemas = imageWorkflowSchemas;

export const listImages = (o: {
  data: z.input<typeof imageBrowserListInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "image.list",
    type: "query",
    input: o.data,
    inputSchema: imageBrowserListInput,
    outputSchema: imageBrowserListOut,
    request: o.request,
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
  });

export const getImageDetail = (o: {
  data: { id: string };
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "image.detail",
    type: "query",
    input: o.data,
    inputSchema: z.object({ id: z.string() }),
    outputSchema: imageWithEntitySchema.nullable(),
    request: o.request,
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
  });

export const updateImage = (o: {
  data: z.input<typeof imageBrowserUpdateInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "image.update",
    type: "mutation",
    input: o.data,
    inputSchema: imageBrowserUpdateInput,
    outputSchema: imageWithEntitySchema,
    request: o.request,
    run: async (context, input) => {
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
  });

export const deleteImages = (o: {
  data: z.input<typeof imageBrowserDeleteInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "image.delete",
    type: "mutation",
    input: o.data,
    inputSchema: imageBrowserDeleteInput,
    outputSchema: imageBrowserDeleteOut,
    request: o.request,
    run: async (context, input) => {
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
  });

export const getProjectImageSummaries = (o: {
  data: z.input<typeof projectImageSummariesInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "image.projectSummaries",
    type: "query",
    input: o.data,
    inputSchema: projectImageSummariesInput,
    outputSchema: projectImageSummariesOut,
    request: o.request,
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
  });

export const markImageUploadedForBrowser = (o: {
  data: z.input<typeof schemas.markUploaded.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "image.markUploaded",
    schemas: schemas.markUploaded,
    workflow: markImageUploadedWorkflow,
  });
export const initiateImageUploadForBrowser = (o: {
  data: z.input<typeof schemas.uploadImage.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "image.uploadImage",
    schemas: schemas.uploadImage,
    workflow: initiateImageUploadWorkflow,
  });
export const initiateDocumentUploadForBrowser = (o: {
  data: z.input<typeof schemas.uploadDocument.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "image.uploadDocument",
    schemas: schemas.uploadDocument,
    workflow: initiateDocumentUploadWorkflow,
  });
export const importImageFromUrlForBrowser = (o: {
  data: z.input<typeof schemas.importFromUrl.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "image.importFromUrl",
    schemas: schemas.importFromUrl,
    workflow: importImageFromUrlWorkflow,
  });
export const cullPendingImagesForBrowser = (o: {
  data: z.input<typeof schemas.cullPendingImages.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "image.cullPendingImages",
    schemas: schemas.cullPendingImages,
    workflow: cullPendingImagesWorkflow,
  });
export const cleanupUnreferencedImagesForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "image.cleanupUnreferencedImages",
    schemas: schemas.cleanupUnreferencedImages,
    workflow: (db) => cleanupUnreferencedImagesWorkflow(db),
  });
