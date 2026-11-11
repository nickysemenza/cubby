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
  ESCALATE_TOOL,
  EXTRACT_ORDER_TOOL,
  importRunAgentIdentity,
  importRunAgentManifest,
} from "@cubby/schemas/import-run-agent";
import { mailMessageRef } from "@cubby/schemas/mailbox-research";
import { preparePurchaseImportInput } from "@cubby/schemas/purchase-import";
import {
  runProgressStamp,
  type RunProgressStamp,
} from "@cubby/schemas/run-fields";
import type { AiUsageTransport } from "@cubby/schemas/telemetry";
import {
  classifyFundingRefusal,
  paidFundingRefusal,
} from "@cubby/shared/ai/funding-refusal";
import type { GatewayResponseInfo } from "@cubby/shared/ai/gateway-request";
import {
  storedChatModelSchema,
  type SupportedChatModel,
} from "@cubby/shared/ai/models";
import { piTokenUsage } from "@cubby/shared/ai/pi-providers";
import { sha256Hex } from "@cubby/shared/sha256";
import { createLogger } from "@cubby/worker-tracing";
import type { Context } from "@earendil-works/chord";
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
  ToolTask,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
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
import {
  CONTEXT_SCOPE,
  cubbyAgentModel,
  cubbyAgentProviders,
} from "./cubby-ai-provider";
import {
  cubbyMcpExtension,
  settleMailAttemptLimit,
  mailWriterOutcome,
} from "./cubby-mcp";
import type {
  DispatchInput,
  PurchaseAgentEnvironment,
  PurchaseImportRunAgentRpc,
  RunServices,
} from "./environment";
import {
  coordinatorEscalation,
  coordinatorModelsFor,
  type CoordinatorEscalation,
} from "./escalation";
import {
  importExtractedOrderTool,
  extractedOrderInput,
} from "./import-order-tool";
import { workflowForRun } from "./import-run-workflows";
import { mailAttempts, isMailExtractionCall } from "./mail-attempts";
import { readPiModelUsage } from "./model-usage";
import { RunSettlement, SETTLEMENT_POLL_MS } from "./run-settlement";
import { renderSignal } from "./signals";
import { CLAIM_IMPORT_WORK_TOOL } from "./tool-protocol";
import { continueMailImportOnYield, runAgentTools } from "./tools";
import {
  currentPhotoWorkItemMessages,
  currentWorkItemMessages,
} from "./work-item-context";

const log = createLogger("purchase-agent");
const context = BACKGROUND_CONTEXT;

