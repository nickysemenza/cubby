import {
  attachableImageEntity,
  attachFileFields,
  attachFileResponse,
} from "@cubby/schemas/image";
import { parseShortcode } from "@cubby/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCaller, registerMcpTool, WRITE_CLOSED } from "./_shared";

// `entityType` is derived from the shortcode's prefix, so it is not asked for.
const { entityType: _entityType, ...attachFileEntityless } = attachFileFields;

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
      "purchase (a vendor charge — this is how a receipt or an emailed PDF " +
      "invoice gets filed against the transaction it documents). " +
      "Provide the file as EITHER `data` (base64, or a data: URI) OR `url` " +
      "(an http(s) link to fetch) — exactly one. For base64, set `contentType` " +
      "(image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif, " +
      "or application/pdf) unless a data: URI already carries it. Resolve the " +
      "target shortcode first via search_products / list_recipes / list_locations / " +
      "list_projects; for a charge use list_purchases / get_purchase, or read " +
      "`purchaseId` off any expense row (list_expenses / get_expense).",
    // `entityType` is dropped on purpose: a shortcode's prefix already names
    // the entity, so asking for both invites a mismatched pair. The handler
    // derives the type from the code and rejects a non-attachable one.
    inputSchema: {
      ...attachFileEntityless,
      entityId: attachFileEntityless.entityId.describe(
        `Shortcode of the target — its prefix picks the entity (${attachableImageEntity.options.join(", ")}).`,
      ),
    },
    outputSchema: attachFileResponse,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const parsed = parseShortcode(params.entityId as string);
      const attachable = attachableImageEntity.safeParse(parsed?.type);
      if (!attachable.success) {
        throw new Error(
          `${params.entityId} names a ${parsed?.type ?? "unknown"}; files attach to a ${attachableImageEntity.options.join(", ")}.`,
        );
      }
      const entityType = attachable.data;
      return await caller.image.attachFile({
        ...params,
        entityType,
      });
    },
  });
}
