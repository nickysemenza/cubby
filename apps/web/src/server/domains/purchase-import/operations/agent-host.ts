import {
  agentPromptSchema,
  agentConversationSchema,
} from "@cubby/schemas/agent-conversation";
import { coordinatorModelsSchema } from "@cubby/schemas/coordinator-models";
import { importRunIdFromAgentIdentity } from "@cubby/schemas/import-run-agent";
import { aiGatewayId } from "@cubby/shared/ai/gateway-metadata";
import { createLogger } from "@cubby/worker-tracing";
/**
 * The purchase agent's host: the exported Durable Object and the narrowed
 * environment that is the agent's only view of this Worker.
 *
 * The agent (`server/domains/purchase-agent/`) reads untrusted vendor pages, mail, and
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

import { connectedChatGptInference } from "~/server/ai/chatgpt/client";
import { gatewayEnvironment } from "~/server/ai/gateway";
import { coordinatedGatewayRequest } from "~/server/ai/gateway-egress-client";
import type {
  DispatchInput,
  PurchaseAgentEnvironment,
  PurchaseImportRunAgentRpc,
} from "~/server/domains/purchase-agent/service/environment";
import {
  assertNotInMaintenance,
  isMaintenanceMode,
  maintenanceResponse,
} from "~/server/http/maintenance";
import { withInvocationTrace } from "~/server/observability/tracing";
import { workerSentryOptions } from "~/server/observability/worker-sentry";
import { testDurationOverrideMs } from "~/server/testing/test-duration-override";

import {
  authorizeLegacyRetirement,
  purchaseAgentMcpTools,
  runServicesFor,
  wakeWaitingDispatch,
  fenceDispatch,
  agentModelTurn,
} from "./agent-services";
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
  fence: () => Promise<void>,
): PurchaseAgentEnvironment {
  // SAFETY: the workerd harness adds this service binding to the Worker; it
  // is deliberately absent from cloudflare.config.ts, so production never has it.
  const {
    CUBBY_PURCHASE_AGENT_TEST_MODEL: testModel,
    CUBBY_PURCHASE_AGENT_FIXED_MODEL: fixedModel,
    CUBBY_PURCHASE_AGENT_COORDINATOR_MODELS: coordinatorModels,
  } = env as Env & {
    CUBBY_PURCHASE_AGENT_TEST_MODEL?: PurchaseAgentEnvironment["testModel"];
    CUBBY_PURCHASE_AGENT_FIXED_MODEL?: string;
    CUBBY_PURCHASE_AGENT_COORDINATOR_MODELS?: string;
  };
  return {
    modelTurn: (request, send) =>
      agentModelTurn(env, ctx, runId, request, send, fence),
    chatGptInference: (body, options) =>
      connectedChatGptInference(
        env.CHATGPT_PLAN.getByName("household"),
        body,
        options,
      ),
    gateway: () => {
      const gateway = env.AI.gateway(aiGatewayId(gatewayEnvironment()));
      return {
        id: aiGatewayId(gatewayEnvironment()),
        coordinatedFetch: (provider, request, controls) =>
          coordinatedGatewayRequest(
            env.AI_GATEWAY_EGRESS.getByName(aiGatewayId(gatewayEnvironment())),
            provider,
            request,
            controls,
          ),
        environment: gatewayEnvironment(),
        run: (data, options) => gateway.run(data, options),
      };
    },
    // pi's database work runs only under a live coordinator turn.
    services: runServicesFor(env, ctx, runId, { fence }),
    mcpTools: purchaseAgentMcpTools,
    ...(testModel && { testModel }),
    ...(testModel &&
      fixedModel === "openai-responses" && {
        fixedModel,
      }),
    // Like the fixed model, only a harness with a model peer can override
    // the manifest's coordinator models.
    ...(testModel &&
      coordinatorModels && {
        coordinatorModels: coordinatorModelsSchema.parse(
          JSON.parse(coordinatorModels),
        ),
      }),
    settlementPollMs: testDurationOverrideMs(env.CUBBY_TEST_SETTLEMENT_POLL_MS),
  };
}

const RETIREMENT_FENCE = "cubby_retirement_fence";
/** Prompts wait in the coordinator's durable storage until its Pass holds a slot. */
const PROMPT_PREFIX = "cubby_pending_prompt:";
const ABORT_PENDING = "cubby_abort_pending";

type RunAgent =
  import("~/server/domains/purchase-agent/service/run-agent").PurchaseImportRunAgent;

/** How long one live fence read answers this instance's fetches and alarms. */
const NOT_RETIRED_TTL_MS = 5 * 60_000;

