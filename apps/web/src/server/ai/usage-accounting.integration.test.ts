/**
 * One model call records exactly one `AiUsage` row.
 *
 * Every accounting path used to call `recordAiUsage` itself; the rows only
 * stayed single because each call site happened to write one. These tests hold
 * the invariant at the boundary — a real database, the real gateway shim faked
 * only at the socket — so a second writer (a middleware plus a hand-written
 * record, say) shows up as a second row.
 */
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ENTITY_EMBEDDING_FEATURE,
  LOCATION_DESCRIPTION_FEATURE,
  FIELD_SUGGESTION_FEATURE,
} from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import {
  recordApplicationCacheHit,
  recordFeatureUsage,
} from "~/server/ai/run-feature";
import { aiUsage } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { ensureRun } from "~/server/runs/ensure-run";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("AiUsage accounting", () => {
  const ctx = withTestDb();

  async function usageRows() {
    return await getDb(ctx.db).select().from(aiUsage);
  }

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
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_action" });

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
    });
  });

  it("records one row for a location analysis served from AiAnalysis", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_action" });
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Usage Accounting Shelf" }),
      ctx.actor,
    );
    const locationId = await resolveLiveShortcode(ctx.db, shelf.id, "location");

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
      { durationMs: 0, cacheStatus: "hit" },
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
    });
  });

  it("records one zero-cost row for a decision served from the response cache", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_action" });

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
    });
  });
});
