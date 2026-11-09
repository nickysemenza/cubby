import type { CoordinatorModels } from "@cubby/schemas/coordinator-models";
import type { ImportRunAgentConfig } from "@cubby/schemas/import-run-agent";
import type { photoInventoryToolInputs } from "@cubby/schemas/purchase-agent-services";
import {
  storedChatModelSchema,
  type SupportedChatModel,
} from "@cubby/shared/ai/models";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { z } from "zod";

const CLAIM_TOOL = "claim_next_import_work";

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
type EscalationRequest = z.infer<
  typeof photoInventoryToolInputs.escalate_import_work
>;
// Old decisions remain readable when a running coordinator resumes after cutover.
const escalationRecord = z.object({
  trigger: z.enum(["requested", "prepare_refused", "unresolved"]),
  detail: z.string(),
  callId: z.string().nullable(),
  /** The model the decision selected; older decisions may name a retired one. */
  model: storedChatModelSchema.optional(),
});
const modelConfiguration = z.object({
  model: storedChatModelSchema,
  status: z.enum(["pending", "applied"]),
});
const claimedEmail = z.looseObject({
  email: z.looseObject({ mailboxId: z.string(), messageId: z.string() }),
});

const KEYS = {
  configuration: "escalation:model-configuration",
  item: "escalation:work-item",
  escalated: (item: string) => `escalation:escalated:${item}`,
  unavailable: (item: string) => `escalation:unavailable:${item}`,
};

/**
 * Per-Email escalation of a Mail import coordinator from its primary model to
 * its escalation model. A work item is the Email the latest
 * `claim_next_import_work` returned (else that call); escalation lasts until a
 * claim returns another item. Re-claiming the same unsettled Email keeps it
 * escalated: keyed by the claim call, each re-claim reset it to the primary,
 * which escalated again in a loop (2026-10-19, 194 calls on one Email). The model changes by
 * reconfiguring the conversation, so pi's request checkpoint records which
 * model each request used and a recovered request reuses it. The decision
 * belongs to the Email, so a new claim cannot reset its escalation.
 */
export function coordinatorEscalation(input: {
  models: CoordinatorModels;
  store: EscalationStore;
  /** Configure the conversation's model for its next request. */
  useModel: (model: SupportedChatModel) => Promise<void>;
  /**
   * Why no free source can fund the escalation now, else null. The primary
   * then settles the Email itself instead of escalating onto paid funding.
   */
  unavailable?: () => Promise<string | null>;
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
  /** Decided once per work item, so a recovered call decides as it first did. */
  async function unavailableReason(): Promise<string | null> {
    const key = KEYS.unavailable(item());
    const recorded = store.read(key);
    if (recorded !== undefined) return recorded || null;
    const reason = (await input.unavailable?.()) ?? null;
    store.write(key, reason ?? "");
    return reason;
  }

  const desiredModel = (): SupportedChatModel => {
    const saved = escalated();
    return active && saved ? (saved.model ?? target) : primary;
  };
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

  async function escalate(request: EscalationRequest): Promise<{
    escalated: boolean;
    model: SupportedChatModel;
    unavailable?: string;
  }> {
    if (!active) return { escalated: false, model: primary };
    if (
      [
        "missing_evidence",
        "member_decision",
        "source_held",
        "transient_failure",
      ].includes(request.category)
    ) {
      return {
        escalated: false,
        model: desiredModel(),
        unavailable:
          "This blocker needs evidence, authority or execution recovery, not a stronger model. Resolve or defer it under the owning policy.",
      };
    }
    if (escalated()) {
      await reconcileConfiguration();
      return { escalated: false, model: desiredModel() };
    }
    const unavailable = await unavailableReason();
    if (unavailable) return { escalated: false, model: primary, unavailable };
    store.write(
      KEYS.escalated(item()),
      JSON.stringify(
        escalationRecord.parse({
          trigger: "requested",
          detail: `${request.category}: ${request.reason}`,
          callId: null,
          model: target,
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
    /** A claim changes the active item; unresolved writes never force escalation. */
    async afterTool(
      call: ToolCall,
      result: ToolExecutionResult,
    ): Promise<undefined> {
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
      return undefined;
    },
  };
}

export type CoordinatorEscalation = ReturnType<typeof coordinatorEscalation>;
