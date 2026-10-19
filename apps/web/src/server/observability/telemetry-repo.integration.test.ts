import type { McpToolCallTelemetry } from "@cubby/schemas/telemetry";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { mcpToolCall } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { persistTelemetryMessages } from "./telemetry-repo";

describe("McpToolCall run attribution", () => {
  const ctx = withTestDb();

  const call = (runId?: string): McpToolCallTelemetry => ({
    version: 1,
    queueType: "telemetry",
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    release: "synthetic-release",
    type: "mcp_tool_call",
    toolName: "entity_read",
    outcome: "success",
    registeredAtCall: true,
    surface: runId ? "in_app_agent" : "external_mcp",
    userId: ctx.actor.userId,
    clientId: null,
    ...(runId ? { runId } : {}),
  });

  it("files agent calls under their Run and drops a Run deleted before ingest", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const agent = call(runId);
    const vanished = call(crypto.randomUUID());
    const external = call();

    await persistTelemetryMessages(ctx.db, [agent, vanished, external]);

    const rows = await getDb(ctx.db)
      .select({
        id: mcpToolCall.id,
        runId: mcpToolCall.runId,
        surface: mcpToolCall.surface,
      })
      .from(mcpToolCall);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(agent.eventId)).toEqual({
      id: agent.eventId,
      runId,
      surface: "in_app_agent",
    });
    expect(byId.get(vanished.eventId)?.runId).toBeNull();
    expect(byId.get(external.eventId)).toMatchObject({
      runId: null,
      surface: "external_mcp",
    });
  });
});
