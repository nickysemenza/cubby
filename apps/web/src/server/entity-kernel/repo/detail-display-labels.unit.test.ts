import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import {
  agentHintsLabel,
  cardNumbersLabel,
  categoryPathLabel,
  externalIdsLabel,
  possibleVendorLabel,
  provenanceEvidenceLabel,
  recipeCompositionLabel,
  recipeTotalsLabel,
  sourceAliasesLabel,
  sourceRefsLabel,
  wishCandidateItems,
} from "./detail-display-labels";

const skilletId = testShortcode("product", "skillet");
const panId = testShortcode("product", "pan");

describe("categoryPathLabel", () => {
  it("reads root to leaf with slashes, and says nothing for no ancestry", () => {
    expect(
      categoryPathLabel([
        { name: "Pantry" },
        { name: "Spices" },
        { name: "Cumin" },
      ]),
    ).toBe("Pantry / Spices / Cumin");
    expect(categoryPathLabel([])).toBeNull();
  });
});

describe("externalIdsLabel", () => {
  // Native shows this text in place of web's product-external-ids cell; without it the row
  // read "1 item" and the identifier itself never appeared.
  it("names each id's source and kind, and says nothing for none", () => {
    expect(
      externalIdsLabel([
        { source: "synthetic-shop", kind: "asin", externalId: "B0SYNTH001" },
        { source: "synthetic-mill", kind: "item_number", externalId: "SM-42" },
      ]),
    ).toBe(
      "synthetic-shop (asin): B0SYNTH001, synthetic-mill (item number): SM-42",
    );
    expect(externalIdsLabel([])).toBeNull();
  });
});

describe("sourceAliasesLabel / sourceRefsLabel", () => {
  it("pairs each source with its alias or external id", () => {
    expect(
      sourceAliasesLabel([
        {
          source: "bank-feed",
          alias: "Everyday Card",
          externalAccountId: null,
        },
        {
          source: "statement",
          alias: "CARD 1234",
          externalAccountId: "acct-7",
        },
      ]),
    ).toBe("bank-feed: Everyday Card, statement: CARD 1234");
    expect(sourceAliasesLabel([])).toBeNull();
    expect(
      sourceRefsLabel([
        { source: "bank-feed", externalId: "txn-1" },
        { source: "statement", externalId: "row-9" },
      ]),
    ).toBe("bank-feed: txn-1, statement: row-9");
    expect(sourceRefsLabel([])).toBeNull();
  });
});

describe("cardNumbersLabel", () => {
  it("prints one dated line per card, an open end as an ellipsis", () => {
    expect(
      cardNumbersLabel([
        {
          last4: "1234",
          kind: "primary",
          validFrom: "2024-01-01",
          validTo: null,
          note: null,
        },
        {
          last4: "9876",
          kind: "wallet_token",
          validFrom: null,
          validTo: null,
          note: "phone",
        },
      ]),
    ).toBe(
      "•••• 1234 · primary · 2024-01-01 → …\n•••• 9876 · wallet token · phone",
    );
    expect(cardNumbersLabel([])).toBeNull();
  });
});

describe("agentHintsLabel", () => {
  it("lists the set hints then the notes, one per line", () => {
    expect(
      agentHintsLabel({
        ordersListUrl: "https://shop.example.test/orders",
        pagination: null,
        orderLinkPattern: "/orders/{id}",
        notes: ["Sign in first"],
      }),
    ).toBe(
      "Orders: https://shop.example.test/orders\nOrder links: /orders/{id}\nSign in first",
    );
    expect(
      agentHintsLabel({
        ordersListUrl: null,
        pagination: null,
        orderLinkPattern: null,
        notes: [],
      }),
    ).toBeNull();
  });
});

describe("recipeCompositionLabel", () => {
  it("counts sections, ingredients and steps with their plurals", () => {
    expect(
      recipeCompositionLabel([
        { ingredients: [{}, {}], instructions: [{}] },
        { ingredients: [{}], instructions: [] },
      ]),
    ).toBe("2 sections · 3 ingredients · 1 step");
    expect(recipeCompositionLabel([])).toBe(
      "0 sections · 0 ingredients · 0 steps",
    );
  });
});

describe("recipeTotalsLabel", () => {
  const coverage = { covered: 2, total: 2 };
  it("joins the cost and calorie estimates, and is absent before costing", () => {
    expect(
      recipeTotalsLabel({
        cost: { status: "complete", lower: 4.2, upper: null, coverage },
        nutrition: {
          kcal: { status: "complete", lower: 560.4, upper: null, coverage },
        },
      }),
    ).toBe("$4.20 · 560 kcal");
    expect(recipeTotalsLabel(null)).toBeNull();
  });
});

describe("provenanceEvidenceLabel", () => {
  it("joins the basis with the rule and detail that explain it", () => {
    expect(
      provenanceEvidenceLabel({
        basis: "exif",
        ruleId: "capture.exif",
        detail: "device clock",
      }),
    ).toBe("exif · capture.exif · device clock");
    expect(provenanceEvidenceLabel({ basis: "manual" })).toBe("manual");
    expect(provenanceEvidenceLabel(null)).toBeNull();
  });
});

describe("possibleVendorLabel", () => {
  const candidate = (
    vendorName: string,
    supportingTransactionCount: number,
  ) => ({
    vendorId: testShortcode("vendor", "inference"),
    vendorName,
    supportingTransactionCount,
    lastSeenDate: null,
  });
  it("names the vendors of a suggested or ambiguous inference", () => {
    expect(
      possibleVendorLabel({
        status: "ambiguous",
        candidates: [
          candidate("Corner Hardware", 3),
          candidate("Garden Supply", 2),
        ],
      }),
    ).toBe("Corner Hardware, Garden Supply");
    expect(
      possibleVendorLabel({
        status: "suggested",
        candidates: [candidate("Corner Hardware", 2)],
      }),
    ).toBe("Corner Hardware");
  });

  it("says nothing for a single prior match or none", () => {
    expect(
      possibleVendorLabel({
        status: "insufficient_history",
        candidates: [candidate("Corner Hardware", 1)],
      }),
    ).toBeNull();
    expect(possibleVendorLabel({ status: "none", candidates: [] })).toBeNull();
    expect(possibleVendorLabel(null)).toBeNull();
  });
});

describe("wishCandidateItems", () => {
  it("words each candidate for a row that opens its product", () => {
    expect(
      wishCandidateItems([
        {
          id: skilletId,
          name: "Cast Iron Skillet",
          manufacturer: "Acme",
          model: "CI-12",
          price: 34.5,
          inventoried: true,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        },
        {
          id: panId,
          name: "Steel Pan",
          manufacturer: "Acme",
          model: null,
          price: null,
          inventoried: false,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
        },
      ]),
    ).toEqual([
      {
        entity: "product",
        id: skilletId,
        title: "Cast Iron Skillet",
        subtitle: "Acme · CI-12",
        trailing: "$34.50 · In inventory",
      },
      {
        entity: "product",
        id: panId,
        title: "Steel Pan",
        subtitle: "Acme",
        trailing: null,
      },
    ]);
  });
});
