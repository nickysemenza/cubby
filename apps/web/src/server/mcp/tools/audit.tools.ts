/**
 * Audit-trail MCP tools — the "what changed recently" read surface.
 * Thin wrapper over auditLog.list; every create/update/delete in the app
 * already writes here, so no new plumbing is needed to answer it.
 */

import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_CLOSED, registerRouterTool } from "./_shared";

export function registerAuditTools(server: McpServer) {
  registerRouterTool(server, {
    name: "get_recent_activity",
    description:
      'Recent changes across the app, newest first — the audit trail every create/update/delete writes to. Each entry has the entityType + entityId touched, the action, a per-field `changes` map (from → to), who did it, the source (ui/mcp/background/…), and createdAt. Filter by entityType and/or entityId to scope it to one entity\'s history; page with cursor (pass back the returned nextCursor). Use it to answer "what changed recently", "who edited this product", or to check what a previous bulk write actually did.',
    inputSchema: auditLogListInput.shape,
    outputSchema: auditLogListOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.auditLog.list(params),
  });
}
