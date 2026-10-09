/** Write-boundary failures: a no-ID source duplicates an assessed Purchase;
 * shared-source orders collide; an association silently moves; forged/stale
 * evidence writes; replay duplicates expenses; services fabricate Products;
 * refund links change money; human decisions are overwritten; another Run's
 * source is completed; validation drops accepted facts or lacks the target's
 * recorded state; shipping-first import loses its lifecycle event; refused canonical writes report success. Semantic support is
 * injected, storage and writes are real. */
import { MAILBOX_RESEARCH_VERSION } from "@cubby/schemas/mailbox-research";
import {
  importWriterInput,
  type ExtractedOrderCandidate,
} from "@cubby/schemas/purchase-import";
import {
  researchWorkResolve,
  type ResearchWorkResolution,
} from "@cubby/schemas/research-tools";
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  entityAttachment,
  expense,
  importSourceClaim,
  importSourceOrder,
  mailboxMessage,
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  orderMailAttachment,
  product,
  purchase,
  run,
  runEvidence,
  runFinding,
  runFactEvidence,
  runOperation,
  runTarget,
  spendingCategory,
  vendor,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { effectiveExpenseSpendingCategorySql } from "~/server/repo/expense-category-resolution";
import { effectiveExpenseTradeSql } from "~/server/repo/expense-inheritance";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadCurrentFactEvidence } from "./fact-verification";
import { resolveImportResearch } from "./research-import";
import { researchObjectiveKey } from "./research-objective";
import type { ResearchAssessor } from "./research-support";
import { startTargetedImport } from "./targeted-run";
import * as writer from "./writer";

const candidate = (
  orderId: string | null,
  amount = 10,
): ExtractedOrderCandidate => ({
  orderId,
  orderedAt: "2026-10-01T12:00:00Z",
  merchant: "Synthetic service merchant",
  currency: "USD",
  printedGrandTotal: amount,
  lines: [
    {
      title: "Synthetic annual service",
      amount,
      quantity: 1,
      lineKind: "principal",
    },
  ],
  payments: [],
  allShipmentsDelivered: true,
});

