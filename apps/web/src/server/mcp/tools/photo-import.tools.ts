/**
 * Photo-inventory run MCP tools. The agent proposes item groups for a
 * `photo_inventory` `ImportRun` (`propose_photo_groups`); a household member
 * reviews and approves them on the run page, and approval runs the bounded
 * `commit_photo_group` writer, which also stays callable directly.
 */
import {
  importRunShortcode,
  ledgerPartyShortcode,
} from "@cubby/schemas/identifiers";
import {
  commitPhotoGroupInput,
  commitPhotoGroupOutput,
  listPhotoGroupProposalsInput,
  photoGroupProposalList,
  photoProductCandidateSearchInput,
  photoProductCandidatesResponse,
  photoRunContextImage,
  proposePhotoGroupsInput,
  proposePhotoGroupsOutput,
} from "@cubby/schemas/photo-import-run";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  listPhotoGroupProposals,
  listPhotoRunImages,
  proposePhotoGroups,
} from "~/server/photo-import-run/proposals";
import { commitPhotoGroup } from "~/server/photo-import-run/writer";
import { getImportRunByShortcode } from "~/server/repo/import-run";
import { findPhotoProductCandidates } from "~/server/repo/photo-product-candidates";

import { getEntityKernelContext } from "../kernel-context";
import { READ_ONLY_CLOSED, registerMcpTool, WRITE_CLOSED } from "./_shared";

/**
 * Every page stays in the coordinator's context for the rest of the run, so
 * a page and each photo's text are bounded: 100 photos (the native picker's
 * maximum) at these caps stay well inside the photo model's context window.
 */
const PHOTO_CONTEXT_PAGE_DEFAULT = 50;
const PHOTO_CONTEXT_PAGE_MAX = 100;
const DESCRIPTION_CHARS = 800;
const RECOGNIZED_TEXT_CHARS = 400;

const clip = (text: string | null, max: number) =>
  text && text.length > max ? `${text.slice(0, max)}…` : text;

export function registerPhotoImportTools(server: McpServer) {
  registerMcpTool(server, {
    name: "get_photo_run_context",
    description:
      "Read one photo-inventory run's owner, notes, and one page of its photos in shot order with their cloud descriptions and recognized text. Pass `nextCursor` back as `cursor` until it is null; an item photographed across a page boundary continues on the next page. Set `withImageUrls` only if you can open images. Use this before proposing groups.",
    inputSchema: z.object({
      runId: importRunShortcode,
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(PHOTO_CONTEXT_PAGE_MAX).optional(),
      withImageUrls: z.boolean().optional(),
    }),
    outputSchema: z.object({
      runId: importRunShortcode,
      ledgerPartyId: ledgerPartyShortcode,
      notes: z.string().nullable(),
      totalImages: z.number().int().nonnegative(),
      nextCursor: z.number().int().nonnegative().nullable(),
      images: z.array(photoRunContextImage),
    }),
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const db = getEntityKernelContext(extra).db;
      const run = await getImportRunByShortcode(db, params.runId);
      if (!run || run.purpose !== "photo_inventory" || !run.ledgerPartyId)
        throw new Error("Photo-inventory run and owner were not found");
      const all = await listPhotoRunImages(db, params.runId);
      const cursor = params.cursor ?? 0;
      const end = cursor + (params.limit ?? PHOTO_CONTEXT_PAGE_DEFAULT);
      return {
        runId: params.runId,
        ledgerPartyId: run.ledgerPartyId,
        notes: run.notes,
        totalImages: all.length,
        nextCursor: end < all.length ? end : null,
        images: all.slice(cursor, end).map((image) => {
          const summary: z.infer<typeof photoRunContextImage> = {
            id: image.id,
            position: image.position,
            targetState: image.targetState,
            describe: image.describe,
            description: clip(image.description, DESCRIPTION_CHARS),
            recognizedText: clip(image.recognizedText, RECOGNIZED_TEXT_CHARS),
          };
          if (params.withImageUrls) {
            summary.originalUrl = image.originalUrl;
            summary.cutoutUrl = image.cutoutUrl;
          }
          return summary;
        }),
      };
    },
  });

  registerMcpTool(server, {
    name: "suggest_photo_product_candidates",
    description:
      "Find existing Products for a photo group before proposing a new one. Returns read-only name/variant candidates and whether each has a purchase, own photo, earlier photo import, or inventory. Compare exact size and color yourself; the rank is not proof and human approval is required to attach photos.",
    inputSchema: photoProductCandidateSearchInput,
    outputSchema: photoProductCandidatesResponse,
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => ({
      candidates: await findPhotoProductCandidates(
        getEntityKernelContext(extra).db,
        params,
      ),
    }),
  });

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
