import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { financialAccountCreateInput } from "@cubby/schemas/financial-account";
import {
  financialBookingPreview,
  financialBookingResult,
} from "@cubby/schemas/financial-booking";
import { spendingCategoryCreateInput } from "@cubby/schemas/spending-category";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { ledgerPartyCreateInput } from "@cubby/schemas/ledger-party";
import { locationCreateInput } from "@cubby/schemas/location";
import {
  commitPurchaseImportInput,
  preparePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { photoRunReviewResponse } from "@cubby/schemas/photo-import-run";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { vendorAccountCreateInput } from "@cubby/schemas/vendor-account";
import type { Page } from "@playwright/test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
} from "~/server/repo/image-processing";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { assignImageProcessingExecutor } from "~/server/repo/image-processing-history";
import { imageDescriptionInputFingerprint } from "~/server/services/image-description.service";
import { photoImportContract } from "~/contracts/photo-import.contract";
import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "~/server/repo/member-login";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { startOrResumeRun } from "~/server/purchase-import/run-service";
import {
  preparePurchaseImport,
  commitPurchaseImport,
} from "~/server/purchase-import/import-orders";
import { persistGmailSyncResult } from "~/server/purchase-import/gmail/persistence";
import { normalizeMessage } from "~/server/purchase-import/gmail/normalize";
import { processOrderMails } from "~/server/purchase-import/gmail/process";
import { productionOrderMailAttachmentStorage } from "~/server/purchase-import/gmail/attachment-storage";
import { attachFileToEntity } from "~/server/services/image-storage.service";
import { createEvidenceHarnessContext, createFixture } from "./e2e-fixtures";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect } from "./e2e-test";

