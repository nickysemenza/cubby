import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ActorContext } from "@cubby/schemas/context";
import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import {
  commitPurchaseImportInput,
  preparePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import {
  buildKernelContext,
  createFixtureWithContext,
} from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import type { Database } from "~/server/db";
import * as schema from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import {
  approvePhotoGroupProposals,
  listPhotoGroupProposals,
  proposePhotoGroups,
} from "~/server/photo-import-run/proposals";
import { productionOrderMailAttachmentStorage } from "~/server/purchase-import/gmail/attachment-storage";
import { normalizeMessage } from "~/server/purchase-import/gmail/normalize";
import { persistGmailSyncResult } from "~/server/purchase-import/gmail/persistence";
import { processOrderMails } from "~/server/purchase-import/gmail/process";
import {
  decideOrderMailCandidate,
  listVendorOrderMail,
} from "~/server/purchase-import/gmail/review";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { effectiveExpenseSpendingCategorySql } from "~/server/repo/expense-category-resolution";
import {
  commitFinancialBooking,
  previewFinancialBooking,
} from "~/server/repo/financial-booking";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
} from "~/server/repo/image-processing";
import { assignImageProcessingExecutor } from "~/server/repo/image-processing-history";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "~/server/repo/member-login";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { imageDescriptionInputFingerprint } from "~/server/services/image-description.service";
import { attachFileToEntity } from "~/server/services/image-storage.service";
import { productionPhotoImportCommitPorts } from "~/server/services/photo-import-commit.service";
import { stagePhotoImport } from "~/server/services/photo-import-stage.service";
import { commitStatementCsv } from "~/server/statement-csv-import";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import { resolveRunFinding } from "./findings";
import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import {
  finalizePhotoRun,
  loadRunDetail,
  startOrResumeRun,
  startPhotoInventoryRun,
} from "./run-service";

/**
 * Every arrival order of the four evidence sources must converge on one
 * Purchase, Product, Expense, settlement, inventory row and linked mail. The
 * browser spec keeps a 4-order Latin square for the UI boundaries; this file
 * keeps all 24 orders against the same server writers those UI steps dispatch.
 */
const EVIDENCE_SOURCES = ["gmail", "retailer", "photo", "csv"] as const;
type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
function sourcePermutations(
  sources: readonly EvidenceSource[],
): EvidenceSource[][] {
  if (!sources.length) return [[]];
  return sources.flatMap((source) =>
    sourcePermutations(sources.filter((other) => other !== source)).map(
      (tail) => [source, ...tail],
    ),
  );
}

const photoFixture = (kind: "shirt" | "label") =>
  readFileSync(
    fileURLToPath(
      new URL(
        `../../../tests/e2e/fixtures/synthetic-wardrobe-${kind}.png`,
        import.meta.url,
      ),
    ),
  );

async function ensureMember(db: Database, actor: ActorContext) {
  const existing = await currentMemberLedgerParty(db, actor);
  if (existing) return existing;
  const party = await createFixtureWithContext(
    buildKernelContext(db, actor.userId),
    "ledgerParty",
    buildEntity("ledgerParty", {
      name: "Synthetic reviewer",
      kind: "member",
    }),
  );
  await setMemberLoginParty(
    db,
    actor.userId,
    parseShortcodeFor("ledgerParty", party.id),
    actor,
  );
  const member = await currentMemberLedgerParty(db, actor);
  if (!member) throw new Error("Reviewer member binding missing");
  return member;
}

/** Only account, vendor, location and category prerequisites are fixtures.
 * Every economic record and observation enters through an import writer. */
