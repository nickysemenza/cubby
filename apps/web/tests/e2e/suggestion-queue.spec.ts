import { eq, inArray } from "drizzle-orm";
import type { Page } from "@playwright/test";
import { productShortcode } from "@cubby/schemas/identifiers";

import { getDb } from "~/server/db/helpers";
import {
  feedback,
  product as productTable,
  assessmentState,
  expense as expenseTable,
  inventoryEntry,
  image as imageTable,
} from "~/server/db/schema";
import { publishEntityConnection } from "~/server/domains/connection/repo/entity-connections";
import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";
import { updateProduct } from "~/server/domains/product/repo/crud";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { assessRecommendation } from "~/server/generic/assessment/repo/assessment-recommendation";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createEntityFixture,
  createEvidenceHarnessContext,
} from "./fixtures/core";
import { seedUnimportedOrderMail } from "./fixtures/mail";
import {
  seedImagePrerequisite,
  attachProductImagePrerequisite,
} from "./fixtures/photos";
import { gotoAuthenticatedPage, uniqueName } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

async function seedTagProposal(page: Page, sourceId: string, tag: string) {
  const { db } = await createEvidenceHarnessContext(page);
  const donors = await Promise.all(
    [1, 2, 3].map((index) =>
      createEntityFixture(page, "product", {
        name: `Synthetic tag support ${index} ${crypto.randomUUID()}`,
        tags: [tag],
      }),
    ),
  );
  const records = await getDb(db)
    .select({
      id: productTable.id,
      shortcode: productTable.shortcode,
      updatedAt: productTable.updatedAt,
    })
    .from(productTable)
    .where(
      inArray(
        productTable.shortcode,
        [sourceId, ...donors.map((donor) => donor.id)].map((value) =>
          productShortcode.parse(value),
        ),
      ),
    );
  const source = records.find((record) => record.shortcode === sourceId);
  if (!source) throw new Error("Synthetic tag source missing");
  const supports = records.filter((record) => record.id !== source.id);
  const prediction = await assessRecommendation(
    db,
    sourceId,
    "product.tag-propagation",
    [tag],
    {
      tag,
      supportingProductCount: supports.length,
      supportingProductIds: supports.map((record) => record.shortcode),
      basis: {
        sourceRevision: source.updatedAt.toISOString(),
        supportingProducts: supports.map((record) => ({
          id: record.shortcode,
          revision: record.updatedAt.toISOString(),
        })),
      },
    },
  );
  return { prediction, supports };
}

