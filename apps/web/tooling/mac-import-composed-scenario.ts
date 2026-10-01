import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pollUntil } from "@cubby/shared/retry";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { getDb, notDeleted } from "../src/server/repo/database-helpers";
import * as schema from "../src/server/db/schema";
import { updateImageProcessingSettings } from "../src/server/repo/image-processing-maintenance";
import {
  listPhotoGroupProposals,
  listPhotoRunImages,
  proposePhotoGroups,
} from "../src/server/photo-import-run/proposals";
import { resolveOrThrow } from "../src/server/repo/shortcode-resolver";
import {
  completeDescribeImageJobs,
  importBrowserOrder,
} from "./convergence-harness";
import { createFixtureWithContext } from "./scenarios/context";
import type { createMacBrowserScenario } from "./mac-browser-import-scenario";
import type { MacImportDriver } from "./mac-import-driver";

import { macImportOrder, type MacImportSource } from "./mac-import-orders";
import { buildEntity } from "./factories/build";
const productName = "Black crew shirt · size M";
const categoryName = "Synthetic Mac clothing";
const fixtureGTIN = "00012345678905";

type BrowserScenario = Awaited<ReturnType<typeof createMacBrowserScenario>>;
type Input = {
  browser: BrowserScenario;
  statementAccountId: string;
  driver: MacImportDriver;
  artifacts: string;
  webRoot: string;
  appPath: () => string;
  onStage: (stage: string) => void;
  onMilestone: (
    stage:
      | "nativeBookingReviewed"
      | "nativePhotoApproved"
      | "retailerCommitted"
      | "browserCaptureVerified",
  ) => void;
};
const eventually = <T>(read: () => Promise<T | undefined>, label: string) =>
  pollUntil(read, { label: `native composed journey: ${label}` });

