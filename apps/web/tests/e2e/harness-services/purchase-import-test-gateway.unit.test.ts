import { describe, expect, it } from "vitest";

import gateway from "./purchase-import-test-gateway";

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

async function configure(decisions: unknown[] = []) {
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
    const body = (await response.json()) as {
      result: {
        answers: {
          selection: { choice: string; probabilities: Record<string, number> };
        };
      };
    };

    expect(body.result.answers.selection).toMatchObject({
      choice: "different",
      probabilities: { same: 0, different: 1, unknown: 0 },
    });
  });

  it("abstains by default and fails closed for unconfigured features", async () => {
    await configure();
    const response = await gateway.fetch(jevRequest("Synthetic jacket"));
    const body = (await response.json()) as {
      result: { answers: { selection: { choice: string } } };
    };
    expect(body.result.answers.selection.choice).toBe("unknown");

    await expect(
      gateway.fetch(jevRequest("Synthetic input", "unconfigured-feature")),
    ).rejects.toThrow("No configured deterministic answer");
  });
});
