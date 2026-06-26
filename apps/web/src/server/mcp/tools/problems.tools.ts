import { assembleAllProblems, countProblems } from "@cubby/schemas/problems";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCaller, json, withErrorHandling } from "./_shared";

export function registerProblemsTools(server: McpServer) {
  server.tool(
    "list_problems",
    "List data-quality problems across products, inventory, locations, and recipes (e.g. duplicates, invalid UPCs, orphaned products, stale prices, partial unit coverage). Use countsOnly for cheap triage, or type to fetch a single category. (Stale ingredient parses and unused aliases are NOT included here — they're manual Settings → Maintenance actions.)",
    {
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
          "Return only this problem category (e.g. 'orphanedProducts', 'productsWithNoImages'). Ignored when countsOnly is true.",
        ),
    },
    withErrorHandling(async (params, extra) => {
      const caller = getCaller(extra);
      // Compose from the three cost-grouped procedures (the monolithic
      // getAllProblems was removed; the two WASM parse-sweeps moved to Settings →
      // Maintenance). These run in-process via the caller, so the assembled
      // result matches what the combined scan returned.
      const [fast, coverage, upc] = await Promise.all([
        caller.problems.getFast(),
        caller.problems.getCoverage(),
        caller.problems.getUpc(),
      ]);
      const all = assembleAllProblems({ fast, coverage, upc });
      if (params.countsOnly) {
        return json(countProblems(all));
      }
      if (typeof params.type === "string") {
        const slice = (all as Record<string, unknown>)[params.type];
        if (slice === undefined) {
          return json({
            error: `Unknown problem type '${params.type}'`,
            availableTypes: Object.keys(all as Record<string, unknown>),
          });
        }
        return json({ [params.type]: slice });
      }
      return json(all);
    }),
  );

  server.tool(
    "reparse_stale_parses",
    "Re-parse every recipe line whose stored parse has drifted from the current parser, persisting the fresh name/amounts/modifier. Name drift re-resolves the line to an ingredient by name OR ALIAS (case-insensitive), so this is the recovery primitive after a mis-merge: once the correct ingredient carries the right alias, re-parsing re-points the affected lines onto it (and leaves correctly-linked lines untouched). Idempotent — a second run finds nothing. Affected recipes' totals are recomputed off the request path. Returns { updated, recipesAffected }.",
    {},
    withErrorHandling(async (_params, extra) => {
      const caller = getCaller(extra);
      const result = await caller.problems.reparseStaleSync();
      return json(result);
    }),
  );
}
