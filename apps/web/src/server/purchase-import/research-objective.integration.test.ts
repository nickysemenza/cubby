import { parseEntityId } from "@cubby/schemas/identifiers";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import {
  researchSourceMetadata,
  retainedResearchObservation,
} from "@cubby/schemas/research";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  financialTransaction,
  image,
  purchase,
  expense,
  entityAttachment,
  importSourceClaim,
  financialTransactionAllocation,
  importHunt,
  run,
  runTarget,
  runEvidence,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { startAccountSync } from "./account-sync";
import { startSelectedChargeRun } from "./charge-runs";
import { dispatchRunEvent } from "./dispatch";
import { dispatchImportHunts } from "./hunts";
import { submitReceiptEvidence } from "./receipt-evidence";
import { resolveImportResearch } from "./research-import";
import { researchServiceFor } from "./research-service";
import type { ResearchAssessmentInput } from "./research-support";
import { controlRun } from "./run-service";

// Real admission failures: account/history and receipt runs finish before doing
// work; selected charges lose their exact selection or unknown dates; retries
// drop objectives; changed receipt originals are accepted under a frozen claim.
function syntheticReceiptPdf() {
  const text =
    "BT /F1 12 Tf 40 700 Td (Synthetic objective shop receipt: 1 cobalt size-small annual service. Total USD 10.00. Date not stated.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe("durable research objective admission", () => {
  const ctx = withTestDb();
  async function fixture() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic objective member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic objective shop",
      website: "https://shop.example.test/account",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Synthetic objective account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
      browserSyncEnabled: true,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic objective card",
      ledgerPartyId: party.id,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
    });
    const events: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    async function hunt(state: string = "pending_browser") {
      const transaction = await insertWithShortcode(
        ctx.db,
        "financialTransaction",
        {
          accountId: card.id,
          kind: "purchase",
          status: "posted",
          amount: 12.34,
          merchant: "Synthetic objective shop",
          transactionDate: null,
          postedDate: "2026-09-15",
        },
      );
      const [row] = await getDb(ctx.db)
        .insert(importHunt)
        .values({
          ledgerPartyId: party.id,
          financialTransactionId: transaction.id,
          vendorId: vendor.id,
          vendorAccountId: account.id,
          state,
          dateFrom: "2026-09-01",
          dateTo: "2026-09-30",
        })
        .returning();
      if (!row) throw new Error("Synthetic hunt missing");
      return { row, transaction };
    }
    async function admitted(publicId: string) {
      const [row] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.shortcode, publicId));
      if (!row) throw new Error("Synthetic admitted Run missing");
      return row;
    }
    async function receiptScope(huntId: string) {
      const [selected] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, huntId));
      if (!selected?.receiptRunId)
        throw new Error("Synthetic receipt Run identity missing");
      const [scope] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, parseEntityId("run", selected.receiptRunId)));
      if (!scope) throw new Error("Synthetic receipt Run missing");
      return scope;
    }
    async function retainedReceipt() {
      const selected = await hunt("receipt_required");
      const bytes = syntheticReceiptPdf();
      const checksum = await sha256Hex(bytes);
      const photo = await insertWithShortcode(ctx.db, "image", {
        key: "images/synthetic-write-receipt.pdf",
        filename: "receipt.pdf",
        contentType: "application/pdf",
        size: bytes.byteLength,
        status: "UPLOADED",
        sha256: checksum,
      });
      await submitReceiptEvidence(
        ctx.db,
        {
          huntId: selected.row.id,
          imageId: photo.shortcode,
        },
        ctx.actor,
        queue,
      );
      const scope = await receiptScope(selected.row.id);
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, scope.id));
      if (!target) throw new Error("Synthetic receipt target missing");
      const stored = new Map<string, string>();
      const service = researchServiceFor(
        ctx.db,
        fromPartial<Env>({ R2_KEY_PREFIX: "synthetic-receipt-writes" }),
        scope.id,
        {
          readAttachment: async () => bytes,
          observations: {
            storage: {
              put: async (key, retained) => {
                stored.set(key, new TextDecoder().decode(retained));
              },
            },
          },
        },
      );
      await service.researchObserve(
        { workRef: target.id, action: { kind: "read" } },
        "synthetic-receipt-write-original",
      );
      const [evidence] = await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.targetId, target.id));
      if (!evidence) throw new Error("Synthetic original evidence missing");
      const originalAttachment = {
        attachmentRef: photo.id,
        filename: photo.filename,
        mimeType: photo.contentType,
        checksum,
        dataBase64: Buffer.from(bytes).toString("base64"),
      };
      const proposal = researchWorkResolve.parse({
        workRef: target.id,
        status: "verified",
        identity: {
          evidenceIds: [evidence.id],
          reasoning: "The selected original names this service and merchant.",
        },
        orders: [
          {
            vendorRef: vendor.shortcode,
            sourceRefs: [evidence.id],
            reasoning:
              "The retained original identifies this service; date is absent; price and quantity are printed.",
            candidate: {
              orderId: null,
              orderedAt: null,
              merchant: "Synthetic objective shop",
              currency: "USD",
              printedGrandTotal: 10,
              lines: [
                {
                  title: "cobalt size-small annual service",
                  amount: 10,
                  quantity: 1,
                  lineKind: "principal",
                },
              ],
              payments: [],
              allShipmentsDelivered: false,
            },
            productResolutions: [{ kind: "expense_only", lineIndex: 0 }],
            defaultTrade: "other",
          },
        ],
        detail:
          "A supported service acquisition retains its missing purchase date.",
      });
      const assess = vi.fn(async (input: ResearchAssessmentInput) => {
        const original = input.observations[0];
        expect(original?.content).toBe(JSON.stringify({ originalAttachment }));
        expect(original?.metadata).toMatchObject({
          imageId: photo.id,
          originalChecksum: checksum,
        });
        return {
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [0],
          rejected: [],
        };
      });
      return {
        selected,
        photo,
        bytes,
        checksum,
        scope,
        target,
        evidence,
        stored,
        originalAttachment,
        proposal,
        assess,
      };
    }
    const next = (runId: string) =>
      researchServiceFor(
        ctx.db,
        fromPartial<Env>({ R2_KEY_PREFIX: "synthetic-objectives" }),
        runId,
      ).researchNext({}, crypto.randomUUID());
    return {
      party,
      vendor,
      account,
      card,
      events,
      queue,
      hunt,
      admitted,
      retainedReceipt,
      receiptScope,
      next,
    };
  }

  it("starts account history as owned research work instead of completing an empty Run", async () => {
    const s = await fixture();
    const started = await startAccountSync(
      ctx.db,
      s.party.id,
      { vendorAccountId: s.account.shortcode },
      s.queue,
    );
    const admitted = await s.admitted(started.runId);
    expect(await s.next(admitted.id)).toMatchObject({
      status: "working",
      work: {
        kind: "account_history",
        account: { accountRef: s.account.shortcode },
      },
    });
    const [live] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, admitted.id));
    expect(live?.status).toBe("running");
    expect(live?.endedAt).toBeNull();
  });

  it("keeps an explicit historical range on the assigned research objective", async () => {
    const s = await fixture();
    const range = { from: "2025-01-01", to: "2025-12-31" };
    const started = await startAccountSync(
      ctx.db,
      s.party.id,
      { vendorAccountId: s.account.shortcode, backfill: range },
      s.queue,
    );
    const admitted = await s.admitted(started.runId);
    expect(await s.next(admitted.id)).toMatchObject({
      status: "working",
      work: { kind: "account_history", range },
    });
  });

  it("creates exactly selected charge objectives and preserves unknown transaction dates", async () => {
    const s = await fixture();
    const selected = await s.hunt();
    const unrelated = await s.hunt();
    const started = await startSelectedChargeRun(
      ctx.db,
      {
        vendorAccountId: s.account.shortcode,
        transactionIds: [selected.transaction.shortcode],
      },
      ctx.actor,
      s.queue,
    );
    const admitted = await s.admitted(started.runId);
    expect(await s.next(admitted.id)).toMatchObject({
      status: "working",
      work: {
        kind: "charge_hunt",
        charge: {
          transactionRef: selected.transaction.shortcode,
          transactionDate: null,
          postedDate: "2026-09-15",
        },
      },
    });
    const targets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, admitted.id));
    expect(targets.map((target) => target.sourceExternalKey)).toEqual([
      selected.row.id,
    ]);
    expect(JSON.stringify(await s.next(admitted.id))).not.toContain(
      unrelated.transaction.shortcode,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(financialTransaction)
        .where(eq(financialTransaction.id, selected.transaction.id)),
    ).toHaveLength(1);
  });

  it("freezes the original selected charge evidence and search range when live records are edited after admission", async () => {
    const s = await fixture();
    const selected = await s.hunt();
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ rawDescription: "SYNTHETIC SHOP ORIGINAL CARD CHARGE" })
      .where(eq(financialTransaction.id, selected.transaction.id));
    const started = await startSelectedChargeRun(
      ctx.db,
      {
        vendorAccountId: s.account.shortcode,
        transactionIds: [selected.transaction.shortcode],
      },
      ctx.actor,
      s.queue,
    );
    const admitted = await s.admitted(started.runId);
    const [assigned] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, admitted.id));
    if (!assigned) throw new Error("Synthetic frozen charge work missing");
    await getDb(ctx.db)
      .update(importHunt)
      .set({ dateFrom: "2026-07-01", dateTo: "2026-07-31" })
      .where(eq(importHunt.id, selected.row.id));
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({
        merchant: "Synthetic revised merchant",
        rawDescription: "SYNTHETIC REVISED CHARGE",
        amount: 98.76,
        transactionDate: "2026-07-10",
        postedDate: "2026-07-11",
      })
      .where(eq(financialTransaction.id, selected.transaction.id));
    expect(await s.next(admitted.id)).toMatchObject({
      status: "working",
      work: {
        kind: "charge_hunt",
        range: { from: "2026-09-01", to: "2026-09-30" },
        charge: {
          transactionRef: selected.transaction.shortcode,
          merchant: "Synthetic objective shop",
          amount: 12.34,
          rawDescription: "SYNTHETIC SHOP ORIGINAL CARD CHARGE",
          transactionDate: null,
          postedDate: "2026-09-15",
        },
      },
    });
    const [task] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, assigned.id));
    const [scope] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, admitted.id));
    expect(task?.targetFingerprint).toBe(assigned.targetFingerprint);
    expect(scope?.input).toEqual(admitted.input);
  });

  it("assigns the selected receipt original and checksum before dispatching", async () => {
    const s = await fixture();
    const selected = await s.hunt("receipt_required");
    const photo = await insertWithShortcode(ctx.db, "image", {
      key: `images/synthetic-receipt-${crypto.randomUUID()}.jpg`,
      filename: "synthetic-receipt.jpg",
      contentType: "image/jpeg",
      size: 100,
      status: "UPLOADED",
      sha256: "a".repeat(64),
    });
    await submitReceiptEvidence(
      ctx.db,
      { huntId: selected.row.id, imageId: photo.shortcode },
      ctx.actor,
      s.queue,
    );
    const [hunt] = await getDb(ctx.db)
      .select()
      .from(importHunt)
      .where(eq(importHunt.id, selected.row.id));
    if (!hunt?.receiptRunId) throw new Error("Synthetic receipt Run missing");
    expect(await s.next(hunt.receiptRunId)).toMatchObject({
      status: "working",
      work: {
        kind: "receipt_hunt",
        receipt: { imageRef: photo.shortcode, checksum: photo.sha256 },
      },
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, hunt.receiptRunId)),
    ).toHaveLength(1);
  });

  it("reads selected receipt originals as retained evidence without dispatching a browser or inventing an extraction", async () => {
    const s = await fixture();
    const selected = await s.hunt("receipt_required");
    const bytes = syntheticReceiptPdf();
    const checksum = await sha256Hex(bytes);
    const photo = await insertWithShortcode(ctx.db, "image", {
      key: "images/synthetic-objective-original.pdf",
      filename: "synthetic-objective-original.pdf",
      contentType: "application/pdf",
      size: bytes.byteLength,
      status: "UPLOADED",
      sha256: checksum,
    });
    await submitReceiptEvidence(
      ctx.db,
      { huntId: selected.row.id, imageId: photo.shortcode },
      ctx.actor,
      s.queue,
    );
    const [hunt] = await getDb(ctx.db)
      .select()
      .from(importHunt)
      .where(eq(importHunt.id, selected.row.id));
    if (!hunt?.receiptRunId)
      throw new Error("Synthetic selected receipt Run missing");
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, hunt.receiptRunId));
    if (!target) throw new Error("Synthetic receipt task missing");
    const readOriginal = vi.fn(async () => bytes);
    const stored = new Map<string, string>();
    const service = researchServiceFor(
      ctx.db,
      fromPartial<Env>({ R2_KEY_PREFIX: "synthetic-objectives" }),
      hunt.receiptRunId,
      {
        readAttachment: readOriginal,
        observations: {
          storage: {
            put: async (key, retained) => {
              stored.set(key, new TextDecoder().decode(retained));
            },
          },
        },
      },
    );
    const output = await service.researchObserve(
      { workRef: target.id, action: { kind: "read" } },
      "synthetic-selected-receipt-read",
    );
    expect(output).toMatchObject({
      originalAttachment: {
        checksum,
        mimeType: "application/pdf",
        dataBase64: Buffer.from(bytes).toString("base64"),
      },
    });
    expect(readOriginal).toHaveBeenCalledTimes(1);
    const evidence = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.targetId, target.id));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.kind).toBe("upload_evidence");
    expect(evidence[0]?.sourceMetadata).toMatchObject({
      imageId: photo.id,
      originalChecksum: checksum,
    });
    expect(stored.get(evidence[0]!.objectKey)).toContain(
      Buffer.from(bytes).toString("base64"),
    );
    expect(output).not.toHaveProperty("extraction");
  });

  it.each(["owned", "foreign", "changed"] as const)(
    "authorizes only the selected retained receipt original at the real writer boundary: %s",
    async (binding) => {
      const s = await fixture();
      const source = await s.retainedReceipt();
      if (binding === "changed")
        await getDb(ctx.db)
          .update(image)
          .set({ sha256: "f".repeat(64) })
          .where(eq(image.id, source.photo.id));
      if (binding === "foreign") {
        const other = await insertWithShortcode(ctx.db, "image", {
          key: "images/synthetic-unselected-receipt.pdf",
          filename: "receipt.pdf",
          contentType: "application/pdf",
          size: source.bytes.byteLength,
          status: "UPLOADED",
          sha256: source.checksum,
        });
        const content = JSON.stringify({
          originalAttachment: {
            ...source.originalAttachment,
            attachmentRef: other.id,
          },
        });
        source.stored.set(source.evidence.objectKey, content);
        const storedMetadata = z
          .object({
            ...researchSourceMetadata.shape,
            researchFingerprint: z.string(),
            research: retainedResearchObservation,
          })
          .parse(source.evidence.sourceMetadata);
        await getDb(ctx.db)
          .update(runEvidence)
          .set({
            checksum: await sha256Hex(content),
            sourceMetadata: {
              ...storedMetadata,
              imageId: other.id,
              attachmentRef: other.id,
            },
          })
          .where(eq(runEvidence.id, source.evidence.id));
      }
      const resolving = resolveImportResearch(
        ctx.db,
        {
          runId: source.scope.id,
          workRef: source.target.id,
          callId: `synthetic-receipt-authority-${binding}`,
          proposal: source.proposal,
        },
        {
          assess: source.assess,
          readEvidence: async (evidence) => {
            const content = source.stored.get(evidence.objectKey);
            if (!content) throw new Error("Synthetic source object missing");
            return content;
          },
        },
      );
      const outcome = await resolving.then(
        (value) => ({ value, error: null }),
        (error) => ({
          value: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const owned = binding === "owned";
      expect(String(outcome.error)).toMatch(
        owned ? /^null$/u : /receipt|evidence kind/i,
      );
      expect(outcome.value?.purchaseIds.length ?? 0).toBe(owned ? 1 : 0);
      expect(source.assess).toHaveBeenCalledTimes(owned ? 1 : 0);
      expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(
        owned ? 1 : 0,
      );
      expect(await getDb(ctx.db).select().from(expense)).toHaveLength(0);
      expect(
        await getDb(ctx.db).select().from(financialTransactionAllocation),
      ).toHaveLength(0);
      expect(
        await getDb(ctx.db).select().from(importSourceClaim),
      ).toMatchObject(
        owned
          ? [
              {
                kind: "receipt_photo",
                checksum: source.checksum,
              },
            ]
          : [],
      );
      expect(await getDb(ctx.db).select().from(entityAttachment)).toMatchObject(
        owned
          ? [
              {
                imageId: source.photo.id,
                entityKind: "purchase",
                role: "attachment",
                documentKind: "order_confirmation",
              },
            ]
          : [],
      );
      const [hunt] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, source.selected.row.id));
      expect(hunt?.state).toBe(
        owned ? "deferred_for_review" : "processing_receipt",
      );
    },
  );

  it("admits a vendor-unknown selected receipt as original research without a preclassified merchant", async () => {
    const s = await fixture();
    const selected = await s.hunt("receipt_required");
    await getDb(ctx.db)
      .update(importHunt)
      .set({ vendorId: null, vendorAccountId: null })
      .where(eq(importHunt.id, selected.row.id));
    const bytes = syntheticReceiptPdf();
    const photo = await insertWithShortcode(ctx.db, "image", {
      key: "images/synthetic-unknown-merchant.pdf",
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: bytes.byteLength,
      status: "UPLOADED",
      sha256: await sha256Hex(bytes),
    });
    await submitReceiptEvidence(
      ctx.db,
      { huntId: selected.row.id, imageId: photo.shortcode },
      ctx.actor,
      s.queue,
    );
    const scope = await s.receiptScope(selected.row.id);
    expect(scope.vendorId).toBeNull();
    expect(await s.next(scope.id)).toMatchObject({
      status: "working",
      work: { kind: "receipt_hunt", receipt: { imageRef: photo.shortcode } },
    });
  });

  it("dispatches bounded implicit financial hunts as explicit owned objectives without joining account history", async () => {
    const s = await fixture();
    const first = await s.hunt();
    const second = await s.hunt();
    expect(await dispatchImportHunts(ctx.db, s.queue)).toBe(2);
    const [admitted] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.vendorAccountId, s.account.id));
    if (!admitted) throw new Error("Synthetic hunt Run missing");
    expect(await s.next(admitted.id)).toMatchObject({
      status: "working",
      work: { kind: "charge_hunt" },
    });
    const targets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, admitted.id));
    expect(targets.map((target) => target.sourceExternalKey).sort()).toEqual(
      [first.row.id, second.row.id].sort(),
    );
  });

  it("restarts only unresolved selected charge objectives without replaying resolved targets", async () => {
    const s = await fixture();
    const resolved = await s.hunt();
    const unresolved = await s.hunt();
    const started = await startSelectedChargeRun(
      ctx.db,
      {
        vendorAccountId: s.account.shortcode,
        transactionIds: [
          resolved.transaction.shortcode,
          unresolved.transaction.shortcode,
        ],
      },
      ctx.actor,
      s.queue,
    );
    const original = await s.admitted(started.runId);
    await getDb(ctx.db)
      .update(importHunt)
      .set({ state: "resolved" })
      .where(eq(importHunt.id, resolved.row.id));
    await getDb(ctx.db)
      .update(runTarget)
      .set({ state: "completed", outcome: "verified", completedAt: new Date() })
      .where(
        and(
          eq(runTarget.runId, original.id),
          eq(runTarget.sourceExternalKey, resolved.row.id),
        ),
      );
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, original.id));
    const restarted = await controlRun(ctx.db, ctx.actor, {
      runPublicId: started.runId,
      action: "restart",
    });
    if (!("successorRunId" in restarted) || !restarted.successorRunId)
      throw new Error("Synthetic charge successor missing");
    const targets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, restarted.successorRunId));
    expect(targets.map((target) => target.sourceExternalKey)).toEqual([
      unresolved.row.id,
    ]);
    expect(await s.next(restarted.successorRunId)).toMatchObject({
      status: "working",
      work: {
        kind: "charge_hunt",
        charge: { transactionRef: unresolved.transaction.shortcode },
      },
    });
  });

  it("recovers an interrupted or refused objective handoff through the same successor dispatch identity", async () => {
    const s = await fixture();
    const started = await startAccountSync(
      ctx.db,
      s.party.id,
      { vendorAccountId: s.account.shortcode },
      s.queue,
    );
    const original = await s.admitted(started.runId);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, original.id));
    const input = { runPublicId: original.shortcode, action: "retry" as const };
    const admitted = await controlRun(ctx.db, ctx.actor, input);
    if (!("successorRunId" in admitted) || !admitted.successorRunId)
      throw new Error("Synthetic objective successor missing");
    const id = parseEntityId("run", admitted.successorRunId);
    const [successor] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, id));
    if (!successor?.dispatchEventId)
      throw new Error("Synthetic objective dispatch identity missing");
    const interrupted = await controlRun(ctx.db, ctx.actor, input);
    expect(interrupted).toMatchObject({
      created: false,
      successorRunId: id,
      dispatchRunId: id,
      dispatchEventId: successor.dispatchEventId,
    });
    await expect(
      dispatchRunEvent(
        ctx.db,
        {
          send: async () => {
            throw new Error("Synthetic queue refusal");
          },
        },
        {
          version: 1,
          type: "start_or_resume",
          runId: id,
          eventId: successor.dispatchEventId,
          purpose: "account_sync",
        },
      ),
    ).rejects.toThrow("Synthetic queue refusal");
    const refused = await controlRun(ctx.db, ctx.actor, input);
    expect(refused).toMatchObject({
      created: false,
      successorRunId: id,
      successorStatus: "dispatch_failed",
      dispatchRunId: id,
      dispatchEventId: successor.dispatchEventId,
    });
    await controlRun(ctx.db, ctx.actor, {
      runPublicId: successor.shortcode,
      action: "abort",
    });
    expect(await controlRun(ctx.db, ctx.actor, input)).not.toHaveProperty(
      "dispatchRunId",
    );
  });
  it("takes account dispatch admission before locking its Run", async () => {
    const s = await fixture();
    const started = await startAccountSync(
      ctx.db,
      s.party.id,
      { vendorAccountId: s.account.shortcode },
      s.queue,
    );
    const original = await s.admitted(started.runId);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "dispatch_failed", coordinatorStartedAt: null })
      .where(eq(run.id, original.id));
    let control: ReturnType<typeof controlRun> | undefined;
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${s.account.id}))`,
        );
        control = controlRun(ctx.db, ctx.actor, {
          runPublicId: original.shortcode,
          action: "retry_dispatch",
        });
        await vi.waitFor(
          async () => {
            const result = await getDb(ctx.db).execute(sql`SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
              AND objid::bigint = (hashtext(${s.account.id})::bigint & 4294967295)
          ) AS waiting`);
            expect(
              z.object({ waiting: z.boolean() }).parse(result.rows[0]).waiting,
            ).toBe(true);
          },
          { interval: 20, timeout: 5_000 },
        );
        await tx.execute(
          sql`SELECT "id" FROM "Run" WHERE "id" = ${original.id} FOR NO KEY UPDATE NOWAIT`,
        );
      });
    } finally {
      if (control) await control;
    }
  });
  it.each([
    { action: "restart", attempt: null },
    { action: "retry", attempt: 4 },
  ] as const)(
    "preserves unresolved account objectives and lineage through $action",
    async ({ action, attempt }) => {
      const s = await fixture();
      const started = await startAccountSync(
        ctx.db,
        s.party.id,
        { vendorAccountId: s.account.shortcode },
        s.queue,
      );
      const original = await s.admitted(started.runId);
      const parent = await insertWithShortcode(ctx.db, "run", {
        purpose: "account_sync",
        trigger: "manual",
        status: "completed",
        ledgerPartyId: s.party.id,
        actorUserId: ctx.actor.userId,
        actorName: original.actorName,
        actorEmail: original.actorEmail,
        actorLedgerPartyShortcode: original.actorLedgerPartyShortcode,
        actorLedgerPartyName: original.actorLedgerPartyName,
        actorLedgerPartyKind: original.actorLedgerPartyKind,
      });
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "needs_review",
          endedAt: new Date(),
          attempt,
          parentRunId: parent.id,
        })
        .where(eq(run.id, original.id));
      const restarted = await controlRun(ctx.db, ctx.actor, {
        runPublicId: started.runId,
        action,
      });
      if (!("successorRunId" in restarted) || !restarted.successorRunId)
        throw new Error("Synthetic successor missing");
      const [successor] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, restarted.successorRunId));
      expect(successor).toMatchObject({
        predecessorRunId: original.id,
        parentRunId: parent.id,
        attempt: attempt === null ? null : attempt + 1,
        cause: "retry",
        input: original.input,
      });
      expect(await s.next(restarted.successorRunId)).toMatchObject({
        status: "working",
        work: { kind: "account_history" },
      });
      const successors = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(
          and(
            eq(runTarget.runId, restarted.successorRunId),
            eq(runTarget.state, "pending"),
          ),
        );
      expect(successors).toHaveLength(1);
    },
  );

  it.each([
    { action: "restart", unknownVendor: false },
    { action: "retry", unknownVendor: false },
    { action: "retry", unknownVendor: true },
  ] as const)(
    "transfers unfinished receipt ownership through $action with unknownVendor=$unknownVendor",
    async ({ action, unknownVendor }) => {
      const s = await fixture();
      const source = await s.retainedReceipt();
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "needs_review",
          endedAt: new Date(),
        })
        .where(eq(run.id, source.scope.id));
      await getDb(ctx.db)
        .update(runTarget)
        .set({ state: "unresolved" })
        .where(eq(runTarget.id, source.target.id));
      if (unknownVendor) {
        await getDb(ctx.db)
          .update(run)
          .set({ vendorId: null, vendorAccountId: null })
          .where(eq(run.id, source.scope.id));
        await getDb(ctx.db)
          .update(importHunt)
          .set({ vendorId: null, vendorAccountId: null })
          .where(eq(importHunt.id, source.selected.row.id));
      }
      const restarted = await controlRun(ctx.db, ctx.actor, {
        runPublicId: source.scope.shortcode,
        action,
      });
      if (!("successorRunId" in restarted) || !restarted.successorRunId)
        throw new Error("Synthetic receipt successor missing");
      expect(await s.next(restarted.successorRunId)).toMatchObject({
        status: "working",
        work: {
          kind: "receipt_hunt",
          receipt: {
            imageRef: source.photo.shortcode,
            checksum: source.checksum,
          },
        },
      });
      const [hunt] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, source.selected.row.id));
      expect(hunt).toMatchObject({
        receiptRunId: restarted.successorRunId,
        receiptImageId: source.photo.id,
        state: "processing_receipt",
      });
      const [predecessorTarget] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, source.target.id));
      expect(predecessorTarget?.state).toBe("unresolved");
    },
  );

  it.each(["same", "changed"] as const)(
    "preserves accepted receipt evidence when a reviewed original is submitted again: %s",
    async (original) => {
      const s = await fixture();
      const source = await s.retainedReceipt();
      await resolveImportResearch(
        ctx.db,
        {
          runId: source.scope.id,
          workRef: source.target.id,
          callId: `synthetic-reviewed-receipt-${original}`,
          proposal: source.proposal,
        },
        {
          assess: source.assess,
          readEvidence: async (evidence) => {
            const content = source.stored.get(evidence.objectKey);
            if (!content) throw new Error("Synthetic receipt original missing");
            return content;
          },
        },
      );
      await getDb(ctx.db)
        .update(run)
        .set({ status: "needs_review", endedAt: new Date() })
        .where(eq(run.id, source.scope.id));
      const before = {
        claims: await getDb(ctx.db).select().from(importSourceClaim),
        evidence: await getDb(ctx.db).select().from(runEvidence),
        attachments: await getDb(ctx.db).select().from(entityAttachment),
        queued: s.events.length,
      };
      const bytes = new TextEncoder().encode(
        `${new TextDecoder().decode(source.bytes)}\n`,
      );
      const replacement =
        original === "changed"
          ? await insertWithShortcode(ctx.db, "image", {
              key: "images/synthetic-reviewed-receipt-refresh.pdf",
              filename: "receipt-refresh.pdf",
              contentType: "application/pdf",
              size: bytes.byteLength,
              status: "UPLOADED",
              sha256: await sha256Hex(bytes),
            })
          : source.photo;
      const submitted = await submitReceiptEvidence(
        ctx.db,
        {
          huntId: source.selected.row.id,
          imageId: replacement.shortcode,
        },
        ctx.actor,
        s.queue,
      );
      expect(submitted.queued).toBe(original === "changed");
      expect(s.events).toHaveLength(
        before.queued + (original === "changed" ? 1 : 0),
      );
      expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual(
        before.claims,
      );
      expect(await getDb(ctx.db).select().from(runEvidence)).toEqual(
        before.evidence,
      );
      expect(await getDb(ctx.db).select().from(entityAttachment)).toEqual(
        before.attachments,
      );
      let nextAttempt: number | null = null;
      if (original === "changed") {
        const attempt = source.scope.attempt;
        if (attempt === null)
          throw new Error("Synthetic source attempt missing.");
        nextAttempt = attempt + 1;
      }
      const nextScope = await s.receiptScope(source.selected.row.id);
      expect(nextScope).toMatchObject(
        original === "changed"
          ? {
              predecessorRunId: source.scope.id,
              cause: "evidence_changed",
              attempt: nextAttempt,
            }
          : { id: source.scope.id },
      );
      const next = original === "changed" ? await s.next(nextScope.id) : null;
      expect(JSON.stringify(next)).toContain(
        original === "changed" ? replacement.shortcode : "null",
      );
      expect(JSON.stringify(next)).toContain(
        original === "changed" ? replacement.sha256! : "null",
      );
    },
  );

  it("refreshes one durable Hunt source claim when a corrected no-ID receipt uniquely names its existing Purchase", async () => {
    const s = await fixture();
    const first = await s.retainedReceipt();
    const imported = await resolveImportResearch(
      ctx.db,
      {
        runId: first.scope.id,
        workRef: first.target.id,
        callId: "synthetic-initial-receipt-claim",
        proposal: first.proposal,
      },
      {
        assess: first.assess,
        readEvidence: async (evidence) => {
          const content = first.stored.get(evidence.objectKey);
          if (!content) throw new Error("Synthetic initial receipt missing");
          return content;
        },
      },
    );
    const [existingPurchase] = await getDb(ctx.db)
      .select()
      .from(purchase)
      .where(
        eq(purchase.id, parseEntityId("purchase", imported.purchaseIds[0]!)),
      );
    const [initialClaim] = await getDb(ctx.db).select().from(importSourceClaim);
    if (!existingPurchase || !initialClaim)
      throw new Error("Synthetic receipt claim missing");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "needs_review", endedAt: new Date() })
      .where(eq(run.id, first.scope.id));
    const bytes = new TextEncoder().encode(
      new TextDecoder().decode(first.bytes).replace("USD 10.00", "USD 12.00"),
    );
    const checksum = await sha256Hex(bytes);
    const photo = await insertWithShortcode(ctx.db, "image", {
      key: "images/synthetic-corrected-price-receipt.pdf",
      filename: "corrected-receipt.pdf",
      contentType: "application/pdf",
      size: bytes.byteLength,
      status: "UPLOADED",
      sha256: checksum,
    });
    await submitReceiptEvidence(
      ctx.db,
      { huntId: first.selected.row.id, imageId: photo.shortcode },
      ctx.actor,
      s.queue,
    );
    const scope = await s.receiptScope(first.selected.row.id);
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, scope.id));
    if (!target) throw new Error("Synthetic refreshed receipt work missing");
    const stored = new Map<string, string>();
    const service = researchServiceFor(
      ctx.db,
      fromPartial<Env>({ R2_KEY_PREFIX: "synthetic-receipt-refresh" }),
      scope.id,
      {
        readAttachment: async () => bytes,
        observations: {
          storage: {
            put: async (key, content) => {
              stored.set(key, new TextDecoder().decode(content));
            },
          },
        },
      },
    );
    await service.researchObserve(
      { workRef: target.id, action: { kind: "read" } },
      "synthetic-corrected-receipt-original",
    );
    const [evidence] = await getDb(ctx.db)
      .select()
      .from(runEvidence)
      .where(eq(runEvidence.targetId, target.id));
    if (!evidence) throw new Error("Synthetic refreshed original missing");
    const previousOrder = first.proposal.orders[0]!;
    const proposal = researchWorkResolve.parse({
      ...first.proposal,
      workRef: target.id,
      identity: {
        evidenceIds: [evidence.id],
        reasoning:
          "The corrected original names the same unique service acquisition.",
      },
      orders: [
        {
          ...previousOrder,
          purchaseRef: existingPurchase.shortcode,
          sourceRefs: [evidence.id],
          candidate: {
            ...previousOrder.candidate,
            printedGrandTotal: 12,
            lines: previousOrder.candidate.lines.map((line) => ({
              ...line,
              amount: 12,
            })),
          },
        },
      ],
    });
    const assess = vi.fn(async (input: ResearchAssessmentInput) => {
      expect(input.observations[0]?.metadata).toMatchObject({
        imageId: photo.id,
        originalChecksum: checksum,
      });
      expect(input.observations[0]?.content).toBe(
        JSON.stringify({
          originalAttachment: {
            attachmentRef: photo.id,
            filename: photo.filename,
            mimeType: photo.contentType,
            checksum,
            dataBase64: Buffer.from(bytes).toString("base64"),
          },
        }),
      );
      return {
        identityVerified: true,
        acceptedFacts: [],
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedOrders: [0],
        rejected: [],
      };
    });
    const refreshed = await resolveImportResearch(
      ctx.db,
      {
        runId: scope.id,
        workRef: target.id,
        callId: "synthetic-refreshed-receipt-claim",
        proposal,
      },
      {
        assess,
        readEvidence: async (row) => {
          const content = stored.get(row.objectKey);
          if (!content)
            throw new Error("Synthetic refreshed receipt original missing");
          return content;
        },
      },
    );
    expect(refreshed.purchaseIds).toEqual([existingPurchase.id]);
    expect(await getDb(ctx.db).select().from(purchase)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toMatchObject([
      {
        id: initialClaim.id,
        kind: "receipt_photo",
        externalKey: `hunt:${first.selected.row.id}`,
        firstRunId: first.scope.id,
        lastRunId: scope.id,
        checksum,
      },
    ]);
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toHaveLength(
      1,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(runEvidence)
        .where(eq(runEvidence.id, first.evidence.id)),
    ).toEqual([first.evidence]);
    expect(await getDb(ctx.db).select().from(expense)).toHaveLength(0);
    expect(
      await getDb(ctx.db).select().from(financialTransactionAllocation),
    ).toHaveLength(0);
  });
});
