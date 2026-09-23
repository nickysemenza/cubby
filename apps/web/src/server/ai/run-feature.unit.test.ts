import { importRunId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { AI_CACHE_TTL_SECONDS } from "~/server/clients/ai-adapters";
import { Database } from "~/server/db";

import {
  PURCHASE_IMPORT_REPAIR_FEATURE,
  LOCATION_DESCRIPTION_FEATURE,
  PRODUCT_IDENTIFICATION_FEATURE,
  RECIPE_FLOW_PRIMARY_FEATURE,
} from "./features";
import {
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
const runId = importRunId.parse("00000000-0000-4000-8000-000000000001");

const request: AiChatRequest = {
  systemPrompts: ["frame"],
  messages: [{ role: "user", content: "subject" }],
};

/** The fields the runner puts on every `chat()` call, typed so the
 * assertions below read them instead of casting a dictionary. */
interface CapturedChatCall {
  adapter: { structuredOutputStream?: unknown };
  modelOptions: unknown;
  outputSchema: unknown;
  systemPrompts: string[];
  messages: unknown[];
  middleware: unknown[];
}

interface FakeChat {
  calls: CapturedChatCall[];
  ports: StructuredRunPorts;
}

/**
 * Capture what the runner hands `chat()` without reaching a provider.
 * `responses` is consumed one per call, in order, so repair tests can hand
 * back a rejected answer on the first call and a corrected one on the
 * second; the last entry repeats for any further call. Callers that never
 * inspect the resolved value pass a single placeholder object.
 */
function fakeChat<T extends object>(responses: readonly T[]): FakeChat {
  const calls: CapturedChatCall[] = [];
  const capture = async (args: CapturedChatCall): Promise<string> => {
    calls.push(args);
    // SAFETY: `responses` is a non-empty array by construction (every call
    // site below passes at least one fixture), and the index is clamped to
    // its last entry, so this index is always in bounds.
    const response =
      responses[Math.min(calls.length - 1, responses.length - 1)]!;
    const widened: unknown = response;
    // SAFETY: `response` (now `widened`) is one of the caller's own
    // fixtures, never actually treated as a string — `capture` is declared
    // to return `Promise<string>` only so it structurally overlaps `chat`'s
    // real conditional return enough for the single cast a few lines below;
    // `runStructuredFeature` re-casts the resolved value to its own `T` and
    // never parses it.
    return widened as string;
  };
  // SAFETY: the port is typed as `chat`'s full generic signature; `capture`
  // reads only the fields every branch of the runner passes, and resolves to
  // whatever `responses` was given, unwrapped through the cast above.
  const chat = capture as StructuredRunPorts["chat"];
  return { calls, ports: { chat } };
}

/** Placeholder resolved value for a `fakeChat` call whose assertions never
 * inspect what `chat()` returned. */
const UNUSED_RESPONSE = { unused: true } as const;

describe("planStructuredRun", () => {
  it("caches a structured feature for the gateway's full TTL", () => {
    const plan = planStructuredRun(PRODUCT_IDENTIFICATION_FEATURE, {
      db,
      runId,
      operation: "suggestCategory",
    });

    expect(plan.call.cacheTtlSeconds).toBe(AI_CACHE_TTL_SECONDS);
    expect(plan.call.skipCache).toBeUndefined();
    // Non-streaming is what puts `stream: false` on the wire, which the
    // gateway's exact-body cache key depends on.
    expect(plan.streaming).toBe(false);
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

  it("skips the cache for an uncacheable feature, and streams it", () => {
    const plan = planStructuredRun(PURCHASE_IMPORT_REPAIR_FEATURE, {
      db,
      runId,
      operation: "purchaseImport.repair",
    });

    expect(plan.call.skipCache).toBe(true);
    expect(plan.call.cacheTtlSeconds).toBeUndefined();
    expect(plan.streaming).toBe(true);
  });

  it("labels the gateway call with the spec's feature and the caller's entity", () => {
    const plan = planStructuredRun(LOCATION_DESCRIPTION_FEATURE, {
      db,
      runId,
      operation: "locationDescription",
      entity: { entityType: "location", entityId: "loc-1" },
    });

    expect(plan.call.metadata).toEqual({
      feature: "location-description",
      operation: "locationDescription",
      entityType: "location",
      entityId: "loc-1",
    });
  });

  it("prices the usage row on the registry's provider for the tier's model", () => {
    // A wrong provider here prices the row as null and drops it out of the
    // cost ledger, so it is read from the registry, never hardcoded.
    expect(
      planStructuredRun(PRODUCT_IDENTIFICATION_FEATURE, {
        db,
        runId,
        operation: "suggestCategory",
      }).usage,
    ).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      feature: "product-identification",
      cacheStatus: "none",
    });

    expect(
      planStructuredRun(RECIPE_FLOW_PRIMARY_FEATURE, {
        db,
        runId,
        operation: "recipeFlow",
      }).usage,
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });

    expect(
      planStructuredRun(LOCATION_DESCRIPTION_FEATURE, {
        db,
        runId,
        operation: "locationDescription",
      }).usage,
    ).toMatchObject({ provider: "google", model: "gemini-2.5-flash" });
  });

  it("records no usage when the caller has no database", () => {
    expect(
      planStructuredRun(PRODUCT_IDENTIFICATION_FEATURE, {
        runId,
        operation: "eval",
      }).usage,
    ).toBeUndefined();
  });
});

describe("runStructuredFeature", () => {
  it("maps the fast tier to OpenAI Responses options and the spec's schema", async () => {
    const { calls, ports } = fakeChat([UNUSED_RESPONSE]);

    await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      { db, runId, operation: "suggestCategory" },
      ports,
    );

    const call = calls[0]!;
    expect(call.modelOptions).toEqual({
      max_output_tokens: 500,
      reasoning: { effort: "low" },
    });
    expect(call.outputSchema).toBe(PRODUCT_IDENTIFICATION_FEATURE.schema);
    expect(call.systemPrompts).toEqual(["frame"]);
  });

  it("maps the vision batch tier to compat options", async () => {
    const { calls, ports } = fakeChat([UNUSED_RESPONSE]);

    await runStructuredFeature(
      LOCATION_DESCRIPTION_FEATURE,
      request,
      { db, runId, operation: "locationDescription" },
      ports,
    );

    // No `reasoning_effort`: Gemini's own thinking stays on for batch work.
    expect(calls[0]!.modelOptions).toEqual({ max_tokens: 1500 });
  });

  it("maps the reasoning tier to Anthropic options with adaptive thinking", async () => {
    const { calls, ports } = fakeChat([UNUSED_RESPONSE]);

    await runStructuredFeature(
      RECIPE_FLOW_PRIMARY_FEATURE,
      request,
      { db, runId, operation: "recipeFlow" },
      ports,
    );

    expect(calls[0]!.modelOptions).toEqual({
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
  });

  it("forces the non-streaming structured path for a cacheable feature", async () => {
    const { calls, ports } = fakeChat([UNUSED_RESPONSE]);

    await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      { db, runId, operation: "suggestCategory" },
      ports,
    );

    // `surfaceStructuredOutputRunErrors(..., { streaming: false })` clears
    // `structuredOutputStream`, which is what makes the engine put
    // `stream: false` on the wire for the gateway's cache key.
    expect(calls[0]!.adapter.structuredOutputStream).toBeUndefined();
  });

  it("attaches a usage middleware only when the caller has a database", async () => {
    const withDb = fakeChat([UNUSED_RESPONSE]);
    await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      { db, runId, operation: "suggestCategory" },
      withDb.ports,
    );
    expect(withDb.calls[0]!.middleware).toHaveLength(1);

    const withoutDb = fakeChat([UNUSED_RESPONSE]);
    await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      { operation: "eval", runId },
      withoutDb.ports,
    );
    expect(withoutDb.calls[0]!.middleware).toHaveLength(0);
  });
});

