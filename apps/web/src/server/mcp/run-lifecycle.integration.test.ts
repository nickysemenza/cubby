import { runShortcode, userId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import { user } from "~/server/db/auth.schema";
import { run as runTable } from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { createMcpServer } from "~/server/mcp/server";
import { admitProductResearch } from "~/server/purchase-import/product-research-run";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { callMcpTool } from "./mcp-test-utils";

// Failure modes: lifecycle controls are unavailable; approval leaks through the
// narrower surface; foreign Runs can be stopped; retries mutate settled attempts
// or start duplicate successors instead of reusing their retained lineage.
describe("Run lifecycle through MCP", () => {
  const ctx = withTestDb("mcp");

  beforeEach(() => {
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_AGENT_QUEUE: {
          send: async (_event: PurchaseAgentEvent) => undefined,
        },
      }),
    );
  });
  afterEach(() => setCfEnv(undefined));

  const call = async (runId: string, controlAction: string) => {
    const request = requireActor(
      createTestRequestContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }),
    );
    return callMcpTool(
      createMcpServer(),
      "run",
      {
        action: "lifecycle",
        runId,
        controlAction,
      },
      request,
      { entityKernel: entityKernelContextSchema.parse(request) },
    );
  };

  const prepare = async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic research member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic catalog hand tool" }),
      ctx.actor,
    );
    const [admission] = await admitProductResearch(ctx.db, {
      ledgerPartyId: member.id,
      userId: ctx.actor.userId,
      productIds: [target.entityId],
      cause: "member_request",
    });
    if (!admission) throw new Error("Synthetic Run was not admitted");
    return admission.run;
  };

  it("stops owned research and reuses one immutable retry successor before restarting", async () => {
    const original = await prepare();
    const stopped = await call(original.shortcode, "cancel");
    expect(stopped.isError).not.toBe(true);
    const persisted = await getDb(ctx.db).query.run.findFirst({
      where: eq(runTable.id, original.id),
    });
    expect(persisted).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
    });
    const retried = await call(original.shortcode, "retry");
    expect(retried.isError).not.toBe(true);
    const successor = z
      .object({
        successor: z.object({ publicId: runShortcode, created: z.boolean() }),
      })
      .parse(retried.structuredContent).successor;
    expect(successor.created).toBe(true);
    const replay = await call(original.shortcode, "retry");
    expect(replay.isError).not.toBe(true);
    expect(replay.structuredContent).toMatchObject({
      successor: { publicId: successor.publicId, created: false },
    });
    expect(
      await getDb(ctx.db).query.run.findFirst({
        where: eq(runTable.id, original.id),
      }),
    ).toMatchObject({
      status: "failed",
      failureCode: "user_cancelled",
      endedAt: persisted!.endedAt,
    });
    expect((await call(successor.publicId, "cancel")).isError).not.toBe(true);
    const restarted = await call(successor.publicId, "restart");
    expect(restarted.isError).not.toBe(true);
    const next = z
      .object({ successor: z.object({ publicId: runShortcode }) })
      .parse(restarted.structuredContent).successor;
    expect(next.publicId).not.toBe(successor.publicId);
    const nextRow = await getDb(ctx.db).query.run.findFirst({
      where: eq(runTable.shortcode, next.publicId),
    });
    const previous = await getDb(ctx.db).query.run.findFirst({
      where: eq(runTable.shortcode, successor.publicId),
    });
    expect(nextRow?.predecessorRunId).toBe(previous?.id);
  });

  it("refuses approval and foreign ownership before changing a Run", async () => {
    const original = await prepare();
    for (const action of ["approve", "reject"]) {
      expect((await call(original.shortcode, action)).isError).toBe(true);
    }
    expect(
      await getDb(ctx.db).query.run.findFirst({
        where: eq(runTable.id, original.id),
      }),
    ).toMatchObject({ status: "running" });
    const foreignUserId = userId.parse(crypto.randomUUID());
    await getDb(ctx.db).insert(user).values({
      id: foreignUserId,
      name: "Synthetic other member",
      email: "other@example.test",
    });
    const foreign = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
      userId: foreignUserId,
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ ledgerPartyId: foreign.id, actorUserId: foreignUserId })
      .where(eq(runTable.id, original.id));
    expect((await call(original.shortcode, "cancel")).isError).toBe(true);
    expect(
      await getDb(ctx.db).query.run.findFirst({
        where: eq(runTable.id, original.id),
      }),
    ).toMatchObject({ status: "running" });
  });
});
