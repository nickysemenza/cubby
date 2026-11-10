import { agentConversationSchema } from "@cubby/schemas/agent-conversation";
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
import {
  annotateActiveSpan,
  withInvocationTrace,
} from "~/server/observability/tracing";
import { workerSentryOptions } from "~/server/observability/worker-sentry";
import { testDurationOverrideMs } from "~/server/testing/test-duration-override";

import {
  authorizeLegacyRetirement,
  purchaseAgentMcpTools,
  runServicesFor,
  wakeWaitingDispatch,
} from "./agent-services";
import { COORDINATOR_GATE_NAME } from "./coordinator-gate";
import {
  CoordinatorTurn,
  type CoordinatorTurnResult,
} from "./coordinator-turn";

type HostContext = { waitUntil(promise: Promise<unknown>): void };
const retirementLog = createLogger("purchase-agent.retirement");
const turnLog = createLogger("purchase-agent.turn");

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
/** A dispatch was refused a turn; its Job waits for this coordinator to wake it. */
const PENDING_DISPATCH = "cubby_pending_dispatch";
/** How long a woken dispatch keeps the turn it was reserved before it arrives. */
const DISPATCH_HANDOFF_MS = 2 * 60_000;
/**
 * The refusal reaches the Job before its deferral commits; a wake that finds
 * no deferred Job looks once more after this.
 */
