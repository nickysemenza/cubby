import {
  attachableImageEntity,
  attachFileFields,
  attachFileResponse,
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

const attachFileInputShape = {
  ...attachFileEntityless,
  entityId: attachFileEntityless.entityId.describe(
    `Shortcode of the target — its prefix picks the entity (${attachableImageEntity.options.join(", ")}).`,
  ),
};

const attachFileItem = z.object(attachFileInputShape);
type AttachFileItem = z.infer<typeof attachFileItem>;

const ATTACH_FILE_SOURCE_PROSE =
  "Provide the file as EITHER `data` (base64, or a data: URI) OR `url` " +
  "(an http(s) link to fetch) — exactly one. For base64, set `contentType` " +
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
 * A single `attach_file` tool routes base64 bytes or an external URL through the
 * server-side R2 upload pipeline and associates the result with a gallery
 * entity. Images and PDFs share one code path (a "document" is inferred from the
 * PDF content type). The browser's two-phase presigned flow isn't usable from a
 * JSON MCP client, so this is server-side PUT only.
 */
export function registerImageTools(server: McpServer) {
  registerMcpTool(server, {
    name: "attach_file",
    description:
      "Attach an image or PDF to a product, recipe, location, project, or " +
      "purchase (one vendor order/receipt event — this is how a receipt or an emailed PDF " +
      "invoice gets filed against the vendor event it documents). Purchase attachments require " +
      "documentKind; order_confirmation, sales_order, invoice, and receipt count as primary evidence. " +
      `${ATTACH_FILE_SOURCE_PROSE} Resolve the ` +
      "target shortcode first via search_products / list_recipes / list_locations / " +
      "list_projects; for a purchase use list_purchases / get_purchase, or read " +
      "`purchaseId` off any expense row (list_expenses / get_expense).",
    // `entityType` is dropped on purpose: a shortcode's prefix already names
    // the entity, so asking for both invites a mismatched pair. The handler
    // derives the type from the code and rejects a non-attachable one.
    inputSchema: attachFileInputShape,
    outputSchema: attachFileResponse,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => await attachOne(getCaller(extra), params),
  });

  registerBatchTool(server, {
    name: "attach_files",
    description:
      "Attach up to 50 files in request order. Each item carries its own entityId, so one call can " +
      "cover many different products/recipes/locations/projects/purchases — this is the cover-image " +
      `pass of an enrichment sweep. ${ATTACH_FILE_SOURCE_PROSE} A failed item does not roll back ` +
      "successful items; set idempotencyKey per item so a retry of a partially-failed batch cannot " +
      "double-attach the files that already landed.",
    itemInput: attachFileItem,
    itemOutput: attachFileResponse,
    annotations: WRITE_CLOSED,
    // Deliberately NOT rejectDuplicateIds: `entityId` is the target, not the
    // item's own identity, and attaching several files to one product in a
    // single call is the normal case (cover plus detail shots).
    run: attachOne,
  });
}
