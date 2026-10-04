import { runEntityId } from "@cubby/schemas/identifiers";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type JsonObject,
  type ModelsApiStreamOptions,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { AI_CACHE_TTL_SECONDS } from "~/server/clients/ai-adapters";
import type { GatewayCallOptions } from "~/server/clients/ai-gateway";
import { Database } from "~/server/db";

import {
  PURCHASE_IMPORT_REPAIR_FEATURE,
  LOCATION_DESCRIPTION_FEATURE,
  PRODUCT_IDENTIFICATION_FEATURE,
  RECIPE_FLOW_PRIMARY_FEATURE,
} from "./features";
import {
  RESPOND_TOOL_NAME,
  type AiChatRequest,
  type AiRunContext,
  modelOptionsFor,
  planStructuredRun,
  runStructuredFeature,
  type StructuredRunPorts,
} from "./run-feature";

const db = new Database(() => {
  throw new Error("run-feature unit tests never resolve a database runtime");
});
const runId = runEntityId.parse("00000000-0000-4000-8000-000000000001");

const request: AiChatRequest = {
  systemPrompts: ["frame"],
  messages: [{ role: "user", content: "subject" }],
};

/** A valid instance of each real feature's schema, so `placeStructuredCall`'s
 * unconditional `spec.schema.parse()` never rejects a fixture — only the
 * fields a given test actually varies carry meaning. */
const PRODUCT_IDENTIFICATION_FIXTURE = {
  name: "n",
  manufacturer: "m",
  model: null,
  confidence: "high",
  reasoning: "r",
};
const LOCATION_DESCRIPTION_FIXTURE = { description: "d", confidence: "high" };
const RECIPE_FLOW_FIXTURE = {
  schemaVersion: 1,
  setup: [],
  sources: [],
  operations: [],
  outputOperationIds: [],
};

/** A forced `respond` tool call carrying `args`, built the same way pi-ai's
 * own test provider expects (see "Faux Provider for Tests") rather than a
 * hand-rolled `AssistantMessage` literal. */
function respondWith(args: JsonObject): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(RESPOND_TOOL_NAME, args), {
    stopReason: "toolUse",
  });
}

interface CapturedCall {
  model: string;
  call: GatewayCallOptions;
  context: Context;
  options: unknown;
}

/**
 * Fakes `callTarget` on pi-ai's own faux provider (`@earendil-works/pi-ai`'s
 * `fauxProvider()`): a real `Model`, routed through a real `Models`
 * collection, answering with scripted `AssistantMessage`s consumed in queue
 * order — a repair test hands back a rejected answer on the first call and
 * a corrected one on the second. `complete` still captures each call's
 * context/options so the tier-mapping assertions below can inspect them.
 */
