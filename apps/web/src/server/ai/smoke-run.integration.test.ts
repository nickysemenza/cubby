import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type JsonObject,
  type ModelsApiStreamOptions,
} from "@earendil-works/pi-ai";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  aiAnalysis,
  runFinding,
  run as runTable,
  orderMail,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { PURCHASE_IMPORT_MAIL_FEATURE } from "./features";
import { RESPOND_TOOL_NAME, type StructuredRunPorts } from "./run-feature";
import { runAiSmoke } from "./smoke-run";

/**
 * Fakes `callTarget` on pi-ai's own faux provider (`fauxProvider()`, see
 * "Faux Provider for Tests"): answers every `complete()` with a forced
 * `respond` tool call carrying `response`, so the smoke dispatch's
 * production request building, schema validation, and writer code all run
 * unmodified, without placing a real model call.
 */
function fakeCallTarget(response: JsonObject) {
  const calls: Context[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(RESPOND_TOOL_NAME, response), {
      stopReason: "toolUse",
    }),
  ]);
  const ports: StructuredRunPorts = {
    callTarget: () => ({
      model: faux.getModel(),
      complete: (context, options) => {
        calls.push(context);
        // SAFETY: the faux provider accepts any API's stream options as an
        // untyped bag; `options` already came from `chatCompletionOptionsFor`,
        // shaped for the real model's API.
        return models.complete(
          faux.getModel(),
          context,
          options as ModelsApiStreamOptions<string>,
        );
      },
    }),
  };
  return { calls, ports };
}

describe("AI smoke dispatch", () => {
  const ctx = withTestDb();

  it("routes order mail through its production request without workflow writes", async () => {
    const { calls, ports } = fakeCallTarget({
      events: [
        {
          event: "other",
          orderId: null,
          amount: null,
          currency: null,
          occurredAt: null,
        },
      ],
    });
    const actor = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    const attempt = await runAiSmoke(
      actor,
      "purchaseMail",
      {
        fixture: "standard",
      },
      ports,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools?.[0]?.name).toBe(RESPOND_TOOL_NAME);
    expect(calls[0]?.messages).toEqual(expect.any(Array));
    expect(attempt).toMatchObject({
      status: "no_model_call",
      feature: PURCHASE_IMPORT_MAIL_FEATURE.feature,
      runShortcode: expect.any(String),
    });
    const runs = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable);
    expect(runs).toEqual([{ shortcode: attempt.runShortcode }]);
    for (const table of [orderMail, runFinding, aiAnalysis]) {
      expect(await getDb(ctx.db).select({ id: table.id }).from(table)).toEqual(
        [],
      );
    }
  });
});
