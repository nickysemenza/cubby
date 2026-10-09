import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * workerd evaluates the Worker entry's whole static import graph at isolate
 * startup, so the web Worker defers work only at its entry points: each
 * `cf-server.ts` handler, `routes/api` handler, Durable Object, and Workflow
 * loads its implementation with one `import()`, and everything below that is
 * static. Below a boundary, an `import()` stays only for a heavy library that a
 * minority of the boundary's paths reach. This rule holds that allowlist;
 * type-only `import("x").T` and `typeof import("x")` are not import
 * expressions and stay allowed. docs/agents/domain-rules.md explains the rule.
 */

const BOUNDARY =
  "See docs/agents/domain-rules.md (lazy loading at Worker entry points).";

type Allowed = {
  /** Specifiers this file may load lazily; `"any"` admits a computed one. */
  readonly sources: readonly string[] | "any";
  readonly reason: string;
};

const ROUTE_ENTRY =
  "Route handler entry: route modules ship in the router chunk every SSR request loads.";

/** Keyed by the path below `apps/web/src/`. */
const ALLOWLIST = new Map(
  Object.entries({
    "cf-server.ts": {
      sources: [
        "@tanstack/react-start/server-entry",
        "./server/http-api",
        "./server/browser-operation-dispatch",
        "./server/calendar/client",
        "./server/image-processing/direct-socket-route",
        "./server/purchase-import/direct-socket-route",
        "./server/purchase-import/agent-services",
        "./server/telemetry-queue",
        "./server/background-tasks/consume",
        "./server/daily-maintenance",
      ],
      reason: "Worker entry: each fetch route, queue consumer and cron.",
    },
    "server/worker-entrypoints.ts": {
      sources: [
        "./ai/chatgpt/durable-object",
        "./calendar/durable-object",
        "./database-freshness/durable-object",
        "./image-processing/durable-object",
        "./purchase-import/durable-object",
        "./purchase-import/agent-host",
        "./usda-release/durable-object",
        "./search-index-repair-workflow",
        "./gmail-workflows",
      ],
      reason: "Durable Object and Workflow entry shells.",
    },
    "routes/api/browser/dispatch.ts": {
      sources: ["~/server/browser-operation-dispatch"],
      reason: ROUTE_ENTRY,
    },
    "routes/api/debug/usda-release.ts": {
      sources: [
        "~/server/clients/usda",
        "~/server/services/usda-link-advance.service",
      ],
      reason: ROUTE_ENTRY,
    },
    "routes/api/import/agent/oauth.callback.ts": {
      sources: [
        "~/server/purchase-import/run-service",
        "~/server/purchase-import/dispatch",
      ],
      reason: ROUTE_ENTRY,
    },
    "routes/api/import/agent/socket.ts": {
      sources: ["~/server/purchase-import/direct-socket-route"],
      reason: ROUTE_ENTRY,
    },
    "routes/api/import/evidence.ts": {
      sources: ["~/server/purchase-import/run-evidence"],
      reason: ROUTE_ENTRY,
    },
    "routes/api/import/runs.$publicId.agent.$.ts": {
      sources: [
        "~/server/purchase-import/run-service",
        "~/server/purchase-import/agent-proxy",
      ],
      reason: ROUTE_ENTRY,
    },
    "routes/api/import/runs.$publicId.agent.ts": {
      sources: ["~/server/purchase-import/agent-proxy"],
      reason: ROUTE_ENTRY,
    },
    "routes/api/mcp.ts": {
      sources: ["~/server/mcp/http-handler"],
      reason: ROUTE_ENTRY,
    },
    "routes/api/v1/$resource.ts": {
      sources: ["~/server/http-api"],
      reason: ROUTE_ENTRY,
    },
    "routes/api/v1/$resource/$operation.ts": {
      sources: ["~/server/http-api"],
      reason: ROUTE_ENTRY,
    },
    "routes/api/workflow-stream/$operation.ts": {
      sources: ["~/server/workflow-stream-dispatch.server"],
      reason: ROUTE_ENTRY,
    },
    "server/crud-services.ts": {
      sources: ["./request-services", "~/server/clients/notion"],
      reason:
        "Heavy libraries: domain services reach WASM and the Notion client its SDK; most requests use neither.",
    },
    "server/calendar/durable-object.ts": {
      sources: ["./postgres-backend"],
      reason:
        "Heavy library: the repository graph reaches WASM; only refreshes and writes need it, not CalDAV reads.",
    },
    "server/database-freshness/durable-object.ts": {
      sources: ["./problem-counts"],
      reason:
        "Heavy library: the WASM-backed detectors serve only the counts refresh.",
    },
    "server/operations/problems.server.ts": {
      sources: ["./problem-reports.server"],
      reason:
        "Heavy library: the detector graph reaches WASM; the homepage counts read ends at the Durable Object.",
    },
    "server/operations/problem-counts.server.ts": {
      sources: ["./problem-reports.server"],
      reason:
        "Heavy library: the detector graph loads only when the Durable Object has no counts.",
    },
    "server/purchase-import/durable-object.ts": {
      sources: ["./research-retention"],
      reason:
        "Heavy library: retirement reaches the repository graph and WASM; the broker's socket traffic does not.",
    },
    "server/purchase-import/gmail/ingest.ts": {
      sources: ["./triage-model"],
      reason:
        "Heavy library: the triage model (AI SDK) serves only messages that need it.",
    },
    "server/purchase-import/research-product.ts": {
      sources: ["./research-support"],
      reason:
        "Heavy library: the model assessor and its skill-rules prompt serve only proposals that need assessment.",
    },
    "server/purchase-import/research-import.ts": {
      sources: ["./research-support"],
      reason:
        "Heavy library: the model assessor and its skill-rules prompt serve only proposals that need assessment.",
    },
    "server/purchase-import/run-service.ts": {
      sources: ["~/server/agents/purchase-import/extract"],
      reason: "Heavy library: the extraction agent serves only batch audits.",
    },
    "server/mcp/apps/index.ts": {
      sources: ["@cubby/mcp-apps/dev"],
      reason: "Development only: Vitest reads the raw bundle without ASSETS.",
    },
    "server/tracing.ts": {
      sources: "any",
      reason:
        "`cloudflare:workers` resolves only on workerd; Node development skips it.",
    },
    "server/background-tasks/publish.ts": {
      sources: ["./handle"],
      reason:
        "Node development's inline transport: the handlers import the producers that publish, so a static import is a cycle.",
    },
    "server/repo/database-helpers/crud.ts": {
      sources: ["~/server/repo/image"],
      reason:
        "Cycle: image.ts evaluates relation config from this barrel at load (TODO: extract the detach path into a leaf).",
    },
  } satisfies Record<string, Allowed>),
);

