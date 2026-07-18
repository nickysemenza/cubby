import { attachFileFields, attachFileResponse } from "@cubby/schemas/image";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCaller, registerMcpTool, WRITE_CLOSED } from "./_shared";

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
      "Attach an image or PDF to a product, recipe, location, or project. " +
      "Provide the file as EITHER `data` (base64, or a data: URI) OR `url` " +
      "(an http(s) link to fetch) — exactly one. For base64, set `contentType` " +
      "(image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif, " +
      "or application/pdf) unless a data: URI already carries it. Resolve the " +
      "target id first via search_products / list_recipes / list_locations / " +
      "list_projects.",
    inputSchema: attachFileFields,
    outputSchema: attachFileResponse,
    annotations: WRITE_CLOSED,
    handler: async (params, extra) => getCaller(extra).image.attachFile(params),
  });
}
