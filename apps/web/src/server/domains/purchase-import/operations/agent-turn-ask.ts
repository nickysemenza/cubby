import { runEntityId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { defineAsk, withAsk } from "~/server/kernel/api";
import { refusedBeforeSending } from "~/server/kernel/produce-ledger";
import { WorkDeferredError } from "~/server/kernel/work-errors";

const agentTurnResponse = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});

/** The host supplies the producer while its durable Pi task is executing. */
export const agentTurnAsk = defineAsk({
  feature: "purchase.agent-turn",
  producer: "model",
  hosted: true,
  promptVersion: "1",
  input: z.object({
    runId: z.uuid(),
    generation: z.string(),
    request: z.json(),
  }),
  output: agentTurnResponse,
});

/** The error types Cubby's agent transport answers with before sending. */
const CUBBY_LOCAL_REFUSAL =
  /"(?:type|code)"\s*:\s*"(?:cubby_admission_refused|cubby_plan_budget_reached|cubby_credit_refused|cubby_transport_failed|subscription_unavailable)"/u;

/**
 * A failed model response reaches Pi as it arrived and is never an Answer:
 * the transport's produce ledger settles the Ask queued when it proves nothing
 * was sent, and `unknown` otherwise.
 */
class ModelTurnResponseError extends Error {
  override name = "ModelTurnResponseError";
  constructor(readonly response: z.infer<typeof agentTurnResponse>) {
    super(`The model answered HTTP ${response.status}: ${response.body}`);
  }
}

/** One model turn through its Ask: the committed Answer, or the failed response unstored. */
export async function runAgentTurn(
  db: Database,
  input: {
    runId: string;
    generation: string;
    request: z.JSONType;
    recovery?: "unknown";
  },
  send: () => Promise<Response>,
  fence: () => Promise<void>,
): Promise<Response> {
  const { runId, generation, request } = input;
  const kind = {
    ...agentTurnAsk,
    produce: async () => {
      await fence();
      const response = await send();
      const output = {
        status: response.status,
        headers: Object.fromEntries(
          [...response.headers].filter(([key]) => key !== "set-cookie"),
        ),
        body: await response.text(),
      };
      if (response.ok) return { output };
      const failure = new ModelTurnResponseError(output);
      // Cubby's own refusals answer before any transport; the transports
      // record what they sent, so the ledger proves which ones were unsent.
      if (CUBBY_LOCAL_REFUSAL.test(output.body)) refusedBeforeSending(failure);
      if (response.status === 403 || response.status === 429) {
        const { pendingFundingResumeAt } =
          await import("~/server/domains/run/repo/execution-context");
        const { readRun } =
          await import("~/server/domains/run/repo/ai-work-state");
        const owner = await readRun(db, runEntityId.parse(runId));
        const until =
          owner?.status === "paused_auth" &&
          owner.failureCode === "execution_limit"
            ? await pendingFundingResumeAt(db, runId)
            : null;
        if (until)
          throw new WorkDeferredError(
            "Model turn waits for funding",
            until,
            "ai_funding_window",
          );
      }
      throw failure;
    },
  };
  try {
    const answer = await withAsk(
      db,
      kind,
      { runId, generation, request },
      {
        runId,
        pass: { name: "purchase.dispatch", key: runId },
        initialOutcome: input.recovery,
      },
    );
    return new Response(answer.body, {
      status: answer.status,
      headers: answer.headers,
    });
  } catch (error) {
    if (error instanceof ModelTurnResponseError)
      return new Response(error.response.body, {
        status: error.response.status,
        headers: error.response.headers,
      });
    if (error instanceof WorkDeferredError)
      return Response.json(
        {
          error: { type: "cubby_admission_refused", message: error.message },
        },
        { status: error.reason === "ai_funding_window" ? 403 : 429 },
      );
    throw error;
  }
}
