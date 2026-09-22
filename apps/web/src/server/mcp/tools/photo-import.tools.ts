/**
 * Photo-inventory run MCP tools — commits one group of photographed items
 * from a `photo_inventory` `ImportRun` into a Product, its gallery
 * attachments, and (optionally) one Inventory entry.
 */
import {
  commitPhotoGroupInput,
  commitPhotoGroupOutput,
} from "@cubby/schemas/photo-import-run";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { commitPhotoGroup } from "~/server/photo-import-run/writer";

import { getEntityKernelContext } from "../kernel-context";
import { registerMcpTool, WRITE_CLOSED } from "./_shared";

export function registerPhotoImportTools(server: McpServer) {
  registerMcpTool(server, {
    name: "commit_photo_group",
    description:
      'Bounded writer for a photo-inventory run: turns one caller-defined group of already-staged images into one Product (an existing Product by id, or a genuinely new one) with each image attached under an `item` or `label` purpose, and optionally one Inventory entry. Idempotent per (runId, groupKey) — retrying the exact same call replays the prior result instead of writing again; retrying with a changed payload under the same groupKey is refused. When a `create` name or alias exactly (case-insensitively) matches a live Product, nothing is written and the call returns `outcome: "conflict"` with the colliding Product ids as data — never a speculative new Product. On an inconclusive match, choose the existing Product\'s id or pick a distinctly different name; this tool never guesses. Every listed image must already be a `pending` target of the run and must appear in exactly one of `images` (attach) or `skip` (leave unattached, with a reason). Marks the run `completed` once no `pending` target remains.',
    inputSchema: commitPhotoGroupInput,
    outputSchema: commitPhotoGroupOutput,
    annotations: WRITE_CLOSED,
    purchaseAgentMutationHandled: true,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return commitPhotoGroup(context.db, params, context.actorContext);
    },
  });
}
