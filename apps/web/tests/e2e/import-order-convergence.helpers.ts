import { startOperation } from "./start-operation";
import { entityApi } from "./entity-api";
import {
  financialBookingPreview,
  financialBookingResult,
} from "@cubby/schemas/financial-booking";

import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import { photoRunReviewResponse } from "@cubby/schemas/photo-import-run";

import {
  resolveRunFindingOut,
  type ResolveRunFindingInput,
} from "@cubby/schemas/problems";

import {
  prepareSourceOrderReconciliationOut,
  proposedImportFix,
  type PrepareSourceOrderReconciliationInput,
} from "@cubby/schemas/purchase-import";

import type { Page } from "@playwright/test";
import { and, eq, sql } from "drizzle-orm";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { photoImportContract } from "~/contracts/photo-import.contract";
import { scrubErrorMessage } from "~/lib/error-diagnostics";
import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "~/server/repo/member-login";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  createEvidenceHarnessContext,
  createEntityFixture,
} from "./fixtures-core";
import {
  completeDescribeImageJobs,
  convergenceNames,
  convergenceProjection,
  createConvergenceFixtures,
  describeJobDiagnostic,
  importBrowserOrder,
  ingestGmailEvidence,
  listDescribeImageJobs,
  openFindingCount,
  sha256Hex,
  shirtGroup,
  syntheticOrderIds,
  wardrobePhotos,
} from "../../tooling/convergence-harness";
import { chooseOption, gotoAuthenticatedPage } from "./e2e-helpers";
import { expect } from "./e2e-test";

type EvidenceSource = "gmail" | "retailer" | "photo" | "csv";
/** Both booking paths retain browser coverage: a statement aggregate needs
 * reviewed receipt reconciliation; a receipt first links existing itemization.
 * Both exercise photo approval and destination navigation. PostgreSQL keeps
 * all 24 arrival orders; the first row also guards the Problems sample limit. */
export const BROWSER_SOURCE_ORDERS = [
  ["csv", "photo", "retailer", "gmail"],
  ["retailer", "gmail", "csv", "photo"],
] as const satisfies readonly (readonly EvidenceSource[])[];

/** Itemization that arrives after a booked aggregate stays a `conflict` until
 * the member reviews it: prepare the replacement through the reconciliation
 * API, apply it from the Run page, then replay the apply. Money, stock,
 * payment evidence and statement allocations survive unchanged. */
