/**
 * Audit-trail MCP tools — the "what changed recently" read surface.
 * Thin wrapper over auditLog.list; every create/update/delete in the app
 * already writes here, so no new plumbing is needed to answer it.
 */

import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCaller, READ_ONLY_CLOSED, registerMcpTool } from "./_shared";

/**
 * `auditLogEntryOut.entityId` is the touched entity's raw uuid, with no
 * shortcode of its own — this tool republishes `auditLog.list`'s result
 * verbatim (see `registerRouterTool`'s doc comment on why that bypasses the
 * `slim*` projections other tools get), so the swap has to happen here.
 * `entityType` is always one of `auditableEntities`, which is exactly the
 * `shortcodeEntities` set (every entity but `usda-food`/`image` — see
 * entity-manifest.ts), so every row is resolvable via `shortcode.lookupMany`.
 *
 * The log row's own `id` is dropped rather than swapped: an audit-log entry
 * isn't itself a shortcode entity (no `get_audit_entry` tool exists to
 * address one by), and pagination here is cursor-based on `createdAt`, not
 * this id, so nothing needs it. `userId`/`user.id` are plain `z.string()`
 * (not `z.uuid()`) already — `User` has no shortcode at all (not in the
 * manifest's entity registry), so those were never uuid-shaped on the wire.
 */
const auditLogEntryMcpOut = auditLogListOut.shape.entries.element
  .omit({ id: true, entityId: true })
  .extend({ entityShortcode: z.string().nullable() });

const auditLogListMcpOut = auditLogListOut.omit({ entries: true }).extend({
  entries: z.array(auditLogEntryMcpOut),
});

export function registerAuditTools(server: McpServer) {
  registerMcpTool(server, {
    name: "get_recent_activity",
    description:
      'Recent changes across the app, newest first — the audit trail every create/update/delete writes to. Each entry has the entityType + entityShortcode touched, the action, a per-field `changes` map (from → to), who did it, the source (`ui`, `api` for MCP/programmatic writes, `epub_import`, `sheets_import`/`csv_import` on older migrated rows, or `script:<name>` for a one-off maintenance script), and createdAt. Filter by entityType and/or entityId to scope it to one entity\'s history; filter by `source` (one value or an array — e.g. `"script:home-depot-export-2026-07-28"`) to isolate what a specific import or maintenance script touched. NOTE: `source` matches EXACTLY, and `script:` is a naming convention rather than a wildcard — there is no prefix or glob matching, so to cover several scripts pass every slug explicitly as an array; filter by `createdAtFrom`/`createdAtTo` (inclusive ISO date-string bounds) to scope to a time window — these AND with cursor-based pagination rather than replacing it, so pass a window on its own for "what happened last Tuesday" without needing a cursor at all. Page with cursor (pass back the returned nextCursor). Use it to answer "what changed recently", "who edited this product", "what did that script touch", or to check what a previous bulk write actually did.',
    inputSchema: auditLogListInput.shape,
    outputSchema: auditLogListMcpOut,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.auditLog.list(params);

      const uniqueRefs = new Map<
        string,
        { entity: (typeof result.entries)[number]["entityType"]; id: string }
      >();
      for (const entry of result.entries) {
        uniqueRefs.set(`${entry.entityType}:${entry.entityId}`, {
          entity: entry.entityType,
          id: entry.entityId,
        });
      }
      const resolved = uniqueRefs.size
        ? await caller.shortcode.lookupMany({ refs: [...uniqueRefs.values()] })
        : [];
      const codeByRef = new Map(
        resolved.map((r) => [`${r.entity}:${r.id}`, r.shortcode]),
      );

      return {
        ...result,
        entries: result.entries.map(({ entityId, ...entry }) => ({
          ...entry,
          entityShortcode:
            codeByRef.get(`${entry.entityType}:${entityId}`) ?? null,
        })),
      };
    },
  });
}
