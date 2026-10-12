import { eq } from "drizzle-orm";

import { email, run } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";
import { seedProductPrerequisite } from "./fixtures-catalog";
import {
  ensureMemberParty,
  fixtureUserId,
  getFixtureDb,
} from "./fixtures-core";
import { seedUnimportedOrderMail } from "./fixtures-mail";

// Failure modes: a member filter widens to shared work, filtering runs only on
// the loaded page, URL state is lost on reload, a queue row loses its source,
// or the shared pager offers a size rejected by the queue contract.
test("Work queue filters routing before paging and opens its source record", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
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
  const product = page.getByRole("link", {
    name: `${prefix} shared product`,
    exact: true,
  });
  await expect(product).toHaveAttribute("href", `/products/${shared.id}`);
  const chooseWaitingFor = async (current: string, next: string) => {
    await page
      .getByRole("button", { name: `Waiting for: ${current}`, exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Filter Waiting for", exact: true })
      .fill(next);
    await page.getByRole("option", { name: next, exact: true }).click();
    await page
      .getByRole("button", { name: `Waiting for: ${next}`, exact: true })
      .click();
  };
  await chooseWaitingFor("Either", member.name);
  await expect(product).toHaveCount(0);
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
  await chooseWaitingFor(member.name, "Unresolved");
  await expect(
    page.getByRole("link", {
      name: `${prefix} unresolved account`,
      exact: true,
    }),
  ).toHaveAttribute("href", `/financial-accounts/${unresolved.shortcode}`);
  await expect(
    page.getByRole("link", { name: `${prefix} owned mail`, exact: true }),
  ).toHaveCount(0);
  await chooseWaitingFor("Unresolved", "Either");
  await page
    .getByRole("combobox", { name: "Rows per page", exact: true })
    .click();
  await expect(
    page.getByRole("option", { name: "100", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "250", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
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
