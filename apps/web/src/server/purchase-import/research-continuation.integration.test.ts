import { runEntityId } from "@cubby/schemas/identifiers";
import {
  mailResearchRunInput,
  productResearchRunInput,
} from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  mailboxMessage,
  orderMail,
  product,
  run,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { startProductResearch } from "./product-research-run";
import { productResearchFixture } from "./product-research.fixtures";
import { startMailResearch } from "./research-run";
import { researchServiceFor } from "./research-service";
import { controlRun } from "./run-service";

// Public control -> current research Next: a retry must not require a Vendor or
// Mac, replay settled work, copy stale admission, or lose source ownership.
describe("research continuation", () => {
  const ctx = withTestDb();
  it.each([
    { action: "retry", attempt: null },
    { action: "restart", attempt: 2 },
  ] as const)(
    "converts null-input legacy Product work through $action without changing its history",
    async ({ action, attempt }) => {
      const f = await productResearchFixture(ctx.db, ctx.actor);
      const settled = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Example previously verified widget" }),
        ctx.actor,
      );
      const [started] = await startProductResearch(
        ctx.db,
        {
          ledgerPartyId: f.party.id,
          userId: ctx.actor.userId,
          productIds: [settled.entityId, f.item.entityId],
          cause: "member_request",
          parentRunId: f.parent.id,
        },
        { send: async () => {} },
      );
      if (!started)
        throw new Error("Synthetic historical Product Run missing.");
      await getDb(ctx.db)
        .update(run)
        .set({ input: null, status: "completed", attempt, endedAt: new Date() })
        .where(eq(run.id, started.runId));
      await getDb(ctx.db)
        .update(runTarget)
        .set({
          state: "completed",
          workKey: "",
          outcome: "enriched",
          completedAt: new Date(),
        })
        .where(
          and(
            eq(runTarget.runId, started.runId),
            eq(runTarget.entityId, settled.entityId),
          ),
        );
      await getDb(ctx.db)
        .update(runTarget)
        .set({
          state: "skipped",
          workKey: "",
          outcome: null,
          warning: "Legacy research retained no accepted identity proof",
          completedAt: new Date(),
          targetFingerprint: "a".repeat(64),
        })
        .where(
          and(
            eq(runTarget.runId, started.runId),
            eq(runTarget.entityId, f.item.entityId),
          ),
        );
      const [original] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, started.runId));
      if (!original)
        throw new Error("Synthetic historical Product predecessor missing.");
      const targets = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, original.id));
      await getDb(ctx.db)
        .update(product)
        .set({ model: "Member-confirmed Q-17" })
        .where(eq(product.id, f.item.entityId));
      const input = { runPublicId: original.shortcode, action };
      const result = await controlRun(ctx.db, ctx.actor, input);
      if (!("successorRunId" in result) || !result.successorRunId)
        throw new Error("Synthetic historical Product continuation missing.");
      const successorId = runEntityId.parse(result.successorRunId);
      const [successor] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, successorId));
      if (!successor)
        throw new Error("Synthetic historical Product successor missing.");
      expect(successor).toMatchObject({
        predecessorRunId: original.id,
        parentRunId: f.parent.id,
        attempt: attempt === null ? null : attempt + 1,
        purpose: "product_enrichment",
        cause: "retry",
      });
      expect(
        productResearchRunInput
          .parse(successor.input)
          .products.map((item) => item.productId)
          .sort(),
      ).toEqual(
        (action === "retry"
          ? [f.item.entityId]
          : [settled.entityId, f.item.entityId]
        ).sort(),
      );
      const tasks = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, successor.id));
      expect(
        tasks.every(
          (task) =>
            task.state === "pending" &&
            task.targetFingerprint !== "a".repeat(64),
        ),
      ).toBe(true);
      const next = z
        .object({ status: z.string(), work: z.unknown() })
        .parse(
          await researchServiceFor(
            ctx.db,
            fromPartial<Env>({}),
            successor.id,
          ).researchNext({}, crypto.randomUUID()),
        );
      expect(next.status).toBe("working");
      expect(next).toMatchObject(
        action === "retry"
          ? {
              work: {
                kind: "product",
                product: {
                  productRef: f.item.id,
                  model: "Member-confirmed Q-17",
                },
              },
            }
          : { work: { kind: "product" } },
      );
      expect(
        await getDb(ctx.db).select().from(run).where(eq(run.id, original.id)),
      ).toEqual([original]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(runTarget)
          .where(eq(runTarget.runId, original.id)),
      ).toEqual(targets);
      await controlRun(ctx.db, ctx.actor, {
        runPublicId: successor.shortcode,
        action: "cancel",
      });
      await getDb(ctx.db)
        .update(product)
        .set({ deletedAt: new Date() })
        .where(eq(product.id, f.item.entityId));
      expect(await controlRun(ctx.db, ctx.actor, input)).toMatchObject({
        successorRunId: successor.id,
        successorStatus: "failed",
        created: false,
      });
    },
  );
  it("refuses a null-input legacy Product Run whose target scope contains another kind", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const [started] = await startProductResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        productIds: [f.item.entityId],
        cause: "member_request",
      },
      { send: async () => {} },
    );
    if (!started) throw new Error("Synthetic historical Product Run missing.");
    await getDb(ctx.db)
      .update(run)
      .set({ input: null, status: "failed" })
      .where(eq(run.id, started.runId));
    await getDb(ctx.db)
      .update(runTarget)
      .set({
        entityKind: "run",
        entityId: started.runId,
        workKey: "unexpected-legacy-work",
      })
      .where(eq(runTarget.runId, started.runId));
    const [original] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, started.runId));
    if (!original)
      throw new Error("Synthetic historical Product predecessor missing.");
    await expect(
      controlRun(ctx.db, ctx.actor, {
        runPublicId: original.shortcode,
        action: "retry",
      }),
    ).rejects.toThrow(/Legacy Product target scope/);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, original.id)),
    ).toEqual([]);
  });
  it("continues unresolved cloud Products with fresh context, unknown lineage and a stable cancelled successor", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Example Product continuation member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const settled = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example verified widget" }),
      ctx.actor,
    );
    const unfinished = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example unresolved widget" }),
      ctx.actor,
    );
    const [started] = await startProductResearch(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        productIds: [settled.entityId, unfinished.entityId],
        cause: "member_request",
      },
      { send: async () => {} },
    );
    if (!started) throw new Error("Synthetic Product research missing");
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "completed", outcome: "verified", completedAt: new Date() })
      .where(
        and(
          eq(runTarget.runId, started.runId),
          eq(runTarget.entityId, settled.entityId),
        ),
      );
    await getDb(ctx.db)
      .update(runTarget)
      .set({
        state: "unresolved",
        outcome: "researched_with_gaps",
        completedAt: new Date(),
      })
      .where(
        and(
          eq(runTarget.runId, started.runId),
          eq(runTarget.entityId, unfinished.entityId),
        ),
      );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", attempt: null, endedAt: new Date() })
      .where(eq(run.id, started.runId));
    const [original] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, started.runId));
    if (!original) throw new Error("Synthetic Product predecessor missing");
    const targets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, started.runId));
    await getDb(ctx.db)
      .update(product)
      .set({ model: "Member-confirmed V2" })
      .where(eq(product.id, unfinished.entityId));
    const control = {
      runPublicId: original.shortcode,
      action: "retry" as const,
    };
    const result = await controlRun(ctx.db, ctx.actor, control);
    if (!("successorRunId" in result) || !result.successorRunId)
      throw new Error("Synthetic Product successor missing");
    const successorId = runEntityId.parse(result.successorRunId);
    const [successor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, successorId));
    if (!successor) throw new Error("Synthetic Product successor missing");
    expect(successor).toMatchObject({
      purpose: "product_enrichment",
      vendorId: null,
      vendorAccountId: null,
      actorUserId: ctx.actor.userId,
      ledgerPartyId: party.id,
      parentRunId: original.parentRunId,
      predecessorRunId: original.id,
      cause: "retry",
      attempt: null,
    });
    expect(
      productResearchRunInput
        .parse(successor?.input)
        .products.map((item) => item.productId),
    ).toEqual([unfinished.entityId]);
    expect(
      productResearchRunInput.parse(successor.input).products[0]
        ?.contextFingerprint,
    ).not.toBe(
      productResearchRunInput
        .parse(original.input)
        .products.find((item) => item.productId === unfinished.entityId)
        ?.contextFingerprint,
    );
    expect(
      await researchServiceFor(
        ctx.db,
        fromPartial<Env>({}),
        successorId,
      ).researchNext({}, crypto.randomUUID()),
    ).toMatchObject({
      status: "working",
      work: {
        kind: "product",
        product: {
          productRef: unfinished.id,
          model: "Member-confirmed V2",
        },
      },
    });
    expect(
      await getDb(ctx.db).select().from(run).where(eq(run.id, original.id)),
    ).toEqual([original]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, original.id)),
    ).toEqual(targets);
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: successor.shortcode,
      action: "cancel",
    });
    for (const action of ["retry", "restart"] as const) {
      const replay = await controlRun(ctx.db, ctx.actor, {
        ...control,
        action,
      });
      expect(replay).toMatchObject({
        successorRunId: successorId,
        successorStatus: "failed",
        created: false,
      });
      expect(replay).not.toHaveProperty("dispatchRunId");
    }
    // Explicit control of that cancelled child starts another immutable attempt;
    // replaying its parent above cannot silently expand or reactivate it.
    const nextAttempt = await controlRun(ctx.db, ctx.actor, {
      runPublicId: successor.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in nextAttempt) || !nextAttempt.successorRunId)
      throw new Error("Synthetic later attempt missing");
    const nextId = runEntityId.parse(nextAttempt.successorRunId);
    const [later] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, nextId));
    expect(later).toMatchObject({
      predecessorRunId: successorId,
      cause: "retry",
      attempt: null,
    });
    expect(
      await researchServiceFor(
        ctx.db,
        fromPartial<Env>({}),
        nextId,
      ).researchNext({}, crypto.randomUUID()),
    ).toMatchObject({
      status: "working",
      work: { kind: "product", product: { productRef: unfinished.id } },
    });
  });
  it("retries only unresolved mail through a fresh admitted Run and preserves its history", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Example continuation member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const sources = [];
    for (const messageId of ["example-confirmation", "example-shipping"]) {
      const bodyText = `${messageId}: Example order status`;
      const [mail] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: party.id,
          mailboxId: "synthetic-continuation-mailbox",
          messageId,
          sender: "orders@unknown-shop.example",
          subject: "Example order",
          receivedAt: new Date("2026-09-01T18:00:00Z"),
          rawChecksum: await sha256Hex(bodyText),
          content: { snippet: null, bodyText, bodyHtml: null },
        })
        .returning();
      if (!mail) throw new Error("Synthetic retained mail missing");
      sources.push(mail);
      await getDb(ctx.db).insert(mailboxMessage).values({
        ledgerPartyId: party.id,
        mailboxId: mail.mailboxId,
        messageId,
        checksum: mail.rawChecksum,
        classification: "related",
        classificationVersion: "synthetic-v1",
        status: "pending",
        orderMailId: mail.id,
      });
    }
    const [settled, unfinished] = sources;
    if (!settled || !unfinished) throw new Error("Synthetic mail missing");
    const [started] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        mailboxId: unfinished.mailboxId,
        messageIds: sources.map((source) => source.id),
      },
      { send: async () => {} },
    );
    if (!started) throw new Error("Synthetic research Run missing");
    const originalId = runEntityId.parse(started.runId);
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "completed", outcome: "verified", completedAt: new Date() })
      .where(
        and(eq(runTarget.runId, originalId), eq(runTarget.workKey, settled.id)),
      );
    await getDb(ctx.db)
      .update(runTarget)
      .set({
        state: "unresolved",
        outcome: "ambiguous",
        completedAt: new Date(),
      })
      .where(
        and(
          eq(runTarget.runId, originalId),
          eq(runTarget.workKey, unfinished.id),
        ),
      );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, originalId));
    const [original] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, originalId));
    if (!original) throw new Error("Synthetic predecessor missing");
    const originalTargets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, originalId));
    const control = {
      runPublicId: original.shortcode,
      action: "retry" as const,
    };
    const result = await controlRun(ctx.db, ctx.actor, control);
    if (!("successorRunId" in result) || !result.successorRunId)
      throw new Error("Research successor missing");
    const successorId = runEntityId.parse(result.successorRunId);
    const [successor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, successorId));
    expect(successor).toMatchObject({
      purpose: "mail_import",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      vendorId: null,
      vendorAccountId: null,
      predecessorRunId: originalId,
      parentRunId: original.parentRunId,
      attempt: 2,
      cause: "retry",
    });
    expect(mailResearchRunInput.parse(successor?.input).sources).toEqual([
      { orderMailId: unfinished.id, checksum: unfinished.rawChecksum },
    ]);
    expect(
      await researchServiceFor(
        ctx.db,
        fromPartial<Env>({}),
        successorId,
      ).researchNext({}, crypto.randomUUID()),
    ).toMatchObject({
      status: "working",
      work: { kind: "mail", sources: [{ messageRef: unfinished.id }] },
    });
    expect(
      await getDb(ctx.db).select().from(run).where(eq(run.id, originalId)),
    ).toEqual([original]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, originalId)),
    ).toEqual(originalTargets);
    expect(await controlRun(ctx.db, ctx.actor, control)).toMatchObject({
      successorRunId: successorId,
      created: false,
    });
    const ledger = await getDb(ctx.db).select().from(mailboxMessage);
    expect(
      ledger.find((message) => message.orderMailId === unfinished.id),
    ).toMatchObject({ runId: successorId, status: "researching" });
    expect(
      ledger.find((message) => message.orderMailId === settled.id)?.runId,
    ).toBe(originalId);
  });
});