export const EVIDENCE_SOURCES = ["gmail", "retailer", "photo", "csv"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export function sourcePermutations(
  sources: readonly EvidenceSource[],
): EvidenceSource[][] {
  if (!sources.length) return [[]];
  return sources.flatMap((source) =>
    sourcePermutations(sources.filter((other) => other !== source)).map(
      (tail) => [source, ...tail],
    ),
  );
}

/** Only account, vendor and location prerequisites are fixtures. Every economic
 * record and observation below enters through an import writer or real route. */
export async function createConvergenceHarness(
  page: Page,
  baseURL: string,
  token: string,
) {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const database = getDb(db);
  let member = await currentMemberLedgerParty(db, actor);
  if (!member) {
    const party = await createFixture(
      page,
      "ledgerParty",
      ledgerPartyCreateInput.parse({
        name: `Synthetic reviewer ${token}`,
        kind: "member",
      }),
    );
    await setMemberLoginParty(
      db,
      actor.userId,
      parseShortcodeFor("ledgerParty", party.id),
      actor,
    );
    member = await currentMemberLedgerParty(db, actor);
  }
  if (!member) throw new Error("Authenticated reviewer member binding missing");
  const name = `Synthetic evidence ${token}`;
  const productName = `${name} crew shirt`;
  const orderId = `SYN-ORDER-${token}`;
  const host = `shop-${token.toLowerCase()}.example.test`;
  const sender = `orders@${host}`;
  const vendor = await createFixture(
    page,
    "vendor",
    vendorCreateInput.parse({
      name,
      website: `https://${host}`,
      browserDomains: [host],
      orderEmailSenders: [sender],
      orderEvidence: "online_account",
    }),
  );
  const account = await createFixture(
    page,
    "vendorAccount",
    vendorAccountCreateInput.parse({
      label: `${name} retailer`,
      vendorId: vendor.id,
      ledgerPartyId: member.shortcode,
    }),
  );
  const card = await createFixture(
    page,
    "financialAccount",
    financialAccountCreateInput.parse({
      name: `${name} card`,
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: member.shortcode,
      sourceAliases: [
        { source: "monarch", alias: `${name} Visa`, externalAccountId: null },
      ],
    }),
  );
  const location = await createFixture(
    page,
    "location",
    locationCreateInput.parse({ name: `${name} drawer`, type: "drawer" }),
  );
  const category = await createFixture(
    page,
    "spendingCategory",
    spendingCategoryCreateInput.parse({
      name: `${name} clothing`,
      evidenceExpectation: "required",
      productExpectation: "required",
    }),
  );
  const vendorId = await resolveOrThrow(db, "vendor", vendor.id);
  const accountId = await resolveOrThrow(db, "vendorAccount", account.id);
  const cardId = await resolveOrThrow(db, "financialAccount", card.id);
  let bookedPurchaseCode: string | undefined;
  let retailerDone = false;
  let productCode: string | undefined;
  let photoRunId: string | undefined;
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
  const post = async <Input, Output>(
    path: string,
    input: Input,
    output: { parse(value: unknown): Output },
  ): Promise<Output> => {
    const response = await page.request.post(`/api/v1/${path}`, {
      data: input,
      headers: { Origin: baseURL },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return output.parse(await response.json());
  };
  const readProduct = async () => {
    const [found] = await database
      .select({ shortcode: schema.product.shortcode })
      .from(schema.product)
      .where(
        and(eq(schema.product.name, productName), notDeleted(schema.product)),
      )
      .limit(1);
    productCode = found?.shortcode;
    return productCode;
  };

  async function gmail() {
    // Synthetic provider payload passes the real MIME normalization and cursor
    // persistence boundary. Only the classifier's model response is supplied.
    const normalized = normalizeMessage(`synthetic-mailbox-${token}`, {
      id: `synthetic-message-${token}`,
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
      ledgerPartyId: member!.id,
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
    const url = `https://${host}/orders/${orderId}`;
    const html = `<main><h1>${orderId}</h1><p data-total="42.50">USD 42.50</p><p data-item="${productName}" data-sku="SYN-SKU-${token}">${productName}</p></main>`;
    await page.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto(url);
    const extracted = await page
      .locator("[data-item]")
      .getAttribute("data-item");
    const printed = await page
      .locator("[data-total]")
      .getAttribute("data-total");
    expect(extracted).toBe(productName);
    expect(printed).toBe("42.50");
    const run = await startOrResumeRun(db, {
      ledgerPartyId: member!.id,
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
      await gotoAuthenticatedPage(page, "/problems");
      const apply = page.getByRole("button", {
        name: "Apply fix",
        exact: true,
      });
      await expect(apply).toHaveCount(1);
      await expect(
        page.getByText(/Replace .+42.50.+with the receipt lines below/),
      ).toBeVisible();
      await apply.click();
      await expect(
        page.getByText("Applied import correction", { exact: true }),
      ).toBeVisible();
    }
    retailerDone = true;
    await readProduct();
  }

  async function photo() {
    const run = await post(
      "photoImport/createRun",
      { notes: `Synthetic occurrence ${token}` },
      photoImportContract.ops.createRun.output,
    );
    photoRunId = run.runId;
    const photos = ["shirt", "label"].map((kind, index) => {
      const bytes = readFileSync(
        fileURLToPath(
          new URL(`./fixtures/synthetic-wardrobe-${kind}.png`, import.meta.url),
        ),
      );
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
    const staged = await post(
      "photoImport/stage",
      {
        runId: run.runId,
        items: photos.map(
          ({ bytes: _bytes, position: _position, ...item }) => ({
            ...item,
            allowExactReuse: false,
          }),
        ),
      },
      photoImportContract.ops.stage.output,
    );
    const finalized = [];
    for (const item of staged.items) {
      if (item.kind !== "upload")
        throw new Error("Expected new upload for synthetic photo");
      const source = photos.find((photo) => photo.clientId === item.clientId);
      if (!source) throw new Error("Missing synthetic bytes");
      const put = await page.request.put(item.uploadUrl, {
        data: source.bytes,
        headers: { "Content-Type": "image/png" },
      });
      expect(put.ok()).toBe(true);
      finalized.push({
        imageId: item.imageId,
        sha256: source.sha256,
        width: source.width,
        height: source.height,
        position: source.position,
      });
    }
    // Resuming after jobs exist dispatches them inline in the Node writer
    // harness, consuming the lease at the keyless external-AI boundary.
    // Resume before finalize creates these jobs; Workerd wakeups go to the
    // harness's offline queue peer and the supplied result takes a real lease.
    await updateImageProcessingSettings(db, { enabled: false, paused: false });
    const result = await post(
      "photoImport/finalize",
      { runId: run.runId, images: finalized },
      photoImportContract.ops.finalize.output,
    );
    expect(result.finalized).toHaveLength(2);
    const imageIds = await Promise.all(
      finalized.map((image) => resolveOrThrow(db, "image", image.imageId)),
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
      if (!claimed) {
        const diagnostic = await database.execute(sql`
          SELECT j.state, j.attempts, j."nextAttemptAt" <= now() AS "due",
            j."nextAttemptAt", now() AS "databaseNow", j."lastError",
            j."attemptId" IS NOT NULL AS "hasAttempt",
            i.status AS "imageStatus", i."deletedAt" IS NOT NULL AS "imageDeleted",
            i.sha256 = j."sourceContentHash" AS "sourceMatches",
            s.metadata AS settings
          FROM "ImageProcessingJob" j JOIN "Image" i ON i.id = j."imageId"
          LEFT JOIN "AppSettings" s ON s.id = '00000000-0000-4000-8000-000000000071'
          WHERE j.id = ${job.id}
        `);
        throw new Error(
          `Synthetic description lease refused: ${JSON.stringify(diagnostic.rows)}`,
        );
      }
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
    await post(
      "photoImport/saveGroups",
      {
        runId: run.runId,
        groups: [
          {
            groupKey: "shirt",
            images: finalized.map((image, index) => ({
              id: image.imageId,
              purpose: index ? "label" : "item",
            })),
            product: productCode
              ? { kind: "existing", existingId: productCode }
              : {
                  kind: "create",
                  create: { name: productName, manufacturer: name },
                },
            inventory: {
              locationId: location.id,
              quantity: 1,
              ownershipMode: "person",
              ownerPartyId: member!.shortcode,
            },
            evidence:
              "Synthetic own-item and label photos; identity explicitly reviewed.",
          },
        ],
      },
      photoImportContract.ops.saveGroups.output,
    );
    await gotoAuthenticatedPage(
      page,
      `/runs/${run.runId}`,
      page.getByRole("heading", { name: "Photo review", exact: true }),
    );
    await page
      .getByRole("checkbox", { name: new RegExp(`Select ${productName}`) })
      .check();
    await page
      .getByRole("button", { name: "Approve 1 selected item", exact: true })
      .click();
    await expect(
      page.getByText("0 to review · 1 settled · 0 photos not in a group", {
        exact: true,
      }),
    ).toBeVisible();
    const reviewResponse = await page.request.get(
      `/api/v1/photoImport/review?runId=${run.runId}`,
    );
    const review = photoRunReviewResponse.parse(await reviewResponse.json());
    productCode = review.review.proposals[0]?.committedProduct?.id;
    expect(productCode).toBeTruthy();
  }

  async function statement() {
    await gotoAuthenticatedPage(page, "/statement-rows/import");
    await page.getByLabel("Statement CSV file").setInputFiles({
      name: `${token}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page
      .getByRole("checkbox", {
        name: `Record SYNTHETIC ORDER ${token}`,
        exact: true,
      })
      .check();
    await page
      .getByLabel(`Transaction kind for SYNTHETIC ORDER ${token}`, {
        exact: true,
      })
      .selectOption("purchase");
    await page
      .getByRole("button", {
        name: "Save rows and create 1 reviewed transactions",
        exact: true,
      })
      .click();
    await expect(page.getByText(/1 transactions created/)).toBeVisible();
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
    const review = await post(
      "financialTransaction/previewBooking",
      {
        transactionId: transaction.shortcode,
        purchaseId: receipt?.shortcode,
        vendorId: vendor.id,
        spendingCategoryId: category.id,
        trade: "other",
      },
      financialBookingPreview,
    );
    expect(review.action).toBe(receipt ? "link_existing" : "create_aggregate");
    const booked = await post(
      "financialTransaction/commitBooking",
      review,
      financialBookingResult,
    );
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
    const [transaction] = await database
      .select()
      .from(schema.financialTransaction)
      .where(
        and(
          eq(schema.financialTransaction.accountId, cardId),
          notDeleted(schema.financialTransaction),
        ),
      );
    if (!purchase || !transaction)
      throw new Error("Imported settlement evidence missing");
    await gotoAuthenticatedPage(page, `/vendors/${vendor.id}`);
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByText("linked", { exact: true })).toBeVisible();
    expect(purchase.shortcode).toBe(bookedPurchaseCode);
    return { purchaseCode: purchase.shortcode, productCode, photoRunId };
  }

  async function projection() {
    const { rows } = await database.execute(sql`
      SELECT
        (SELECT count(*)::int FROM "Purchase" WHERE "vendorId" = ${vendorId} AND "orderId" = ${orderId} AND "deletedAt" IS NULL) AS purchases,
        (SELECT count(*)::int FROM "Product" WHERE name = ${productName} AND "deletedAt" IS NULL) AS products,
        (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS expenses,
        (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" JOIN "Product" product ON product.id = e."productId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL AND product.name = ${productName} AND product."deletedAt" IS NULL) AS "productLines",
        (SELECT count(*)::int FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" t ON t.id = a."transactionId" JOIN "Purchase" p ON p.id = a."purchaseId" WHERE t."accountId" = ${cardId} AND a."deletedAt" IS NULL AND t."deletedAt" IS NULL AND p."vendorId" = ${vendorId} AND p."orderId" = ${orderId} AND p."deletedAt" IS NULL) AS "settledPurchases",
        (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" JOIN "SpendingCategory" c ON c.id = COALESCE(e."spendingCategoryId", p."spendingCategoryId") WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL AND c.shortcode = ${category.id} AND c."deletedAt" IS NULL) AS "categorizedExpenses",
        (SELECT round(sum(e.cost) * 100)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS spend,
        (SELECT count(*)::int FROM "FinancialTransaction" WHERE "accountId" = ${cardId} AND "deletedAt" IS NULL) AS transactions,
        (SELECT round(sum(a.amount) * 100)::int FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" t ON t.id = a."transactionId" WHERE t."accountId" = ${cardId} AND a."deletedAt" IS NULL AND t."deletedAt" IS NULL) AS settlement,
        (SELECT count(*)::int FROM "InventoryEntry" i JOIN "Product" p ON p.id = i."productId" WHERE p.name = ${productName} AND i."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS inventory,
        (SELECT sum(i."amountValue")::int FROM "InventoryEntry" i JOIN "Product" p ON p.id = i."productId" WHERE p.name = ${productName} AND i."deletedAt" IS NULL AND p."deletedAt" IS NULL AND i."ownershipMode" = 'person' AND i."ownerLedgerPartyId" = ${member!.id}) AS "ownedQuantity",
        (SELECT count(*)::int FROM "StatementRow" WHERE "accountDescriptor" = ${`${name} Visa`} AND "deletedAt" IS NULL) AS observations,
        (SELECT count(*)::int FROM "StatementRow" s JOIN "EntityExternalId" x ON x.source = s.source AND x."externalId" = s."externalId" AND x.kind = 'settlement_ref' AND x."deletedAt" IS NULL JOIN "FinancialTransaction" t ON t.id = x."entityId" AND t."deletedAt" IS NULL WHERE s."accountDescriptor" = ${`${name} Visa`} AND s."deletedAt" IS NULL) AS "matchedObservations",
        (SELECT count(*)::int FROM "OrderMail" WHERE "messageId" = ${`synthetic-message-${token}`}) AS mail,
        (SELECT count(*)::int FROM "OrderMailCandidateDecision" d JOIN "OrderMailEvent" e ON e.id = d."eventId" JOIN "OrderMail" m ON m.id = e."orderMailId" WHERE m."messageId" = ${`synthetic-message-${token}`} AND d.decision = 'linked') AS "linkedMail"
    `);
    return rows[0];
  }
  return {
    sources: { gmail, retailer, photo, csv: statement },
    settle,
    projection,
    productName,
    orderId,
  };
}
