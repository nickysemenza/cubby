import { proposedImportFix } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";

import * as schema from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import {
  ensureMemberParty,
  fixtureUserId,
  getFixtureDb,
} from "./fixtures-core";
import { gotoAuthenticatedPage, uniqueName } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

// Domain admission/application is covered by persisted-state objective regressions.
// This presentation fixture exercises the generic Run review and real dismissal.
test("reviews learned Vendor navigation without silently authorizing hosts", async ({
  page,
}, testInfo) => {
  const db = getFixtureDb();
  const database = getDb(db);
  const party = await ensureMemberParty(page, "Synthetic profile");
  const vendor = await insertWithShortcode(db, "vendor", {
    name: uniqueName(testInfo, "Synthetic profile shop"),
    browserDomains: ["shop.example.test"],
    agentHints: {
      ordersListUrl: null,
      pagination: "Old page navigation",
      orderLinkPattern: "Old order selector",
      notes: ["Old navigation note"],
    },
  });
  const account = await insertWithShortcode(db, "vendorAccount", {
    label: "Synthetic profile account",
    vendorId: vendor.id,
    ledgerPartyId: party.id,
  });
  const run = await insertWithShortcode(db, "run", {
    actorUserId: await fixtureUserId(page),
    actorName: "Synthetic member",
    actorEmail: "synthetic@example.test",
    ledgerPartyId: party.id,
    actorLedgerPartyShortcode: party.shortcode,
    actorLedgerPartyName: party.name,
    actorLedgerPartyKind: party.kind,
    vendorAccountId: account.id,
    purpose: "account_sync",
    trigger: "manual",
    status: "needs_review",
    startedAt: new Date(),
    endedAt: new Date(),
    input: {
      kind: "research_objectives",
      instructionRevision: 1,
      objectives: [
        {
          kind: "account_history",
          vendorAccountId: account.id,
          range: null,
          cursor: null,
        },
      ],
    },
  });
  const fingerprint = "a".repeat(64);
  const fix = proposedImportFix.parse({
    kind: "vendor_capture_profile",
    runId: run.id,
    vendorId: vendor.id,
    vendorAccountId: account.id,
    targetId: crypto.randomUUID(),
    current: {
      hints: {
        ordersListUrl: null,
        pagination: "Old page navigation",
        orderLinkPattern: "Old order selector",
        notes: ["Old navigation note"],
      },
      browserDomains: ["shop.example.test"],
    },
    profile: {
      evidenceIds: [crypto.randomUUID()],
      hints: {
        ordersListUrl: "https://shop.example.test/account/orders",
        pagination: null,
        orderLinkPattern: null,
        notes: [],
      },
      browserDomains: ["shop.example.test", "signin.example.test"],
    },
    reviewSnapshot: { fingerprint },
  });
  const [finding] = await database
    .insert(schema.runFinding)
    .values({
      runId: run.id,
      ledgerPartyId: party.id,
      entityKind: "run",
      entityId: run.id,
      kind: "other",
      summary: "Review learned account navigation and browser hosts.",
      proposedFix: fix,
      evidenceFingerprint: fingerprint,
    })
    .returning();
  if (!finding) throw new Error("Synthetic profile review missing");
  await gotoAuthenticatedPage(page, `/runs/${run.shortcode}`);
  await expect(
    page.getByText(
      /Order history:.*https:\/\/shop.example.test\/account\/orders/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/Browser hosts:.*signin.example.test/),
  ).toBeVisible();
  await expect(
    page.getByText(/Pagination:.*Old page navigation.*None/),
  ).toBeVisible();
  await expect(
    page.getByText(/Order links:.*Old order selector.*None/),
  ).toBeVisible();
  await expect(
    page.getByText(/Notes:.*Old navigation note.*None/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply fix", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await database.query.runFinding.findFirst({
            where: eq(schema.runFinding.id, finding.id),
          })
        )?.status,
    )
    .toBe("dismissed");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Apply fix", exact: true }),
  ).toHaveCount(0);
  const current = await database.query.vendor.findFirst({
    where: eq(schema.vendor.id, vendor.id),
  });
  expect(current?.browserDomains).toEqual(["shop.example.test"]);
  expect(current?.agentHints).toEqual(vendor.agentHints);
  expect(
    (
      await database.query.runFinding.findFirst({
        where: eq(schema.runFinding.id, finding.id),
      })
    )?.proposedFix,
  ).toEqual(fix);
});
