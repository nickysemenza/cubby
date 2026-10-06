import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ActorContext } from "@cubby/schemas/context";
import { financialBookingInput } from "@cubby/schemas/financial-booking";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import {
  completeDescribeImageJobs,
  convergenceNames,
  convergenceProjection,
  createConvergenceFixtures,
  importBrowserOrder,
  ingestGmailEvidence,
  listDescribeImageJobs,
  productPhotos,
  shirtGroup,
  sha256Hex,
  syntheticOrderIds,
  wardrobePhotos,
} from "tooling/convergence-harness";
import { buildEntity } from "tooling/factories/build";
import {
  buildKernelContext,
  createFixtureWithContext,
} from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import * as schema from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import {
  approvePhotoGroupProposals,
  listPhotoGroupProposals,
  proposePhotoGroups,
} from "~/server/photo-import-run/proposals";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  commitFinancialBooking,
  previewFinancialBooking,
} from "~/server/repo/financial-booking";
import { updateImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import {
  currentMemberLedgerParty,
  setMemberLoginParty,
} from "~/server/repo/member-login";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { productionPhotoImportCommitPorts } from "~/server/services/photo-import-commit.service";
import { stagePhotoImport } from "~/server/services/photo-import-stage.service";
import { commitStatementCsv } from "~/server/statement-csv-import";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import { resolveRunFinding } from "./findings";
import { listVendorOrderMail } from "./gmail/review";
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

async function createConvergenceHarness(
  db: Database,
  actor: ActorContext,
  token: string,
) {
  const database = getDb(db);
  const kernel = buildKernelContext(db, actor.userId);
  const member = await ensureMember(db, actor);
  const names = convergenceNames(token);
  const { productName, orderId } = names;
  const { vendor, account, card, location, category, productCategory } =
    await createConvergenceFixtures(
      (entity, overrides) =>
        createFixtureWithContext(
          kernel,
          entity,
          buildEntity(entity, overrides),
        ),
      member.shortcode,
      names,
    );
  const vendorId = await resolveOrThrow(db, "vendor", vendor.id);
  const accountId = await resolveOrThrow(db, "vendorAccount", account.id);
  const cardId = await resolveOrThrow(db, "financialAccount", card.id);
  let bookedPurchaseCode: string | undefined;
  let retailerDone = false;
  let productCode: string | undefined;

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

  const gmail = () => ingestGmailEvidence(db, member.id, names);

  async function retailer() {
    const run = await startOrResumeRun(db, {
      ledgerPartyId: member.id,
      vendorAccountId: accountId,
      trigger: "manual",
    });
    const committed = await importBrowserOrder(db, {
      runId: run.id,
      actor,
      ids: syntheticOrderIds(token),
      externalKey: `history:${orderId}`,
      checksum: sha256Hex(names.retailerHtml),
      extractionRevision: "synthetic-browser@1",
      candidate: names.retailerCandidate,
      targetPurchaseId: bookedPurchaseCode,
      resolveProduct: readProduct,
    });
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
    const photos = wardrobePhotos(token, photoFixture);
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
    const jobs = await listDescribeImageJobs(db, imageIds);
    expect(jobs).toHaveLength(2);
    await completeDescribeImageJobs(
      db,
      jobs,
      `Synthetic own-item evidence for ${productName}`,
    );

    await readProduct();
    await proposePhotoGroups(db, {
      runId,
      groups: [
        shirtGroup(names, finalized, productCode, {
          locationId: location.id,
          categoryId: productCategory.id,
          ownerPartyId: member.shortcode,
        }),
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
      text: names.statementCsv,
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
    // Exact-order mail links itself to the Purchase without a member click,
    // whichever of the mail and the Purchase arrived first.
    const worklist = await listVendorOrderMail(db, { vendorId: vendor.id });
    const event = worklist.items
      .flatMap((item) => item.events)
      .find((row) => row.orderId === orderId);
    if (!event) throw new Error("Order mail event missing from worklist");
    expect(
      event.candidates.find((row) => row.purchaseId === purchase.shortcode)
        ?.decision,
    ).toBe("linked");
    expect(purchase.shortcode).toBe(bookedPurchaseCode);
    return { purchase, productCode };
  }

  return {
    sources: { gmail, retailer, photo, csv: statement },
    settle,
    projection: () =>
      convergenceProjection(db, names, {
        vendorId,
        cardId,
        memberId: member.id,
        categoryShortcode: category.id,
      }),
    productPhotos: (productShortcode: string) =>
      productPhotos(db, productShortcode),
    productName,
    orderId,
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