/**
 * One import Run's coordinator Durable Object. Execution entry points refuse a
 * retired Run before loading the agent; its Lifecycle jobs wake it through
 * `alarm`. The SDK initializes the agent inside its own `fetch` and `alarm`
 * (the alarm's memory-limit circuit breaker covers boot hydration), so only
 * the `dispatch` RPC initializes it here. Retirement of a settled Run
 * destroys the transcript, and with it any Email text the agent read.
 *
 * `Run.retiredAt` is stamped only after `retire` acknowledges empty storage,
 * so the database fence alone leaves a gap. Once `retire` is authorized it
 * writes a durable fence table (which survives a restart and is the only
 * storage an empty inventory keeps), admits no execution, drains the ones
 * already admitted, and inventories and deletes storage with no event
 * interleaved.
 */
class PurchaseImportRunAgentHost
  extends DurableObject<Env>
  implements PurchaseImportRunAgentRpc
{
  private agent: Promise<RunAgent> | undefined;
  private disposalAttempted = false;
  private retiring = false;
  /** Until when the last database fence read said this Run is live. */
  private liveUntil = 0;
  private readonly admitted = new Set<Promise<unknown>>();
  private claimToken: string | undefined;

  private async executionFence(): Promise<void> {
    if (!this.claimToken) throw new Error("Coordinator has no Pass claim");
    await fenceDispatch(this.env, this.ctx, this.runId(), this.claimToken);
  }

  /** Run `work` unless retirement began, tracked so `retire` can drain it. */
  private admit<T>(work: () => Promise<T>, refused: T): Promise<T> {
    this.retiring ||=
      this.ctx.storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          RETIREMENT_FENCE,
        )
        .toArray().length > 0;
    if (this.retiring) return Promise.resolve(refused);
    const running = work();
    const settled = () => this.admitted.delete(running);
    this.admitted.add(running);
    running.then(settled, settled);
    return running;
  }

  /** Persist the retirement fence; storage deletion removes it, so rewrite it after. */
  private fence() {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${RETIREMENT_FENCE} (fenced INTEGER)`,
    );
  }

  /**
   * The database fence, plus retirement begun on this instance meanwhile.
   * `Run.retiredAt` is stamped only after this object's own `retire()` has
   * set `retiring`, so a live "not retired" answer stays true for this
   * instance; it is re-read after `NOT_RETIRED_TTL_MS` only to notice a Run
   * deleted underneath it. A retired answer is never cached away.
   */
  private async fenced(): Promise<boolean> {
    if (this.retiring) return true;
    if (this.liveUntil > Date.now()) return false;
    const retired = await this.services().coordinatorRetired();
    if (!retired) this.liveUntil = Date.now() + NOT_RETIRED_TTL_MS;
    return retired || this.retiring;
  }

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
    this.agent ??= import("~/server/domains/purchase-agent/service/run-agent")
      .then(({ PurchaseImportRunAgent }) => {
        return new PurchaseImportRunAgent(
          this.ctx,
          purchaseAgentEnvironment(this.env, this.ctx, this.runId(), () =>
            this.executionFence(),
          ),
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
    const retired = () =>
      new Response("Import Run coordinator retired.", { status: 410 });
    const { pathname } = new URL(request.url);
    // Only an agent this isolate already constructed for Run work streams
    // live; opening a cold harness resumes its pending tasks, so every other
    // observation stays a snapshot of retained storage.
    if (request.method === "GET" && pathname === "/stream" && this.agent) {
      const agent = this.agent;
      return this.admit(async () => {
        if (await this.fenced()) return retired();
        return (await agent).fetch(request);
      }, retired());
    }
    if (
      request.method === "GET" &&
      (pathname === "/" || pathname === "/transcript" || pathname === "/stream")
    ) {
      return this.admit(
        async () => {
          const { readStoredAgentConversation } =
            await import("../service/agent-transcript");
          return Response.json(
            readStoredAgentConversation(this.ctx.storage.sql),
          );
        },
        Response.json(
          agentConversationSchema.parse({
            status: "absent",
            messages: [],
            settlements: [],
          }),
        ),
      );
    }
    return this.admit(async () => {
      if (await this.fenced()) return retired();
      if (request.method === "POST" && pathname === "/abort") {
        if (this.agent) return (await this.agent).fetch(request);
        await this.ctx.storage.put(ABORT_PENDING, true);
        await wakeWaitingDispatch(this.env, this.ctx, this.runId());
        return Response.json({ aborted: true });
      }
      if (request.method !== "POST" || pathname !== "/")
        return new Response("Not found", { status: 404 });
      const hasState =
        this.ctx.storage.sql
          .exec("SELECT 1 FROM sqlite_master WHERE name = 'cubby_state'")
          .toArray().length > 0;
      if (
        !hasState ||
        !this.ctx.storage.sql
          .exec("SELECT 1 FROM cubby_state WHERE key = 'identity'")
          .toArray().length
      )
        return Response.json(
          { error: "The agent has not started for this run" },
          { status: 409 },
        );
      const parsed = agentPromptSchema.safeParse(
        await request.json().catch(() => null),
      );
      if (!parsed.success)
        return Response.json({ error: parsed.error.message }, { status: 400 });
      const operationId = `prompt:${crypto.randomUUID()}`;
      await this.ctx.storage.put(
        `${PROMPT_PREFIX}${operationId}`,
        parsed.data.body,
      );
      await wakeWaitingDispatch(this.env, this.ctx, this.runId());
      return Response.json({ operationId }, { status: 202 });
    }, retired());
  }

  async retire(): Promise<{ disposed: boolean }> {
    assertNotInMaintenance(this.env);
    const { current } = await this.authorizeRetirement();
    this.retiring = true;
    this.fence();
    await Promise.allSettled(this.admitted);
    return this.ctx.blockConcurrencyWhile(() => this.dispose(current));
  }

  /**
   * A legacy name (a bare session id stored before import Run identities) is
   * resolved only here, to the one settled Run storing it, and erased without
   * loading the agent; every execution entry point still refuses it.
   */
  private async authorizeRetirement(): Promise<{ current: boolean }> {
    const { name } = this.ctx.id;
    if (!name || importRunIdFromAgentIdentity(name))
      return this.services().authorizeRetirement();
    await authorizeLegacyRetirement(this.env, this.ctx, name);
    return { current: false };
  }

  private async dispose(current: boolean): Promise<{ disposed: boolean }> {
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
    if (!current) {
      // A retired purpose's stored identity cannot open the current agent, and
      // its settled Run has no turn to abort: erase storage without loading it.
      // The next call's empty inventory acknowledges the disposal.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.fence();
      return { disposed: false };
    }
    this.disposalAttempted = true;
    const agent = await this.loaded();
    await agent.abortForRetirement();
    await agent.destroy();
    // Before destroy's deferred isolate abort runs.
    this.fence();
    // Public destroy aborts this isolate. Only a later cold empty inventory acknowledges it.
    return { disposed: false };
  }

  async alarm(): Promise<void> {
    if (isMaintenanceMode(this.env)) {
      await this.ctx.storage.setAlarm(Date.now() + 300_000);
      return;
    }
    if (await this.fenced()) return;
    // Lifecycle alarms remain durable; loading or resuming Pi requires a Pass slot.
    await wakeWaitingDispatch(this.env, this.ctx, this.runId());
  }

  async work(token: string): Promise<boolean> {
    assertNotInMaintenance(this.env);
    return this.admit(async () => {
      if (await this.fenced()) return false;
      this.claimToken = token;
      await this.executionFence();
      const agent = await this.loaded();
      await agent.__unsafe_ensureInitialized();
      if (await this.ctx.storage.get(ABORT_PENDING)) {
        await agent.fetch(
          new Request("https://cubby.internal/abort", { method: "POST" }),
        );
        await this.ctx.storage.delete(ABORT_PENDING);
      }
      const prompts = await this.ctx.storage.list<string>({
        prefix: PROMPT_PREFIX,
      });
      for (const [key, body] of prompts) {
        await this.executionFence();
        const response = await agent.fetch(
          new Request("https://cubby.internal/", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-cubby-operation": key.slice(PROMPT_PREFIX.length),
            },
            body: JSON.stringify({ body }),
          }),
        );
        if (!response.ok)
          throw new Error(
            `Coordinator refused durable prompt (${response.status}): ${await response.text()}`,
          );
        await this.ctx.storage.delete(key);
      }
      await agent.alarm();
      return agent.working();
    }, false);
  }

  async dispatch(
    input: DispatchInput,
    token: string,
  ): ReturnType<PurchaseImportRunAgentRpc["dispatch"]> {
    assertNotInMaintenance(this.env);
    return withInvocationTrace(
      "purchase-agent.dispatch",
      () =>
        this.admit(
          async () => {
            if (await this.fenced()) return { accepted: false };
            this.claimToken = token;
            await this.executionFence();
            const agent = await this.loaded();
            await agent.__unsafe_ensureInitialized();
            return agent.dispatch(input);
          },
          { accepted: false },
        ),
      { "cubby.workload": "rpc", "cubby.run.id": this.runId() },
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
