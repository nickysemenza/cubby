import type { CoordinatorModels } from "@cubby/schemas/coordinator-models";
import type { ImportRunAgentConfig } from "@cubby/schemas/import-run-agent";
import type { photoInventoryToolInputs } from "@cubby/schemas/purchase-agent-services";
import type { SupportedChatModel } from "@cubby/shared/ai/models";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { z } from "zod";

import { CLAIM_IMPORT_WORK_TOOL } from "./tool-protocol";

const CLAIM_TOOL = CLAIM_IMPORT_WORK_TOOL;

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
export type EscalationRequest = z.infer<
  typeof photoInventoryToolInputs.escalate_import_work
>;
const claimedEmail = z.looseObject({
  email: z.looseObject({ mailboxId: z.string(), messageId: z.string() }),
});

const KEYS = {
  item: "escalation:work-item",
  questions: (item: string) => `escalation:questions:${item}`,
};

/** The stronger model's reply to one escalated question. */
export type EscalationAnswer =
  | { answered: true; model: SupportedChatModel; answer: string }
  | { answered: false; model?: SupportedChatModel; unavailable: string };

/**
 * Per-Email escalation of a Mail import coordinator. The primary keeps the
 * conversation and every write; an escalation asks one stronger model one
 * question about the current Email and returns its answer as the tool result.
 * Switching the whole conversation re-wrote the cached prefix under the new
 * model and priced every later step at its rate (2026-11), while the answers
 * that mattered were single facts. Each Email may ask the escalation model,
 * then the quality model, once each. A work item is the Email the latest
 * `claim_next_import_work` returned (else that call); re-claiming the same
 * Email keeps its spent questions.
 */
export function coordinatorEscalation(input: {
  models: CoordinatorModels;
  store: EscalationStore;
  /** The stronger models, in the order one Email may ask them. */
  ladder: readonly SupportedChatModel[];
  /** One question to one model; resolves its text or a raw refusal. */
  ask: (
    model: SupportedChatModel,
    request: EscalationRequest,
  ) => Promise<{ text: string } | { refused: string }>;
  /**
   * Why no free source can fund an escalation now, else null. The primary
   * then settles the Email itself instead of escalating onto paid funding.
   */
  unavailable?: () => Promise<string | null>;
}) {
  const { primary } = input.models;
  const ladder = input.ladder.filter((model) => model !== primary);
  const active = ladder.length > 0;
  const { store } = input;
  const item = () => store.read(KEYS.item) ?? "";
  const asked = (key = item()) => Number(store.read(KEYS.questions(key)) ?? 0);

  async function escalate(
    request: EscalationRequest,
  ): Promise<EscalationAnswer> {
    if (!active)
      return { answered: false, unavailable: "This Run has no escalation." };
    if (
      [
        "missing_evidence",
        "member_decision",
        "source_held",
        "transient_failure",
      ].includes(request.category)
    )
      return {
        answered: false,
        unavailable:
          "This blocker needs evidence, authority or execution recovery, not a stronger model. Resolve or defer it under the owning policy.",
      };
    const spent = asked();
    const model = ladder[spent];
    if (!model)
      return {
        answered: false,
        unavailable:
          "This Email has used its stronger-model questions. Settle it with the evidence and answers you have, or resolve it unresolved with the exact gap.",
      };
    const unavailable = await input.unavailable?.();
    if (unavailable) return { answered: false, model, unavailable };
    const reply = await input.ask(model, request);
    if ("refused" in reply)
      return { answered: false, model, unavailable: reply.refused };
    store.write(KEYS.questions(item()), String(spent + 1));
    return { answered: true, model, answer: reply.text };
  }

  return {
    active,
    /** Whether the current Email has received a stronger model's answer. */
    escalated: () => asked() > 0,
    escalate,
    /** A claim changes the active item. */
    afterTool(call: ToolCall, result: ToolExecutionResult): undefined {
      if (!active || call.name !== CLAIM_TOOL) return undefined;
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
      return undefined;
    },
  };
}

export type CoordinatorEscalation = ReturnType<typeof coordinatorEscalation>;
