import assert from "node:assert/strict";
import { expect } from "e2e";
import { z } from "zod";
import { pollUntil } from "@cubby/shared/retry";
import { photoRunReviewResponse } from "@cubby/schemas/photo-import-run";
import { mailReadOut } from "@cubby/schemas/mailbox-research";
import { emailPurchaseLink } from "@cubby/schemas/email-fields";
import { importTest as test, outcome, readFields } from "./journey.fixtures";

test("wardrobe upload processes images, proposes items and commits only approved groups", async ({
  data,
  agent,
  screen,
}) => {
  const { photo } = data.scenarios();
  await data.open(`/runs/${photo.runId}`);
  const review = () =>
    data
      .operation("photoImport.review", { runId: photo.runId })
      .then((value) => photoRunReviewResponse.parse(value));
  const grouped = await pollUntil(
    async () => {
      const current = await review();
      assert(
        !current.images.some((image) => image.describe === "failed"),
        `Photo descriptions failed: ${JSON.stringify(current.images.map(({ id, describe, describeReason }) => ({ id, describe, describeReason })))}`,
      );
      return current.review.proposals.length === photo.groups.length
        ? current
        : undefined;
    },
    { label: "real photo description and grouping Jobs", timeoutMs: 120_000 },
  );
  outcome(
    {
      processed: photo.groups.map((group) => {
        const image = grouped.images.find((item) => item.id === group.imageId);
        return {
          id: group.imageId,
          ready: image?.describe === "ready",
          described: Boolean(image?.description?.trim()),
        };
      }),
    },
    {
      processed: photo.groups.map((group) => ({
        id: group.imageId,
        ready: true,
        described: true,
      })),
    },
  );
  for (const group of photo.groups) {
    const products = (await data.list("product")).map((row) =>
      readFields(row, ["name"]),
    );
    outcome(
      { created: products.some((row) => row.name === group.name) },
      { created: false },
    );
  }
  const [first, second] = photo.groups;
  assert(first && second, "The wardrobe fixture requires two distinct items");
  await agent.act(
    `Open the wardrobe item "${first.name}" and approve it using its individual Create product and add 1 action. Finish when that item shows Applied. Leave the other item unapproved.`,
  );
  const partlyApproved = await review();
  outcome(
    {
      states: partlyApproved.review.proposals
        .map((proposal) => ({ key: proposal.groupKey, state: proposal.state }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    },
    {
      states: [
        { key: first.groupKey, state: "committed" },
        { key: second.groupKey, state: "proposed" },
      ].sort((a, b) => a.key.localeCompare(b.key)),
    },
  );
  await agent.act(
    `Select the remaining item named "${second.name}" and approve it using batch approval. Finish when both items show Applied.`,
  );
  const completed = await pollUntil(
    async () => {
      const current = await review();
      return current.review.runStatus === "completed" ? current : undefined;
    },
    { label: "approved wardrobe Run completion", timeoutMs: 60_000 },
  );
  outcome(
    {
      count: completed.review.proposals.length,
      completedImages: completed.images.filter(
        (image) => image.targetState === "completed",
      ).length,
      states: completed.review.proposals.map((proposal) => proposal.state),
    },
    { count: 2, completedImages: 2, states: ["committed", "committed"] },
  );
  for (const group of photo.groups) {
    const proposal = completed.review.proposals.find(
      (item) => item.groupKey === group.groupKey,
    );
    assert(
      proposal?.committedProduct && proposal.committedInventoryId,
      "Approval must publish a Product and Inventory entry",
    );
    const product = await data.fields("product", proposal.committedProduct.id, [
      "name",
      "images",
    ]);
    const images = z
      .object({ images: z.array(z.object({ id: z.string() })) })
      .parse(product).images;
    outcome(
      { name: product.name, photos: images.map((image) => image.id) },
      { name: group.name, photos: [group.imageId] },
    );
    outcome(
      await data.fields("inventory", proposal.committedInventoryId, ["amount"]),
      { amount: { value: 1, unit: "each" } },
    );
  }
  await expect(screen.getByText(first.name).first()).toBeVisible();
});

test("saved order import preserves source identity, dates, money and the unselected shipping Email", async ({
  data,
  agent,
}) => {
  const { mail } = data.scenarios();
  const source = z
    .object({ checksum: z.string() })
    .parse(await data.fields("email", mail.emailId, ["checksum"]));
  await data.open(`/emails/${mail.emailId}`);
  await agent.act(
    "Import the displayed saved order Email. Stop once its import is started.",
  );
  const importedEmail = z
    .object({ runId: z.string() })
    .parse(await data.fields("email", mail.emailId, ["runId"]));
  await data.open(`/runs/${importedEmail.runId}`);
  await pollUntil(
    async () => {
      const run = z
        .object({ status: z.string(), stepFailures: z.array(z.unknown()) })
        .parse(
          await data.operation("run.workSnapshot", {
            runId: importedEmail.runId,
          }),
        );
      assert(
        !["failed", "dispatch_failed"].includes(run.status),
        `Order import failed: ${JSON.stringify(run.stepFailures)}`,
      );
      return run.status === "completed" ? run : undefined;
    },
    { label: "real order import coordinator and writer", timeoutMs: 120_000 },
  );
  const purchases = (await data.list("purchase"))
    .map((value) =>
      z
        .object({
          id: z.string(),
          orderId: z.string().nullable(),
          vendorId: z.string(),
          date: z.string().nullable(),
        })
        .parse(readFields(value, ["id", "orderId", "vendorId", "date"])),
    )
    .filter((purchase) => purchase.vendorId === mail.vendorId);
  outcome(
    {
      count: purchases.length,
      purchases: purchases.map(({ orderId, date }) => ({ orderId, date })),
    },
    { count: 1, purchases: [{ orderId: mail.orderId, date: "2026-09-10" }] },
  );
  const [purchase] = purchases;
  assert(purchase, "The imported purchase must exist");
  const accepted = mailReadOut.pick({ acceptedSourceOrders: true }).parse(
    await data.operation("purchaseImport.mailRead", {
      mailboxId: mail.mailboxId,
      messageId: mail.messageId,
    }),
  );
  outcome(
    {
      count: accepted.acceptedSourceOrders.length,
      sources: accepted.acceptedSourceOrders,
    },
    {
      count: 1,
      sources: [
        {
          purchaseId: purchase.id,
          purchaseDeleted: false,
          source: {
            kind: "mail_message",
            externalKey: `gmail:${mail.mailboxId}:${mail.messageId}`,
            checksum: source.checksum,
          },
        },
      ],
    },
  );
  // Run completion precedes asynchronous publication of materialized Email facts.
  const links = await pollUntil(
    async () => {
      const current = z
        .object({ purchaseLinks: z.array(emailPurchaseLink) })
        .parse(await data.fields("email", mail.emailId, ["purchaseLinks"]))
        .purchaseLinks.filter((link) => link.accepted);
      return current.some((link) => link.purchaseId === purchase.id)
        ? current
        : undefined;
    },
    { label: "published accepted Email purchase links", timeoutMs: 60_000 },
  );
  outcome(
    { count: links.length, links },
    {
      count: 1,
      links: [
        {
          purchaseId: purchase.id,
          state: "linked",
          accepted: true,
          changedSinceReview: false,
        },
      ],
    },
  );
  outcome(
    await data.sourceAcceptance(mail.emailId, purchase.id, source.checksum),
    { count: 1, attributedToMember: true, sourceMatches: true },
  );
  outcome(await data.fields("email", mail.emailId, ["checksum", "linked"]), {
    checksum: source.checksum,
    linked: true,
  });
  const lines = (await data.list("expense"))
    .map((value) =>
      z
        .object({
          purchaseId: z.string().nullable(),
          cost: z.number().nullable(),
          name: z.string(),
          productId: z.string().nullable(),
        })
        .parse(readFields(value, ["purchaseId", "cost", "name", "productId"])),
    )
    .filter((line) => line.purchaseId === purchase.id);
  outcome(
    {
      count: lines.length,
      lines: lines.map(({ name, cost }) => ({ name, cost })),
    },
    { count: 1, lines: [{ name: mail.itemName, cost: 5 }] },
  );
  const [line] = lines;
  assert(line?.productId, "Imported line must name its Product");
  const ids = z
    .object({ externalIds: z.array(z.object({ url: z.string().nullable() })) })
    .parse(await data.fields("product", line.productId, ["externalIds"]));
  outcome(
    {
      sourceLinkRetained: ids.externalIds.some(
        (id) => id.url === mail.productUrl,
      ),
    },
    { sourceLinkRetained: true },
  );
  outcome(await data.fields("email", mail.shippingEmailId, ["runId"]), {
    runId: null,
  });
});

test("browsing Email metadata never admits an import", async ({
  data,
  agent,
  screen,
  browser,
}) => {
  const { navigationEmailId } = data.scenarios();
  const purchaseCount = (await data.list("purchase")).length;
  const before = await data.fields("email", navigationEmailId, [
    "checksum",
    "classification",
    "status",
    "runId",
  ]);
  await data.open(`/emails/${navigationEmailId}`);
  await agent.act(
    "Navigate to the Emails list using the workspace navigation. Leave all Emails unchanged.",
  );
  await expect(browser).toHaveURL(/\/emails(?:\?.*)?$/);
  await agent.act(
    'Open the Email named "Synthetic Email navigation receipt" without starting an import.',
  );
  await expect(
    screen.getByRole("heading", "Synthetic Email navigation receipt"),
  ).toBeVisible();
  outcome(
    { purchaseCount: (await data.list("purchase")).length },
    { purchaseCount },
  );
  outcome(
    await data.fields("email", navigationEmailId, [
      "checksum",
      "classification",
      "status",
      "runId",
    ]),
    z.record(z.string(), z.json()).parse(before),
  );
});

test("Run progress is visible and dismissing a finding persists member resolution", async ({
  data,
  screen,
}) => {
  const { console: run } = data.scenarios();
  await data.open(`/runs/${run.runId}`);
  await expect(screen.getByText("Reading synthetic orders")).toBeVisible();
  await data.open("/problems#import-findings");
  await expect(screen.getByText("Synthetic finding to resolve")).toBeVisible();
  await screen
    .getByRole("listitem")
    .filter({ hasText: "Synthetic finding to resolve" })
    .getByRole("button", "Dismiss")
    .click();
  await expect(screen.getByText("Synthetic finding to resolve")).toBeHidden();
  const snapshot = z
    .object({
      findings: z.array(z.object({ id: z.string(), status: z.string() })),
    })
    .parse(await data.operation("run.workSnapshot", { runId: run.runId }));
  const finding = snapshot.findings.find((item) => item.id === run.findingId);
  outcome({ finding }, { finding: { id: run.findingId, status: "dismissed" } });
});
