import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  allProblemsSchema,
  problemsCountSchema,
  problemsTypeSliceOut,
  problemsUnknownTypeOut,
  reparseStaleSyncOut,
} from "@cubby/schemas/mcp";
import { assembleAllProblems, countProblems } from "@cubby/schemas/problems";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type Caller,
  getCaller,
  READ_ONLY_CLOSED,
  registerMcpTool,
  WRITE_CLOSED,
} from "./_shared";

/**
 * The `projectAttentionItemSchema`-shaped keys inside `allProblemsSchema` —
 * the household-tracker detectors. Every row there carries only `entityId` (a
 * raw uuid); unlike the product/location/recipe/ingredient/inventory/vendor
 * problem rows (which already gained a `shortcode` sibling in the previous
 * cutover pass), this schema has no public-id field at all, so it has to be
 * resolved here rather than just dropped.
 */
const TRACKER_KEYS = [
  "overdueTasks",
  "stalledProjects",
  "projectsMissingBudget",
  "pastDuePlannedExpenses",
  "unclassifiedExpenses",
  "blockedWorkProjects",
  "projectsWithDateDrift",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every `<x>Id`/`<x>Shortcode` pair (including the bare `id`/`shortcode`
 * case) present on one row — the raw-uuid half is redundant once its public
 * sibling sits right next to it, which the previous cutover pass already made
 * true for nearly every detector row in packages/schemas/problems.ts.
 */
function redundantIdKeys(row: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (typeof row.id === "string" && typeof row.shortcode === "string") {
    keys.push("id");
  }
  // entityMissingEmbeddingSchema is the one row shaped {entityType, entityId,
  // shortcode} — its public field is spelled `shortcode`, not the
  // `entityShortcode` the generic suffix rule below looks for.
  if (
    typeof row.entityId === "string" &&
    typeof row.entityType === "string" &&
    typeof row.shortcode === "string"
  ) {
    keys.push("entityId");
  }
  for (const key of Object.keys(row)) {
    if (key === "id" || key === "entityId" || !key.endsWith("Id")) continue;
    const shortcodeKey = `${key.slice(0, -2)}Shortcode`;
    if (typeof row[shortcodeKey] === "string") keys.push(key);
  }
  return keys;
}

/**
 * Recursively drop every raw-uuid field a row also carries the public
 * shortcode for. The MCP-side half of the shortcode cutover for
 * `list_problems`: this tool republishes the router's/Problems page's own
 * schemas verbatim (see `registerRouterTool`'s doc comment on why that
 * bypasses the `slim*` projections other tools get), so the strip has to
 * happen here rather than upstream.
 *
 * Two known gaps this deliberately leaves alone (no sibling shortcode exists
 * to strip against, and inventing one would need entity-graph knowledge this
 * generic pass doesn't have): `orphanedEntityEmbeddings[].entityId` (the row
 * IS the orphan — the entity it names may no longer resolve at all) and
 * `referentialLivenessViolations[].targetId`/`sourceId` (the dangling side of
 * a bad FK, where `sourceTable` is a raw pgTable name, not always even a
 * shortcode entity — e.g. a join table). Both are dev/maintenance
 * diagnostics expected to sit at zero in production, not general entity
 * listings an agent would act on by id.
 */
function dropRedundantIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropRedundantIds);
  if (!isRecord(value)) return value;
  const drop = new Set(redundantIdKeys(value));
  const next: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (drop.has(key)) continue;
    next[key] = dropRedundantIds(val);
  }
  return next;
}

/**
 * Stamp an `entityShortcode` onto every tracker row (see `TRACKER_KEYS`) via
 * one batched reverse lookup, so `dropRedundantIds` above has a sibling to
 * drop the raw `entityId` against. Returns a shallow-patched copy.
 */
