import type { CoordinatorModels } from "@cubby/schemas/coordinator-models";
import type { ImportRunAgentConfig } from "@cubby/schemas/import-run-agent";
import {
  supportedChatModelSchema,
  type SupportedChatModel,
} from "@cubby/shared/ai/models";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { z } from "zod";

const CLAIM_TOOL = "claim_next_import_work";
const PREPARE_TOOL = "mcp__cubby__purchase_import";
const MAIL_TOOL = "mcp__cubby__mail";
/** The refusal of one Email's `prepare` that escalates it. */
const PREPARE_REFUSAL_LIMIT = 2;

/** A purpose's models: the harness override when present, else its manifest. */
export function coordinatorModelsFor(
  manifest: Pick<ImportRunAgentConfig, "model" | "escalationModel">,
  override?: CoordinatorModels,
): CoordinatorModels {
  return (
    override ?? {
      primary: manifest.model,
      escalation: manifest.escalationModel,
    }
  );
}

/** Durable per-Run facts, kept in the coordinator's own SQLite. */
export interface EscalationStore {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
}

type ToolCall = { id: string; name: string; arguments: unknown };
type Trigger = "requested" | "prepare_refused" | "unresolved";

const escalationRecord = z.object({
  trigger: z.enum(["requested", "prepare_refused", "unresolved"]),
  detail: z.string(),
  /** The tool call that escalated, so its recovery repeats the same note. */
  callId: z.string().nullable(),
});
const modelConfiguration = z.object({
  model: supportedChatModelSchema,
  status: z.enum(["pending", "applied"]),
});
const refusedCalls = z.array(z.string());
const claimedEmail = z.looseObject({
  email: z.looseObject({ mailboxId: z.string(), messageId: z.string() }),
});
const toolArguments = z.looseObject({
  action: z.string().optional(),
  disposition: z
    .looseObject({ kind: z.string(), reason: z.string().optional() })
    .optional(),
});

const KEYS = {
  configuration: "escalation:model-configuration",
  item: "escalation:work-item",
  escalated: (item: string) => `escalation:escalated:${item}`,
  unavailable: (item: string) => `escalation:unavailable:${item}`,
  refused: (item: string) => `escalation:refused:${item}`,
  blocked: (callId: string) => `escalation:blocked:${callId}`,
};

/**
 * Per-Email escalation of a Mail import coordinator from its primary model to
 * its escalation model. A work item is the Email the latest
 * `claim_next_import_work` returned (else that call); escalation lasts until a
 * claim returns another item. Re-claiming the same unsettled Email keeps it
 * escalated: keyed by the claim call, each re-claim reset it to the primary,
 * which escalated again in a loop (2026-10-19, 194 calls on one Email). The model changes by
 * reconfiguring the conversation, so pi's request checkpoint records which
 * model each request used and a recovered request reuses it. Every decision
 * is keyed by its tool call id, so a recovered call decides as it first did.
 */