describe("runStructuredFeature repair", () => {
  // `validate` closures below track their own call count instead of
  // inspecting the fake's resolved value: the fake returns plain test
  // fixtures, not real `ProductIdentification` output, and the point of these
  // tests is the runner's repair *policy* (how many calls, what the second
  // one carries), not the shape of any one tier's schema.
  const okContext = (): AiRunContext<unknown> => ({
    db,
    runId,
    operation: "suggestCategory",
    validate: () => ({ ok: true }),
  });

  it("returns the first answer and places one call when validate passes", async () => {
    const { calls, ports } = fakeChat([{ pass: 1 }]);

    const result = await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      okContext(),
      ports,
    );

    expect(result).toEqual({ pass: 1 });
    expect(calls).toHaveLength(1);
  });

  it("leaves plain calls unaffected when the caller passes no validate", async () => {
    const { calls, ports } = fakeChat([
      { never: "repaired" },
      { unused: true },
    ]);

    const result = await runStructuredFeature(
      PRODUCT_IDENTIFICATION_FEATURE,
      request,
      { db, runId, operation: "suggestCategory" },
      ports,
    );

    expect(result).toEqual({ never: "repaired" });
    expect(calls).toHaveLength(1);
  });

  it("repairs once when validate rejects the first answer, then returns the second", async () => {
    const { calls, ports } = fakeChat([{ bad: true }, { good: true }]);
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

    expect(result).toEqual({ good: true });
    expect(calls).toHaveLength(2);

    // The first call is the caller's own request, untouched.
    expect(calls[0]!.messages).toEqual(request.messages);

    // The second call appends one turn naming the issue and the rejected
    // answer, on top of the original messages — it does not replace them.
    const repairMessages = calls[1]!.messages;
    expect(repairMessages).toHaveLength(request.messages.length + 1);
    expect(repairMessages.slice(0, -1)).toEqual(request.messages);
    const repairTurn: unknown = repairMessages.at(-1);
    expect(repairTurn).toEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining(
          "operation op-x references unknown operation setup-y",
        ),
      }),
    );
    expect(repairTurn).toEqual(
      expect.objectContaining({ content: expect.stringContaining("bad") }),
    );
    expect(repairTurn).toEqual(
      expect.objectContaining({
        content: expect.stringMatching(/corrected, complete answer/i),
      }),
    );
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
    const { calls, ports } = fakeChat([{ bad: 1 }, { stillBad: 2 }]);
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

describe("modelOptionsFor", () => {
  it("routes each model to its provider's option shape", () => {
    expect(modelOptionsFor("gpt-5.6-luna", { maxTokens: 100 })).toEqual({
      max_output_tokens: 100,
      reasoning: { effort: "low" },
    });
    expect(modelOptionsFor("claude-sonnet-5", { maxTokens: 100 })).toEqual({
      max_tokens: 100,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(modelOptionsFor("gemini-2.5-flash", { maxTokens: 100 })).toEqual({
      max_tokens: 100,
      reasoning_effort: "low",
    });
  });

  it("honours an explicit effort", () => {
    expect(
      modelOptionsFor("gpt-5.6-luna", { maxTokens: 100, effort: "high" }),
    ).toEqual({ max_output_tokens: 100, reasoning: { effort: "high" } });
  });
});
