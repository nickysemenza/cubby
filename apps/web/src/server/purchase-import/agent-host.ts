import { importRunIdFromAgentIdentity } from "@cubby/schemas/import-run-agent";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import { createLogger } from "@cubby/worker-tracing";
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

import {
  assertNotInMaintenance,
  isMaintenanceMode,
  maintenanceResponse,
} from "~/server/maintenance";
import type {
  DispatchInput,
  PurchaseAgentEnvironment,
  PurchaseAgentQueueEnvironment,
  PurchaseImportRunAgentRpc,
} from "~/server/purchase-agent/environment";
import { withInvocationTrace } from "~/server/tracing";

import { connectedChatGptInference } from "../ai/chatgpt/client";
import { gatewayEnvironment } from "../ai/gateway";
import { workerSentryOptions } from "../worker-sentry";
import { purchaseAgentMcpTools, runServicesFor } from "./agent-services";

type HostContext = { waitUntil(promise: Promise<unknown>): void };
const retirementLog = createLogger("purchase-agent.retirement");

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
      const gateway = env.AI.gateway(CUBBY_AI_GATEWAY_ID);
      return {
        id: CUBBY_AI_GATEWAY_ID,
        environment: gatewayEnvironment(),
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
 * One import Run's coordinator Durable Object. Every entry point checks its
 * external retirement fence before loading the agent; its Lifecycle jobs
 * wake it through `alarm`. The SDK initializes the agent inside its own
 * `fetch` and `alarm` (the alarm's memory-limit circuit breaker covers boot
 * hydration), so only the `dispatch` RPC initializes it here. Retirement
 * authorizes its receipt without hydration, then uses public SDK disposal.
 */
class PurchaseImportRunAgentHost
  extends DurableObject<Env>
  implements PurchaseImportRunAgentRpc
{
  private agent: Promise<RunAgent> | undefined;
  private disposalAttempted = false;

  private runId(): string {
    const runId = importRunIdFromAgentIdentity(this.ctx.id.name);
    if (!runId)
      throw new Error("Purchase agent object is not named for an import Run");
    return runId;
  }

  private services() {
    return runServicesFor(this.env, this.ctx, this.runId());
  }

  private loaded(): Promise<RunAgent> {
    this.agent ??= import("~/server/purchase-agent/run-agent")
      .then(({ PurchaseImportRunAgent }) => {
        return new PurchaseImportRunAgent(
          this.ctx,
          purchaseAgentEnvironment(this.env, this.ctx, this.runId()),
        );
      })
      .catch((error) => {
        this.agent = undefined;
        throw error;
      });
    return this.agent;
  }

  async fetch(request: Request): Promise<Response> {
    if (isMaintenanceMode(this.env)) return maintenanceResponse(request);
    const status = await this.services().researchCoordinatorStatus();
    if (status === "retired")
      return new Response(
        "Research coordinator permanently retired: unrelated_source.",
        { status: 410 },
      );
    if (status !== "ready")
      return new Response(`Research coordinator execution fenced: ${status}.`, {
        status: 409,
      });
    return (await this.loaded()).fetch(request);
  }

  async retire(input: { receiptId: string }): Promise<{ disposed: boolean }> {
    assertNotInMaintenance(this.env);
    await this.services().authorizeResearchRetirement(input.receiptId);
    const keys = await this.ctx.storage.list();
    const alarm = await this.ctx.storage.getAlarm();
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .toArray()
      .filter(
        // KV and protected alarm metadata use public storage APIs. Miniflare
        // recreates only ctx.id.name in its identity table before every RPC.
        ({ name }) =>
          !name.startsWith("sqlite_") &&
          name !== "__cf_kv" &&
          name !== "_cf_KV" &&
          name !== "_cf_METADATA" &&
          name !== "__miniflare_do_name",
      );
    const rows = tables.reduce((count, { name }) => {
      const identifier = `"${name.replaceAll('"', '""')}"`;
      const [table] = this.ctx.storage.sql
        .exec<{ count: number }>(`SELECT count(*) AS count FROM ${identifier}`)
        .toArray();
      if (!table) throw new Error("Retirement storage inventory unavailable.");
      return count + table.count;
    }, 0);
    retirementLog.info("storage-inventory", {
      kvKeys: keys.size,
      alarmPending: alarm !== null,
      userTables: tables.length,
      tableNames: tables.map(({ name }) => name),
      userRows: rows,
      disposalAttempted: this.disposalAttempted,
    });
    if (!keys.size && !rows && alarm === null)
      return { disposed: !this.disposalAttempted };
    this.disposalAttempted = true;
    const agent = await this.loaded();
    await agent.abortForRetirement();
    await agent.destroy();
    // Public destroy aborts this isolate. Only a later cold empty inventory acknowledges it.
    return { disposed: false };
  }

  async alarm(): Promise<void> {
    if (isMaintenanceMode(this.env)) {
      await this.ctx.storage.setAlarm(Date.now() + 300_000);
      return;
    }
    return withInvocationTrace(
      "purchase-agent.alarm",
      async () => {
        if ((await this.services().researchCoordinatorStatus()) !== "ready")
          return;
        await (await this.loaded()).alarm();
      },
      {
        "cubby.workload": "alarm",
        "cubby.run.id":
          importRunIdFromAgentIdentity(this.ctx.id.name) ?? undefined,
      },
    );
  }

  async dispatch(input: DispatchInput): Promise<{ accepted: boolean }> {
    assertNotInMaintenance(this.env);
    return withInvocationTrace(
      "purchase-agent.dispatch",
      async () => {
        if ((await this.services().researchCoordinatorStatus()) !== "ready")
          return { accepted: false };
        const agent = await this.loaded();
        await agent.__unsafe_ensureInitialized();
        return agent.dispatch(input);
      },
      {
        "cubby.workload": "rpc",
        "cubby.run.id":
          importRunIdFromAgentIdentity(this.ctx.id.name) ?? undefined,
      },
    );
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
