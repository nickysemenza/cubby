/**
 * The purchase agent's host: the exported Durable Object and the narrowed
 * environment that is the agent's only view of this Worker.
 *
 * The agent (`server/purchase-agent/`) reads untrusted vendor pages, mail, and
 * photos. It receives no `env`, database, binding, or secret — only
 * `purchaseAgentEnvironment` below, whose services are bound to one Run — and
 * the `cubby/purchase-agent-boundary` lint rule keeps its directory from
 * importing anything that could reach them.
 *
 * Its runtime (Agents SDK, pi, MCP client, ~1.5 MB) stays off every page
 * request: this module is on the Worker entry's static graph, so it holds only
 * a shell that loads the agent on its first event.
 */
import * as Sentry from "@sentry/cloudflare";
import { DurableObject } from "cloudflare:workers";

import type {
  DispatchInput,
  PurchaseAgentEnvironment,
  PurchaseImportRunAgentRpc,
} from "~/server/purchase-agent/environment";

import { CF_AIG_GATEWAY_ID } from "../cf-env";
import { workerSentryOptions } from "../worker-sentry";
import { purchaseAgentMcpTools, runServicesFor } from "./agent-services";

type HostContext = { waitUntil(promise: Promise<unknown>): void };

/** The agent's whole environment, built from this Worker's bindings. */
export function purchaseAgentEnvironment(
  env: Env,
  ctx: HostContext,
): PurchaseAgentEnvironment {
  // SAFETY: the workerd harness adds this service binding to the Worker; it
  // is deliberately absent from wrangler.jsonc, so production never has it.
  const { CUBBY_PURCHASE_AGENT_TEST_MODEL: testModel } = env as Env & {
    CUBBY_PURCHASE_AGENT_TEST_MODEL?: PurchaseAgentEnvironment["testModel"];
  };
  return {
    gateway: () => {
      const gateway = env.AI.gateway(CF_AIG_GATEWAY_ID);
      return {
        id: CF_AIG_GATEWAY_ID,
        run: (data, options) => gateway.run(data, options),
      };
    },
    run: (runId) => runServicesFor(env, ctx, runId),
    mcpTools: purchaseAgentMcpTools,
    coordinator: (agentId) => env.PURCHASE_IMPORT_RUN.getByName(agentId),
    ...(testModel && { testModel }),
  };
}

type RunAgent =
  import("~/server/purchase-agent/run-agent").PurchaseImportRunAgent;

/**
 * One import Run's coordinator Durable Object. Every entry point loads the
 * agent (once per instance) and forwards to it; the agent's Lifecycle jobs
 * wake it through `alarm`.
 */
class PurchaseImportRunAgentHost
  extends DurableObject<Env>
  implements PurchaseImportRunAgentRpc
{
  private agent: Promise<RunAgent> | undefined;

  private started(): Promise<RunAgent> {
    this.agent ??= import("~/server/purchase-agent/run-agent")
      .then(async ({ PurchaseImportRunAgent }) => {
        const agent = new PurchaseImportRunAgent(
          this.ctx,
          purchaseAgentEnvironment(this.env, this.ctx),
        );
        await agent.__unsafe_ensureInitialized();
        return agent;
      })
      .catch((error) => {
        this.agent = undefined;
        throw error;
      });
    return this.agent;
  }

  async fetch(request: Request): Promise<Response> {
    return (await this.started()).fetch(request);
  }

  async alarm(): Promise<void> {
    await (await this.started()).alarm();
  }

  async dispatch(input: DispatchInput): Promise<{ accepted: boolean }> {
    return (await this.started()).dispatch(input);
  }
}

// The Worker's own Sentry configuration (`withSentry` in cf-server.ts covers
// the queue consumer); the tag separates the agent's issues.
export const PurchaseImportRunAgent = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    ...workerSentryOptions(env),
    initialScope: { tags: { service: "purchase-agent" } },
  }),
  PurchaseImportRunAgentHost,
);
