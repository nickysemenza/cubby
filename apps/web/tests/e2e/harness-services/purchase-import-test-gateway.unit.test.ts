import { describe, expect, it } from "vitest";

import gateway, { type Fixture } from "./purchase-import-test-gateway";

const choices = {
  same: "color same; size same",
  different: "color same; size different",
  unknown: "color unknown; size unknown",
};

function jevRequest(state: string, feature = "product-variant-relation") {
  return new Request("https://gateway.test/workers-ai/run/typesafe/jev", {
    method: "POST",
    headers: { "cf-aig-metadata": JSON.stringify({ feature }) },
    body: JSON.stringify({
      state,
      questions: {
        selection: {
          criteria: Object.fromEntries(
            Object.entries(choices).map(([key, label]) => [key, label]),
          ),
        },
      },
    }),
  });
}

async function configure(decisions: NonNullable<Fixture["decisions"]> = []) {
  const response = await gateway.fetch(
    new Request("https://gateway.test/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decisions }),
    }),
  );
  expect(response.status).toBe(204);
}

describe("test AI gateway semantic decisions", () => {
  it("uses an explicit scenario answer for product variant comparisons", async () => {
    await configure([
      {
        feature: "product-variant-relation",
        match: "Synthetic boot title",
        label: choices.different,
      },
    ]);

    const response = await gateway.fetch(
      jevRequest("Synthetic boot title", "product-variant-relation"),
    );
    expect(await response.json()).toMatchObject({
      result: {
        answers: {
          selection: {
            choice: "different",
            probabilities: { same: 0, different: 1, unknown: 0 },
          },
        },
      },
    });
  });

  it("abstains by default and fails closed for unconfigured features", async () => {
    await configure();
    const response = await gateway.fetch(jevRequest("Synthetic jacket"));
    expect(await response.json()).toMatchObject({
      result: { answers: { selection: { choice: "unknown" } } },
    });

    await expect(
      gateway.fetch(jevRequest("Synthetic input", "unconfigured-feature")),
    ).rejects.toThrow("No configured deterministic answer");
  });

  it("keeps unscripted extractions unavailable after a decision-only reset", async () => {
    await configure();
    const response = await gateway.fetch(
      new Request("https://gateway.test/openai/responses", {
        method: "POST",
        headers: {
          "cf-aig-metadata": JSON.stringify({
            feature: "purchase-import-extraction",
          }),
        },
        body: JSON.stringify({ input: "Synthetic receipt" }),
      }),
    );
    expect(response.status).toBe(501);
    expect(await response.text()).toContain("Unscripted gateway feature");
  });
});