const runIdentity = z.object({
  runId: z.uuid(),
  purpose: agentImportRunPurpose,
  /** The Run's recorded coordinator model; a transient retry records its escalation model. */
  model: storedChatModelSchema.optional(),
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

/**
 * Model requests one Mail source may consume in a Run before it settles
 * unresolved. Escalated receipts take about 15; a re-claim loop took hundreds.
 */
const MAX_REQUESTS_PER_MAIL_SOURCE = 16;

/** Mutable per-run facts kept in this object's SQLite, beside pi's tables. */
const STATE_KEYS = {
  identity: "identity",
  latestSubmission: "latest_submission",
  receivedEvents: "received_events",
  progressSequence: "progress_sequence",
  /** The submission whose last model turn found no paid funding, if any. */
  fundingUnavailable: "funding_unavailable",
  /** The latest submission's last model error or failed tool result text. */
  lastFailure: "last_failure",
} as const;

const recordedFailure = z.object({ operationId: z.string(), text: z.string() });

/**
 * One import Run's coordinator: a pi-durable conversation hosted on this
 * Durable Object's SQLite by `PiHarness`. pi owns the transcript, retries,
 * and crash recovery; this class supplies Cubby's tools, the run's identity,
 * the conversation projection the run page reads, and settlement reports.
 *
 * The exported Durable Object (`server/domains/purchase-import/operations/agent-host.ts`) loads
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
  /** The installed Run's per-Email escalation; set with its extensions. */
  private escalation: CoordinatorEscalation | undefined;
  private requestStartedAt = 0;
  /** What carried the current model request; the coordinator runs one at a time. */
  private requestTransport: AiUsageTransport = "unknown";
  /** The current request's last gateway response, for its usage row. */
  private requestGateway: GatewayResponseInfo | undefined;

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
      progressStamp: (operationId) => {
        const stampKey = `settlement-progress-stamp:${operationId}`;
        const persisted = this.readState(stampKey);
        if (persisted) return runProgressStamp.parse(JSON.parse(persisted));
        const generation = this.readState(
          `submission-generation:${operationId}`,
        );
        if (!generation)
          throw new Error("Settlement has no admitted progress generation");
        const stamp = this.allocateProgressStamp(generation);
        this.writeState(stampKey, JSON.stringify(stamp));
        return stamp;
      },
      receivedEventIds: () => this.receivedEventIds(),
      fundingUnavailable: (operationId) =>
        this.readState(STATE_KEYS.fundingUnavailable) === operationId,
      lastFailure: (operationId) => {
        const raw = this.readState(STATE_KEYS.lastFailure);
        const recorded = raw
          ? recordedFailure.safeParse(JSON.parse(raw)).data
          : undefined;
        return recorded?.operationId === operationId
          ? recorded.text
          : undefined;
      },
    },
    () => this.agentEnv.settlementPollMs ?? SETTLEMENT_POLL_MS,
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

  /**
   * Whether pi has work running. pi keeps working in memory after the entry
   * point that started it returns, so the host keeps its coordinator turn
   * until this is false. Call only once the agent has started (pi is open).
   */
  async working(): Promise<boolean> {
    return (await this.harness.pi()).wake().active;
  }

  /** External retirement waits for the terminating tool; cold disposal must not reopen pi. */
  async abortForRetirement(): Promise<void> {
    if (this.identity()) await this.harness.abort();
  }

  private services(): RunServices {
    return this.agentEnv.services;
  }

  private allocateProgressStamp(generation: string): RunProgressStamp {
    const sequence =
      Number(this.readState(STATE_KEYS.progressSequence) ?? "0") + 1;
    this.writeState(STATE_KEYS.progressSequence, String(sequence));
    return runProgressStamp.parse({ generation, sequence });
  }

  /** The dispatch generation of the request that issued a tool call. */
  private async toolGeneration(
    api: Pick<ToolExecutionApi, "taskId">,
    context: Context,
  ): Promise<string | undefined> {
    const direct = this.readState(`request-generation:${api.taskId}`);
    if (direct) return direct;
    const pi = await this.harness.pi();
    let task = await pi.getTask(api.taskId, context);
    // A nested writer belongs to its parent tool, then to the issuing
    // generation. Keep the same generation fence at every depth.
    while (task?.owner) {
      const generation = this.readState(`request-generation:${task.owner}`);
      if (generation) return generation;
      task = await pi.getTask(task.owner, context);
    }
    return undefined;
  }

  private async toolProgressStamp(
    api: ToolExecutionApi,
    context: Context,
  ): Promise<RunProgressStamp> {
    const existing = await api.memo("progress-stamp", context);
    if (existing) return runProgressStamp.parse(existing);
    const generation = await this.toolGeneration(api, context);
    if (!generation)
      throw new Error("Progress tool has no originating request generation");
    const stamp = this.allocateProgressStamp(generation);
    return runProgressStamp.parse(
      await api.memo("progress-stamp", stamp, context),
    );
  }

  private report<TError>(error: TError): void {
    log.error("purchase agent operation failed", { error });
    Sentry.captureException(error);
  }

  // ---- pi ---------------------------------------------------------------

  private async openPi({ storage, context: open, onWake }: PiHarnessContext) {
    const models = createModels();
    const identity = this.identity();
    for (const provider of cubbyAgentProviders({
      fundingFallback: true,
      fixedModel: this.agentEnv.fixedModel,
      // A harness override measures its named models, never tier substitutes.
      pinnedModel: this.agentEnv.coordinatorModels !== undefined,
      cacheKey: () => this.identity()?.runId,
      onFundingRefusal: async (message, { local }) => {
        // The usage row records the refusal text in `failure`; Cubby's own
        // refusal made no provider call and records nothing.
        if (!local) await this.afterResponse(message);
        // The next rung is a new attempt: its usage row must not inherit this
        // rung's transport, start time or gateway log.
        this.requestStartedAt = Date.now();
        this.requestTransport = "unknown";
        this.requestGateway = undefined;
      },
      gateway: () => this.agentEnv.gateway(),
      recorder: this.recorder,
      testModel: this.agentEnv.testModel,
      subscription: this.agentEnv.chatGptInference,
      transportPolicy: () => {
        const photo = this.identity()?.purpose === "photo_inventory";
        return {
          subscriptionRequired: !photo,
          subscriptionFallback: photo ? undefined : "budgeted",
          beforePaidRequest: (request) =>
            this.services().admitPaidInference(request),
          beforePlanRequest: (request) =>
            this.services().admitPlanInference(request),
        };
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
        // agents ≥0.32 / pi-durable ≥1.4: pass onWake so sleeps hibernate the DO
        // instead of retaining in-memory timers.
        onWake,
      },
      open,
    );
  }

  private async installRunExtensions(identity: RunIdentity): Promise<void> {
    if (this.installed === identity.runId) return;
    const { runId, purpose } = identity;
    const manifest = importRunAgentManifest[purpose];
    // A transient-failure retry records its escalation model as the Run's
    // coordinator; equal primary and escalation turns escalation off.
    const models = coordinatorModelsFor(
      identity.model && !this.agentEnv.coordinatorModels
        ? { ...manifest, model: identity.model }
        : manifest,
      this.agentEnv.coordinatorModels,
    );
    const escalation = coordinatorEscalation({
      models,
      store: {
        read: (key) => this.readState(key),
        write: (key, value) => this.writeState(key, value),
      },
      useModel: (model) => this.useModel(model),
      unavailable: () => this.services().escalationUnavailable(),
    });
    const attempts =
      purpose === "mail_import"
        ? mailAttempts({
            read: (key) => this.readState(key),
            write: (key, value) => this.writeState(key, value),
          })
        : undefined;
    const reserveExtraction = async (
      call: Pick<
        import("@earendil-works/pi-ai").ToolCall,
        "id" | "name" | "arguments"
      >,
      api: Pick<ToolExecutionApi, "taskId">,
      context: Context,
      accountingOnly = false,
    ) => {
      if (!attempts) return;
      const source = attempts.source();
      const generation = await this.toolGeneration(api, context);
      if (!source?.evidenceVersion || !generation)
        return {
          block: "Claim current trusted Email evidence before extracting.",
        };
      // A route handoff is not a failed extraction. Apply this before both
      // malformed-call accounting and writer admission so exception repair keeps its budget.
      const extractionBlock = attempts.extractionBlock(call.name);
      if (extractionBlock) return { block: extractionBlock };
      const named = z
        .object({
          mail: mailMessageRef.extend({ checksum: z.string().optional() }),
        })
        .safeParse(call.arguments);
      const namedOrders = z
        .object({
          orders: z.array(
            z.object({
              source: z.unknown(),
              evidenceChecksum: z.string().optional(),
            }),
          ),
        })
        .safeParse(call.arguments.input);
      const foreignMail =
        named.success &&
        (named.data.mail.mailboxId !== source.mailboxId ||
          named.data.mail.messageId !== source.messageId ||
          (named.data.mail.checksum !== undefined &&
            named.data.mail.checksum !== source.checksum));
      const foreignOrder =
        namedOrders.success &&
        namedOrders.data.orders.some((order) => {
          const mail = z
            .object({
              kind: z.literal("mail_message"),
              externalKey: z.string(),
              checksum: z.string().optional(),
            })
            .safeParse(order.source);
          return (
            mail.success &&
            (mail.data.externalKey !==
              `gmail:${source.mailboxId}:${source.messageId}` ||
              (mail.data.checksum !== undefined &&
                mail.data.checksum !== source.checksum) ||
              (order.evidenceChecksum !== undefined &&
                order.evidenceChecksum !== source.checksum))
          );
        });
      if (foreignMail || foreignOrder)
        return {
          block:
            "This extraction names a different Email or checksum. Claim its current evidence before extracting; no attempt was charged.",
        };
      this.writeState(`mail-attempt-source:${call.id}`, JSON.stringify(source));
      const stage =
        escalation.active && escalation.model() !== models.primary
          ? "escalation"
          : "primary";
      const identity = await extractionIdentity(call);
      const proposal =
        call.name === EXTRACT_ORDER_TOOL
          ? extractedOrderInput.safeParse(call.arguments)
          : undefined;
      const admitted = await this.services().mailAttempt({
        source: { ...source, evidenceVersion: source.evidenceVersion },
        generation,
        identity,
        invocation: call.id,
        publicationPossible: validExtraction(call),
        proposal: proposal?.success
          ? z
              .record(z.string(), z.json())
              .parse(JSON.parse(JSON.stringify(proposal.data)))
          : undefined,
        stage,
        action: "admit",
      });
      if (admitted.kind === "admitted") return;
      if (admitted.kind === "pending")
        return {
          block:
            "An earlier write outcome is pending. Claim the Email to recover its retained proposal, then replay its exact tool and arguments before changing extraction.",
        };
      if (accountingOnly) {
        this.writeState("mail-attempt-limit-pending", JSON.stringify(source));
        return;
      }

      const settlement = await settleMailAttemptLimit({
        services: () => this.services(),
        runId,
        source,
        generation,
      });
      if (settlement.kind === "refused")
        return {
          block: `Attempt exhaustion settlement was refused: ${settlement.diagnostic}. Re-claim the current evidence and resolve the supported gap through mail_resolve; do not retry extraction for this unchanged source.`,
        };
      return {
        block:
          "This Email reached its durable extraction attempt limit. Claim the next Email; do not prepare this source again.",
      };
    };
    this.escalation = escalation;
    const workflow = workflowForRun(purpose, runId, {
      escalation: escalation.active,
    });
    const agentTools = new Set<string>(manifest.agentTools);
    this.registry.install(
      defineExtension({
        name: "cubby.run",
        tools: [
          ...runAgentTools(
            () => this.services(),
            (api, context) => this.toolProgressStamp(api, context),
            purpose,
            (error) => this.report(error),
            (request) => escalation.escalate(request),
          ),
          ...(attempts
            ? [importExtractedOrderTool(runId, attempts.ordinaryEvidence)]
            : []),
        ].filter(
          (tool) =>
            agentTools.has(tool.name) &&
            (tool.name !== ESCALATE_TOOL || escalation.active),
        ),
        hooks: [
          ...(attempts || escalation.active
            ? [
                hook(ToolTask, {
                  beforeTool: (call, api, context) => {
                    if (!attempts || call.parent || !isMailExtractionCall(call))
                      return;
                    return reserveExtraction(call, api, context);
                  },
                  afterTool: async (call, result, api, context) => {
                    if (result.isError)
                      this.recordFailure(
                        `${call.name}: ${
                          result.output
                            ?.flatMap((part) =>
                              part.type === "text" ? [part.text] : [],
                            )
                            .join("\n") || "tool error"
                        }`,
                      );
                    if (
                      attempts &&
                      !call.parent &&
                      isMailExtractionCall(call)
                    ) {
                      const savedSource = this.readState(
                        `mail-attempt-source:${call.id}`,
                      );
                      const source = savedSource
                        ? z
                            .object({
                              mailboxId: z.string(),
                              messageId: z.string(),
                              checksum: z.string(),
                              evidenceVersion: z.string(),
                            })
                            .parse(JSON.parse(savedSource))
                        : undefined;
                      const generation = await this.toolGeneration(
                        api,
                        context,
                      );
                      if (source?.evidenceVersion && generation) {
                        const failure = z
                          .object({ stage: z.enum(["prepare", "commit"]) })
                          .safeParse(result.structuredOutput);
                        const stage =
                          call.name === EXTRACT_ORDER_TOOL
                            ? (failure.data?.stage ?? "commit")
                            : "prepare";
                        const action = mailWriterOutcome({ result, stage });
                        await this.services().mailAttempt({
                          source: {
                            ...source,
                            evidenceVersion: source.evidenceVersion,
                          },
                          generation,
                          identity: await extractionIdentity(call),
                          invocation: call.id,
                          publicationPossible: validExtraction(call),
                          stage:
                            escalation.active &&
                            escalation.model() !== models.primary
                              ? "escalation"
                              : "primary",
                          action,
                        });
                      }
                    }
                    if (attempts && call.name === CLAIM_IMPORT_WORK_TOOL) {
                      const text = result.output?.find(
                        (part) => part.type === "text",
                      );
                      let value: unknown;
                      try {
                        value =
                          text?.type === "text"
                            ? JSON.parse(text.text)
                            : undefined;
                      } catch {
                        // SILENT: an unreadable claim grants no source budget.
                      }
                      attempts.observeClaim(value);
                    }
                    return escalation.afterTool(call, result);
                  },
                }),
              ]
            : []),
          hook(GenerationTask, {
            beforeRequest: async (request, api, requestContext) => {
              const live = await api.snapshot(
                LiveDoc,
                api.conversationId,
                requestContext,
              );
              const inputId = live?.run?.inputs.at(-1);
              const submission = inputId
                ? await (
                    await this.harness.pi()
                  ).submission(inputId, requestContext)
                : undefined;
              const input = submission
                ? await submission.status(requestContext)
                : undefined;
              const generation = input?.requestId
                ? this.readState(`submission-generation:${input.requestId}`)
                : undefined;
              if (!generation)
                throw new Error(
                  "Request has no originating submission generation",
                );
              const memo = await api.memo(
                "progress-generation",
                { generation },
                requestContext,
              );
              this.writeState(
                `request-generation:${api.taskId}`,
                z.object({ generation: z.string() }).parse(memo).generation,
              );
              let settlementRefusal: string | undefined;
              const exhausted = this.readState("mail-attempt-limit-pending");
              if (attempts && exhausted) {
                const source = z
                  .object({
                    mailboxId: z.string(),
                    messageId: z.string(),
                    checksum: z.string(),
                    evidenceVersion: z.string().optional(),
                  })
                  .parse(JSON.parse(exhausted));
                const settlement = await settleMailAttemptLimit({
                  services: () => this.services(),
                  runId,
                  source,
                  generation,
                });
                if (settlement.kind === "refused")
                  settlementRefusal = settlement.diagnostic;
                this.writeState("mail-attempt-limit-pending", "");
              }
              let requestLimitSettled = false;
              const current = attempts?.source();
              if (current) {
                // Attempt budgets only count writer submissions; a model that
                // keeps re-claiming or retrying blocked calls never spends one.
                const key = `mail-source-requests:${current.mailboxId}:${current.messageId}:${current.checksum}`;
                const recorded = this.readState(key);
                const requests =
                  recorded === "settled" ? 0 : Number(recorded ?? 0) + 1;
                if (recorded !== "settled")
                  this.writeState(key, String(requests));
                if (requests > MAX_REQUESTS_PER_MAIL_SOURCE) {
                  const settlement = await settleMailAttemptLimit({
                    services: () => this.services(),
                    runId,
                    source: current,
                    generation,
                  });
                  if (settlement.kind === "refused")
                    settlementRefusal = settlement.diagnostic;
                  else {
                    this.writeState(key, "settled");
                    requestLimitSettled = true;
                  }
                }
              }
              this.requestStartedAt = Date.now();
              this.requestTransport = "unknown";
              this.requestGateway = undefined;
              const messages =
                manifest.workItemContext === "current"
                  ? currentWorkItemMessages(request.messages)
                  : currentPhotoWorkItemMessages(request.messages);
              if (settlementRefusal)
                return {
                  messages: [
                    ...messages,
                    {
                      role: "user" as const,
                      timestamp: Date.now(),
                      content: `Automatic exhaustion settlement was refused: ${settlementRefusal}. Re-claim the current evidence and resolve the supported gap through mail_resolve; do not retry extraction for this unchanged source.`,
                    },
                  ],
                };
              if (requestLimitSettled)
                return {
                  messages: [
                    ...messages,
                    {
                      role: "user" as const,
                      timestamp: Date.now(),
                      content:
                        "This Email reached its per-Email request limit and was settled unresolved for review. Claim the next Email; do not work on this source again.",
                    },
                  ],
                };
              return { messages };
            },
            afterResponse: async (message, api, context) => {
              await this.afterResponse(message);
              // ToolTask validates before beforeTool. Count malformed model
              // submissions here too, but not transient failed generations.
              if (attempts && message.stopReason === "toolUse") {
                for (const part of message.content) {
                  if (part.type === "toolCall" && isMailExtractionCall(part)) {
                    try {
                      await reserveExtraction(part, api, context, true);
                    } catch (error) {
                      // ToolTask repeats admission before any writer. Accounting
                      // failure cannot authorize a write or strand the generation.
                      this.report(error);
                    }
                  }
                }
              }
            },
            onYield: (_answer, api, context) =>
              purpose === "mail_import"
                ? continueMailImportOnYield({
                    services: this.services(),
                    api,
                    context,
                    generation: this.readState(
                      `request-generation:${api.taskId}`,
                    ),
                  })
                : undefined,
          }),
        ],
      }),
    );
    const mcpTools = await this.agentEnv.mcpTools(purpose);
    this.registry.install(
      cubbyMcpExtension(
        mcpTools,
        () => this.services(),
        (api, context) => this.toolGeneration(api, context),
        purpose === "mail_import" ? runId : undefined,
      ),
    );
    if (workflow.skills)
      this.registry.install(await piSkills([workflow.skills]));
    this.installed = runId;
  }

  private async afterResponse(message: AssistantMessage) {
    // Durable and bound to one submission, unlike the usage row below, which may
    // not be written: a later attempt must not inherit this turn's funding stop.
    const errorText = message.errorMessage ?? "";
    // A credit refusal that survives the funding ladder is terminal: park the
    // Run for funding instead of failing it and releasing its Emails. An
    // Anthropic turn's Claude credit refusal is a different rung.
    this.writeState(
      STATE_KEYS.fundingUnavailable,
      message.stopReason === "error" &&
        (paidFundingRefusal(errorText) !== null ||
          (message.provider !== "anthropic" &&
            classifyFundingRefusal({
              text: errorText,
              funding: "openai_credit",
            }) !== null))
        ? (this.readState(STATE_KEYS.latestSubmission) ?? "")
        : "",
    );
    // The settlement classifies a failed submission from the errors since its
    // last answered model turn.
    if (message.stopReason === "error")
      this.recordFailure(message.errorMessage || "model error without text");
    else this.writeState(STATE_KEYS.lastFailure, "");
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
        failure:
          message.stopReason === "error"
            ? message.errorMessage || undefined
            : undefined,
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

  /** Durable and bound to the latest submission, like the funding stop. */
  private recordFailure(text: string) {
    this.writeState(
      STATE_KEYS.lastFailure,
      JSON.stringify({
        operationId: this.readState(STATE_KEYS.latestSubmission) ?? "",
        text: text.slice(0, 4_000),
      }),
    );
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
    const signal = input.signal;
    const eventId = signal.attributes?.eventId;
    if (!eventId || !this.receivedEventIds().includes(eventId)) {
      if (eventId) this.recordReceived(eventId);
      this.writeState(
        `submission-generation:${input.operationId}`,
        input.generation,
      );
      this.writeState(STATE_KEYS.latestSubmission, input.operationId);
    }
    const receipt = await this.harness.submit(renderSignal(signal), {
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
    const escalation = this.escalation;
    if (!escalation) throw new Error("Run extensions were not installed");
    const root = await (await this.harness.pi()).root(context);
    await root.configure(
      {
        // A resumed Run keeps an escalated Email on its escalation model.
        model: cubbyAgentModel(escalation.model(), this.agentEnv.fixedModel),
        thinkingLevel: manifest.effort,
        instructions: workflowForRun(identity.purpose, identity.runId, {
          escalation: escalation.active,
        }).instructions,
      },
      context,
    );
  }

  /** The model of the conversation's next request (`escalation.ts`). */
  private async useModel(model: SupportedChatModel): Promise<void> {
    const root = await (await this.harness.pi()).root(context);
    await root.configure(
      { model: cubbyAgentModel(model, this.agentEnv.fixedModel) },
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
    return {
      ...projectConversation({
        entries,
        running: live?.run !== undefined,
        settlements,
        contextCalls,
        partial,
      }),
      modelUsage: readPiModelUsage(this.ctx.storage.sql),
    };
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
    // The watch only signals change; each frame re-reads the whole snapshot,
    // so the smallest window keeps the watch's own copy small.
    const watch = await root.watch(context, { min: 1 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      void watch.stop();
    };
    request.signal.addEventListener("abort", close);
    return eventStream(
      new ReadableStream({
        start: (controller) => {
          controller.enqueue(first);
          watch.start(async () => {
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

// The writer owns envelope and cross-order validation. Identity only needs the
// extraction facts; Zod cannot omit fields from the refined writer schema.
const preparationFacts = z.object({
  orders: preparePurchaseImportInput.shape.orders,
});

function validExtraction(
  call: Pick<import("@earendil-works/pi-ai").ToolCall, "name" | "arguments">,
) {
  return call.name === EXTRACT_ORDER_TOOL
    ? extractedOrderInput.safeParse(call.arguments).success
    : preparationFacts.safeParse(call.arguments.input).success;
}

// A free-text explanation does not change what a write publishes. Hashing it
// made every reworded replay a changed extraction, which a pending attempt
// blocks forever (2026-11-11).
type ExtractionOutcome = z.output<
  typeof preparePurchaseImportInput.shape.orders.element.shape.extraction
>;
const extractionFacts = (extraction: ExtractionOutcome) =>
  Object.fromEntries(
    Object.entries(extraction).filter(([key]) => key !== "detail"),
  );

async function extractionIdentity(
  call: Pick<
    import("@earendil-works/pi-ai").ToolCall,
    "id" | "name" | "arguments"
  >,
) {
  const parsed = extractedOrderInput.safeParse(call.arguments);
  if (parsed.success)
    return sha256Hex(
      JSON.stringify({
        ...parsed.data,
        extraction: extractionFacts(parsed.data.extraction),
      }),
    );
  const prepared = preparationFacts.safeParse(call.arguments.input);
  if (prepared.success)
    return sha256Hex(
      JSON.stringify(
        prepared.data.orders.map((order) => ({
          source: order.source,
          evidenceChecksum: order.evidenceChecksum,
          vendorId: order.vendorId,
          vendor: order.vendor,
          targetPurchaseId: order.targetPurchaseId,
          distinctFromPurchases: order.distinctFromPurchases,
          extraction: extractionFacts(order.extraction),
        })),
      ),
    );
  // Repeated malformed submissions consume distinct slots.
  return call.id;
}