async function withTrackerShortcodes(
  caller: Caller,
  all: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const refs: Array<{ entity: ShortcodeEntity; id: string }> = [];
  for (const key of TRACKER_KEYS) {
    const rows = all[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (isRecord(row) && typeof row.entityId === "string") {
        refs.push({
          entity: row.entityType as ShortcodeEntity,
          id: row.entityId,
        });
      }
    }
  }
  if (refs.length === 0) return all;

  const resolved = await caller.shortcode.lookupMany({ refs });
  const codeByRef = new Map(
    resolved.map((r) => [`${r.entity}:${r.id}`, r.shortcode]),
  );

  const next = { ...all };
  for (const key of TRACKER_KEYS) {
    const rows = next[key];
    if (!Array.isArray(rows)) continue;
    next[key] = rows.map((row) =>
      isRecord(row) && typeof row.entityId === "string"
        ? {
            ...row,
            entityShortcode:
              codeByRef.get(`${row.entityType}:${row.entityId}`) ?? null,
          }
        : row,
    );
  }
  return next;
}

/**
 * MCP-local companion to `allProblemsSchema`: the same key set (every
 * detector array, plus `totalProblems`), but each row is a permissive record
 * rather than the router's own strict per-detector schema.
 *
 * Hand-mirroring 20+ per-detector row schemas from packages/schemas/
 * problems.ts (each `.omit()`-ted for the id-like fields `dropRedundantIds`
 * removes) isn't worth it here: `list_problems`'s outputSchema is already a
 * `z.union` the SDK can't turn into a precise JSON Schema anyway (see
 * `sdkOutputSchema`'s doc comment in _shared.ts — a non-ZodObject output
 * degrades to `{type:"object"}` for the advertised schema regardless), so no
 * client-visible advertisement gets worse by trading field-level precision
 * for a schema that actually validates the shortcode-only payload
 * `dropRedundantIds` produces. Derived from the real schema's key set so a
 * newly-added detector gets a slot automatically.
 */
const allProblemsMcpOut = z.object(
  Object.fromEntries(
    Object.entries(allProblemsSchema.shape).map(([key, schema]) => [
      key,
      key === "totalProblems"
        ? schema
        : z.array(z.record(z.string(), z.unknown())),
    ]),
  ),
);

export function registerProblemsTools(server: McpServer) {
  registerMcpTool(server, {
    name: "list_problems",
    description:
      "List data-quality problems across products, inventory, locations, and recipes, plus household-tracker items needing attention (overdue tasks, stalled/blocked projects, past-due planned expenses, missing budgets, unclassified expenses).",
    inputSchema: {
      countsOnly: z
        .boolean()
        .optional()
        .describe(
          "Return only per-type counts and a total, not the full lists",
        ),
      type: z
        .string()
        .optional()
        .describe(
          "Return only this problem category (e.g. 'orphanedProducts'). Ignored when countsOnly is true.",
        ),
    },
    outputSchema: z.union([
      problemsCountSchema,
      allProblemsMcpOut,
      problemsTypeSliceOut,
      problemsUnknownTypeOut,
    ]),
    annotations: READ_ONLY_CLOSED,
    handler: async (params, extra) => {
      const caller = getCaller(extra);
      const [fast, coverage, upc, tracker] = await Promise.all([
        caller.problems.getFast(),
        caller.problems.getCoverage(),
        caller.problems.getUpc(),
        caller.problems.getTracker(),
      ]);
      const all = assembleAllProblems({ fast, coverage, upc, tracker });
      if (params.countsOnly) {
        // Counts are just array lengths — no need to resolve shortcodes for
        // a response that skips the rows themselves.
        return countProblems(all);
      }
      const withShortcodes = await withTrackerShortcodes(
        caller,
        all as unknown as Record<string, unknown>,
      );
      const stripped = dropRedundantIds(withShortcodes) as Record<
        string,
        unknown
      >;
      if (typeof params.type === "string") {
        const slice = stripped[params.type];
        if (slice === undefined) {
          return {
            error: `Unknown problem type '${params.type}'`,
            availableTypes: Object.keys(all as Record<string, unknown>),
          };
        }
        return { type: params.type, items: slice };
      }
      return stripped;
    },
  });

  registerMcpTool(server, {
    name: "reparse_stale_parses",
    description:
      "Re-parse every recipe line whose stored parse has drifted from the current parser.",
    inputSchema: {},
    outputSchema: reparseStaleSyncOut,
    annotations: WRITE_CLOSED,
    handler: async (_params, extra) => {
      const caller = getCaller(extra);
      return caller.problems.reparseStaleSync();
    },
  });
}
