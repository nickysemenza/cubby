import { runEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import * as databaseHelpers from "~/server/db/helpers";
import { aiUsage, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { isBackgroundRun, readChatGptPlanAvailability } from "./funding";

// A local budget boundary is only a re-probe time. Reporting it as OpenAI's
// reset gives false usage information; withholding a real hint loses recovery.
describe("AI funding availability", () => {
  const ctx = withTestDb();
  it.each([
    ["background", true],
    ["ai_suggest", false],
  ] as const)(
    "shares concurrent immutable origin reads for %s",
    async (purpose, expected) => {
      const runId = await ensureRun(ctx.db, ctx.actor, { purpose });
      const cold = await countTestDbQueries(() =>
        Promise.all(
          Array.from({ length: 32 }, () => isBackgroundRun(ctx.db, runId)),
        ),
      );
      expect(cold.result).toEqual(Array(32).fill(expected));
      expect(cold.queryCount).toBe(1);
      const warm = await countTestDbQueries(() =>
        isBackgroundRun(ctx.db, runId),
      );
      expect(warm.result).toBe(expected);
      expect(warm.queryCount).toBe(0);
    },
  );

  it("rechecks missing origins and recovers after a failed origin read", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const unavailable = new Error("Synthetic unavailable origin database");
    const read = vi
      .spyOn(databaseHelpers, "getDb")
      .mockImplementationOnce(() => {
        throw unavailable;
      });
    try {
      await expect(isBackgroundRun(ctx.db, runId)).rejects.toBe(unavailable);
    } finally {
      read.mockRestore();
    }
    expect(await isBackgroundRun(ctx.db, runId)).toBe(true);

    const missingId = runEntityId.parse(crypto.randomUUID());
    expect(await isBackgroundRun(ctx.db, missingId)).toBe(false);
    const [template] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runId));
    const { shortcode: _shortcode, ...values } = template!;
    await insertWithShortcode(ctx.db, "run", { ...values, id: missingId });
    expect(await isBackgroundRun(ctx.db, missingId)).toBe(true);
  });

  it.each([
    ["", null],
    [',"resets_at":1790838000', "2026-10-01T07:00:00.000Z"],
    [',"resets_in_seconds":3600', "2026-10-01T02:00:00.000Z"],
  ])(
    "separates quota reset hints from the internal probe: %s",
    async (hint, until) => {
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
      });
      await getDb(ctx.db)
        .insert(aiUsage)
        .values({
          runId,
          feature: "synthetic-plan",
          provider: "openai",
          model: "gpt-6-sol",
          operation: "synthetic.generation",
          durationMs: 1,
          transport: "chatgpt",
          failure: `{"error":{"code":"subscription_sharing_usage_limit_exceeded"${hint}}}`,
          createdAt: new Date("2026-10-01T01:00:00.000Z"),
        });
      const planConnection = async () => ({
        connected: true,
        needsReauthorization: false,
      });
      expect(
        await readChatGptPlanAvailability(ctx.db, {
          planConnection,
          now: new Date("2026-10-01T01:30:00.000Z"),
        }),
      ).toMatchObject({ state: "paused", until });
      expect(
        await readChatGptPlanAvailability(ctx.db, {
          planConnection,
          now: new Date("2026-10-01T06:00:00.000Z"),
        }),
      ).toMatchObject(
        until && new Date(until) > new Date("2026-10-01T06:00:00.000Z")
          ? { state: "paused", until }
          : { state: "available", until: null },
      );
    },
  );
});