async function createConvergenceHarness(
  db: Database,
  actor: ActorContext,
  token: string,
) {
  const database = getDb(db);
  const kernel = buildKernelContext(db, actor.userId);
  const member = await ensureMember(db, actor);
  const name = `Synthetic evidence ${token}`;
  const productName = `${name} crew shirt`;
  const orderId = `SYN-ORDER-${token}`;
  const host = `shop-${token}.example.test`;
  const sender = `orders@${host}`;
  const messageId = `synthetic-message-${token}`;
  const vendor = await createFixtureWithContext(
    kernel,
    "vendor",
    buildEntity("vendor", {
      name,
      website: `https://${host}`,
      browserDomains: [host],
      orderEmailSenders: [sender],
      orderEvidence: "online_account",
    }),
  );
  const account = await createFixtureWithContext(
    kernel,
    "vendorAccount",
    buildEntity("vendorAccount", {
      label: `${name} retailer`,
      vendorId: vendor.id,
      ledgerPartyId: member.shortcode,
    }),
  );
  const card = await createFixtureWithContext(
    kernel,
    "financialAccount",
    buildEntity("financialAccount", {
      name: `${name} card`,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: member.shortcode,
      sourceAliases: [
        { source: "monarch", alias: `${name} Visa`, externalAccountId: null },
      ],
    }),
  );
  const location = await createFixtureWithContext(
    kernel,
    "location",
    buildEntity("location", { name: `${name} drawer`, type: "drawer" }),
  );
  const category = await createFixtureWithContext(
    kernel,
    "spendingCategory",
    buildEntity("spendingCategory", {
      name: `${name} clothing`,
      evidenceExpectation: "required",
      productExpectation: "required",
    }),
  );
  const productCategory = await createFixtureWithContext(
    kernel,
    "productCategory",
    buildEntity("productCategory", {
      name: `${name} apparel`,
      spendingCategoryMode: "mapped",
      spendingCategoryId: category.id,
    }),
  );
  const vendorId = await resolveOrThrow(db, "vendor", vendor.id);
  const accountId = await resolveOrThrow(db, "vendorAccount", account.id);
  const cardId = await resolveOrThrow(db, "financialAccount", card.id);
  let bookedPurchaseCode: string | undefined;
  let retailerDone = false;
  let productCode: string | undefined;
  const retailerInput = {
    orderId,
    orderedAt: "2026-09-10T12:00:00.000Z",
    merchant: name,
    currency: "USD",
    printedGrandTotal: 42.5,
    lines: [
      {
        title: productName,
        amount: 42.5,
        lineKind: "principal",
        identifiers: { sku: `SYN-SKU-${token}` },
      },
    ],
    payments: [],
    allShipmentsDelivered: true,
  };
  const csv = `Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id\n2026-09-12,${name},Clothing,${name} Visa,SYNTHETIC ORDER ${token},,-42.50,${token}-posted`;

  /** Mirrors the product page's category PATCH, which goes through the kernel. */
  const readProduct = async () => {
    const [found] = await database
      .select({
        shortcode: schema.product.shortcode,
        categoryId: schema.product.categoryId,
      })
      .from(schema.product)
      .where(
        and(eq(schema.product.name, productName), notDeleted(schema.product)),
      )
      .limit(1);
    if (found && found.categoryId === null)
      await executeEntity(kernel, {
        action: "update",
        entity: "product",
        id: parseShortcodeFor("product", found.shortcode),
        data: {
          categoryId: parseShortcodeFor("productCategory", productCategory.id),
        },
      });
    productCode = found?.shortcode;
    return productCode;
  };

  async function gmail() {
    // Synthetic provider payload passes the real MIME normalization and cursor
    // persistence boundary. Only the classifier's model response is supplied.
    const normalized = normalizeMessage(`synthetic-mailbox-${token}`, {
      id: messageId,
      threadId: `synthetic-thread-${token}`,
      historyId: "1",
      internalDate: String(Date.parse("2026-09-10T12:30:00Z")),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: sender },
          { name: "Subject", value: `Order ${orderId}` },
        ],
        body: {
          data: Buffer.from(
            `Order ${orderId} placed. Total USD 42.50.`,
          ).toString("base64url"),
        },
      },
    });
    await persistGmailSyncResult(db, {
      ledgerPartyId: member.id,
      advanceCursor: false,
      result: {
        mode: "bootstrap",
        reason: "first_sync",
        cursor: { historyId: "1" },
        messages: [normalized.mail],
        attachments: normalized.attachments,
        events: [],
      },
    });
    await processOrderMails(db, [normalized.mail.messageId], [], {
      classify: async () => ({
        events: [
          {
            event: "placed",
            orderId,
            amount: 42.5,
            currency: "USD",
            occurredAt: "2026-09-10T12:00:00.000Z",
          },
        ],
      }),
      attachFile: attachFileToEntity,
      attachmentStorage: productionOrderMailAttachmentStorage,
    });
  }

  async function retailer() {
    const html = `<main><h1>${orderId}</h1><p data-total="42.50">USD 42.50</p><p data-item="${productName}" data-sku="SYN-SKU-${token}">${productName}</p></main>`;
    const run = await startOrResumeRun(db, {
      ledgerPartyId: member.id,
      vendorAccountId: accountId,
      trigger: "manual",
    });
    const checksum = createHash("sha256").update(html).digest("hex");
    const prepareOperationId = `prepare:${token}`;
    const stableOrderId = `order:${token}`;
    const stableLineId = `line:${token}`;
    await preparePurchaseImport(
      db,
      preparePurchaseImportInput.parse({
        _runExecution: {
          runId: run.id,
          operationId: prepareOperationId,
          itemOperationIds: [`item:${token}`],
        },
        orders: [
          {
            targetPurchaseId: bookedPurchaseCode,
            stableOrderId,
            itemOperationId: `item:${token}`,
            source: {
              kind: "browser_order",
              externalKey: `history:${orderId}`,
              checksum,
            },
            evidenceChecksum: checksum,
            extractionRevision: "synthetic-browser@1",
            extraction: { status: "ready", candidate: retailerInput },
            lineIds: [stableLineId],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      }),
      actor,
    );
    await readProduct();
    const committed = await commitPurchaseImport(
      db,
      commitPurchaseImportInput.parse({
        _runExecution: { runId: run.id, operationId: `commit:${token}` },
        prepareOperationId,
        defaultTrade: "other",
        resolutions: [
          {
            stableOrderId,
            stableLineId,
            resolution: productCode
              ? { kind: "existing", productId: productCode }
              : { kind: "new" },
          },
        ],
      }),
      actor,
    );
    expect(committed.items[0]?.outcome).toMatch(/created|updated|replayed/);
    if (bookedPurchaseCode) {
      // The Run page's "Apply fix": the reviewed replacement of the booked
      // aggregate line, submitted with the fingerprint the page displayed.
      const detail = await loadRunDetail(db, run.publicId);
      const replacements = detail.findings.filter(
        (finding) =>
          finding.status === "open" &&
          finding.proposedFix?.kind === "replace_aggregate_line" &&
          finding.proposedFix.reviewSnapshot,
      );
      expect(replacements).toHaveLength(1);
      const [finding] = replacements;
      const fix = finding?.proposedFix;
      if (fix?.kind !== "replace_aggregate_line" || !fix.reviewSnapshot)
        throw new Error("Expected a reviewed aggregate replacement");
      expect(fix.reviewSnapshot.amount).toBe(42.5);
      const resolved = await resolveRunFinding(
        db,
        {
          id: finding!.id,
          action: "apply",
          reviewedFingerprint: fix.reviewSnapshot.fingerprint,
        },
        actor,
      );
      expect(resolved.status).toBe("applied");
      const after = await loadRunDetail(db, run.publicId);
      expect(after.findings.find((row) => row.id === finding!.id)?.status).toBe(
        "applied",
      );
    }
    retailerDone = true;
    await readProduct();
  }

  async function photo() {
    const run = await startPhotoInventoryRun(db, {
      actorUserId: actor.userId,
      notes: `Synthetic occurrence ${token}`,
    });
    const runId = run.publicId;
    const photos = (["shirt", "label"] as const).map((kind, index) => {
      const bytes = photoFixture(kind);
      return {
        bytes,
        clientId: `${token}-${kind}`,
        filename: `${token}-${kind}.png`,
        contentType: "image/png" as const,
        size: bytes.length,
        width: 640,
        height: 640,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        position: index,
      };
    });
    const staged = await stagePhotoImport(db, {
      runId,
      items: photos.map(({ bytes: _bytes, position: _position, ...item }) => ({
        ...item,
        allowExactReuse: false,
      })),
    });
    const finalized = staged.items.map((item) => {
      if (item.kind !== "upload")
        throw new Error("Expected new upload for synthetic photo");
      const source = photos.find((entry) => entry.clientId === item.clientId);
      if (!source) throw new Error("Missing synthetic bytes");
      return {
        imageId: item.imageId,
        sha256: source.sha256,
        width: source.width,
        height: source.height,
        position: source.position,
      };
    });
    // The uploaded object is the only seam: R2 reads return the fixture bytes
    // the browser PUT, and real image inspection hashes and measures them.
    const bytesByKey = new Map<string, Uint8Array<ArrayBuffer>>();
    for (const [index, entry] of finalized.entries()) {
      const [row] = await database
        .select({ key: schema.image.key })
        .from(schema.image)
        .where(eq(schema.image.shortcode, entry.imageId));
      if (!row) throw new Error("Staged image row missing");
      bytesByKey.set(row.key, Uint8Array.from(photos[index]!.bytes));
    }
    const result = await finalizePhotoRun(
      db,
      { runId, images: finalized },
      actor,
      {
        ...productionPhotoImportCommitPorts,
        getObject: async (key: string) =>
          new Response(bytesByKey.get(key) ?? null, {
            status: bytesByKey.has(key) ? 200 : 404,
          }),
      },
    );
    expect(result.finalized).toHaveLength(2);
    const imageIds = await Promise.all(
      finalized.map((entry) => resolveOrThrow(db, "image", entry.imageId)),
    );
    const jobs = await database
      .select()
      .from(schema.imageProcessingJob)
      .where(
        and(
          inArray(schema.imageProcessingJob.imageId, imageIds),
          eq(schema.imageProcessingJob.kind, "describe_image"),
        ),
      );
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      // Only the external model response is synthetic. The uploaded-byte hash,
      // lease, executor and completion fences use the real processing writers.
      const claimed = await claimImageProcessingJob(db, {
        jobId: job.id,
        kinds: ["describe_image"],
        leaseMs: 60_000,
      });
      if (!claimed) throw new Error("Synthetic description lease refused");
      const provider = providerFor(IMAGE_DESCRIPTION_FEATURE.model);
      expect(
        await assignImageProcessingExecutor(db, {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
          executor: {
            kind: "cloud",
            deviceId: null,
            name: provider,
            platform: "cloud",
            appVersion: null,
            osVersion: null,
          },
        }),
      ).toBeTruthy();
      const completion = await completeImageProcessingJob(db, {
        result: {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: "describe_image",
            status: "completed",
            description: {
              description: `Synthetic own-item evidence for ${productName}`,
              claims: [],
              cutoutEligibility: "ineligible",
            },
            runtime: {
              platform: "cloud",
              model: IMAGE_DESCRIPTION_FEATURE.model,
            },
          },
        },
        cloudAnalysis: {
          provider,
          model: IMAGE_DESCRIPTION_FEATURE.model,
          promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
          resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
          inputFingerprint: imageDescriptionInputFingerprint({
            sourceContentHash: claimed.sourceContentHash,
            contentType: claimed.originalContentType,
            provider,
            model: IMAGE_DESCRIPTION_FEATURE.model,
          }),
        },
        runtime: {
          provider,
          model: IMAGE_DESCRIPTION_FEATURE.model,
          feature: "image-description",
        },
      });
      expect(completion.adopted).toBe(true);
    }

    await readProduct();
    await proposePhotoGroups(db, {
      runId,
      groups: [
        {
          groupKey: "shirt",
          images: finalized.map((entry, index) => ({
            id: entry.imageId,
            purpose: index ? "label" : "item",
          })),
          product: productCode
            ? { kind: "existing", existingId: productCode }
            : {
                kind: "create",
                create: {
                  name: productName,
                  manufacturer: name,
                  categoryId: productCategory.id,
                },
              },
          inventory: {
            locationId: location.id,
            quantity: 1,
            ownershipMode: "person",
            ownerPartyId: member.shortcode,
          },
          evidence:
            "Synthetic own-item and label photos; identity explicitly reviewed.",
        },
      ],
    });
    // "Approve 1 selected item" sends the revision the review page loaded.
    const loaded = await listPhotoGroupProposals(db, runId);
    const approved = await approvePhotoGroupProposals(
      db,
      {
        runId,
        groupKeys: ["shirt"],
        expectedRevisions: loaded.proposals.map((proposal) => ({
          groupKey: proposal.groupKey,
          updatedAt: proposal.updatedAt,
        })),
      },
      actor,
    );
    expect(approved.results).toEqual([
      { groupKey: "shirt", outcome: "committed" },
    ]);
    const review = await listPhotoGroupProposals(db, runId);
    expect(
      review.proposals.filter((proposal) => proposal.state === "proposed"),
    ).toHaveLength(0);
    expect(review.proposals).toHaveLength(1);
    expect(review.unassignedImageIds).toEqual([]);
    productCode = review.proposals[0]?.committedProduct?.id;
    expect(productCode).toBeTruthy();
  }

  async function statement() {
    // The /statement-rows/import page's "Save rows and create 1 reviewed
    // transactions" dispatches statementRow.commitCsv with the chosen kind.
    const committed = await commitStatementCsv(db, actor, {
      fileName: `${token}.csv`,
      text: csv,
      selected: [{ key: "1", kind: "purchase" }],
    });
    expect(committed.transactions).toBe(1);
    const transaction = await database.query.financialTransaction.findFirst({
      where: and(
        eq(schema.financialTransaction.accountId, cardId),
        notDeleted(schema.financialTransaction),
      ),
    });
    if (!transaction) throw new Error("Imported statement transaction missing");
    const receipt = retailerDone
      ? await database.query.purchase.findFirst({
          where: and(
            eq(schema.purchase.vendorId, vendorId),
            eq(schema.purchase.orderId, orderId),
            notDeleted(schema.purchase),
          ),
        })
      : undefined;
    if (retailerDone && !receipt)
      throw new Error("Reviewed retailer Purchase missing");
    const review = await previewFinancialBooking(
      db,
      financialBookingInput.parse({
        transactionId: transaction.shortcode,
        purchaseId: receipt?.shortcode,
        vendorId: vendor.id,
        spendingCategoryId: null,
        trade: "other",
      }),
    );
    expect(review.action).toBe(receipt ? "link_existing" : "create_aggregate");
    const booked = await commitFinancialBooking(db, review, actor);
    bookedPurchaseCode = booked.purchaseId;
    expect(booked.expenseId === null).toBe(Boolean(receipt));
  }

  async function settle() {
    const [purchase] = await database
      .select()
      .from(schema.purchase)
      .where(
        and(
          eq(schema.purchase.vendorId, vendorId),
          eq(schema.purchase.orderId, orderId),
          notDeleted(schema.purchase),
        ),
      );
    if (!purchase) throw new Error("Imported settlement evidence missing");
    // The vendor page's order-mail "Link" for the exact-order candidate.
    const worklist = await listVendorOrderMail(db, { vendorId: vendor.id });
    const event = worklist.items
      .flatMap((item) => item.events)
      .find((row) => row.orderId === orderId);
    if (!event) throw new Error("Order mail event missing from worklist");
    const candidate = event.candidates.find(
      (row) => row.purchaseId === purchase.shortcode,
    );
    expect(candidate?.decision).not.toBe("linked");
    const decision = await decideOrderMailCandidate(
      db,
      {
        eventId: event.id,
        purchaseId: purchase.shortcode,
        decision: "linked",
        evidenceChecksum: event.evidenceChecksum,
      },
      actor,
    );
    expect(decision).toMatchObject({
      purchaseId: purchase.shortcode,
      decision: "linked",
    });
    expect(purchase.shortcode).toBe(bookedPurchaseCode);
    return { purchase, productCode };
  }

  async function projection() {
    const { rows } = await database.execute(sql`
      SELECT
        (SELECT count(*)::int FROM "Purchase" WHERE "vendorId" = ${vendorId} AND "orderId" = ${orderId} AND "deletedAt" IS NULL) AS purchases,
        (SELECT count(*)::int FROM "Product" WHERE name = ${productName} AND "deletedAt" IS NULL) AS products,
        (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS expenses,
        (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" JOIN "Product" product ON product.id = e."productId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL AND product.name = ${productName} AND product."deletedAt" IS NULL) AS "productLines",
        (SELECT count(*)::int FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" t ON t.id = a."transactionId" JOIN "Purchase" p ON p.id = a."purchaseId" WHERE t."accountId" = ${cardId} AND a."deletedAt" IS NULL AND t."deletedAt" IS NULL AND p."vendorId" = ${vendorId} AND p."orderId" = ${orderId} AND p."deletedAt" IS NULL) AS "settledPurchases",
        (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" JOIN "SpendingCategory" c ON c.id = ${effectiveExpenseSpendingCategorySql("e")} WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL AND c.shortcode = ${category.id} AND c."deletedAt" IS NULL) AS "categorizedExpenses",
        (SELECT round(sum(e.cost) * 100)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS spend,
        (SELECT count(*)::int FROM "FinancialTransaction" WHERE "accountId" = ${cardId} AND "deletedAt" IS NULL) AS transactions,
        (SELECT round(sum(a.amount) * 100)::int FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" t ON t.id = a."transactionId" WHERE t."accountId" = ${cardId} AND a."deletedAt" IS NULL AND t."deletedAt" IS NULL) AS settlement,
        (SELECT count(*)::int FROM "InventoryEntry" i JOIN "Product" p ON p.id = i."productId" WHERE p.name = ${productName} AND i."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS inventory,
        (SELECT sum(i."amountValue")::int FROM "InventoryEntry" i JOIN "Product" p ON p.id = i."productId" WHERE p.name = ${productName} AND i."deletedAt" IS NULL AND p."deletedAt" IS NULL AND i."ownershipMode" = 'person' AND i."ownerLedgerPartyId" = ${member.id}) AS "ownedQuantity",
        (SELECT count(*)::int FROM "StatementRow" WHERE "accountDescriptor" = ${`${name} Visa`} AND "deletedAt" IS NULL) AS observations,
        (SELECT count(*)::int FROM "StatementRow" s JOIN "EntityExternalId" x ON x.source = s.source AND x."externalId" = s."externalId" AND x.kind = 'settlement_ref' AND x."deletedAt" IS NULL JOIN "FinancialTransaction" t ON t.id = x."entityId" AND t."deletedAt" IS NULL WHERE s."accountDescriptor" = ${`${name} Visa`} AND s."deletedAt" IS NULL) AS "matchedObservations",
        (SELECT count(*)::int FROM "OrderMail" WHERE "messageId" = ${messageId}) AS mail,
        (SELECT count(*)::int FROM "OrderMailCandidateDecision" d JOIN "OrderMailEvent" e ON e.id = d."eventId" JOIN "OrderMail" m ON m.id = e."orderMailId" WHERE m."messageId" = ${messageId} AND d.decision = 'linked') AS "linkedMail"
    `);
    return rows[0];
  }

  /** What the product page's #images and #labels sections render. */
  async function productPhotos(productShortcode: string) {
    const { rows } = await database.execute(sql`
      SELECT i.filename, a.purpose
      FROM "EntityAttachment" a
      JOIN "Image" i ON i.id = a."imageId" AND i."deletedAt" IS NULL
      JOIN "Product" p ON p.id = a."entityId"
      WHERE p.shortcode = ${productShortcode} AND a."deletedAt" IS NULL
      ORDER BY i.filename
    `);
    return rows;
  }

  return {
    sources: { gmail, retailer, photo, csv: statement },
    settle,
    projection,
    productPhotos,
    productName,
    orderId,
    async openFindingCount() {
      const { rows } = await database.execute(sql`
        SELECT count(*)::int AS count FROM "RunFinding" f
        JOIN "Purchase" p ON p.id = f."entityId"
        WHERE p."vendorId" = ${vendorId} AND f.status = 'open'
      `);
      return Number(rows[0]?.count);
    },
  };
}

