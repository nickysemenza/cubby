/**
 * Shortcode router — the public-id boundary for callers that don't hold a uuid.
 *
 * MCP speaks shortcodes end to end, but every domain router below it takes
 * uuids. Rather than teach ~98 tools to resolve one code at a time (or widen the
 * routers to accept both, which the cutover explicitly rejects), the MCP layer
 * translates once at its own boundary through this router.
 *
 * Batched on purpose: a bulk tool (`delete_products`, `bulk_move_tasks`) hands
 * over a whole array of codes, and a per-code round trip would turn one tool
 * call into N queries.
 */

import {
  type ShortcodeEntity,
  shortcodeEntities,
} from "@cubby/schemas/entity-manifest";
import { z } from "zod";
import {
  lookupShortcodes,
  refKey,
  resolveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const shortcodeEntityEnum = z.enum(
  shortcodeEntities as readonly [ShortcodeEntity, ...ShortcodeEntity[]],
);

const resolveManyInput = z.object({
  // Loose `z.string()`: the caller is asking "what is this?", so an unparseable
  // or unknown code must come back as a miss it can report, not a zod throw
  // that tells it nothing about which of the batch was bad.
  codes: z.array(z.string()).min(1).max(500),
});

const resolveManyOut = z.array(
  z.object({
    code: z.string(),
    entity: shortcodeEntityEnum,
    id: z.string(),
  }),
);

/**
 * Resolve public codes to `{ entity, id }`. Unresolvable codes are OMITTED
 * rather than returned as nulls — the caller diffs against its input to name
 * exactly which codes failed, which is what its error message needs.
 *
 * Resolution includes soft-deleted rows (that's `resolveShortcode`'s contract),
 * so a tool acting on a deleted row still gets a real id and fails downstream
 * with the domain's own error rather than a misleading "unknown code".
 */
const resolveMany = protectedProcedure
  .input(resolveManyInput)
  .output(resolveManyOut)
  .query(async ({ ctx, input }) => {
    const resolved = await resolveShortcodes(ctx.db, input.codes);
    return [...resolved].map(([code, ref]) => ({
      code,
      entity: ref.entity,
      id: ref.id,
    }));
  });

const entityRefInput = z.object({
  entity: shortcodeEntityEnum,
  id: z.string(),
});

const lookupManyInput = z.object({
  refs: z.array(entityRefInput).min(1).max(2000),
});

const lookupManyOut = z.array(
  z.object({
    entity: shortcodeEntityEnum,
    id: z.string(),
    shortcode: z.string().nullable(),
  }),
);

/**
 * The reverse of `resolveMany`: private uuid(s) → public shortcode, batched
 * per entity type via `lookupShortcodes`.
 *
 * Exists for the MCP output layer. A `registerRouterTool` tool republishes a
 * tRPC router's result verbatim, so any router output whose schema predates
 * the shortcode cutover (a raw FK id with no shortcode field of its own —
 * `expenseId` on a match candidate, `entityId` on a search/attention row, …)
 * has no shortcode already sitting next to it the way a `slim*`-projected
 * entity row does. This is that gap's one query, not a per-tool `getDb`
 * escape hatch — see `lookupShortcodes`'s own doc comment, which anticipates
 * exactly this caller.
 *
 * A ref with no resolvable row (bad id, or a soft-deleted row some other
 * lookup already dropped) comes back with `shortcode: null` rather than being
 * omitted, so a caller can zip the result back onto its input 1:1 by index.
 */
const lookupMany = protectedProcedure
  .input(lookupManyInput)
  .output(lookupManyOut)
  .query(async ({ ctx, input }) => {
    const codes = await lookupShortcodes(ctx.db, input.refs);
    return input.refs.map((ref) => ({
      entity: ref.entity,
      id: ref.id,
      shortcode: codes.get(refKey(ref.entity, ref.id)) ?? null,
    }));
  });

export const shortcodeRouter = createTRPCRouter({ resolveMany, lookupMany });
