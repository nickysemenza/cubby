import { importRunIdFromAgentIdentity } from "@cubby/schemas/import-run-agent";
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
  PurchaseAgentQueueEnvironment,
  PurchaseImportRunAgentRpc,
} from "~/server/purchase-agent/environment";

import { connectedChatGptInference } from "../ai/chatgpt/client";
import { CF_AIG_GATEWAY_ID } from "../cf-env";
import { workerSentryOptions } from "../worker-sentry";
import { purchaseAgentMcpTools, runServicesFor } from "./agent-services";

type HostContext = { waitUntil(promise: Promise<unknown>): void };

/**
 * One coordinator's whole environment, built from this Worker's bindings. Its
 * services are bound to `runId`, which the host reads from the object's name.
 */
function purchaseAgentEnvironment(
  env: Env,
  ctx: HostContext,
  runId: string,
): PurchaseAgentEnvironment {
  // SAFETY: the workerd harness adds this service binding to the Worker; it
  // is deliberately absent from wrangler.jsonc, so production never has it.
  const { CUBBY_PURCHASE_AGENT_TEST_MODEL: testModel } = env as Env & {
    CUBBY_PURCHASE_AGENT_TEST_MODEL?: PurchaseAgentEnvironment["testModel"];
  };
  return {
    chatGptInference: (body, options) =>
      connectedChatGptInference(
        env.CHATGPT_PLAN.getByName("household"),
        body,
        options,
      ),
    gateway: () => {
      const gateway = env.AI.gateway(CF_AIG_GATEWAY_ID);
      return {
        id: CF_AIG_GATEWAY_ID,
        run: (data, options) => gateway.run(data, options),
      };
    },
    services: runServicesFor(env, ctx, runId),
    mcpTools: purchaseAgentMcpTools,
    ...(testModel && { testModel }),
  };
}

/** The queue consumer's environment: any Run's services and coordinator. */
export function purchaseAgentQueueEnvironment(
  env: Env,
  ctx: HostContext,
): PurchaseAgentQueueEnvironment {
  return {
    run: (runId) => runServicesFor(env, ctx, runId),
    coordinator: (agentId) => env.PURCHASE_IMPORT_RUN.getByName(agentId),
  };
}

type RunAgent =
  import("~/server/purchase-agent/run-agent").PurchaseImportRunAgent;

/**
 * One import Run's coordinator Durable Object. Every entry point loads the
 * agent (once per instance) and forwards to it; the agent's Lifecycle jobs
 * wake it through `alarm`. The SDK initializes the agent inside its own
 * `fetch` and `alarm` (the alarm's memory-limit circuit breaker covers boot
 * hydration), so only the `dispatch` RPC initializes it here.
 */
class PurchaseImportRunAgentHost
  extends DurableObject<Env>
  implements PurchaseImportRunAgentRpc
{
  private agent: Promise<RunAgent> | undefined;

  private loaded(): Promise<RunAgent> {
    this.agent ??= import("~/server/purchase-agent/run-agent")
      .then(({ PurchaseImportRunAgent }) => {
        const runId = importRunIdFromAgentIdentity(this.ctx.id.name);
        if (!runId)
          throw new Error(
            "Purchase agent object is not named for an import Run",
          );
        return new PurchaseImportRunAgent(
          this.ctx,
          purchaseAgentEnvironment(this.env, this.ctx, runId),
        );
      })
      .catch((error) => {
        this.agent = undefined;
        throw error;
      });
    return this.agent;
  }

  async fetch(request: Request): Promise<Response> {
    return (await this.loaded()).fetch(request);
  }

  async alarm(): Promise<void> {
    await (await this.loaded()).alarm();
  }

  async dispatch(input: DispatchInput): Promise<{ accepted: boolean }> {
    const agent = await this.loaded();
    await agent.__unsafe_ensureInitialized();
    return agent.dispatch(input);
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
