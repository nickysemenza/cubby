/**
 * Photo-inventory run MCP tools. The agent proposes item groups for a
 * `photo_inventory` `ImportRun` (`propose_photo_groups`); a household member
 * reviews and approves them on the run page, and approval runs the bounded
 * `commit_photo_group` writer, which also stays callable directly.
 */
import {
  commitPhotoGroupInput,
  commitPhotoGroupOutput,
  listPhotoGroupProposalsInput,
  photoGroupProposalList,
  proposePhotoGroupsInput,
  proposePhotoGroupsOutput,
} from "@cubby/schemas/photo-import-run";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  listPhotoGroupProposals,
  proposePhotoGroups,
} from "~/server/photo-import-run/proposals";
import { commitPhotoGroup } from "~/server/photo-import-run/writer";

import { getEntityKernelContext } from "../kernel-context";
import { READ_ONLY_CLOSED, registerMcpTool, WRITE_CLOSED } from "./_shared";

export function registerPhotoImportTools(server: McpServer) {
  registerMcpTool(server, {
    name: "propose_photo_groups",
    description:
      "Propose how a photo-inventory run's images group into items, for a human to review and approve on the run page — nothing is written to Products or Inventory until approval, which runs `commit_photo_group` with each group's payload. Each group has the same shape as `commit_photo_group` (minus runId) plus optional `evidence` (why these photos are one item, and why this Product). Upserts by groupKey: a group whose groupKey is still `proposed` is replaced; a groupKey that is already `committed` or `discarded` is left untouched and returned in `frozenGroupKeys`. `removeGroupKeys` drops proposed groups. Every image must be a `pending` target of the run and, across the run's proposed groups after this call, appear in exactly one group (attached or skipped) — otherwise the whole call is refused. Returns every proposal plus the pending images no proposed group mentions yet.",
    inputSchema: proposePhotoGroupsInput,
    outputSchema: proposePhotoGroupsOutput,
    annotations: WRITE_CLOSED,
    purchaseAgentMutationHandled: true,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return proposePhotoGroups(context.db, params);
    },
  });

  registerMcpTool(server, {
    name: "list_photo_group_proposals",
    description:
      "Read a photo-inventory run's proposed, committed and discarded item groups, including any name-collision `conflict` or `lastError` from a failed approval, and the pending images no proposed group mentions yet.",
    inputSchema: listPhotoGroupProposalsInput,
    outputSchema: photoGroupProposalList,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return listPhotoGroupProposals(context.db, params.runId);
    },
  });

  registerMcpTool(server, {
    name: "commit_photo_group",
    description:
      'Bounded writer for a photo-inventory run — what approving a proposed group runs. Prefer `propose_photo_groups` and let the user approve on the run page; call this directly only when the user explicitly asks to skip review. Turns one caller-defined group of already-staged images into one Product (an existing Product by id, or a genuinely new one) with each image attached under an `item` or `label` purpose, and optionally one Inventory entry. Idempotent per (runId, groupKey) — retrying the exact same call replays the prior result instead of writing again; retrying with a changed payload under the same groupKey is refused unless the earlier attempt failed. When a `create` name or alias exactly (case-insensitively) matches a live Product, nothing is written and the call returns `outcome: "conflict"` with the colliding Product ids as data — never a speculative new Product. On an inconclusive match, choose the existing Product\'s id or pick a distinctly different name; this tool never guesses. Every listed image must already be a `pending` target of the run and must appear in exactly one of `images` (attach) or `skip` (leave unattached, with a reason); a skip-only group touches no Product. Marks the run `completed` once no `pending` target remains.',
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
