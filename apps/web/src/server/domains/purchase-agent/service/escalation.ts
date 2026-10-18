import type { CoordinatorModels } from "@cubby/schemas/coordinator-models";
import type { ImportRunAgentConfig } from "@cubby/schemas/import-run-agent";
import type { SupportedChatModel } from "@cubby/shared/ai/models";
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
const refusedCalls = z.array(z.string());
const toolArguments = z.looseObject({
  action: z.string().optional(),
  disposition: z
    .looseObject({ kind: z.string(), reason: z.string().optional() })
    .optional(),
});

const KEYS = {
  item: "escalation:work-item",
  escalated: (item: string) => `escalation:escalated:${item}`,
  refused: (item: string) => `escalation:refused:${item}`,
  blocked: (callId: string) => `escalation:blocked:${callId}`,
};

/**
 * Per-Email escalation of a Mail import coordinator from its primary model to
 * its escalation model. A work item is the latest `claim_next_import_work`
 * call; escalation lasts until the next claim. The model changes by
 * reconfiguring the conversation, so pi's request checkpoint records which
 * model each request used and a recovered request reuses it. Every decision
 * is keyed by its tool call id, so a recovered call decides as it first did.
 */
export function coordinatorEscalation(input: {
  models: CoordinatorModels;
  store: EscalationStore;
  /** Configure the conversation's model for its next request. */
  useModel: (model: SupportedChatModel) => Promise<void>;
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

  async function escalate(request: {
    reason: Trigger;
    detail: string;
    callId?: string;
  }): Promise<{ escalated: boolean; model: SupportedChatModel }> {
    if (!active || escalated())
      return { escalated: false, model: active ? target : primary };
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
    await input.useModel(target);
    return { escalated: true, model: target };
  }

  return {
    active,
    /** The model this Run's next request uses. */
    model: (): SupportedChatModel => (active && escalated() ? target : primary),
    escalate,
    /** Hold a primary model's `unresolved` resolution for one escalated try. */
    async beforeTool(call: ToolCall): Promise<{ block: string } | undefined> {
      if (!active || call.name !== MAIL_TOOL) return undefined;
      const args = toolArguments.safeParse(call.arguments).data;
      if (args?.action !== "resolve" || args.disposition?.kind !== "unresolved")
        return undefined;
      const blocked = store.read(KEYS.blocked(call.id));
      if (blocked) return { block: blocked };
      if (escalated()) return undefined;
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
        const previous = item();
        if (previous === call.id) return undefined;
        store.write(KEYS.item, call.id);
        if (escalated(previous)) await input.useModel(primary);
        return undefined;
      }
      if (
        call.name !== PREPARE_TOOL ||
        toolArguments.safeParse(call.arguments).data?.action !== "prepare" ||
        result.isError !== true
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
      if (current) return current.callId === call.id ? withNote() : undefined;
      const raw = store.read(KEYS.refused(item()));
      const refused = new Set(raw ? refusedCalls.parse(JSON.parse(raw)) : []);
      refused.add(call.id);
      store.write(KEYS.refused(item()), JSON.stringify([...refused]));
      if (refused.size < PREPARE_REFUSAL_LIMIT) return undefined;
      await escalate({
        reason: "prepare_refused",
        detail: "prepare refused twice",
        callId: call.id,
      });
      return withNote();
    },
  };
}

export type CoordinatorEscalation = ReturnType<typeof coordinatorEscalation>;
