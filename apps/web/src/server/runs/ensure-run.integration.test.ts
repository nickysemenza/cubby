import { buildActorContext } from "@cubby/schemas/context";
import { fromPartial } from "@total-typescript/shoehorn";
import { count, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { run as runTable, user } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  type PreviewEntityPorts,
  previewEntity,
} from "~/server/entity-kernel/preview";
import { getDb } from "~/server/repo/database-helpers";

import { aiCallRunInput, ensureRun, systemActor } from "./ensure-run";

const HOUR = new Date("2026-09-23T14:20:00.000Z");
const SAME_HOUR = new Date("2026-09-23T14:59:59.000Z");
const NEXT_HOUR = new Date("2026-09-23T15:00:00.000Z");

const runCount = async (db: Parameters<typeof getDb>[0]) => {
  const [row] = await getDb(db).select({ n: count() }).from(runTable);
  return row?.n ?? 0;
};

describe("ephemeral AI runs", () => {
  const ctx = withTestDb("mcp");

  it("groups two calls by the same actor in the same UTC hour into one ai_suggest run", async () => {
    const first = await ensureRun(
      ctx.db,
      ctx.actor,
      aiCallRunInput(ctx.actor, { now: HOUR }),
    );
    const second = await ensureRun(
      ctx.db,
      ctx.actor,
      aiCallRunInput(ctx.actor, { now: SAME_HOUR }),
    );
    expect(second).toBe(first);
    const [row] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, first));
    expect(row).toMatchObject({
      purpose: "ai_suggest",
      trigger: "ephemeral",
      channel: "mcp",
    });
    expect(await runCount(ctx.db)).toBe(1);
  });

  it("opens a new run for the next hour, another channel, or another actor", async () => {
    const base = await ensureRun(
      ctx.db,
      ctx.actor,
      aiCallRunInput(ctx.actor, { now: HOUR }),
    );
    const nextHour = await ensureRun(
      ctx.db,
      ctx.actor,
      aiCallRunInput(ctx.actor, { now: NEXT_HOUR }),
    );
    const web = buildActorContext(ctx.actor.userId, "web");
    const otherChannel = await ensureRun(
      ctx.db,
      web,
      aiCallRunInput(web, { now: HOUR }),
    );
    const system = systemActor();
    await getDb(ctx.db).insert(user).values({
      id: system.userId,
      name: "System",
      email: "system@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const systemRun = await ensureRun(
      ctx.db,
      system,
      aiCallRunInput(system, { now: HOUR }),
    );
    expect(new Set([base, nextHour, otherChannel, systemRun]).size).toBe(4);
  });

  it("keeps a page's runKey run separate from the hourly run", async () => {
    const page = await ensureRun(
      ctx.db,
      ctx.actor,
      aiCallRunInput(ctx.actor, { runKey: "page-1", now: HOUR }),
    );
    const hourly = await ensureRun(
      ctx.db,
      ctx.actor,
      aiCallRunInput(ctx.actor, { now: HOUR }),
    );
    expect(page).not.toBe(hourly);
  });

  it("mints one run for a batch preview and for later single previews in the hour", async () => {
    const suggest = vi.fn<PreviewEntityPorts["suggest"]>();
    suggest.mockResolvedValue({ suggestions: {} });
    const ports: PreviewEntityPorts = {
      suggest,
      resolveExpense: vi.fn(),
      resolveTask: vi.fn(),
      // The real ensureRun with the production key, pinned to a fixed clock.
      ensureRun: (db, actor, input, generator) =>
        ensureRun(
          db,
          actor,
          input.clientKey ? input : aiCallRunInput(actor, { now: HOUR }),
          generator,
        ),
    };
    const context = fromPartial<EntityKernelContext>({
      db: ctx.db,
      actorContext: ctx.actor,
    });
    const item = {
      entity: "product" as const,
      data: { name: "Synthetic widget" },
      context: { suggest: true, targets: ["categoryId"] },
    };
    await Promise.all(
      Array.from({ length: 5 }, () => previewEntity(context, item, ports)),
    );
    await previewEntity(context, item, ports);
    expect(suggest).toHaveBeenCalledTimes(6);
    expect(await runCount(ctx.db)).toBe(1);
    // Every suggestion call carried the same run.
    expect(new Set(suggest.mock.calls.map(([, runId]) => runId)).size).toBe(1);
  });
});
