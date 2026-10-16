import { eq } from "drizzle-orm";

import {
  email,
  entityAttachment,
  image,
  product,
  run,
} from "~/server/db/schema";
import { getDb } from "~/server/db/helpers";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  chooseOption,
  gotoAuthenticatedPage,
  inlineExplanation,
  uniqueName,
} from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";
import { seedProductPrerequisite } from "./fixtures/catalog";
import {
  ensureMemberParty,
  fixtureUserId,
  getFixtureDb,
} from "./fixtures/core";
import { seedUnimportedOrderMail } from "./fixtures/mail";
import { seedImagePrerequisite } from "./fixtures/photos";

// Failure modes: a member filter widens to shared work, filtering runs only on
// the loaded page, URL state is lost on reload, a queue row loses its source,
// or changing routing keeps a selection from the previous result set.
test("Work queue filters routing before paging and opens its source record", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(60_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 900 });
  const prefix = uniqueName(testInfo, "Queue routing");
  const member = await ensureMemberParty(page, prefix);
  const mail = await seedUnimportedOrderMail(page, prefix);
  const db = getFixtureDb();
  const [owned] = await getDb(db)
    .update(email)
    .set({ subject: `${prefix} owned mail` })
    .where(eq(email.checksum, mail.checksum))
    .returning();
  if (!owned) throw new Error("Synthetic owned email is missing");
  const unresolved = await insertWithShortcode(db, "financialAccount", {
    name: `${prefix} unresolved account`,
    provisional: true,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    ledgerPartyId: null,
  });
  const shared = await seedProductPrerequisite(page, {
    name: `${prefix} shared product`,
  });
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(prefix)}&pageSize=1&waitingFor=either`,
  );
  const product = page
    .getByRole("link", {
      name: `${prefix} shared product`,
      exact: true,
    })
    .first();
  await expect(product).toHaveAttribute("href", `/products/${shared.id}`);
  // One record can need both repair and research. Copy its code once, along
  // with the shared vendor's logo task even before it has a purchase.
  await expect(
    page.getByRole("table").getByRole("link", {
      name: `${prefix} shared product`,
      exact: true,
    }),
  ).toHaveCount(2);
  await page.getByRole("checkbox", { name: "Select all", exact: true }).check();
  await page.getByRole("button", { name: "Copy codes", exact: true }).click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText()))
        .split("\n")
        .sort(),
    )
    .toEqual([shared.id, mail.vendor.shortcode].sort());
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  // Waiting for is any-of: swap the one picked choice, then Apply. A choice
  // is its option label and its chip summary.
  type Choice = { option: string; chip: string };
  const either: Choice = { option: "Either", chip: "Either" };
  const noValue: Choice = { option: "No value", chip: "no value" };
  const picked: Choice = { option: member.name, chip: member.name };
  const chooseWaitingFor = async (from: Choice, to: Choice) => {
    await page
      .getByRole("button", { name: `Waiting for: ${from.chip}`, exact: true })
      .click();
    const search = page.getByRole("combobox", {
      name: "Filter Waiting for",
      exact: true,
    });
    for (const { option } of [from, to]) {
      await search.fill(option);
      await page.getByRole("option", { name: option, exact: true }).click();
    }
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(
      page.getByRole("button", {
        name: `Waiting for: ${to.chip}`,
        exact: true,
      }),
    ).toBeVisible();
  };
  await chooseWaitingFor(either, picked);
  await expect(product).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy codes", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: `${prefix} owned mail`, exact: true }),
  ).toHaveAttribute("href", `/emails/${owned.shortcode}`);
  await expect(page).toHaveURL(new RegExp(`waitingFor=${member.shortcode}`));
  await page.reload();
  await expect(
    page.getByRole("button", {
      name: `Waiting for: ${member.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await chooseWaitingFor(picked, noValue);
  await expect(
    page.getByRole("link", {
      name: `${prefix} unresolved account`,
      exact: true,
    }),
  ).toHaveAttribute("href", `/financial-accounts/${unresolved.shortcode}`);
  await expect(
    page.getByRole("link", { name: `${prefix} owned mail`, exact: true }),
  ).toHaveCount(0);
  await chooseWaitingFor(noValue, either);
  await expect(
    page.getByRole("combobox", { name: "Rows per page", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 402, height: 874 });
  await expect(product).toHaveAttribute("href", `/products/${shared.id}`);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await product.click();
  await expect(page).toHaveURL(`/products/${shared.id}`);
});

