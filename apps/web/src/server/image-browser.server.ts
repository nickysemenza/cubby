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
import type { z } from "zod";
import { executeEntity } from "~/server/entity-kernel";
import { getImagesByProjectIds } from "~/server/repo/image";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";

export const listImages = async (options: {
  data: z.input<typeof imageBrowserListInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "image.list",
    type: "query",
    input: options.data,
    inputSchema: imageBrowserListInput,
    outputSchema: imageBrowserListOut,
    request: options.request,
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
        throw new Error("Entity kernel returned the wrong action");
      }
      return { items: result.items, meta: result.meta };
    },
  });

export const getImageDetail = async (options: {
  data: { id: string };
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "image.detail",
    type: "query",
    input: options.data,
    inputSchema: imageBrowserUpdateInput.pick({ id: true }),
    outputSchema: imageWithEntitySchema.nullable(),
    request: options.request,
    readPolicy: "strong",
    run: async (context, input) => {
      const result = await executeEntity(context, {
        action: "get",
        entity: "image",
        id: input.id,
        missing: "null",
      });
      if (result.action !== "get") {
        throw new Error("Entity kernel returned the wrong action");
      }
      return result.item;
    },
  });

export const updateImage = async (options: {
  data: z.input<typeof imageBrowserUpdateInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "image.update",
    type: "mutation",
    input: options.data,
    inputSchema: imageBrowserUpdateInput,
    outputSchema: imageWithEntitySchema,
    request: options.request,
    run: async (context, input) => {
      const updated = await executeEntity(context, {
        action: "update",
        entity: "image",
        id: input.id,
        data: input.data,
      });
      if (updated.action !== "update") {
        throw new Error("Entity kernel returned the wrong action");
      }
      const detail = await executeEntity(context, {
        action: "get",
        entity: "image",
        id: input.id,
        missing: "error",
      });
      if (detail.action !== "get" || !detail.item) {
        throw new Error("Updated image could not be reloaded");
      }
      return detail.item;
    },
  });

export const deleteImages = async (options: {
  data: z.input<typeof imageBrowserDeleteInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "image.delete",
    type: "mutation",
    input: options.data,
    inputSchema: imageBrowserDeleteInput,
    outputSchema: imageBrowserDeleteOut,
    request: options.request,
    run: async (context, input) => {
      const result = await executeEntity(context, {
        action: "delete",
        entity: "image",
        ids: input.ids,
      });
      if (result.action !== "delete") {
        throw new Error("Entity kernel returned the wrong action");
      }
      return { deleted: result.deleted, sideEffects: result.sideEffects };
    },
  });

export const getProjectImageSummaries = async (options: {
  data: z.input<typeof projectImageSummariesInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "image.projectSummaries",
    type: "query",
    input: options.data,
    inputSchema: projectImageSummariesInput,
    outputSchema: projectImageSummariesOut,
    request: options.request,
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
