/**
 * Failures: a vendor history query searches the Vendor's name as free text,
 * drops the approved window, shares coverage with another window, or lets a
 * stored sender carry Gmail operators.
 */
import { vendorId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { vendorSearchTerms } from "./vendor-identity";
import { vendorHistoryQueries, windowedVendorQuery } from "./vendor-mail-scope";

const id = vendorId.parse("00000000-0000-4000-8000-00000000000a");

describe("vendor history queries", () => {
  it("searches only verified senders and the website domain inside the window", () => {
    const queries = vendorHistoryQueries(
      id,
      vendorSearchTerms({
        website: "https://www.kettle.example.co.uk/shop",
        orderEmailSenders: ["Orders@Kettle-Mail.example.test"],
      }),
    );
    expect(queries).toEqual([
      { key: `vendor:${id}:domain:example.co.uk`, query: '"example.co.uk"' },
      {
        key: `vendor:${id}:from:orders@kettle-mail.example.test`,
        query: "from:orders@kettle-mail.example.test",
      },
    ]);
    expect(
      queries.map((query) =>
        windowedVendorQuery(query, {
          receivedAfter: "2024-01-01",
          receivedBefore: "2026-10-01",
        }),
      )[0],
    ).toEqual({
      key: `vendor:${id}:domain:example.co.uk:2024-01-01..2026-10-01`,
      query: '("example.co.uk") after:2024/01/01 before:2026/10/01',
    });
  });

  it("never turns a stored sender with Gmail operators into a query", () => {
    expect(
      vendorHistoryQueries(id, [
        "orders@kettle.example.test",
        "shop.example.test OR in:anywhere",
        '"quoted@example.test"',
        "{a.example.test b.example.test}",
        "-from:me",
      ]),
    ).toEqual([
      {
        key: `vendor:${id}:from:orders@kettle.example.test`,
        query: "from:orders@kettle.example.test",
      },
    ]);
  });

  it("produces no query for a Vendor without a sender or website", () => {
    expect(
      vendorHistoryQueries(
        id,
        vendorSearchTerms({ website: null, orderEmailSenders: [] }),
      ),
    ).toEqual([]);
  });
});
