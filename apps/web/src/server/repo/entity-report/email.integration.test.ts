import { entityReportOut } from "@cubby/schemas/entity-report";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  user,
  aiUsage,
  importSourceClaim,
  importSourceOrder,
  orderMailAttachment,
  orderMailEvent,
  orderMailCandidateDecision,
  email as emailTable,
  orderMail,
  purchase as purchaseTable,
  run,
} from "~/server/db/schema";
import { startAgentRunFixture } from "~/server/purchase-import/import-run.fixtures";
import { getDb } from "~/server/repo/database-helpers";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { emailReviewReport } from "./email";
import { buildEntityReport } from "./index";

describe("Email review report", () => {
  const ctx = withTestDb();
  // Navigation failures: accepted aliases/attachments or lifecycle evidence vanish;
  // dismissed candidates become purchases; thread collisions or other owners leak.
  it("navigates accepted families and lifecycle purchases without promoting dismissed or mailbox thread context", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic navigation owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const foreignUserId = testUserId("synthetic-navigation-other-member");
    await getDb(ctx.db)
      .insert(user)
      .values({
        id: foreignUserId,
        name: "Synthetic other navigation member",
        email: "navigation-other@example.test",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    const foreignParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other navigation owner",
      kind: "member",
      userId: foreignUserId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic navigation vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "SYNTHETIC-NAVIGATION",
      date: "2026-09-01",
    });
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic navigation item" }),
      ctx.actor,
    );
    const expense = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: purchase.id,
      productId: item.entityId,
      name: item.name,
      cost: 12,
      date: "2026-09-01",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
    });
    const firstRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    const retain = async (
      messageId: string,
      options: {
        mailboxId?: string;
        threadId?: string;
        foreign?: boolean;
      } = {},
    ) => {
      const ownerId = options.foreign ? foreignParty.id : party.id;
      const [original] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: ownerId,
          rawChecksum: `synthetic-navigation:${messageId}`,
        })
        .returning();
      if (!original) throw new Error("Synthetic original missing");
      const email = await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: ownerId,
        orderMailId: original.id,
        checksum: original.rawChecksum,
        mailboxId: options.mailboxId ?? "synthetic-navigation",
        messageId,
        threadId: options.threadId ?? "synthetic-thread",
        subject: `Synthetic ${messageId}`,
        classification: "related",
        status: "completed",
      });
      return { original, email };
    };
    const selected = await retain("accepted");
    const attachment = await retain("attachment", {
      threadId: "attachment-thread",
    });
    const lifecycle = await retain("lifecycle", {
      threadId: "lifecycle-thread",
    });
    const dismissed = await retain("dismissed");
    const context = await retain("context");
    const collision = await retain("other-mailbox", {
      mailboxId: "other-mailbox",
    });
    const foreign = await retain("other-owner", { foreign: true });
    for (const source of [selected, attachment]) {
      const kind = source === attachment ? "mail_attachment" : "mail_message";
      let externalKey = `gmail:${source.email.mailboxId}:${source.email.messageId}`;
      if (source === attachment) {
        await getDb(ctx.db).insert(orderMailAttachment).values({
          orderMailId: source.original.id,
          providerAttachmentId: "synthetic-receipt",
          filename: "receipt.png",
          mimeType: "image/png",
          checksum: "synthetic-attachment",
        });
        externalKey += ":attachment:synthetic-receipt";
      }
      const [root] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: party.id,
          kind,
          externalKey,
          checksum: source.original.rawChecksum,
          firstRunId,
          lastRunId: firstRunId,
        })
        .returning();
      if (!root) throw new Error("Synthetic claim missing");
      const [alias] = await getDb(ctx.db)
        .insert(importSourceClaim)
        .values({
          ledgerPartyId: party.id,
          kind,
          externalKey: `${externalKey}:historical-alias`,
          canonicalClaimId: root.id,
          checksum: source.original.rawChecksum,
          firstRunId,
          lastRunId: firstRunId,
        })
        .returning();
      if (!alias) throw new Error("Synthetic alias missing");
      await getDb(ctx.db).insert(importSourceOrder).values({
        sourceClaimId: alias.id,
        orderKey: "synthetic-navigation",
        purchaseId: purchase.id,
        checksum: source.original.rawChecksum,
        outputFingerprint: "synthetic-navigation-output",
      });
    }
    for (const source of [lifecycle, dismissed, foreign]) {
      const [event] = await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: source.original.id,
          event: "shipment",
          sourceKey: `synthetic-navigation:${source.email.messageId}`,
        })
        .returning();
      if (!event) throw new Error("Synthetic event missing");
      await getDb(ctx.db)
        .insert(orderMailCandidateDecision)
        .values({
          eventId: event.id,
          purchaseId: purchase.id,
          decision: source === dismissed ? "dismissed" : "linked",
          evidenceChecksum: source.original.rawChecksum,
          decidedByUserId: ctx.actor.userId,
        });
    }
    const report = async (id: string) =>
      (
        await buildEntityReport(
          ctx.db,
          { slot: "email.review", id },
          async () => null,
          ctx.actor,
        )
      ).blocks;
    const rows = (blocks: Awaited<ReturnType<typeof report>>, title: string) =>
      blocks.flatMap((block) =>
        block.kind === "records" && block.title === title ? block.rows : [],
      );
    const blocks = await report(selected.email.shortcode);
    expect(rows(blocks, "Purchase links")).toContainEqual(
      expect.objectContaining({ entity: "purchase", id: purchase.shortcode }),
    );
    expect(rows(blocks, "Purchase Expenses")).toContainEqual(
      expect.objectContaining({ entity: "expense", id: expense.shortcode }),
    );
    expect(rows(blocks, "Purchase Products")).toContainEqual(
      expect.objectContaining({ entity: "product", id: item.id }),
    );
    expect(
      rows(blocks, "Emails for the same Purchases").map((row) => row.id),
    ).toEqual(
      expect.arrayContaining([
        attachment.email.shortcode,
        lifecycle.email.shortcode,
      ]),
    );
    expect(rows(blocks, "Gmail thread context").map((row) => row.id)).toEqual(
      expect.arrayContaining([
        dismissed.email.shortcode,
        context.email.shortcode,
      ]),
    );
    // Received time is an instant each client formats, never preformatted trailing text.
    for (const row of rows(blocks, "Gmail thread context"))
      expect(row.trailing).toBeNull();
    const allRows = blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    expect(
      allRows.some(
        (row) =>
          row.id === collision.email.shortcode ||
          row.id === foreign.email.shortcode,
      ),
    ).toBe(false);
    expect(
      rows(await report(attachment.email.shortcode), "Purchase links").map(
        (row) => row.id,
      ),
    ).toContain(purchase.shortcode);
    expect(
      rows(await report(lifecycle.email.shortcode), "Purchase links").map(
        (row) => row.id,
      ),
    ).toContain(purchase.shortcode);
    const dismissedBlocks = await report(dismissed.email.shortcode);
    // A dismissal is a reviewed pair, never a link to the Purchase's money.
    expect(rows(dismissedBlocks, "Purchase Expenses")).toEqual([]);
    expect(rows(dismissedBlocks, "Purchase Products")).toEqual([]);
    expect(rows(dismissedBlocks, "Purchase links")).toEqual([
      expect.objectContaining({
        entity: "purchase",
        id: purchase.shortcode,
        statuses: [{ label: "Dismissed", tone: "muted" }],
      }),
    ]);
    // Another member's Email reads as metadata: no pipeline, no review.
    const foreignBlocks = await report(foreign.email.shortcode);
    expect(rows(foreignBlocks, "Email pipeline")).toEqual([]);
    expect(
      foreignBlocks.flatMap((block) =>
        block.kind === "records"
          ? block.rows.flatMap((row) => row.commands ?? [])
          : [],
      ),
    ).toEqual([]);
    await getDb(ctx.db)
      .update(purchaseTable)
      .set({ deletedAt: new Date() })
      .where(eq(purchaseTable.id, purchase.id));
    const historical = await report(selected.email.shortcode);
    expect(rows(historical, "Purchase links")).toContainEqual(
      expect.objectContaining({
        entity: null,
        id: null,
        statuses: [{ label: "Purchase deleted", tone: "warning" }],
      }),
    );
    expect(
      rows(historical, "Email pipeline").find(
        (row) => row.title === "Linked Purchase",
      ),
    ).toMatchObject({
      entity: null,
      id: null,
      subtitle: expect.stringContaining("Deleted Purchase"),
    });
  });
  it("offers checksum-fenced import only for retained related content and distinguishes an unknown cost", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic review owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const [original] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        rawChecksum: "a".repeat(64),
        content: {
          snippet: null,
          bodyText: "Synthetic order evidence",
          bodyHtml: null,
        },
      })
      .returning();
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-review",
      messageId: "selected",
      checksum: "a".repeat(64),
      orderMailId: original!.id,
      classification: "related",
      status: "pending",
      executionPolicy: "classification_only",
    });
    const blocks = await emailReviewReport(
      ctx.db,
      email.shortcode,
      null,
      ctx.actor,
    );
    // Every command, including input templates, must survive the wire schema.
    expect(() => entityReportOut.parse({ blocks })).not.toThrow();
    const commandsOf = (report: typeof blocks) =>
      report.flatMap((block) =>
        block.kind === "records"
          ? [
              ...(block.commands ?? []),
              ...block.rows.flatMap((row) => row.commands ?? []),
            ]
          : [],
      );
    expect(commandsOf(blocks).map((command) => command.request)).toContainEqual(
      {
        kind: "import-email",
        items: [{ id: email.shortcode, expectedChecksum: "a".repeat(64) }],
      },
    );
    // An absent estimate never reads as free.
    expect(
      blocks
        .flatMap((block) => (block.kind === "records" ? block.rows : []))
        .find((row) => row.title === "Import Run")?.subtitle,
    ).toContain("Cost unknown");
    await getDb(ctx.db)
      .update(orderMail)
      .set({ content: { snippet: null, bodyText: null, bodyHtml: null } })
      .where((await import("drizzle-orm")).eq(orderMail.id, original!.id));
    const unavailable = await emailReviewReport(
      ctx.db,
      email.shortcode,
      null,
      ctx.actor,
    );
    const unavailableCommands = commandsOf(unavailable);
    expect(
      unavailableCommands.some(
        (command) => command.request.kind === "import-email",
      ),
    ).toBe(false);
    // Reclassify refetches the original, so it stays offered without content.
    expect(
      unavailableCommands.some(
        (command) => command.request.kind === "reclassify-email",
      ),
    ).toBe(true);
  });
  // Failure: a recent estimate window must not hide older actual costs or admit a foreign/checksum-mismatched Run.
  it("shows older actual frozen-source Run usage beyond fifty newer imports, including failed calls and unknown billing", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic usage owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const originalId = crypto.randomUUID();
    const [original] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        id: originalId,
        ledgerPartyId: party.id,
        rawChecksum: "c".repeat(64),
      })
      .returning();
    if (!original) throw new Error("Synthetic original missing");
    const email = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-cost",
      messageId: "selected",
      checksum: "c".repeat(64),
      orderMailId: original.id,
      classification: "related",
      status: "completed",
    });
    const selectedRun = await startAgentRunFixture(ctx.db, {
      ledgerPartyId: party.id,
    });
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "completed",
        endedAt: new Date("2026-01-01T12:00:00Z"),
        input: {
          kind: "mail_research",
          sources: [{ orderMailId: original.id, checksum: email.checksum }],
        },
      })
      .where(eq(run.id, selectedRun.id));
    await getDb(ctx.db)
      .update(emailTable)
      .set({ runId: selectedRun.id })
      .where(eq(emailTable.id, email.id));
    await getDb(ctx.db)
      .insert(aiUsage)
      .values([
        {
          runId: selectedRun.id,
          feature: "mail-import",
          provider: "synthetic",
          model: "synthetic-model",
          operation: "import",
          durationMs: 1,
          transport: "chatgpt",
          estimatedCost: null,
        },
        {
          runId: selectedRun.id,
          feature: "mail-import",
          provider: "synthetic",
          model: "synthetic-model",
          operation: "import",
          durationMs: 1,
          transport: "gateway",
          estimatedCost: 0.25,
          status: "failed",
        },
        {
          runId: selectedRun.id,
          feature: "mail-import",
          provider: "synthetic",
          model: "synthetic-model",
          operation: "import",
          durationMs: 1,
          transport: "unknown",
          estimatedCost: null,
        },
      ]);
    for (let index = 0; index < 50; index += 1) {
      const unrelated = await startAgentRunFixture(ctx.db, {
        ledgerPartyId: party.id,
      });
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "completed",
          endedAt: new Date("2026-10-10T12:00:00Z"),
          input: {
            kind: "mail_research",
            sources: [
              { orderMailId: crypto.randomUUID(), checksum: "d".repeat(64) },
            ],
          },
        })
        .where(eq(run.id, unrelated.id));
    }
    const otherUserId = testUserId("synthetic-other-cost-member");
    await getDb(ctx.db).insert(user).values({
      id: otherUserId,
      name: "Synthetic other cost member",
      email: "other-cost@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const otherParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other cost owner",
      kind: "member",
      userId: otherUserId,
    });
    for (const mismatch of ["owner", "checksum"] as const) {
      const unrelated = await startAgentRunFixture(ctx.db, {
        ledgerPartyId: mismatch === "owner" ? otherParty.id : party.id,
      });
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "completed",
          endedAt: new Date("2026-10-11T12:00:00Z"),
          input: {
            kind: "mail_research",
            sources: [
              {
                orderMailId: original.id,
                checksum:
                  mismatch === "checksum" ? "d".repeat(64) : email.checksum,
              },
            ],
          },
        })
        .where(eq(run.id, unrelated.id));
      await getDb(ctx.db).insert(aiUsage).values({
        runId: unrelated.id,
        feature: "mail-import",
        provider: "synthetic",
        model: "synthetic-unrelated",
        operation: "import",
        durationMs: 1,
        transport: "gateway",
        estimatedCost: 99,
      });
    }
    const blocks = await emailReviewReport(
      ctx.db,
      email.shortcode,
      null,
      ctx.actor,
    );
    const pipeline = blocks.find(
      (block) => block.kind === "records" && block.title === "Email pipeline",
    );
    if (pipeline?.kind !== "records") throw new Error("Email pipeline missing");
    const importRow = pipeline.rows.find((row) => row.title === "Import Run");
    expect(importRow).toMatchObject({
      entity: "run",
      id: selectedRun.publicId,
    });
    const usage = importRow?.subtitle?.split("\n") ?? [];
    expect(usage).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ · chatgpt · .* · \$0\.00$/u),
        expect.stringMatching(/ · gateway · .*1 failed · \$0\.25$/u),
        expect.stringMatching(/ · unknown · .* · Unknown$/u),
      ]),
    );
    expect(usage.join("\n")).not.toContain("synthetic-unrelated");
    expect(importRow?.subtitle).toMatch(/Est\. \$99\.00 per Email/u);
  });
});