describe("supported retained-mail research writes", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));
  async function fixture(
    content = "Synthetic original supports annual services ORDER-ONE and ORDER-TWO.",
  ) {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail researcher",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic service merchant",
    });
    const checksum = await sha256Hex(content);
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        mailboxId: "synthetic-google-subject",
        messageId: "synthetic-source",
        sender: "platform@example.test",
        subject: "Original service receipt",
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: checksum,
        content: { snippet: null, bodyText: content, bodyHtml: null },
      })
      .returning();
    if (!mail) throw new Error("Synthetic source missing");
    const run = await insertWithShortcode(ctx.db, "run", {
      purpose: "mail_import",
      status: "running",
      trigger: "manual",
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: party.name,
      actorEmail: "research@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
      input: {
        kind: "mail_research",
        mailboxId: mail.mailboxId,
        sources: [{ orderMailId: mail.id, checksum }],
      },
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: run.id,
        entityId: run.id,
        entityKind: "run",
        workKey: mail.id,
        state: "pending",
        targetFingerprint: checksum,
      })
      .returning();
    if (!target) throw new Error("Synthetic task missing");
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: run.id,
        targetId: target.id,
        kind: "mail_message",
        checksum,
        objectKey: "synthetic/retained-mail",
        mediaType: "text/plain",
        sourceMetadata: {
          orderMailId: mail.id,
          mailboxId: mail.mailboxId,
          messageId: mail.messageId,
          checksum,
        },
      })
      .returning();
    if (!evidence) throw new Error("Synthetic evidence missing");
    await getDb(ctx.db).insert(mailboxMessage).values({
      ledgerPartyId: party.id,
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
      checksum,
      classification: "related",
      classificationVersion: MAILBOX_RESEARCH_VERSION,
      status: "researching",
      runId: run.id,
      orderMailId: mail.id,
    });
    const writerInput = importWriterInput.parse({
      runId: run.id,
      ledgerPartyId: party.id,
      vendorId: vendor.id,
      vendorAccountId: null,
      defaultTrade: "other",
      source: {
        kind: "mail_message",
        externalKey: `gmail:${mail.mailboxId}:${mail.messageId}`,
        checksum,
      },
      extraction: { status: "ready", candidate: candidate("ORDER-ONE") },
      primaryDocumentImageId: null,
      screenshotImageId: null,
      productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
    });
    const ports = {
      readEvidence: async () => content,
      assess: async () => ({
        identityVerified: true,
        acceptedFacts: [],
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedOrders: [0, 1],
        acceptedEmailLinks: [],
        rejected: [],
      }),
    };
    const proposal = researchWorkResolve.parse({
      workRef: target.id,
      status: "verified",
      identity: {
        evidenceIds: [evidence.id],
        reasoning:
          "The complete original identifies two distinct service acquisitions.",
      },
      orders: ["ORDER-ONE", "ORDER-TWO"].map((id, index) => ({
        vendorRef: vendor.shortcode,
        evidenceIds: [evidence.id],
        reasoning:
          "The original states this distinct annual service and total.",
        candidate: candidate(id, 10 + index * 10),
        productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
      })),
      detail: "Verified two supported service acquisitions from one original.",
    });
    return {
      party,
      vendor,
      mail,
      run,
      target,
      evidence,
      content,
      writerInput,
      ports,
      proposal,
    };
  }
  it("retains an exact item-resolution refusal before source assessment and writes", async () => {
    const f = await fixture();
    let assessments = 0;
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-missing-item-resolution",
          proposal: {
            ...f.proposal,
            orders: [{ ...f.proposal.orders[0]!, productResolutions: [] }],
          },
        },
        {
          ...f.ports,
          assess: async () => {
            assessments++;
            return { ...(await f.ports.assess()), acceptedOrders: [0] };
          },
        },
      ),
    ).rejects.toThrow(/orders\[0\]\.productResolutions.*0/);
    expect(assessments).toBe(0);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(0);
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(0);
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.operationId, "synthetic-missing-item-resolution"));
    expect(attempt).toMatchObject({
      state: "failed",
      result: { attempt: { orders: [{ productResolutions: [] }] } },
    });
    expect(attempt?.error).toMatch(/orders\[0\]\.productResolutions.*0/);
  });
  // Missing source purpose must not block supported imports or replace a
  // member's existing purpose. The researcher supplies source facts only.
  it.each(["new", "unassigned", "assigned"] as const)(
    "applies the host purpose fallback without a researcher trade: %s",
    async (purpose) => {
      const f = await fixture();
      if (purpose !== "new")
        await insertWithShortcode(ctx.db, "purchase", {
          vendorId: f.vendor.id,
          orderId: "ORDER-ONE",
          defaultTrade: purpose === "assigned" ? "plumbing" : null,
        });
      const proposal = {
        ...f.proposal,
        orders: f.proposal.orders.slice(0, 1),
      };
      const result = await resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-host-purpose-fallback",
          proposal,
        },
        {
          ...f.ports,
          assess: async () => ({
            ...(await f.ports.assess()),
            acceptedOrders: [0],
          }),
        },
      );
      expect(result.status).toBe("verified");
      const [saved] = await getDb(ctx.db).select().from(purchase);
      expect(saved?.defaultTrade).toBe(
        purpose === "assigned" ? "plumbing" : null,
      );
      const lines = await getDb(ctx.db)
        .select({
          cost: expense.cost,
          trade: expense.trade,
          effectiveTrade: effectiveExpenseTradeSql(),
        })
        .from(expense);
      expect(lines).toEqual([
        {
          cost: 10,
          trade: purpose === "assigned" ? null : "other",
          effectiveTrade: purpose === "assigned" ? "plumbing" : "other",
        },
      ]);
      expect(await getDb(ctx.db).select().from(product)).toHaveLength(0);
    },
  );
  // A semantic refusal must not surrender mail ownership; a corrected call and
  // replay must commit one source order, expense, and lifecycle association.
  it("retains refused mail work for a corrected call and replays both receipts without duplicate writes", async () => {
    const f = await fixture();
    const proposal = { ...f.proposal, orders: f.proposal.orders.slice(0, 1) };
    const input = {
      runId: f.run.id,
      workRef: f.target.id,
      callId: "synthetic-refused-mail",
      proposal,
    };
    const refused = await resolveImportResearch(ctx.db, input, {
      ...f.ports,
      assess: async () => ({
        identityVerified: true,
        acceptedFacts: [],
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedOrders: [],
        rejected: [
          {
            path: "orders.0",
            reason: "Correct the unsupported purpose claim.",
          },
        ],
      }),
    });
    expect(refused).toMatchObject({
      status: "researched_with_gaps",
      purchaseIds: [],
    });
    const [active] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(active).toMatchObject({
      state: "needs_evidence",
      completedAt: null,
      outcome: null,
    });
    const [mail] = await getDb(ctx.db)
      .select()
      .from(mailboxMessage)
      .where(eq(mailboxMessage.runId, f.run.id));
    expect(mail).toMatchObject({ status: "researching", runId: f.run.id });
    expect(await resolveImportResearch(ctx.db, input, f.ports)).toEqual(
      refused,
    );
    const correctedInput = { ...input, callId: "synthetic-corrected-mail" };
    const corrected = await resolveImportResearch(ctx.db, correctedInput, {
      ...f.ports,
      assess: async () => ({
        identityVerified: true,
        acceptedFacts: [],
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedOrders: [0],
        rejected: [],
      }),
    });
    expect(corrected).toMatchObject({ status: "verified" });
    expect(corrected.purchaseIds).toHaveLength(1);
    expect(
      await resolveImportResearch(ctx.db, correctedInput, f.ports),
    ).toEqual(corrected);
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(product)).toHaveLength(0);
    expect(
      await getDb(ctx.db).select().from(orderMailCandidateDecision),
    ).toHaveLength(1);
    await expect(
      resolveImportResearch(
        ctx.db,
        { ...correctedInput, callId: "synthetic-late-mail" },
        f.ports,
      ),
    ).rejects.toThrow(/settled|closed/);
  });
  it("counts replayed accepted source orders and links with the same refusal as zero progress", async () => {
    const f = await fixture();
    const ports = {
      ...f.ports,
      assess: async () => ({
        identityVerified: true,
        acceptedFacts: [],
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedOrders: [0],
        rejected: [
          { path: "orders.1", reason: "Second order remains unsupported." },
        ],
      }),
    };
    for (let attempt = 1; attempt <= 4; attempt++) {
      const input = {
        runId: f.run.id,
        workRef: f.target.id,
        callId: `synthetic-replayed-source-${attempt}`,
        proposal: f.proposal,
      };
      const receipt = await resolveImportResearch(ctx.db, input, ports);
      expect(await resolveImportResearch(ctx.db, input, ports)).toEqual(
        receipt,
      );
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, f.target.id));
      expect(target?.state).toBe(
        attempt === 4 ? "unresolved" : "needs_evidence",
      );
    }
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(orderMailEvent)).toHaveLength(1);
    expect(
      await getDb(ctx.db).select().from(orderMailCandidateDecision),
    ).toHaveLength(1);
  });
  it("keeps an empty verified mail proposal active and settles an explicit final gap", async () => {
    const f = await fixture();
    const proposal = { ...f.proposal, orders: [] };
    const ports = {
      ...f.ports,
      assess: async () => ({
        identityVerified: true,
        scopeCompletionVerified: true,
        acceptedFacts: [],
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedOrders: [],
        rejected: [],
      }),
    };
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-empty-mail",
        proposal,
      },
      ports,
    );
    expect(result).toMatchObject({
      status: "researched_with_gaps",
      purchaseIds: [],
    });
    expect(result.refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "attempt" })]),
    );
    const [active] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(active).toMatchObject({
      state: "needs_evidence",
      completedAt: null,
    });
    await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-final-mail-gap",
        proposal: { ...proposal, status: "researched_with_gaps" },
      },
      ports,
    );
    const [settled] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(settled).toMatchObject({
      state: "unresolved",
      outcome: "researched_with_gaps",
      completedAt: expect.any(Date),
    });
  });
  async function validationAdmission(
    f: Awaited<ReturnType<typeof fixture>>,
    targetPurchase: typeof purchase.$inferSelect,
  ) {
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_AGENT_QUEUE: { send: async () => {} },
      }),
    );
    const launched = await startTargetedImport(ctx.db, f.party.id, {
      purpose: "purchase_validation",
      purchaseId: targetPurchase.shortcode,
      sourceId: null,
    });
    const admitted = launched.runs[0]?.run;
    if (!admitted) throw new Error("Validation admission is missing.");
    const runId = await resolveOrThrow(ctx.db, "run", admitted.id);
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, runId));
    if (!target) throw new Error("Validation target is missing.");
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId,
        targetId: target.id,
        kind: "mail_message",
        checksum: f.evidence.checksum,
        objectKey: `${f.evidence.objectKey}/validation`,
        mediaType: "text/plain",
        sourceMetadata: {
          orderMailId: f.mail.id,
          mailboxId: f.mail.mailboxId,
          messageId: f.mail.messageId,
          checksum: f.mail.rawChecksum,
          contextOnly: true,
        },
      })
      .returning();
    if (!evidence) throw new Error("Validation original is missing.");
    return { runId, target, evidence };
  }
  it("records the supported shipping event when its original creates the Purchase first", async () => {
    const f = await fixture(
      "Synthetic order ORDER-ONE has shipped: annual service, USD 10.",
    );
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [{ ...f.proposal.orders[0]!, event: "shipped" }],
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-shipping-first",
        proposal,
      },
      {
        ...f.ports,
        assess: async () => ({
          ...(await f.ports.assess()),
          acceptedOrders: [0],
        }),
      },
    );
    expect(result.status).toBe("verified");
    const events = await getDb(ctx.db).select().from(orderMailEvent);
    expect(events.map(({ event }) => event)).toEqual(["shipped"]);
    const links = await getDb(ctx.db).select().from(orderMailCandidateDecision);
    expect(
      links.map(({ eventId, purchaseId, evidenceChecksum }) => ({
        eventId,
        purchaseId,
        evidenceChecksum,
      })),
    ).toEqual([
      {
        eventId: events[0]!.id,
        purchaseId: result.purchaseIds[0],
        evidenceChecksum: f.mail.rawChecksum,
      },
    ]);
    const lines = await getDb(ctx.db).select().from(expense);
    expect(lines.map(({ cost }) => Number(cost))).toEqual([10]);
  });
  it("attaches only the assessed original while refusing implicit same-order mail links and attachments", async () => {
    const f = await fixture();
    const [otherMail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: f.party.id,
        mailboxId: f.mail.mailboxId,
        messageId: "synthetic-unassessed-same-order",
        vendorId: f.vendor.id,
        sender: "platform@example.test",
        subject: "Unassessed receipt",
        receivedAt: new Date("2026-10-01T12:00:00Z"),
        rawChecksum: "b".repeat(64),
        content: {
          snippet: null,
          bodyText: "Synthetic unassessed unrelated original",
          bodyHtml: null,
        },
      })
      .returning();
    if (!otherMail) throw new Error("Synthetic unassessed mail missing");
    const [otherEvent] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: otherMail.id,
        event: "confirmation",
        orderId: "ORDER-ONE",
        sourceKey: "synthetic-unassessed-order",
        payload: {},
      })
      .returning();
    if (!otherEvent) throw new Error("Synthetic unassessed event missing");
    const images = await Promise.all(
      ["assessed", "unassessed"].map((name) =>
        insertWithShortcode(ctx.db, "image", {
          key: `images/synthetic-${name}.pdf`,
          filename: `synthetic-${name}.pdf`,
          contentType: "application/pdf",
          size: 100,
          status: "UPLOADED",
          sha256: "a".repeat(64),
        }),
      ),
    );
    const [assessedImage, unassessedImage] = images;
    if (!assessedImage || !unassessedImage)
      throw new Error("Synthetic original images missing");
    await getDb(ctx.db)
      .insert(orderMailAttachment)
      .values([
        {
          orderMailId: f.mail.id,
          providerAttachmentId: "synthetic-assessed-attachment",
          filename: "synthetic-assessed.pdf",
          mimeType: "application/pdf",
          checksum: assessedImage.sha256!,
          imageId: assessedImage.id,
        },
        {
          orderMailId: otherMail.id,
          providerAttachmentId: "synthetic-unassessed-attachment",
          filename: "synthetic-unassessed.pdf",
          mimeType: "application/pdf",
          checksum: unassessedImage.sha256!,
          imageId: unassessedImage.id,
        },
      ]);
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-source-isolation",
        proposal: { ...f.proposal, orders: f.proposal.orders.slice(0, 1) },
      },
      {
        ...f.ports,
        assess: async () => ({
          ...(await f.ports.assess()),
          acceptedOrders: [0],
        }),
      },
    );
    expect(result.purchaseIds).toHaveLength(1);
    const attached = await getDb(ctx.db).select().from(entityAttachment);
    expect(attached.map((row) => row.imageId)).toEqual([assessedImage.id]);
    const decisions = await getDb(ctx.db)
      .select()
      .from(orderMailCandidateDecision);
    expect(
      decisions.some((decision) => decision.eventId === otherEvent.id),
    ).toBe(false);
    expect(decisions).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      1,
    );
  });

  it("retains supported orders while reporting incomplete account scope instead of claiming full history verification", async () => {
    const f = await fixture();
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic history account",
      vendorId: f.vendor.id,
      ledgerPartyId: f.party.id,
      browserSyncEnabled: true,
    });
    const objectives = researchObjectivesRunInput.parse({
      kind: "research_objectives",
      instructionRevision: 1,
      objectives: [
        {
          kind: "account_history",
          vendorAccountId: account.id,
          range: null,
          cursor: null,
        },
      ],
    });
    const scopeFingerprint = await sha256Hex(
      JSON.stringify([1, objectives.objectives[0]]),
    );
    await getDb(ctx.db)
      .update(run)
      .set({
        purpose: "account_sync",
        vendorAccountId: account.id,
        input: objectives,
      })
      .where(eq(run.id, f.run.id));
    await getDb(ctx.db)
      .update(runTarget)
      .set({
        workKey: `account:${account.id}`,
        sourceKind: "account_history",
        sourceExternalKey: account.id,
        vendorAccountId: account.id,
        targetFingerprint: scopeFingerprint,
      })
      .where(eq(runTarget.id, f.target.id));
    await getDb(ctx.db)
      .update(runEvidence)
      .set({
        kind: "web_page",
        sourceMetadata: {
          sourceURL: "https://shop.example.test/account/orders/one",
        },
      })
      .where(eq(runEvidence.id, f.evidence.id));
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-incomplete-history",
        proposal: { ...f.proposal, orders: f.proposal.orders.slice(0, 1) },
      },
      {
        ...f.ports,
        assess: async () => ({
          ...(await f.ports.assess()),
          acceptedOrders: [0],
        }),
      },
    );
    expect(result.purchaseIds).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
    expect(result.status).toBe("researched_with_gaps");
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(target?.state).toBe("unresolved");
    expect(target?.warning).toMatch(/scope|history|exhaust/i);
  });

  it("converges a fresh no-ID original on the supported existing Purchase without erasing its known order identity", async () => {
    const f = await fixture();
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-ONE",
    });
    const result = await writer.importVendorOrder(
      ctx.db,
      {
        ...f.writerInput,
        targetPurchaseId: existing.id,
        orderLocator: "accepted-semantic-identity",
        extraction: { status: "ready", candidate: candidate(null) },
      },
      ctx.actor.userId,
    );
    expect(result.purchaseId).toBe(existing.id);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
    expect((await getDb(ctx.db).select().from(purchase))[0]?.orderId).toBe(
      "ORDER-ONE",
    );
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
  });
  it("rejects a source-order association with a different Purchase and keeps the prior checksum and owner", async () => {
    const f = await fixture();
    const first = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-ONE",
    });
    const second = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-TWO",
    });
    const input = { ...f.writerInput, orderId: "ORDER-ONE" };
    await withTransaction(ctx.db, (tx) =>
      writer.recordImportSourceAssociation(
        tx,
        input,
        first.id,
        "synthetic-original-proof",
      ),
    );
    await expect(
      withTransaction(ctx.db, (tx) =>
        writer.recordImportSourceAssociation(
          tx,
          { ...input, source: { ...input.source, checksum: "a".repeat(64) } },
          second.id,
          "synthetic-second-proof",
        ),
      ),
    ).rejects.toThrow(/different Purchase|already.*Purchase/);
    expect(
      (await getDb(ctx.db).select().from(importSourceOrder))[0]?.purchaseId,
    ).toBe(first.id);
    expect(
      (await getDb(ctx.db).select().from(importSourceClaim))[0]?.checksum,
    ).toBe(input.source.checksum);
  });
  it("imports two service orders from one original once, with totals, source lineage, and no fabricated Product or receiving finding", async () => {
    const f = await fixture();
    const input = {
      runId: f.run.id,
      workRef: f.target.id,
      callId: "synthetic-resolve-orders",
      proposal: f.proposal,
    };
    const result = await resolveImportResearch(ctx.db, input, f.ports);
    expect(result.purchaseIds).toHaveLength(2);
    expect(await resolveImportResearch(ctx.db, input, f.ports)).toEqual(result);
    const expenses = await getDb(ctx.db).select().from(expense);
    expect(expenses).toHaveLength(2);
    expect(
      expenses.reduce(
        (sum, line) => sum + (line.cost === null ? Number.NaN : line.cost),
        0,
      ),
    ).toBe(30);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toHaveLength(
      1,
    );
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
      2,
    );
    expect(await getDb(ctx.db).select().from(orderMailEvent)).toHaveLength(2);
    expect(
      await getDb(ctx.db).select().from(orderMailCandidateDecision),
    ).toHaveLength(2);
    expect(
      (await getDb(ctx.db).select().from(runFinding)).filter(
        (finding) => finding.kind === "arrived",
      ),
    ).toEqual([]);
    expect((await getDb(ctx.db).select().from(mailboxMessage))[0]?.status).toBe(
      "completed",
    );
    await expect(
      resolveImportResearch(
        ctx.db,
        { ...input, callId: "synthetic-late-resolve" },
        f.ports,
      ),
    ).rejects.toThrow(/settled|closed/);
  });
  it("refuses an accepted Purchase reference whose live catalog branch has no complete assessment mapping", async () => {
    const f = await fixture(
      "ORDER-ONE establishes a supported annual service for USD 10.",
    );
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic annual service purpose",
    });
    // A malformed persisted branch must fail closed even when its leaf is live.
    await getDb(ctx.db)
      .update(spendingCategory)
      .set({ parentId: category.id })
      .where(eq(spendingCategory.id, category.id));
    const input = {
      runId: f.run.id,
      workRef: f.target.id,
      callId: "synthetic-incomplete-reference-meaning",
      proposal: researchWorkResolve.parse({
        ...f.proposal,
        facts: [
          {
            evidenceId: f.evidence.id,
            orderIndex: 0,
            fieldPath: "spendingCategoryId",
            value: category.shortcode,
            support: {
              observation: "Annual service",
              reasoning: "The source establishes this service purpose.",
            },
          },
        ],
      }),
    };
    const result = await resolveImportResearch(ctx.db, input, {
      ...f.ports,
      assess: async (assessment: Parameters<ResearchAssessor>[0]) => {
        expect(assessment.context).toMatchObject({ referenceValues: [] });
        return {
          ...(await f.ports.assess()),
          acceptedOrders: [0],
          acceptedFacts: [0],
        };
      },
    });
    const [saved] = await getDb(ctx.db).select().from(purchase);
    expect(saved?.spendingCategoryId).toBeNull();
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
    expect(result.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "orders[0].spendingCategoryId" }),
      ]),
    );
  });
  it("scopes live Purchase reference meaning to each original order without merging identical catalog leaf labels", async () => {
    const f = await fixture(
      "ORDER-ONE: Synthetic home repairs > Annual service, USD 10. ORDER-TWO: Synthetic vehicle repairs > Annual service, USD 20.",
    );
    const categories = await Promise.all(
      ["Synthetic home repairs", "Synthetic vehicle repairs"].map(
        async (name) => {
          const parent = await insertWithShortcode(ctx.db, "spendingCategory", {
            name,
          });
          const category = await insertWithShortcode(
            ctx.db,
            "spendingCategory",
            {
              name: "Annual service",
              parentId: parent.id,
            },
          );
          return { parent, category };
        },
      ),
    );
    const input = {
      runId: f.run.id,
      workRef: f.target.id,
      callId: "synthetic-scoped-reference-meaning",
      proposal: researchWorkResolve.parse({
        ...f.proposal,
        facts: categories.map(({ parent, category }, orderIndex) => ({
          evidenceId: f.evidence.id,
          orderIndex,
          fieldPath: "spendingCategoryId",
          value: category.shortcode,
          support: {
            observation: `${parent.name} > Annual service`,
            reasoning:
              "The original identifies this exact acquisition's service purpose.",
          },
        })),
      }),
    };
    let assessments = 0;
    const ports = {
      ...f.ports,
      assess: async (assessment: Parameters<ResearchAssessor>[0]) => {
        assessments++;
        expect(assessment.context).toMatchObject({
          referenceValues: categories.map(({ parent, category }, index) => ({
            factIndex: index,
            entityKind: "purchase",
            orderIndex: index,
            fieldPath: "spendingCategoryId",
            reference: {
              id: category.shortcode,
              name: "Annual service",
              path: [
                { id: parent.shortcode, name: parent.name },
                { id: category.shortcode, name: "Annual service" },
              ],
            },
          })),
        });
        expect(assessment.observations[0]?.content).toBe(f.content);
        return { ...(await f.ports.assess()), acceptedFacts: [0, 1] };
      },
    };
    const result = await resolveImportResearch(ctx.db, input, ports);
    const rows = await getDb(ctx.db).select().from(purchase);
    for (const [index, { category }] of categories.entries()) {
      const saved = rows.find(
        (row) => row.orderId === (index === 0 ? "ORDER-ONE" : "ORDER-TWO"),
      );
      expect(saved?.spendingCategoryId).toBe(category.id);
      const proof = await loadCurrentFactEvidence(ctx.db, {
        entityKind: "purchase",
        entityId: saved!.shortcode,
        fieldPath: "spendingCategoryId",
        ledgerPartyId: f.party.id,
      });
      expect(proof).toMatchObject([
        { value: category.id, support: input.proposal.facts[index]?.support },
      ]);
    }
    expect(rows).toHaveLength(2);
    expect(await resolveImportResearch(ctx.db, input, ports)).toEqual(result);
    expect(assessments).toBe(1);
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(2);
  });
  it.each(["distinct_purposes", "shared_purpose", "filtered_order"] as const)(
    "binds accepted purpose facts to their exact original order and retains discoverable Purchase proof (%s)",
    async (mode) => {
      const f = await fixture();
      const categories = await Promise.all(
        [
          "Synthetic annual service purpose",
          "Synthetic recurring service purpose",
        ].map((name) =>
          insertWithShortcode(ctx.db, "spendingCategory", { name }),
        ),
      );
      if (mode === "shared_purpose") categories[1] = categories[0]!;
      const acceptedOrders = mode === "filtered_order" ? [1] : [0, 1];
      const input = {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-resolve-order-purpose",
        proposal: researchWorkResolve.parse({
          ...f.proposal,
          facts: categories.map((category, orderIndex) => ({
            evidenceId: f.evidence.id,
            orderIndex,
            fieldPath: "spendingCategoryId",
            value: category.shortcode,
            support: {
              observation: `Annual service ORDER-${orderIndex === 0 ? "ONE" : "TWO"}`,
              reasoning:
                "The original describes this distinct service acquisition's purpose.",
            },
          })),
        }),
      };
      const ports = {
        ...f.ports,
        assess: async () => ({
          ...(await f.ports.assess()),
          acceptedOrders,
          acceptedFacts: acceptedOrders,
        }),
      };
      const result = await resolveImportResearch(ctx.db, input, ports);
      expect(result.purchaseIds).toHaveLength(acceptedOrders.length);
      const rows = await getDb(ctx.db).select().from(purchase);
      expect(rows).toHaveLength(acceptedOrders.length);
      for (const index of acceptedOrders) {
        const category = categories[index]!;
        const saved = rows.find(
          (row) => row.orderId === `ORDER-${index === 0 ? "ONE" : "TWO"}`,
        );
        expect(saved?.spendingCategoryId).toBe(category.id);
        if (!saved) throw new Error("Synthetic imported Purchase missing");
        const proof = await loadCurrentFactEvidence(ctx.db, {
          entityKind: "purchase",
          entityId: saved.shortcode,
          fieldPath: "spendingCategoryId",
          ledgerPartyId: f.party.id,
        });
        expect(proof).toMatchObject([
          {
            subject: { entityKind: "purchase", entityId: saved.shortcode },
            value: category.id,
            support: input.proposal.facts[index]?.support,
          },
        ]);
      }
      const proofs = await getDb(ctx.db).select().from(runFactEvidence);
      expect(proofs).toHaveLength(acceptedOrders.length);
      expect(proofs.every((proof) => proof.targetId === f.target.id)).toBe(
        true,
      );
      expect(await resolveImportResearch(ctx.db, input, ports)).toEqual(result);
      expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual(
        proofs,
      );
      const expenses = await getDb(ctx.db).select().from(expense);
      expect(expenses).toHaveLength(acceptedOrders.length);
      expect(
        expenses.reduce(
          (sum, row) => sum + (row.cost === null ? Number.NaN : row.cost),
          0,
        ),
      ).toBe(mode === "filtered_order" ? 20 : 30);
      expect(await getDb(ctx.db).select().from(product)).toEqual([]);
      expect(
        (await getDb(ctx.db).select().from(runFinding)).some(
          (finding) => finding.kind === "arrived",
        ),
      ).toBe(false);
    },
  );
  it.each(["missing", "absent", "rejected"] as const)(
    "refuses an accepted Purchase fact with %s order binding before any domain writes",
    async (binding) => {
      const f = await fixture();
      const category = await insertWithShortcode(ctx.db, "spendingCategory", {
        name: "Synthetic refused purpose",
      });
      const fact: ResearchWorkResolution["facts"][number] = {
        evidenceId: f.evidence.id,
        fieldPath: "spendingCategoryId",
        value: category.shortcode,
        support: {
          observation: "Synthetic annual service",
          reasoning: "This source explains the acquisition purpose.",
        },
      };
      if (binding !== "missing")
        fact.orderIndex = binding === "absent" ? 20 : 0;
      const proposal = researchWorkResolve.parse({
        ...f.proposal,
        facts: [fact],
      });
      await expect(
        resolveImportResearch(
          ctx.db,
          {
            runId: f.run.id,
            workRef: f.target.id,
            callId: `synthetic-invalid-binding-${binding}`,
            proposal,
          },
          {
            ...f.ports,
            assess: async () => ({
              ...(await f.ports.assess()),
              acceptedOrders: binding === "rejected" ? [1] : [0, 1],
              acceptedFacts: [0],
            }),
          },
        ),
      ).rejects.toThrow(/order.*(binding|accepted|missing)|bound.*order/i);
      expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
      expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
      expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
      expect(await getDb(ctx.db).select().from(importSourceOrder)).toEqual([]);
    },
  );
  it.each(["matching", "contradiction"] as const)(
    "preserves an existing Purchase purpose while retaining a %s outcome",
    async (mode) => {
      const f = await fixture();
      const categories = await Promise.all(
        ["Synthetic supported purpose", "Synthetic member purpose"].map(
          (name) => insertWithShortcode(ctx.db, "spendingCategory", { name }),
        ),
      );
      const proposed = categories[0]!;
      const current = mode === "matching" ? proposed : categories[1]!;
      const existing = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: f.vendor.id,
        orderId: "ORDER-ONE",
        spendingCategoryId: current.id,
        spendingCategoryOrigin: "manual",
      });
      const proposal = researchWorkResolve.parse({
        ...f.proposal,
        orders: [f.proposal.orders[0]],
        facts: [
          {
            evidenceId: f.evidence.id,
            orderIndex: 0,
            fieldPath: "spendingCategoryId",
            value: proposed.shortcode,
            support: {
              observation: "Synthetic annual service purpose",
              reasoning:
                "The exact identified acquisition describes this supported purpose.",
            },
          },
        ],
      });
      const result = await resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: `synthetic-existing-purpose-${mode}`,
          proposal,
        },
        {
          ...f.ports,
          assess: async () => ({
            ...(await f.ports.assess()),
            acceptedOrders: [0],
            acceptedFacts: [0],
          }),
        },
      );
      const [saved] = await getDb(ctx.db)
        .select()
        .from(purchase)
        .where(eq(purchase.id, existing.id));
      expect(saved).toMatchObject({
        spendingCategoryId: current.id,
        spendingCategoryOrigin: "manual",
      });
      const proof = await loadCurrentFactEvidence(ctx.db, {
        entityKind: "purchase",
        entityId: existing.shortcode,
        fieldPath: "spendingCategoryId",
        ledgerPartyId: f.party.id,
      });
      expect(proof.map((row) => row.value)).toEqual(
        mode === "matching" ? [current.id] : [],
      );
      expect(result.status).toBe(
        mode === "matching" ? "verified" : "researched_with_gaps",
      );
      const [settled] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, f.target.id));
      expect(settled).toMatchObject({
        state: mode === "matching" ? "completed" : "unresolved",
        completedAt: expect.any(Date),
      });
      const contradictionRefusal = {
        path: "orders[0].spendingCategoryId",
        reason: expect.stringMatching(/conflict|contradict/i),
      };
      const expectedRefusals =
        mode === "matching" ? [] : [contradictionRefusal];
      expect(result.refusals).toEqual(expectedRefusals);
      expect(
        (await getDb(ctx.db).select().from(expense)).reduce(
          (sum, row) => sum + (row.cost === null ? Number.NaN : row.cost),
          0,
        ),
      ).toBe(10);
    },
  );
  it("checks the current canonical purpose when two accepted operands resolve to one Purchase", async () => {
    const f = await fixture();
    const categories = await Promise.all(
      ["Synthetic first accepted purpose", "Synthetic conflicting purpose"].map(
        (name) => insertWithShortcode(ctx.db, "spendingCategory", { name }),
      ),
    );
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [f.proposal.orders[0], f.proposal.orders[0]],
      facts: categories.map((category, orderIndex) => ({
        evidenceId: f.evidence.id,
        orderIndex,
        fieldPath: "spendingCategoryId",
        value: category.shortcode,
        support: {
          observation: "Synthetic annual service",
          reasoning:
            "The same original acquisition supports this proposed purpose.",
        },
      })),
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-duplicate-order-purpose",
        proposal,
      },
      {
        ...f.ports,
        assess: async () => ({
          ...(await f.ports.assess()),
          acceptedFacts: [0, 1],
        }),
      },
    );
    const purchases = await getDb(ctx.db).select().from(purchase);
    expect(purchases).toMatchObject([
      {
        spendingCategoryId: categories[0]!.id,
        spendingCategoryOrigin: "source",
      },
    ]);
    expect(purchases).toHaveLength(1);
    expect(result).toMatchObject({
      status: "researched_with_gaps",
      refusals: [{ path: "orders[1].spendingCategoryId" }],
    });
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toHaveLength(1);
    expect(
      (await getDb(ctx.db).select().from(expense)).reduce(
        (sum, row) => sum + (row.cost === null ? Number.NaN : row.cost),
        0,
      ),
    ).toBe(10);
  });
  it("records supported source purposes without changing existing Expense classification", async () => {
    const f = await fixture(
      "Synthetic original lists an acquired durable item ORDER-ONE and a service ORDER-TWO.",
    );
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic acquired durable item",
        categoryId: null,
      }),
      ctx.actor,
    );
    const blocked = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic purpose forbidding Products",
      productExpectation: "not_allowed",
    });
    const allowed = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic supported service purpose",
    });
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [
        {
          ...f.proposal.orders[0],
          productResolutions: [
            { kind: "existing", lineIndex: 0, productId: item.id },
          ],
        },
        f.proposal.orders[1],
      ],
      facts: [blocked, allowed].map((category, orderIndex) => ({
        evidenceId: f.evidence.id,
        orderIndex,
        fieldPath: "spendingCategoryId",
        value: category.shortcode,
        support: {
          observation: "Synthetic distinct acquisition purpose",
          reasoning:
            "The retained source identifies this acquisition and proposed purpose.",
        },
      })),
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-policy-refused-purpose",
        proposal,
      },
      {
        ...f.ports,
        assess: async () => ({
          ...(await f.ports.assess()),
          acceptedFacts: [0, 1],
        }),
      },
    );
    const rows = await getDb(ctx.db).select().from(purchase);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.orderId === "ORDER-ONE")).toMatchObject({
      spendingCategoryId: blocked.id,
      spendingCategoryOrigin: "source",
    });
    expect(
      rows.find((row) => row.orderId === "ORDER-TWO")?.spendingCategoryId,
    ).toBe(allowed.id);
    expect(result.refusals).toEqual([]);
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toHaveLength(2);
    const expenses = await getDb(ctx.db).select().from(expense);
    expect(expenses).toHaveLength(2);
    expect(
      expenses.reduce(
        (sum, row) => sum + (row.cost === null ? Number.NaN : row.cost),
        0,
      ),
    ).toBe(30);
    expect(
      expenses.filter((row) => row.productId === item.entityId),
    ).toHaveLength(1);
    const classifications = await getDb(ctx.db)
      .select({ categoryId: effectiveExpenseSpendingCategorySql("Expense") })
      .from(expense);
    expect(classifications).toEqual([
      { categoryId: null },
      { categoryId: null },
    ]);
  });
  it("refuses forged source identity and changed frozen originals before semantic assessment or domain writes", async () => {
    const f = await fixture();
    let assessments = 0;
    const ports = {
      ...f.ports,
      assess: async () => {
        assessments += 1;
        return f.ports.assess();
      },
    };
    await getDb(ctx.db)
      .update(runEvidence)
      .set({
        sourceMetadata: {
          orderMailId: crypto.randomUUID(),
          mailboxId: f.mail.mailboxId,
          messageId: f.mail.messageId,
          checksum: f.mail.rawChecksum,
        },
      })
      .where(eq(runEvidence.id, f.evidence.id));
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-forged-source",
          proposal: f.proposal,
        },
        ports,
      ),
    ).rejects.toThrow(/source|owned|identity/);
    expect(assessments).toBe(0);
    await getDb(ctx.db)
      .update(runEvidence)
      .set({
        sourceMetadata: {
          orderMailId: f.mail.id,
          mailboxId: f.mail.mailboxId,
          messageId: f.mail.messageId,
          checksum: f.mail.rawChecksum,
        },
      })
      .where(eq(runEvidence.id, f.evidence.id));
    await getDb(ctx.db)
      .update(orderMail)
      .set({ rawChecksum: "b".repeat(64) })
      .where(eq(orderMail.id, f.mail.id));
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-stale-source",
          proposal: f.proposal,
        },
        ports,
      ),
    ).rejects.toThrow(/changed|checksum/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
  });
  it.each(["none", "dismissed", "linked_elsewhere"] as const)(
    "links refund provenance without changing money and preserves human decisions (%s)",
    async (decision) => {
      const f = await fixture(
        "Synthetic refund notice for service ORDER-ONE. The original paid amount is ten dollars.",
      );
      const existing = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: f.vendor.id,
        orderId: "ORDER-ONE",
      });
      const other = await insertWithShortcode(ctx.db, "purchase", {
        vendorId: f.vendor.id,
        orderId: "ORDER-OTHER",
      });
      await insertWithShortcode(ctx.db, "expense", {
        purchaseId: existing.id,
        name: "Synthetic annual service",
        trade: "other",
        costType: "services",
        date: "2026-10-01",
        cost: 10,
        lineKind: "principal",
      });
      const [event] = await getDb(ctx.db)
        .insert(orderMailEvent)
        .values({
          orderMailId: f.mail.id,
          sourceKey: "synthetic-historical-event",
          event: "placed",
          orderId: "ORDER-ONE",
          payload: {},
        })
        .returning();
      if (!event) throw new Error("Synthetic event missing");
      if (decision !== "none")
        await getDb(ctx.db)
          .insert(orderMailCandidateDecision)
          .values({
            eventId: event.id,
            purchaseId: decision === "dismissed" ? existing.id : other.id,
            decision: decision === "dismissed" ? "dismissed" : "linked",
            evidenceChecksum: f.mail.rawChecksum,
            decidedByUserId: ctx.actor.userId,
          });
      await getDb(ctx.db)
        .insert(orderMailAttachment)
        .values({
          orderMailId: f.mail.id,
          providerAttachmentId: "synthetic-pdf",
          filename: "receipt.pdf",
          mimeType: "application/pdf",
          checksum: await sha256Hex("pdf"),
          pendingObjectKey: "synthetic/pdf",
        });
      let attachments = 0;
      const proposal = researchWorkResolve.parse({
        workRef: f.target.id,
        status: "verified",
        identity: {
          evidenceIds: [f.evidence.id],
          reasoning:
            "The original refund notice uniquely refers to the recorded service order.",
        },
        emailLinks: [
          {
            purchaseRef: existing.shortcode,
            evidenceIds: [f.evidence.id],
            reasoning:
              "The supported notice is a lifecycle update for this exact service.",
            event: "refunded",
          },
        ],
        detail:
          "Preserved refund support without booking an automatic financial adjustment.",
      });
      const result = await resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-refund-link",
          proposal,
        },
        {
          ...f.ports,
          assess: async () => ({
            identityVerified: true,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedOrders: [],
            acceptedEmailLinks: [0],
            rejected: [],
          }),
          attachSource: async () => {
            attachments += 1;
          },
        },
      );
      expect(
        (await getDb(ctx.db).select().from(expense)).map((line) =>
          Number.isFinite(line.cost) ? line.cost : Number.NaN,
        ),
      ).toEqual([10]);
      expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(2);
      const decisions = await getDb(ctx.db)
        .select()
        .from(orderMailCandidateDecision);
      expect(result.purchaseIds.includes(existing.id)).toBe(
        decision === "none",
      );
      expect(
        (await getDb(ctx.db).select().from(orderMailEvent)).some(
          (row) => row.event === "refunded",
        ),
      ).toBe(decision === "none");
      expect(attachments).toBe(decision === "none" ? 1 : 0);
      expect(result.status).toBe(
        decision === "none" ? "verified" : "researched_with_gaps",
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.decision).toBe(
        decision === "dismissed" ? "dismissed" : "linked",
      );
      expect(await getDb(ctx.db).select().from(importSourceClaim)).toHaveLength(
        decision === "none" ? 1 : 0,
      );
    },
  );

  it("imports supported browser originals through the same writer and preserves source replay", async () => {
    const f = await fixture();
    const broker = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: f.vendor.id,
      ledgerPartyId: f.party.id,
      label: "Synthetic browser account",
    });
    const scope = researchObjectivesRunInput.parse({
      kind: "research_objectives",
      instructionRevision: 1,
      objectives: [
        {
          kind: "account_history",
          vendorAccountId: broker.id,
          range: null,
          cursor: null,
        },
      ],
    });
    await getDb(ctx.db)
      .update(run)
      .set({
        purpose: "account_sync",
        vendorAccountId: broker.id,
        input: scope,
      })
      .where(eq(run.id, f.run.id));
    await getDb(ctx.db)
      .update(runTarget)
      .set({ workKey: researchObjectiveKey(scope.objectives[0]!) })
      .where(eq(runTarget.id, f.target.id));
    await getDb(ctx.db)
      .update(runEvidence)
      .set({
        kind: "browser_capture",
        sourceMetadata: {
          sourceURL: "https://merchant.example.test/orders",
          servedURL: "https://merchant.example.test/orders",
          brokerAccountId: broker.id,
          title: "Synthetic original orders",
          capturedAt: "2026-10-01T12:00:00Z",
          truncated: false,
        },
      })
      .where(eq(runEvidence.id, f.evidence.id));
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-browser-orders",
        proposal: f.proposal,
      },
      f.ports,
    );
    expect(result.purchaseIds).toHaveLength(2);
    expect(
      (await getDb(ctx.db).select().from(importSourceClaim)).every(
        (claim) => claim.kind === "browser_order",
      ),
    ).toBe(true);
    expect(
      (await getDb(ctx.db).select().from(expense)).map((line) =>
        Number.isFinite(line.cost) ? line.cost : Number.NaN,
      ),
    ).toEqual([10, 20]);
  });
  it("keeps purchase validation read-only even when semantic support accepts an order", async () => {
    const f = await fixture();
    const targetPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-ONE",
      statedTotal: 18,
    });
    const validation = await validationAdmission(f, targetPurchase);
    const proposedOrder = f.proposal.orders[0];
    if (!proposedOrder) throw new Error("Synthetic accepted order is missing.");
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      workRef: validation.target.id,
      identity: {
        ...f.proposal.identity,
        evidenceIds: [validation.evidence.id],
      },
      orders: [
        {
          ...proposedOrder,
          purchaseRef: targetPurchase.shortcode,
          evidenceIds: [validation.evidence.id],
        },
      ],
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: validation.runId,
        workRef: validation.target.id,
        callId: "synthetic-validation",
        proposal,
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [0],
          acceptedEmailLinks: [],
          rejected: [],
        }),
      },
    );
    expect(result.proposedOrders).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([
      targetPurchase,
    ]);
  });
  it("refuses financial reversal operands even when semantic assessment accepts them", async () => {
    const f = await fixture();
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [
        { ...f.proposal.orders[0], candidate: candidate("ORDER-ONE", -10) },
      ],
    });
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-refused-reversal",
          proposal,
        },
        {
          ...f.ports,
          assess: async () => ({
            identityVerified: true,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedOrders: [0],
            acceptedEmailLinks: [],
            rejected: [],
          }),
        },
      ),
    ).rejects.toThrow(/reversal|negative|refund/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
  });

  it("preserves historical dismissal when the writer would find a known order without an explicit purchaseRef", async () => {
    const f = await fixture();
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-ONE",
    });
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: f.mail.id,
        sourceKey: "synthetic-dismissed-order",
        event: "placed",
        orderId: "ORDER-ONE",
        payload: {},
      })
      .returning();
    if (!event) throw new Error("Synthetic event missing");
    await getDb(ctx.db).insert(orderMailCandidateDecision).values({
      eventId: event.id,
      purchaseId: existing.id,
      decision: "dismissed",
      evidenceChecksum: f.mail.rawChecksum,
      decidedByUserId: ctx.actor.userId,
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-dismissed-order-write",
        proposal: researchWorkResolve.parse({
          ...f.proposal,
          orders: [f.proposal.orders[0]],
        }),
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [0],
          acceptedEmailLinks: [],
          rejected: [],
        }),
      },
    );
    expect(result.status).toBe("researched_with_gaps");
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(orderMailCandidateDecision)).map(
        (decision) => decision.decision,
      ),
    ).toEqual(["dismissed"]);
  });
  it("creates one supported unfamiliar Vendor for two distinct orders and no physical service Products", async () => {
    const f = await fixture();
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: f.proposal.orders.map(({ vendorRef: _vendorRef, ...order }) => ({
        ...order,
        vendor: {
          name: "Synthetic unfamiliar merchant",
          website: "https://unfamiliar.example.test",
        },
      })),
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-unfamiliar-vendor",
        proposal,
      },
      f.ports,
    );
    expect(result.purchaseIds).toHaveLength(2);
    expect(
      (await getDb(ctx.db).select().from(vendor)).filter(
        (row) => row.name === "Synthetic unfamiliar merchant",
      ),
    ).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
  });
  it("rejects browser captures without an owned broker before semantic assessment", async () => {
    const f = await fixture();
    const broker = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: f.vendor.id,
      ledgerPartyId: f.party.id,
      label: "Synthetic owned history account",
    });
    const scope = researchObjectivesRunInput.parse({
      kind: "research_objectives",
      instructionRevision: 1,
      objectives: [
        {
          kind: "account_history",
          vendorAccountId: broker.id,
          range: null,
          cursor: null,
        },
      ],
    });
    await getDb(ctx.db)
      .update(run)
      .set({
        purpose: "account_sync",
        vendorAccountId: broker.id,
        input: scope,
      })
      .where(eq(run.id, f.run.id));
    await getDb(ctx.db)
      .update(runTarget)
      .set({ workKey: researchObjectiveKey(scope.objectives[0]!) })
      .where(eq(runTarget.id, f.target.id));
    await getDb(ctx.db)
      .update(runEvidence)
      .set({
        kind: "browser_capture",
        sourceMetadata: { sourceURL: "https://merchant.example.test/orders" },
      })
      .where(eq(runEvidence.id, f.evidence.id));
    let assessed = false;
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-unowned-browser",
          proposal: f.proposal,
        },
        {
          ...f.ports,
          assess: async () => {
            assessed = true;
            return f.ports.assess();
          },
        },
      ),
    ).rejects.toThrow(/broker|account|owned/);
    expect(assessed).toBe(false);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
  it("fences original evidence metadata changed during semantic assessment", async () => {
    const f = await fixture();
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-evidence-changed-after-assessment",
          proposal: f.proposal,
        },
        {
          ...f.ports,
          assess: async () => {
            await getDb(ctx.db)
              .update(runEvidence)
              .set({
                sourceMetadata: {
                  orderMailId: f.mail.id,
                  mailboxId: f.mail.mailboxId,
                  messageId: "synthetic-different-original",
                  checksum: f.mail.rawChecksum,
                },
              })
              .where(eq(runEvidence.id, f.evidence.id));
            return f.ports.assess();
          },
        },
      ),
    ).rejects.toThrow(/changed|identity|evidence/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
  });
  it("allows a supported new acquisition discount while refusing refund principal reversals", async () => {
    const f = await fixture();
    const discounted = {
      ...candidate("ORDER-DISCOUNTED"),
      printedGrandTotal: 8,
      lines: [
        ...candidate("ORDER-DISCOUNTED").lines,
        {
          title: "Synthetic purchase discount",
          amount: -2,
          quantity: 1,
          lineKind: "discount",
        },
      ],
    };
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [{ ...f.proposal.orders[0], candidate: discounted }],
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-discounted-new-purchase",
        proposal,
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [0],
          acceptedEmailLinks: [],
          rejected: [],
        }),
      },
    );
    expect(result.purchaseIds).toHaveLength(1);
    expect(
      (await getDb(ctx.db).select().from(expense)).reduce(
        (sum, line) => sum + (line.cost === null ? Number.NaN : line.cost),
        0,
      ),
    ).toBe(8);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
  });

  async function supplemental(
    f: Awaited<ReturnType<typeof fixture>>,
    contextOnly = false,
  ) {
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: f.party.id,
        mailboxId: f.mail.mailboxId,
        messageId: "synthetic-supplemental",
        sender: "platform@example.test",
        subject: "Supplemental service receipt",
        receivedAt: f.mail.receivedAt,
        rawChecksum: f.mail.rawChecksum,
        content: f.mail.content,
      })
      .returning();
    if (!mail) throw new Error("Synthetic supplemental source missing");
    await getDb(ctx.db)
      .insert(mailboxMessage)
      .values({
        ledgerPartyId: f.party.id,
        mailboxId: mail.mailboxId,
        messageId: mail.messageId,
        checksum: mail.rawChecksum,
        classification: "related",
        classificationVersion: MAILBOX_RESEARCH_VERSION,
        status: "researching",
        runId: contextOnly ? null : f.run.id,
        orderMailId: mail.id,
      });
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: f.run.id,
        targetId: f.target.id,
        kind: "mail_message",
        checksum: f.mail.rawChecksum,
        objectKey: "synthetic/supplemental-mail",
        mediaType: "text/plain",
        sourceMetadata: {
          orderMailId: mail.id,
          mailboxId: mail.mailboxId,
          messageId: mail.messageId,
          checksum: mail.rawChecksum,
          contextOnly,
        },
      })
      .returning();
    if (!evidence)
      throw new Error("Synthetic supplemental observation missing");
    return { mail, evidence };
  }
  it("refuses to settle another owned message through the current source task", async () => {
    const f = await fixture();
    const additional = await supplemental(f);
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: f.proposal.orders.map((order) => ({
        ...order,
        evidenceIds: [additional.evidence.id],
      })),
    });
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-cross-source-task",
          proposal,
        },
        f.ports,
      ),
    ).rejects.toThrow(/primary|task|work/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(mailboxMessage)).every(
        (message) => message.status === "researching",
      ),
    ).toBe(true);
  });
  it("uses context-only mail in semantic support without taking source ownership or writing its lineage", async () => {
    const f = await fixture();
    const additional = await supplemental(f, true);
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      identity: {
        ...f.proposal.identity,
        evidenceIds: [f.evidence.id, additional.evidence.id],
      },
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-context-only-support",
        proposal,
      },
      f.ports,
    );
    expect(result.purchaseIds).toHaveLength(2);
    expect(
      (await getDb(ctx.db).select().from(importSourceClaim)).map(
        (claim) => claim.externalKey,
      ),
    ).toEqual([`gmail:${f.mail.mailboxId}:${f.mail.messageId}`]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(mailboxMessage)
          .where(eq(mailboxMessage.orderMailId, additional.mail.id))
      )[0]?.runId,
    ).toBeNull();
    expect(
      await getDb(ctx.db)
        .select()
        .from(orderMailEvent)
        .where(eq(orderMailEvent.orderMailId, additional.mail.id)),
    ).toEqual([]);
  });

  it("bounds semantic context to explicit references and current source lineage rather than household financial history", async () => {
    const f = await fixture();
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-ONE",
    });
    const unrelated = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-UNRELATED",
    });
    const unrelatedExpense = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: unrelated.id,
      name: "Synthetic unrelated household charge",
      trade: "other",
      costType: "services",
      date: "2026-09-01",
      cost: 17,
      lineKind: "principal",
    });
    const priorProof = await sha256Hex("synthetic-prior-source-proof");
    await withTransaction(ctx.db, (tx) =>
      writer.recordImportSourceAssociation(
        tx,
        { ...f.writerInput, orderId: "ORDER-ONE" },
        existing.id,
        priorProof,
      ),
    );
    let contextJson = "";
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [{ ...f.proposal.orders[0], purchaseRef: existing.shortcode }],
    });
    await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-bounded-support-context",
        proposal,
      },
      {
        ...f.ports,
        assess: async (input) => {
          contextJson = JSON.stringify(input.context);
          return {
            identityVerified: true,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedOrders: [0],
            acceptedEmailLinks: [],
            rejected: [],
          };
        },
      },
    );
    expect(contextJson).toContain(existing.shortcode);
    expect(contextJson).toContain(priorProof);
    expect(contextJson).not.toContain(unrelated.shortcode);
    expect(contextJson).not.toContain(unrelatedExpense.name);
  });
  it.each(["date", "total"] as const)(
    "retains a supported incomplete Purchase with unknown %s without inventing money, Products, or a source identity",
    async (missing) => {
      const f = await fixture();
      const incomplete = {
        ...candidate(null),
        orderedAt: missing === "date" ? null : candidate(null).orderedAt,
        printedGrandTotal: missing === "total" ? null : 10,
      };
      const proposal = researchWorkResolve.parse({
        ...f.proposal,
        status: "partially_verified",
        orders: [{ ...f.proposal.orders[0], candidate: incomplete }],
        detail:
          "The original supports acquisition identity while the source has an unknown required money field.",
      });
      const result = await resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: `synthetic-incomplete-${missing}`,
          proposal,
        },
        {
          ...f.ports,
          assess: async () => ({
            identityVerified: true,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedOrders: [0],
            acceptedEmailLinks: [],
            rejected: [],
          }),
        },
      );
      expect(result.purchaseIds).toHaveLength(1);
      expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
      expect(await getDb(ctx.db).select().from(product)).toEqual([]);
      expect(await getDb(ctx.db).select().from(importSourceOrder)).toHaveLength(
        1,
      );
      expect(
        await resolveImportResearch(
          ctx.db,
          {
            runId: f.run.id,
            workRef: f.target.id,
            callId: `synthetic-incomplete-${missing}`,
            proposal,
          },
          f.ports,
        ),
      ).toEqual(result);
      expect(
        (await getDb(ctx.db).select().from(purchase))[0]?.orderId,
      ).toBeNull();
    },
  );
  it("refuses identical no-ID orders reached through different aliases of the same supported Vendor", async () => {
    const f = await fixture();
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [
        { ...f.proposal.orders[0], candidate: candidate(null) },
        {
          ...f.proposal.orders[0],
          vendorRef: undefined,
          vendor: { name: f.vendor.name },
          candidate: candidate(null),
        },
      ],
    });
    await expect(
      resolveImportResearch(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-ambiguous-no-id-vendor-alias",
          proposal,
        },
        f.ports,
      ),
    ).rejects.toThrow(/ambiguous|identical|distinct/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(purchase)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
  });
  it("returns supported validation facts with the current Purchase context while preserving recorded money", async () => {
    const f = await fixture(
      "Synthetic original: ORDER-ONE annual service, total USD 10.",
    );
    const targetPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-ONE",
      statedTotal: 18,
    });
    const recorded = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: targetPurchase.id,
      name: "Synthetic recorded annual service",
      cost: 18,
      costType: "services",
      trade: "other",
      date: "2026-10-01",
      lineKind: "principal",
    });
    const validation = await validationAdmission(f, targetPurchase);
    const fact = {
      evidenceId: validation.evidence.id,
      fieldPath: "statedTotal",
      value: 10,
      support: {
        observation: "ORDER-ONE annual service, total USD 10.",
        reasoning:
          "The original states the total for this exact recorded acquisition.",
      },
    };
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      workRef: validation.target.id,
      identity: {
        ...f.proposal.identity,
        evidenceIds: [validation.evidence.id],
      },
      orders: [],
      facts: [fact],
    });
    let contextJson = "";
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: validation.runId,
        workRef: validation.target.id,
        callId: "synthetic-validation-facts",
        proposal,
      },
      {
        ...f.ports,
        assess: async ({ context }) => {
          contextJson = JSON.stringify(context);
          return {
            identityVerified: true,
            acceptedFacts: [0],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedOrders: [],
            acceptedEmailLinks: [],
            rejected: [],
          };
        },
      },
    );
    expect.soft(contextJson).toContain(targetPurchase.shortcode);
    expect.soft(contextJson).toContain(recorded.name);
    expect.soft(result.proposedFacts).toEqual([fact]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([recorded]);
    expect((await getDb(ctx.db).select().from(purchase))[0]?.statedTotal).toBe(
      18,
    );
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual([]);
  });
  it("reports a research gap when existing canonical Expenses refuse automatic receipt writes", async () => {
    const f = await fixture();
    const existing = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.vendor.id,
      orderId: "ORDER-ONE",
      itemizationEvidence: true,
    });
    const recorded = await insertWithShortcode(ctx.db, "expense", {
      purchaseId: existing.id,
      name: "Synthetic reviewed service line",
      cost: 17,
      costType: "services",
      trade: "other",
      date: "2026-10-01",
      lineKind: "principal",
    });
    const proposal = researchWorkResolve.parse({
      ...f.proposal,
      orders: [{ ...f.proposal.orders[0], purchaseRef: existing.shortcode }],
    });
    const result = await resolveImportResearch(
      ctx.db,
      {
        runId: f.run.id,
        workRef: f.target.id,
        callId: "synthetic-refused-canonical-lines",
        proposal,
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [0],
          acceptedEmailLinks: [],
          rejected: [],
        }),
      },
    );
    expect(await getDb(ctx.db).select().from(expense)).toEqual([recorded]);
    expect(await getDb(ctx.db).select().from(product)).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(runFinding)).some(
        (finding) => finding.kind === "duplicate_lines",
      ),
    ).toBe(true);
    expect(result.status).toBe("researched_with_gaps");
    expect((await getDb(ctx.db).select().from(runTarget))[0]?.state).toBe(
      "unresolved",
    );
  });
});
