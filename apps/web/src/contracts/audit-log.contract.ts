import { auditLogListInput, auditLogListOut } from "@cubby/schemas/audit";

import { defineContract, query } from "~/contracts/define";

export const auditLogContract = defineContract(
  "auditLog",
  {
    // Audit activity reads live and bypasses the freshness RPC before PostgreSQL.
    list: query({
      description:
        'Recent changes across the app, newest first — the audit trail every create/update/delete writes. Each entry has the entityKind + public shortcode entityId touched, the action, a per-field `changes` map (from → to), who did it (`user`), how the write arrived (`channel`: `web`, `api` for API keys and the Apple app, `mcp`, `caldav`, or `system` for crons and retries), the MCP OAuth client (`oauthClient`), the Apple install (`device`), the Run it belonged to (`runId`, a RUN- shortcode), and createdAt. Filter by entityKind and/or entityId for one entity\'s history; by `channel` (one value or an array), `oauthClient`, `deviceId` (DEV-) or `runId` (RUN-) to isolate what one client, install, import or agent run touched; by `createdAtFrom`/`createdAtTo` (inclusive ISO date-string bounds) for a time window — these AND with cursor pagination, so pass a window on its own for "what happened last Tuesday". Page with cursor (pass back nextCursor).',
      readPolicy: "strong",
      input: auditLogListInput,
      output: auditLogListOut,
      native: "Native recent activity and audit history",
    }),
  },
  { exposure: "capability", mcpToolGroup: "activity" },
);
