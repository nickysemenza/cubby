import { buildActorContext } from "@cubby/schemas/context";
import { executionAuthorizationRef } from "@cubby/schemas/execution-authorization";
import {
  mailResearchRunInput,
  productResearchRunInput,
} from "@cubby/schemas/run-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { count, eq } from "drizzle-orm";
import { withTestDb, countTestDbQueries } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { withRequestDb } from "~/server/db";
import { run as runTable, user } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  type PreviewEntityPorts,
  previewEntity,
} from "~/server/entity-kernel/preview";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { persistTelemetryMessages } from "~/server/repo/telemetry";

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

  it("opens an orphaned usage fallback before its telemetry transaction", async () => {
    await getDb(ctx.db).insert(user).values({
      id: systemActor().userId,
      name: "System",
      email: "system@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const measured = await countTestDbQueries(() =>
      persistTelemetryMessages(ctx.db, [
        {
          version: 1,
          queueType: "telemetry",
          type: "ai_usage",
          eventId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          release: "synthetic",
          feature: "field-suggestion",
          provider: "openai",
          model: "gpt-6-sol",
          operation: "suggestFields",
          runId: crypto.randomUUID(),
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
          cacheStatus: "hit",
          transport: "cache",
          entityKind: null,
          entityId: null,
        },
      ]),
    );
    const begin = measured.statements.findIndex((statement) =>
      /^begin\b/iu.test(statement),
    );
    const runInsert = measured.statements.findIndex((statement) =>
      /insert into "Run"/u.test(statement),
    );
    expect(runInsert).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThan(runInsert);
  });

  // Delayed usage, retries and out-of-order delivery must preserve completion
  // without making every field-hint read rewrite the page Run.
  it("advances completed AI Run timestamps from persisted usage monotonically", async () => {
    const id = await ensureRun(
      ctx.db,
      ctx.actor,
      aiCallRunInput(ctx.actor, { runKey: "synthetic-usage-page" }),
    );
    const endedAt = new Date("2030-01-01T00:00:00Z");
    const event = {
      version: 1 as const,
      queueType: "telemetry" as const,
      type: "ai_usage" as const,
      eventId: crypto.randomUUID(),
      occurredAt: endedAt.toISOString(),
      release: "synthetic",
      feature: "field-suggestion",
      provider: "openai",
      model: "gpt-6-sol",
      operation: "suggestFields",
      runId: id,
      inputTokens: 1,
      outputTokens: 1,
      durationMs: 1,
      cacheStatus: "hit" as const,
      transport: "cache" as const,
      entityKind: null,
      entityId: null,
    };
    await persistTelemetryMessages(ctx.db, [event]);
    const saved = async () =>
      (
        await getDb(ctx.db).select().from(runTable).where(eq(runTable.id, id))
      )[0];
    expect((await saved())?.endedAt).toEqual(endedAt);
    await persistTelemetryMessages(ctx.db, [
      event,
      {
        ...event,
        eventId: crypto.randomUUID(),
        occurredAt: "2029-01-01T00:00:00Z",
      },
    ]);
    expect((await saved())?.endedAt).toEqual(endedAt);
  });

  it("shares concurrent page Run lookups only within their database request", async () => {
    const input = aiCallRunInput(ctx.actor, {
      runKey: "synthetic-shared-page",
    });
    const id = await ensureRun(ctx.db, ctx.actor, input);
    const read = () =>
      withRequestDb({ strong: "unused", boundedStale: "unused" }, () =>
        countTestDbQueries(() =>
          Promise.all(
            Array.from({ length: 5 }, () =>
              ensureRun(ctx.db, ctx.actor, input),
            ),
          ),
        ),
      );
    const first = await read();
    expect(first.result).toEqual(Array.from({ length: 5 }, () => id));
    expect(first.queryCount).toBe(1);
    const second = await read();
    expect(second.queryCount).toBe(1);
  });

  // Reading stored hints must not rewrite the page Run or serialize fields
  // behind a shared row lock. Usage persistence owns the completion timestamp.
  it("reuses a completed keyed Run without touching its timestamps", async () => {
    const input = aiCallRunInput(ctx.actor, { runKey: "synthetic-page-pass" });
    const id = await ensureRun(ctx.db, ctx.actor, input);
    const endedAt = new Date("2026-01-01T00:00:00Z");
    await getDb(ctx.db)
      .update(runTable)
      .set({ endedAt })
      .where(eq(runTable.id, id));
    const [before] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, id));
    expect(await ensureRun(ctx.db, ctx.actor, input)).toBe(id);
    const [after] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, id));
    expect(after?.endedAt).toEqual(before?.endedAt);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

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