export async function applyReviewedSourceReconciliation(
  page: Page,
  input: {
    db: Awaited<ReturnType<typeof createEvidenceHarnessContext>>["db"];
    baseURL: string;
    purchaseCode: string;
    productCode: string;
  },
) {
  const database = getDb(input.db);
  const purchaseId = await resolveOrThrow(
    input.db,
    "purchase",
    input.purchaseCode,
  );
  const openReconciliations = async () =>
    (
      await database.query.runFinding.findMany({
        where: and(
          eq(schema.runFinding.entityId, purchaseId),
          eq(schema.runFinding.status, "open"),
        ),
      })
    ).filter(
      (row) =>
        proposedImportFix.safeParse(row.proposedFix).data?.kind ===
        "reconcile_source_order",
    );
  // A browser approval commits after its click returns.
  await expect.poll(async () => (await openReconciliations()).length).toBe(1);
  const [finding] = await openReconciliations();
  if (!finding) throw new Error("Reconciliation finding missing");
  const lines = () =>
    database.query.expense.findMany({
      where: and(
        eq(schema.expense.purchaseId, purchaseId),
        notDeleted(schema.expense),
      ),
    });
  const aggregate = await lines();
  expect(aggregate).toMatchObject([{ cost: 42.5, productId: null }]);
  const preserved = async () => ({
    inventory: await database.select().from(schema.inventoryEntry),
    payments: await database.select().from(schema.purchasePaymentEvidence),
    allocations: await database
      .select()
      .from(schema.financialTransactionAllocation),
  });
  const before = await preserved();
  const send = async <Output>(
    path: string,
    data: PrepareSourceOrderReconciliationInput | ResolveRunFindingInput,
    output: { parse(value: unknown): Output },
  ) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      data,
      headers: { Origin: input.baseURL },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return output.parse(await response.json());
  };
  const expenseId = parseShortcodeFor("expense", aggregate[0]!.shortcode);
  const review = await send(
    "purchaseImport/prepareReconciliation",
    {
      id: finding.id,
      resolution: {
        kind: "replace_lines",
        expenseIds: [expenseId],
        lines: [
          {
            lineIndex: 0,
            expenseId,
            productId: parseShortcodeFor("product", input.productCode),
          },
        ],
      },
    },
    prepareSourceOrderReconciliationOut,
  );
  expect(review.spend).toEqual({ before: 42.5, after: 42.5, delta: 0 });
  // Preparing records the review; it writes no ledger, stock or settlement.
  expect(await lines()).toEqual(aggregate);
  expect(await preserved()).toEqual(before);

  const [run] = await database
    .select({ shortcode: schema.run.shortcode })
    .from(schema.runFinding)
    .innerJoin(schema.run, eq(schema.run.id, schema.runFinding.runId))
    .where(eq(schema.runFinding.id, finding.id));
  if (!run) throw new Error("Reconciliation Run missing");
  const apply = page.getByRole("button", { name: "Apply fix", exact: true });
  await gotoAuthenticatedPage(
    page,
    `/runs/${run.shortcode}#import-findings`,
    apply,
  );
  await expect(apply).toHaveCount(1);
  await apply.click();
  await expect(
    page.getByText("Applied import correction", { exact: true }),
  ).toBeVisible();
  await expect(apply).toHaveCount(0);
  await expect(
    page.locator("#import-findings").getByText("applied", { exact: true }),
  ).toBeVisible();
  // A repeated apply of the same reviewed fingerprint is a no-op.
  expect(
    await send(
      "problems/resolveRunFinding",
      {
        id: finding.id,
        action: "apply",
        reviewedFingerprint: review.reviewedFingerprint,
      },
      resolveRunFindingOut,
    ),
  ).toEqual({ id: finding.id, status: "applied" });
  const productId = await resolveOrThrow(
    input.db,
    "product",
    input.productCode,
  );
  expect(await lines()).toMatchObject([{ cost: 42.5, productId }]);
  expect(await preserved()).toEqual(before);
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
    const party = await createEntityFixture(page, "ledgerParty", {
      name: `Synthetic reviewer ${token}`,
      kind: "member",
    });
    await setMemberLoginParty(
      db,
      actor.userId,
      parseShortcodeFor("ledgerParty", party.id),
      actor,
    );
    member = await currentMemberLedgerParty(db, actor);
  }
  if (!member) throw new Error("Authenticated reviewer member binding missing");
  const names = convergenceNames(token);
  const { productName, orderId } = names;
  const { vendor, card, location, category, productCategory } =
    await createConvergenceFixtures(
      (entity, overrides) => createEntityFixture(page, entity, overrides),
      member.shortcode,
      names,
    );
  const vendorId = await resolveOrThrow(db, "vendor", vendor.id);
  const cardId = await resolveOrThrow(db, "financialAccount", card.id);
  let bookedPurchaseCode: string | undefined;
  let retailerDone = false;
  let reconcileBookedAggregate = false;
  let productCode: string | undefined;
  let photoRunId: string | undefined;
  const post = async <Input, Output>(
    path: string,
    input: Input,
    output: { parse(value: unknown): Output },
  ): Promise<Output> => {
    const response =
      path === "photoImport/saveGroups"
        ? await startOperation(page.request, "photoImport.saveGroups", input)
        : await page.request.post(`/api/v1/${path}`, {
            data: input,
            headers: { Origin: baseURL },
          });
    expect(response.ok(), await response.text()).toBe(true);
    return output.parse(await response.json());
  };
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
    if (found && found.categoryId === null) {
      const classified = await entityApi(page.request).update(
        "product",
        found.shortcode,
        { categoryId: productCategory.id },
        { headers: { Origin: baseURL } },
      );
      expect(classified.ok(), await classified.text()).toBe(true);
    }
    productCode = found?.shortcode;
    return productCode;
  };

  let researchMail: Awaited<ReturnType<typeof ingestGmailEvidence>> | undefined;
  const gmail = async () => {
    researchMail = await ingestGmailEvidence(db, member!.id, names);
  };

  async function retailer() {
    // Source-order permutations enter at the importer as a member caller's
    // order; input-first journeys cover the extraction boundary.
    const html = names.retailerHtml;
    const committed = await importBrowserOrder(db, {
      actor,
      vendorId: vendor.id,
      ids: syntheticOrderIds(token),
      externalKey: `history:${orderId}`,
      checksum: sha256Hex(html),
      extractionRevision: "synthetic-browser@1",
      candidate: names.retailerCandidate,
      targetPurchaseId: bookedPurchaseCode,
      resolveProduct: readProduct,
    });
    // A booked statement aggregate is not replaced automatically: the receipt
    // waits as a reviewed reconciliation that settle() applies.
    if (bookedPurchaseCode)
      expect(committed.items[0]?.outcome).toBe("conflict");
    else
      expect(committed.items[0]?.outcome).toMatch(/created|updated|replayed/);
    reconcileBookedAggregate = Boolean(bookedPurchaseCode);
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
    const photos = wardrobePhotos(token);
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
    const jobs = await listDescribeImageJobs(db, imageIds);
    expect(jobs).toHaveLength(2);
    await completeDescribeImageJobs(
      db,
      jobs,
      `Synthetic own-item evidence for ${productName}`,
      (jobId) => describeJobDiagnostic(db, jobId),
    );

    await readProduct();
    await post(
      "photoImport/saveGroups",
      {
        runId: run.runId,
        groups: [
          shirtGroup(names, finalized, productCode, {
            locationId: location.id,
            categoryId: productCategory.id,
            ownerPartyId: member!.shortcode,
          }),
        ],
      },
      photoImportContract.ops.saveGroups.output,
    );
    await gotoAuthenticatedPage(
      page,
      `/runs/${run.runId}#work`,
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
    expect(
      reviewResponse.status(),
      reviewResponse.status() === 200
        ? undefined
        : scrubErrorMessage(await reviewResponse.text()),
    ).toBe(200);
    const review = photoRunReviewResponse.parse(await reviewResponse.json());
    productCode = review.review.proposals[0]?.committedProduct?.id;
    expect(productCode).toBeTruthy();
  }

  async function statement() {
    await gotoAuthenticatedPage(page, "/statement-rows/import");
    await page.getByLabel("Statement CSV file").setInputFiles({
      name: `${token}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(names.statementCsv),
    });
    await page
      .getByRole("checkbox", {
        name: `Record SYNTHETIC ORDER ${token}`,
        exact: true,
      })
      .check();
    await chooseOption(
      page,
      page.getByLabel(`Transaction kind for SYNTHETIC ORDER ${token}`, {
        exact: true,
      }),
      "purchase",
    );
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
        spendingCategoryId: null,
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
    await readProduct();
    if (!productCode) throw new Error("Reviewed photo Product missing");
    if (reconcileBookedAggregate)
      await applyReviewedSourceReconciliation(page, {
        db,
        baseURL,
        purchaseCode: bookedPurchaseCode!,
        productCode,
      });
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
    if (!researchMail) throw new Error("Retained mail research missing");
    await researchMail(purchase.shortcode);
    await gotoAuthenticatedPage(page, `/vendors/${vendor.id}`);
    const { rows: links } = await database.execute(sql`
      SELECT p.shortcode AS "purchaseCode"
      FROM "OrderMailCandidateDecision" d
      JOIN "OrderMailEvent" e ON e.id = d."eventId"
      JOIN "OrderMail" m ON m.id = e."orderMailId"
      JOIN "Email" email ON email."orderMailId" = m.id
        AND email."ledgerPartyId" = m."ledgerPartyId"
      JOIN "Purchase" p ON p.id = d."purchaseId"
      WHERE email."messageId" = ${names.messageId}
        AND email."deletedAt" IS NULL
        AND d.decision = 'linked'
    `);
    expect(links).toEqual([{ purchaseCode: purchase.shortcode }]);
    expect(purchase.shortcode).toBe(bookedPurchaseCode);
    return { purchaseCode: purchase.shortcode, productCode, photoRunId };
  }

  const projection = () =>
    convergenceProjection(db, names, {
      vendorId,
      cardId,
      memberId: member!.id,
      categoryShortcode: category.id,
    });
  return {
    sources: { gmail, retailer, photo, csv: statement },
    settle,
    projection,
    productName,
    orderId,
    openFindingCount: () => openFindingCount(db, vendorId),
  };
}