export function coordinatorEscalation(input: {
  models: CoordinatorModels;
  store: EscalationStore;
  /** Configure the conversation's model for its next request. */
  useModel: (model: SupportedChatModel) => Promise<void>;
  /**
   * Why the escalation model's funding cannot answer now (a refused Claude
   * credit, a spent window budget), else null. Escalating then would only
   * fall through the funding ladder to another model, so the primary settles
   * the Email itself.
   */
  unavailable?: (model: SupportedChatModel) => Promise<string | null>;
}) {
  const { primary } = input.models;
  const target = input.models.escalation ?? primary;
  const active = target !== primary;
  const { store } = input;
  const item = () => store.read(KEYS.item) ?? "";
  const escalated = (key = item()) => {
    const raw = store.read(KEYS.escalated(key));
    return raw ? escalationRecord.parse(JSON.parse(raw)) : undefined;
  };
  const note = (detail: string) =>
    `Cubby escalated this Email to ${target} (${detail}); ${target} settles it from here.`;

  /** Decided once per work item, so a recovered call decides as it first did. */
  async function unavailableReason(): Promise<string | null> {
    const key = KEYS.unavailable(item());
    const recorded = store.read(key);
    if (recorded !== undefined) return recorded || null;
    const reason = (await input.unavailable?.(target)) ?? null;
    store.write(key, reason ?? "");
    return reason;
  }

  const desiredModel = (): SupportedChatModel =>
    active && escalated() ? target : primary;
  function configurationIsCurrent() {
    const desired = desiredModel();
    const raw = store.read(KEYS.configuration);
    const previous = raw
      ? modelConfiguration.parse(JSON.parse(raw))
      : undefined;
    // Before the first transition the host installs the primary itself. A
    // pending attempt may have applied before throwing, so it always retries.
    return (
      (!previous && desired === primary) ||
      (previous?.status === "applied" && previous.model === desired)
    );
  }
  async function reconcileConfiguration() {
    if (configurationIsCurrent()) return;
    const desired = desiredModel();
    store.write(
      KEYS.configuration,
      JSON.stringify({ model: desired, status: "pending" }),
    );
    await input.useModel(desired);
    store.write(
      KEYS.configuration,
      JSON.stringify({ model: desired, status: "applied" }),
    );
  }

  async function escalate(request: {
    reason: Trigger;
    detail: string;
    callId?: string;
  }): Promise<{
    escalated: boolean;
    model: SupportedChatModel;
    unavailable?: string;
  }> {
    if (!active) return { escalated: false, model: primary };
    if (escalated()) {
      await reconcileConfiguration();
      return { escalated: false, model: target };
    }
    const unavailable = await unavailableReason();
    if (unavailable) return { escalated: false, model: primary, unavailable };
    store.write(
      KEYS.escalated(item()),
      JSON.stringify(
        escalationRecord.parse({
          trigger: request.reason,
          detail: request.detail,
          callId: request.callId ?? null,
        }),
      ),
    );
    await reconcileConfiguration();
    return { escalated: true, model: target };
  }

  return {
    active,
    /** The model this Run's next request uses. */
    model: desiredModel,
    escalate,
    /** Hold a primary model's `unresolved` resolution for one escalated try. */
    async beforeTool(call: ToolCall): Promise<{ block: string } | undefined> {
      if (!active || call.name !== MAIL_TOOL) return undefined;
      const args = toolArguments.safeParse(call.arguments).data;
      if (args?.action !== "resolve" || args.disposition?.kind !== "unresolved")
        return undefined;
      const blocked = store.read(KEYS.blocked(call.id));
      if (blocked) {
        await escalate({
          reason: "unresolved",
          detail: args.disposition.reason ?? "unresolved",
          callId: call.id,
        });
        return { block: blocked };
      }
      if (escalated() && configurationIsCurrent()) return undefined;
      if (!escalated() && (await unavailableReason())) return undefined;
      // Pi can complete a failed beforeTool call as an error and let the
      // primary retry with a new ID. Persist its hold before reconciliation,
      // so recovery cannot mistake that primary-authored call for a stronger turn.
      const block = `${note("before resolving it unresolved")} Review its evidence before resolving it.`;
      store.write(KEYS.blocked(call.id), block);
      await escalate({
        reason: "unresolved",
        detail: args.disposition.reason ?? "unresolved",
        callId: call.id,
      });
      return { block };
    },
    /** Start a work item at each claim; count refused prepares per item. */
    async afterTool(
      call: ToolCall,
      result: ToolExecutionResult,
    ): Promise<ToolExecutionResult | undefined> {
      if (!active) return undefined;
      if (call.name === CLAIM_TOOL) {
        const text = result.output?.find((part) => part.type === "text");
        let claimed: unknown;
        try {
          claimed = text && "text" in text ? JSON.parse(text.text) : undefined;
        } catch {
          // SILENT: an unparseable claim result keys the item by its call.
        }
        const email = claimedEmail.safeParse(claimed).data?.email;
        const key = email
          ? `email:${email.mailboxId}:${email.messageId}`
          : call.id;
        if (item() !== key) store.write(KEYS.item, key);
        await reconcileConfiguration();
        return undefined;
      }
      if (
        call.name !== PREPARE_TOOL ||
        toolArguments.safeParse(call.arguments).data?.action !== "prepare" ||
        result.isError !== true ||
        heldByAnotherRun(result)
      )
        return undefined;
      const current = escalated();
      const withNote = () => ({
        ...result,
        output: [
          ...(result.output ?? []),
          { type: "text" as const, text: note("prepare refused twice") },
        ],
      });
      if (current) {
        await reconcileConfiguration();
        return current.callId === call.id ? withNote() : undefined;
      }
      const raw = store.read(KEYS.refused(item()));
      const refused = new Set(raw ? refusedCalls.parse(JSON.parse(raw)) : []);
      refused.add(call.id);
      store.write(KEYS.refused(item()), JSON.stringify([...refused]));
      if (refused.size < PREPARE_REFUSAL_LIMIT) return undefined;
      const outcome = await escalate({
        reason: "prepare_refused",
        detail: "prepare refused twice",
        callId: call.id,
      });
      return outcome.escalated ? withNote() : undefined;
    },
  };
}

/**
 * Another Run holding a supporting original is not a hard Email: the stronger
 * model meets the same refusal, so it never counts toward escalation.
 */
function heldByAnotherRun(result: ToolExecutionResult) {
  return (result.output ?? []).some(
    (part) =>
      part.type === "text" && part.text.includes("MAIL_SOURCE_HELD_BY_RUN"),
  );
}

export type CoordinatorEscalation = ReturnType<typeof coordinatorEscalation>;
