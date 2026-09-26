import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";

import { defineContract, query } from "~/contracts/define";

export const auditLogContract = defineContract("auditLog", {
  list: query({
    mcp: {
      name: "get_recent_activity",
      description:
        'Recent changes across the app, newest first — the audit trail every create/update/delete writes to. Each entry has the entityType + public shortcode entityId touched, the action, a per-field `changes` map (from → to), who did it (`user`), how the write arrived (`channel`: `web`, `api` for API keys and the Apple app, `mcp`, `caldav`, or `system` for crons and retries with no user present), the MCP OAuth client (`oauthClient`, e.g. Claude or ChatGPT), the Apple install (`device`), the Run it belonged to (`runId`, a RUN- shortcode), and createdAt. Filter by entityType and/or entityId to scope it to one entity\'s history; by `channel` (one value or an array), `oauthClient`, `deviceId` (DEV-) or `runId` (RUN-) to isolate what one client, install, import or agent run touched; by `createdAtFrom`/`createdAtTo` (inclusive ISO date-string bounds) to scope it to a time window — these AND with cursor-based pagination rather than replacing it, so pass a window on its own for "what happened last Tuesday" without needing a cursor at all. Page with cursor (pass back the returned nextCursor). Use it to answer "what changed recently", "who edited this product", "what did that run touch", or to check what a previous bulk write actually did.',
    },
    input: auditLogListInput,
    output: auditLogListOut,
    native: "Native recent activity and audit history",
  }),
});