// Failure modes: already-acted pending rows bury real proposals; non-actionable
// pairs become proposals; only the source endpoint exposes review; Wrong removes
// an automatic decision from its audit or silently changes imported data.
test("one queue separates proposals from automatic history and reviews either endpoint", async ({
  page,
  e2eRuntime,
}, testInfo) => {
  test.slow();
  const { db, actor } = await createEvidenceHarnessContext(page);
  const name = uniqueName(testInfo, "Synthetic queue drill");
  const item = await createEntityFixture(page, "product", {
    name,
    manufacturer: "Example Tools",
  });
  const cover = await seedImagePrerequisite(
    "synthetic-queue-cover",
    e2eRuntime.objectStorageUrl,
  );
  await attachProductImagePrerequisite(page, cover.id, item.id, "item");
  const other = await createEntityFixture(page, "product", {
    name: `${name} neighbour`,
  });
  const charge = await createEntityFixture(page, "expense", {
    name: `${name} receipt`,
    cost: 24,
    trade: "electrical",
  });
  const connection = await publishEntityConnection(db, {
    relation: "product-expense",
    source: { entityKind: "product", entityId: item.id },
    target: { entityKind: "expense", entityId: charge.id },
    label: "Synthetic acquisition connection",
    evidence: {
      reasons: ["Synthetic itemized evidence"],
      contradictions: [],
      unknowns: [],
    },
  });
  const pair = await publishProductPair(db, {
    productIds: [
      await resolveOrThrow(db, "product", item.id),
      await resolveOrThrow(db, "product", other.id),
    ],
    source: "agent",
    evidence: "Synthetic similarity without identity proof",
    sourceUrls: [],
    actionable: false,
  });
  const mail = await seedUnimportedOrderMail(
    page,
    uniqueName(testInfo, "Synthetic audit vendor"),
  );
  const source = mail.events[0];
  if (!source) throw new Error("Synthetic Email missing");
  const runId = await ensureRun(db, actor, { purpose: "ai_suggest" });
  const decision = await publishAssessment(db, {
    publicationKey: `synthetic-outcome:${source.emailId}`,
    family: "mail_import_outcome",
    subject: {
      kind: "mail_import_outcome",
      entity: "email",
      recordId: await resolveOrThrow(db, "email", source.emailId),
      checksum: source.checksum,
      runId,
    },
    judgment: {
      kind: "imported",
      lines: [{ name: "Synthetic packet", cost: 5 }],
      total: 5,
    },
    producer: {
      kind: "rule",
      model: null,
      revision: "synthetic/v1",
      runId,
      evaluationId: null,
    },
    fingerprint: source.checksum,
    evidence: null,
  });
  // Legacy predictions without application receipts remain visible as unverified,
  // even when they disagree with the Email's current classification.
  await publishAssessment(db, {
    publicationKey: `synthetic-legacy:${source.emailId}`,
    family: "email_relevance",
    subject: {
      kind: "email_relevance",
      entity: "email",
      recordId: await resolveOrThrow(db, "email", source.emailId),
      checksum: source.checksum,
      observationId: crypto.randomUUID(),
    },
    judgment: { classification: "unrelated", stage: "decision" },
    producer: null,
    fingerprint: source.checksum,
    evidence: null,
  });

  await gotoAuthenticatedPage(page, "/suggestions");
  const queue = page.getByRole("table", { name: "Suggestions", exact: true });
  await expect(
    queue
      .getByRole("row")
      .filter({ hasText: "Synthetic acquisition connection" }),
  ).toHaveCount(1);
  const pending = await listSuggestionPage(db, {});
  expect(pending.items.map((row) => row.assessmentId)).not.toContain(pair.id);
  expect(pending.items.map((row) => row.assessmentId)).not.toContain(
    decision.id,
  );
  await expect(
    page.getByRole("link", { name: new RegExp(name) }).first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("link", { name: new RegExp(name) }).first(),
  ).toBeVisible();
  // The resolved mobile identity must receive the name column's width rather
  // than yielding it to manufacturer metadata or keeping a compact link cap.
  expect(
    await page
      .getByText(name, { exact: true })
      .first()
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThan(150);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });

  const documentOrigin = await page.evaluate(() => performance.timeOrigin);
  await page
    .getByRole("link", { name: new RegExp(name) })
    .and(page.locator(`a[href="/products/${item.id}"]`))
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/products/${item.id}$`));
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    documentOrigin,
  );
  await expect(
    page.getByRole("region", { name: "Pending suggestions", exact: true }),
  ).toContainText("Synthetic acquisition connection");

  // Source detail and target list exercise both endpoints through the shared
  // review surface; repeating both presentations for each endpoint adds no write coverage.
  await gotoAuthenticatedPage(
    page,
    `/expenses?search=${encodeURIComponent(`${name} receipt`)}`,
  );
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name: `${name} receipt`, exact: true }),
  });
  await row
    .getByRole("button", { name: "1 pending suggestion", exact: true })
    .click();
  const review = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  await expect(review).toContainText("Synthetic acquisition connection");
  await review.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect
    .poll(async () =>
      (
        await getDb(db)
          .select()
          .from(feedback)
          .where(eq(feedback.assessmentId, connection.review.assessmentId))
      ).some((row) => row.verdict === "correct" && row.intent === "apply"),
    )
    .toBe(true);

  await gotoAuthenticatedPage(
    page,
    "/automatic-decisions?family=mail_import_outcome",
  );
  const audit = page.getByRole("region", {
    name: "Automatic decisions",
    exact: true,
  });
  await expect(audit).toContainText("Synthetic packet");
  await expect(
    audit.getByRole("link", { name: /Synthetic itemized confirmation/ }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });

  await page.setViewportSize({ width: 1440, height: 900 });
  await audit.getByRole("button", { name: "Wrong", exact: true }).click();
  await expect(
    audit.getByRole("button", { name: "Wrong", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(async () =>
      (
        await getDb(db)
          .select()
          .from(feedback)
          .where(eq(feedback.assessmentId, decision.id))
      ).some((row) => row.verdict === "wrong" && row.intent === "history"),
    )
    .toBe(true);
  await page.reload();
  await expect(audit).toContainText("Synthetic packet");
  await gotoAuthenticatedPage(
    page,
    `/automatic-decisions?family=email_relevance&record=${source.emailId}`,
  );
  await expect(audit).toContainText("Unverified application");
  await expect(audit).toContainText("unrelated");
});

// Replaces the transient project/placement reviewers: mounting is passive,
// each stored change needs confirmation, and a coalesced move follows its survivor.
test("project assignments and placement moves use the shared queue", async ({
  page,
}, testInfo) => {
  test.slow();
  const { db } = await createEvidenceHarnessContext(page);
  const project = await createEntityFixture(page, "project", {
    name: uniqueName(testInfo, "Synthetic workshop refresh"),
  });
  const expense = await createEntityFixture(page, "expense", {
    name: uniqueName(testInfo, "Synthetic supplies"),
    cost: 15,
    trade: "building",
  });
  const item = await createEntityFixture(page, "product", {
    name: uniqueName(testInfo, "Synthetic placement tool"),
  });
  const from = await createEntityFixture(page, "location", {
    name: uniqueName(testInfo, "Synthetic unplaced shelf"),
  });
  const to = await createEntityFixture(page, "location", {
    name: uniqueName(testInfo, "Synthetic target shelf"),
  });
  const source = await createEntityFixture(page, "inventory", {
    productId: item.id,
    locationId: from.id,
    amount: { value: 1, unit: "each" },
  });
  const target = await createEntityFixture(page, "inventory", {
    productId: item.id,
    locationId: to.id,
    amount: { value: 2, unit: "each" },
  });
  await publishEntityConnection(db, {
    relation: "expense-project",
    source: { entityKind: "expense", entityId: expense.id },
    target: { entityKind: "project", entityId: project.id },
    label: "Synthetic project assignment",
    evidence: {
      reasons: ["Synthetic dated work"],
      contradictions: [],
      unknowns: [],
    },
  });
  await publishEntityConnection(db, {
    relation: "inventory-location",
    source: { entityKind: "inventory", entityId: source.id },
    target: { entityKind: "location", entityId: to.id },
    label: "Synthetic placement move",
    evidence: {
      reasons: ["Synthetic stock destination"],
      contradictions: [],
      unknowns: [],
    },
  });
  const expenseId = await resolveOrThrow(db, "expense", expense.id);
  await gotoAuthenticatedPage(page, `/projects/${project.id}`);
  const proposals = page.getByRole("region", {
    name: "Pending suggestions",
    exact: true,
  });
  await expect(proposals).toContainText("Synthetic project assignment");
  expect(
    (
      await getDb(db)
        .select({ projectId: expenseTable.projectId })
        .from(expenseTable)
        .where(eq(expenseTable.id, expenseId))
    )[0]?.projectId,
  ).toBeNull();
  await proposals.getByRole("button", { name: "Confirm", exact: true }).click();
  const projectId = await resolveOrThrow(db, "project", project.id);
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ projectId: expenseTable.projectId })
            .from(expenseTable)
            .where(eq(expenseTable.id, expenseId))
        )[0]?.projectId,
    )
    .toBe(projectId);
  await gotoAuthenticatedPage(page, `/inventory/${source.id}`);
  await expect(proposals).toContainText("Synthetic placement move");
  await proposals.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/inventory/${target.id}$`));
  const targetId = await resolveOrThrow(db, "inventory", target.id);
  expect(
    (
      await getDb(db)
        .select({
          value: inventoryEntry.amountValue,
          unit: inventoryEntry.amountUnit,
        })
        .from(inventoryEntry)
        .where(eq(inventoryEntry.id, targetId))
    )[0],
  ).toEqual({ value: 3, unit: "each" });
});

