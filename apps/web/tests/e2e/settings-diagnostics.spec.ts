import { timingResponseSchema } from "~/lib/perf/timing.contract";

import { expect, test } from "./support/e2e-test";

// The production route must authenticate before exposing infrastructure timings.
test("connection diagnostics require a member and isolate upstream failures", async ({
  request,
  playwright,
  baseURL,
}) => {
  const anonymous = await playwright.request.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const rejected = await anonymous.get("/api/debug/timing");
    expect(rejected.status()).toBe(401);
    expect(rejected.headers()["cache-control"]).toBe("private, no-store");
  } finally {
    await anonymous.dispose();
  }

  const response = await request.get("/api/debug/timing");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const { results } = timingResponseSchema.parse(await response.json());
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: "db: SELECT 1",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        label: "usda release: status()",
        durationMs: expect.any(Number),
      }),
      // The offline Worker disables upstream UPC calls; its error must not hide other results.
      expect.objectContaining({
        label: "upc: upstream lookup",
        error: "UPC upstream lookup is disabled",
      }),
    ]),
  );
  expect(
    results.find((result) => result.label === "db: SELECT 1")?.error,
  ).toBeUndefined();
});