// Failure modes: later pages replace earlier rows, sorting orders only loaded
// rows, a checkbox opens the inspector, copied codes are queue keys, or changing
// filters leaves an executable selection from the previous result set.
test("Work queue scrolls, sorts, copies source codes and inspects independently", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  const prefix = uniqueName(testInfo, "Queue table parity");
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"];
  names.push(...Array.from({ length: 24 }, (_, i) => `Between ${i}`));
  const records = [];
  for (const suffix of names) {
    records.push(
      await seedProductPrerequisite(page, { name: `${prefix} ${suffix}` }),
    );
  }
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(prefix)}&source=research&sort=-name`,
  );
  const table = page.getByRole("table");
  const first = table.getByRole("row").filter({
    has: page.getByRole("link", { name: `${prefix} Foxtrot`, exact: true }),
  });
  await first
    .getByRole("checkbox", { name: "Select row", exact: true })
    .check();
  await expect(
    page.getByRole("complementary", { name: "Product inspector" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Copy codes", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(records[5]?.id);
  await expect(
    first.getByRole("checkbox", { name: "Select row", exact: true }),
  ).toBeChecked();
  await first.getByRole("cell", { name: "Product", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Product inspector" }),
  ).toBeVisible();
  await expect(
    first.getByRole("checkbox", { name: "Select row", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Close inspector", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Work queue keyboard navigation" })
    .evaluate((pane) => {
      pane.scrollTop = pane.scrollHeight;
    });
  await expect(
    table.getByRole("link", { name: `${prefix} Alpha`, exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: `${prefix} Foxtrot`, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(table.getByRole("link").first()).toHaveText(`${prefix} Foxtrot`);
  await table
    .getByRole("button", { name: "Sort by Record", exact: true })
    .click();
  await table
    .getByRole("button", { name: "Sort by Record", exact: true })
    .click();
  await expect(table.getByRole("link").first()).toHaveText(`${prefix} Alpha`);
  await expect(page).toHaveURL(/sort=name/);
  await table
    .getByRole("row")
    .filter({
      has: page.getByRole("link", { name: `${prefix} Alpha`, exact: true }),
    })
    .getByRole("checkbox", { name: "Select row", exact: true })
    .check();
  // Shared tables replace filter controls with the selection bar. A bookmarked
  // filter navigation must still clear the selection from its prior scope.
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(`${prefix} Alpha`)}&source=research&sort=name`,
  );
  await expect(
    table.getByRole("link", { name: `${prefix} Bravo`, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy codes", exact: true }),
  ).toHaveCount(0);
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(prefix)}&source=research&sort=reason&page=4&pageSize=2`,
  );
  await expect(table.getByRole("link").first()).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]page(?:Size)?=/);
});

// Run detail currently recovers pending execution on a read. Queue navigation
// must stay on the passive Problems surface until that detail contract is fixed.
test("Work queue Run navigation stays on passive Problems", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Queue paused account");
  const member = await ensureMemberParty(page, name);
  const db = getFixtureDb();
  const paused = await insertWithShortcode(db, "run", {
    ledgerPartyId: member.id,
    actorUserId: await fixtureUserId(page),
    actorName: "Synthetic member",
    actorEmail: "synthetic@example.test",
    actorLedgerPartyShortcode: member.shortcode,
    actorLedgerPartyName: member.name,
    actorLedgerPartyKind: "member",
    purpose: "account_sync",
    trigger: "manual",
    status: "paused_auth",
    agentSessionId: name,
  });
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${paused.shortcode}&source=account`,
  );
  const source = page.getByRole("link", {
    name: "account_sync · paused_auth",
    exact: true,
  });
  await expect(source).toHaveAttribute("href", "/problems");
  const runDetailReads: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes(`/runs/${paused.shortcode}`))
      runDetailReads.push(request.url());
  });
  await source.click();
  await expect(page).toHaveURL("/problems");
  expect(runDetailReads).toEqual([]);
  const saved = await getDb(db).query.run.findFirst({
    where: eq(run.id, paused.id),
  });
  expect(saved?.status).toBe("paused_auth");
});

