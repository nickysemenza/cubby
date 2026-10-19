import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { aiUsage } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { readChatGptPlanAvailability } from "./funding";

// A local budget boundary is only a re-probe time. Reporting it as OpenAI's
// reset gives false usage information; withholding a real hint loses recovery.
describe("ChatGPT quota availability", () => {
  const ctx = withTestDb();
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
