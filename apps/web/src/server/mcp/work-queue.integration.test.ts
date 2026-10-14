import { parseEntityId } from "@cubby/schemas/identifiers";
import { recordStatementRowsInput } from "@cubby/schemas/statement-row";
import { testUserId } from "@cubby/schemas/testing";
import {
  workQueueHouseholdInput,
  workQueueOutSchema,
} from "@cubby/schemas/work-queue";
import { eq, sql } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { user } from "~/server/db/auth.schema";
import {
  imageProcessingJob,
  financialAccount as financialAccountTable,
  financialTransactionAllocation,
  run as runTable,
  photoRunImage,
  photoGroupProposal,
  runFinding,
  statementRow,
  suggestion,
  vendorAccount,
} from "~/server/db/schema";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { createMcpServer } from "~/server/mcp/server";
import { proposePhotoGroups } from "~/server/photo-import-run/proposals";
import { resolveRunFinding } from "~/server/purchase-import/findings";
import { stopRunForReview } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import { IMAGE_DESCRIPTION_PROCESSOR_REVISION } from "~/server/repo/image-processing";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  insertEntityAttachments,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { recordStatementRows } from "~/server/repo/statement-row";
import { readWorkQueue } from "~/server/repo/work-queue";
import { requireActor } from "~/server/request-context";
import { ensureRun } from "~/server/runs/ensure-run";
import { createTestRequestContext } from "~/server/testing/request-context";

