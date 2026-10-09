import {
  agentPromptSchema,
  type AgentConversation,
  type AgentConversationSettlement,
} from "@cubby/schemas/agent-conversation";
import {
  contextBreakdownSchema,
  type ContextBreakdown,
} from "@cubby/schemas/context-breakdown";
import {
  agentImportRunPurpose,
  importRunAgentIdentity,
  importRunAgentManifest,
} from "@cubby/schemas/import-run-agent";
import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import type { GatewayResponseInfo } from "@cubby/shared/ai/gateway-request";
import { piTokenUsage } from "@cubby/shared/ai/pi-providers";
import { createLogger } from "@cubby/worker-tracing";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type EntryRecord,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import * as Sentry from "@sentry/cloudflare";
import { Agent } from "agents";
import {
  PiHarness,
  skills as piSkills,
  type PiHarnessContext,
} from "agents/harness/pi";
import { z } from "zod";

import { createContextRecorder } from "./context-breakdown";
import { projectConversation } from "./conversation";
import { CONTEXT_SCOPE, cubbyAgentProviders } from "./cubby-ai-provider";
import { cubbyMcpExtension } from "./cubby-mcp";
import type {
  DispatchInput,
  PurchaseAgentEnvironment,
  PurchaseImportRunAgentRpc,
  RunServices,
} from "./environment";
import { workflowForRun } from "./import-run-workflows";
import { RunSettlement } from "./run-settlement";
import {
  parseSignal,
  renderSignal,
  resumeResearchSignal,
  type AgentSignal,
} from "./signals";
import { photoInventoryTools, purchaseImportTools } from "./tools";

const log = createLogger("purchase-agent");
const context = BACKGROUND_CONTEXT;

const runIdentity = z.object({
  runId: z.uuid(),
  purpose: agentImportRunPurpose,
});
type RunIdentity = z.infer<typeof runIdentity>;

/** The fields the projection reads from pi's committed assistant partial. */
const assistantPartialFields = z.looseObject({
  role: z.literal("assistant"),
  content: z.array(z.looseObject({ type: z.string() })),
  model: z.string(),
  usage: z.looseObject({ cost: z.looseObject({ total: z.number() }) }),
  timestamp: z.number(),
});
const assistantPartial = z.custom<AssistantMessage>(
  (value) => assistantPartialFields.safeParse(value).success,
);

/**
 * The Agents SDK base reads its `env` only to find Durable Object, Workflow,
 * and MCP bindings this agent never uses, so it gets none: the agent's
 * environment is the narrowed one its host passes in.
 */
// SAFETY: an empty environment; the SDK finds no binding in it, which is
// the intent, and nothing in this module reads `this.env`.
const NO_BINDINGS = Object.freeze({}) as Cloudflare.Env;

/** Mutable per-run facts kept in this object's SQLite, beside pi's tables. */
const STATE_KEYS = {
  identity: "identity",
  reasoningMode: "reasoning_mode",
  latestSubmission: "latest_submission",
  receivedEvents: "received_events",
  researchGenerationCount: "research_generation_count",
  researchGenerationStop: "research_generation_stop",
} as const;

/**
 * One import Run's coordinator: a pi-durable conversation hosted on this
 * Durable Object's SQLite by `PiHarness`. pi owns the transcript, retries,
 * and crash recovery; this class supplies Cubby's tools, the run's identity,
 * the conversation projection the run page reads, and settlement reports.
 *
 * The exported Durable Object (`server/purchase-import/agent-host.ts`) loads
 * this module on first use and constructs it with the narrowed environment;
 * nothing here reads the Worker's `env`.
 */
