import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimAiEvaluation,
  publishAiEvaluation,
} from "~/server/ai/repo/ai-evaluation";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  searchDocument,
  location,
  user,
} from "~/server/db/schema";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { createLocationFixture } from "~/server/testing/repo.fixtures";

import {
  connectionSourceFingerprint,
  scheduleConnectionRefresh,
} from "./connection-refresh";
import { ensureRun, systemActor } from "./ensure-run";

// Failure mode: completing a negative scan permanently hides a later endpoint,
// or a projection rebuild creates unnecessary new evaluations with identical content.
describe("connection discovery roster freshness", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await getDb(ctx.db).insert(user).values({
      id: systemActor().userId,
      name: "Synthetic system",
      email: "synthetic-system@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  it("reschedules a completed negative scan for new, changed and retired endpoints", async () => {
    const source = await createLocationFixture(
      ctx.db,
      {
        name: "Synthetic discovery source",
        type: "room",
        aliases: [],
      },
      ctx.actor,
    );
    const ref = { entityKind: "location" as const, entityId: source.id };
    await activateAiRefresh(ctx.db, "synthetic-connection-roster", {
      enabled: true,
    });
    const firstRun = await scheduleConnectionRefresh(ctx.db, ref);
    if (!firstRun)
      throw new Error("Synthetic connection discovery was not scheduled");
    expect(await scheduleConnectionRefresh(ctx.db, ref)).toBe(firstRun);
    const [first] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, firstRun));
    if (!first) throw new Error("Synthetic connection evaluation is missing");
    const claimed = await claimAiEvaluation(ctx.db, first.id);
    if (!claimed?.attemptToken)
      throw new Error("Synthetic evaluation was not claimed");
    await publishAiEvaluation(
      ctx.db,
      first.id,
      claimed.attemptToken,
      async () => ({ source: ref, discovered: true }),
    );
    const before = await connectionSourceFingerprint(ctx.db, ref);
    expect(await scheduleConnectionRefresh(ctx.db, ref)).toBeNull();

    await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    expect(await connectionSourceFingerprint(ctx.db, ref)).toBe(before);

    const endpoint = await createLocationFixture(
      ctx.db,
      {
        name: "Synthetic new endpoint",
        type: "room",
        aliases: [],
      },
      ctx.actor,
    );
    expect(await connectionSourceFingerprint(ctx.db, ref)).not.toBe(before);
    await refreshSearchDocument(ctx.db, "location", endpoint.entityId);
    const afterInsert = await connectionSourceFingerprint(ctx.db, ref);
    expect(afterInsert).not.toBe(before);
    expect(await scheduleConnectionRefresh(ctx.db, ref)).not.toBe(firstRun);
    await refreshSearchDocument(ctx.db, "location", endpoint.entityId);
    expect(await connectionSourceFingerprint(ctx.db, ref)).toBe(afterInsert);

    await getDb(ctx.db)
      .update(searchDocument)
      .set({ sourceHash: "synthetic-changed-content" })
      .where(
        and(
          eq(searchDocument.entityKind, "location"),
          eq(searchDocument.entityId, endpoint.entityId),
        ),
      );
    const afterContent = await connectionSourceFingerprint(ctx.db, ref);
    expect(afterContent).not.toBe(afterInsert);
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, endpoint.entityId));
    expect(await connectionSourceFingerprint(ctx.db, ref)).not.toBe(
      afterContent,
    );
  });
});
