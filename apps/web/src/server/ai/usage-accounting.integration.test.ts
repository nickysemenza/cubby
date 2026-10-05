/**
 * One model call records exactly one `AiUsage` row.
 *
 * Every accounting path used to call `recordAiUsage` itself; the rows only
 * stayed single because each call site happened to write one. These tests hold
 * the invariant at the boundary — a real database, the real gateway shim faked
 * only at the socket — so a second writer (a middleware plus a hand-written
 * record, say) shows up as a second row.
 */
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ModelsApiStreamOptions,
} from "@earendil-works/pi-ai";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ENTITY_EMBEDDING_FEATURE,
  LOCATION_DESCRIPTION_FEATURE,
  FIELD_SUGGESTION_FEATURE,
} from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import {
  RESPOND_TOOL_NAME,
  recordApplicationCacheHit,
  recordFeatureUsage,
  runStructuredFeature,
  type StructuredRunPorts,
} from "~/server/ai/run-feature";
import { aiUsage } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { ensureRun } from "~/server/runs/ensure-run";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("AiUsage accounting", () => {
  const ctx = withTestDb();

  async function usageRows() {
    return await getDb(ctx.db).select().from(aiUsage);
  }

  it.each([
    { random: 0.25, model: "typesafe/jev", provider: "typesafe" },
    { random: 0.75, model: "@cf/cloudflare/clef", provider: "cloudflare" },
  ])(
    "records exactly one usage row for the selected $model",
    async ({ random, model, provider }) => {
      vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key");
      vi.spyOn(Math, "random").mockReturnValue(random);
      vi.resetModules();
      vi.stubGlobal("fetch", async () => {
        const answer = {
          answers: {
            selection: {
              type: "choice",
              choice: "c0",
              confidence: 0.9,
              probabilities: { c0: 0.9, none: 0.1 },
            },
          },
          usage: { input_tokens: 100, output_tokens: 0 },
        };
        return Response.json(
          provider === "cloudflare" ? answer : { result: answer },
        );
      });
      const { runJevChoice } = await import("./jev");
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
      });
      await runJevChoice({
        feature: { ...FIELD_SUGGESTION_FEATURE, cache: false },
        subject: "synthetic decision",
        rules: "Choose one.",
        choices: ["one"],
        usage: { db: ctx.db, runId, operation: "decision-model-trial" },
      });
      const rows = await usageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        model,
        provider,
        inputTokens: 100,
        outputTokens: 0,
        status: "succeeded",
        attempt: 1,
      });
    },
  );

  it("records one row for one embeddings call", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key");
    vi.resetModules();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: "list",
            model: "text-embedding-3-small",
            data: [0, 1].map((index) => ({
              object: "embedding",
              index,
              embedding: Array.from({ length: 1536 }, () => 0.5),
            })),
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { embedTexts } = await import("~/server/semantic/embeddings");
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });

    await embedTexts(["eggs", "flour"], {
      db: ctx.db,
      runId,
      feature: ENTITY_EMBEDDING_FEATURE.feature,
      operation: "entityEmbeddingBackfill",
    });

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "entity-embedding",
      provider: "openai",
      model: "text-embedding-3-small",
      operation: "entityEmbeddingBackfill",
      runId,
      inputTokens: 4,
      cacheStatus: "none",
      transport: "gateway",
    });
  });

  it("records one row for one location vision model call", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    // The fake `callTarget` (pi-ai's own `fauxProvider()` test double — see
    // "Faux Provider for Tests") resolves `recordFeatureUsage` straight from
    // the `AssistantMessage` it hands back, the same as the real transport,
    // so the row count reflects every writer the runner attaches to a call:
    // a second one would show up as a second row.
    const faux = fauxProvider();
    const fauxModels = createModels();
    fauxModels.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(RESPOND_TOOL_NAME, {
          description: "Synthetic shelf of bins.",
          confidence: "high",
        }),
        { stopReason: "toolUse" },
      ),
    ]);
    const ports: StructuredRunPorts = {
      callTarget: (_model, call) => ({
        model: faux.getModel(),
        // SAFETY: the faux provider accepts any API's stream options as an
        // untyped bag; `options` already came from `chatCompletionOptionsFor`,
        // shaped for the real model's API.
        complete: (context, options) => {
          call.onTransport?.("gateway");
          // SAFETY: the faux provider takes the same API-shaped options
          // produced by chatCompletionOptionsFor, with a loose model ID.
          return fauxModels.complete(
            faux.getModel(),
            context,
            options as ModelsApiStreamOptions<string>,
          );
        },
      }),
    };

    await runStructuredFeature(
      LOCATION_DESCRIPTION_FEATURE,
      { systemPrompts: ["frame"], messages: [{ role: "user", content: "x" }] },
      { db: ctx.db, runId, operation: "locationDescription" },
      ports,
    );

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "location-description",
      operation: "locationDescription",
      status: "succeeded",
      transport: "gateway",
    });
    // The faux provider estimates usage from message/response length rather
    // than taking an exact override; the invariant under test is "exactly
    // one row, populated from the real `AssistantMessage`", not these
    // particular counts.
    expect(rows[0]?.inputTokens).toBeGreaterThan(0);
    expect(rows[0]?.outputTokens).toBeGreaterThan(0);
  });

  it("records one row for a location analysis served from AiAnalysis", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Usage Accounting Shelf" }),
      ctx.actor,
    );
    const locationId = await resolveOrThrow(ctx.db, "location", shelf.id);

    // No model runs on an analysis-cache hit, so this is the only writer for
    // the call: the runner's usage middleware never fires.
    await recordFeatureUsage(
      LOCATION_DESCRIPTION_FEATURE,
      {
        db: ctx.db,
        runId,
        operation: "locationDescription",
        entity: { entityKind: "location", entityId: locationId },
      },
      { transport: "cache", durationMs: 0, cacheStatus: "hit" },
    );

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "location-description",
      provider: providerFor(LOCATION_DESCRIPTION_FEATURE.model),
      model: LOCATION_DESCRIPTION_FEATURE.model,
      operation: "locationDescription",
      runId,
      cacheStatus: "hit",
      entityKind: "location",
      entityId: locationId,
      transport: "cache",
    });
  });

  it("records one zero-cost row for a decision served from the response cache", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });

    await recordApplicationCacheHit(
      FIELD_SUGGESTION_FEATURE,
      { db: ctx.db, runId, operation: "suggestFields.product.categoryId" },
      7,
    );

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "field-suggestion",
      provider: "typesafe",
      model: "typesafe/jev",
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      attempt: 0,
      applicationCacheStatus: "hit",
      durationMs: 7,
      transport: "cache",
    });
  });

  // A connected ChatGPT plan owns the call once selected: a failure before any
  // HTTP response (the plan's RPC throwing) is still a ChatGPT call, never an
  // API call, and never silently retried through the gateway.
  it("records a failed ChatGPT call as chatgpt even without a response", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const faux = fauxProvider();
    const transports: string[] = [];
    const ports: StructuredRunPorts = {
      callTarget: (_model, call) => ({
        model: faux.getModel(),
        complete: async () => {
          call.onTransport?.("chatgpt");
          transports.push("chatgpt");
          throw new Error("ChatGPT inference exceeded its deadline");
        },
      }),
    };

    await expect(
      runStructuredFeature(
        LOCATION_DESCRIPTION_FEATURE,
        {
          systemPrompts: ["frame"],
          messages: [{ role: "user", content: "x" }],
        },
        { db: ctx.db, runId, operation: "locationDescription" },
        ports,
      ),
    ).rejects.toThrow(/deadline/);

    expect(transports).toEqual(["chatgpt"]);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature: "location-description",
      status: "failed",
      transport: "chatgpt",
      inputTokens: null,
      outputTokens: null,
      estimatedCost: 0,
    });
  });

  // The model answered and was billed; only the forced tool call / schema
  // check failed. The row keeps the response's usage and cost.
  it("keeps a billed response's usage when its answer fails validation", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const faux = fauxProvider();
    const fauxModels = createModels();
    fauxModels.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(RESPOND_TOOL_NAME, { description: 42 }),
        { stopReason: "toolUse" },
      ),
    ]);
    const ports: StructuredRunPorts = {
      callTarget: (_model, call) => ({
        model: faux.getModel(),
        complete: (context, options) => {
          call.onTransport?.("gateway");
          // SAFETY: the faux provider takes the same API-shaped options
          // produced by chatCompletionOptionsFor, with a loose model ID.
          return fauxModels.complete(
            faux.getModel(),
            context,
            options as ModelsApiStreamOptions<string>,
          );
        },
      }),
    };

    await expect(
      runStructuredFeature(
        LOCATION_DESCRIPTION_FEATURE,
        {
          systemPrompts: ["frame"],
          messages: [{ role: "user", content: "x" }],
        },
        { db: ctx.db, runId, operation: "locationDescription" },
        ports,
      ),
    ).rejects.toThrow(/expected string/);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", transport: "gateway" });
    expect(rows[0]?.inputTokens).toBeGreaterThan(0);
    expect(rows[0]?.outputTokens).toBeGreaterThan(0);
  });

  // Plan usage is never API spend, even when the registry could price the
  // tokens a ChatGPT response reports.
  it("never prices a ChatGPT plan call from its tokens", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const { recordAiUsage } = await import("~/server/ai-usage");
    await recordAiUsage(ctx.db, {
      provider: "openai",
      model: "gpt-6-sol",
      feature: "location-description",
      operation: "locationDescription",
      runId,
      inputTokens: 1_000,
      outputTokens: 1_000,
      durationMs: 5,
      transport: "chatgpt",
    });

    const rows = await usageRows();
    expect(rows[0]).toMatchObject({ transport: "chatgpt", estimatedCost: 0 });
  });

  it("records unknown when a failed call never selected a transport", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const faux = fauxProvider();
    const ports: StructuredRunPorts = {
      callTarget: () => ({
        model: faux.getModel(),
        complete: async () => {
          throw new Error("ChatGPT plan status lookup failed");
        },
      }),
    };

    await expect(
      runStructuredFeature(
        LOCATION_DESCRIPTION_FEATURE,
        {
          systemPrompts: ["frame"],
          messages: [{ role: "user", content: "x" }],
        },
        { db: ctx.db, runId, operation: "locationDescription" },
        ports,
      ),
    ).rejects.toThrow(/status lookup/);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", transport: "unknown" });
  });
});