function fakePorts(responses: readonly AssistantMessage[]) {
  const calls: CapturedCall[] = [];
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);
  const ports: StructuredRunPorts = {
    callTarget: (model, call) => ({
      model: faux.getModel(),
      complete: async (context, options) => {
        calls.push({ model, call, context, options });
        // SAFETY: the faux provider accepts any API's stream options as an
        // untyped bag (`StreamOptions & Record<string, unknown>`); `options`
        // already came from `chatCompletionOptionsFor`, shaped for the real
        // model's API, which is all the production call site relies on.
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

describe("planStructuredRun", () => {
  it("caches a structured feature for the gateway's full TTL", () => {
    const plan = planStructuredRun(PRODUCT_IDENTIFICATION_FEATURE, {
      db,
      runId,
      operation: "suggestCategory",
    });

    expect(plan.call.cacheTtlSeconds).toBe(AI_CACHE_TTL_SECONDS);
    expect(plan.call.skipCache).toBeUndefined();
  });

  it("turns a caller's force into a skip rather than a shorter TTL", () => {
    const plan = planStructuredRun(PRODUCT_IDENTIFICATION_FEATURE, {
      db,
      runId,
      operation: "suggestCategory",
      force: true,
    });

    expect(plan.call.skipCache).toBe(true);
    expect(plan.call.cacheTtlSeconds).toBeUndefined();
  });

  it("skips the cache for an uncacheable feature", () => {
    const plan = planStructuredRun(PURCHASE_IMPORT_REPAIR_FEATURE, {
      db,
      runId,
      operation: "purchaseImport.repair",
    });

    expect(plan.call.skipCache).toBe(true);
    expect(plan.call.cacheTtlSeconds).toBeUndefined();
  });

  it("labels the gateway call with the spec's feature and the caller's entity", () => {
    const plan = planStructuredRun(LOCATION_DESCRIPTION_FEATURE, {
      db,
      runId,
      operation: "locationDescription",
      entity: { entityKind: "location", entityId: "loc-1" },
    });

    expect(plan.call.metadata).toEqual({
      feature: "location-description",
      operation: "locationDescription",
      entityKind: "location",
      entityId: "loc-1",
    });
  });
});

it("keeps the model, gateway route, operation, and provider cause on a failed call", async () => {
  const providerError = Object.assign(new Error("Wholesale Rate limited"), {
    status: 429,
    code: 2018,
  });
  const faux = fauxProvider();
  const ports: StructuredRunPorts = {
    callTarget: () => ({
      model: faux.getModel(),
      complete: async () => {
        throw providerError;
      },
    }),
  };
  await expect(
    runStructuredFeature(
      PURCHASE_IMPORT_REPAIR_FEATURE,
      request,
      { runId, operation: "purchaseImport.repair" },
      ports,
    ),
  ).rejects.toMatchObject({
    message: expect.stringContaining(PURCHASE_IMPORT_REPAIR_FEATURE.model),
    cause: providerError,
  });
});

describe("runStructuredFeature", () => {
  it("maps the fast tier to OpenAI Responses options and forces the respond tool", async () => {
    const { calls, ports } = fakePorts([
      respondWith(PRODUCT_IDENTIFICATION_FIXTURE),
    ]);

    const result = await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      { db, runId, operation: "suggestCategory" },
      ports,
    );

    expect(result).toEqual(PRODUCT_IDENTIFICATION_FIXTURE);
    const call = calls[0]!;
    expect(call.options).toEqual({
      maxTokens: 500,
      reasoningEffort: "low",
      toolChoice: { type: "function", name: RESPOND_TOOL_NAME },
    });
    expect(call.context.systemPrompt).toBe("frame");
    expect(call.context.tools).toHaveLength(1);
    expect(call.context.tools?.[0]?.name).toBe(RESPOND_TOOL_NAME);
  });

  // Regression: pi-ai `structuredClone`s strict tool parameters before every
  // request; a TypeBox-wrapped schema carried a validator function and failed
  // every structured call in workerd while this fake path still passed.
  it("hands pi-ai respond-tool parameters it can clone", async () => {
    const { calls, ports } = fakePorts([
      respondWith(PRODUCT_IDENTIFICATION_FIXTURE),
    ]);

    await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      { runId, operation: "suggestCategory" },
      ports,
    );

    const parameters = calls[0]?.context.tools?.[0]?.parameters;
    expect(() => structuredClone(parameters)).not.toThrow();
  });

  it("maps the vision batch tier to compat options with no forced reasoning effort", async () => {
    const { calls, ports } = fakePorts([
      respondWith(LOCATION_DESCRIPTION_FIXTURE),
    ]);

    await runStructuredFeature(
      LOCATION_DESCRIPTION_FEATURE,
      request,
      { db, runId, operation: "locationDescription" },
      ports,
    );

    // No `reasoningEffort`: Gemini's own thinking stays on for batch work.
    expect(calls[0]!.options).toEqual({
      maxTokens: 1500,
      toolChoice: { type: "function", function: { name: RESPOND_TOOL_NAME } },
    });
  });

  it("maps the reasoning tier to OpenAI Responses options", async () => {
    const { calls, ports } = fakePorts([respondWith(RECIPE_FLOW_FIXTURE)]);

    await runStructuredFeature(
      RECIPE_FLOW_PRIMARY_FEATURE,
      request,
      { db, runId, operation: "recipeFlow" },
      ports,
    );

    expect(calls[0]!.options).toEqual({
      maxTokens: 16000,
      reasoningEffort: "low",
      toolChoice: { type: "function", name: RESPOND_TOOL_NAME },
    });
  });
});

describe("runStructuredFeature repair", () => {
  const okContext = (): AiRunContext<unknown> => ({
    db,
    runId,
    operation: "suggestCategory",
    validate: () => ({ ok: true }),
  });

  it("returns the first answer and places one call when validate passes", async () => {
    const { calls, ports } = fakePorts([
      respondWith(PRODUCT_IDENTIFICATION_FIXTURE),
    ]);

    const result = await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      okContext(),
      ports,
    );

    expect(result).toEqual(PRODUCT_IDENTIFICATION_FIXTURE);
    expect(calls).toHaveLength(1);
  });

  it("leaves plain calls unaffected when the caller passes no validate", async () => {
    const { calls, ports } = fakePorts([
      respondWith({
        ...PRODUCT_IDENTIFICATION_FIXTURE,
        reasoning: "never repaired",
      }),
      respondWith({ ...PRODUCT_IDENTIFICATION_FIXTURE, reasoning: "unused" }),
    ]);

    const result = await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      { db, runId, operation: "suggestCategory" },
      ports,
    );

    expect(result.reasoning).toBe("never repaired");
    expect(calls).toHaveLength(1);
  });

  it("repairs once when validate rejects the first answer, then returns the second", async () => {
    const { calls, ports } = fakePorts([
      respondWith({ ...PRODUCT_IDENTIFICATION_FIXTURE, reasoning: "bad" }),
      respondWith({ ...PRODUCT_IDENTIFICATION_FIXTURE, reasoning: "good" }),
    ]);
    let validateCalls = 0;
    const ctx: AiRunContext<unknown> = {
      db,
      runId,
      operation: "suggestCategory",
      validate: () => {
        validateCalls += 1;
        return validateCalls === 1
          ? {
              ok: false,
              issues: ["operation op-x references unknown operation setup-y"],
            }
          : { ok: true };
      },
    };

    const result = await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      ctx,
      ports,
    );

    expect(result).toMatchObject({ reasoning: "good" });
    expect(calls).toHaveLength(2);

    // The first call is the caller's own request, untouched.
    expect(calls[0]!.context.messages).toHaveLength(request.messages.length);

    // The second call appends one turn naming the issue and the rejected
    // answer, on top of the original messages — it does not replace them.
    const repairMessages = calls[1]!.context.messages;
    expect(repairMessages).toHaveLength(request.messages.length + 1);
    const repairTurn = repairMessages.at(-1);
    if (!repairTurn || repairTurn.role !== "user") {
      throw new Error("The repair turn must be a user message.");
    }
    const repairText = userMessageText(repairTurn);
    expect(repairText).toContain(
      "operation op-x references unknown operation setup-y",
    );
    expect(repairText).toContain("bad");
    expect(repairText).toMatch(/corrected, complete answer/i);
  });

  it("plans the repair call to skip the gateway's response cache", () => {
    // The repaired body already differs from the first call's (the repair
    // turn is new), so it would miss the gateway's exact-body cache
    // regardless — this proves the runner is explicit about it anyway,
    // exactly the merge `runStructuredFeature` performs before its second
    // `placeCall`.
    const firstPlan = planStructuredRun(PRODUCT_IDENTIFICATION_FEATURE, {
      db,
      runId,
      operation: "suggestCategory",
    });
    const repairPlan = planStructuredRun(PRODUCT_IDENTIFICATION_FEATURE, {
      db,
      runId,
      operation: "suggestCategory",
      force: true,
    });

    expect(firstPlan.call.skipCache).toBeUndefined();
    expect(repairPlan.call.skipCache).toBe(true);
  });

  it("throws with the issues when validate rejects the repair too", async () => {
    const { calls, ports } = fakePorts([
      respondWith({ ...PRODUCT_IDENTIFICATION_FIXTURE, reasoning: "bad-1" }),
      respondWith({
        ...PRODUCT_IDENTIFICATION_FIXTURE,
        reasoning: "still-bad",
      }),
    ]);
    const ctx: AiRunContext<unknown> = {
      db,
      runId,
      operation: "suggestCategory",
      validate: () => ({ ok: false, issues: ["still missing a field"] }),
    };

    await expect(
      runStructuredFeature(PRODUCT_IDENTIFICATION_FEATURE, request, ctx, ports),
    ).rejects.toThrow(/still missing a field/);
    expect(calls).toHaveLength(2);
  });
});

