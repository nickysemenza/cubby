import { buildActorContext } from "@cubby/schemas/context";
import { testUserId } from "@cubby/schemas/testing";
import { workQueueOutSchema } from "@cubby/schemas/work-queue";
import { CURRENT_MEMBER_FILTER } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { user } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { requireActor } from "~/server/http/request-context";
import { createMcpServer } from "~/server/mcp/server";
import { callMcpTool } from "~/server/testing/mcp-test-utils";
import { publishAllQualityFixtures } from "~/server/testing/quality.fixtures";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";
import { seedRunFinding } from "~/server/testing/run-finding.fixtures";

// The engine owns filter permutations. This boundary owns identity routing and
// the invariant that caller filters cannot widen the connected member's fence.
describe("activity.queue member routing", () => {
  const ctx = withTestDb("mcp");

  it("returns shared work and the current member's work, with current authority before counts", async () => {
    const otherUser = testUserId("synthetic-work-mcp-other");
    await getDb(ctx.db).insert(user).values({
      id: otherUser,
      name: "Synthetic other member",
      email: "work-mcp-other@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const first = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic first member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const second = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic second member",
      kind: "member",
      userId: otherUser,
    });
    const shared = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic shared queue product",
        categoryId: null,
      }),
      ctx.actor,
    );
    const attentionRun = async (userId: typeof otherUser) => {
      const id = await ensureRun(
        ctx.db,
        { ...ctx.actor, userId, runId: null },
        { purpose: "ai_suggest", trigger: "manual", status: "running" },
      );
      await getDb(ctx.db)
        .update(run)
        .set({ status: "paused_auth" })
        .where(eq(run.id, id));
      const [row] = await getDb(ctx.db)
        .select({ id: run.id, shortcode: run.shortcode })
        .from(run)
        .where(eq(run.id, id));
      if (!row) throw new Error("Synthetic attention Run missing");
      return row;
    };
    const mine = await attentionRun(ctx.actor.userId);
    const theirs = await attentionRun(otherUser);
    await publishAllQualityFixtures(ctx.db);
    const read = async (userId: typeof otherUser, filters = {}) => {
      const response = await callMcpTool(
        createMcpServer(),
        "activity_read",
        {
          action: "queue",
          reason: ["product_category", "account:run"],
          pageSize: 100,
          ...filters,
        },
        requireActor({
          ...createTestRequestContext(ctx.db, { auth: { userId } }),
          actorContext: buildActorContext(userId, "mcp"),
        }),
        {},
      );
      expect(response.isError).not.toBe(true);
      return workQueueOutSchema.parse(response.structuredContent);
    };
    const firstPage = await read(ctx.actor.userId);
    expect(firstPage.items.map((row) => row.id)).toEqual(
      expect.arrayContaining([shared.id, mine.shortcode]),
    );
    expect(firstPage.items.map((row) => row.id)).not.toContain(
      theirs.shortcode,
    );
    expect(
      firstPage.items.find((row) => row.id === mine.shortcode),
    ).toMatchObject({
      executor: "external",
      owners: [{ id: first.shortcode }],
    });
    expect(firstPage.items.find((row) => row.id === shared.id)).toMatchObject({
      shared: true,
      executor: "agent",
    });
    expect((await read(otherUser)).items.map((row) => row.id)).toEqual(
      expect.arrayContaining([shared.id, theirs.shortcode]),
    );
    expect(
      (await read(ctx.actor.userId, { owner: second.shortcode })).meta
        .totalCount,
    ).toBe(1); // Shared work lists every member.
    const own = await read(ctx.actor.userId, { owner: CURRENT_MEMBER_FILTER });
    expect(own.items.map((row) => row.id)).toEqual(
      firstPage.items.map((row) => row.id),
    );
    const page = await read(ctx.actor.userId, { pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.meta.totalCount).toBe(firstPage.meta.totalCount);
    await getDb(ctx.db)
      .update(run)
      .set({ actorUserId: otherUser })
      .where(eq(run.id, mine.id));
    const unresolved = await read(ctx.actor.userId);
    expect(unresolved.items.map((row) => row.id)).not.toContain(mine.shortcode);
    expect(unresolved.meta.totalCount).toBe(firstPage.meta.totalCount - 1);
    expect((await read(otherUser)).items.map((row) => row.id)).not.toContain(
      mine.shortcode,
    );
    const findingRun = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    const finding = await seedRunFinding(ctx.db, {
      runId: findingRun,
      ledgerPartyId: first.id,
      entityKind: "product",
      entityId: shared.entityId,
      kind: "other",
      summary: "Synthetic private source review",
      evidenceFingerprint: "synthetic-current-owner-finding",
    });
    const findings = { reason: "finding", owner: CURRENT_MEMBER_FILTER };
    const visible = await read(ctx.actor.userId, findings);
    expect(visible.items.map((row) => row.key)).toEqual([
      `finding:${finding.id}`,
    ]);
    expect(visible.meta.totalCount).toBe(1);
    expect(visible.items[0]?.owners).toEqual([
      expect.objectContaining({ id: first.shortcode }),
    ]);
    expect((await read(otherUser, { reason: "finding" })).meta.totalCount).toBe(
      0,
    );
    await getDb(ctx.db)
      .update(run)
      .set({ actorUserId: otherUser })
      .where(eq(run.id, findingRun));
    expect((await read(ctx.actor.userId, findings)).meta.totalCount).toBe(0);
    expect((await read(otherUser, { reason: "finding" })).meta.totalCount).toBe(
      0,
    );
  });
});
