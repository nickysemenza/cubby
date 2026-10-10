import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  financialBookingPreview,
  financialBookingResult,
} from "@cubby/schemas/financial-booking";

import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import { photoRunReviewResponse } from "@cubby/schemas/photo-import-run";

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
} from "../../tooling/convergence-harness";
import { gotoAuthenticatedPage } from "./e2e-helpers";
import { expect } from "./e2e-test";

type EvidenceSource = "gmail" | "retailer" | "photo" | "csv";
/** Cyclic shifts of one order: every source arrives in every position once and
 * every ordered pair occurs, so each browser path is exercised first, last and
 * after each other source. All 24 orders run in the PostgreSQL tier, which
 * costs a fraction of the browser time each order takes here. The first row
 * carries the Problems-sample regression in the spec. */
export const BROWSER_SOURCE_ORDERS = [
  ["csv", "photo", "retailer", "gmail"],
  ["photo", "retailer", "gmail", "csv"],
  ["retailer", "gmail", "csv", "photo"],
  ["gmail", "csv", "photo", "retailer"],
] as const satisfies readonly (readonly EvidenceSource[])[];

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
  let productCode: string | undefined;
  let photoRunId: string | undefined;
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
      const classified = await page.request.patch(
        `/api/v1/products/${found.shortcode}`,
        {
          headers: { Origin: baseURL },
          data: { categoryId: productCategory.id },
        },
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
      ids: syntheticOrderIds(token),
      externalKey: `history:${orderId}`,
      checksum: sha256Hex(html),
      extractionRevision: "synthetic-browser@1",
      candidate: names.retailerCandidate,
      targetPurchaseId: bookedPurchaseCode,
      resolveProduct: readProduct,
    });
    expect(committed.items[0]?.outcome).toMatch(/created|updated|replayed/);
    if (bookedPurchaseCode) {
      await gotoAuthenticatedPage(
        page,
        `/runs/${committed.runId}#import-findings`,
      );
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
      await expect(apply).toHaveCount(0);
      await expect(
        page.locator("#import-findings").getByText("applied", { exact: true }),
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
      JOIN "Purchase" p ON p.id = d."purchaseId"
      WHERE m."messageId" = ${names.messageId} AND d.decision = 'linked'
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
