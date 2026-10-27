import { describe, expect, it } from "vitest";

import { Database } from "~/server/db/database";
import { explainLiveDerived } from "~/server/generic/derived/repo/explain";

describe("live field comparisons", () => {
  it("does not substitute a root payload for a contextual field without a standalone comparison", async () => {
    expect(
      await explainLiveDerived(
        new Database(),
        {},
        "email",
        "importOutcome",
        "synthetic-email",
      ),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("compares the declared scalar rather than its containing result object", async () => {
    const result = await explainLiveDerived(
      new Database(),
      {
        "shipment.eventSummary": async () =>
          new Map([
            [
              "synthetic-shipment",
              {
                value: {
                  eventCount: 3,
                  firstEventDate: null,
                  lastEventDate: null,
                  eventSpanHours: null,
                  eventSpanLabel: null,
                },
                sort: null,
              },
            ],
          ]),
      },
      "shipment",
      "eventCount",
      "synthetic-shipment",
    );
    expect(result).toMatchObject({
      kind: "available",
      result: {
        kind: "live",
        decision: { outcome: { kind: "value", value: 3 } },
      },
    });
  });
  it("retains a successful empty outcome separately from no computation result", async () => {
    const decision = {
      outcome: { kind: "empty", reason: "unset" },
      provenance: { kind: "computed" },
    } as const;
    const empty = await explainLiveDerived(
      new Database(),
      {
        "product.price": async () =>
          new Map([
            [
              "synthetic-product",
              {
                value: null,
                sort: null,
                decision,
              },
            ],
          ]),
      },
      "product",
      "price",
      "synthetic-product",
    );
    expect(empty).toEqual({
      kind: "available",
      result: { kind: "live", decision },
    });
    const missing = await explainLiveDerived(
      new Database(),
      {
        "product.price": async () => new Map(),
      },
      "product",
      "price",
      "synthetic-product",
    );
    expect(missing).toMatchObject({ kind: "unavailable" });
  });

  it("rejects a computation whose empty outcome contradicts its value", async () => {
    await expect(
      explainLiveDerived(
        new Database(),
        {
          "product.price": async () =>
            new Map([
              [
                "synthetic-product",
                {
                  value: 12,
                  sort: null,
                  decision: {
                    outcome: { kind: "empty", reason: "blocked" },
                    provenance: { kind: "computed" },
                  },
                },
              ],
            ]),
        },
        "product",
        "price",
        "synthetic-product",
      ),
    ).rejects.toThrow("Derived outcome does not match its published value");
  });

  it("keeps the ownership captured by the live computation", async () => {
    const ownership = {
      kind: "automatic",
      receiptId: "synthetic-receipt",
      confidence: 0.9,
    } as const;
    const result = await explainLiveDerived(
      new Database(),
      {
        "product.price": async () =>
          new Map([
            [
              "synthetic-product",
              {
                value: 12,
                sort: 12,
                decision: {
                  outcome: { kind: "value" },
                  provenance: { kind: "own", ownership },
                },
              },
            ],
          ]),
      },
      "product",
      "price",
      "synthetic-product",
    );
    expect(result).toMatchObject({
      kind: "available",
      result: {
        decision: {
          outcome: { kind: "value", value: 12 },
          provenance: { kind: "own", ownership },
        },
      },
    });
  });
});
