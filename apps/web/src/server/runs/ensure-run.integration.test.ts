import { buildActorContext } from "@cubby/schemas/context";
import { executionAuthorizationRef } from "@cubby/schemas/execution-authorization";
import {
  mailResearchRunInput,
  productResearchRunInput,
} from "@cubby/schemas/run-fields";
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
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

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

  // Automatic descendants must share one spend/candidate budget while their
  // causal lineage still points to the actual work that discovered them.
  it("carries execution authority through research descendants without replacing the causal parent", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic research member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const approvalRoot = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const authorization = executionAuthorizationRef.parse({
      runId: approvalRoot,
      approvalFingerprint: "a".repeat(64),
    });
    const source = mailResearchRunInput.parse({
      kind: "mail_research",
      sources: [{ orderMailId: crypto.randomUUID(), checksum: "b".repeat(64) }],
    });
    const parent = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_import",
      trigger: "discovery",
      input: { ...source, executionAuthorization: authorization },
    });
    const child = await ensureRun(ctx.db, ctx.actor, {
      purpose: "product_enrichment",
      trigger: "discovery",
      parentRunId: parent,
      input: productResearchRunInput.parse({
        kind: "product_research",
        instructionRevision: 1,
        products: [
          {
            productId: crypto.randomUUID(),
            contextFingerprint: "c".repeat(64),
          },
        ],
      }),
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, child));
    expect(saved?.parentRunId).toBe(parent);
    expect(productResearchRunInput.parse(saved?.input)).toMatchObject({
      executionAuthorization: authorization,
    });
  });

  it("preserves an unfinished keyed Run when its asynchronous starter replays", async () => {
    const input = {
      purpose: "background" as const,
      trigger: "scheduled" as const,
      status: "running" as const,
      clientKey: "synthetic-unfinished-work",
    };
    const first = await ensureRun(ctx.db, ctx.actor, input);
    expect(await ensureRun(ctx.db, ctx.actor, input)).toBe(first);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, first));
    expect(saved).toMatchObject({ status: "running", endedAt: null });
  });
  it("records an explicit causal parent without treating it as a retry predecessor", async () => {
    const parent = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const child = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "discovery",
      status: "running",
      parentRunId: parent,
      cause: "source_discovered",
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, child));
    expect(saved).toMatchObject({
      parentRunId: parent,
      predecessorRunId: null,
      cause: "source_discovered",
      attempt: 1,
    });
  });

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
