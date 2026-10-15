import { describe, expect, it } from "vitest";

import { withoutSourceAlias, withoutSourceRef } from "./duplicate-claims";

describe("duplicate claim removal", () => {
  it("removes only the exact source and identifier pair from refs", () => {
    const refs = [
      { source: "bank-a", externalId: "t-1" },
      { source: "bank-b", externalId: "t-1" },
      { source: "bank-a", externalId: "t-2" },
    ];
    expect(
      withoutSourceRef(refs, { source: "bank-a", externalId: "t-1" }),
    ).toEqual([
      { source: "bank-b", externalId: "t-1" },
      { source: "bank-a", externalId: "t-2" },
    ]);
  });

  it("removes only the exact source and account id pair from aliases", () => {
    const aliases = [
      { source: "bank-a", alias: "Card", externalAccountId: "acct-1" },
      { source: "bank-b", alias: "Card", externalAccountId: "acct-1" },
      { source: "bank-a", alias: "Other", externalAccountId: null },
    ];
    expect(
      withoutSourceAlias(aliases, {
        source: "bank-a",
        externalAccountId: "acct-1",
      }),
    ).toEqual([
      { source: "bank-b", alias: "Card", externalAccountId: "acct-1" },
      { source: "bank-a", alias: "Other", externalAccountId: null },
    ]);
  });
});