/** The allowlist entry for this file, keyed by its path below `apps/web/src/`. */
function allowedFor(filename: string): Allowed | undefined {
  const marker = "/apps/web/src/";
  const index = filename.replaceAll("\\", "/").lastIndexOf(marker);
  if (index < 0) return;
  return ALLOWLIST.get(filename.slice(index + marker.length));
}

/** A quoted string literal's value (`"zod"` → zod). */
function staticSource(node: ESTree.Node | null | undefined) {
  if (node?.type !== "Literal" || node.raw === null) return;
  if (!node.raw.startsWith('"') && !node.raw.startsWith("'")) return;
  return String(node.value);
}

export const workerLazyImportBoundaryRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep import() in the web Worker to entry shells and justified heavy-library sites.",
    },
    messages: {
      notAllowed: `import("{{source}}") is below a Worker entry boundary, where imports are static: import it statically, break a cycle by extracting a leaf module, or inject a test double as a parameter. A heavy library a minority of paths reach goes in this rule's allowlist with its reason. ${BOUNDARY}`,
    },
  },
  createOnce(context) {
    return {
      ImportExpression(node) {
        const source = staticSource(node.source);
        const allowed = allowedFor(context.filename);
        if (
          allowed &&
          (allowed.sources === "any" ||
            (source !== undefined && allowed.sources.includes(source)))
        )
          return;
        context.report({
          node,
          messageId: "notAllowed",
          data: { source: source ?? "<computed>" },
        });
      },
    };
  },
});