const DISPATCH_RECHECK_MS = 5_000;

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
  private turn: CoordinatorTurn | undefined;
  /** Until when the turn waits for a woken dispatch to arrive. */
  private dispatchExpectedUntil = 0;

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

  /**
   * The household coordinator-turn cap (`./coordinator-turn.ts`): every entry
   * that loads the agent runs inside a turn. The turn stays held while pi
   * still works after the entry returns.
   */
  private turns(): CoordinatorTurn {
    const runId = this.runId();
    const gate = () =>
      this.env.COORDINATOR_GATE.getByName(COORDINATOR_GATE_NAME);
    this.turn ??= new CoordinatorTurn({
      acquire: (token, options) =>
        gate().acquire({
          runId,
          agent: this.ctx.id.name ?? "",
          token,
          ...(options && { queue: options.queue }),
        }),
      release: (token) =>
        gate()
          .release({ runId, token })
          .then(
            () => undefined,
            (error: unknown) => {
              turnLog.error("coordinator turn release failed", {
                runId,
                error,
              });
            },
          ),
      idle: async () => {
        if (this.dispatchExpectedUntil > Date.now()) return false;
        // An agent that failed to load runs nothing; that is decidably idle.
        const agent = await this.agent?.catch(() => undefined);
        return !agent || !(await agent.working());
      },
      reportIdleError: (error) => {
        turnLog.error("coordinator idle check failed; keeping its turn", {
          runId,
          error,
        });
        Sentry.captureException(error);
      },
      reportGateError: (error) => {
        turnLog.error("coordinator gate unavailable; waiting", {
          runId,
          error,
        });
        Sentry.captureException(error);
      },
    });
    return this.turn;
  }

  /** Record a refused turn on the invocation span, its Sentry scope and the log. */
  private turnWaited(
    refused: Extract<CoordinatorTurnResult<unknown>, { ran: false }>,
    entry: "alarm" | "dispatch" | "fetch",
  ) {
    annotateActiveSpan({
      "cubby.coordinator.turn": refused.unavailable ? "unavailable" : "waiting",
      "cubby.coordinator.turn.holders": refused.holders,
      "cubby.coordinator.turn.position": refused.position,
      "cubby.coordinator.turn.retry_ms": refused.retryAfterMs,
    });
    Sentry.getCurrentScope().setTag(
      "cubby.coordinator.turn",
      refused.unavailable ? "unavailable" : "waiting",
    );
    turnLog.info("coordinator turn wait", {
      runId: this.runId(),
      entry,
      holders: refused.holders,
      position: refused.position,
      retryAfterMs: refused.retryAfterMs,
      unavailable: refused.unavailable ?? false,
    });
  }

  private loaded(): Promise<RunAgent> {
    this.agent ??= import("~/server/domains/purchase-agent/service/run-agent")
      .then(({ PurchaseImportRunAgent }) => {
        return new PurchaseImportRunAgent(
          this.ctx,
          purchaseAgentEnvironment(this.env, this.ctx, this.runId(), () =>
            this.turns().fence(),
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
      (pathname === "/transcript" || pathname === "/stream")
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
      // A member's stop never waits for a turn.
      if (request.method === "POST" && pathname === "/abort")
        return (await this.loaded()).fetch(request);
      // A prompt answers 503 at once rather than joining the gate's queue.
      const turn = await this.turns().turn(
        async () => (await this.loaded()).fetch(request),
        { queue: false },
      );
      if (turn.ran) return turn.value;
      this.turnWaited(turn, "fetch");
      return Response.json(
        {
          error:
            "The coordinator is waiting for a free turn; try again shortly.",
        },
        {
          status: 503,
          headers: {
            "retry-after": String(Math.ceil(turn.retryAfterMs / 1000)),
          },
        },
      );
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
    return withInvocationTrace(
      "purchase-agent.alarm",
      () =>
        this.admit(async () => {
          if (await this.fenced()) return;
          const turn = await this.turns().turn(async () => {
            // The gate reserved this turn for a dispatch that was refused one:
            // bring its Job forward and keep the turn until it arrives.
            if (await this.ctx.storage.get<boolean>(PENDING_DISPATCH)) {
              await this.ctx.storage.delete(PENDING_DISPATCH);
              const wake = () =>
                wakeWaitingDispatch(this.env, this.ctx, this.runId());
              const woken =
                (await wake()) ||
                (await new Promise((resolve) =>
                  setTimeout(resolve, DISPATCH_RECHECK_MS),
                ).then(wake));
              // Nothing to wake (the Job settled or its deferral never
              // committed): release the turn instead of holding it idle.
              if (!woken) return;
              this.dispatchExpectedUntil = Date.now() + DISPATCH_HANDOFF_MS;
              await this.alarmAt(this.dispatchExpectedUntil);
              return;
            }
            await (await this.loaded()).alarm();
          });
          if (turn.ran) return;
          this.turnWaited(turn, "alarm");
          // No agent code ran, so its due Lifecycle jobs stay due. The gate
          // wakes this object when it reserves a turn; this is the fallback.
          await this.alarmAt(Date.now() + turn.retryAfterMs);
        }, undefined),
      {
        "cubby.workload": "alarm",
        "cubby.run.id":
          importRunIdFromAgentIdentity(this.ctx.id.name) ?? undefined,
      },
    );
  }

  /** The gate reserved a turn for this coordinator: take it on the next alarm. */
  async turnReady(): Promise<void> {
    if (isMaintenanceMode(this.env)) return;
    await this.alarmAt(Date.now());
  }

  /** Arm the alarm for `at` unless one is already due sooner. */
  private async alarmAt(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  async dispatch(
    input: DispatchInput,
  ): ReturnType<PurchaseImportRunAgentRpc["dispatch"]> {
    assertNotInMaintenance(this.env);
    const refused: Awaited<ReturnType<PurchaseImportRunAgentRpc["dispatch"]>> =
      { accepted: false };
    return withInvocationTrace(
      "purchase-agent.dispatch",
      () =>
        this.admit(async () => {
          if (await this.fenced()) return refused;
          const turn = await this.turns().turn(async () => {
            // Admitted by itself: no reserved turn needs to wake this Job.
            this.dispatchExpectedUntil = 0;
            await this.ctx.storage.delete(PENDING_DISPATCH);
            const agent = await this.loaded();
            await agent.__unsafe_ensureInitialized();
            return agent.dispatch(input);
          });
          if (turn.ran) return turn.value;
          this.turnWaited(turn, "dispatch");
          await this.ctx.storage.put(PENDING_DISPATCH, true);
          // Keep asking, like a refused alarm, so this coordinator keeps its
          // place in the gate's queue while its Job waits.
          await this.alarmAt(Date.now() + turn.retryAfterMs);
          return {
            accepted: false,
            waiting: {
              holders: turn.holders,
              ...(turn.unavailable && { unavailable: true }),
            },
          };
        }, refused),
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
