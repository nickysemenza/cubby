import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";

import { issuerCandidates, hasCreditCardIdentity } from "./account-evidence";
import { fieldSuggestSpecFor } from "./registry";

describe("FinancialAccount evidence candidate boundaries", () => {
  it("refuses non-card and malformed identity requests before DB access", async () => {
    const db = {} as Database;
    const issuer = fieldSuggestSpecFor("financialAccount", "issuer");
    const holder = fieldSuggestSpecFor(
      "financialAccount",
      "primaryCardholderId",
    );
    const network = fieldSuggestSpecFor("financialAccount", "network");
    if (
      issuer?.kind !== "text" ||
      holder?.kind !== "reference" ||
      network?.kind !== "enum"
    )
      throw new Error("Expected shared scalar suggestion specs");
    await expect(issuer.roster(db, {})).resolves.toEqual([]);
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
        identity: '{"kind":"credit_card","issuer":null,"network":null}',
        name: "Synthetic Platinum",
      }),
    ).resolves.toEqual(["visa", "mastercard", "amex", "discover", "other"]);
  });

  it("keeps saved issuer vocabulary and extracts only structurally labelled new values", () => {
    expect(
      issuerCandidates(
        ["Harbor Example Bank", "Meadow Example Bank", "harbor example bank"],
        {
          name: "Another Example issuer",
          notes: "Issuer: Bay Example Union\nFunding party: Synthetic member",
        },
      ),
    ).toEqual([
      "Harbor Example Bank",
      "Meadow Example Bank",
      "Bay Example Union",
    ]);
  });
});