// Failure modes retained from the retired Workbench: mounting applies a tag;
// an identity conflict offers merge; a pair loses its exact review identity;
// merge skips survivor/impact confirmation. Image acceptance must confirm the
// same stored description rather than regenerate a model result.
test("new proposal families require explicit review and preserve merge confirmation", async ({
  page,
  e2eRuntime,
}, testInfo) => {
  test.slow();
  const { db } = await createEvidenceHarnessContext(page);
  const first = await createEntityFixture(page, "product", {
    name: uniqueName(testInfo, "Synthetic matching drill"),
    manufacturer: "Example Tools",
    model: "SYN-DRILL-17",
  });
  const second = await createEntityFixture(page, "product", {
    name: uniqueName(testInfo, "Synthetic matching drill duplicate"),
    manufacturer: "Example Tools",
    model: "SYN-DRILL-17",
  });
  const conflicted = await createEntityFixture(page, "product", {
    name: uniqueName(testInfo, "Synthetic conflicting drill"),
    manufacturer: "Example Tools",
    model: "SYN-DRILL-29",
  });
  const firstId = await resolveOrThrow(db, "product", first.id);
  const secondId = await resolveOrThrow(db, "product", second.id);
  await publishProductPair(db, {
    productIds: [firstId, secondId],
    source: "agent",
    evidence: "Synthetic identical-model evidence",
    sourceUrls: [],
    actionable: true,
  });
  await publishProductPair(db, {
    productIds: [firstId, await resolveOrThrow(db, "product", conflicted.id)],
    source: "agent",
    evidence: "Synthetic conflicting-model evidence",
    sourceUrls: [],
    actionable: true,
    conflict: true,
  });
  const tagged = await createEntityFixture(page, "product", {
    name: uniqueName(testInfo, "Synthetic tag target"),
    tags: ["synthetic-existing"],
  });
  const taggedId = await resolveOrThrow(db, "product", tagged.id);
  const { prediction: tag } = await seedTagProposal(
    page,
    tagged.id,
    "synthetic-addition",
  );
  const picture = await seedImagePrerequisite(
    "synthetic-review-description",
    e2eRuntime.objectStorageUrl,
  );
  const [image] = await getDb(db)
    .select({ id: imageTable.id, sha256: imageTable.sha256 })
    .from(imageTable)
    .where(eq(imageTable.shortcode, picture.id));
  if (!image) throw new Error("Synthetic Image missing");
  const description = await publishAssessment(
    db,
    {
      publicationKey: `synthetic-description:${image.id}`,
      family: "image_description",
      subject: {
        kind: "image_description",
        entity: "image",
        recordId: image.id,
        contentHash: image.sha256,
      },
      judgment: "A synthetic drill on a plain workbench.",
      producer: null,
      fingerprint: image.sha256,
      evidence: null,
    },
    { suggestedValue: "A synthetic drill on a plain workbench." },
  );

  await gotoAuthenticatedPage(page, "/suggestions");
  const table = page.getByRole("table", { name: "Suggestions", exact: true });
  const tagRow = table
    .getByRole("row")
    .filter({ hasText: "Add tag synthetic-addition" });
  await expect(tagRow).toHaveCount(1);
  expect(
    (
      await getDb(db)
        .select({ tags: productTable.tags })
        .from(productTable)
        .where(eq(productTable.id, taggedId))
    )[0]?.tags,
  ).toEqual(["synthetic-existing"]);
  await tagRow.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ tags: productTable.tags })
            .from(productTable)
            .where(eq(productTable.id, taggedId))
        )[0]?.tags,
    )
    .toEqual(["synthetic-existing", "synthetic-addition"]);
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ status: assessmentState.status })
            .from(assessmentState)
            .where(eq(assessmentState.id, tag.assessmentId))
        )[0]?.status,
    )
    .toBe("applied");

  const imageRow = table
    .getByRole("row")
    .filter({ hasText: "A synthetic drill on a plain workbench." });
  await imageRow.getByRole("button", { name: "Accept", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ confirmedValue: assessmentState.confirmedValue })
            .from(assessmentState)
            .where(eq(assessmentState.id, description.id))
        )[0]?.confirmedValue,
    )
    .toEqual({
      present: true,
      value: "A synthetic drill on a plain workbench.",
    });

  const conflictRow = table
    .getByRole("row")
    .filter({ hasText: "Synthetic conflicting-model evidence" });
  await expect(
    conflictRow.getByRole("button", { name: "Review merge", exact: true }),
  ).toHaveCount(0);
  await gotoAuthenticatedPage(
    page,
    `/suggestions?family=product_pair&record=product:${second.id}`,
  );
  await page.getByRole("button", { name: "Review merge", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Keep (target):", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await getDb(db)
            .select({ deletedAt: productTable.deletedAt })
            .from(productTable)
            .where(
              eq(
                productTable.id,
                await resolveOrThrow(db, "product", conflicted.id),
              ),
            )
        )[0]?.deletedAt,
    )
    .toBeNull();
  const merged = await getDb(db)
    .select({ deletedAt: productTable.deletedAt })
    .from(productTable)
    .where(inArray(productTable.id, [firstId, secondId]));
  expect(merged.filter((row) => row.deletedAt !== null)).toHaveLength(1);
  expect(merged.filter((row) => row.deletedAt === null)).toHaveLength(1);
});

// Persisted tag votes must not authorize an apply after their supporting facts change.
test("a stored tag Suggestion refuses changed supporting evidence", async ({
  page,
}, testInfo) => {
  const { db, actor } = await createEvidenceHarnessContext(page);
  const source = await createEntityFixture(page, "product", {
    name: uniqueName(testInfo, "Synthetic stale tag target"),
    tags: [],
  });
  const { supports } = await seedTagProposal(
    page,
    source.id,
    "synthetic-stale-tag",
  );
  const donor = supports[0];
  if (!donor) throw new Error("Synthetic tag support missing");
  await gotoAuthenticatedPage(page, `/suggestions?record=product:${source.id}`);
  const row = page
    .getByRole("row")
    .filter({ hasText: "Add tag synthetic-stale-tag" });
  await expect(row).toHaveCount(1);
  await updateProduct(db, donor.id, { tags: [] }, actor);
  await row.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("main")).toContainText(
    "Tag proposal evidence changed; find suggestions again",
  );
  expect(
    (
      await getDb(db)
        .select({ tags: productTable.tags })
        .from(productTable)
        .where(eq(productTable.shortcode, productShortcode.parse(source.id)))
    )[0]?.tags,
  ).toEqual([]);
});
