import {
  attachableImageEntity,
  attachFileFields,
  attachFileResponse,
  createFileUploadInput,
  createFileUploadResponse,
  imageAttachExistingInput,
  imageAttachExistingOutput,
} from "@cubby/schemas/image";
import { parseShortcode } from "@cubby/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  attachExistingImageWorkflow,
  attachFileWorkflow,
  createFileUploadWorkflow,
} from "~/server/workflows/image.server";

import {
  getRequestContext,
  registerBatchTool,
  registerRouterTool,
  type ToolExtra,
  WRITE_CLOSED,
} from "./_shared";

// `entityType` is derived from the shortcode's prefix, so it is not asked for.
const {
  entityType: _entityType,
  data: _data,
  ...attachFileEntityless
} = attachFileFields;

const attachFileInputFields = {
  ...attachFileEntityless,
  entityId: attachFileEntityless.entityId.describe(
    `Shortcode of the target — its prefix picks the entity (${attachableImageEntity.options.join(", ")}).`,
  ),
  url: attachFileEntityless.url.describe(
    "External http(s) URL the server fetches. Provide exactly one of `url` or `uploadId`.",
  ),
  uploadId: attachFileEntityless.uploadId.describe(
    "`IMG-` code returned by create_file_uploads after its presigned PUT succeeded. Provide exactly one of `url` or `uploadId`.",
  ),
  contentType: attachFileEntityless.contentType.describe(
    "Optional expected MIME type for a URL attachment; a conflicting response Content-Type is rejected.",
  ),
};

const attachFileItem = z
  .object(attachFileInputFields)
  .superRefine((value, ctx) => {
    const sources = [value.url, value.uploadId].filter(Boolean);
    if (sources.length !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of `url` or `uploadId`",
      });
    }
    if (
      value.purpose !== undefined &&
      parseShortcode(value.entityId)?.type !== "product"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["purpose"],
        message: "purpose is only supported for Product attachments",
      });
    }
  });
type AttachFileItem = z.infer<typeof attachFileItem>;

const attachExistingItem = imageAttachExistingInput;

const ATTACH_FILE_SOURCE_PROSE =
  "Provide the file exactly one of two ways: `url` (an http(s) link the server " +
  "fetches) or `uploadId` (from create_file_uploads — the route for a file on " +
  "local disk).";

export const IMAGE_TOOL_NAMES = {
  createFileUploads: "create_file_uploads",
  attachFiles: "attach_files",
  attachExistingImage: "attach_existing_image",
} as const;

/**
 * Attach one file, deriving the target entity from its shortcode prefix.
 *
 * Kept separate from the batch adapter so the prefix check and `entityType`
 * derivation remain one per-item operation with an indexed runtime outcome.
 */
async function attachOne(params: AttachFileItem, extra: ToolExtra) {
  const parsed = parseShortcode(params.entityId);
  const attachable = attachableImageEntity.safeParse(parsed?.type);
  if (!attachable.success) {
    throw new Error(
      `${params.entityId} names a ${parsed?.type ?? "unknown"}; files attach to a ${attachableImageEntity.options.join(", ")}.`,
    );
  }
  return await attachFileWorkflow(getRequestContext(extra).db, {
    ...params,
    entityType: attachable.data,
  });
}

/**
 * Image/document attachment tools.
 *
 * `attach_files` routes bytes through the server-side R2 upload pipeline and
 * associates the result with a gallery entity. Images and PDFs share one code
 * path (a "document" is inferred from the PDF content type).
 *
 * A local file cannot be named by a URL from the remote server. The
 * `create_file_uploads` batch exposes the browser's two-phase presigned flow,
 * so the client PUTs bytes straight to R2 and `attach_files` consumes each
 * resulting `uploadId` without carrying base64 through MCP.
 */
export function registerImageTools(server: McpServer) {
  registerBatchTool(server, {
    name: IMAGE_TOOL_NAMES.createFileUploads,
    description:
      "Stage up to 50 LOCAL files in request order and get one presigned PUT URL per successful item. This is how files on disk reach Cubby: the server is remote, so `url` cannot name a local path. Three steps: call this batch, upload each successful item with " +
      "`curl -X PUT -H 'Content-Type: <contentType>' --upload-file <path> '<uploadUrl>'`, " +
      "then call attach_files with the returned uploadIds. A failed item does not roll back successful presigns; results preserve input indexes for retrying only failures. No R2 staging, wrangler, or manual cleanup — each staged object is discarded once attached. Supported types: image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif, application/pdf.",
    itemInputSchema: createFileUploadInput,
    itemOutputSchema: createFileUploadResponse,
    projectReference: (item) => item.uploadId,
    defaultResultDetail: "full",
    annotations: WRITE_CLOSED,
    run: async (item, extra) =>
      await createFileUploadWorkflow(getRequestContext(extra).db, item),
  });

  registerRouterTool(server, {
    name: IMAGE_TOOL_NAMES.attachExistingImage,
    description:
      `Attach an existing uploaded image to a live gallery record. The image is not re-uploaded; ` +
      `the target shortcode prefix must name one of ${attachableImageEntity.options.join(", ")}. ` +
      "Repeated requests are idempotent and restore a previously soft-deleted link.",
    inputSchema: attachExistingItem,
    outputSchema: imageAttachExistingOutput,
    annotations: WRITE_CLOSED,
    telemetryEntity: (params) => parseShortcode(params.targetId)?.type,
    call: async (context, params) => {
      const parsed = parseShortcode(params.targetId);
      const attachable = attachableImageEntity.safeParse(parsed?.type);
      if (!attachable.success) {
        throw new Error(
          `${params.targetId} is not a gallery attachment target; expected ${attachableImageEntity.options.join(", ")}.`,
        );
      }
      return await attachExistingImageWorkflow(
        context.db,
        context.actorContext,
        params,
      );
    },
  });

  registerBatchTool(server, {
    name: IMAGE_TOOL_NAMES.attachFiles,
    description:
      `Attach up to 50 files in request order. Each item carries its own entityId, so one call can ` +
      `cover many different ${attachableImageEntity.options.join("/")} records — this is the cover-image ` +
      `pass of an enrichment sweep. ${ATTACH_FILE_SOURCE_PROSE} A failed item does not roll back ` +
      "successful items; set idempotencyKey per item so a retry of a partially-failed batch cannot " +
      "double-attach the files that already landed.",
    itemInputSchema: attachFileItem,
    itemOutputSchema: attachFileResponse,
    projectReference: (item) => item.imageId,
    // `full` rather than the compact default: an attach response is seven short
    // fields, not a hydrated entity, and `reused` exists precisely so a caller
    // can tell a replay from an upload — summarizing it away would undo that.
    defaultResultDetail: "full",
    annotations: WRITE_CLOSED,
    // Deliberately NOT rejectDuplicateIds: `entityId` is the target, not the
    // item's own identity, and attaching several files to one product in a
    // single call is the normal case (cover plus detail shots).
    //
    // Telemetry attributes the batch to its FIRST item's entity. A batch is
    // free to mix entities, so this is deliberately approximate — one row per
    // call has nowhere to put a set. First-item attribution beats null for the
    // common single-entity sweep; a mixed batch under-reports the rest.
    telemetryEntity: (params) =>
      params.items.length > 0
        ? parseShortcode(params.items[0]!.entityId)?.type
        : undefined,
    run: attachOne,
  });
}
