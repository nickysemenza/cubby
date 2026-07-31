/** Audit-trail MCP tools — the "what changed recently" read surface. */

import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCaller, READ_ONLY_CLOSED, registerMcpTool } from "./_shared";

export function registerAuditTools(server: McpServer) {
  registerMcpTool(server, {
    name: "get_recent_activity",
    description:
      'Recent changes across the app, newest first — the audit trail every create/update/delete writes to. Each entry has the entityType + public shortcode entityId touched, the action, a per-field `changes` map (from → to), who did it, the source (`ui`, `api` for MCP/programmatic writes, `epub_import`, `sheets_import`/`csv_import` on older migrated rows, or `script:<name>` for a one-off maintenance script), and createdAt. Filter by entityType and/or entityId to scope it to one entity\'s history; filter by `source` (one value or an array — e.g. `"script:home-depot-export-2026-07-28"`) to isolate what a specific import or maintenance script touched. NOTE: `source` matches EXACTLY, and `script:` is a naming convention rather than a wildcard — there is no prefix or glob matching, so to cover several scripts pass every slug explicitly as an array; filter by `createdAtFrom`/`createdAtTo` (inclusive ISO date-string bounds) to scope it to a time window — these AND with cursor-based pagination rather than replacing it, so pass a window on its own for "what happened last Tuesday" without needing a cursor at all. Page with cursor (pass back the returned nextCursor). Use it to answer "what changed recently", "who edited this product", "what did that script touch", or to check what a previous bulk write actually did.',
    inputSchema: auditLogListInput.shape,
    outputSchema: auditLogListOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      return caller.auditLog.list(params);
    },
  });
}
