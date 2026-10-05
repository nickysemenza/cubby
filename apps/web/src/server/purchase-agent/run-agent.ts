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
import { createLogger } from "@cubby/worker-tracing";
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
import { renderSignal } from "./signals";
import { purchaseImportTools } from "./tools";

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
  toolRounds: "tool_rounds",
  nudgedAt: "nudged_at",
  latestSubmission: "latest_submission",
  receivedEvents: "received_events",
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
  implements PurchaseImportRunAgentRpc
{
  private readonly registry = createRegistry();
  private readonly recorder = createContextRecorder();
  private installed: string | undefined;
  private requestStartedAt = 0;

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

  private counter(key: string, fallback: number): number {
    const raw = this.readState(key);
    return raw === undefined ? fallback : Number(raw);
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
    const models = createModels();
    for (const provider of cubbyAgentProviders({
      gateway: () => this.agentEnv.gateway(),
      runId: () => this.identity()?.runId,
      recorder: this.recorder,
      testModel: this.agentEnv.testModel,
    }))
      models.setProvider(provider);
    // A cold start reinstalls the run's tools before pi resumes any task, so
    // a recovered tool call never finds its tool missing.
    const identity = this.identity();
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
    const mcpTools = await this.agentEnv.mcpTools(purpose);
    const manifest = importRunAgentManifest[purpose];
    const workflow = workflowForRun(purpose, runId);
    const agentTools = new Set<string>(manifest.agentTools);
    this.registry.install(
      defineExtension({
        name: "cubby.run",
        tools: purchaseImportTools(() => this.services()).filter((tool) =>
          agentTools.has(tool.name),
        ),
        hooks: [
          hook(GenerationTask, {
            beforeRequest: () => {
              this.requestStartedAt = Date.now();
              return undefined;
            },
            afterResponse: (message) => this.afterResponse(message),
            afterTools: () => {
              this.writeState(
                STATE_KEYS.toolRounds,
                String(this.counter(STATE_KEYS.toolRounds, 0) + 1),
              );
            },
            onYield: () => this.finishNudge(workflow.finishNudge),
          }),
        ],
      }),
    );
    this.registry.install(cubbyMcpExtension(mcpTools, () => this.services()));
    this.registry.install(await piSkills([workflow.skills]));
    this.installed = runId;
  }

  /**
   * The model may stop talking without a terminal tool call. Send it back
   * once per stretch of new tool rounds; if it stops again without doing
   * anything, the run's inputs settle and the server's reconcile moves the run
   * to review. pi never yields after a terminating round, so a pending browser
   * command or an approval stop is never nudged.
   */
  private finishNudge(body: string | null) {
    if (!body) return undefined;
    const rounds = this.counter(STATE_KEYS.toolRounds, 0);
    if (this.counter(STATE_KEYS.nudgedAt, -1) === rounds) return undefined;
    this.writeState(STATE_KEYS.nudgedAt, String(rounds));
    return { continue: renderSignal({ type: "run_not_finished", body }) };
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
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cacheReadTokens: message.usage.cacheRead,
        cacheWriteTokens: message.usage.cacheWrite,
        durationMs: Math.max(0, Date.now() - this.requestStartedAt),
        status: message.stopReason === "error" ? "failed" : "succeeded",
        estimatedCost: message.usage.cost.total,
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
    const eventId = input.signal.attributes?.eventId;
    if (!eventId || !this.receivedEventIds().includes(eventId)) {
      if (eventId) this.recordReceived(eventId);
      this.writeState(STATE_KEYS.latestSubmission, input.operationId);
    }
    const receipt = await this.harness.submit(renderSignal(input.signal), {
      operationId: input.operationId,
      whenBusy: "steer",
    });
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
    await root.configure(
      {
        model: { provider: "openai", modelId: manifest.model },
        thinkingLevel: manifest.effort,
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