export class PurchaseImportRunAgent
  extends Agent
  implements Pick<PurchaseImportRunAgentRpc, "dispatch">
{
  private readonly registry = createRegistry();
  private readonly recorder = createContextRecorder();
  private installed: string | undefined;
  private requestStartedAt = 0;
  /** What carried the current model request; the coordinator runs one at a time. */
  private requestTransport: AiUsageTransport = "unknown";
  /** The current request's last gateway response, for its usage row. */
  private requestGateway: GatewayResponseInfo | undefined;
  private piStorage: Storage | undefined;

  readonly harness = new PiHarness({
    harness: (input) => this.openPi(input),
  });
  private readonly settlement = new RunSettlement(
    this.harness,
    () => this.services(),
    (error) => this.report(error),
    (settled) => this.recordSettlement(settled),
    {
      latest: () => this.readState(STATE_KEYS.latestSubmission),
      receivedEventIds: () => this.receivedEventIds(),
      reviewDetail: () => this.readState(STATE_KEYS.researchGenerationStop),
    },
  );

  constructor(
    ctx: ConstructorParameters<typeof Agent>[0],
    private readonly agentEnv: PurchaseAgentEnvironment,
  ) {
    super(ctx, NO_BINDINGS);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cubby_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cubby_context_calls (response_id TEXT PRIMARY KEY, breakdown TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cubby_settlements (operation_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, reason TEXT)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cubby_browser_deliveries (request_id TEXT PRIMARY KEY, signal TEXT NOT NULL)",
    );
    this.lifecycle.use(this.harness).use(this.settlement);
  }

  // ---- durable run facts -------------------------------------------------

  private readState(key: string): string | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM cubby_state WHERE key = ?",
        key,
      )
      .toArray()[0];
    return row?.value;
  }

  private writeState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO cubby_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private identity(): RunIdentity | undefined {
    const raw = this.readState(STATE_KEYS.identity);
    return raw ? runIdentity.parse(JSON.parse(raw)) : undefined;
  }

  /** External retirement waits for the terminating tool; cold disposal must not reopen pi. */
  async abortForRetirement(): Promise<void> {
    if (this.identity()) await this.harness.abort();
  }

  private services(): RunServices {
    return this.agentEnv.services;
  }

  private report<TError>(error: TError): void {
    log.error("purchase agent operation failed", { error });
    Sentry.captureException(error);
  }

  // ---- pi ---------------------------------------------------------------

  private async openPi({ storage, context: open }: PiHarnessContext) {
    this.piStorage = storage;
    const models = createModels();
    const identity = this.identity();
    for (const provider of cubbyAgentProviders({
      gateway: () => this.agentEnv.gateway(),
      recorder: this.recorder,
      testModel: this.agentEnv.testModel,
      subscription: this.agentEnv.chatGptInference,
      subscriptionRequired: identity?.purpose !== "photo_inventory",
      beforeTransmission: () => {
        if (identity?.purpose === "photo_inventory") return;
        const stop = this.readState(STATE_KEYS.researchGenerationStop);
        if (!stop) return;
        return Response.json(
          {
            error: {
              type: "permission_error",
              code: "research_generation_limit",
              message: stop,
            },
          },
          { status: 403 },
        );
      },
      onTransport: (transport) => {
        this.requestTransport = transport;
      },
      onResponse: (info) => {
        this.requestGateway = info;
      },
    }))
      models.setProvider(provider);
    // A cold start reinstalls the run's tools before pi resumes any task, so
    // a recovered tool call never finds its tool missing.
    if (identity) await this.installRunExtensions(identity);
    return Harness.open(
      storage,
      {
        models,
        registry: this.registry,
        settings: {
          // The coordinator works one tool at a time; see cubby-ai-provider.
          toolExecution: "sequential",
          retry: { maxRetries: 3 },
        },
        onReport: (error) => this.report(error),
      },
      open,
    );
  }

  private async installRunExtensions(identity: RunIdentity): Promise<void> {
    if (this.installed === identity.runId) return;
    const { runId, purpose } = identity;
    const manifest = importRunAgentManifest[purpose];
    const workflow = workflowForRun(purpose, runId);
    const agentTools = new Set<string>(manifest.agentTools);
    this.registry.install(
      defineExtension({
        name: "cubby.run",
        tools: (purpose === "photo_inventory"
          ? photoInventoryTools(() => this.services())
          : purchaseImportTools(
              () => this.services(),
              (output) => this.retainResearchMode(output),
              () => this.acknowledgeAdmittedObservations(),
            )
        ).filter((tool) => agentTools.has(tool.name)),
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async (request, api, hookContext) => {
              this.admitResearchGeneration(purpose, api.taskId);
              await this.acknowledgeAdmittedObservations();
              this.requestStartedAt = Date.now();
              this.requestTransport = "unknown";
              this.requestGateway = undefined;
              const index = request.messages.findLastIndex(
                (message) => message.role === "user",
              );
              const last = request.messages[index];
              const text =
                last?.role === "user"
                  ? z.string().safeParse(last.content)
                  : undefined;
              const signal = text?.success ? parseSignal(text.data) : undefined;
              if (
                purpose !== "photo_inventory" &&
                !this.readState(STATE_KEYS.researchGenerationStop) &&
                last?.role === "user" &&
                signal?.type === "cubby.research-continuation" &&
                signal.attributes?.yieldRef
              ) {
                const existing = await api.memo<JsonValue>(
                  "research-continuation-consumed",
                  hookContext,
                );
                const output =
                  existing ??
                  (await api.memo(
                    "research-continuation-consumed",
                    z
                      .json()
                      .parse(
                        await this.services().researchContinue(
                          signal.attributes.yieldRef,
                          true,
                        ),
                      ),
                    hookContext,
                  ));
                await this.retainResearchMode(output);
                return {
                  messages: [
                    ...request.messages.slice(0, index),
                    {
                      ...last,
                      content: renderSignal({
                        ...signal,
                        body: JSON.stringify(output),
                      }),
                    },
                    ...request.messages.slice(index + 1),
                  ],
                };
              }
              return undefined;
            },
            afterResponse: (message) => this.afterResponse(message),
            onYield: async (_answer, api, hookContext) => {
              if (
                purpose === "photo_inventory" ||
                this.readState(STATE_KEYS.researchGenerationStop)
              )
                return undefined;
              const existing = await api.memo<JsonValue>(
                "research-continuation",
                hookContext,
              );
              const output =
                existing ??
                (await api.memo(
                  "research-continuation",
                  z
                    .json()
                    .parse(
                      await this.services().researchContinue(
                        `yield:${api.taskId}`,
                        false,
                      ),
                    ),
                  hookContext,
                ));
              await this.retainResearchMode(output);
              const active = z
                .object({ status: z.literal("working") })
                .safeParse(output);
              if (!active.success) return undefined;
              return {
                continue: renderSignal({
                  type: "cubby.research-continuation",
                  attributes: { yieldRef: `yield:${api.taskId}` },
                  body: JSON.stringify(output),
                }),
              };
            },
          }),
        ],
      }),
    );
    if (purpose === "photo_inventory") {
      const mcpTools = await this.agentEnv.mcpTools(purpose);
      this.registry.install(cubbyMcpExtension(mcpTools, () => this.services()));
    }
    if (workflow.skills)
      this.registry.install(await piSkills([workflow.skills]));
    this.installed = runId;
  }

  /** Count unique pi generations atomically; retries and recovery keep their task id. */
  private admitResearchGeneration(
    purpose: RunIdentity["purpose"],
    taskId: TaskId,
  ): void {
    if (purpose === "photo_inventory") return;
    this.ctx.storage.transactionSync(() => {
      const key = `research_generation:${taskId}`;
      if (this.readState(key)) return undefined;
      const count = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(this.readState(STATE_KEYS.researchGenerationCount) ?? "0");
      if (count >= 256) {
        const detail =
          "Research generation limit (256) reached. Unfinished work remains for review; no verification or completion is claimed.";
        this.writeState(STATE_KEYS.researchGenerationStop, detail);
        return;
      }
      this.writeState(STATE_KEYS.researchGenerationCount, String(count + 1));
      this.writeState(key, "admitted");
      return undefined;
    });
  }

  /** Preserve host-requested escalation across eviction and service-result replay. */
  private async retainResearchMode(output: JsonValue): Promise<void> {
    const mode = z
      .looseObject({ reasoningMode: z.literal("unfamiliar_resolution") })
      .safeParse(output);
    if (!mode.success) return;
    this.writeState(STATE_KEYS.reasoningMode, mode.data.reasoningMode);
    const root = await (await this.harness.pi()).root(context);
    await root.configure(
      {
        model: { provider: "openai", modelId: "gpt-6-sol" },
        thinkingLevel: "high",
      },
      context,
    );
  }

  private async afterResponse(message: AssistantMessage) {
    await this.recorder.settled();
    const breakdown = this.recorder.take(CONTEXT_SCOPE);
    const responseKey = message.responseId ?? `t:${message.timestamp}`;
    if (breakdown)
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO cubby_context_calls (response_id, breakdown) VALUES (?, ?)",
        responseKey,
        JSON.stringify(breakdown),
      );
    try {
      await this.services().recordAgentUsage({
        eventId: `model-turn:${responseKey}`,
        provider: message.provider,
        model: message.model,
        feature: "purchase_import_agent",
        operation: "agent.generation",
        attempt: 1,
        ...piTokenUsage(message),
        durationMs: Math.max(0, Date.now() - this.requestStartedAt),
        status: message.stopReason === "error" ? "failed" : "succeeded",
        transport: this.requestTransport,
        gatewayLogId: this.requestGateway?.gatewayLogId ?? undefined,
        gatewayCacheStatus:
          this.requestGateway?.gatewayCacheStatus ?? undefined,
      });
    } catch (error) {
      // Usage accounting never fails the coordinator's turn.
      this.report(error);
    }
  }

  private recordSettlement(settled: AgentConversationSettlement) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cubby_settlements (operation_id, outcome, reason) VALUES (?, ?, ?)",
      settled.operationId,
      settled.outcome,
      settled.reason ?? null,
    );
  }

  // ---- entry points -----------------------------------------------------

  /** SDK admission is the receipt authority, including cold tool recovery. */
  private async acknowledgeAdmittedObservations(): Promise<void> {
    const storage = this.piStorage;
    if (!storage) return;
    const deliveries = this.ctx.storage.sql
      .exec<{ request_id: string; signal: string }>(
        "SELECT request_id, signal FROM cubby_browser_deliveries ORDER BY rowid",
      )
      .toArray();
    for (const delivery of deliveries) {
      const admitted = await storage.submissionByRequest(
        ROOT_CONVERSATION_ID,
        delivery.request_id,
        context,
      );
      if (!admitted) continue;
      const signal: AgentSignal = z
        .object({
          type: z.string(),
          attributes: z.record(z.string(), z.string()).optional(),
          body: z.string(),
        })
        .parse(JSON.parse(delivery.signal));
      await this.services().researchAcknowledge(signal);
      this.ctx.storage.sql.exec(
        "DELETE FROM cubby_browser_deliveries WHERE request_id = ?",
        delivery.request_id,
      );
    }
  }

  /** A queue event for this Run: admit it once, keyed by its operation id. */
  async dispatch(input: DispatchInput): Promise<{ accepted: boolean }> {
    const identity = runIdentity.parse(input.identity);
    if (this.name !== importRunAgentIdentity(identity.runId, identity.purpose))
      throw new Error("Import run agent identity does not match its Run");
    const stored = this.identity();
    if (
      stored &&
      (stored.runId !== identity.runId || stored.purpose !== identity.purpose)
    )
      throw new Error("Import run agent is bound to another Run");
    if (!stored) {
      // A new coordinator starts only for a member who still authorizes the
      // agent; the host pauses the Run for authorization otherwise.
      await this.services().authorize();
      this.writeState(STATE_KEYS.identity, JSON.stringify(identity));
    }
    await this.ensureRunReady(identity);
    // Record a new event, and its submission as the newest, before pi
    // persists it: a submission that persists but fails to return is then
    // still the newest when the queue redelivers it, and gets its watcher. A
    // redelivered older event leaves the newest submission alone.
    const signal =
      identity.purpose === "photo_inventory"
        ? input.signal
        : await resumeResearchSignal(input.signal, async (incoming) => {
            const observation = await this.services().researchResume(incoming);
            if (observation)
              await this.retainResearchMode(z.json().parse(observation));
            return observation;
          });
    const eventId = input.signal.attributes?.eventId;
    if (!eventId || !this.receivedEventIds().includes(eventId)) {
      if (eventId) this.recordReceived(eventId);
      if (signal)
        this.writeState(STATE_KEYS.latestSubmission, input.operationId);
    }
    if (!signal) return { accepted: true };
    if (
      identity.purpose !== "photo_inventory" &&
      input.signal.type === "purchase-import.browser_result"
    ) {
      const serialized = JSON.stringify(input.signal);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO cubby_browser_deliveries (request_id, signal) VALUES (?, ?)",
        input.operationId,
        serialized,
      );
      const retained = this.ctx.storage.sql
        .exec<{ signal: string }>(
          "SELECT signal FROM cubby_browser_deliveries WHERE request_id = ?",
          input.operationId,
        )
        .one();
      if (retained.signal !== serialized)
        throw new Error("Browser delivery request is bound to another signal");
    }
    const receipt = await this.harness.submit(renderSignal(signal), {
      operationId: input.operationId,
      whenBusy: "steer",
    });
    if (identity.purpose !== "photo_inventory")
      await this.acknowledgeAdmittedObservations();
    if (
      receipt.accepted ||
      this.readState(STATE_KEYS.latestSubmission) === receipt.operationId
    )
      await this.settlement.watch({ operationId: receipt.operationId });
    return { accepted: receipt.accepted };
  }

  private receivedEventIds(): string[] {
    const raw = this.readState(STATE_KEYS.receivedEvents);
    return raw ? z.array(z.string()).parse(JSON.parse(raw)) : [];
  }

  private recordReceived(eventId: string) {
    const received = this.receivedEventIds();
    if (received.includes(eventId)) return;
    this.writeState(
      STATE_KEYS.receivedEvents,
      JSON.stringify([...received, eventId]),
    );
  }

  private async ensureRunReady(identity: RunIdentity): Promise<void> {
    await this.installRunExtensions(identity);
    const manifest = importRunAgentManifest[identity.purpose];
    const root = await (await this.harness.pi()).root(context);
    const escalated =
      this.readState(STATE_KEYS.reasoningMode) === "unfamiliar_resolution";
    await root.configure(
      {
        model: {
          provider: "openai",
          modelId: escalated ? "gpt-6-sol" : manifest.model,
        },
        thinkingLevel: escalated ? "high" : manifest.effort,
        instructions: workflowForRun(identity.purpose, identity.runId)
          .instructions,
      },
      context,
    );
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const suffix = url.pathname.replace(/^\/+|\/+$/gu, "");
    if (request.method === "GET" && suffix === "")
      return Response.json(await this.conversation());
    if (request.method === "GET" && suffix === "stream")
      return this.stream(request);
    if (request.method === "POST" && suffix === "") return this.prompt(request);
    if (request.method === "POST" && suffix === "abort") {
      await this.harness.abort();
      return Response.json({ aborted: true });
    }
    return new Response("Not found", { status: 404 });
  }

  /** A member's instruction joins the running work after its current round. */
  private async prompt(request: Request): Promise<Response> {
    const identity = this.identity();
    if (!identity)
      return Response.json(
        { error: "The agent has not started for this run" },
        { status: 409 },
      );
    const parsed = agentPromptSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success)
      return Response.json({ error: parsed.error.message }, { status: 400 });
    await this.ensureRunReady(identity);
    const operationId = `prompt:${crypto.randomUUID()}`;
    this.writeState(STATE_KEYS.latestSubmission, operationId);
    const receipt = await this.harness.submit(parsed.data.body, {
      operationId,
      whenBusy: "steer",
    });
    await this.settlement.watch({ operationId: receipt.operationId });
    return Response.json({ operationId: receipt.operationId }, { status: 202 });
  }

  async conversation(): Promise<AgentConversation> {
    if (!this.identity())
      return { status: "absent", messages: [], settlements: [] };
    const pi = await this.harness.pi();
    const root = await pi.conversation(ROOT_CONVERSATION_ID, context);
    if (!root) return { status: "absent", messages: [], settlements: [] };
    const entries: EntryRecord[] = [];
    let cursor;
    do {
      const page = await root.entries({}, 500, cursor, context);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    entries.reverse();
    const live = await pi.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context);
    const contextCalls = new Map<string, ContextBreakdown>();
    for (const row of this.ctx.storage.sql
      .exec<{ response_id: string; breakdown: string }>(
        "SELECT response_id, breakdown FROM cubby_context_calls",
      )
      .toArray()) {
      const parsed = contextBreakdownSchema.safeParse(
        JSON.parse(row.breakdown),
      );
      if (parsed.success) contextCalls.set(row.response_id, parsed.data);
    }
    const settlements = this.ctx.storage.sql
      .exec<{ operation_id: string; outcome: string; reason: string | null }>(
        "SELECT operation_id, outcome, reason FROM cubby_settlements ORDER BY rowid",
      )
      .toArray()
      .map((row) => {
        const settled: AgentConversationSettlement = {
          operationId: row.operation_id,
          outcome: row.outcome === "done" ? "done" : "unanswered",
        };
        if (row.reason) settled.reason = row.reason;
        return settled;
      });
    // pi commits the in-flight partial as the JSON form of an AssistantMessage.
    const partial = assistantPartial.safeParse(live?.generation?.message).data;
    return projectConversation({
      entries,
      running: live?.run !== undefined,
      settlements,
      contextCalls,
      partial,
    });
  }

  /**
   * Server-sent snapshots: one at connect, then one after each burst of
   * commits. Every frame is a whole snapshot, so a client that reconnects
   * simply takes the next one.
   */
  private async stream(request: Request): Promise<Response> {
    const encoder = new TextEncoder();
    const frame = async () =>
      encoder.encode(`data: ${JSON.stringify(await this.conversation())}\n\n`);
    // Enqueue never waits for a reader: a writer awaited before the Response
    // is returned deadlocks, because nothing can read until it is returned.
    const first = await frame();
    if (!this.identity())
      return eventStream(
        new ReadableStream({
          start(controller) {
            controller.enqueue(first);
            controller.close();
          },
        }),
      );
    const root = await (await this.harness.pi()).root(context);
    const view = await root.viewState(context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let unsubscribe = () => {};
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      view.dispose();
    };
    request.signal.addEventListener("abort", close);
    return eventStream(
      new ReadableStream({
        start: (controller) => {
          controller.enqueue(first);
          unsubscribe = view.subscribe(() => {
            if (timer || closed) return;
            timer = setTimeout(() => {
              timer = undefined;
              frame()
                .then((next) => {
                  if (!closed) controller.enqueue(next);
                })
                .catch((error) => {
                  this.report(error);
                  close();
                  controller.close();
                });
            }, 250);
          });
        },
        cancel: close,
      }),
    );
  }
}

const eventStream = (body: ReadableStream<Uint8Array>) =>
  new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
    },
  });
