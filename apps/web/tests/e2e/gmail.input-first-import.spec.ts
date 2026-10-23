import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import * as schema from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { setMemberLoginParty } from "~/server/http/member-login";
import { account as googleAccount } from "~/server/db/auth.schema";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";
import { createGmailApiClient } from "~/server/domains/purchase-import/repo/gmail/client";
import { ingestGmailMessages } from "~/server/domains/purchase-import/service/gmail/ingest";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import {
  createEvidenceHarnessContext,
  ensureMemberParty,
} from "./fixtures/core";
import { gotoAuthenticatedPage } from "./support/e2e-helpers";
import { expect, test } from "./support/e2e-test";

// This journey owns real OAuth persistence and credential-backed MIME retention.
// Prepared choices and source convergence have renderer and PostgreSQL owners.
test("connects Google and retains Gmail MIME evidence without economic writes", async ({
  page,
  e2eRuntime,
}) => {
  const provider = e2eRuntime.googleProvider;
  if (!provider) throw new Error("Gmail journey requires its local provider");
  const token = `gmail-${Date.now()}`;
  const messageId = `synthetic-message-${token}`;
  const sender = "orders@synthetic-retailer.example.test";
  const subject = `Order SYN-${token}`;
  const bodyText = `Order SYN-${token} placed. Total USD 42.50.`;
  const { db, actor } = await createEvidenceHarnessContext(page);
  const database = getDb(db);
  const member = await ensureMemberParty(
    page,
    `Synthetic Gmail member ${token}`,
  );
  await setMemberLoginParty(
    db,
    actor.userId,
    parseShortcodeFor("ledgerParty", member.shortcode),
    actor,
  );
  const session = z
    .object({ user: z.object({ email: z.email() }) })
    .parse(await (await page.request.get("/api/auth/get-session")).json());
  provider.configure({
    email: session.user.email,
    message: {
      id: messageId,
      threadId: `synthetic-thread-${token}`,
      historyId: "1",
      internalDate: String(Date.parse("2026-09-10T12:30:00Z")),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: sender },
          { name: "Subject", value: subject },
        ],
        body: { data: Buffer.from(bodyText).toString("base64url") },
      },
    },
    classification: {
      events: [
        {
          event: "placed",
          orderId: `SYN-${token}`,
          amount: 42.5,
          currency: "USD",
          occurredAt: "2026-09-10T12:00:00.000Z",
        },
      ],
    },
  });
  await gotoAuthenticatedPage(page, "/settings");
  const disconnect = page.getByRole("button", {
    name: "Disconnect Google & Gmail",
    exact: true,
  });
  await expect(
    page.getByRole("button", {
      name: /^(?:Connect|Disconnect) Google & Gmail$/u,
    }),
  ).toBeEnabled();
  if (await disconnect.isVisible()) await disconnect.click();
  const connect = page.getByRole("button", {
    name: "Connect Google & Gmail",
    exact: true,
  });
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(
    page.getByRole("heading", { name: "Synthetic Google consent" }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Grant read-only Gmail access",
      exact: true,
    })
    .click();
  await expect(disconnect).toBeVisible();
  const accounts = z
    .array(
      z
        .object({
          providerId: z.string(),
          scopes: z.array(z.string()).optional(),
        })
        .loose(),
    )
    .parse(await (await page.request.get("/api/auth/list-accounts")).json());
  expect(accounts.some((account) => account.providerId === "google")).toBe(
    true,
  );
  const connected = await database.query.account.findFirst({
    where: and(
      eq(googleAccount.userId, actor.userId),
      eq(googleAccount.providerId, "google"),
    ),
  });
  if (!connected?.accessToken)
    throw new Error("Google callback did not retain its access token");
  const client = createGmailApiClient({
    accessToken: connected.accessToken,
    baseUrl: `${provider.url}/gmail/v1/`,
  });
  const discovered = await client.listMessages({
    query: "-in:spam -in:trash",
  });
  expect(discovered.messages?.map((message) => message.id)).toContain(
    messageId,
  );
  expect(connected.scope?.split(",")).toContain(GMAIL_READONLY_SCOPE);
  const ingested = await ingestGmailMessages(db, client, {
    ledgerPartyId: member.id,
    mailboxId: connected.accountId,
    messageIds: [messageId],
    triage: async () => "related",
  });
  const retained = await readRetainedMail(db, {
    ledgerPartyIds: [member.id],
    mailboxId: connected.accountId,
    messageId,
  });
  expect(retained).toMatchObject([
    {
      id: ingested.orderMailIds[0],
      ledgerPartyId: member.id,
      mailboxId: connected.accountId,
      messageId,
      sender,
      subject,
      content: { bodyText },
    },
  ]);
  expect(retained).toHaveLength(1);
  // Acquiring an original must not book spend or claim household ownership.
  expect(
    await database.query.purchase.findMany({
      where: notDeleted(schema.purchase),
      columns: { id: true },
    }),
  ).toEqual([]);
  expect(
    await database.query.expense.findMany({
      where: notDeleted(schema.expense),
      columns: { id: true },
    }),
  ).toEqual([]);
  expect(
    await database.query.inventoryEntry.findMany({
      where: notDeleted(schema.inventoryEntry),
      columns: { id: true },
    }),
  ).toEqual([]);
  expect(provider.events()).toEqual(
    expect.arrayContaining([
      "GET /authorize",
      "POST /token",
      "GET /jwks",
      "GET /gmail/v1/users/me/messages",
      `GET /gmail/v1/users/me/messages/${messageId}`,
    ]),
  );
});
