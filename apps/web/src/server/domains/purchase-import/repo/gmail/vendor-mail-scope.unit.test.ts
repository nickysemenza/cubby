/**
 * Failures: a Vendor discovery query searches the Vendor's name as free text
 * or lets a stored sender carry Gmail operators.
 */
import { vendorId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { vendorSearchTerms } from "./vendor-identity";
import { vendorMailQueries } from "./vendor-mail-scope";

const id = vendorId.parse("00000000-0000-4000-8000-00000000000a");

describe("vendor mail queries", () => {
  it("searches only verified senders and the website domain", () => {
    const queries = vendorMailQueries(
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
  });

  it("never turns a stored sender with Gmail operators into a query", () => {
    expect(
      vendorMailQueries(id, [
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
      vendorMailQueries(
        id,
        vendorSearchTerms({ website: null, orderEmailSenders: [] }),
      ),
    ).toEqual([]);
  });
});
