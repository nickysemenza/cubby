import type { gatewayQuery } from "@cubby/shared/ai-gateway-request";
import { z } from "zod";

import { getChatGptPlanNamespace } from "../../cf-env";
import type { ChatGptPlanRpc } from "./rpc";
import { chatGptInferenceDeadline, chatGptResponseLifetime } from "./rpc";

const inferenceBody = z.looseObject({ model: z.string().min(1) });

/** Household-wide connection, including unattended jobs without a user session. */
export function chatGptPlan(): ChatGptPlanRpc | undefined {
  return getChatGptPlanNamespace()?.getByName("household");
}

export async function chatGptInference(
  body: Awaited<ReturnType<typeof gatewayQuery>>,
  options?: { signal?: AbortSignal; requestTimeoutMs?: number },
): Promise<Response | null> {
  const plan = chatGptPlan();
  if (!plan || !(await plan.status()).connected) return null;
  return inferChatGptPlan(plan, body, options);
}

export async function inferChatGptPlan(
  plan: ChatGptPlanRpc,
  body: Awaited<ReturnType<typeof gatewayQuery>>,
  options: { signal?: AbortSignal; requestTimeoutMs?: number } = {},
): Promise<Response> {
  options.signal?.throwIfAborted();
  const requestId = crypto.randomUUID();
  const timeoutMs = chatGptInferenceDeadline(options.requestTimeoutMs);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", relayAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(new Error("ChatGPT inference exceeded its deadline")),
    timeoutMs,
  );
  let rejectAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
  });
  const cancel = () => {
    rejectAbort();
    void plan.cancel(requestId).catch(() => {
      // SILENT: local cancellation already fails the caller; the owner's
      // bounded deadline also stops inference if this cancel RPC is lost.
    });
  };
  controller.signal.addEventListener("abort", cancel, { once: true });
  const finish = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relayAbort);
    controller.signal.removeEventListener("abort", cancel);
  };
  try {
    const pending = plan.infer(body, inferenceBody.parse(body).model, {
      requestId,
      timeoutMs,
    });
    // A remote admission that finishes after caller cancellation must not leave
    // its returned stream running after the caller has stopped waiting.
    void pending.then(
      (response) => {
        if (controller.signal.aborted)
          void response.body?.cancel().catch(() => {
            // SILENT: a late response belongs to an already cancelled caller.
          });
      },
      () => {
        // SILENT: Promise.race below preserves the admission failure.
      },
    );
    const response = await Promise.race([pending, aborted]);
    return chatGptResponseLifetime(response, controller.signal, finish, () => {
      controller.abort(new Error("ChatGPT inference stream cancelled"));
    });
  } catch (error) {
    finish();
    throw error;
  }
}

export function requireChatGptPlan(): ChatGptPlanRpc {
  const plan = chatGptPlan();
  if (!plan)
    throw new Error("ChatGPT plan storage is unavailable in this runtime");
  return plan;
}
