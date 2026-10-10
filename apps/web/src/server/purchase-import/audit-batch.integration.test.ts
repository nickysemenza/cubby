import { userId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { auditLog, run, runFinding, user } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadPurchaseAuditBatch } from "./audit-batch";
import { productResearchFixture } from "./product-research.fixtures";
import { auditImportBatch } from "./run-service";

describe("purchase audit restart recovery", () => {
  const ctx = withTestDb();
  const successorFor = async (
    f: Awaited<ReturnType<typeof productResearchFixture>>,
  ) => {
    return await insertWithShortcode(ctx.db, "run", {
      purpose: "account_sync",
      trigger: "manual",
      status: "running",
      agentSessionId: "synthetic-audit-agent",
      predecessorRunId: f.parent.id,
      ledgerPartyId: f.party.id,
      actorUserId: ctx.actor.userId,
      actorName: f.party.name,
      actorEmail: "research@example.test",
      actorLedgerPartyShortcode: f.party.shortcode,
      actorLedgerPartyName: f.party.name,
      actorLedgerPartyKind: "member",
    });
  };

  it("includes unaudited predecessor purchases when the successor has no new writes", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, { legacy: true });
    const successor = await successorFor(f);

    const batch = await loadPurchaseAuditBatch(ctx.db, successor.id);
    expect(batch.map((row) => row.id)).toEqual([f.order.id]);
    expect(batch[0]?.expenses).toHaveLength(1);
    expect(batch[0]?.expenses[0]?.amount).toBe(24);
  });

  it("keeps unique stable pages across repeated writes and a malformed retry cycle", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, { legacy: true });
    const successor = await successorFor(f);
    const ids = [f.order.id];
    for (let index = 0; index < 26; index++) {
      const order = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: f.order.vendorId,
        orderId: `SYNTHETIC-RETRY-${index}`,
        date: "2026-09-01",
      });
      ids.push(order.id);
      await getDb(ctx.db).insert(auditLog).values({
        entityKind: "purchase",
        entityId: order.id,
        action: "create",
        userId: ctx.actor.userId,
        runId: f.parent.id,
      });
    }
    await getDb(ctx.db).insert(auditLog).values({
      entityKind: "purchase",
      entityId: f.order.id,
      action: "update",
      userId: ctx.actor.userId,
      runId: successor.id,
    });
    await getDb(ctx.db)
      .update(run)
      .set({ predecessorRunId: successor.id })
      .where(eq(run.id, f.parent.id));
    const first = await loadPurchaseAuditBatch(ctx.db, successor.id);
    const second = await loadPurchaseAuditBatch(ctx.db, successor.id, 25);
    expect(first).toHaveLength(25);
    expect(second).toHaveLength(2);
    expect([...first, ...second].map((row) => row.id)).toEqual(ids.sort());
    expect(await loadPurchaseAuditBatch(ctx.db, successor.id, 50)).toEqual([]);
  });

  it.each([
    "owner",
    "actor",
    "account",
    "vendor",
    "purpose",
    "audited",
    "deleted",
  ] as const)(
    "does not inherit predecessor writes across the %s boundary",
    async (boundary) => {
      const f = await productResearchFixture(ctx.db, ctx.actor, {
        legacy: true,
      });
      const successor = await successorFor(f);
      const foreignOwner = await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Other audit owner",
        kind: "member",
      });
      const foreignVendor = await insertWithShortcode(ctx.db, "vendor", {
        name: "Other audit shop",
        website: null,
      });
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        label: "Other audit account",
        ledgerPartyId: f.party.id,
        vendorId: foreignVendor.id,
      });
      const foreignActor = userId.parse(crypto.randomUUID());
      await getDb(ctx.db)
        .insert(user)
        .values({
          id: foreignActor,
          name: "Other audit actor",
          email: `${foreignActor}@example.test`,
        });
      const patch =
        boundary === "owner"
          ? { ledgerPartyId: foreignOwner.id }
          : boundary === "actor"
            ? { actorUserId: foreignActor }
            : boundary === "account"
              ? { vendorAccountId: account.id }
              : boundary === "vendor"
                ? { vendorId: foreignVendor.id }
                : boundary === "purpose"
                  ? { purpose: "product_enrichment" }
                  : boundary === "audited"
                    ? { auditedAt: new Date() }
                    : { deletedAt: new Date() };
      await getDb(ctx.db).update(run).set(patch).where(eq(run.id, f.parent.id));
      expect(await loadPurchaseAuditBatch(ctx.db, successor.id)).toEqual([]);
    },
  );

  it("retains inherited findings without granting a fix on predecessor records", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, { legacy: true });
    const successor = await successorFor(f);
    const batch = await loadPurchaseAuditBatch(ctx.db, successor.id);
    const expenseId = batch[0]?.expenses[0]?.id;
    if (!expenseId) throw new Error("Synthetic inherited expense missing");
    const assess = async () => ({
      findings: [
        {
          kind: "wrong_product" as const,
          targetPurchaseId: f.order.id,
          summary: "Inherited line needs member investigation",
          probability: 0.5,
          proposedFix: {
            kind: "relink_product" as const,
            expenseId,
            productId: f.item.entityId,
          },
        },
      ],
    });
    await auditImportBatch(
      ctx.db,
      {
        runId: successor.id,
        operationId: "synthetic-audit",
        offset: 0,
      },
      assess,
    );
    const findings = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(eq(runFinding.runId, successor.id));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      status: "open",
      proposedFix: null,
      summary: "Inherited line needs member investigation",
    });
  });
  it("keeps a mismatched inherited expense fix report-only beside a writable purchase", async () => {
    const f = await productResearchFixture(ctx.db, ctx.actor, { legacy: true });
    const successor = await successorFor(f);
    const writable = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.order.vendorId,
      orderId: "SYNTHETIC-SUCCESSOR",
      date: "2026-09-01",
    });
    await getDb(ctx.db).insert(auditLog).values({
      entityKind: "purchase",
      entityId: writable.id,
      action: "create",
      userId: ctx.actor.userId,
      runId: successor.id,
    });
    const batch = await loadPurchaseAuditBatch(ctx.db, successor.id);
    const expenseId = batch.find((row) => row.id === f.order.id)?.expenses[0]
      ?.id;
    if (!expenseId) throw new Error("Synthetic inherited expense missing");
    await auditImportBatch(
      ctx.db,
      {
        runId: successor.id,
        operationId: "synthetic-mismatched-audit",
        offset: 0,
      },
      async () => ({
        findings: [
          {
            kind: "wrong_product" as const,
            targetPurchaseId: writable.id,
            summary: "Mismatched inherited target",
            probability: 0.5,
            proposedFix: {
              kind: "relink_product" as const,
              expenseId,
              productId: f.item.entityId,
            },
          },
        ],
      }),
    );
    const findings = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(eq(runFinding.runId, successor.id));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      entityKind: "purchase",
      entityId: writable.id,
      proposedFix: null,
    });
  });
});