/** `content is string` is the one shape `isInsideTypeGuard` recognizes as a
 * type guard, so the `typeof` narrowing this needs lives in its own
 * predicate function rather than inline. */
function isStringContent(content: UserMessage["content"]): content is string {
  return typeof content === "string";
}

function userMessageText(message: UserMessage): string {
  return isStringContent(message.content) ? message.content : "";
}

describe("modelOptionsFor", () => {
  it("routes each model to its provider's option shape", () => {
    expect(modelOptionsFor("gpt-6-luna", { maxTokens: 100 })).toEqual({
      maxTokens: 100,
      reasoningEffort: "low",
      toolChoice: { type: "function", name: RESPOND_TOOL_NAME },
    });
    expect(modelOptionsFor("claude-sonnet-5", { maxTokens: 100 })).toEqual({
      maxTokens: 100,
      thinkingEnabled: true,
      effort: "low",
      toolChoice: { type: "tool", name: RESPOND_TOOL_NAME },
    });
    expect(modelOptionsFor("gemini-2.5-flash", { maxTokens: 100 })).toEqual({
      maxTokens: 100,
      reasoningEffort: "low",
      toolChoice: { type: "function", function: { name: RESPOND_TOOL_NAME } },
    });
  });

  it("honours an explicit effort", () => {
    expect(
      modelOptionsFor("gpt-6-luna", { maxTokens: 100, effort: "high" }),
    ).toEqual({
      maxTokens: 100,
      reasoningEffort: "high",
      toolChoice: { type: "function", name: RESPOND_TOOL_NAME },
    });
  });
});