// Failure modes: another member's private work leaks into an actionable page;
// shared research disappears; caller filters widen authority; a cached member
// result crosses connections; account authority follows its current owner,
// missing ownership fails closed, and filtering precedes counts and paging. Assert through the production MCP transport.
describe("member actionable Work queue", () => {
  const ctx = withTestDb("mcp");

  // Recent amounts remain evidence, but investigation waits through two full business days.
  it("separates awaiting posting from actionable settlement and transfer work", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic grace owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const account = (
      await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic grace account",
        identity: { kind: "cash" },
        ledgerPartyId: member.shortcode,
      })
    ).output;
    const accountId = await resolveOrThrow(
      ctx.db,
      "financialAccount",
      account.id,
    );
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId,
        kind: "account_transfer",
        status: "posted",
        amount: 25,
        transactionDate: "2026-10-09",
        postedDate: "2026-10-09",
      },
    );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic settlement grace vendor",
    });
    const sourceAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: member.id,
      label: "Synthetic settlement source",
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: sourceAccount.id,
      date: "2026-09-01",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: order.id,
      name: "Synthetic gross line",
      costType: "materials",
      cost: 30,
      date: "2026-09-01",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
    });
    const charge = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId,
      kind: "purchase",
      status: "posted",
      amount: 25,
      transactionDate: "2026-10-09",
      postedDate: "2026-10-09",
    });
    await getDb(ctx.db)
      .insert(financialTransactionAllocation)
      .values({ transactionId: charge.id, purchaseId: order.id, amount: 25 });
    const readPurchase = (kind: "awaiting_posting" | "repair") =>
      readWorkQueue(
        ctx.db,
        member.id,
        workQueueHouseholdInput.parse({
          source: "reconciliation",
          query: order.shortcode,
          kind,
        }),
        false,
      );
    const read = (kind?: "awaiting_posting" | "repair") =>
      readWorkQueue(
        ctx.db,
        member.id,
        workQueueHouseholdInput.parse({
          source: "reconciliation",
          query: transaction.shortcode,
          kind,
        }),
        false,
      );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-13T19:00:00Z"));
      expect((await read("awaiting_posting")).items).toEqual([
        expect.objectContaining({
          id: transaction.shortcode,
          kind: "awaiting_posting",
          amount: 25,
        }),
      ]);
      expect((await read("repair")).meta.totalCount).toBe(0);
      expect((await readPurchase("awaiting_posting")).items).toEqual([
        expect.objectContaining({
          id: order.shortcode,
          kind: "awaiting_posting",
          amount: 30,
        }),
      ]);
      expect((await readPurchase("repair")).meta.totalCount).toBe(0);
      vi.setSystemTime(new Date("2026-10-14T19:00:00Z"));
      expect((await read("repair")).items).toEqual([
        expect.objectContaining({ id: transaction.shortcode, kind: "repair" }),
      ]);
      expect((await read("awaiting_posting")).meta.totalCount).toBe(0);
      expect((await readPurchase("repair")).items).toEqual([
        expect.objectContaining({ id: order.shortcode, amount: 30 }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A present undated transaction uses its first observation, not an old
  // Purchase date; the observation's LA day can precede its UTC calendar day.
  it("ages undated settlement transactions from their household observation day", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic undated settlement owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic undated settlement vendor",
    });
    const sourceAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: member.id,
      label: "Synthetic undated source",
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic undated tender",
      identity: { kind: "cash" },
      ledgerPartyId: member.id,
    });
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: sourceAccount.id,
      date: "2026-09-01",
    });
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: order.id,
      name: "Synthetic undated gross line",
      costType: "materials",
      cost: 30,
      date: "2026-09-01",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
    });
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: account.id,
        kind: "purchase",
        status: "pending",
        amount: 25,
        transactionDate: null,
        postedDate: null,
        createdAt: new Date("2026-10-09T01:00:00Z"),
      },
    );
    await getDb(ctx.db)
      .insert(financialTransactionAllocation)
      .values({
        transactionId: transaction.id,
        purchaseId: order.id,
        amount: 25,
      });
    const read = (kind: "awaiting_posting" | "repair") =>
      readWorkQueue(
        ctx.db,
        member.id,
        workQueueHouseholdInput.parse({
          source: "reconciliation",
          query: order.shortcode,
          kind,
        }),
        false,
      );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-12T19:00:00Z"));
      expect((await read("awaiting_posting")).items).toEqual([
        expect.objectContaining({ id: order.shortcode, amount: 30 }),
      ]);
      expect((await read("repair")).meta.totalCount).toBe(0);
      vi.setSystemTime(new Date("2026-10-13T19:00:00Z"));
      expect((await read("repair")).items).toEqual([
        expect.objectContaining({ id: order.shortcode, amount: 30 }),
      ]);
      expect((await read("awaiting_posting")).meta.totalCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Import time must not renew dated grace; without a transaction the
  // Purchase date drives missing-settlement investigation, before count and paging.
  it("defers missing Purchase settlement using its date and keeps old imports actionable", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic purchase grace owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic grace vendor",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: member.id,
      label: "Synthetic source",
    });
    const recent = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      date: "2026-10-09",
    });
    const old = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      date: "2026-09-01",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-13T19:00:00Z"));
      const read = (kind: "awaiting_posting" | "repair", id: string) =>
        readWorkQueue(
          ctx.db,
          member.id,
          workQueueHouseholdInput.parse({
            source: "reconciliation",
            kind,
            query: id,
            check: "settlement_reference",
          }),
          false,
        );
      expect((await read("awaiting_posting", recent.shortcode)).items).toEqual([
        expect.objectContaining({
          id: recent.shortcode,
          kind: "awaiting_posting",
        }),
      ]);
      expect((await read("repair", recent.shortcode)).meta.totalCount).toBe(0);
      expect((await read("repair", old.shortcode)).items).toEqual([
        expect.objectContaining({ id: old.shortcode, kind: "repair" }),
      ]);
      vi.setSystemTime(new Date("2026-10-14T19:00:00Z"));
      expect((await read("repair", recent.shortcode)).meta.totalCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Settlement evidence proves a tender account's authority, not access to itemization or a private receipt source.
  it("routes source research separately from the payment account while fencing financial work", async () => {
    const payerUserId = testUserId("synthetic-tender-owner-user");
    await getDb(ctx.db).insert(user).values({
      id: payerUserId,
      name: "Synthetic tender member",
      email: "synthetic-tender-member@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const sourceOwner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic source member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const payer = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic tender member",
      kind: "member",
      userId: payerUserId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic source and tender vendor",
    });
    const merchandise = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic merchandise requiring product resolution",
      itemizationExpectation: "required",
      productExpectation: "required",
    });
    const sourceAccount = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: sourceOwner.id,
      label: "Synthetic original source account",
    });
    const tenderAccount = await insertWithShortcode(
      ctx.db,
      "financialAccount",
      {
        name: "Synthetic payment account",
        identity: { kind: "cash" },
        ledgerPartyId: payer.id,
      },
    );
    const sourcePurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: sourceAccount.id,
      itemizationExpectation: "required",
      displayLabel: "Synthetic source-owned order",
      spendingCategoryId: merchandise.id,
      date: "2026-09-20",
    });
    const paymentOnlyPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      itemizationExpectation: "required",
      displayLabel: "Synthetic unknown original source order",
      spendingCategoryId: merchandise.id,
      date: "2026-09-20",
    });
    const sourceExpense = (
      await createRepoEntity(ctx, "expense", {
        name: "Synthetic source-owned line",
        purchaseId: sourcePurchase.shortcode,
        productId: null,
        cost: 10,
        date: "2026-09-20",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
      })
    ).output;
    const paymentOnlyExpense = (
      await createRepoEntity(ctx, "expense", {
        name: "Synthetic unknown-source line",
        purchaseId: paymentOnlyPurchase.shortcode,
        productId: null,
        cost: 10,
        date: "2026-09-20",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
      })
    ).output;
    const transaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: tenderAccount.id,
        kind: "charge",
        status: "posted",
        amount: 12,
        postedDate: "2026-09-20",
        merchant: "Synthetic source-owned order settlement",
      },
    );
    const paymentOnlyTransaction = await insertWithShortcode(
      ctx.db,
      "financialTransaction",
      {
        accountId: tenderAccount.id,
        kind: "charge",
        status: "posted",
        amount: 12,
        postedDate: "2026-09-20",
        merchant: "Synthetic unknown original source settlement",
      },
    );
    await getDb(ctx.db)
      .insert(financialTransactionAllocation)
      .values([
        {
          transactionId: transaction.id,
          purchaseId: sourcePurchase.id,
          amount: 10,
        },
        {
          transactionId: paymentOnlyTransaction.id,
          purchaseId: paymentOnlyPurchase.id,
          amount: 10,
        },
      ]);
    const sourceImage = await createImageFixture(
      ctx.db,
      "Synthetic source-owned original image",
      { sha256: "d".repeat(64) },
    );
    const unknownImage = await createImageFixture(
      ctx.db,
      "Synthetic unknown-original image",
      { sha256: "e".repeat(64) },
    );
    await insertEntityAttachments(ctx.db, [
      {
        entityId: sourcePurchase.id,
        imageId: sourceImage.id,
        documentKind: "receipt",
      },
      {
        entityId: paymentOnlyPurchase.id,
        imageId: unknownImage.id,
        documentKind: "receipt",
      },
    ]);
    await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values(
        [sourceImage, unknownImage].map(
          (image): typeof imageProcessingJob.$inferInsert => ({
            imageId: parseEntityId("image", image.id),
            kind: "describe_image",
            state: "failed",
            sourceContentHash: image.sha256!,
            processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
          }),
        ),
      );
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic public identity match" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .insert(runFinding)
      .values({
        ledgerPartyId: sourceOwner.id,
        entityKind: "expense",
        entityId: await resolveOrThrow(ctx.db, "expense", sourceExpense.id),
        kind: "other",
        summary: "Synthetic source-based product relinking review",
        evidenceFingerprint: "synthetic-source-product-relink",
        proposedFix: {
          kind: "relink_product",
          expenseId: await resolveOrThrow(ctx.db, "expense", sourceExpense.id),
          productId: product.entityId,
        },
      });
    const otherSourceAccount = await insertWithShortcode(
      ctx.db,
      "vendorAccount",
      {
        vendorId: vendor.id,
        ledgerPartyId: payer.id,
        label: "Synthetic other original source account",
      },
    );
    const otherSourcePurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: otherSourceAccount.id,
      spendingCategoryId: merchandise.id,
      itemizationExpectation: "required",
      displayLabel: "Synthetic other original source order",
      date: "2026-09-20",
    });
    const otherSourceExpense = (
      await createRepoEntity(ctx, "expense", {
        name: "Synthetic other source item",
        purchaseId: otherSourcePurchase.shortcode,
        productId: null,
        cost: 1,
        date: "2026-09-20",
        trade: "other",
        lineKind: "principal",
        lineBasis: "item_line",
      })
    ).output;
    const staleExpenseId = await resolveOrThrow(
      ctx.db,
      "expense",
      otherSourceExpense.id,
    );
    await getDb(ctx.db)
      .insert(runFinding)
      .values([
        {
          ledgerPartyId: payer.id,
          entityKind: "expense",
          entityId: await resolveOrThrow(ctx.db, "expense", sourceExpense.id),
          kind: "other",
          summary: "Synthetic stale relink points to another source Expense",
          evidenceFingerprint: "synthetic-mismatched-relink-target",
          proposedFix: {
            kind: "relink_product",
            expenseId: staleExpenseId,
            productId: product.entityId,
          },
        },
        {
          ledgerPartyId: payer.id,
          entityKind: "purchase",
          entityId: otherSourcePurchase.id,
          kind: "other",
          summary: "Synthetic stale relink has a Purchase target",
          evidenceFingerprint: "synthetic-wrong-kind-relink-target",
          proposedFix: {
            kind: "relink_product",
            expenseId: staleExpenseId,
            productId: product.entityId,
          },
        },
      ]);
    const retainedStaleFindings = () =>
      getDb(ctx.db)
        .select({
          entityId: runFinding.entityId,
          entityKind: runFinding.entityKind,
          proposedFix: runFinding.proposedFix,
          status: runFinding.status,
        })
        .from(runFinding)
        .where(eq(runFinding.ledgerPartyId, payer.id));
    const beforeStaleFindings = await retainedStaleFindings();
    const retainedAllocations = await getDb(ctx.db)
      .select()
      .from(financialTransactionAllocation);
    const read = async (
      actorUserId: typeof payerUserId,
      source: "research" | "problem" | "reconciliation" | "finding",
      query: string,
    ) => {
      const response = await callMcpTool(
        createMcpServer(),
        "activity",
        { action: "work_queue", source, query, pageSize: 1 },
        {},
        {
          operationContext: new McpOperationContext(
            requireActor(
              createTestRequestContext(ctx.db, {
                auth: { userId: actorUserId },
              }),
            ),
          ),
        },
      );
      expect(response.isError).not.toBe(true);
      return workQueueOutSchema.parse(response.structuredContent);
    };
    for (const id of [sourcePurchase.shortcode, sourceExpense.id]) {
      const owned = await read(ctx.actor.userId, "research", id);
      expect.soft(owned.items.map((row) => row.id)).toEqual([id]);
      expect.soft(owned.meta.totalCount).toBe(1);
      expect
        .soft(await read(payerUserId, "research", id))
        .toMatchObject({ items: [], meta: { totalCount: 0 } });
    }
    for (const id of [paymentOnlyPurchase.shortcode, paymentOnlyExpense.id]) {
      expect
        .soft(await read(ctx.actor.userId, "research", id))
        .toMatchObject({ items: [], meta: { totalCount: 0 } });
      expect
        .soft(await read(payerUserId, "research", id))
        .toMatchObject({ items: [], meta: { totalCount: 0 } });
      const unresolved = await readWorkQueue(
        ctx.db,
        sourceOwner.id,
        workQueueHouseholdInput.parse({
          source: "research",
          query: id,
          waitingFor: "unresolved",
        }),
        false,
      );
      expect.soft(unresolved.items.map((row) => row.id)).toEqual([id]);
    }
    expect
      .soft(
        (
          await read(ctx.actor.userId, "problem", sourceImage.shortcode)
        ).items.map((row) => row.id),
      )
      .toEqual([sourceImage.shortcode]);
    expect
      .soft(await read(payerUserId, "problem", sourceImage.shortcode))
      .toMatchObject({ items: [], meta: { totalCount: 0 } });
    expect
      .soft(await read(ctx.actor.userId, "problem", unknownImage.shortcode))
      .toMatchObject({ items: [], meta: { totalCount: 0 } });
    expect
      .soft(await read(payerUserId, "problem", unknownImage.shortcode))
      .toMatchObject({ items: [], meta: { totalCount: 0 } });
    expect
      .soft(
        (await read(ctx.actor.userId, "finding", sourceExpense.id)).items.map(
          (row) => row.id,
        ),
      )
      .toEqual([sourceExpense.id]);
    expect
      .soft(await read(payerUserId, "finding", sourceExpense.id))
      .toMatchObject({ items: [], meta: { totalCount: 0 } });
    for (const memberUserId of [ctx.actor.userId, payerUserId]) {
      expect
        .soft(
          await read(memberUserId, "finding", otherSourcePurchase.shortcode),
        )
        .toMatchObject({ items: [], meta: { totalCount: 0 } });
    }
    for (const target of [sourceExpense.id, otherSourcePurchase.shortcode]) {
      const unresolved = await readWorkQueue(
        ctx.db,
        sourceOwner.id,
        workQueueHouseholdInput.parse({
          source: "finding",
          waitingFor: "unresolved",
          query: target,
        }),
        false,
      );
      expect.soft(unresolved.items.map((row) => row.id)).toEqual([target]);
    }
    expect(
      (
        await read(payerUserId, "reconciliation", transaction.shortcode)
      ).items.map((row) => row.id),
    ).toEqual([transaction.shortcode]);
    expect(
      await read(ctx.actor.userId, "reconciliation", transaction.shortcode),
    ).toMatchObject({ items: [], meta: { totalCount: 0 } });
    expect(
      await getDb(ctx.db).select().from(financialTransactionAllocation),
    ).toEqual(retainedAllocations);
    expect(await retainedStaleFindings()).toEqual(beforeStaleFindings);
  });

  // Closed findings must not resurrect a terminal Run; actual proposed photo groups remain work even while their Run is running.
  it("keeps only pending Run review work while preserving paused authentication and retired findings", async () => {
    const member = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic Run reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const scope = {
      ledgerPartyId: member.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic Run reviewer",
      actorEmail: "synthetic-run-reviewer@example.test",
      actorLedgerPartyShortcode: member.shortcode,
      actorLedgerPartyName: member.name,
      actorLedgerPartyKind: member.kind,
      trigger: "manual",
    };
    const terminal = await insertWithShortcode(ctx.db, "run", {
      ...scope,
      purpose: "mail_import",
      status: "running",
      agentSessionId: "synthetic-terminal-review",
    });
    const stopped = await stopRunForReview(ctx.db, {
      runId: terminal.id,
      operationId: "synthetic-stop-for-review",
      kind: "other",
      summary: "Synthetic import requires retained source review.",
    });
    const paused = await insertWithShortcode(ctx.db, "run", {
      ...scope,
      purpose: "account_sync",
      status: "paused_auth",
      agentSessionId: "synthetic-pending-auth",
    });
    const retired = await insertWithShortcode(ctx.db, "run", {
      ...scope,
      purpose: "mail_import",
      status: "needs_review",
      endedAt: new Date(),
      retiredAt: new Date(),
      agentSessionId: "synthetic-retired-review",
    });
    await getDb(ctx.db).insert(runFinding).values({
      runId: retired.id,
      ledgerPartyId: member.id,
      entityKind: "run",
      entityId: retired.id,
      kind: "other",
      summary: "Synthetic retired source still requires review.",
      evidenceFingerprint: "synthetic-retired-open-finding",
    });
    const historicallyApplied = await insertWithShortcode(ctx.db, "run", {
      ...scope,
      purpose: "mail_import",
      status: "needs_review",
      endedAt: new Date(),
      agentSessionId: "synthetic-applied-terminal-review",
    });
    await getDb(ctx.db).insert(runFinding).values({
      runId: historicallyApplied.id,
      ledgerPartyId: member.id,
      entityKind: "run",
      entityId: historicallyApplied.id,
      kind: "other",
      summary: "Synthetic source review was applied.",
      evidenceFingerprint: "synthetic-applied-finding",
      status: "applied",
      resolvedAt: new Date(),
    });
    const photo = await insertWithShortcode(ctx.db, "run", {
      ...scope,
      purpose: "photo_inventory",
      status: "running",
      agentSessionId: "synthetic-proposed-photo-review",
    });
    const image = await createImageFixture(
      ctx.db,
      "Synthetic pending group photo",
    );
    await getDb(ctx.db)
      .insert(photoRunImage)
      .values({
        runId: photo.id,
        imageId: parseEntityId("image", image.id),
        position: 0,
        state: "pending",
        targetFingerprint: "synthetic-pending-photo-group",
      });
    await proposePhotoGroups(ctx.db, {
      runId: photo.shortcode,
      groups: [
        {
          groupKey: "synthetic-photo-group",
          images: [{ id: image.shortcode, purpose: "item" }],
          product: {
            kind: "create",
            create: { name: "Synthetic proposed household item" },
          },
        },
      ],
    });
    const read = async (
      query: string,
      source: "account" | "finding" = "account",
    ) => {
      const response = await callMcpTool(
        createMcpServer(),
        "activity",
        { action: "work_queue", source, query },
        {},
        {
          operationContext: new McpOperationContext(
            requireActor(
              createTestRequestContext(ctx.db, {
                auth: { userId: ctx.actor.userId },
              }),
            ),
          ),
        },
      );
      expect(response.isError).not.toBe(true);
      return workQueueOutSchema.parse(response.structuredContent);
    };
    expect(
      (await read(terminal.shortcode, "finding")).items.map((row) => row.id),
    ).toEqual([terminal.shortcode]);
    await resolveRunFinding(
      ctx.db,
      { id: stopped.findingId!, action: "dismiss" },
      ctx.actor,
    );
    expect
      .soft(await read(terminal.shortcode))
      .toMatchObject({ items: [], meta: { totalCount: 0 } });
    expect
      .soft(await read(historicallyApplied.shortcode))
      .toMatchObject({ items: [], meta: { totalCount: 0 } });
    expect((await read(paused.shortcode)).items.map((row) => row.id)).toEqual([
      paused.shortcode,
    ]);
    expect(
      (await read(retired.shortcode, "finding")).items.map((row) => row.id),
    ).toEqual([retired.shortcode]);
    expect
      .soft((await read(photo.shortcode)).items.map((row) => row.id))
      .toEqual([photo.shortcode]);
    const [retainedTerminal] = await getDb(ctx.db)
      .select({ status: runTable.status, endedAt: runTable.endedAt })
      .from(runTable)
      .where(eq(runTable.id, terminal.id));
    expect(retainedTerminal?.status).toBe("needs_review");
    expect(retainedTerminal?.endedAt).toBeInstanceOf(Date);
    const [retainedPhoto] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, photo.id));
    expect(retainedPhoto?.status).toBe("running");
    const [proposal] = await getDb(ctx.db)
      .select({ state: photoGroupProposal.state })
      .from(photoGroupProposal)
      .where(eq(photoGroupProposal.runId, photo.id));
    expect(proposal?.state).toBe("proposed");
  });

  // Malformed retained JSON must remain inspectable without widening private-account eligibility or changing its evidence.
  it("routes malformed account diagnostics to the current member before paging and counts", async () => {
    const otherUserId = testUserId("synthetic-malformed-account-other-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Synthetic other account member",
      email: "other-account-member@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const owner = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic account owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other account member",
      kind: "member",
      userId: otherUserId,
    });
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic malformed account",
      identity: { kind: "cash" },
      ledgerPartyId: owner.id,
    });
    await getDb(ctx.db)
      .update(financialAccountTable)
      .set({
        // oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- Inject malformed retained JSON; 'kind' is a JSON property name.
        identity: sql`jsonb_build_object('kind', ${"cash"}::text, 'unexpected', ${"synthetic-retained-value"}::text)`,
        cardNumbers: sql`jsonb_build_array(${"synthetic-malformed-card"}::text)`,
      })
      .where(eq(financialAccountTable.id, account.id));
    const retained = () =>
      getDb(ctx.db)
        .select({
          identity: financialAccountTable.identity,
          sourceAliases: financialAccountTable.sourceAliases,
          cardNumbers: financialAccountTable.cardNumbers,
          updatedAt: financialAccountTable.updatedAt,
        })
        .from(financialAccountTable)
        .where(eq(financialAccountTable.id, account.id));
    const before = await retained();
    const read = (
      actorUserId: typeof otherUserId,
      pageIndex = 0,
      pageSize = 1,
    ) =>
      callMcpTool(
        createMcpServer(),
        "activity",
        {
          action: "work_queue",
          source: "problem",
          query: account.shortcode,
          pageSize,
          pageIndex,
        },
        {},
        {
          operationContext: new McpOperationContext(
            requireActor(
              createTestRequestContext(ctx.db, {
                auth: { userId: actorUserId },
              }),
            ),
          ),
        },
      );
    const owned = await read(ctx.actor.userId, 0, 25);
    expect(owned.isError).not.toBe(true);
    const ownedPage = workQueueOutSchema.parse(owned.structuredContent);
    expect(ownedPage.items).toHaveLength(2);
    expect.soft(new Set(ownedPage.items.map((row) => row.key)).size).toBe(2);
    expect.soft(new Set(ownedPage.items.map((row) => row.reason)).size).toBe(2);
    expect(ownedPage.items[0]).toMatchObject({
      problemKey: "invalidFinancialJson",
      waitingFor: { kind: "members", members: [{ id: owner.shortcode }] },
    });
    expect(ownedPage.meta.totalCount).toBe(2);
    const later = await read(ctx.actor.userId, 2);
    expect(later.isError).not.toBe(true);
    expect(workQueueOutSchema.parse(later.structuredContent)).toMatchObject({
      items: [],
      meta: { totalCount: 2 },
    });
    const other = await read(otherUserId);
    expect(other.isError).not.toBe(true);
    expect(workQueueOutSchema.parse(other.structuredContent)).toMatchObject({
      items: [],
      meta: { totalCount: 0 },
    });
    expect(await retained()).toEqual(before);
  });

  it("offers shared research and the connected member's source work without offering another member's work", async () => {
    const otherUserId = testUserId("synthetic-work-queue-other-user");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Synthetic other member",
      email: "other-work-member@example.test",
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
      userId: otherUserId,
    });
    const shared = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic shared research item",
        categoryId: null,
      }),
      ctx.actor,
    );
    const privateRun = async (
      party: typeof first,
      actorUserId: typeof otherUserId,
      sourceAccount?: typeof vendorAccount.$inferSelect.id,
    ) => {
      const run = await insertWithShortcode(ctx.db, "run", {
        ledgerPartyId: party.id,
        vendorAccountId: sourceAccount,
        actorUserId,
        actorName: party.name,
        actorEmail: "synthetic-actor@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        purpose: "mail_import",
        trigger: "manual",
        status: "needs_review",
        endedAt: new Date(),
        agentSessionId: `synthetic-source-${party.shortcode}-${sourceAccount ?? "mail"}`,
      });
      await getDb(ctx.db)
        .insert(runFinding)
        .values({
          runId: run.id,
          ledgerPartyId: party.id,
          entityId: run.id,
          entityKind: "run",
          kind: "other",
          summary: "Review this member's retained order source.",
          evidenceFingerprint: `synthetic-source-review-${party.shortcode}`,
        });
      return run;
    };
    const mine = await privateRun(first, ctx.actor.userId);
    const theirs = await privateRun(second, otherUserId);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic work source vendor",
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: vendor.id,
      ledgerPartyId: second.id,
      label: "Synthetic second member source account",
    });
    const ownedPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      displayLabel: "Synthetic account-owned research order %_",
      itemizationExpectation: "required",
      date: "2026-09-20",
      runId: mine.id,
    });
    const unknownPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      displayLabel: "Synthetic unresolved research order",
      itemizationExpectation: "required",
      date: "2026-09-20",
    });
    const privateImage = await createImageFixture(
      ctx.db,
      "Synthetic private receipt",
      { sha256: "a".repeat(64) },
    );
    const publicImage = await createImageFixture(
      ctx.db,
      "Synthetic public representative",
      { sha256: "b".repeat(64), source: "catalog" },
    );
    const unknownImage = await createImageFixture(
      ctx.db,
      "Synthetic unresolved receipt",
      { sha256: "c".repeat(64) },
    );
    await insertEntityAttachments(ctx.db, [
      {
        entityId: ownedPurchase.id,
        imageId: privateImage.id,
        documentKind: "receipt",
      },
      { entityId: shared.entityId, imageId: publicImage.id, role: "cover" },
      {
        entityId: unknownPurchase.id,
        imageId: unknownImage.id,
        documentKind: "receipt",
      },
    ]);
    await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values(
        [privateImage, publicImage, unknownImage].map(
          (image): typeof imageProcessingJob.$inferInsert => ({
            imageId: parseEntityId("image", image.id),
            kind: "describe_image",
            state: "failed",
            sourceContentHash: image.sha256!,
            processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
          }),
        ),
      );
    const mismatched = await privateRun(first, ctx.actor.userId, account.id);
    const source = "synthetic-work-statement";
    const financialAccount = await insertWithShortcode(
      ctx.db,
      "financialAccount",
      {
        name: "Synthetic statement account",
        identity: { kind: "cash" },
        ledgerPartyId: second.id,
      },
    );
    const statement = (label: string) =>
      recordStatementRows(
        ctx.db,
        recordStatementRowsInput.parse({
          import: {
            source,
            label,
            fingerprint: label,
            dateKind: "transaction",
            rowCountDeclared: 2,
            notes: null,
          },
          rows: [
            {
              accountDescriptor: label,
              statementDate: "2026-09-20",
              providerAmount: -12,
              rawDescription: label,
            },
          ],
        }),
        ctx.actor,
      );
    await statement("Synthetic unresolved statement");
    const linkedStatement = await statement("Synthetic owned statement");
    await getDb(ctx.db)
      .update(statementRow)
      .set({ accountId: financialAccount.id })
      .where(eq(statementRow.batchId, linkedStatement.batchId!));
    const [expiredFinding] = await getDb(ctx.db)
      .insert(runFinding)
      .values({
        runId: mine.id,
        ledgerPartyId: first.id,
        entityId: mine.id,
        entityKind: "run",
        kind: "other",
        summary: "Synthetic expired source review",
        evidenceFingerprint: "synthetic-expired-review",
        expiresAt: new Date(0),
      })
      .returning({ id: runFinding.id });
    const reassignedRun = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: first.id,
      vendorAccountId: account.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic retained actor",
      actorEmail: "synthetic-retained@example.test",
      actorLedgerPartyShortcode: first.shortcode,
      actorLedgerPartyName: first.name,
      actorLedgerPartyKind: "member",
      purpose: "account_sync",
      trigger: "manual",
      status: "paused_auth",
      agentSessionId: "synthetic-reassigned-account-run",
    });
    const overview = await readWorkQueue(
      ctx.db,
      first.id,
      workQueueHouseholdInput.parse({ waitingFor: "unresolved" }),
      false,
    );
    expect(overview.items.map((row) => row.id)).toContain(
      unknownPurchase.shortcode,
    );
    expect(overview.items.map((row) => row.id)).toContain(mismatched.shortcode);
    expect(overview.items.map((row) => row.id)).toContain(
      reassignedRun.shortcode,
    );
    expect(overview.items.map((row) => row.id)).toContain(
      unknownImage.shortcode,
    );
    expect(
      overview.items.find(
        (row) => row.name === "Synthetic unresolved statement",
      ),
    ).toMatchObject({
      entity: null,
      id: null,
      problemKey: "incompleteStatementImports",
      waitingFor: { kind: "unresolved" },
    });
    expect(
      overview.items.every((row) => row.waitingFor.kind === "unresolved"),
    ).toBe(true);
    const read = (actorUserId: typeof otherUserId, fields = {}) =>
      callMcpTool(
        createMcpServer(),
        "activity",
        { action: "work_queue", ...fields },
        {},
        {
          operationContext: new McpOperationContext(
            requireActor(
              createTestRequestContext(ctx.db, {
                auth: { userId: actorUserId },
              }),
            ),
          ),
        },
      );
    const firstPage = await read(ctx.actor.userId);
    expect(firstPage.isError).not.toBe(true);
    const firstItems = workQueueOutSchema.parse(
      firstPage.structuredContent,
    ).items;
    expect(firstItems.map((row) => row.id)).toContain(mine.shortcode);
    expect(
      firstItems.some(
        (row) =>
          row.id === shared.id &&
          row.source === "research" &&
          row.waitingFor.kind === "either",
      ),
    ).toBe(true);
    expect(firstItems.map((row) => row.id)).not.toContain(theirs.shortcode);
    expect(firstItems.map((row) => row.id)).not.toContain(mismatched.shortcode);
    expect(
      firstItems.find((row) => row.id === shared.id)?.waitingFor.kind,
    ).toBe("either");
    const secondPage = await read(otherUserId);
    expect(secondPage.isError).not.toBe(true);
    const secondItems = workQueueOutSchema.parse(
      secondPage.structuredContent,
    ).items;
    expect(secondItems.map((row) => row.id)).toContain(theirs.shortcode);
    expect(secondItems.map((row) => row.id)).not.toContain(mine.shortcode);
    expect(secondItems.map((row) => row.id)).not.toContain(
      mismatched.shortcode,
    );
    expect(secondItems.map((row) => row.id)).toContain(shared.id);
    expect(
      secondItems.some(
        (row) =>
          row.id === shared.id &&
          row.source === "research" &&
          row.waitingFor.kind === "either",
      ),
    ).toBe(true);
    expect(firstItems.map((row) => row.id)).not.toContain(
      reassignedRun.shortcode,
    );
    expect(secondItems.map((row) => row.id)).not.toContain(
      reassignedRun.shortcode,
    );
    expect(firstItems.map((row) => row.id)).not.toContain(
      privateImage.shortcode,
    );
    expect(secondItems.map((row) => row.id)).toContain(privateImage.shortcode);
    expect(firstItems.map((row) => row.id)).toContain(publicImage.shortcode);
    expect(secondItems.map((row) => row.id)).toContain(publicImage.shortcode);
    expect(firstItems.map((row) => row.id)).not.toContain(
      unknownImage.shortcode,
    );
    expect(secondItems.map((row) => row.id)).not.toContain(
      unknownImage.shortcode,
    );
    expect(
      firstItems.some((row) => row.name === "Synthetic owned statement"),
    ).toBe(false);
    expect(
      secondItems.find((row) => row.name === "Synthetic owned statement"),
    ).toMatchObject({
      entity: null,
      id: null,
      problemKey: "incompleteStatementImports",
      waitingFor: { kind: "members", members: [{ id: second.shortcode }] },
    });
    expect(
      secondItems.some((row) => row.name === "Synthetic unresolved statement"),
    ).toBe(false);
    expect(
      firstItems.some((row) => row.name === "Synthetic expired source review"),
    ).toBe(false);
    const [retainedExpired] = await getDb(ctx.db)
      .select({ status: runFinding.status })
      .from(runFinding)
      .where(eq(runFinding.id, expiredFinding!.id));
    expect(retainedExpired?.status).toBe("open");
    expect(firstItems.map((row) => row.id)).not.toContain(
      ownedPurchase.shortcode,
    );
    expect(secondItems.map((row) => row.id)).toContain(ownedPurchase.shortcode);
    expect(firstItems.map((row) => row.id)).not.toContain(
      unknownPurchase.shortcode,
    );
    expect(secondItems.map((row) => row.id)).not.toContain(
      unknownPurchase.shortcode,
    );
    const filtered = workQueueOutSchema.parse(
      (
        await read(otherUserId, {
          source: "research",
          query: "Synthetic account-owned",
        })
      ).structuredContent,
    );
    expect(filtered.items.map((row) => row.id)).toEqual([
      ownedPurchase.shortcode,
    ]);
    expect(filtered.meta.totalCount).toBe(1);
    const literalSearch = workQueueOutSchema.parse(
      (await read(otherUserId, { source: "research", query: "%_" }))
        .structuredContent,
    );
    expect(literalSearch.items.map((row) => row.id)).toEqual([
      ownedPurchase.shortcode,
    ]);
    expect(literalSearch.meta.totalCount).toBe(1);
    const hidden = workQueueOutSchema.parse(
      (
        await read(ctx.actor.userId, {
          query: "Synthetic account-owned",
          pageSize: 1,
        })
      ).structuredContent,
    );
    expect(hidden.items).toEqual([]);
    expect(hidden.meta.totalCount).toBe(0);
    const paged = workQueueOutSchema.parse(
      (
        await read(otherUserId, {
          source: "finding",
          pageSize: 1,
          pageIndex: 1,
        })
      ).structuredContent,
    );
    expect(paged.items).toEqual([]);
    expect(paged.meta.totalCount).toBe(1);
    expect(
      (await read(ctx.actor.userId, { waitingFor: second.shortcode })).isError,
    ).toBe(true);
  });
  // Failure modes: rows carry no thumbnail, a borrowed-image entity misses
  // its product's cover, or a member read exposes imagery borrowed through a
  // linked record the member's routing never established.
  it("carries each source record's resolved display images", async () => {
    const pictured = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic pictured queue item",
        categoryId: null,
      }),
      ctx.actor,
    );
    const cover = await createImageFixture(ctx.db, "Synthetic queue cover", {
      sha256: "f".repeat(64),
      source: "catalog",
    });
    await insertEntityAttachments(ctx.db, {
      entityId: pictured.entityId,
      imageId: cover.id,
      role: "cover",
    });
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic queue shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: pictured.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    const queue = await readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({
        query: "Synthetic pictured queue item",
        pageSize: 100,
      }),
      false,
    );
    const imagesFor = (entity: string) =>
      queue.items
        .filter((row) => row.entity === entity)
        .map((row) => row.displayImages.map((image) => image.id));
    expect(imagesFor("product").length).toBeGreaterThan(0);
    expect(new Set(imagesFor("product").flat())).toEqual(
      new Set([cover.shortcode]),
    );
    expect(imagesFor("inventory").length).toBeGreaterThan(0);
    for (const ids of imagesFor("inventory"))
      expect(ids).toEqual([cover.shortcode]);
    const memberRead = await readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({
        query: "Synthetic pictured queue item",
        pageSize: 100,
      }),
      true,
    );
    expect(memberRead.items.length).toBeGreaterThan(0);
    for (const row of memberRead.items) expect(row.displayImages).toEqual([]);
  });

  // Sorting must precede paging, and ties must preserve the secondary sort.
  it("keeps multi-field sorting stable across page boundaries", async () => {
    const query = "Synthetic sorted queue";
    for (const suffix of ["Alpha", "Bravo"]) {
      await createProductFixture(
        ctx.db,
        makeProductInput({ name: `${query} ${suffix}`, categoryId: null }),
        ctx.actor,
      );
    }
    const input = workQueueHouseholdInput.parse({
      query,
      source: "research",
      pageSize: 100,
      sort: [
        { orderBy: "waitingFor", direction: "asc" },
        { orderBy: "name", direction: "desc" },
      ],
    });
    const full = await readWorkQueue(ctx.db, null, input, false);
    expect(full.meta.totalCount).toBe(2);
    expect(full.items.map((row) => row.name)).toEqual([
      `${query} Bravo`,
      `${query} Alpha`,
    ]);
    const pagedKeys = [];
    for (let pageIndex = 0; pageIndex < full.meta.totalCount; pageIndex++) {
      const page = await readWorkQueue(
        ctx.db,
        null,
        { ...input, pageIndex, pageSize: 1 },
        false,
      );
      pagedKeys.push(...page.items.map((row) => row.key));
    }
    expect(pagedKeys).toEqual(full.items.map((row) => row.key));
  });

  // Pending Suggestions surface as one row per suggested field, never one per
  // Suggestion; a required receipt names the policy that requires it.
  it("aggregates pending Suggestions per field and states a receipt gap's policy source", async () => {
    const products = await Promise.all(
      ["One", "Two"].map((suffix) =>
        createProductFixture(
          ctx.db,
          makeProductInput({
            name: `Synthetic suggested ${suffix}`,
            categoryId: null,
          }),
          ctx.actor,
        ),
      ),
    );
    const runId = await ensureRun(
      ctx.db,
      { ...ctx.actor, runId: null },
      { purpose: "ai_suggest" },
    );
    await getDb(ctx.db)
      .insert(suggestion)
      .values(
        await Promise.all(
          products.map(async (product) => ({
            runId,
            entity: "product",
            recordId: await resolveOrThrow(ctx.db, "product", product.id),
            field: "categoryId",
            currentValue: null,
            suggestedValue: "CAT-2222",
            confidence: 0.9,
            model: "typesafe/jev",
            kind: "addition" as const,
            status: "pending" as const,
          })),
        ),
      );
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic receipt policy vendor",
      itemizationExpectation: "required",
    });
    const lumpOrder = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      displayLabel: "Synthetic receipt policy order",
      date: "2026-09-20",
    });
    await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic lump booking",
      purchaseId: lumpOrder.id,
      cost: 30,
      date: "2026-09-20",
      costType: "materials",
      lineBasis: "allocation",
      economicRole: "vendor",
    });
    const queue = await readWorkQueue(
      ctx.db,
      null,
      workQueueHouseholdInput.parse({ pageSize: 100 }),
      false,
    );
    const suggested = queue.items.filter((row) => row.source === "suggestion");
    expect(suggested).toEqual([
      expect.objectContaining({
        entity: "product",
        id: null,
        suggestionField: "categoryId",
        reason: "2 pending suggestions",
      }),
    ]);
    const receipt = queue.items.find(
      (row) =>
        row.name === "Synthetic receipt policy order" &&
        row.source === "research",
    );
    // No document is expected, so the row names only the missing item lines.
    expect(receipt?.reason).toBe(
      "The order is not yet broken into item lines with their Products.",
    );
  });
});