// Each permutation drives four writers end to end (~2s on CI) and the last
// one has run 6–11s, so the 10s default flakes on slower runners.
describe("import order convergence", { timeout: 30_000 }, () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;

  beforeEach(async () => {
    // Background publishes are captured, not run inline: processing and
    // enrichment must not reach a model while the writers under test run.
    queue = captureBackgroundQueue();
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
  });
  afterEach(() => queue.restore());

  it.each(sourcePermutations(EVIDENCE_SOURCES).map((order) => [order]))(
    "Gmail, retailer, own photos and statement converge: %j",
    async (order) => {
      const token = `order-${order.join("-")}`;
      const harness = await createConvergenceHarness(ctx.db, ctx.actor, token);
      // The Problems overview samples twelve findings. A Run must retain its
      // reviewed action after earlier receipt arrivals fill that sample.
      const earlierRetailerRuns =
        order.join(",") === "csv,photo,retailer,gmail" ? 13 : 0;
      for (let index = 0; index < earlierRetailerRuns; index++) {
        const earlier = await createConvergenceHarness(
          ctx.db,
          ctx.actor,
          `${token}-earlier-${index}`,
        );
        await earlier.sources.retailer();
        expect(await earlier.openFindingCount()).toBeGreaterThanOrEqual(1);
      }
      for (const source of order) await harness.sources[source]();
      const result = await harness.settle();
      expect(await harness.projection()).toEqual({
        purchases: 1,
        products: 1,
        expenses: 1,
        categorizedExpenses: 1,
        productLines: 1,
        settledPurchases: 1,
        spend: 4250,
        transactions: 1,
        settlement: 4250,
        inventory: 1,
        ownedQuantity: 1,
        observations: 1,
        matchedObservations: 1,
        mail: 1,
        linkedMail: 1,
      });
      expect(result.purchase.orderId).toBe(harness.orderId);
      if (!result.productCode) throw new Error("No reviewed Product identity");
      const [product] = await getDb(ctx.db)
        .select({ name: schema.product.name })
        .from(schema.product)
        .where(eq(schema.product.shortcode, result.productCode));
      expect(product?.name).toBe(harness.productName);
      expect(await harness.productPhotos(result.productCode)).toEqual([
        { filename: `${token}-label.png`, purpose: "label" },
        { filename: `${token}-shirt.png`, purpose: "item" },
      ]);
    },
  );
});