/** Only auth/account/category/location prerequisites are fixtures. Economic writes cross production review boundaries. */
export async function createMacComposedScenario(input: Input) {
  const { db, kernel, member, vendor, run } = input.browser.context;
  const database = getDb(db);
  const vendorId = await resolveOrThrow(db, "vendor", vendor.id);
  const category = await createFixtureWithContext(
    kernel,
    "spendingCategory",
    buildEntity("spendingCategory", {
      name: categoryName,
      evidenceExpectation: "required",
      productExpectation: "required",
    }),
  );
  const location = await createFixtureWithContext(
    kernel,
    "location",
    buildEntity("location", {
      name: "Synthetic Mac wardrobe drawer",
      type: "drawer",
    }),
  );
  const cardId = await resolveOrThrow(
    db,
    "financialAccount",
    input.statementAccountId,
  );
  const photos = path.join(input.artifacts, "photo-inputs");
  mkdirSync(photos, { recursive: true });
  copyFileSync(
    path.join(input.webRoot, "tests/e2e/fixtures/synthetic-wardrobe-shirt.png"),
    path.join(photos, "synthetic-shirt.png"),
  );
  copyFileSync(
    path.join(
      input.webRoot,
      "tests/e2e/fixtures/synthetic-mac-wardrobe-label.png",
    ),
    path.join(photos, "synthetic-label.png"),
  );
  const originalHashes = ["synthetic-shirt.png", "synthetic-label.png"].map(
    (filename) =>
      createHash("sha256")
        .update(readFileSync(path.join(photos, filename)))
        .digest("hex"),
  );
  let photoRunCode: string | undefined;
  let bookedPurchaseCode: string | undefined;
  let receiptCommitted = false;
  let photoProposalGuard:
    | {
        before: EconomicProjection;
        afterProposal: EconomicProjection;
        beforeApproval: EconomicProjection;
      }
    | undefined;
  const stages: Array<{
    source: MacImportSource;
    nativeReviewed: boolean;
    projection: Projection;
  }> = [];
  await updateImageProcessingSettings(db, { enabled: false, paused: false });

  async function productCode() {
    const [product] = await database
      .select({ code: schema.product.shortcode })
      .from(schema.product)
      .where(
        and(eq(schema.product.name, productName), notDeleted(schema.product)),
      )
      .limit(1);
    return product?.code;
  }
  async function purchase() {
    const [found] = await database
      .select({
        code: schema.purchase.shortcode,
        orderId: schema.purchase.orderId,
      })
      .from(schema.purchase)
      .where(
        and(
          eq(schema.purchase.vendorId, vendorId),
          notDeleted(schema.purchase),
        ),
      )
      .limit(1);
    return found;
  }
  async function nativeBooking() {
    input.onStage("native-booking-review");
    const [transaction] = await database
      .select({ code: schema.financialTransaction.shortcode })
      .from(schema.financialTransaction)
      .where(
        and(
          eq(schema.financialTransaction.accountId, cardId),
          notDeleted(schema.financialTransaction),
        ),
      )
      .limit(1);
    if (!transaction)
      throw new Error(
        "Actual native CSV did not create the expected fixture card transaction",
      );
    await input.driver.openEntity(transaction.code, input.appPath());
    await input.driver.wait("id=financial.evidence.review");
    const existing = receiptCommitted ? await purchase() : undefined;
    if (receiptCommitted && !existing)
      throw new Error("Receipt commit is missing its canonical Purchase");
    await input.driver.pickBookingEntity(
      "financial.booking.category",
      categoryName,
    );
    if (existing) {
      await input.driver.pickBookingEntity(
        "financial.booking.purchase",
        existing.orderId ?? "Synthetic Outfitters",
      );
    } else {
      await input.driver.pickBookingEntity(
        "financial.booking.vendor",
        "Synthetic Outfitters",
      );
    }
    await input.driver.click("id=financial.booking.preview");
    await input.driver.wait("id=financial.booking.commit");
    await input.driver.screenshot("native-booking-preview");
    const view = await input.driver.snapshot();
    if (
      !view.includes(
        existing ? "Link existing Expenses" : "Create aggregate Expense",
      )
    )
      throw new Error(
        "Native booking preview did not display its expected economic action",
      );
    await input.driver.click("id=financial.booking.commit");
    bookedPurchaseCode = (
      await eventually(purchase, "native reviewed Purchase booking")
    )?.code;
    const projection = await eventually(async () => {
      const value = await project();
      return value.settlementCents === 2999 ? value : undefined;
    }, "native booking settlement allocation");
    input.onMilestone("nativeBookingReviewed");
    if (projection.transactions !== 1)
      throw new Error("Native booking unexpectedly duplicated the transaction");
  }

  async function photo() {
    const beforeProposal = await economicProjection();
    input.onStage("native-photo-intake");
    await input.driver.addPhotosToImportRun(photos);
    const nativeRun = await eventually(async () => {
      const [found] = await database
        .select({ code: schema.run.shortcode, id: schema.run.id })
        .from(schema.run)
        .where(eq(schema.run.purpose, "photo_inventory"))
        .limit(1);
      return found;
    }, "native-created photo inventory run");
    photoRunCode = nativeRun.code;
    const images = await eventually(async () => {
      const found = await listPhotoRunImages(db, nativeRun.code);
      return found.length === 2 ? found : undefined;
    }, "native upload/stage/PUT/finalize of both photo originals");
    const originals = await database
      .select({ code: schema.image.shortcode, sha256: schema.image.sha256 })
      .from(schema.image)
      .innerJoin(
        schema.runTarget,
        eq(schema.runTarget.entityId, schema.image.id),
      )
      .where(eq(schema.runTarget.runId, nativeRun.id));
    if (
      originals
        .map((image) => image.sha256)
        .sort()
        .join(",") !== [...originalHashes].sort().join(",")
    )
      throw new Error(
        "Native upload did not preserve the two fixture original-byte hashes",
      );
    const imageIds = await Promise.all(
      images.map((image) => resolveOrThrow(db, "image", image.id)),
    );
    const jobs = await eventually(async () => {
      const found = await database
        .select()
        .from(schema.imageProcessingJob)
        .where(
          and(
            inArray(schema.imageProcessingJob.imageId, imageIds),
            eq(schema.imageProcessingJob.kind, "describe_image"),
          ),
        );
      return found.length === 2 ? found : undefined;
    }, "production description jobs from native finalize");
    await completeDescribeImageJobs(
      db,
      jobs,
      `Supplied external model fixture response: own ${productName}; label Synthetic Works, M, GTIN ${fixtureGTIN}.`,
    );
    const existing = await productCode();
    await proposePhotoGroups(db, {
      runId: parseShortcodeFor("run", nativeRun.code),
      groups: [
        {
          groupKey: "synthetic-shirt",
          images: images.map((image) => ({
            id: image.id,
            purpose:
              originals.find((original) => original.code === image.id)
                ?.sha256 === originalHashes[1]
                ? "label"
                : "item",
          })),
          product: existing
            ? { kind: "existing", existingId: existing }
            : {
                kind: "create",
                create: {
                  name: productName,
                  manufacturer: "Synthetic Works",
                  notes: `Black, size M. Reviewed label GTIN ${fixtureGTIN}.`,
                },
              },
          inventory: {
            locationId: parseShortcodeFor("location", location.id),
            quantity: 1,
            ownershipMode: "person",
            ownerPartyId: member.shortcode,
          },
          evidence: `Supplied grouping result for actual uploaded shirt+label bytes. Exact black/M identity and GTIN ${fixtureGTIN} are shown for native approval. No Product or Inventory is written before approval.`,
        },
      ],
    });
    const afterProposal = await economicProjection();
    assertEconomicProjectionUnchanged(beforeProposal, afterProposal);
    input.onStage("native-photo-group-review");
    await input.driver.wait('label="Review item groups"');
    await input.driver.click('label="Review item groups"');
    await input.driver.wait("id=review.workspace");
    await input.driver.screenshot("native-photo-group-review");
    const beforeApproval = await economicProjection();
    assertEconomicProjectionUnchanged(beforeProposal, beforeApproval);
    photoProposalGuard = {
      before: beforeProposal,
      afterProposal,
      beforeApproval,
    };
    await input.driver.approveAllPhotoGroups();
    await eventually(async () => {
      const review = await listPhotoGroupProposals(db, nativeRun.code);
      return review.proposals.length === 1 &&
        review.proposals[0]?.state === "committed"
        ? review
        : undefined;
    }, "actual native group approval");
    input.onMilestone("nativePhotoApproved");
  }

  async function receiptFindings() {
    const findings = await database
      .select({
        id: schema.runFinding.id,
        kind: schema.runFinding.kind,
        proposedFix: schema.runFinding.proposedFix,
      })
      .from(schema.runFinding)
      .where(
        and(
          eq(schema.runFinding.runId, run.id),
          eq(schema.runFinding.status, "open"),
        ),
      );
    const fixKind = (finding: (typeof findings)[number]) =>
      z.object({ kind: z.string() }).safeParse(finding.proposedFix).data?.kind;
    const replacements = findings.filter(
      (finding) => fixKind(finding) === "replace_aggregate_line",
    );
    const arrivals = findings.filter(
      (finding) =>
        finding.kind === "arrived" && fixKind(finding) === "receive_purchase",
    );
    if (
      arrivals.length !== 1 ||
      findings.length !== replacements.length + arrivals.length
    )
      throw new Error(
        `Delivered native receipt has unexpected findings: ${JSON.stringify(findings)}`,
      );
    return { findings, replacements };
  }

  async function receipt() {
    input.onStage("native-retailer-capture-and-resume");
    const capture = await input.browser.run(input.driver);
    const orderText = capture.orderCapture.readableText.replace(/\s+/g, " ");
    const productText = capture.productCapture.readableText.replace(
      /\s+/g,
      " ",
    );
    if (
      capture.orderCapture.sourceURL !==
        `${input.browser.context.retailerOrigin}/orders/order-001` ||
      capture.productCapture.sourceURL !==
        `${input.browser.context.retailerOrigin}/products/black-crew-shirt` ||
      !orderText.includes("September 21, 2026") ||
      !orderText.includes("Visa ending 4242") ||
      !orderText.includes("Total $29.99") ||
      !orderText.includes("Delivered") ||
      !orderText.includes("Quantity 1") ||
      !orderText.includes(productName) ||
      !productText.includes("Exact color Black") ||
      !productText.includes("Size M") ||
      !productText.includes(`GTIN ${fixtureGTIN}`) ||
      !productText.includes("$29.99")
    )
      throw new Error(
        "Supplied extraction does not match actual native date/card/amount/exact variant/GTIN captures",
      );
    input.onMilestone("browserCaptureVerified");
    const checksum = createHash("sha256")
      .update(JSON.stringify(capture))
      .digest("hex");
    const committed = await importBrowserOrder(db, {
      runId: run.id,
      actor: kernel.actorContext,
      ids: {
        prepare: "mac:prepare:order-001",
        commit: "mac:commit:order-001",
        order: "mac:order-001",
        line: "mac:black-crew-shirt:M",
        item: "mac:item:order-001",
      },
      externalKey: "order-001",
      checksum,
      extractionRevision: "synthetic-native-capture@1",
      candidate: {
        orderId: "order-001",
        orderedAt: "2026-09-21T12:00:00.000Z",
        merchant: "Synthetic Outfitters",
        currency: "USD",
        printedGrandTotal: 29.99,
        lines: [
          {
            title: productName,
            amount: 29.99,
            quantity: 1,
            lineKind: "principal",
            productUrl: capture.productCapture.sourceURL,
          },
        ],
        payments: [
          {
            amount: 29.99,
            cardLastFour: "4242",
            chargedAt: "2026-09-21T12:00:00.000Z",
          },
        ],
        allShipmentsDelivered: true,
      },
      targetPurchaseId: bookedPurchaseCode,
      resolveProduct: productCode,
    });
    if (
      !committed.items[0] ||
      !["created", "updated", "replayed"].includes(committed.items[0].outcome)
    )
      throw new Error(
        `Production native retailer commit refused: ${JSON.stringify(committed)}`,
      );
    receiptCommitted = true;
    const { findings, replacements } = await receiptFindings();
    if (bookedPurchaseCode) {
      if (replacements.length !== 1 || !replacements[0])
        throw new Error(
          `CSV-first native receipt must offer exactly one reviewed aggregate replacement: ${JSON.stringify({ committed, findings })}`,
        );
      input.onStage("native-receipt-replacement-review");
      await input.driver.openEntity(run.publicId, input.appPath());
      await input.driver.wait(`id=run.finding.apply.${replacements[0].id}`);
      await input.driver.screenshot("native-receipt-replacement-review");
      await input.driver.click(`id=run.finding.apply.${replacements[0].id}`);
      await input.driver.wait(`id=run.finding.confirm.${replacements[0].id}`);
      await input.driver.click(`id=run.finding.confirm.${replacements[0].id}`);
      await eventually(async () => {
        const [finding] = await database
          .select({ state: schema.runFinding.status })
          .from(schema.runFinding)
          .where(eq(schema.runFinding.id, replacements[0]!.id));
        return finding?.state === "applied" ? finding : undefined;
      }, "native approved receipt aggregate replacement");
    } else if (replacements.length)
      throw new Error(
        "Receipt-first fixture unexpectedly has unresolved findings",
      );
    const evidence = path.join(input.artifacts, "native-receipt-commit.json");
    writeFileSync(
      evidence,
      JSON.stringify(
        {
          capturedEvidenceChecksum: checksum,
          source: "actual native broker captures",
          modelResponse: "supplied deterministic extraction fixture",
          preparationAndCommit: "production writers",
          originalRunResumed: true,
          nativeReplacementApproved: Boolean(bookedPurchaseCode),
          receiptCommitted: true,
        },
        null,
        2,
      ) + "\n",
    );
    input.driver.evidence.push(evidence);
    input.onMilestone("retailerCommitted");
  }

  const economicProjectionSchema = z.object({
    products: z.coerce.number(),
    inventory: z.coerce.number(),
    expenses: z.coerce.number(),
    spendCents: z.coerce.number(),
    productIds: z.array(z.string()),
    inventoryIds: z.array(z.string()),
    expenseIds: z.array(z.string()),
  });
  type EconomicProjection = z.infer<typeof economicProjectionSchema>;
  function assertEconomicProjectionUnchanged(
    before: EconomicProjection,
    after: EconomicProjection,
  ) {
    for (const key of Object.keys(before)) {
      const field = economicProjectionSchema.keyof().parse(key);
      if (JSON.stringify(after[field]) !== JSON.stringify(before[field]))
        throw new Error(
          `Native photo intake/proposal prematurely changed ${field}`,
        );
    }
  }
  async function economicProjection(): Promise<EconomicProjection> {
    const result = await database.execute(sql`
      SELECT (SELECT count(*) FROM "Product" WHERE "deletedAt" IS NULL) AS products,
        (SELECT count(*) FROM "InventoryEntry" WHERE "deletedAt" IS NULL) AS inventory,
        (SELECT count(*) FROM "Expense" WHERE "deletedAt" IS NULL) AS expenses,
        (SELECT coalesce(round(sum(cost)*100),0) FROM "Expense" WHERE "deletedAt" IS NULL) AS "spendCents",
        ARRAY(SELECT id::text FROM "Product" WHERE "deletedAt" IS NULL ORDER BY id) AS "productIds",
        ARRAY(SELECT id::text FROM "InventoryEntry" WHERE "deletedAt" IS NULL ORDER BY id) AS "inventoryIds",
        ARRAY(SELECT id::text FROM "Expense" WHERE "deletedAt" IS NULL ORDER BY id) AS "expenseIds"
    `);
    return economicProjectionSchema.parse(result.rows[0]);
  }

  const projectionSchema = z.object({
    purchases: z.coerce.number(),
    products: z.coerce.number(),
    expenses: z.coerce.number(),
    productLines: z.coerce.number(),
    spendCents: z.coerce.number(),
    transactions: z.coerce.number(),
    observations: z.coerce.number(),
    settlementCents: z.coerce.number(),
    inventory: z.coerce.number(),
    ownedQuantity: z.coerce.number().nullable(),
    categorizedExpenses: z.coerce.number(),
    images: z.coerce.number(),
    unresolvedFindings: z.coerce.number(),
  });
  type Projection = z.infer<typeof projectionSchema>;
  async function project(): Promise<Projection> {
    const result = await database.execute(sql`
      SELECT
        (SELECT count(*) FROM "Purchase" WHERE "vendorId"=${vendorId} AND "deletedAt" IS NULL) AS purchases,
        (SELECT count(*) FROM "Product" WHERE name=${productName} AND "deletedAt" IS NULL) AS products,
        (SELECT count(*) FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" WHERE p."vendorId"=${vendorId} AND p."deletedAt" IS NULL AND e."deletedAt" IS NULL) AS expenses,
        (SELECT count(*) FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" WHERE p."vendorId"=${vendorId} AND e."productId" IS NOT NULL AND p."deletedAt" IS NULL AND e."deletedAt" IS NULL) AS "productLines",
        (SELECT coalesce(round(sum(e.cost)*100),0) FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" WHERE p."vendorId"=${vendorId} AND p."deletedAt" IS NULL AND e."deletedAt" IS NULL) AS "spendCents",
        (SELECT count(*) FROM "FinancialTransaction" WHERE "accountId"=${cardId} AND "deletedAt" IS NULL) AS transactions,
        (SELECT count(*) FROM "StatementRow" WHERE "deletedAt" IS NULL) AS observations,
        (SELECT coalesce(round(sum(a.amount)*100),0) FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" t ON t.id=a."transactionId" WHERE t."accountId"=${cardId} AND t."deletedAt" IS NULL AND a."deletedAt" IS NULL) AS "settlementCents",
        (SELECT count(*) FROM "InventoryEntry" i JOIN "Product" p ON p.id=i."productId" WHERE p.name=${productName} AND p."deletedAt" IS NULL AND i."deletedAt" IS NULL) AS inventory,
        (SELECT sum(i."amountValue") FROM "InventoryEntry" i JOIN "Product" p ON p.id=i."productId" WHERE p.name=${productName} AND p."deletedAt" IS NULL AND i."deletedAt" IS NULL AND i."ownershipMode"='person' AND i."ownerLedgerPartyId"=${member.id}) AS "ownedQuantity",
        (SELECT count(*) FROM "Expense" e JOIN "Purchase" p ON p.id=e."purchaseId" WHERE p."vendorId"=${vendorId} AND coalesce(e."spendingCategoryId",p."spendingCategoryId")=${await resolveOrThrow(db, "spendingCategory", category.id)} AND p."deletedAt" IS NULL AND e."deletedAt" IS NULL) AS "categorizedExpenses",
        (SELECT count(*) FROM "Image" WHERE "deletedAt" IS NULL AND status='UPLOADED') AS images,
        (SELECT count(*) FROM "RunFinding" WHERE status='open' AND "runId"=${run.id}) AS "unresolvedFindings"
    `);
    return projectionSchema.parse(result.rows[0]);
  }

  async function assertCanonicalEdges() {
    const canonicalProduct = await productCode();
    const canonicalPurchase = await purchase();
    if (!canonicalProduct || !canonicalPurchase)
      throw new Error("Native composed canonical entities are missing");
    const productId = await resolveOrThrow(db, "product", canonicalProduct);
    const purchaseId = await resolveOrThrow(
      db,
      "purchase",
      canonicalPurchase.code,
    );
    const locationId = await resolveOrThrow(db, "location", location.id);
    const categoryId = await resolveOrThrow(
      db,
      "spendingCategory",
      category.id,
    );
    const edges = await database.execute(sql`
      SELECT e.shortcode AS "expense", p.shortcode AS "purchase", pr.shortcode AS "product",
        i.shortcode AS "inventory", t.shortcode AS "transaction", r."externalId" AS "statementExternalId"
      FROM "Expense" e
      JOIN "Purchase" p ON p.id=e."purchaseId" AND p.id=${purchaseId} AND p."vendorId"=${vendorId} AND p."orderId"='order-001' AND p."deletedAt" IS NULL
      JOIN "Product" pr ON pr.id=e."productId" AND pr.id=${productId} AND pr."deletedAt" IS NULL
      JOIN "InventoryEntry" i ON i."productId"=pr.id AND i."locationId"=${locationId} AND i."ownerLedgerPartyId"=${member.id} AND i."ownershipMode"='person' AND i."amountValue"=1 AND i."deletedAt" IS NULL
      JOIN "FinancialTransactionAllocation" a ON a."purchaseId"=p.id AND a.amount=29.99 AND a."deletedAt" IS NULL
      JOIN "FinancialTransaction" t ON t.id=a."transactionId" AND t."accountId"=${cardId} AND t.amount=29.99 AND t.status='posted' AND t.kind='purchase' AND t."deletedAt" IS NULL
      JOIN "EntityExternalId" ref ON ref."entityId"=t.id AND ref."entityKind"='financialTransaction' AND ref.kind='settlement_ref' AND ref.source='monarch' AND ref."deletedAt" IS NULL
      JOIN "StatementRow" r ON r.source=ref.source AND r."externalId"=ref."externalId" AND r."providerTransactionId"='synthetic-statement-1' AND r.amount=29.99 AND r."providerAmount"=-29.99 AND r."providerStatus"='posted' AND r."accountId"=${cardId} AND r."statementDate"='2026-09-21' AND r."deletedAt" IS NULL
      WHERE e."deletedAt" IS NULL AND e.cost=29.99 AND coalesce(e."spendingCategoryId",p."spendingCategoryId")=${categoryId}
    `);
    const edge = z
      .array(
        z.object({
          expense: z.string(),
          purchase: z.string(),
          product: z.string(),
          inventory: z.string(),
          transaction: z.string(),
          statementExternalId: z.string(),
        }),
      )
      .length(1)
      .parse(edges.rows)[0]!;
    const attachments = await database.execute(sql`
      SELECT im.shortcode AS image, im.sha256, a.purpose
      FROM "EntityAttachment" a JOIN "Image" im ON im.id=a."imageId" AND im."deletedAt" IS NULL AND im.status='UPLOADED'
      WHERE a."entityKind"='product' AND a."entityId"=${productId} AND a."deletedAt" IS NULL
    `);
    const originals = z
      .array(
        z.object({
          image: z.string(),
          sha256: z.string(),
          purpose: z.enum(["item", "label"]),
        }),
      )
      .length(2)
      .parse(attachments.rows);
    for (const [index, purpose] of ["item", "label"].entries()) {
      if (
        originals.filter(
          (image) =>
            image.sha256 === originalHashes[index] && image.purpose === purpose,
        ).length !== 1
      )
        throw new Error(
          `Native composed canonical Product is missing the original ${purpose} attachment`,
        );
    }
    const nonEconomic = await database.execute(sql`
      SELECT r."providerTransactionId", r.amount, r."providerAmount", r."providerStatus", r.disposition,
        (SELECT count(*) FROM "EntityExternalId" ref WHERE ref.source=r.source AND ref."externalId"=r."externalId" AND ref.kind='settlement_ref' AND ref."deletedAt" IS NULL) AS "settlementReferences"
      FROM "StatementRow" r WHERE r."providerTransactionId"='synthetic-statement-2' AND r.source='monarch' AND r."statementDate"='2026-09-22' AND r."deletedAt" IS NULL
    `);
    const evidenceOnly = z
      .array(
        z.object({
          providerTransactionId: z.literal("synthetic-statement-2"),
          amount: z.coerce.number().pipe(z.literal(-50)),
          providerAmount: z.coerce.number().pipe(z.literal(50)),
          providerStatus: z.literal("posted"),
          disposition: z.literal("open"),
          settlementReferences: z.coerce.number().pipe(z.literal(0)),
        }),
      )
      .length(1)
      .parse(nonEconomic.rows)[0]!;
    return {
      ...edge,
      originalAttachments: originals,
      nonEconomicObservation: evidenceOnly,
    };
  }

  return {
    async run(order: MacImportSource[], csv: () => Promise<void>) {
      for (const source of macImportOrder.parse(order)) {
        input.onStage(`native-${source}-arrival`);
        if (source === "csv") {
          await csv();
          await nativeBooking();
        } else if (source === "photo") await photo();
        else await receipt();
        stages.push({
          source,
          nativeReviewed: true,
          projection: await project(),
        });
      }
      // The photo review already recorded ownership. Dismiss receipt arrival
      // through the native review instead of receiving a second owned unit.
      const [arrival] = await database
        .select({ id: schema.runFinding.id })
        .from(schema.runFinding)
        .where(
          and(
            eq(schema.runFinding.runId, run.id),
            eq(schema.runFinding.kind, "arrived"),
            eq(schema.runFinding.status, "open"),
          ),
        );
      if (!arrival)
        throw new Error("Delivered receipt arrival review is missing");
      await input.driver.openEntity(run.publicId, input.appPath());
      await input.driver.wait(`id=run.finding.dismiss.${arrival.id}`);
      await input.driver.screenshot("native-existing-ownership-arrival-review");
      await input.driver.click(`id=run.finding.dismiss.${arrival.id}`);
      await eventually(async () => {
        const [finding] = await database
          .select({ state: schema.runFinding.status })
          .from(schema.runFinding)
          .where(eq(schema.runFinding.id, arrival.id));
        return finding?.state === "dismissed" ? finding : undefined;
      }, "native arrival dismissal for existing photo ownership");
      const final = await project();
      const expected = {
        purchases: 1,
        products: 1,
        expenses: 1,
        productLines: 1,
        spendCents: 2999,
        transactions: 1,
        observations: 2,
        settlementCents: 2999,
        inventory: 1,
        ownedQuantity: 1,
        categorizedExpenses: 1,
        // Two photo originals plus history, order, and product capture documents.
        images: 5,
        unresolvedFindings: 0,
      };
      for (const key of Object.keys(expected)) {
        const field = projectionSchema.keyof().parse(key);
        if (final[field] !== expected[field])
          throw new Error(
            `Native composed graph ${field}: expected ${expected[field]}, got ${final[field]}`,
          );
      }
      const canonicalEdges = await assertCanonicalEdges();
      const canonicalProduct = await productCode();
      if (!canonicalProduct)
        throw new Error("Canonical Product is missing for native edit review");
      const [storedProduct] = await database
        .select({ price: schema.product.price })
        .from(schema.product)
        .where(
          eq(
            schema.product.id,
            await resolveOrThrow(db, "product", canonicalProduct),
          ),
        );
      if (!storedProduct || storedProduct.price !== null)
        throw new Error(
          "Native inherited-price fixture unexpectedly has a stored price override",
        );
      await input.driver.openEntity(canonicalProduct, input.appPath());
      await input.driver.wait("id=detail.product.edit");
      await input.driver.click("id=detail.product.edit");
      await input.driver.wait("id=editor.product");
      await input.driver.wait('contains="Effective: $29.99"');
      const editor = await input.driver.wait(
        'contains="Inherited · expense-derived unit price"',
      );
      const save = editor
        .split("\n")
        .find((line) => line.includes("id=editor.product.save"));
      if (!save?.includes("[disabled]"))
        throw new Error(
          "Opening the native Product editor pinned an inherited field into the draft",
        );
      await input.driver.screenshot("native-inherited-price-editor");
      await input.driver.click('label="Cancel" role=Button');
      const file = path.join(input.artifacts, "native-composed-results.json");
      writeFileSync(
        file,
        JSON.stringify(
          {
            order,
            stages,
            final,
            canonicalEdges,
            photoProposalGuard,
            photoRun: photoRunCode,
            inheritedPriceEdit: {
              effectivePrice: 29.99,
              unchangedDraftSaveDisabled: true,
            },
            boundaries: {
              csv: "native NSOpenPanel + review + shared writer + native Expense booking/link review",
              photo:
                "native NSOpenPanel + upload/finalize + real job lease/completion with supplied description/grouping + native approval",
              receipt:
                "actual native broker capture/resume + supplied extraction + production prepare/commit + native aggregate finding approval when required",
            },
            rawModelQualityValidated: false,
          },
          null,
          2,
        ) + "\n",
      );
      input.driver.evidence.push(file);
    },
  };
}
