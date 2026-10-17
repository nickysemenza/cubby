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
import { checkpointMailboxCoverage } from "~/server/domains/purchase-import/repo/gmail/persistence";
import { vendorSearchTerms } from "~/server/domains/purchase-import/repo/gmail/vendor-identity";
import { vendorMailQueries } from "~/server/domains/purchase-import/repo/gmail/vendor-mail-scope";
import { vendorMailSearchReport } from "~/server/generic/entity-report/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { vendorList } from "./vendor";

// Failures: a search finished in one mailbox reading as done everywhere; a
// stale completed search (the website moved) counting as current; a Vendor
// with no searches reading as not started; the website's registrable domain
// (public-suffix logic in TypeScript) not matching its host in SQL.
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
    const unresearched = await vendorRow(
      "Synthetic Unresearched Vendor",
      null,
      [],
    );
    const queries = (row: {
      id: VendorId;
      website: string | null;
      orderEmailSenders: string[];
    }) => vendorMailQueries(row.id, vendorSearchTerms(row));
    const at = (
      row: Parameters<typeof queries>[0],
      position: Pick<MailboxScopedPosition, "pageToken" | "completed">,
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
        ...at(done, finished),
        ...at(partial, finished),
        ...at(untouched, { pageToken: null, completed: false }),
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
      to: coverage(at(done, finished)),
    });

    const states = async (mailSearch?: MailSearchState[]) =>
      Object.fromEntries(
        (
          await vendorList(
            ctx.db,
            mailSearch ? { mailSearch } : {},
            [{ orderBy: "name", direction: "asc" }],
            { pageIndex: 0, pageSize: 50 },
          )
        ).data.map((row) => [row.name, row.mailSearch]),
      );
    expect(await states()).toEqual({
      "Synthetic Done Vendor": "done",
      "Synthetic Moved Vendor": "not_started",
      "Synthetic Partial Vendor": "in_progress",
      "Synthetic Unresearched Vendor": null,
      "Synthetic Untouched Vendor": "not_started",
    });
    expect(Object.keys(await states(["in_progress", "done"]))).toEqual([
      "Synthetic Done Vendor",
      "Synthetic Partial Vendor",
    ]);
    const sorted = await vendorList(
      ctx.db,
      { mailSearch: ["done", "in_progress"] },
      [{ orderBy: "mailSearch", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(sorted.data.map((row) => row.mailSearch)).toEqual([
      "done",
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
  });
});
