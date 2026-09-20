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
  type Caller,
  getCaller,
  registerBatchTool,
  registerMcpTool,
  WRITE_CLOSED,
} from "./_shared";

// `entityType` is derived from the shortcode's prefix, so it is not asked for.
const { entityType: _entityType, ...attachFileEntityless } = attachFileFields;

const attachFileInputFields = {
  ...attachFileEntityless,
  entityId: attachFileEntityless.entityId.describe(
    `Shortcode of the target — its prefix picks the entity (${attachableImageEntity.options.join(", ")}).`,
  ),
};

const attachFileItem = z.object(attachFileInputFields);
type AttachFileItem = z.infer<typeof attachFileItem>;

const attachExistingItem = imageAttachExistingInput;

const ATTACH_FILE_SOURCE_PROSE =
  "Provide the file exactly one of three ways: `url` (an http(s) link the server " +
  "fetches), `uploadId` (from create_file_upload — the ONLY route for a file on " +
  "local disk), or `data` (base64, or a data: URI; avoid at photo sizes, it costs " +
  "tens of thousands of tokens per image). For base64, set `contentType` " +
  "(image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif, " +
  "or application/pdf) unless a data: URI already carries it.";

/**
 * Attach one file, deriving the target entity from its shortcode prefix.
 *
 * Shared by `attach_file` and `attach_files` so the prefix check and the
 * `entityType` derivation cannot drift between the singular and plural forms.
 */
async function attachOne(caller: Caller, params: AttachFileItem) {
  const parsed = parseShortcode(params.entityId);
  const attachable = attachableImageEntity.safeParse(parsed?.type);
  if (!attachable.success) {
    throw new Error(
      `${params.entityId} names a ${parsed?.type ?? "unknown"}; files attach to a ${attachableImageEntity.options.join(", ")}.`,
    );
  }
  return await caller.image.attachFile({
    ...params,
    entityType: attachable.data,
  });
}

/**
 * Image/document attachment tools.
 *
 * `attach_file` routes bytes through the server-side R2 upload pipeline and
 * associates the result with a gallery entity. Images and PDFs share one code
 * path (a "document" is inferred from the PDF content type).
 *
 * Three input modes, and the third is why this file grew: `data` (base64) and
 * `url` are both server-side, which left a file on local disk with no route at
 * all — the server is remote, so no URL names it, and base64 costs ~82k tokens
 * for one photo. `create_file_upload` exposes the same two-phase presigned flow
 * the browser has always used, so the client PUTs the bytes straight to R2 and
 * `attach_file` takes the resulting `uploadId`.
 */
export function registerImageTools(server: McpServer) {
  registerMcpTool(server, {
    name: "create_file_upload",
    description:
      "Stage a LOCAL file for attachment and get a presigned PUT URL back. This is how a file on disk reaches Cubby: the server is remote, so `url` cannot name a local path, and base64 `data` costs tens of thousands of tokens per photo. Three steps: call this, upload the bytes with " +
      "`curl -X PUT -H 'Content-Type: <contentType>' --upload-file <path> '<uploadUrl>'`, " +
      "then call attach_file with the returned uploadId. No R2 staging, wrangler, or manual cleanup — the staged object is discarded once attached. Supported types: image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif, application/pdf.",
    inputSchema: createFileUploadInput,
    outputSchema: createFileUploadResponse,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) =>
      await getCaller(extra).image.createFileUpload(params),
  });

  registerMcpTool(server, {
    name: "attach_existing_image",
    description:
      `Attach an existing uploaded image to a live gallery record. The image is not re-uploaded; ` +
      `the target shortcode prefix must name one of ${attachableImageEntity.options.join(", ")}. ` +
      "Repeated requests are idempotent and restore a previously soft-deleted link.",
    inputSchema: attachExistingItem,
    outputSchema: imageAttachExistingOutput,
    annotations: WRITE_CLOSED,
    telemetryEntity: (params) => parseShortcode(params.targetId)?.type,
    handler: async (params, extra) => {
      const parsed = parseShortcode(params.targetId);
      const attachable = attachableImageEntity.safeParse(parsed?.type);
      if (!attachable.success) {
        throw new Error(
          `${params.targetId} is not a gallery attachment target; expected ${attachableImageEntity.options.join(", ")}.`,
        );
      }
      return await getCaller(extra).image.attachExisting(params);
    },
  });

  registerMcpTool(server, {
    name: "attach_file",
    description:
      `Attach an image or PDF to one of ${attachableImageEntity.options.join(", ")}. ` +
      "A Purchase is one vendor order/receipt event — this is how a receipt or an emailed PDF " +
      "invoice gets filed against the vendor event it documents). Purchase attachments require " +
      "documentKind; order_confirmation, sales_order, invoice, and receipt count as primary evidence. " +
      `${ATTACH_FILE_SOURCE_PROSE} Resolve the ` +
      "target shortcode first using the corresponding entity tools. " +
      "`reused: true` in the response means the idempotencyKey matched a file that is " +
      "still attached and nothing was uploaded; `false` means this call stored bytes.",
    // `entityType` is dropped on purpose: a shortcode's prefix already names
    // the entity, so asking for both invites a mismatched pair. The handler
    // derives the type from the code and rejects a non-attachable one.
    inputSchema: attachFileItem,
    outputSchema: attachFileResponse,
    annotations: WRITE_CLOSED,
    // The attachment target, for `McpToolCall.entity`. Derived from the
    // shortcode prefix for the same reason `entityType` is not an input: the
    // code already names the entity. This tool is ~18% of all MCP traffic, so
    // leaving it unattributed would hollow out the usage dashboard on its own.
    telemetryEntity: (params) => parseShortcode(params.entityId)?.type,
    handler: async (params, extra) => await attachOne(getCaller(extra), params),
  });

  registerBatchTool(server, {
    name: "attach_files",
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