// Failure modes: the queue sits inside a contained gutter instead of reaching
// the workbench edges, a source record loses its thumbnail, categorical values
// lose their labels, or the rule's next action disappears with its column.
test("Work queue rows show the source record's image, type and next action", async ({
  page,
  e2eRuntime,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = uniqueName(testInfo, "Queue pictured product");
  const seeded = await seedProductPrerequisite(page, { name });
  const picture = await seedImagePrerequisite(
    `queue-thumb-${Date.now()}`,
    e2eRuntime.objectStorageUrl,
  );
  const db = getDb(getFixtureDb());
  const [owner] = await db
    .select({ id: product.id })
    .from(product)
    .where(eq(product.shortcode, seeded.id));
  const [stored] = await db
    .select({ id: image.id })
    .from(image)
    .where(eq(image.shortcode, picture.id));
  if (!owner || !stored) throw new Error("Synthetic queue image is missing");
  await db.insert(entityAttachment).values({
    entityId: owner.id,
    entityKind: "product",
    purpose: "item",
    role: "cover",
    imageId: stored.id,
  });
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(name)}&source=research`,
  );
  const record = page.getByRole("link", { name, exact: true });
  const row = page.getByRole("row").filter({ has: record });
  await expect
    .poll(() =>
      row
        .getByRole("img", { name: "Image", exact: true })
        .evaluate(
          (node) => node instanceof HTMLImageElement && node.naturalWidth > 0,
        ),
    )
    .toBe(true);
  await expect(
    row.getByRole("cell", { name: "Product", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("cell", { name: "Research", exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("columnheader", { name: "Next action", exact: true }),
  ).toHaveCount(0);
  // Research rows replace the reason with the record's current gaps; the
  // rule's next action stays as the reason's description.
  await expect(
    row.getByTitle("Review missing facts and add verified evidence.", {
      exact: true,
    }),
  ).toBeVisible();
  const table = await page.getByRole("table").boundingBox();
  const main = await page.getByRole("main").boundingBox();
  expect(table && main && main.width - table.width).toBeLessThanOrEqual(2);
});

// Failure mode: the record strip keeps a gap the person just resolved on the
// same page, because the queue read is not refreshed by record writes.
test("Record Work queue strip drops a gap as soon as it is accepted", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = uniqueName(testInfo, "Queue strip refresh");
  const product = await seedProductPrerequisite(page, {
    name,
    manufacturer: "(unspecified)",
  });
  await gotoAuthenticatedPage(page, `/products/${product.id}`);
  const strip = page.getByRole("region", { name: "Work queue", exact: true });
  await expect(strip).toContainText("Manufacturer is not recorded.");
  const explanation = page.getByRole("button", {
    name: /How manufacturer is determined/,
  });
  await explanation.click();
  const inline = await inlineExplanation(page, explanation);
  await inline.getByRole("button", { name: "Accept as…" }).click();
  await chooseOption(page, inline.getByLabel("Reason"), "Not applicable");
  await inline
    .getByLabel("Note")
    .fill("Synthetic item has no manufacturer on its packaging.");
  await inline.getByRole("button", { name: "Accept exception" }).click();
  await expect(strip).not.toContainText("Manufacturer is not recorded.");
  await expect(strip).toContainText(
    "No model or external identifier is recorded.",
  );
});
