import { eq } from "drizzle-orm";
import { agentConversationSchema } from "@cubby/schemas/agent-conversation";

import { email, run } from "~/server/db/schema";
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
    page
      .getByRole("table", { name: "Work queue", exact: true })
      .getByRole("link", {
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
  // Waiting for is any-of: swap the one picked choice, live. A choice
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
    // Unpicking `from` first empties the filter; the chip's editor stays.
    // A short roster lists inline without a search field.
    for (const { option } of [from, to]) {
      if ((await search.count()) > 0 && (await search.isEditable()))
        await search.fill(option);
      await page.getByRole("option", { name: option, exact: true }).click();
    }
    // Edits apply live, so the editor stays open until dismissed; the next
    // chip click must open it, not toggle it shut.
    await page.keyboard.press("Escape");
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
  const list = page.getByRole("table", { name: "Work queue", exact: true });
  const first = list.getByRole("row").filter({
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
  await first.getByText("Product", { exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Product inspector" }),
  ).toBeVisible();
  await expect(
    first.getByRole("checkbox", { name: "Select row", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "Close inspector", exact: true })
    .click();
  // Scrolling the page to the last loaded row pulls the next page.
  await expect(async () => {
    await list.getByRole("row").last().scrollIntoViewIfNeeded();
    await expect(
      list.getByRole("link", { name: `${prefix} Alpha`, exact: true }),
    ).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(
    list.getByRole("link", { name: `${prefix} Foxtrot`, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(list.getByRole("link").first()).toHaveText(`${prefix} Foxtrot`);
  await page.getByRole("button", { name: /^Sort: Record/ }).click();
  await page.getByRole("menuitem", { name: "Ascending", exact: true }).click();
  await expect(list.getByRole("link").first()).toHaveText(`${prefix} Alpha`);
  await expect(page).toHaveURL(/sort=name/);
  await list
    .getByRole("row")
    .filter({
      has: page.getByRole("link", { name: `${prefix} Alpha`, exact: true }),
    })
    .getByRole("checkbox", { name: "Select row", exact: true })
    .check();
  // A bookmarked filter navigation must clear the selection from its prior
  // scope.
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(`${prefix} Alpha`)}&source=research&sort=name`,
  );
  await expect(
    list.getByRole("link", { name: `${prefix} Bravo`, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Copy codes", exact: true }),
  ).toHaveCount(0);
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(prefix)}&source=research&sort=reason&page=4&pageSize=2`,
  );
  await expect(list.getByRole("link").first()).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]page(?:Size)?=/);
});

// Failure mode: following a Run or observing it again recovers pending execution
// instead of reading retained state, changing dispatch or starting an agent.
test("Work queue Run navigation reads passive retained details", async ({
  page,
}, testInfo) => {
  const name = uniqueName(testInfo, "Queue paused account");
  const member = await ensureMemberParty(page, name);
  const db = getFixtureDb();
  const dispatchEventId = crypto.randomUUID();
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
    dispatchEventId,
  });
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${paused.shortcode}&source=account`,
  );
  const source = page.getByRole("link", {
    name: "account_sync · paused_auth",
    exact: true,
  });
  await expect(source).toHaveAttribute("href", `/runs/${paused.shortcode}`);
  const savedBefore = await getDb(db).query.run.findFirst({
    where: eq(run.id, paused.id),
  });
  expect(savedBefore).toMatchObject({
    status: "paused_auth",
    dispatchEventId,
    coordinatorStartedAt: null,
  });
  const agentWrites: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith(
        `/api/import/runs/${paused.shortcode}/agent`,
      ) &&
      request.method() !== "GET"
    )
      agentWrites.push(`${request.method()} ${request.url()}`);
  });
  await source.click();
  await expect(page).toHaveURL(`/runs/${paused.shortcode}`);
  const absent = page.getByText(
    "The agent conversation is not available yet.",
    { exact: false },
  );
  await expect(absent).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Agent prompt" }),
  ).toBeDisabled();
  await page.reload();
  await expect(absent).toBeVisible();
  const conversation = await page.request.get(
    `/api/import/runs/${paused.shortcode}/agent`,
  );
  expect(conversation.ok(), await conversation.text()).toBe(true);
  expect(agentConversationSchema.parse(await conversation.json())).toEqual({
    status: "absent",
    messages: [],
    settlements: [],
  });
  expect(agentWrites).toEqual([]);
  const saved = await getDb(db).query.run.findFirst({
    where: eq(run.id, paused.id),
  });
  expect(saved).toEqual(savedBefore);
});

// Failure modes: the queue sits inside a contained gutter instead of reaching
// the workbench edges, a row loses its record type, Details loses the next
// action the row no longer repeats, or keyboard activation of Details bubbles
// to the row's inspector/navigation handler.
test("Work queue rows show the source record's type and action details", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const name = uniqueName(testInfo, "Queue research product");
  await seedProductPrerequisite(page, { name });
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(name)}&source=research`,
  );
  const record = page.getByRole("link", { name, exact: true });
  const row = page.getByRole("row").filter({ has: record });
  await expect(row.getByText("Product", { exact: true })).toBeVisible();
  const queueUrl = page.url();
  const details = row.getByRole("button", {
    name: "Action details",
    exact: true,
  });
  for (const key of ["Enter", "Space"]) {
    await details.focus();
    await page.keyboard.press(key);
    const dialog = page.getByRole("dialog", {
      name: "Action details",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Claude / Codex");
    await expect(dialog).toContainText(
      "Record verified facts or a supported data exception. Review the proposed fields before applying.",
    );
    await expect(page).toHaveURL(queueUrl);
    await expect(
      page.getByRole("complementary", { name: "Product inspector" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  // A full-width table reaching the workbench edges, not a contained column.
  const list = await page
    .getByRole("table", { name: "Work queue", exact: true })
    .boundingBox();
  const main = await page.getByRole("main").boundingBox();
  expect(list && main && main.width - list.width).toBeLessThanOrEqual(50);
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

// Tab counts share the page population; separate one-row reads repeat every
// expensive preparation and can exhaust a batched Work queue invocation.
test("Work queue loads all tab counts with its page read", async ({
  page,
}, testInfo) => {
  const prefix = uniqueName(testInfo, "Shared queue counts");
  const item = await seedProductPrerequisite(page, { name: prefix });
  const calls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    const suffix = path.split("/api/operations/")[1];
    if (!suffix) return;
    calls.push(
      ...(suffix.startsWith("batch~")
        ? suffix.slice(6).split(",")
        : [suffix]
      ).filter((name) => name === "workQueue.list"),
    );
  });
  await gotoAuthenticatedPage(
    page,
    `/work-queue?query=${encodeURIComponent(prefix)}&source=research`,
  );
  await expect(
    page
      .getByRole("table", { name: "Work queue", exact: true })
      .getByRole("link", { name: prefix, exact: true }),
  ).toHaveAttribute("href", `/products/${item.id}`);
  const views = page.getByRole("navigation", { name: "Work views" });
  for (const label of ["All", "Review", "Research", "Waiting", "Automatic"]) {
    await expect(
      views.getByRole("button", { name: new RegExp(`^${label}\\s*\\d+$`) }),
    ).toBeVisible();
  }
  expect(calls).toEqual(["workQueue.list"]);
});
