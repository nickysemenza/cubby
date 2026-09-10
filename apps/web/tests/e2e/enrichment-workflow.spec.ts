import {
  aiEnrichmentProposalEventSchema,
  enrichmentProposalPrecomputeInput,
} from "@cubby/schemas/ai";
import superjson from "superjson";
import { z } from "zod";

import { seedIngredientPrerequisite } from "./e2e-fixtures";
import { expect, test } from "./e2e-test";

const eventFrame = z.object({
  kind: z.literal("event"),
  payload: z.object({ json: aiEnrichmentProposalEventSchema }),
});

test("declared enrichment streams public ingredient proposals through the Worker", async ({
  page,
}) => {
  const name = `Enrichment stream ${Date.now()}`;
  const ingredient = await seedIngredientPrerequisite(page, name);
  const input = enrichmentProposalPrecomputeInput.parse({
    items: [
      {
        id: ingredient.id,
        name,
        wantUsda: false,
        wantMerge: false,
      },
    ],
  });
  const response = await page.request.post(
    "/api/workflow-stream/ai.precomputeEnrichmentProposals",
    {
      headers: { "content-type": "application/json" },
      data: superjson.stringify(input),
    },
  );
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/x-ndjson");
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => eventFrame.parse(JSON.parse(line)).payload.json);
  expect(events).toEqual([
    { type: "progress", done: 0, total: 1 },
    {
      type: "progress",
      done: 1,
      total: 1,
      item: {
        id: ingredient.id,
        usda: { food: null, confidence: "low", reasoning: "" },
        merge: null,
      },
    },
    { type: "done", result: { processed: 1 } },
  ]);
});
