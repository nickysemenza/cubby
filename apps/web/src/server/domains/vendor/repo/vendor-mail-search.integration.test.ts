import { userId, type VendorId } from "@cubby/schemas/identifiers";
import type {
  MailboxCoverage,
  MailboxScopedPosition,
  MailSearchState,
} from "@cubby/schemas/mailbox-research";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { account } from "~/server/db/auth.schema";
import { getDb } from "~/server/db/helpers";
import { user } from "~/server/db/schema";
import { retainedMailFixture } from "~/server/domains/purchase-import/operations/order-import.fixtures";
import { readMailCoverage } from "~/server/domains/purchase-import/repo/gmail/mail-coverage";
import { checkpointMailboxCoverage } from "~/server/domains/purchase-import/repo/gmail/persistence";
import { vendorSearchTerms } from "~/server/domains/purchase-import/repo/gmail/vendor-identity";
import { vendorMailQueries } from "~/server/domains/purchase-import/repo/gmail/vendor-mail-scope";
import { vendorMailSearchReport } from "~/server/generic/entity-report/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { vendorScaffold } from "./vendor";

// Failures: a search finished in one mailbox reading as done everywhere; a
// stale completed search (the website moved) counting as current; a Vendor
// with no searches reading as not started; a finished parent-domain search
// standing in for an unsearched private-suffix website; a website host that
// TypeScript normalizes (trailing dot) never matching in SQL.
describe("vendor Mail search status", () => {
  const ctx = withTestDb();

  it("aggregates each Vendor's current searches across every member mailbox", async () => {
    const otherUser = userId.parse(crypto.randomUUID());
    await getDb(ctx.db).insert(user).values({
      id: otherUser,
      name: "Synthetic second member",
      email: "second-member@example.test",
      emailVerified: false,
    });
    const members = await Promise.all(
      [
        { userId: ctx.actor.userId, mailboxId: "synthetic-mailbox-a" },
        { userId: otherUser, mailboxId: "synthetic-mailbox-b" },
      ].map(async (member, index) => {
        const party = await insertWithShortcode(ctx.db, "ledgerParty", {
          name: `Synthetic member ${index + 1}`,
          kind: "member",
          userId: member.userId,
        });
        await getDb(ctx.db).insert(account).values({
          id: crypto.randomUUID(),
          accountId: member.mailboxId,
          providerId: "google",
          userId: member.userId,
          updatedAt: new Date(),
        });
        return { party, mailboxId: member.mailboxId };
      }),
    );
    const vendorRow = (
      name: string,
      website: string | null,
      senders: string[],
    ) =>
      insertWithShortcode(ctx.db, "vendor", {
        name,
        website,
        orderEmailSenders: senders,
      });
    const done = await vendorRow(
      "Synthetic Done Vendor",
      "https://www.done.example.test/shop",
      ["orders@done.example.test"],
    );
    const partial = await vendorRow(
      "Synthetic Partial Vendor",
      "https://partial.example.org",
      ["receipts@partial.example.org"],
    );
    const untouched = await vendorRow("Synthetic Untouched Vendor", null, [
      "hello@untouched.example.net",
    ]);
    const moved = await vendorRow(
      "Synthetic Moved Vendor",
      "https://new-home.example.com",
      [],
    );
    // `github.io` is a private suffix: the website searches `tenant.github.io`,
    // and a finished search of the former `github.io` website is not it.
    const privateSuffix = await vendorRow(
      "Synthetic Private Suffix Vendor",
      "https://tenant.github.io/store",
      ["orders@tenant-mail.example.com"],
    );
    const trailingDot = await vendorRow(
      "Synthetic Trailing Dot Vendor",
      "https://Shop.Trailing.example.com./",
      [],
    );
    const unresearched = await vendorRow(
      "Synthetic Unresearched Vendor",
      null,
      [],
    );
    const formerWebsite = (): MailboxScopedPosition[] => [
      ...at(privateSuffix, finished).filter((query) =>
        query.key.includes(":from:"),
      ),
      {
        key: `vendor:${privateSuffix.id}:domain:github.io`,
        query: '"github.io"',
        ...finished,
      },
    ];
    const queries = (row: {
      id: VendorId;
      website: string | null;
      orderEmailSenders: string[];
    }) => vendorMailQueries(row.id, vendorSearchTerms(row));
    const at = (
      row: Parameters<typeof queries>[0],
      position: Pick<
        MailboxScopedPosition,
        "pageToken" | "completed" | "messageCount"
      >,
    ) => queries(row).map((query) => ({ ...query, ...position }));
    const finished = { pageToken: null, completed: true };
    const coverage = (scoped: MailboxScopedPosition[]): MailboxCoverage => ({
      version: 1,
      baselineHistoryId: "100",
      broad: { pageToken: null, completed: false },
      scoped,
      history: { historyId: "100", pageToken: null, targetHistoryId: null },
      nextLane: "scan",
    });
    const [a, b] = members;
    if (!a || !b) throw new Error("Two synthetic members are required");
    await checkpointMailboxCoverage(ctx.db, {
      ledgerPartyId: a.party.id,
      mailboxId: a.mailboxId,
      from: null,
      to: coverage([
        ...at(done, { ...finished, messageCount: 0 }),
        ...at(partial, finished),
        ...at(untouched, { pageToken: null, completed: false }),
        ...at(trailingDot, finished),
        ...formerWebsite(),
        {
          key: "sender:noreply@order.online",
          query: 'from:"noreply@order.online"',
          pageToken: null,
          completed: true,
          messageCount: 1,
          completedAt: "2026-10-01T12:00:00Z",
        },
        // The Vendor's old website: finished, but no longer one of its searches.
        {
          key: `vendor:${moved.id}:domain:old-home.example.com`,
          query: '"old-home.example.com"',
          ...finished,
        },
      ]),
    });
    await checkpointMailboxCoverage(ctx.db, {
      ledgerPartyId: b.party.id,
      mailboxId: b.mailboxId,
      from: null,
      to: coverage([
        ...at(done, finished),
        ...at(trailingDot, finished),
        ...formerWebsite(),
      ]),
    });

    const states = async (mailSearch?: MailSearchState[]) =>
      Object.fromEntries(
        (
          await vendorScaffold.read(ctx.db, {
            filters: mailSearch ? { mailSearch } : {},
            sorts: [{ orderBy: "name", direction: "asc" }],
            pagination: { pageIndex: 0, pageSize: 50 },
          })
        ).data.map((row) => [row.name, row.mailSearch]),
      );
    expect(await states()).toEqual({
      "Generic / Unbranded": null,
      "Synthetic Done Vendor": "done",
      "Synthetic Moved Vendor": "not_started",
      "Synthetic Partial Vendor": "in_progress",
      "Synthetic Private Suffix Vendor": "in_progress",
      "Synthetic Trailing Dot Vendor": "done",
      "Synthetic Unresearched Vendor": null,
      "Synthetic Untouched Vendor": "not_started",
    });
    expect(Object.keys(await states(["in_progress", "done"]))).toEqual([
      "Synthetic Done Vendor",
      "Synthetic Partial Vendor",
      "Synthetic Private Suffix Vendor",
      "Synthetic Trailing Dot Vendor",
    ]);
    expect(queries(privateSuffix).map((query) => query.key)).toContain(
      `vendor:${privateSuffix.id}:domain:tenant.github.io`,
    );
    const sorted = await vendorScaffold.read(ctx.db, {
      filters: { mailSearch: ["done", "in_progress"] },
      sorts: [{ orderBy: "mailSearch", direction: "asc" }],
      pagination: { pageIndex: 0, pageSize: 50 },
    });
    expect(sorted.data.map((row) => row.mailSearch)).toEqual([
      "done",
      "done",
      "in_progress",
      "in_progress",
    ]);

    const [table] = await vendorMailSearchReport(ctx.db, partial.shortcode);
    expect(table).toMatchObject({ kind: "table" });
    if (table?.kind !== "table") throw new Error("Expected a table block");
    expect(
      table.rows.map((row) => [row.cells[0], row.cells[2]]).sort(),
    ).toEqual(
      [
        ['"example.org"', "Done"],
        ['"example.org"', "Not started"],
        ["from:receipts@partial.example.org", "Done"],
        ["from:receipts@partial.example.org", "Not started"],
      ].sort(),
    );
    expect(
      await vendorMailSearchReport(ctx.db, unresearched.shortcode),
    ).toEqual([expect.objectContaining({ kind: "note" })]);
    await retainedMailFixture(ctx.db, {
      ledgerPartyId: a.party.id,
      mailboxId: a.mailboxId,
      messageId: "synthetic-shared-sender-receipt",
      checksum: "a".repeat(64),
      sender: "Synthetic Cafe <noreply@order.online>",
      subject: "Synthetic Cafe receipt",
    });
    // A mailbox with newer receipts must not consume another mailbox's sample.
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        retainedMailFixture(ctx.db, {
          ledgerPartyId: a.party.id,
          mailboxId: a.mailboxId,
          messageId: `synthetic-shared-receipt-${index}`,
          checksum: "a".repeat(64),
          sender: "Synthetic Cafe <noreply@order.online>",
          subject: `Synthetic receipt ${index}`,
        }),
      ),
    );
    await retainedMailFixture(ctx.db, {
      ledgerPartyId: b.party.id,
      mailboxId: b.mailboxId,
      messageId: "synthetic-older-receipt",
      checksum: "b".repeat(64),
      sender: "orders@other.example.test",
      subject: "Synthetic older receipt",
      receivedAt: new Date("2026-09-01T12:00:00Z"),
    });
    const report = await readMailCoverage(ctx.db, ctx.actor.userId);
    expect(report.sharedSenders).toEqual([
      expect.objectContaining({
        mailboxId: a.mailboxId,
        sender: "noreply@order.online",
        state: "complete",
        completedAt: "2026-10-01T12:00:00Z",
        scanned: 51,
        classified: 51,
        retained: 51,
        related: 51,
        sellerUnresolved: 51,
        linkedEmails: 0,
        linkedPurchases: 0,
        imported: 0,
      }),
    ]);
    expect(
      report.discovery.find((row) => row.mailboxId === a.mailboxId),
    ).toMatchObject({ sellerUnresolved: 51 });
    expect(
      report.discovery.find((row) => row.mailboxId === b.mailboxId),
    ).toMatchObject({ sellerUnresolved: 1 });
    expect(
      report.unresolvedEmails.filter((row) => row.mailboxId === a.mailboxId),
    ).toHaveLength(50);
    expect(
      report.unresolvedEmails
        .filter((row) => row.mailboxId === b.mailboxId)
        .map((row) => row.subject),
    ).toEqual(["Synthetic older receipt"]);
    expect(
      report.rows.filter((row) => row.vendorId === done.shortcode),
    ).toEqual([
      expect.objectContaining({
        mailboxId: a.mailboxId,
        state: "no_matches",
        vendorAccountId: null,
      }),
      expect.objectContaining({
        mailboxId: b.mailboxId,
        state: "complete",
        vendorAccountId: null,
      }),
    ]);
    expect(
      report.rows.filter((row) => row.vendorId === unresearched.shortcode),
    ).toHaveLength(2);
    expect(
      report.rows.some((row) => row.vendorName === "Generic / Unbranded"),
    ).toBe(false);
    expect(report.mailboxes).toEqual([
      expect.objectContaining({ mailboxId: a.mailboxId, canControl: true }),
      expect.objectContaining({ mailboxId: b.mailboxId, canControl: false }),
    ]);
  });
});
