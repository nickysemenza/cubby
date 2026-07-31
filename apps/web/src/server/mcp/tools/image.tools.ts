import { attachFileFields, attachFileResponse } from "@cubby/schemas/image";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCaller, registerMcpTool, WRITE_CLOSED } from "./_shared";

/**
 * `attachFileResponse.entityId` is the attached-to entity's raw uuid, with no
 * shortcode of its own — `attach_file` predates the shortcode cutover, and
 * this tool republishes the router's result verbatim (see
 * `registerRouterTool`'s doc comment on why that bypasses the `slim*`
 * projections other tools get), so the swap has to happen here rather than in
 * packages/schemas. `imageId` is a declared exception: images have no
 * shortcode of their own.
 */
const attachFileMcpOut = attachFileResponse
  .omit({ entityId: true })
  .extend({ entityShortcode: z.string().nullable() });

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
      "target id first via search_products / list_recipes / list_locations / " +
      "list_projects; for a charge use list_purchases / get_purchase, or read " +
      "`purchaseId` off any expense row (list_expenses / get_expense).",
    inputSchema: attachFileFields,
    outputSchema: attachFileMcpOut,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.image.attachFile(params);
      const [ref] = await caller.shortcode.lookupMany({
        refs: [{ entity: result.entityType, id: result.entityId }],
      });
      const { entityId: _entityId, ...rest } = result;
      return { ...rest, entityShortcode: ref?.shortcode ?? null };
    },
  });
}
