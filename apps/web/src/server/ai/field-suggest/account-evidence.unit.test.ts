import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";

import { hasCreditCardIdentity } from "./account-evidence";
import { fieldSuggestSpecFor } from "./registry";

describe("FinancialAccount evidence candidate boundaries", () => {
  it("refuses non-card and malformed identity requests before DB access", async () => {
    const db = {} as Database;
    const holder = fieldSuggestSpecFor(
      "financialAccount",
      "primaryCardholderId",
    );
    const network = fieldSuggestSpecFor("financialAccount", "network");
    if (holder?.kind !== "reference" || network?.kind !== "enum")
      throw new Error("Expected shared scalar suggestion specs");
    await expect(holder.roster(db, {}, {})).resolves.toEqual([]);
    await expect(
      network.candidates?.(db, { identity: "invalid" }),
    ).resolves.toEqual([]);
    expect(hasCreditCardIdentity({ identity: '{"kind":"cash"}' })).toBe(false);
    for (const field of [
      "provisional",
      "authorizedUsers",
      "fundingPeriods",
      "cardNumbers",
    ])
      expect(fieldSuggestSpecFor("financialAccount", field)).toBeUndefined();
  });

  it("offers every network for model judgment even without literal network keywords", async () => {
    const network = fieldSuggestSpecFor("financialAccount", "network");
    if (network?.kind !== "enum") throw new Error("Expected network enum");
    await expect(
      network.candidates?.({} as Database, {
        identity: '{"kind":"credit_card","network":null}',
        name: "Synthetic Platinum",
      }),
    ).resolves.toEqual(["visa", "mastercard", "amex", "discover", "other"]);
  });
});
