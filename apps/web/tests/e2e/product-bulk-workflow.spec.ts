import { productCreateManyInput } from "@cubby/schemas/product";
import { productCreateManyEvent } from "@cubby/schemas/product-workflow";
import superjson from "superjson";
import { z } from "zod";

import { expect, test } from "./e2e-test";

const eventFrame = z.object({
  kind: z.literal("event"),
  payload: z.object({ json: productCreateManyEvent }),
});

test("product bulk workflow streams validated progress and its final committed result", async ({
  page,
}) => {
  const prefix = `Bulk workflow ${Date.now()}`;
  const input = productCreateManyInput.parse(
    ["One", "Two"].map((suffix) => ({
      name: `${prefix} ${suffix}`,
      manufacturer: "Fixture manufacturer",
      aliases: [],
      tags: [],
      upc: null,
      fdc_id: null,
      expectedQuantity: null,
      ingredientId: null,
      unitMappings: [],
      externalIds: [],
    })),
  );
  const response = await page.request.post(
    "/api/workflow-stream/product.createMany",
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
  expect(events.slice(0, -1)).toEqual([
    { type: "progress", done: 0, total: 2 },
    { type: "progress", done: 1, total: 2 },
    { type: "progress", done: 2, total: 2 },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "done",
    result: { created: 2, failed: [] },
  });
});
