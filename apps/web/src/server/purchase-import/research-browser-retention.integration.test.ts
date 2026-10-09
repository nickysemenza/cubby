import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  researchRetention,
  run,
  runEvidence,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { researchBrowserAccountIds } from "./research-browser-retention";

// Cleanup must inventory every transport before disposable SQL is erased.
// Wrong receipts must fail before metadata reads; historical commands without
// transport identity cannot silently turn into a successful empty inventory.
describe("research browser cleanup inventory", () => {
  const ctx = withTestDb();
  async function fixture() {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic cleanup member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const accounts = [];
    for (const label of ["Original", "Command", "Evidence"]) {
      const seller = await insertWithShortcode(ctx.db, "vendor", {
        name: `Synthetic ${label} transport shop`,
      });
      accounts.push(
        await insertWithShortcode(ctx.db, "vendorAccount", {
          label: `Synthetic ${label} account`,
          vendorId: seller.id,
          ledgerPartyId: member.id,
        }),
      );
    }
    const [original, command, evidence] = accounts;
    if (!original || !command || !evidence)
      throw new Error("Synthetic account fixture unavailable");
    const scope = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "needs_review",
      trigger: "manual",
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: member.name,
      actorEmail: "inventory@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: "member",
      vendorAccountId: original.id,
      retiredAt: new Date(),
      retirementReason: "unrelated_source",
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: scope.id,
        entityKind: "run",
        entityId: scope.id,
        targetFingerprint: "synthetic",
      })
      .returning();
    if (!target) throw new Error("Synthetic target unavailable");
    const receiptId = crypto.randomUUID();
    await getDb(ctx.db)
      .insert(researchRetention)
      .values({
        id: receiptId,
        runId: scope.id,
        workRef: target.id,
        ledgerPartyId: member.id,
        orderMailId: crypto.randomUUID(),
        mailboxId: "synthetic-mailbox",
        messageId: "synthetic-message",
        checksum: "a".repeat(64),
        phase: "fenced",
        plan: {
          originOperationId: "synthetic-inventory",
          objectKeys: [],
          screenshotRefs: [],
          retiredRunIds: [scope.id],
          successors: [],
        },
      });
    await getDb(ctx.db)
      .insert(runOperation)
      .values({
        runId: scope.id,
        operationId: "synthetic-browser",
        kind: "browser_command",
        inputFingerprint: "a".repeat(64),
        result: { brokerAccountId: command.id },
      });
    await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: scope.id,
        targetId: target.id,
        kind: "browser_capture",
        objectKey: `synthetic/${scope.id}`,
        checksum: "a".repeat(64),
        mediaType: "text/html",
        sourceMetadata: { brokerAccountId: evidence.id },
      });
    return { scope, receiptId, accounts };
  }

  it("collects every server-recorded command/evidence transport plus legacy account before erasure", async () => {
    const f = await fixture();
    expect(
      await researchBrowserAccountIds(ctx.db, {
        runId: f.scope.id,
        receiptId: f.receiptId,
      }),
    ).toEqual(f.accounts.map((account) => account.id).sort());
  });

  it("authorizes the owning retirement receipt before parsing private account metadata", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(runEvidence)
      .set({ sourceMetadata: { brokerAccountId: "invalid-private-account" } })
      .where(eq(runEvidence.runId, f.scope.id));
    await expect(
      researchBrowserAccountIds(ctx.db, {
        runId: f.scope.id,
        receiptId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/not authorized|receipt/i);
  });

  it("keeps missing historical transport identity as a pending cleanup gap", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(run)
      .set({ vendorAccountId: null })
      .where(eq(run.id, f.scope.id));
    await getDb(ctx.db)
      .update(runOperation)
      .set({ result: {} })
      .where(eq(runOperation.runId, f.scope.id));
    await getDb(ctx.db)
      .update(runEvidence)
      .set({ sourceMetadata: {} })
      .where(eq(runEvidence.runId, f.scope.id));
    await expect(
      researchBrowserAccountIds(ctx.db, {
        runId: f.scope.id,
        receiptId: f.receiptId,
      }),
    ).rejects.toThrow(/historical|identity/i);
  });
});
